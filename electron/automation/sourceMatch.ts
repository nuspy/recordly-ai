export interface AutomationSource {
	id: string;
	name: string;
	display_id?: string;
	sourceType?: "screen" | "window";
	appName?: string;
	windowTitle?: string;
	originalName?: string;
}

export interface SourceSelector {
	id?: string;
	/** Case-insensitive regular expression (or plain substring) matched against the title. */
	title?: string;
	appName?: string;
	/** 0-based index among screens, in the order the OS reports them. */
	displayIndex?: number;
	type?: "screen" | "window";
}

function toMatcher(pattern: string) {
	try {
		const regex = new RegExp(pattern, "i");
		return (value: string) => regex.test(value);
	} catch {
		const needle = pattern.toLowerCase();
		return (value: string) => value.toLowerCase().includes(needle);
	}
}

function sourceType(source: AutomationSource) {
	return source.sourceType ?? (source.id.startsWith("screen:") ? "screen" : "window");
}

/**
 * Picks the source an agent described. Exact id wins; otherwise filters by type, app name and
 * title, preferring exact (case-insensitive) title equality over partial matches.
 */
export function matchSource(
	sources: readonly AutomationSource[],
	selector: SourceSelector,
): { source: AutomationSource | null; candidates: AutomationSource[] } {
	if (selector.id) {
		const source = sources.find((candidate) => candidate.id === selector.id) ?? null;
		return { source, candidates: source ? [source] : [] };
	}

	let candidates = sources.filter(
		(candidate) => !selector.type || sourceType(candidate) === selector.type,
	);

	if (typeof selector.displayIndex === "number") {
		const screens = candidates.filter((candidate) => sourceType(candidate) === "screen");
		const source = screens[selector.displayIndex] ?? null;
		return { source, candidates: source ? [source] : [] };
	}

	if (selector.appName) {
		const matches = toMatcher(selector.appName);
		candidates = candidates.filter((candidate) => matches(candidate.appName ?? ""));
	}

	if (selector.title) {
		const matches = toMatcher(selector.title);
		const lowered = selector.title.toLowerCase();
		const titled = candidates.filter((candidate) =>
			matches(candidate.windowTitle ?? candidate.name),
		);
		const exact = titled.filter(
			(candidate) => (candidate.windowTitle ?? candidate.name).toLowerCase() === lowered,
		);
		candidates = exact.length > 0 ? exact : titled;
	}

	if (!selector.appName && !selector.title && !selector.type) {
		return { source: null, candidates: [] };
	}
	return { source: candidates[0] ?? null, candidates };
}
