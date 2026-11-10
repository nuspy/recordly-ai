import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, type IpcMain, type WebContents } from "electron";
import { getFfprobeBinaryPath } from "../ipc/ffmpeg/binary";
import { currentRecordingSession, currentVideoPath } from "../ipc/state";
import { approveUserPath, getRecordingsDir } from "../ipc/utils";
import type { AutomationLaunchOptions } from "./cli";
import { resolveAutomationPort } from "./cli";
import {
	type AutoEditOptions,
	type AutomationSettings,
	getRecordingTimeMs,
	type RecordingStatusSnapshot,
	type SessionJournal,
} from "./contract";
import {
	createServerInfo,
	ensureAutomationToken,
	getAutomationDir,
	getTokenPath,
	removeServerInfo,
	writeServerInfo,
} from "./discovery";
import { AutomationEventBus } from "./events";
import { clearAutomationExportPath, setAutomationExportPath } from "./exportTargets";
import { conflict } from "./http";
import { JournalStore, readJournalSidecar, writeJournalSidecar } from "./journal";
import { type RunningAutomationServer, startAutomationServer } from "./restServer";
import type { AutomationRouter } from "./router";
import { AutomationRpc } from "./rpc";
import { readAutomationSettings, writeAutomationSettings } from "./settings";

export interface AutomationHost {
	launch: AutomationLaunchOptions;
	userDataPath: string;
	appVersion: string;
	/** Opens (or reuses) the editor window for the current recording session/project. */
	openEditorWindow: () => void;
	/** Recreates the HUD (recorder host) if it was closed after a recording. */
	ensureHudWindow: () => void;
	/** Quits the app; `force` skips unsaved-changes prompts. */
	quit: (force: boolean) => void;
}

export interface PreparedNarration {
	id: string;
	text: string;
	path: string;
	durationMs: number;
	createdAt: string;
}

export interface ExportJob {
	id: string;
	status: "running" | "done" | "failed";
	outputPath: string;
	format: string;
	startedAt: string;
	finishedAt: string | null;
	percent: number;
	phase: string | null;
	error: string | null;
}

const IDLE_MIN_RECORDED_MS = 1000;

/**
 * State and plumbing of the Recordly AI automation layer: the REST server, the renderer
 * bridges, the event log and the journal of the recording in progress.
 */
export class AutomationController {
	readonly bus = new AutomationEventBus();
	readonly rpc = new AutomationRpc();
	readonly journal: JournalStore;
	readonly prepared = new Map<string, PreparedNarration>();
	readonly jobs = new Map<string, ExportJob>();
	settings: AutomationSettings;
	lastStatus: RecordingStatusSnapshot | null = null;
	private server: RunningAutomationServer | null = null;
	private serverError: string | null = null;
	private token: string;
	private pendingRestStart: { autoEdit: AutoEditOptions } | null = null;
	private finalizedVideoPath: string | null = null;
	private lastClockAtStop: number | null = null;
	/** Video of the previous take: a cancelled/failed take still reports it as "current". */
	private sessionStartVideoPath: string | null = null;
	private sessionDiscarded = false;
	private exportEditor: WebContents | null = null;
	private idleOverrideActive = false;
	private readyLogged = false;
	private router: AutomationRouter | null = null;

	constructor(readonly host: AutomationHost) {
		this.settings = readAutomationSettings();
		this.token = ensureAutomationToken(host.userDataPath);
		this.journal = new JournalStore(path.join(getAutomationDir(host.userDataPath), "sessions"));
	}

	get serverMode() {
		return this.host.launch.server;
	}

	get isServing() {
		return this.server !== null;
	}

	get tokenPath() {
		return getTokenPath(this.host.userDataPath);
	}

	get preparedDir() {
		return path.join(getAutomationDir(this.host.userDataPath), "prepared");
	}

	get serverStatus() {
		return {
			running: this.server !== null,
			baseUrl: this.server?.baseUrl ?? null,
			port: this.server?.port ?? null,
			tokenFile: this.server ? this.tokenPath : null,
			error: this.serverError,
		};
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────

	register(ipcMain: IpcMain, router: AutomationRouter) {
		this.router = router;
		this.rpc.register(ipcMain);
		this.rpc.onRendererEvent((event, role) =>
			this.handleRendererEvent(event.type, event.data, role),
		);

		ipcMain.handle("automation:get-runtime-info", () => ({
			serverMode: this.serverMode,
			restEnabled: this.settings.restEnabled,
			port: this.server?.port ?? null,
		}));
		ipcMain.handle("automation:get-settings", () => this.settings);
		ipcMain.handle(
			"automation:set-settings",
			async (_event, patch: Partial<AutomationSettings>) => this.updateSettings(patch ?? {}),
		);
		ipcMain.handle("automation:get-server-status", () => ({
			...this.serverStatus,
			token: this.server ? this.token : null,
		}));
		ipcMain.handle("automation:rotate-token", async () => {
			this.token = ensureAutomationToken(this.host.userDataPath, true);
			if (this.server) await this.restartServer();
			return { ...this.serverStatus, token: this.server ? this.token : null };
		});
		ipcMain.handle("automation:read-journal", async (_event, videoPath: string) => {
			if (typeof videoPath !== "string" || !videoPath) return null;
			const journal = await readJournalSidecar(videoPath);
			// Project loads replace the media allowlist; re-approve narration files every read.
			for (const audio of journal?.audio ?? []) approveUserPath(audio.path);
			return journal;
		});
		ipcMain.handle(
			"automation:mark-journal-applied",
			async (_event, videoPath: string, part: "content" | "autoEdit", appliedIds: unknown) =>
				this.markJournalApplied(
					videoPath,
					part,
					Array.isArray(appliedIds)
						? appliedIds.filter((id) => typeof id === "string")
						: [],
				),
		);
	}

	async start() {
		if (this.serverMode || this.settings.restEnabled) {
			await this.startServer();
		}
	}

	async stop() {
		await this.journal.flush();
		if (this.server) {
			await this.server.close().catch(() => undefined);
			this.server = null;
		}
		removeServerInfo(this.host.userDataPath);
	}

	private async startServer() {
		if (this.server || !this.router) return;
		const port = resolveAutomationPort(this.host.launch, this.settings.port);
		try {
			this.server = await startAutomationServer({
				router: this.router,
				token: this.token,
				port,
				onRequestError: (error, method, requestPath) => {
					const status = (error as { status?: number }).status ?? 500;
					if (status >= 500) {
						console.warn(`[automation] ${method} ${requestPath} failed:`, error);
					}
				},
			});
			this.serverError = null;
			writeServerInfo(
				this.host.userDataPath,
				createServerInfo({
					port: this.server.port,
					appVersion: this.host.appVersion,
					serverMode: this.serverMode,
					userDataPath: this.host.userDataPath,
				}),
			);
			console.log(`[automation] REST API listening on ${this.server.baseUrl}`);
			void this.rpc.waitForBridge("hud", 120_000).then((ready) => this.logReady(ready));
		} catch (error) {
			this.serverError =
				(error as NodeJS.ErrnoException).code === "EADDRINUSE"
					? `Port ${port} is already in use.`
					: error instanceof Error
						? error.message
						: String(error);
			console.error("[automation] REST API failed to start:", this.serverError);
		}
	}

	private async restartServer() {
		if (this.server) {
			await this.server.close().catch(() => undefined);
			this.server = null;
		}
		await this.startServer();
	}

	private logReady(hudReady: boolean) {
		if (this.readyLogged || !this.server) return;
		this.readyLogged = true;
		const info = {
			baseUrl: this.server.baseUrl,
			port: this.server.port,
			tokenFile: this.tokenPath,
			hudReady,
			serverMode: this.serverMode,
		};
		// One machine-readable line for launchers that do read stdout (dev, CLI starts).
		console.log(`RECORDLY_AI_READY ${JSON.stringify(info)}`);
		this.bus.publish("app.ready", info);
	}

	async updateSettings(patch: Partial<AutomationSettings>) {
		const previous = this.settings;
		this.settings = writeAutomationSettings(patch);
		this.notifyRenderers("settings-changed", this.settings);
		this.bus.publish("settings.changed", { automation: this.settings });
		if (!this.serverMode) {
			if (this.settings.restEnabled && !this.server) await this.startServer();
			else if (!this.settings.restEnabled && this.server) await this.stop();
			else if (this.server && previous.port !== this.settings.port)
				await this.restartServer();
		}
		return this.settings;
	}

	/** Sends an existing app channel (e.g. `selected-source-changed`) to every window. */
	notifyRenderersRaw(channel: string, payload: unknown) {
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.isDestroyed()) {
				window.webContents.send(channel, payload);
			}
		}
	}

	notifyRenderers(type: string, data: unknown) {
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.isDestroyed()) {
				window.webContents.send("automation:notification", type, data);
			}
		}
	}

	// ── Recording session & journal ──────────────────────────────────────────

	defaultAutoEdit(overrides: Partial<AutoEditOptions> = {}): AutoEditOptions {
		return {
			speedUpIdle: this.settings.autoEditOnStop,
			targetMs: this.settings.idleTargetSeconds * 1000,
			keepMs: this.settings.idleKeepMs,
			maxSpeed: this.settings.idleMaxSpeed,
			speedBadge: this.settings.idleSpeedBadge,
			presetId: this.settings.defaultPresetId,
			...overrides,
		};
	}

	/** Called right before the REST start command so the new session inherits its options. */
	expectRestStart(autoEdit: AutoEditOptions) {
		this.pendingRestStart = { autoEdit };
	}

	clearRestStart() {
		this.pendingRestStart = null;
	}

	get sessionId() {
		return this.journal.current?.sessionId ?? null;
	}

	get isSessionFinalized() {
		return this.finalizedVideoPath !== null;
	}

	/** Sends a HUD command, bringing the HUD back first when it was closed after a recording. */
	async sendToHud<T>(command: string, args: unknown = {}, timeoutMs = 30_000): Promise<T> {
		if (!this.rpc.isReady("hud")) {
			this.host.ensureHudWindow();
			await this.rpc.waitForBridge("hud", 30_000);
		}
		return this.rpc.send<T>("hud", command, args, timeoutMs);
	}

	/** Recording-relative "now", read fresh from the HUD so pauses are accounted for exactly. */
	async nowRecordingMs(receivedAt = Date.now()): Promise<number> {
		let status = this.lastStatus;
		try {
			status = await this.rpc.send<RecordingStatusSnapshot>(
				"hud",
				"recording.status",
				{},
				2000,
			);
			this.lastStatus = status;
		} catch {
			// Fall back to the last pushed snapshot.
		}
		if (!status?.recording || !status.clock) {
			throw conflict(
				"Not recording: pass an explicit `atMs` (recording time) to place content after the recording stopped.",
			);
		}
		return getRecordingTimeMs(status.clock, receivedAt);
	}

	/** Resolves where content lands: explicit `atMs`, else "now" (+ optional `offsetMs`). */
	async resolveAtMs(body: Record<string, unknown>, receivedAt = Date.now()): Promise<number> {
		const offset =
			typeof body.offsetMs === "number" && Number.isFinite(body.offsetMs) ? body.offsetMs : 0;
		if (typeof body.atMs === "number" && Number.isFinite(body.atMs)) {
			return Math.max(0, Math.round(body.atMs + offset));
		}
		return Math.max(0, Math.round((await this.nowRecordingMs(receivedAt)) + offset));
	}

	requireJournal(): SessionJournal {
		const journal = this.journal.current;
		if (!journal) {
			throw conflict(
				"No automated recording session. Start one with POST /v1/recording/start.",
			);
		}
		return journal;
	}

	async sessionMediaDir() {
		const journal = this.requireJournal();
		const dir = path.join(await getRecordingsDir(), "automation", journal.sessionId);
		await fs.mkdir(dir, { recursive: true });
		return dir;
	}

	getFfprobePath() {
		return getFfprobeBinaryPath();
	}

	/** Applies a journal mutation, persists it and keeps an already-open editor in sync. */
	async mutateJournal(mutator: (journal: SessionJournal) => void) {
		this.requireJournal();
		this.journal.mutate(mutator);
		if (this.finalizedVideoPath) {
			await this.journal.syncSidecar();
			if (this.rpc.isReady("editor")) {
				void this.rpc
					.send("editor", "editor.applyJournal", { autoEdit: false }, 30_000)
					.catch(() => undefined);
			}
		}
	}

	/** Idle threshold for the next take only; the GUI setting stays untouched. */
	overrideIdleThresholdForSession(seconds: number) {
		this.idleOverrideActive = true;
		this.notifyRenderers("settings-changed", {
			...this.settings,
			idleThresholdSeconds: Math.min(600, Math.max(1, seconds)),
		});
	}

	/** The take was cancelled: its journal must never be written next to any video. */
	discardSession() {
		if (!this.journal.current || this.finalizedVideoPath) return;
		this.sessionDiscarded = true;
		this.bus.publish("recording.discarded", { sessionId: this.sessionId });
	}

	async finalizeSession(videoPath: string | null, clockMsAtStop: number | null) {
		const journal = this.journal.current;
		if (!journal || !videoPath || this.sessionDiscarded) return;
		if (this.finalizedVideoPath) return;
		if (
			this.sessionStartVideoPath &&
			path.resolve(videoPath) === path.resolve(this.sessionStartVideoPath)
		) {
			// No new video was produced (cancel, failed stop): keep the previous sidecar intact.
			this.discardSession();
			return;
		}
		this.finalizedVideoPath = videoPath;
		await this.journal.finalize(videoPath, clockMsAtStop ?? this.lastClockAtStop);
		for (const audio of journal.audio) approveUserPath(audio.path);
		this.bus.publish("recording.finalized", {
			sessionId: journal.sessionId,
			videoPath,
			journal: {
				captions: journal.captions.length,
				audio: journal.audio.length,
				markers: journal.markers.length,
				idle: journal.idle.length,
			},
		});
	}

	private async markJournalApplied(
		videoPath: string,
		part: "content" | "autoEdit",
		appliedIds: string[],
	) {
		const now = new Date().toISOString();
		const apply = (journal: SessionJournal) => {
			if (part === "content") journal.appliedAt = now;
			else journal.autoEditAppliedAt = now;
			journal.appliedIds = [...new Set([...(journal.appliedIds ?? []), ...appliedIds])];
		};
		// The live session owns its sidecar: update it in memory and let the store write it, so
		// content that arrives after stop is never overwritten by a stale read-modify-write.
		const current = this.journal.current;
		if (current?.videoPath && path.resolve(current.videoPath) === path.resolve(videoPath)) {
			this.journal.mutate(apply);
			await this.journal.syncSidecar();
			return;
		}
		const journal = await readJournalSidecar(videoPath);
		if (!journal) return;
		apply(journal);
		await writeJournalSidecar(videoPath, journal);
	}

	private startSession() {
		const sessionId = randomUUID();
		const restStart = this.pendingRestStart;
		this.pendingRestStart = null;
		this.finalizedVideoPath = null;
		this.lastClockAtStop = null;
		this.sessionDiscarded = false;
		this.sessionStartVideoPath = currentRecordingSession?.videoPath ?? currentVideoPath ?? null;
		this.journal.start(sessionId);
		// Recordings started by hand keep upstream behavior: no automatic speed-ups.
		this.journal.mutate((journal) => {
			journal.autoEdit = restStart?.autoEdit ?? null;
		});
		return sessionId;
	}

	private handleRendererEvent(type: string, data: unknown, role: string | null) {
		const payload = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
		switch (type) {
			case "recording.state":
				this.handleRecordingState(payload as unknown as RecordingStatusSnapshot);
				return;
			case "recording.finalized":
				void this.finalizeSession(
					typeof payload.videoPath === "string" ? payload.videoPath : null,
					typeof payload.clockMsAtStop === "number" ? payload.clockMsAtStop : null,
				).catch((error) => console.warn("[automation] journal finalize failed:", error));
				return;
			case "idle.started":
				this.bus.publish("idle.started", { ...payload, sessionId: this.sessionId });
				return;
			case "idle.ended": {
				const startMs = Number(payload.startMs);
				const endMs = Number(payload.endMs);
				this.bus.publish("idle.ended", { ...payload, sessionId: this.sessionId });
				if (
					this.journal.current &&
					Number.isFinite(startMs) &&
					Number.isFinite(endMs) &&
					endMs - startMs >= IDLE_MIN_RECORDED_MS
				) {
					this.journal.mutate((journal) => {
						journal.idle.push({
							startMs: Math.round(startMs),
							endMs: Math.round(endMs),
						});
					});
				}
				return;
			}
			case "export.progress":
			case "export.done":
			case "export.failed":
				this.updateExportJob(type, payload);
				this.bus.publish(type, { ...payload, jobId: this.activeJob()?.id ?? null });
				return;
			default:
				this.bus.publish(type, { ...payload, ...(role ? { from: role } : {}) });
		}
	}

	private handleRecordingState(next: RecordingStatusSnapshot) {
		const previous = this.lastStatus;
		this.lastStatus = next;
		if (!this.server) return;

		if (next.starting && !previous?.starting && !next.recording) {
			this.bus.publish("recording.starting", {});
		}
		if (next.countdownActive && !previous?.countdownActive) {
			this.bus.publish("recording.countdown", { seconds: next.countdownDelay });
		}
		if (next.recording && !previous?.recording) {
			const sessionId = this.startSession();
			this.bus.publish("recording.started", { sessionId });
		}
		if (next.recording && previous?.recording && next.paused !== previous.paused) {
			const atMs = next.clock ? getRecordingTimeMs(next.clock, Date.now()) : null;
			this.bus.publish(next.paused ? "recording.paused" : "recording.resumed", {
				sessionId: this.sessionId,
				atMs,
			});
		}
		if (!next.recording && previous?.recording) {
			this.lastClockAtStop = previous.clock
				? getRecordingTimeMs(previous.clock, Date.now())
				: null;
			this.bus.publish("recording.stopped", { sessionId: this.sessionId });
			if (this.idleOverrideActive) {
				this.idleOverrideActive = false;
				this.notifyRenderers("settings-changed", this.settings);
			}
		}
	}

	// ── Export jobs ──────────────────────────────────────────────────────────

	/**
	 * Registers a REST export: the editor's next finalize writes to `outputPath`. The target is
	 * dropped as soon as the job ends any other way, so later manual exports get their dialog.
	 */
	createExportJob(outputPath: string, format: string, editor: WebContents): ExportJob {
		setAutomationExportPath(editor, outputPath);
		this.exportEditor = editor;
		editor.once("destroyed", () => {
			if (this.exportEditor === editor) {
				this.failActiveJob("The editor closed during the export.");
			}
		});
		const job: ExportJob = {
			id: randomUUID(),
			status: "running",
			outputPath,
			format,
			startedAt: new Date().toISOString(),
			finishedAt: null,
			percent: 0,
			phase: null,
			error: null,
		};
		this.jobs.set(job.id, job);
		return job;
	}

	activeJob(): ExportJob | null {
		for (const job of this.jobs.values()) {
			if (job.status === "running") return job;
		}
		return null;
	}

	failActiveJob(message: string) {
		const job = this.activeJob();
		if (job) {
			job.status = "failed";
			job.error = message;
			job.finishedAt = new Date().toISOString();
			this.bus.publish("export.failed", { jobId: job.id, message });
		}
		this.releaseExportTarget();
	}

	private releaseExportTarget() {
		if (this.exportEditor && !this.exportEditor.isDestroyed()) {
			clearAutomationExportPath(this.exportEditor);
		}
		this.exportEditor = null;
	}

	private updateExportJob(type: string, payload: Record<string, unknown>) {
		const job = this.activeJob();
		if (!job) return;
		if (type === "export.progress") {
			job.percent = Number(payload.percent) || job.percent;
			job.phase = typeof payload.phase === "string" ? payload.phase : job.phase;
			return;
		}
		job.finishedAt = new Date().toISOString();
		if (type === "export.done") {
			job.status = "done";
			job.percent = 100;
			if (typeof payload.path === "string") job.outputPath = payload.path;
		} else {
			job.status = "failed";
			job.error = typeof payload.message === "string" ? payload.message : "Export failed.";
		}
		this.releaseExportTarget();
	}
}
