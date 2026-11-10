export interface AutomationEvent {
	seq: number;
	type: string;
	at: string;
	data: unknown;
}

type Listener = (event: AutomationEvent) => void;

function matchesTypes(event: AutomationEvent, types: readonly string[] | null) {
	if (!types || types.length === 0) return true;
	return types.some((type) =>
		type.endsWith(".*") ? event.type.startsWith(type.slice(0, -1)) : event.type === type,
	);
}

/**
 * In-memory event log with monotonically increasing sequence numbers. Agents either stream
 * it (SSE) or block on `waitNext` (long-poll), resuming from the last `seq` they saw.
 */
export class AutomationEventBus {
	private readonly events: AutomationEvent[] = [];
	private readonly listeners = new Set<Listener>();
	private nextSeq = 1;

	constructor(
		private readonly capacity = 2000,
		private readonly now: () => Date = () => new Date(),
	) {}

	get lastSeq() {
		return this.nextSeq - 1;
	}

	publish(type: string, data: unknown = null): AutomationEvent {
		const event: AutomationEvent = {
			seq: this.nextSeq++,
			type,
			at: this.now().toISOString(),
			data,
		};
		this.events.push(event);
		if (this.events.length > this.capacity) {
			this.events.splice(0, this.events.length - this.capacity);
		}
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				console.warn("[automation] event listener failed:", error);
			}
		}
		return event;
	}

	since(afterSeq: number, types: readonly string[] | null = null): AutomationEvent[] {
		return this.events.filter((event) => event.seq > afterSeq && matchesTypes(event, types));
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Resolves with the first matching event after `afterSeq`, or null on timeout. */
	waitNext(
		afterSeq: number,
		types: readonly string[] | null,
		timeoutMs: number,
	): Promise<AutomationEvent | null> {
		const existing = this.since(afterSeq, types)[0];
		if (existing) return Promise.resolve(existing);

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				unsubscribe();
				resolve(null);
			}, timeoutMs);
			const unsubscribe = this.subscribe((event) => {
				if (event.seq > afterSeq && matchesTypes(event, types)) {
					clearTimeout(timer);
					unsubscribe();
					resolve(event);
				}
			});
		});
	}
}
