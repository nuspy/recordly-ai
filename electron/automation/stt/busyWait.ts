import type { BridgeSessionState } from "../bridgeClient";

export interface BusyWaitDeps {
	getSessionState: () => Promise<BridgeSessionState>;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
}

export const BRIDGE_BUSY_POLL_MS = 2_000;

export const realClock: Pick<BusyWaitDeps, "now" | "sleep"> = {
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Wait while a CallAPICall voice session holds the bridge's Whisper lock. Resolves "idle" as
 * soon as no session is active, or "timeout" once `timeoutMs` has elapsed with the session
 * still active. Nothing else is loaded meanwhile: the caller decides what to do on timeout.
 */
export async function waitForBridgeIdle(
	deps: BusyWaitDeps,
	options: { timeoutMs: number; pollMs?: number; onWaiting?: (waitedMs: number) => void },
): Promise<"idle" | "timeout"> {
	const pollMs = Math.max(1, options.pollMs ?? BRIDGE_BUSY_POLL_MS);
	const startedAt = deps.now();
	for (;;) {
		const state = await deps.getSessionState();
		if (!state.active) return "idle";
		const waitedMs = deps.now() - startedAt;
		if (waitedMs >= options.timeoutMs) return "timeout";
		options.onWaiting?.(waitedMs);
		await deps.sleep(Math.min(pollMs, options.timeoutMs - waitedMs));
	}
}
