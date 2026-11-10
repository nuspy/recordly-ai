export type IdleDetectorEvent =
	| { type: "idle.started"; atMs: number; lastChangeMs: number }
	| { type: "idle.ended"; atMs: number; startMs: number; endMs: number; idleMs: number };

export interface IdleDetectorOptions {
	/** No visual change for this long → idle (GUI setting X). */
	idleAfterMs: number;
	/** Changed-pixel fraction above which a frame counts as a change. */
	changeThreshold: number;
	/** Consecutive changed samples needed to end an idle period (filters single blips). */
	changeConfirmSamples?: number;
}

/**
 * Hysteresis state machine over `(timeMs, changedFraction)` samples. Times are recording
 * time, so the idle interval it reports can be accelerated directly in the editor.
 * The idle interval starts at the last change, not when the threshold elapsed: the whole
 * dead time is what the editor compresses.
 */
export class IdleDetector {
	private lastChangeMs: number | null = null;
	private idle = false;
	private pendingChange = 0;
	private pendingChangeStartMs: number | null = null;

	constructor(private options: IdleDetectorOptions) {}

	get isIdle() {
		return this.idle;
	}

	configure(options: Partial<IdleDetectorOptions>) {
		this.options = { ...this.options, ...options };
	}

	reset(nowMs: number) {
		this.lastChangeMs = nowMs;
		this.idle = false;
		this.pendingChange = 0;
		this.pendingChangeStartMs = null;
	}

	push(timeMs: number, fraction: number): IdleDetectorEvent[] {
		if (this.lastChangeMs === null) {
			this.reset(timeMs);
			return [];
		}
		const events: IdleDetectorEvent[] = [];
		const changed = fraction > this.options.changeThreshold;
		const confirmSamples = Math.max(1, this.options.changeConfirmSamples ?? 1);

		if (changed) {
			if (this.idle) {
				this.pendingChange++;
				this.pendingChangeStartMs ??= timeMs;
				if (this.pendingChange >= confirmSamples) {
					const startMs = this.lastChangeMs;
					const endMs = this.pendingChangeStartMs;
					events.push({
						type: "idle.ended",
						atMs: timeMs,
						startMs,
						endMs,
						idleMs: endMs - startMs,
					});
					this.idle = false;
					this.lastChangeMs = timeMs;
					this.pendingChange = 0;
					this.pendingChangeStartMs = null;
				}
			} else {
				this.lastChangeMs = timeMs;
			}
			return events;
		}

		this.pendingChange = 0;
		this.pendingChangeStartMs = null;
		if (!this.idle && timeMs - this.lastChangeMs >= this.options.idleAfterMs) {
			this.idle = true;
			events.push({ type: "idle.started", atMs: timeMs, lastChangeMs: this.lastChangeMs });
		}
		return events;
	}

	/** Closes an open idle period (recording stopped/paused while the screen was static). */
	flush(timeMs: number): IdleDetectorEvent[] {
		if (!this.idle || this.lastChangeMs === null) return [];
		const startMs = this.lastChangeMs;
		this.idle = false;
		this.lastChangeMs = timeMs;
		return [
			{ type: "idle.ended", atMs: timeMs, startMs, endMs: timeMs, idleMs: timeMs - startMs },
		];
	}
}
