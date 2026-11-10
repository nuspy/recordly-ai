// Shared, dependency-free contract between the Recordly AI automation layer in the main
// process and the renderer bridges (HUD + editor). Keep this file free of Node/Electron
// imports: the renderer imports it through a relative path.

export const AUTOMATION_API_VERSION = 1;
export const DEFAULT_AUTOMATION_PORT = 47800;

export type AutomationBridgeRole = "hud" | "editor";

export interface AutomationCommandMessage {
	requestId: string;
	command: string;
	args: unknown;
}

export interface AutomationResultMessage {
	requestId: string;
	ok: boolean;
	result?: unknown;
	error?: { code: string; message: string };
}

export interface AutomationRendererEvent {
	type: string;
	data?: unknown;
}

export interface AutomationRuntimeInfo {
	serverMode: boolean;
	restEnabled: boolean;
	port: number | null;
}

/** Recording clock as kept by `useScreenRecorder` (all values are `Date.now()` epoch ms). */
export interface RecordingClockSnapshot {
	startTimeMs: number;
	accumulatedPausedMs: number;
	pauseStartedAtMs: number | null;
}

export interface RecordingStatusSnapshot {
	recording: boolean;
	paused: boolean;
	starting: boolean;
	finalizing: boolean;
	countdownActive: boolean;
	clock: RecordingClockSnapshot | null;
	microphoneEnabled: boolean;
	systemAudioEnabled: boolean;
	webcamEnabled: boolean;
	countdownDelay: number;
}

/**
 * Recording-relative time (ms of recorded footage, pauses excluded) at `atEpochMs`.
 * While paused the clock is frozen at the pause boundary, so content sent during a pause
 * lands exactly where the recording resumes.
 */
export function getRecordingTimeMs(snapshot: RecordingClockSnapshot, atEpochMs: number): number {
	const effectiveNow =
		snapshot.pauseStartedAtMs !== null
			? Math.min(atEpochMs, snapshot.pauseStartedAtMs)
			: atEpochMs;
	return Math.max(0, effectiveNow - snapshot.startTimeMs - snapshot.accumulatedPausedMs);
}

// ── Automation settings (persisted under app-settings key `recordlyAi.automation`) ──

export type SttBackendPreference = "auto" | "bridge" | "local";

export interface AutomationSettings {
	/** Expose the REST API in normal GUI mode (always on with --server). */
	restEnabled: boolean;
	port: number;
	/** Seconds without visual change before an idle period starts (GUI setting X). */
	idleThresholdSeconds: number;
	/** Target on-screen duration of an accelerated idle period (GUI setting Y). */
	idleTargetSeconds: number;
	/** Normal-speed lead-in/lead-out kept at both ends of an idle period. */
	idleKeepMs: number;
	/** Preview playback cannot exceed 16x (Chromium playbackRate cap). */
	idleMaxSpeed: number;
	/** Fraction of sampled pixels that must change to count as "changed". */
	idleChangeThreshold: number;
	/** Show a "⏩ ×N" badge over accelerated spans. */
	idleSpeedBadge: boolean;
	/** Apply idle speed-ups automatically when an automated recording opens in the editor. */
	autoEditOnStop: boolean;
	sttBackend: SttBackendPreference;
	/** CallAPICall handy-compat server (STT/TTS). */
	bridgeUrl: string;
	/** CallAPICall control server (session state, engine status). */
	bridgeControlUrl: string;
	bridgeControlToken: string;
	/** How long to wait for an active CallAPICall voice session before transcribing locally. */
	bridgeBusyTimeoutSeconds: number;
	/** NVIDIA GPU (nvidia-smi UUID) used by local whisper.cpp; "" lets CUDA pick the fastest. */
	sttGpuId: string;
	ttsVoice: string;
	ttsLanguage: string;
	/** Editor preset applied to automated recordings (null = keep editor defaults). */
	defaultPresetId: string | null;
}

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
	restEnabled: false,
	port: DEFAULT_AUTOMATION_PORT,
	idleThresholdSeconds: 6,
	idleTargetSeconds: 10,
	idleKeepMs: 1000,
	idleMaxSpeed: 16,
	idleChangeThreshold: 0.002,
	idleSpeedBadge: true,
	autoEditOnStop: true,
	sttBackend: "auto",
	bridgeUrl: "http://127.0.0.1:8720",
	bridgeControlUrl: "http://127.0.0.1:8770",
	bridgeControlToken: "",
	bridgeBusyTimeoutSeconds: 600,
	sttGpuId: "",
	ttsVoice: "if_sara",
	ttsLanguage: "it",
	defaultPresetId: null,
};

/** `GPU-<uuid>` (or `MIG-...`) as printed by nvidia-smi: the only accepted GPU selector. */
export const GPU_ID_PATTERN = /^(GPU|MIG)-[0-9A-Za-z-]+$/;

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(numeric)) return fallback;
	return Math.min(max, Math.max(min, numeric));
}

function readString(value: unknown, fallback: string) {
	return typeof value === "string" ? value.trim() : fallback;
}

export function normalizeAutomationSettings(raw: unknown): AutomationSettings {
	const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const d = DEFAULT_AUTOMATION_SETTINGS;
	const sttBackend =
		input.sttBackend === "bridge" || input.sttBackend === "local" || input.sttBackend === "auto"
			? input.sttBackend
			: d.sttBackend;
	return {
		restEnabled: typeof input.restEnabled === "boolean" ? input.restEnabled : d.restEnabled,
		port: Math.round(clampNumber(input.port, d.port, 1024, 65535)),
		idleThresholdSeconds: clampNumber(
			input.idleThresholdSeconds,
			d.idleThresholdSeconds,
			1,
			600,
		),
		idleTargetSeconds: clampNumber(input.idleTargetSeconds, d.idleTargetSeconds, 1, 600),
		idleKeepMs: Math.round(clampNumber(input.idleKeepMs, d.idleKeepMs, 0, 10_000)),
		idleMaxSpeed: clampNumber(input.idleMaxSpeed, d.idleMaxSpeed, 1, 16),
		idleChangeThreshold: clampNumber(input.idleChangeThreshold, d.idleChangeThreshold, 0, 0.5),
		idleSpeedBadge:
			typeof input.idleSpeedBadge === "boolean" ? input.idleSpeedBadge : d.idleSpeedBadge,
		autoEditOnStop:
			typeof input.autoEditOnStop === "boolean" ? input.autoEditOnStop : d.autoEditOnStop,
		sttBackend,
		bridgeUrl: readString(input.bridgeUrl, d.bridgeUrl) || d.bridgeUrl,
		bridgeControlUrl:
			readString(input.bridgeControlUrl, d.bridgeControlUrl) || d.bridgeControlUrl,
		bridgeControlToken: readString(input.bridgeControlToken, d.bridgeControlToken),
		bridgeBusyTimeoutSeconds: clampNumber(
			input.bridgeBusyTimeoutSeconds,
			d.bridgeBusyTimeoutSeconds,
			0,
			3600,
		),
		sttGpuId:
			typeof input.sttGpuId === "string" && GPU_ID_PATTERN.test(input.sttGpuId.trim())
				? input.sttGpuId.trim()
				: d.sttGpuId,
		ttsVoice: readString(input.ttsVoice, d.ttsVoice) || d.ttsVoice,
		ttsLanguage: readString(input.ttsLanguage, d.ttsLanguage),
		defaultPresetId:
			typeof input.defaultPresetId === "string" && input.defaultPresetId.trim()
				? input.defaultPresetId.trim()
				: null,
	};
}

// ── Session journal (sidecar `<video>.recordly-automation.json`) ──

export const JOURNAL_VERSION = 1;
export const JOURNAL_SIDECAR_SUFFIX = ".recordly-automation.json";

export interface JournalCaptionWord {
	text: string;
	startMs: number;
	endMs: number;
	leadingSpace?: boolean;
}

export interface JournalCaption {
	id: string;
	startMs: number;
	endMs: number;
	text: string;
	words?: JournalCaptionWord[];
	narrationId?: string;
}

export interface JournalAudio {
	id: string;
	path: string;
	atMs: number;
	durationMs: number;
	volume: number;
	trackIndex?: number;
	narrationId?: string;
	label?: string;
}

export type JournalMarkerKind = "step" | "chapter" | "note" | "discard-start" | "discard-end";

export interface JournalMarker {
	id: string;
	atMs: number;
	label: string;
	kind: JournalMarkerKind;
}

export interface JournalIdleInterval {
	startMs: number;
	endMs: number;
}

export interface JournalZoom {
	id: string;
	startMs: number;
	endMs: number;
	/** Normalized 0..1 rectangle of the recorded source to zoom onto. */
	rect: { x: number; y: number; width: number; height: number };
}

export interface JournalAnnotation {
	id: string;
	startMs: number;
	endMs: number;
	type: "text" | "blur";
	text?: string;
	rect?: { x: number; y: number; width: number; height: number };
}

export interface AutoEditOptions {
	speedUpIdle: boolean;
	targetMs: number;
	keepMs: number;
	maxSpeed: number;
	speedBadge: boolean;
	presetId: string | null;
}

export interface SessionJournal {
	version: number;
	sessionId: string;
	createdAt: string;
	videoPath: string | null;
	/** Recording clock reading when the recording stopped (used to calibrate offsets). */
	clockMsAtStop: number | null;
	captions: JournalCaption[];
	audio: JournalAudio[];
	markers: JournalMarker[];
	idle: JournalIdleInterval[];
	zooms: JournalZoom[];
	annotations: JournalAnnotation[];
	autoEdit: AutoEditOptions | null;
	/** Set by the editor once captions/audio/markers have been merged into the project. */
	appliedAt: string | null;
	/** Set by the editor once idle speed-ups have been applied (they must run only once). */
	autoEditAppliedAt: string | null;
	/** Journal item ids already merged into the project (deleted items must not return). */
	appliedIds: string[];
}

export function createEmptyJournal(sessionId: string, now = new Date()): SessionJournal {
	return {
		version: JOURNAL_VERSION,
		sessionId,
		createdAt: now.toISOString(),
		videoPath: null,
		clockMsAtStop: null,
		captions: [],
		audio: [],
		markers: [],
		idle: [],
		zooms: [],
		annotations: [],
		autoEdit: null,
		appliedAt: null,
		autoEditAppliedAt: null,
		appliedIds: [],
	};
}

export function getJournalSidecarPath(videoPath: string) {
	return `${videoPath}${JOURNAL_SIDECAR_SUFFIX}`;
}
