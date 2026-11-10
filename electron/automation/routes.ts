import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { desktopCapturer } from "electron";
import { readAppSetting, writeAppSetting } from "../appSettingsStore";
import { loadProjectFromPath } from "../ipc/project/manager";
import { bringSelectedWindowForward } from "../ipc/register/sources";
import {
	currentProjectPath,
	selectedSource,
	setCurrentProjectPath,
	setCurrentRecordingSession,
	setCurrentVideoPath,
	setSelectedSource,
} from "../ipc/state";
import type { SelectedSource } from "../ipc/types";
import { approveUserPath, getRecordingsDir, getScreen } from "../ipc/utils";
import { resolveWindowsWindowBounds } from "../ipc/windowsWindowControl";
import { ingestAudio } from "./audioIngest";
import { isBridgeReachable, synthesizeWithBridge, transcribeWithBridge } from "./bridgeClient";
import {
	distributeNarrationCues,
	estimateSpeechDurationMs,
	groupWordsIntoCues,
	type TimedWord,
} from "./captionText";
import {
	AUTOMATION_API_VERSION,
	type AutoEditOptions,
	type AutomationSettings,
	type JournalCaption,
	type JournalMarkerKind,
	type RecordingStatusSnapshot,
} from "./contract";
import type { AutomationController } from "./controller";
import { isNormalizedRect, normalizeRectToSource, padNormalizedRect, type Rect } from "./geometry";
import {
	badRequest,
	conflict,
	HANDLED,
	HttpError,
	notFound,
	optionalBoolean,
	optionalNumber,
	optionalString,
	type RequestContext,
	requireString,
} from "./http";
import { AutomationRouter } from "./router";
import { type AutomationSource, matchSource, type SourceSelector } from "./sourceMatch";

const EDITOR_PRESETS_KEY = "recordly.editor.presets";
const MARKER_KINDS = new Set<JournalMarkerKind>([
	"step",
	"chapter",
	"note",
	"discard-start",
	"discard-end",
]);

type Body = Record<string, unknown>;

function asObject(value: unknown): Body {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Body) : {};
}

function readTypes(query: URLSearchParams): string[] | null {
	const raw = query.get("types");
	if (!raw) return null;
	return raw
		.split(",")
		.map((type) => type.trim())
		.filter(Boolean);
}

function clampVolume(value: number | undefined) {
	return value === undefined ? 1 : Math.min(4, Math.max(0, value));
}

function writeSse(
	ctx: RequestContext,
	event: { seq: number; type: string; at: string; data: unknown },
) {
	ctx.res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

/** Bounds of the selected source in the coordinate space UIA/agents use (physical pixels). */
async function getSelectedSourceBounds(space: "physical" | "dip"): Promise<Rect | null> {
	const source = selectedSource;
	if (!source?.id) return null;
	if (source.id.startsWith("window:")) {
		if (process.platform !== "win32") return null;
		return resolveWindowsWindowBounds(source);
	}
	const displays = getScreen().getAllDisplays();
	const display =
		displays.find((candidate) => String(candidate.id) === String(source.display_id)) ??
		displays[0];
	if (!display) return null;
	const scale = space === "physical" ? display.scaleFactor : 1;
	return {
		x: display.bounds.x * scale,
		y: display.bounds.y * scale,
		width: display.bounds.width * scale,
		height: display.bounds.height * scale,
	};
}

/** Accepts `rect` (normalized 0..1 of the recorded source) or `screenRect` (pixels). */
async function resolveTargetRect(body: Body): Promise<Rect> {
	const padding = optionalNumber(body, "padding");
	if (isNormalizedRect(body.rect)) {
		return padding ? padNormalizedRect(body.rect, padding) : body.rect;
	}
	if (isNormalizedRect(body.screenRect)) {
		const space = body.coordinateSpace === "dip" ? "dip" : "physical";
		const bounds = await getSelectedSourceBounds(space);
		if (!bounds) {
			throw badRequest(
				"Could not resolve the bounds of the selected source; pass `rect` instead.",
			);
		}
		const normalized = normalizeRectToSource(body.screenRect, bounds);
		if (!normalized) throw badRequest("`screenRect` lies outside the recorded source.");
		return padding === 0 ? normalized : padNormalizedRect(normalized, padding ?? 0.04);
	}
	throw badRequest("Provide `rect` (normalized) or `screenRect` (screen pixels).");
}

export function createAutomationRouter(controller: AutomationController): AutomationRouter {
	const router = new AutomationRouter();
	const { bus, rpc } = controller;

	const hudStatus = () =>
		controller.sendToHud<RecordingStatusSnapshot>("recording.status", {}, 5000);

	const listSources = async (types?: string[] | null) =>
		controller.sendToHud<AutomationSource[]>(
			"sources.list",
			{ types: types ?? ["screen", "window"] },
			15_000,
		);

	const selectSource = async (selector: SourceSelector, bringToFront: boolean) => {
		const sources = await listSources(selector.type ? [selector.type] : null);
		const { source, candidates } = matchSource(sources, selector);
		if (!source) {
			throw new HttpError(404, "source_not_found", "No source matches the selector.", {
				candidates: candidates.slice(0, 10).map((candidate) => ({
					id: candidate.id,
					name: candidate.name,
				})),
				available: sources.slice(0, 30).map((candidate) => ({
					id: candidate.id,
					name: candidate.name,
					type: candidate.sourceType,
				})),
			});
		}
		const selected: SelectedSource = { ...source };
		if (bringToFront && source.id.startsWith("window:")) {
			await bringSelectedWindowForward(selected).catch(() => null);
		}
		setSelectedSource(selected);
		controller.notifyRenderersRaw("selected-source-changed", selected);
		bus.publish("source.selected", { id: source.id, name: source.name });
		return source;
	};

	const parseSelector = (body: Body): SourceSelector | null => {
		const selector: SourceSelector = {
			id: optionalString(body, "id"),
			title: optionalString(body, "title"),
			appName: optionalString(body, "appName"),
			displayIndex: optionalNumber(body, "displayIndex"),
			type: body.type === "screen" || body.type === "window" ? body.type : undefined,
		};
		return Object.values(selector).some((value) => value !== undefined) ? selector : null;
	};

	const editorState = async () => {
		if (!rpc.isReady("editor")) return { open: false };
		return { open: true, ...(await rpc.send<Body>("editor", "editor.state", {}, 5000)) };
	};

	const waitForEditorReady = async (videoPath: string | null, timeoutMs: number) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (rpc.isReady("editor")) {
				try {
					const state = await rpc.send<Body>("editor", "editor.state", {}, 3000);
					const matches =
						!videoPath ||
						(typeof state.videoPath === "string" &&
							path.resolve(state.videoPath) === path.resolve(videoPath));
					if (state.ready && matches) return state;
				} catch {
					// Editor still booting.
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
		return null;
	};

	const placeCaptions = async (journalCaptions: JournalCaption[]) => {
		await controller.mutateJournal((journal) => {
			journal.captions.push(...journalCaptions);
			journal.captions.sort((a, b) => a.startMs - b.startMs);
		});
	};

	const bridgeEndpoints = () => controller.settings;

	/** Audio for a narration/audio request: file, base64, raw body, TTS, or a prepared clip. */
	const resolveNarrationAudio = async (
		ctx: RequestContext,
		body: Body,
		targetDir: string,
		fileStem: string,
	): Promise<{ path: string; durationMs: number; text: string | null } | null> => {
		const preparedId = optionalString(body, "preparedId");
		if (preparedId) {
			const prepared = controller.prepared.get(preparedId);
			if (!prepared) throw notFound(`Prepared narration "${preparedId}" not found.`);
			const targetPath = path.join(targetDir, `${fileStem}${path.extname(prepared.path)}`);
			await fs.mkdir(targetDir, { recursive: true });
			await fs.copyFile(prepared.path, targetPath);
			return { path: targetPath, durationMs: prepared.durationMs, text: prepared.text };
		}
		if (ctx.contentType.startsWith("audio/")) {
			const buffer = await ctx.raw();
			const result = await ingestAudio(
				{ buffer, format: ctx.contentType },
				targetDir,
				fileStem,
				controller.getFfprobePath(),
			);
			return { ...result, text: null };
		}
		const filePath = optionalString(body, "path");
		const base64 = optionalString(body, "base64");
		if (filePath || base64) {
			const result = await ingestAudio(
				{ path: filePath, base64, format: optionalString(body, "format") },
				targetDir,
				fileStem,
				controller.getFfprobePath(),
			);
			return { ...result, text: null };
		}
		const tts = body.tts === true ? {} : asObject(body.tts);
		if (body.tts !== undefined && body.tts !== false) {
			const text = requireString(body, "text");
			const speech = await synthesizeWithBridge(bridgeEndpoints(), {
				text,
				voice: optionalString(tts, "voice") ?? controller.settings.ttsVoice,
				lang: optionalString(tts, "lang") ?? (controller.settings.ttsLanguage || undefined),
				...(optionalString(tts, "engine") ? { engine: optionalString(tts, "engine") } : {}),
			});
			const result = await ingestAudio(
				{ buffer: speech.wav, format: "wav" },
				targetDir,
				fileStem,
				controller.getFfprobePath(),
			);
			return { ...result, text };
		}
		return null;
	};

	/** Word-timed cues by transcribing the narration audio itself through the bridge. */
	const wordTimedCues = async (
		audioPath: string,
		atMs: number,
		idPrefix: string,
		narrationId: string,
		language: string | undefined,
	): Promise<JournalCaption[] | null> => {
		if (path.extname(audioPath).toLowerCase() !== ".wav") return null;
		if (!(await isBridgeReachable(bridgeEndpoints()))) return null;
		try {
			const transcript = await transcribeWithBridge(
				bridgeEndpoints(),
				await fs.readFile(audioPath),
				{
					language,
				},
			);
			const words: TimedWord[] = transcript.segments.flatMap((segment) =>
				(segment.words ?? []).map((word) => ({
					text: word.text,
					startMs: word.start_s * 1000,
					endMs: word.end_s * 1000,
				})),
			);
			return words.length > 0 ? groupWordsIntoCues(words, atMs, idPrefix, narrationId) : null;
		} catch {
			return null;
		}
	};

	// ── System ───────────────────────────────────────────────────────────────

	router.add(
		"GET",
		"/v1/health",
		"Liveness + readiness (?wait=seconds blocks until the recorder is ready).",
		async (ctx) => {
			const wait = Number(ctx.query.get("wait") ?? 0);
			if (wait > 0 && !rpc.isReady("hud")) {
				if (rpc.isReady("editor")) controller.host.ensureHudWindow();
				await rpc.waitForBridge("hud", Math.min(wait, 300) * 1000);
			}
			return {
				ok: true,
				ready: rpc.isReady("hud") || rpc.isReady("editor"),
				hudReady: rpc.isReady("hud"),
				editorOpen: rpc.isReady("editor"),
				serverMode: controller.serverMode,
				apiVersion: AUTOMATION_API_VERSION,
				appVersion: controller.host.appVersion,
			};
		},
	);

	router.add("GET", "/v1/info", "Server, paths and session overview.", async () => ({
		...controller.serverStatus,
		apiVersion: AUTOMATION_API_VERSION,
		appVersion: controller.host.appVersion,
		serverMode: controller.serverMode,
		recordingsDirectory: await getRecordingsDir(),
		sessionId: controller.sessionId,
		lastEventSeq: bus.lastSeq,
	}));

	router.add("GET", "/v1/openapi.json", "Machine-readable list of endpoints.", () => {
		const paths: Record<string, Record<string, unknown>> = {};
		for (const route of router.list()) {
			const openApiPath = route.pattern.replace(/:([A-Za-z]+)/g, "{$1}");
			paths[openApiPath] ??= {};
			paths[openApiPath][route.method.toLowerCase()] = {
				summary: route.summary,
				security: route.pattern === "/v1/health" ? [] : [{ bearer: [] }],
			};
		}
		return {
			openapi: "3.1.0",
			info: { title: "Recordly AI automation API", version: String(AUTOMATION_API_VERSION) },
			servers: [{ url: controller.serverStatus.baseUrl }],
			components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
			paths,
		};
	});

	router.add("GET", "/v1/events", "Server-sent event stream (?types=a,b.*&after=seq).", (ctx) => {
		const types = readTypes(ctx.query);
		const after = Number(
			ctx.query.get("after") ?? ctx.req.headers["last-event-id"] ?? bus.lastSeq,
		);
		ctx.res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-store",
			Connection: "keep-alive",
		});
		ctx.res.write(": recordly-ai events\n\n");
		for (const event of bus.since(Number.isFinite(after) ? after : bus.lastSeq, types)) {
			writeSse(ctx, event);
		}
		const unsubscribe = bus.subscribe((event) => {
			const matches =
				!types ||
				types.some((type) =>
					type.endsWith(".*")
						? event.type.startsWith(type.slice(0, -1))
						: event.type === type,
				);
			if (matches) writeSse(ctx, event);
		});
		const heartbeat = setInterval(() => ctx.res.write(": ping\n\n"), 15_000);
		ctx.req.on("close", () => {
			clearInterval(heartbeat);
			unsubscribe();
		});
		return HANDLED;
	});

	router.add(
		"GET",
		"/v1/events/next",
		"Long-poll the next matching event (?types=&after=&timeout=seconds).",
		async (ctx) => {
			const types = readTypes(ctx.query);
			const afterParam = ctx.query.get("after");
			const after = afterParam === null ? bus.lastSeq : Number(afterParam);
			const timeoutSeconds = Math.min(
				300,
				Math.max(0, Number(ctx.query.get("timeout") ?? 30)),
			);
			const event = await bus.waitNext(
				Number.isFinite(after) ? after : bus.lastSeq,
				types,
				timeoutSeconds * 1000,
			);
			return { event, lastSeq: bus.lastSeq, timedOut: event === null };
		},
	);

	router.add("GET", "/v1/events/history", "Events after ?after=seq (non-blocking).", (ctx) => ({
		events: bus.since(Number(ctx.query.get("after") ?? 0), readTypes(ctx.query)),
		lastSeq: bus.lastSeq,
	}));

	router.add(
		"POST",
		"/v1/app/quit",
		"Quit Recordly AI ({force} skips unsaved-changes checks).",
		async (ctx) => {
			const body = await ctx.json();
			const force = optionalBoolean(body, "force") ?? false;
			if (!force && rpc.isReady("editor")) {
				const state = await rpc
					.send<Body>("editor", "editor.state", {}, 3000)
					.catch(() => null);
				if (state?.hasUnsavedChanges) {
					throw conflict(
						"The project has unsaved changes: POST /v1/project/save first, or pass force.",
					);
				}
			}
			setTimeout(() => controller.host.quit(force), 150);
			return { quitting: true };
		},
	);

	// ── Settings ─────────────────────────────────────────────────────────────

	router.add("GET", "/v1/settings", "Automation + recording settings.", async () => {
		const status = rpc.isReady("hud") ? await hudStatus().catch(() => null) : null;
		return {
			automation: controller.settings,
			recording: status
				? {
						microphone: status.microphoneEnabled,
						systemAudio: status.systemAudioEnabled,
						webcam: status.webcamEnabled,
						countdownSeconds: status.countdownDelay,
					}
				: null,
			recordingsDirectory: await getRecordingsDir(),
		};
	});

	router.add(
		"PATCH",
		"/v1/settings",
		"Update {automation:{...}, recording:{microphone, systemAudio, webcam, microphoneDeviceId, webcamDeviceId, countdownSeconds}}.",
		async (ctx) => {
			const body = await ctx.json();
			const automationPatch = asObject(body.automation);
			const recordingPatch = asObject(body.recording);
			const automation =
				Object.keys(automationPatch).length > 0
					? await controller.updateSettings(
							automationPatch as Partial<AutomationSettings>,
						)
					: controller.settings;
			let recording: unknown = null;
			if (Object.keys(recordingPatch).length > 0) {
				recording = await controller.sendToHud(
					"recording.configure",
					recordingPatch,
					10_000,
				);
			}
			return { automation, recording };
		},
	);

	// ── Sources ──────────────────────────────────────────────────────────────

	router.add(
		"GET",
		"/v1/sources",
		"List capturable screens/windows (?types=screen,window&q=regex).",
		async (ctx) => {
			const sources = await listSources(readTypes(ctx.query));
			const q = ctx.query.get("q");
			const filtered = q ? matchSource(sources, { title: q }).candidates : sources;
			return { sources: filtered, selected: selectedSource };
		},
	);

	router.add("GET", "/v1/sources/selected", "Currently selected source.", () => ({
		selected: selectedSource,
	}));

	router.add(
		"POST",
		"/v1/sources/select",
		"Select by {id | title (regex) | appName | displayIndex, type?, bringToFront?}.",
		async (ctx) => {
			const body = await ctx.json();
			const selector = parseSelector(body);
			if (!selector) throw badRequest("Provide id, title, appName or displayIndex.");
			return {
				selected: await selectSource(
					selector,
					optionalBoolean(body, "bringToFront") ?? true,
				),
			};
		},
	);

	router.add(
		"GET",
		"/v1/screenshot",
		"PNG of the selected source (?maxWidth=1280).",
		async (ctx) => {
			const source = selectedSource;
			if (!source?.id) throw conflict("No source selected.");
			const maxWidth = Math.min(
				3840,
				Math.max(160, Number(ctx.query.get("maxWidth") ?? 1280)),
			);
			const isWindow = source.id.startsWith("window:");
			const sources = await desktopCapturer.getSources({
				types: [isWindow ? "window" : "screen"],
				thumbnailSize: { width: maxWidth, height: Math.round((maxWidth * 9) / 16) * 2 },
				fetchWindowIcons: false,
			});
			const match =
				sources.find((candidate) => candidate.id === source.id) ??
				(isWindow
					? null
					: sources.find(
							(candidate) =>
								String(candidate.display_id) === String(source.display_id),
						));
			if (!match || match.thumbnail.isEmpty()) {
				throw notFound("The selected source is not capturable right now.");
			}
			const png = match.thumbnail.toPNG();
			ctx.res.writeHead(200, {
				"Content-Type": "image/png",
				"Content-Length": png.length,
				"Cache-Control": "no-store",
			});
			ctx.res.end(png);
			return HANDLED;
		},
	);

	router.add(
		"POST",
		"/v1/wait",
		"Wait for the selected source to become {condition:'stable'|'changed', forMs, timeoutMs, ignoreRects, threshold}.",
		async (ctx) => {
			const body = await ctx.json();
			const timeoutMs = Math.min(
				30 * 60_000,
				Math.max(1000, optionalNumber(body, "timeoutMs") ?? 60_000),
			);
			return controller.sendToHud("visual.wait", { ...body, timeoutMs }, timeoutMs + 10_000);
		},
	);

	router.add(
		"POST",
		"/v1/idle/ignore",
		"Mask regions from idle detection {rects:[{x,y,width,height}] normalized}.",
		async (ctx) => {
			const body = await ctx.json();
			const rects = Array.isArray(body.rects) ? body.rects.filter(isNormalizedRect) : [];
			controller.notifyRenderers("idle-ignore-rects", rects);
			return { rects };
		},
	);

	// ── Presets ──────────────────────────────────────────────────────────────

	const readPresets = () => {
		const stored = readAppSetting(EDITOR_PRESETS_KEY);
		return Array.isArray(stored) ? (stored as Array<Body>) : [];
	};
	const writePresets = (presets: Body[]) => {
		writeAppSetting(EDITOR_PRESETS_KEY, presets);
		controller.notifyRenderers("presets-changed", presets);
	};

	router.add("GET", "/v1/presets", "List editor presets (?full=1 includes snapshots).", (ctx) => {
		const full = ctx.query.get("full") === "1";
		return {
			presets: readPresets().map((preset) =>
				full
					? preset
					: {
							id: preset.id,
							name: preset.name,
							createdAt: preset.createdAt,
							updatedAt: preset.updatedAt,
						},
			),
			defaultPresetId: controller.settings.defaultPresetId,
		};
	});

	router.add(
		"GET",
		"/v1/presets/current",
		"Snapshot of the current editor look (editor must be open).",
		() => rpc.send("editor", "presets.current", {}, 5000),
	);

	router.add(
		"POST",
		"/v1/presets",
		"Create/overwrite a preset from the current editor look {name, snapshot?: partial overrides, makeDefault?}.",
		async (ctx) => {
			const body = await ctx.json();
			requireString(body, "name");
			const preset = await rpc.send<Body>("editor", "presets.saveCurrent", body, 10_000);
			if (optionalBoolean(body, "makeDefault")) {
				await controller.updateSettings({ defaultPresetId: String(preset.id) });
			}
			bus.publish("preset.saved", { id: preset.id, name: preset.name });
			return { preset };
		},
	);

	router.add("PATCH", "/v1/presets/:id", "Rename a preset {name}.", async (ctx) => {
		const body = await ctx.json();
		const name = requireString(body, "name").trim();
		const presets = readPresets();
		const preset = presets.find((item) => item.id === ctx.params.id);
		if (!preset) throw notFound(`Preset "${ctx.params.id}" not found.`);
		preset.name = name;
		preset.updatedAt = new Date().toISOString();
		writePresets(presets);
		return { preset };
	});

	router.add("DELETE", "/v1/presets/:id", "Delete a preset.", (ctx) => {
		const presets = readPresets();
		const next = presets.filter((item) => item.id !== ctx.params.id);
		if (next.length === presets.length) throw notFound(`Preset "${ctx.params.id}" not found.`);
		writePresets(next);
		return { deleted: ctx.params.id };
	});

	router.add(
		"POST",
		"/v1/presets/:id/apply",
		"Apply a preset now (editor open) and/or use it for automated edits {default?}.",
		async (ctx) => {
			const body = await ctx.json();
			const exists = readPresets().some((preset) => preset.id === ctx.params.id);
			if (!exists) throw notFound(`Preset "${ctx.params.id}" not found.`);
			const makeDefault = optionalBoolean(body, "default") ?? !rpc.isReady("editor");
			if (makeDefault) await controller.updateSettings({ defaultPresetId: ctx.params.id });
			const applied = rpc.isReady("editor")
				? await rpc.send("editor", "presets.apply", { id: ctx.params.id }, 5000)
				: null;
			return { applied, defaultPresetId: controller.settings.defaultPresetId };
		},
	);

	// ── Recording ────────────────────────────────────────────────────────────

	router.add("GET", "/v1/recording", "Recorder status + session.", async () => ({
		status: await hudStatus(),
		sessionId: controller.sessionId,
		journal: controller.journal.current
			? {
					captions: controller.journal.current.captions.length,
					audio: controller.journal.current.audio.length,
					markers: controller.journal.current.markers.length,
					idle: controller.journal.current.idle.length,
					videoPath: controller.journal.current.videoPath,
				}
			: null,
	}));

	router.add(
		"POST",
		"/v1/recording/start",
		"Start recording {source?, microphone, systemAudio, webcam, countdownSeconds, autoEdit?:{speedUpIdle,targetSeconds,keepMs,maxSpeed,speedBadge}, presetId?}.",
		async (ctx) => {
			const body = await ctx.json();
			const sourceSelector = parseSelector(asObject(body.source));
			if (sourceSelector) await selectSource(sourceSelector, true);
			if (!selectedSource?.id)
				throw conflict("No source selected: POST /v1/sources/select first.");

			const autoEditBody = asObject(body.autoEdit);
			const targetSeconds = optionalNumber(autoEditBody, "targetSeconds");
			const autoEdit: AutoEditOptions = controller.defaultAutoEdit({
				...(optionalBoolean(autoEditBody, "speedUpIdle") !== undefined
					? { speedUpIdle: optionalBoolean(autoEditBody, "speedUpIdle") }
					: {}),
				...(targetSeconds !== undefined ? { targetMs: targetSeconds * 1000 } : {}),
				...(optionalNumber(autoEditBody, "keepMs") !== undefined
					? { keepMs: optionalNumber(autoEditBody, "keepMs") }
					: {}),
				...(optionalNumber(autoEditBody, "maxSpeed") !== undefined
					? {
							maxSpeed: Math.min(
								16,
								Math.max(1, optionalNumber(autoEditBody, "maxSpeed") ?? 16),
							),
						}
					: {}),
				...(optionalBoolean(autoEditBody, "speedBadge") !== undefined
					? { speedBadge: optionalBoolean(autoEditBody, "speedBadge") }
					: {}),
				...(optionalString(body, "presetId")
					? { presetId: optionalString(body, "presetId") }
					: {}),
			} as Partial<AutoEditOptions>);

			const idleSeconds = optionalNumber(asObject(body.idle), "thresholdSeconds");
			if (idleSeconds !== undefined) controller.overrideIdleThresholdForSession(idleSeconds);

			const countdownSeconds =
				optionalNumber(body, "countdownSeconds") ?? (controller.serverMode ? 0 : undefined);
			controller.expectRestStart(autoEdit);
			try {
				const status = await controller.sendToHud<RecordingStatusSnapshot>(
					"recording.start",
					{
						microphone: optionalBoolean(body, "microphone"),
						systemAudio: optionalBoolean(body, "systemAudio"),
						webcam: optionalBoolean(body, "webcam"),
						microphoneDeviceId: optionalString(body, "microphoneDeviceId"),
						webcamDeviceId: optionalString(body, "webcamDeviceId"),
						countdownSeconds,
					},
					90_000 + (countdownSeconds ?? 10) * 1000,
				);
				return { sessionId: controller.sessionId, status, source: selectedSource };
			} catch (error) {
				controller.clearRestStart();
				throw error;
			}
		},
	);

	router.add("POST", "/v1/recording/pause", "Pause recording.", async () => ({
		status: await controller.sendToHud("recording.pause", {}, 15_000),
	}));

	router.add("POST", "/v1/recording/resume", "Resume recording.", async () => ({
		status: await controller.sendToHud("recording.resume", {}, 15_000),
	}));

	router.add(
		"POST",
		"/v1/recording/stop",
		"Stop, save and open the editor {waitForEditor?: true}.",
		async (ctx) => {
			const body = await ctx.json();
			const result = await controller.sendToHud<{
				videoPath: string | null;
				clockMsAtStop: number;
			}>("recording.stop", {}, 11 * 60_000);
			await controller.finalizeSession(result.videoPath, result.clockMsAtStop);
			let editor: unknown = null;
			if ((optionalBoolean(body, "waitForEditor") ?? true) && result.videoPath) {
				editor = await waitForEditorReady(result.videoPath, 90_000);
			}
			return { videoPath: result.videoPath, sessionId: controller.sessionId, editor };
		},
	);

	router.add("POST", "/v1/recording/cancel", "Discard the recording in progress.", async () => {
		controller.discardSession();
		return { status: await controller.sendToHud("recording.cancel", {}, 15_000) };
	});

	// ── Live content (journal) ───────────────────────────────────────────────

	router.add(
		"POST",
		"/v1/captions",
		"Add a subtitle {text, atMs?, offsetMs?, durationMs?, words?} at recording 'now'.",
		async (ctx) => {
			const receivedAt = Date.now();
			const body = await ctx.json();
			const text = requireString(body, "text");
			const atMs = await controller.resolveAtMs(body, receivedAt);
			const durationMs = optionalNumber(body, "durationMs") ?? estimateSpeechDurationMs(text);
			const id = `cap-${randomUUID().slice(0, 8)}`;
			const cues = distributeNarrationCues(text, atMs, durationMs, id);
			await placeCaptions(cues);
			bus.publish("content.caption", { atMs, durationMs, cues: cues.length });
			return { atMs, durationMs, cues };
		},
	);

	router.add(
		"POST",
		"/v1/audio",
		"Insert audio at recording 'now' {path|base64,format | raw audio/* body; atMs?, offsetMs?, volume?, trackIndex?, label?}.",
		async (ctx) => {
			const receivedAt = Date.now();
			const body = ctx.contentType.startsWith("audio/")
				? Object.fromEntries(ctx.query.entries())
				: await ctx.json();
			const numericBody: Body = { ...body };
			for (const key of ["atMs", "offsetMs", "volume", "trackIndex"]) {
				if (typeof numericBody[key] === "string")
					numericBody[key] = Number(numericBody[key]);
			}
			const atMs = await controller.resolveAtMs(numericBody, receivedAt);
			const id = `aud-${randomUUID().slice(0, 8)}`;
			const audio = await resolveNarrationAudio(
				ctx,
				numericBody,
				await controller.sessionMediaDir(),
				id,
			);
			if (!audio) throw badRequest("Provide `path`, `base64` or an audio/* body.");
			approveUserPath(audio.path);
			const entry = {
				id,
				path: audio.path,
				atMs,
				durationMs: audio.durationMs,
				volume: clampVolume(optionalNumber(numericBody, "volume")),
				...(optionalNumber(numericBody, "trackIndex") !== undefined
					? { trackIndex: optionalNumber(numericBody, "trackIndex") }
					: {}),
				...(optionalString(numericBody, "label")
					? { label: optionalString(numericBody, "label") }
					: {}),
			};
			await controller.mutateJournal((journal) => {
				journal.audio.push(entry);
			});
			bus.publish("content.audio", { id, atMs, durationMs: audio.durationMs });
			return entry;
		},
	);

	router.add(
		"POST",
		"/v1/narration",
		"Subtitle + voice in one call {text, path|base64|tts|preparedId, atMs?, offsetMs?, volume?, captions?:true, wordTiming?}.",
		async (ctx) => {
			const receivedAt = Date.now();
			const body = await ctx.json();
			const atMs = await controller.resolveAtMs(body, receivedAt);
			const narrationId = `narr-${randomUUID().slice(0, 8)}`;
			const audio = await resolveNarrationAudio(
				ctx,
				body,
				await controller.sessionMediaDir(),
				narrationId,
			);
			const text = optionalString(body, "text") ?? audio?.text ?? null;
			if (!audio && !text) throw badRequest("Provide `text` and/or audio.");
			const durationMs = audio?.durationMs ?? estimateSpeechDurationMs(text ?? "");

			let cues: JournalCaption[] = [];
			if (text && (optionalBoolean(body, "captions") ?? true)) {
				const timed =
					audio && optionalBoolean(body, "wordTiming")
						? await wordTimedCues(
								audio.path,
								atMs,
								narrationId,
								narrationId,
								optionalString(body, "language"),
							)
						: null;
				cues =
					timed ??
					distributeNarrationCues(text, atMs, durationMs, narrationId, narrationId);
			}
			if (audio) approveUserPath(audio.path);
			await controller.mutateJournal((journal) => {
				if (audio) {
					journal.audio.push({
						id: narrationId,
						path: audio.path,
						atMs,
						durationMs: audio.durationMs,
						volume: clampVolume(optionalNumber(body, "volume")),
						narrationId,
						label: text?.slice(0, 60),
					});
				}
				journal.captions.push(...cues);
				journal.captions.sort((a, b) => a.startMs - b.startMs);
			});
			bus.publish("content.narration", {
				narrationId,
				atMs,
				durationMs,
				endsAtMs: atMs + durationMs,
			});
			return {
				narrationId,
				atMs,
				durationMs,
				endsAtMs: atMs + durationMs,
				captions: cues.length,
				audioPath: audio?.path ?? null,
			};
		},
	);

	router.add(
		"POST",
		"/v1/narration/prepare",
		"Pre-render narration before it is needed {id?, text, tts? | path | base64}.",
		async (ctx) => {
			const body = ctx.contentType.startsWith("audio/")
				? Object.fromEntries(ctx.query.entries())
				: await ctx.json();
			const id =
				optionalString(body, "id")?.replace(/[^\w.-]/g, "_") ||
				`prep-${randomUUID().slice(0, 8)}`;
			const withTts =
				body.path || body.base64 || ctx.contentType.startsWith("audio/")
					? body
					: { ...body, tts: body.tts ?? true };
			const audio = await resolveNarrationAudio(ctx, withTts, controller.preparedDir, id);
			if (!audio) throw badRequest("Nothing to prepare.");
			const prepared = {
				id,
				text: optionalString(body, "text") ?? audio.text ?? "",
				path: audio.path,
				durationMs: audio.durationMs,
				createdAt: new Date().toISOString(),
			};
			controller.prepared.set(id, prepared);
			return prepared;
		},
	);

	router.add("GET", "/v1/narration/prepared", "List prepared narrations.", () => ({
		prepared: [...controller.prepared.values()],
	}));

	router.add(
		"POST",
		"/v1/narration/:id/play",
		"Insert a prepared narration at recording 'now' {atMs?, offsetMs?, captions?, volume?, wordTiming?}.",
		async (ctx) => {
			const receivedAt = Date.now();
			const body = await ctx.json();
			const prepared = controller.prepared.get(ctx.params.id);
			if (!prepared) throw notFound(`Prepared narration "${ctx.params.id}" not found.`);
			const atMs = await controller.resolveAtMs(body, receivedAt);
			const narrationId = `narr-${randomUUID().slice(0, 8)}`;
			const audio = await resolveNarrationAudio(
				ctx,
				{ preparedId: prepared.id },
				await controller.sessionMediaDir(),
				narrationId,
			);
			if (!audio) throw notFound("Prepared audio is missing.");
			approveUserPath(audio.path);
			let cues: JournalCaption[] = [];
			if (prepared.text && (optionalBoolean(body, "captions") ?? true)) {
				const timed = optionalBoolean(body, "wordTiming")
					? await wordTimedCues(
							audio.path,
							atMs,
							narrationId,
							narrationId,
							optionalString(body, "language"),
						)
					: null;
				cues =
					timed ??
					distributeNarrationCues(
						prepared.text,
						atMs,
						audio.durationMs,
						narrationId,
						narrationId,
					);
			}
			await controller.mutateJournal((journal) => {
				journal.audio.push({
					id: narrationId,
					path: audio.path,
					atMs,
					durationMs: audio.durationMs,
					volume: clampVolume(optionalNumber(body, "volume")),
					narrationId,
					label: prepared.text.slice(0, 60),
				});
				journal.captions.push(...cues);
				journal.captions.sort((a, b) => a.startMs - b.startMs);
			});
			bus.publish("content.narration", {
				narrationId,
				preparedId: prepared.id,
				atMs,
				durationMs: audio.durationMs,
				endsAtMs: atMs + audio.durationMs,
			});
			return {
				narrationId,
				atMs,
				durationMs: audio.durationMs,
				endsAtMs: atMs + audio.durationMs,
				captions: cues.length,
			};
		},
	);

	router.add(
		"POST",
		"/v1/markers",
		"Mark a step/chapter/note or a discard-start/discard-end retake {label, kind, atMs?}.",
		async (ctx) => {
			const receivedAt = Date.now();
			const body = await ctx.json();
			const kind = (optionalString(body, "kind") ?? "step") as JournalMarkerKind;
			if (!MARKER_KINDS.has(kind))
				throw badRequest(`kind must be one of ${[...MARKER_KINDS].join(", ")}.`);
			const atMs = await controller.resolveAtMs(body, receivedAt);
			const marker = {
				id: `mk-${randomUUID().slice(0, 8)}`,
				atMs,
				label: optionalString(body, "label") ?? "",
				kind,
			};
			await controller.mutateJournal((journal) => {
				journal.markers.push(marker);
			});
			bus.publish("content.marker", marker);
			return marker;
		},
	);

	router.add(
		"POST",
		"/v1/zoom",
		"Zoom onto {rect | screenRect, coordinateSpace?, padding?} for {durationMs} from 'now' (or startMs/endMs).",
		async (ctx) => {
			const receivedAt = Date.now();
			const body = await ctx.json();
			const rect = await resolveTargetRect(body);
			const startMs =
				optionalNumber(body, "startMs") ?? (await controller.resolveAtMs(body, receivedAt));
			const endMs =
				optionalNumber(body, "endMs") ??
				startMs + (optionalNumber(body, "durationMs") ?? 3000);
			if (endMs <= startMs) throw badRequest("endMs must be after startMs.");
			const zoom = { id: `zm-${randomUUID().slice(0, 8)}`, startMs, endMs, rect };
			await controller.mutateJournal((journal) => {
				journal.zooms.push(zoom);
			});
			bus.publish("content.zoom", zoom);
			return zoom;
		},
	);

	router.add(
		"POST",
		"/v1/annotations",
		"Add a text callout or a privacy blur {type:'text'|'blur', text?, rect|screenRect, durationMs, atMs?}.",
		async (ctx) => {
			const receivedAt = Date.now();
			const body = await ctx.json();
			const type = body.type === "blur" ? "blur" : "text";
			const hasRect = isNormalizedRect(body.rect) || isNormalizedRect(body.screenRect);
			const rect = hasRect
				? await resolveTargetRect({
						...body,
						padding: optionalNumber(body, "padding") ?? 0,
					})
				: undefined;
			if (type === "blur" && !rect) throw badRequest("A blur needs `rect` or `screenRect`.");
			const startMs =
				optionalNumber(body, "startMs") ?? (await controller.resolveAtMs(body, receivedAt));
			const endMs =
				optionalNumber(body, "endMs") ??
				startMs + (optionalNumber(body, "durationMs") ?? 4000);
			const annotation = {
				id: `an-${randomUUID().slice(0, 8)}`,
				startMs,
				endMs,
				type,
				...(type === "text" ? { text: requireString(body, "text") } : {}),
				...(rect ? { rect } : {}),
			} as const;
			await controller.mutateJournal((journal) => {
				journal.annotations.push({ ...annotation });
			});
			bus.publish("content.annotation", annotation);
			return annotation;
		},
	);

	// ── Editor, project, export ──────────────────────────────────────────────

	router.add("GET", "/v1/editor", "Editor state (open, ready, counts, unsaved changes).", () =>
		editorState(),
	);

	router.add(
		"POST",
		"/v1/editor/open",
		"Open {videoPath | projectPath} in the editor {waitReady?: true}.",
		async (ctx) => {
			const body = await ctx.json();
			const projectPath = optionalString(body, "projectPath");
			const videoPath = optionalString(body, "videoPath");
			if (!projectPath && !videoPath) throw badRequest("Provide videoPath or projectPath.");
			let expectedVideo: string | null = null;
			if (projectPath) {
				const loaded = (await loadProjectFromPath(path.resolve(projectPath))) as Body;
				if (!loaded.success)
					throw badRequest(String(loaded.message ?? "Could not load the project."));
				const project = asObject(loaded.project);
				expectedVideo = typeof project.videoPath === "string" ? project.videoPath : null;
				if (rpc.isReady("editor")) {
					await rpc.send(
						"editor",
						"project.load",
						{ project: loaded.project, path: loaded.path },
						30_000,
					);
				} else {
					controller.host.openEditorWindow();
				}
			} else if (videoPath) {
				const resolved = path.resolve(videoPath);
				await fs.access(resolved).catch(() => {
					throw badRequest(`Video not found: ${resolved}`);
				});
				approveUserPath(resolved);
				setCurrentVideoPath(resolved);
				setCurrentProjectPath(null);
				const session = { videoPath: resolved, webcamPath: null, timeOffsetMs: 0 };
				setCurrentRecordingSession(session);
				controller.notifyRenderersRaw("recording-session-changed", session);
				expectedVideo = resolved;
				controller.host.openEditorWindow();
			}
			if (optionalBoolean(body, "waitReady") === false) return { opening: true };
			const state = await waitForEditorReady(
				expectedVideo && !expectedVideo.startsWith("file:") ? expectedVideo : null,
				90_000,
			);
			if (!state)
				throw new HttpError(
					504,
					"editor_timeout",
					"The editor did not become ready in time.",
				);
			return { editor: state };
		},
	);

	router.add(
		"POST",
		"/v1/editor/apply-journal",
		"Merge late journal content (captions/audio sent after stop) {autoEdit?, force?}.",
		async (ctx) => {
			const body = await ctx.json();
			return rpc.send("editor", "editor.applyJournal", body, 60_000);
		},
	);

	router.add(
		"POST",
		"/v1/editor/auto-edit",
		"Speed up idle periods now {targetMs?, keepMs?, maxSpeed?, speedBadge?, force?}.",
		async (ctx) => {
			const body = await ctx.json();
			return rpc.send("editor", "editor.autoEdit", body, 60_000);
		},
	);

	router.add("GET", "/v1/project", "Full project JSON of the open editor.", () =>
		rpc.send("editor", "project.get", {}, 10_000),
	);

	router.add(
		"PUT",
		"/v1/project",
		"Replace the open project {project} (validated by the editor).",
		async (ctx) => {
			const body = await ctx.json();
			if (!body.project || typeof body.project !== "object")
				throw badRequest('"project" is required.');
			return rpc.send(
				"editor",
				"project.load",
				{ project: body.project, path: currentProjectPath },
				30_000,
			);
		},
	);

	router.add(
		"POST",
		"/v1/project/save",
		"Save the project without dialogs {name?, copyTo?}.",
		async (ctx) => {
			const body = await ctx.json();
			const result = await rpc.send<{ path: string | null }>(
				"editor",
				"project.save",
				body,
				60_000,
			);
			const copyTo = optionalString(body, "copyTo");
			if (copyTo && result.path) {
				const target = path.resolve(copyTo);
				await fs.mkdir(path.dirname(target), { recursive: true });
				await fs.copyFile(result.path, target);
				return { path: result.path, copiedTo: target };
			}
			return result;
		},
	);

	router.add(
		"GET",
		"/v1/project/chapters",
		"Chapters from step/chapter markers on the edited timeline (?format=youtube).",
		async (ctx) => {
			const chapters = await rpc.send<Array<{ label: string; timelineMs: number }>>(
				"editor",
				"chapters.get",
				{},
				10_000,
			);
			if (ctx.query.get("format") !== "youtube") return { chapters };
			const stamp = (ms: number) => {
				const total = Math.max(0, Math.floor(ms / 1000));
				const hours = Math.floor(total / 3600);
				const minutes = Math.floor((total % 3600) / 60);
				const seconds = String(total % 60).padStart(2, "0");
				return hours > 0
					? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
					: `${minutes}:${seconds}`;
			};
			// YouTube needs the first chapter at 0:00: snap a chapter that starts within the
			// first second, otherwise add an "Intro" chapter.
			const lines = chapters.map(
				(chapter, index) =>
					`${stamp(index === 0 && chapter.timelineMs < 1000 ? 0 : chapter.timelineMs)} ${chapter.label}`,
			);
			if (chapters.length > 0 && chapters[0].timelineMs >= 1000) lines.unshift("0:00 Intro");
			return { chapters, text: lines.join("\n") };
		},
	);

	router.add(
		"POST",
		"/v1/captions/generate",
		"Transcribe the recording into captions {language?} (bridge or local Whisper).",
		async (ctx) => {
			const body = await ctx.json();
			return rpc.send("editor", "captions.generate", body, 60 * 60_000);
		},
	);

	router.add(
		"POST",
		"/v1/export",
		"Export {format:'mp4'|'gif', quality, encodingMode, fps, includeCaptionSidecar, outputPath?, wait?, timeoutSeconds?}.",
		async (ctx) => {
			const body = await ctx.json();
			const editor = rpc.getContents("editor");
			if (!editor) throw new HttpError(503, "editor_unavailable", "Open the editor first.");
			if (controller.activeJob()) throw conflict("An export is already running.");
			const format = optionalString(body, "format") === "gif" ? "gif" : "mp4";
			const requested = optionalString(body, "outputPath");
			const outputPath = requested
				? path.resolve(requested)
				: path.join(
						await getRecordingsDir(),
						"exports",
						`recordly-ai-${Date.now()}.${format}`,
					);
			const job = controller.createExportJob(outputPath, format, editor);
			const startSeq = bus.lastSeq;
			try {
				await rpc.send("editor", "export.start", { ...body, format }, 90_000);
			} catch (error) {
				controller.failActiveJob(error instanceof Error ? error.message : String(error));
				throw error;
			}
			bus.publish("export.started", { jobId: job.id, outputPath, format });
			if (optionalBoolean(body, "wait")) {
				const timeoutMs =
					Math.min(6 * 3600, optionalNumber(body, "timeoutSeconds") ?? 3600) * 1000;
				const deadline = Date.now() + timeoutMs;
				let after = startSeq;
				while (job.status === "running" && Date.now() < deadline) {
					const event = await bus.waitNext(
						after,
						["export.done", "export.failed"],
						Math.min(30_000, deadline - Date.now()),
					);
					if (event) after = event.seq;
				}
			}
			return { job };
		},
	);

	router.add("POST", "/v1/export/cancel", "Cancel the running export.", async () => {
		await rpc.send("editor", "export.cancel", {}, 10_000);
		controller.failActiveJob("Export cancelled.");
		return { cancelled: true };
	});

	router.add("GET", "/v1/jobs/:id", "Export job status.", (ctx) => {
		const job = controller.jobs.get(ctx.params.id);
		if (!job) throw notFound(`Job "${ctx.params.id}" not found.`);
		return { job };
	});

	return router;
}
