import fs from "node:fs/promises";
import path from "node:path";
import {
	createEmptyJournal,
	getJournalSidecarPath,
	JOURNAL_VERSION,
	type SessionJournal,
} from "./contract";

async function writeJsonAtomically(filePath: string, value: unknown) {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
	await fs.rename(tempPath, filePath);
}

export async function readJournalSidecar(videoPath: string): Promise<SessionJournal | null> {
	try {
		const parsed = JSON.parse(await fs.readFile(getJournalSidecarPath(videoPath), "utf8"));
		if (!parsed || parsed.version !== JOURNAL_VERSION || typeof parsed.sessionId !== "string") {
			return null;
		}
		return {
			...createEmptyJournal(parsed.sessionId, new Date(parsed.createdAt ?? Date.now())),
			...parsed,
		} as SessionJournal;
	} catch {
		return null;
	}
}

export async function writeJournalSidecar(videoPath: string, journal: SessionJournal) {
	await writeJsonAtomically(getJournalSidecarPath(videoPath), { ...journal, videoPath });
}

/**
 * Holds the journal of the automated recording in progress. Every mutation is persisted
 * (debounced) under userData so a crash mid-demo does not lose the narration timeline; when
 * the recording is finalized the journal moves next to the video as a sidecar, which the
 * editor merges into the project.
 */
export class JournalStore {
	private journal: SessionJournal | null = null;
	private flushTimer: NodeJS.Timeout | null = null;
	private flushChain: Promise<void> = Promise.resolve();

	constructor(
		private readonly sessionsDir: string,
		private readonly debounceMs = 250,
	) {}

	get current() {
		return this.journal;
	}

	start(sessionId: string): SessionJournal {
		this.journal = createEmptyJournal(sessionId);
		this.scheduleFlush();
		return this.journal;
	}

	mutate(mutator: (journal: SessionJournal) => void): SessionJournal | null {
		if (!this.journal) return null;
		mutator(this.journal);
		this.scheduleFlush();
		return this.journal;
	}

	/** Binds the journal to its video and writes the sidecar the editor will read. */
	async finalize(
		videoPath: string,
		clockMsAtStop: number | null,
	): Promise<SessionJournal | null> {
		if (!this.journal) return null;
		this.journal.videoPath = videoPath;
		this.journal.clockMsAtStop = clockMsAtStop;
		await this.flush();
		await writeJournalSidecar(videoPath, this.journal);
		return this.journal;
	}

	/** Re-writes the sidecar after content arrives once the recording already stopped. */
	async syncSidecar() {
		await this.flush();
		if (this.journal?.videoPath) {
			await writeJournalSidecar(this.journal.videoPath, this.journal);
		}
	}

	flush(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		const snapshot = this.journal ? structuredClone(this.journal) : null;
		if (!snapshot) return this.flushChain;
		const target = path.join(this.sessionsDir, `${snapshot.sessionId}.json`);
		this.flushChain = this.flushChain
			.then(() => writeJsonAtomically(target, snapshot))
			.catch((error) => console.warn("[automation] failed to persist journal:", error));
		return this.flushChain;
	}

	private scheduleFlush() {
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flush();
		}, this.debounceMs);
	}
}
