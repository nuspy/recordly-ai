import { type MutableRefObject, useEffect, useRef } from "react";
import type { EditorPreset } from "@/components/video-editor/editorPreferences";
import { saveEditorPresets } from "@/components/video-editor/editorPreferences";
import type { useEditorExportController } from "@/components/video-editor/export/useEditorExportController";
import type { useExportSession } from "@/components/video-editor/export/useExportSession";
import type { useExportSettings } from "@/components/video-editor/export/useExportSettings";
import type { useVideoEditorPresets } from "@/components/video-editor/presets/useVideoEditorPresets";
import type { useEditorProjectController } from "@/components/video-editor/project/useEditorProjectController";
import { createProjectData } from "@/components/video-editor/projectPersistence";
import type { useProjectState } from "@/components/video-editor/state/useProjectState";
import type { useTimelineState } from "@/components/video-editor/state/useTimelineState";
import { mapSourceTimeToTimelineTime } from "@/components/video-editor/types";
import type {
	AutoEditOptions,
	AutomationSettings,
	SessionJournal,
} from "../../../electron/automation/contract";
import {
	AutomationCommandError,
	type AutomationCommandHandlers,
	delay,
	emitAutomationEvent,
	getAutomationApi,
	readBoolean,
	readNumber,
	readString,
	useAutomationBridge,
	waitForValue,
} from "../bridge";
import {
	createSpeedBadgeAnnotations,
	getJournalCalibrationShiftMs,
	mergeJournalIntoTimeline,
} from "./mergeJournal";

interface EditorAutomationInput {
	project: ReturnType<typeof useProjectState>;
	timeline: ReturnType<typeof useTimelineState>;
	presets: ReturnType<typeof useVideoEditorPresets>;
	projectController: ReturnType<typeof useEditorProjectController>;
	exportController: ReturnType<typeof useEditorExportController>;
	exportSettings: ReturnType<typeof useExportSettings>;
	exportSession: ReturnType<typeof useExportSession>;
	durationSeconds: number;
	isPreviewReady: boolean;
	isGeneratingCaptions: boolean;
	nextAnnotationZIndexRef: MutableRefObject<number>;
}

const FORMATS = new Set(["mp4", "gif"]);
const QUALITIES = new Set(["medium", "good", "high", "source"]);
const ENCODING_MODES = new Set(["fast", "balanced", "quality"]);
const FPS = new Set([24, 30, 60]);

function defaultAutoEdit(settings: AutomationSettings | null): AutoEditOptions {
	return {
		speedUpIdle: settings?.autoEditOnStop ?? true,
		targetMs: (settings?.idleTargetSeconds ?? 10) * 1000,
		keepMs: settings?.idleKeepMs ?? 1000,
		maxSpeed: settings?.idleMaxSpeed ?? 16,
		speedBadge: settings?.idleSpeedBadge ?? true,
		presetId: settings?.defaultPresetId ?? null,
	};
}

/**
 * Editor side of the automation bridge: merges the agent's journal (narration, captions,
 * idle speed-ups) into the timeline and exposes project/save/export/caption commands.
 * Everything goes through the editor's own state setters and actions, so the result is
 * exactly what a user would get by doing the same edits by hand (undo included).
 */
export function useEditorAutomation(input: EditorAutomationInput) {
	const latest = useRef(input);
	latest.current = input;
	const settingsRef = useRef<AutomationSettings | null>(null);
	const appliedForSource = useRef<string | null>(null);
	const exportWatch = useRef<number | null>(null);

	useEffect(() => {
		const api = getAutomationApi();
		if (!api) return;
		void api
			.getSettings()
			.then((settings) => {
				settingsRef.current = settings;
			})
			.catch(() => undefined);
		return api.onNotification((type, data) => {
			if (type === "settings-changed" && data && typeof data === "object") {
				settingsRef.current = data as AutomationSettings;
			} else if (type === "presets-changed" && Array.isArray(data)) {
				latest.current.presets.setEditorPresets(data as EditorPreset[]);
			}
		});
	}, []);

	const sourcePath = input.projectController.snapshot.currentSourcePath;
	const ready =
		Boolean(sourcePath) &&
		input.durationSeconds > 0 &&
		input.timeline.clipRegions.length > 0 &&
		!input.project.loading;

	const getState = () => {
		const { project, timeline, exportSession, projectController } = latest.current;
		return {
			videoPath: projectController.snapshot.currentSourcePath ?? null,
			projectPath: project.currentProjectPath ?? null,
			durationMs: Math.round(latest.current.durationSeconds * 1000),
			ready:
				Boolean(projectController.snapshot.currentSourcePath) &&
				latest.current.durationSeconds > 0 &&
				timeline.clipRegions.length > 0,
			previewReady: latest.current.isPreviewReady,
			hasUnsavedChanges: projectController.hasUnsavedChanges,
			isExporting: exportSession.isExporting,
			isGeneratingCaptions: latest.current.isGeneratingCaptions,
			counts: {
				clips: timeline.clipRegions.length,
				captions: timeline.autoCaptions.length,
				audio: timeline.audioRegions.length,
				zooms: timeline.zoomRegions.length,
				annotations: timeline.annotationRegions.length,
			},
		};
	};

	const applyPreset = (presetId: string) => {
		const { presets } = latest.current;
		const preset = presets.editorPresets.find((item) => item.id === presetId);
		if (!preset)
			throw new AutomationCommandError("not_found", `Preset "${presetId}" not found.`);
		presets.applySnapshot(preset.snapshot);
		return preset;
	};

	const applyJournal = async (options: {
		allowAutoEdit: boolean;
		force?: boolean;
		overrides?: Partial<AutoEditOptions>;
	}) => {
		const api = getAutomationApi();
		const current = latest.current;
		const videoPath = current.projectController.snapshot.currentSourcePath;
		if (!api || !videoPath) {
			throw new AutomationCommandError("editor_not_ready", "No recording is loaded.");
		}
		const journal: SessionJournal | null = await api.readJournal(videoPath);
		if (!journal) return { applied: false, reason: "no-journal" };

		// Only recordings an agent started carry auto-edit options; manual recordings are left
		// alone unless a caller explicitly asks (POST /v1/editor/auto-edit).
		const autoEdit: AutoEditOptions | null = options.overrides
			? {
					...(journal.autoEdit ?? defaultAutoEdit(settingsRef.current)),
					...options.overrides,
				}
			: journal.autoEdit;
		// Structural edits (discarded retakes, idle speed-ups when enabled) run once.
		const runAutoEdit = Boolean(
			options.allowAutoEdit && autoEdit && (options.force || !journal.autoEditAppliedAt),
		);
		if (runAutoEdit && autoEdit?.presetId) {
			try {
				applyPreset(autoEdit.presetId);
			} catch (error) {
				console.warn("[automation] journal preset not applied:", error);
			}
		}

		const { timeline } = current;
		const result = mergeJournalIntoTimeline({
			journal,
			timeline: {
				clipRegions: timeline.clipRegions,
				zoomRegions: timeline.zoomRegions,
				annotationRegions: timeline.annotationRegions,
				audioRegions: timeline.audioRegions,
				autoCaptions: timeline.autoCaptions,
			},
			videoDurationMs: Math.round(current.durationSeconds * 1000),
			applyAutoEdit: runAutoEdit,
			autoEditOptions: autoEdit,
			alreadyApplied: new Set(journal.appliedIds ?? []),
		});

		let annotations = result.annotationRegions;
		if (runAutoEdit && autoEdit?.speedBadge && result.accelerated.length > 0) {
			const badges = createSpeedBadgeAnnotations(
				result.accelerated,
				result.clipRegions,
				current.nextAnnotationZIndexRef.current,
			);
			current.nextAnnotationZIndexRef.current += badges.length;
			const existing = new Set(annotations.map((annotation) => annotation.id));
			annotations = [...annotations, ...badges.filter((badge) => !existing.has(badge.id))];
		}

		timeline.setClipRegions(result.clipRegions);
		timeline.setZoomRegions(result.zoomRegions);
		timeline.setAnnotationRegions(annotations);
		timeline.setAudioRegions(result.audioRegions);
		if (result.added.captions > 0) {
			timeline.setAutoCaptions(result.autoCaptions);
			timeline.setAutoCaptionSettings((settings) => ({ ...settings, enabled: true }));
		}

		await api.markJournalApplied(videoPath, "content", result.appliedIds);
		if (runAutoEdit) await api.markJournalApplied(videoPath, "autoEdit");

		const summary = {
			applied: true,
			videoPath,
			added: result.added,
			accelerated: result.accelerated,
			discardedMs: result.discardedMs,
			autoEditApplied: runAutoEdit,
		};
		emitAutomationEvent("editor.journal-applied", summary);
		return summary;
	};

	// Merge the journal once per loaded recording, as soon as the timeline exists.
	// biome-ignore lint/correctness/useExhaustiveDependencies: applyJournal reads the latest ref.
	useEffect(() => {
		if (!ready || !sourcePath || appliedForSource.current === sourcePath) return;
		appliedForSource.current = sourcePath;
		void applyJournal({ allowAutoEdit: true }).catch((error) =>
			emitAutomationEvent("editor.journal-failed", {
				videoPath: sourcePath,
				message: error instanceof Error ? error.message : String(error),
			}),
		);
	}, [ready, sourcePath]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: getState reads the latest ref.
	useEffect(() => {
		if (ready) emitAutomationEvent("editor.ready", getState());
	}, [ready, sourcePath]);

	useEffect(
		() => () => {
			if (exportWatch.current !== null) window.clearInterval(exportWatch.current);
		},
		[],
	);

	const watchExport = () => {
		if (exportWatch.current !== null) window.clearInterval(exportWatch.current);
		let sawExporting = false;
		let lastProgressAt = 0;
		const startedAt = Date.now();
		exportWatch.current = window.setInterval(() => {
			const session = latest.current.exportSession;
			if (session.isExporting) {
				sawExporting = true;
				if (Date.now() - lastProgressAt >= 250 && session.exportProgress) {
					lastProgressAt = Date.now();
					emitAutomationEvent("export.progress", {
						percent: Math.round(session.exportProgress.percentage * 10) / 10,
						phase: session.exportProgress.phase ?? "rendering",
						etaSeconds: session.exportProgress.estimatedTimeRemaining,
					});
				}
				return;
			}
			if (!sawExporting && Date.now() - startedAt < 10_000) return;
			if (exportWatch.current !== null) window.clearInterval(exportWatch.current);
			exportWatch.current = null;
			if (session.exportedFilePath) {
				emitAutomationEvent("export.done", { path: session.exportedFilePath });
			} else {
				emitAutomationEvent("export.failed", {
					message:
						session.exportError ??
						(sawExporting ? "Export ended without a file." : "Export did not start."),
				});
			}
		}, 100);
	};

	const handlers = useRef<AutomationCommandHandlers>({});
	handlers.current = {
		"editor.state": () => getState(),

		"editor.applyJournal": async (args) =>
			applyJournal({
				allowAutoEdit: readBoolean(args, "autoEdit") ?? false,
				force: readBoolean(args, "force") ?? false,
			}),

		"editor.autoEdit": async (args) => {
			const overrides: Partial<AutoEditOptions> = { speedUpIdle: true };
			const targetMs = readNumber(args, "targetMs");
			const keepMs = readNumber(args, "keepMs");
			const maxSpeed = readNumber(args, "maxSpeed");
			const speedBadge = readBoolean(args, "speedBadge");
			if (targetMs !== undefined) overrides.targetMs = targetMs;
			if (keepMs !== undefined) overrides.keepMs = keepMs;
			if (maxSpeed !== undefined) overrides.maxSpeed = Math.min(16, Math.max(1, maxSpeed));
			if (speedBadge !== undefined) overrides.speedBadge = speedBadge;
			return applyJournal({
				allowAutoEdit: true,
				force: readBoolean(args, "force") ?? false,
				overrides,
			});
		},

		"chapters.get": async () => {
			const api = getAutomationApi();
			const videoPath = latest.current.projectController.snapshot.currentSourcePath;
			if (!api || !videoPath) {
				throw new AutomationCommandError("editor_not_ready", "No recording is loaded.");
			}
			const journal = await api.readJournal(videoPath);
			const clips = latest.current.timeline.clipRegions;
			const shift = journal
				? getJournalCalibrationShiftMs(
						journal,
						Math.round(latest.current.durationSeconds * 1000),
					)
				: 0;
			return (journal?.markers ?? [])
				.filter((marker) => marker.kind === "chapter" || marker.kind === "step")
				.map((marker) => ({
					label: marker.label,
					kind: marker.kind,
					timelineMs: mapSourceTimeToTimelineTime(marker.atMs + shift, clips),
				}))
				.sort((a, b) => a.timelineMs - b.timelineMs);
		},

		"project.get": () => {
			const { projectController, project } = latest.current;
			const videoPath = projectController.snapshot.currentSourcePath;
			if (!videoPath)
				throw new AutomationCommandError("editor_not_ready", "No recording is loaded.");
			return {
				path: project.currentProjectPath ?? null,
				project: createProjectData(
					videoPath,
					projectController.snapshot.currentPersistedEditorState,
					project.lastSavedSnapshot?.projectId ?? null,
				),
			};
		},

		"project.load": async (args) => {
			const loaded = await latest.current.projectController.lifecycle.applyLoadedProject(
				args.project,
				readString(args, "path") ?? null,
			);
			if (!loaded) throw new AutomationCommandError("bad_request", "Invalid project data.");
			return { loaded: true };
		},

		"project.save": async (args) => {
			const { projectController } = latest.current;
			const name = readString(args, "name")?.trim();
			const previousPath = latest.current.project.currentProjectPath;
			const ok = name
				? await projectController.saveActions.saveProjectWithName(name, "rename")
				: await projectController.saveActions.saveProject(false, { silent: true });
			if (!ok)
				throw new AutomationCommandError("save_failed", "The project could not be saved.");
			const path = await waitForValue(() => latest.current.project.currentProjectPath, 5000);
			return { path: path ?? previousPath ?? null };
		},

		"export.start": async (args) => {
			const { exportSettings, exportSession } = latest.current;
			if (exportSession.isExporting) {
				throw new AutomationCommandError("conflict", "An export is already running.");
			}
			const format = readString(args, "format") ?? "mp4";
			if (!FORMATS.has(format))
				throw new AutomationCommandError("bad_request", "format must be mp4 or gif.");
			const quality = readString(args, "quality");
			const encodingMode = readString(args, "encodingMode");
			const fps = readNumber(args, "fps");
			const includeCaptionSidecar = readBoolean(args, "includeCaptionSidecar");
			exportSettings.setExportFormat(format as "mp4" | "gif");
			if (quality && QUALITIES.has(quality)) {
				exportSettings.setExportQuality(
					quality as Parameters<typeof exportSettings.setExportQuality>[0],
				);
			}
			if (encodingMode && ENCODING_MODES.has(encodingMode)) {
				exportSettings.setExportEncodingMode(
					encodingMode as Parameters<typeof exportSettings.setExportEncodingMode>[0],
				);
			}
			if (fps !== undefined && FPS.has(fps)) {
				exportSettings.setMp4FrameRate(
					fps as Parameters<typeof exportSettings.setMp4FrameRate>[0],
				);
			}
			if (includeCaptionSidecar !== undefined) {
				exportSettings.setIncludeCaptionSidecar(includeCaptionSidecar);
			}
			await waitForValue(
				() =>
					latest.current.exportSettings.exportFormat === format &&
					(includeCaptionSidecar === undefined ||
						latest.current.exportSettings.includeCaptionSidecar ===
							includeCaptionSidecar),
				2000,
			);
			const previewReady = await waitForValue(
				() => latest.current.isPreviewReady,
				60_000,
				200,
			);
			if (!previewReady) {
				throw new AutomationCommandError(
					"editor_not_ready",
					"The preview did not become ready.",
				);
			}
			await delay(50);
			// The dialog action closes over the export settings of its render: use the
			// latest one so the format/quality/sidecar chosen above are honored.
			latest.current.exportController.dialogActions.handleStartExportFromDropdown();
			watchExport();
			return { started: true, format };
		},

		"export.cancel": () => {
			latest.current.exportController.dialogActions.handleCancelExport();
			return { cancelled: true };
		},

		"captions.generate": async (args) => {
			const { timeline, projectController } = latest.current;
			const language = readString(args, "language");
			if (language) {
				timeline.setAutoCaptionSettings((settings) => ({ ...settings, language }));
				await delay(50);
			}
			const before = timeline.autoCaptions;
			await projectController.autoCaption.handleGenerateAutoCaptions();
			await waitForValue(() => !latest.current.isGeneratingCaptions, 60 * 60_000, 250);
			const after = latest.current.timeline.autoCaptions;
			return { generated: after !== before, count: after.length };
		},

		"presets.apply": (args) => {
			const id = readString(args, "id");
			if (!id) throw new AutomationCommandError("bad_request", '"id" is required.');
			const preset = applyPreset(id);
			return { applied: true, id: preset.id, name: preset.name };
		},

		"presets.saveCurrent": (args) => {
			const { presets } = latest.current;
			const name = readString(args, "name")?.trim().replace(/\s+/g, " ");
			if (!name) throw new AutomationCommandError("bad_request", '"name" is required.');
			const patch = args.snapshot && typeof args.snapshot === "object" ? args.snapshot : {};
			const existing = presets.editorPresets.find(
				(preset) => preset.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
			);
			const timestamp = new Date().toISOString();
			const preset: EditorPreset = {
				id: existing?.id ?? crypto.randomUUID(),
				name,
				createdAt: existing?.createdAt ?? timestamp,
				updatedAt: timestamp,
				snapshot: { ...presets.currentSnapshot, ...(patch as object) },
			};
			const next = [preset, ...presets.editorPresets.filter((item) => item.id !== preset.id)];
			if (!saveEditorPresets(next)) {
				throw new AutomationCommandError("save_failed", "Could not store the preset.");
			}
			presets.setEditorPresets(next);
			return preset;
		},

		"presets.current": () => latest.current.presets.currentSnapshot,
	};

	useAutomationBridge("editor", handlers);
}
