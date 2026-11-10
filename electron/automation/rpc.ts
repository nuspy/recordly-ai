import { randomUUID } from "node:crypto";
import type { IpcMain, WebContents } from "electron";
import type {
	AutomationBridgeRole,
	AutomationCommandMessage,
	AutomationRendererEvent,
	AutomationResultMessage,
} from "./contract";
import { HttpError } from "./http";

interface PendingCommand {
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	timer: NodeJS.Timeout;
	role: AutomationBridgeRole;
}

type RendererEventHandler = (
	event: AutomationRendererEvent,
	role: AutomationBridgeRole | null,
) => void;

/**
 * Main → renderer command channel. The HUD hosts the recorder and the editor owns the
 * timeline/export state, so REST handlers forward commands to whichever bridge
 * registered for that role and await its reply.
 */
export class AutomationRpc {
	private readonly bridges = new Map<AutomationBridgeRole, WebContents>();
	private readonly pending = new Map<string, PendingCommand>();
	private readonly readyWaiters = new Map<AutomationBridgeRole, Array<() => void>>();
	private readonly eventHandlers = new Set<RendererEventHandler>();

	register(ipcMain: IpcMain) {
		ipcMain.on("automation:bridge-ready", (event, role: unknown) => {
			if (role !== "hud" && role !== "editor") return;
			this.attach(role, event.sender);
		});
		ipcMain.on("automation:result", (_event, message: AutomationResultMessage) => {
			this.settle(message);
		});
		ipcMain.on("automation:event", (event, message: AutomationRendererEvent) => {
			if (!message || typeof message.type !== "string") return;
			const role = this.roleOf(event.sender);
			for (const handler of this.eventHandlers) {
				try {
					handler(message, role);
				} catch (error) {
					console.warn("[automation] renderer event handler failed:", error);
				}
			}
		});
	}

	onRendererEvent(handler: RendererEventHandler) {
		this.eventHandlers.add(handler);
		return () => this.eventHandlers.delete(handler);
	}

	getContents(role: AutomationBridgeRole): WebContents | null {
		const contents = this.bridges.get(role);
		return contents && !contents.isDestroyed() ? contents : null;
	}

	isReady(role: AutomationBridgeRole) {
		const contents = this.bridges.get(role);
		return Boolean(contents && !contents.isDestroyed());
	}

	waitForBridge(role: AutomationBridgeRole, timeoutMs: number): Promise<boolean> {
		if (this.isReady(role)) return Promise.resolve(true);
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				resolve(true);
			};
			const timer = setTimeout(() => {
				const waiters = this.readyWaiters.get(role) ?? [];
				this.readyWaiters.set(
					role,
					waiters.filter((waiter) => waiter !== done),
				);
				resolve(false);
			}, timeoutMs);
			this.readyWaiters.set(role, [...(this.readyWaiters.get(role) ?? []), done]);
		});
	}

	send<T = unknown>(
		role: AutomationBridgeRole,
		command: string,
		args: unknown = {},
		timeoutMs = 30_000,
	): Promise<T> {
		const contents = this.bridges.get(role);
		if (!contents || contents.isDestroyed()) {
			return Promise.reject(
				new HttpError(
					503,
					`${role}_unavailable`,
					role === "editor"
						? "The editor is not open. Stop a recording or call POST /v1/editor/open first."
						: "The recording HUD is not ready yet. Retry after GET /v1/health?wait=60.",
				),
			);
		}

		const requestId = randomUUID();
		const message: AutomationCommandMessage = { requestId, command, args };
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				reject(
					new HttpError(
						504,
						"renderer_timeout",
						`${role} did not answer "${command}" in time.`,
					),
				);
			}, timeoutMs);
			this.pending.set(requestId, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timer,
				role,
			});
			contents.send("automation:command", message);
		});
	}

	private attach(role: AutomationBridgeRole, contents: WebContents) {
		this.bridges.set(role, contents);
		contents.once("destroyed", () => {
			if (this.bridges.get(role) === contents) {
				this.bridges.delete(role);
			}
			for (const [requestId, pending] of this.pending) {
				if (pending.role === role) {
					clearTimeout(pending.timer);
					this.pending.delete(requestId);
					pending.reject(
						new HttpError(
							503,
							`${role}_closed`,
							`The ${role} window closed during the command.`,
						),
					);
				}
			}
		});
		const waiters = this.readyWaiters.get(role) ?? [];
		this.readyWaiters.delete(role);
		for (const waiter of waiters) waiter();
	}

	private roleOf(contents: WebContents): AutomationBridgeRole | null {
		for (const [role, registered] of this.bridges) {
			if (registered === contents) return role;
		}
		return null;
	}

	private settle(message: AutomationResultMessage) {
		const pending = message ? this.pending.get(message.requestId) : undefined;
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending.delete(message.requestId);
		if (message.ok) {
			pending.resolve(message.result);
		} else {
			const code = message.error?.code ?? "renderer_error";
			const status = code === "bad_request" ? 400 : code === "conflict" ? 409 : 500;
			pending.reject(
				new HttpError(status, code, message.error?.message ?? "Command failed."),
			);
		}
	}
}
