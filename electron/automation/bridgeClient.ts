// HTTP client for the CallAPICall bridge (handy-compat STT/TTS server + control server).
// Recordly AI shares the bridge's already-loaded Whisper model instead of loading its own,
// so the VRAM is not spent twice on the same model.

export interface BridgeEndpoints {
	/** handy-compat server, e.g. http://127.0.0.1:8720 (no auth). */
	bridgeUrl: string;
	/** control server, e.g. http://127.0.0.1:8770 (Bearer when a token is configured). */
	bridgeControlUrl: string;
	bridgeControlToken?: string;
}

export interface BridgeTranscriptWord {
	start_s: number;
	end_s: number;
	text: string;
}

export interface BridgeTranscriptSegment {
	start_s: number;
	end_s: number;
	text: string;
	words?: BridgeTranscriptWord[];
}

export interface BridgeTranscript {
	text: string;
	segments: BridgeTranscriptSegment[];
}

export interface BridgeSpeech {
	wav: Buffer;
	sampleRate: number;
	durationMs: number;
	voice: string;
	engine: string;
}

export interface BridgeSessionState {
	active: boolean;
	mode?: string | null;
	phase?: string | null;
}

export class BridgeError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "BridgeError";
	}
}

function trimBase(url: string) {
	return url.replace(/\/+$/, "");
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} catch (error) {
		if (controller.signal.aborted) {
			throw new BridgeError(`CallAPICall bridge request timed out: ${url}`);
		}
		throw new BridgeError(
			`CallAPICall bridge unreachable (${url}): ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timer);
	}
}

async function readJson<T>(response: Response, url: string): Promise<T> {
	const text = await response.text();
	if (!response.ok) {
		throw new BridgeError(
			`CallAPICall bridge ${url} failed with HTTP ${response.status}: ${text.slice(0, 300)}`,
			response.status,
		);
	}
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new BridgeError(`CallAPICall bridge ${url} returned invalid JSON.`);
	}
}

function controlHeaders(endpoints: BridgeEndpoints): Record<string, string> {
	const token = endpoints.bridgeControlToken?.trim();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function isBridgeReachable(endpoints: BridgeEndpoints, timeoutMs = 1500) {
	try {
		const url = `${trimBase(endpoints.bridgeUrl)}/health`;
		const response = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Voice sessions/calls share the bridge's Whisper inference lock: a long Recordly job would
 * delay them. Callers check this before every segment and wait while a session is active.
 * An unreachable control server is reported as "not active" (the STT server may run alone).
 */
export async function getBridgeSessionState(
	endpoints: BridgeEndpoints,
	timeoutMs = 1500,
): Promise<BridgeSessionState> {
	try {
		const url = `${trimBase(endpoints.bridgeControlUrl)}/session/state`;
		const response = await fetchWithTimeout(
			url,
			{ method: "GET", headers: controlHeaders(endpoints) },
			timeoutMs,
		);
		const body = await readJson<Record<string, unknown>>(response, url);
		return {
			active: body.active === true,
			mode: typeof body.mode === "string" ? body.mode : null,
			phase: typeof body.phase === "string" ? body.phase : null,
		};
	} catch {
		return { active: false };
	}
}

export async function getBridgeEngineStatus(endpoints: BridgeEndpoints, timeoutMs = 2000) {
	const url = `${trimBase(endpoints.bridgeControlUrl)}/engines/status`;
	const response = await fetchWithTimeout(
		url,
		{ method: "GET", headers: controlHeaders(endpoints) },
		timeoutMs,
	);
	return readJson<Record<string, unknown>>(response, url);
}

export async function transcribeWithBridge(
	endpoints: BridgeEndpoints,
	wav: Buffer,
	options: { language?: string | null; timeoutMs?: number } = {},
): Promise<BridgeTranscript> {
	const params = new URLSearchParams({ segments: "1", words: "1" });
	const language = options.language?.trim();
	if (language && language !== "auto") {
		params.set("lang", language);
	}
	const url = `${trimBase(endpoints.bridgeUrl)}/transcribe?${params.toString()}`;
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
	const response = await fetchWithTimeout(
		url,
		{ method: "POST", body: form },
		options.timeoutMs ?? 5 * 60 * 1000,
	);
	const body = await readJson<Partial<BridgeTranscript>>(response, url);
	return {
		text: typeof body.text === "string" ? body.text : "",
		segments: Array.isArray(body.segments) ? body.segments : [],
	};
}

export async function synthesizeWithBridge(
	endpoints: BridgeEndpoints,
	request: { text: string; voice?: string; lang?: string; engine?: string },
	timeoutMs = 2 * 60 * 1000,
): Promise<BridgeSpeech> {
	const url = `${trimBase(endpoints.bridgeUrl)}/tts/test`;
	const response = await fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(request),
		},
		timeoutMs,
	);
	const body = await readJson<Record<string, unknown>>(response, url);
	if (body.status !== "ok" && body.status !== "ready" && typeof body.audio_b64 !== "string") {
		throw new BridgeError(
			`CallAPICall TTS failed: ${String(body.message ?? body.status ?? "unknown error")}`,
		);
	}
	if (typeof body.audio_b64 !== "string" || !body.audio_b64) {
		throw new BridgeError("CallAPICall TTS returned no audio.");
	}
	return {
		wav: Buffer.from(body.audio_b64, "base64"),
		sampleRate: Number(body.sample_rate) || 24000,
		durationMs: Number(body.duration_ms) || 0,
		voice: String(body.voice ?? request.voice ?? ""),
		engine: String(body.engine ?? ""),
	};
}
