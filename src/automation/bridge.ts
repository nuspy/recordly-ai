import { type MutableRefObject, useEffect } from "react";
import type { AutomationBridgeRole } from "../../electron/automation/contract";

export type AutomationCommandHandler = (args: Record<string, unknown>) => unknown;
export type AutomationCommandHandlers = Record<string, AutomationCommandHandler>;

/** Error with a machine-readable code, surfaced to the REST caller as-is. */
export class AutomationCommandError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "AutomationCommandError";
	}
}

export function getAutomationApi() {
	return typeof window === "undefined" ? null : (window.electronAPI?.automation ?? null);
}

export function emitAutomationEvent(type: string, data?: unknown) {
	getAutomationApi()?.emit(type, data);
}

export function delay(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Polls `predicate` until it returns a non-null value or the timeout elapses. */
export async function waitForValue<T>(
	predicate: () => T | null | undefined | false,
	timeoutMs: number,
	intervalMs = 50,
): Promise<T | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = predicate();
		if (value) return value;
		if (Date.now() >= deadline) return null;
		await delay(intervalMs);
	}
}

/**
 * Registers this window as the automation bridge for `role` and dispatches main-process
 * commands to the latest handlers (kept in a ref so handlers always see current state).
 */
export function useAutomationBridge(
	role: AutomationBridgeRole,
	handlersRef: MutableRefObject<AutomationCommandHandlers>,
) {
	useEffect(() => {
		const api = getAutomationApi();
		if (!api) return;
		const unsubscribe = api.onCommand(async ({ requestId, command, args }) => {
			const handler = handlersRef.current[command];
			if (!handler) {
				api.respond({
					requestId,
					ok: false,
					error: {
						code: "unknown_command",
						message: `Unknown ${role} command "${command}".`,
					},
				});
				return;
			}
			try {
				const result = await handler(
					args && typeof args === "object" ? (args as Record<string, unknown>) : {},
				);
				api.respond({ requestId, ok: true, result: result ?? null });
			} catch (error) {
				api.respond({
					requestId,
					ok: false,
					error: {
						code:
							error instanceof AutomationCommandError ? error.code : "renderer_error",
						message: error instanceof Error ? error.message : String(error),
					},
				});
			}
		});
		api.announce(role);
		return unsubscribe;
	}, [role, handlersRef]);
}

export function readNumber(args: Record<string, unknown>, key: string): number | undefined {
	const value = args[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
	const value = args[key];
	return typeof value === "boolean" ? value : undefined;
}

export function readString(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" ? value : undefined;
}
