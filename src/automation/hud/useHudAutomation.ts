import { useEffect, useRef, useState } from "react";
import type { useScreenRecorder } from "@/hooks/useScreenRecorder";
import {
	type AutomationSettings,
	getRecordingTimeMs,
	type RecordingStatusSnapshot,
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
import type { NormalizedRect } from "../idle/frameDiff";
import { IdleDetector } from "../idle/idleDetector";
import { openSourceSampler, type SourceSampler } from "../idle/sourceSampler";

type Recorder = ReturnType<typeof useScreenRecorder>;

const SAMPLE_INTERVAL_MS = 500;

function snapshotOf(recorder: Recorder): RecordingStatusSnapshot {
	const clock = recorder.recording ? recorder.getRecordingClockSnapshot() : null;
	return {
		recording: recorder.recording,
		paused: recorder.paused,
		starting: recorder.starting,
		finalizing: recorder.finalizing,
		countdownActive: recorder.countdownActive,
		clock,
		microphoneEnabled: recorder.microphoneEnabled,
		systemAudioEnabled: recorder.systemAudioEnabled,
		webcamEnabled: recorder.webcamEnabled,
		countdownDelay: recorder.countdownDelay,
	};
}

function readRects(value: unknown): NormalizedRect[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(rect): rect is NormalizedRect =>
			rect &&
			typeof rect === "object" &&
			["x", "y", "width", "height"].every((key) => typeof rect[key] === "number"),
	);
}

async function getSelectedSourceId(): Promise<string> {
	const source = await window.electronAPI.getSelectedSource();
	if (!source?.id) {
		throw new AutomationCommandError("no_source", "No recording source is selected.");
	}
	return source.id;
}

/**
 * Lets the main process drive the HUD recorder (REST server, agents). Recording itself stays
 * in `useScreenRecorder`; this hook only presses its buttons and reports state changes.
 */
export function useHudAutomation(recorder: Recorder) {
	const latest = useRef(recorder);
	latest.current = recorder;
	const capturedAlerts = useRef<string[] | null>(null);
	const idleSettings = useRef<Pick<
		AutomationSettings,
		"idleThresholdSeconds" | "idleChangeThreshold"
	> | null>(null);
	const ignoreRects = useRef<NormalizedRect[]>([]);
	const serverMode = useRef(false);
	// Idle sampling opens a second capture: only when agents can use it (REST on / server mode).
	const [automationActive, setAutomationActive] = useState(false);

	// Blocking alert() dialogs would freeze a hidden HUD: surface them as events instead
	// while an automation command runs (or always in server mode).
	useEffect(() => {
		const originalAlert = window.alert.bind(window);
		window.alert = (message?: unknown) => {
			const text = String(message ?? "");
			if (capturedAlerts.current || serverMode.current) {
				capturedAlerts.current?.push(text);
				emitAutomationEvent("hud.alert", { message: text });
				console.warn("[automation] HUD alert:", text);
				return;
			}
			originalAlert(text);
		};
		return () => {
			window.alert = originalAlert;
		};
	}, []);

	useEffect(() => {
		const api = getAutomationApi();
		if (!api) return;
		void api
			.getRuntimeInfo()
			.then((info) => {
				serverMode.current = info.serverMode;
				if (info.serverMode || info.restEnabled) setAutomationActive(true);
			})
			.catch(() => undefined);
		void api
			.getSettings()
			.then((settings) => {
				idleSettings.current = settings;
			})
			.catch(() => undefined);
		return api.onNotification((type, data) => {
			if (type === "settings-changed" && data && typeof data === "object") {
				idleSettings.current = data as AutomationSettings;
				setAutomationActive(serverMode.current || (data as AutomationSettings).restEnabled);
			} else if (type === "idle-ignore-rects") {
				ignoreRects.current = readRects(data);
			}
		});
	}, []);

	// Report every state transition; main turns them into REST events and journal entries.
	const { recording, paused, starting, finalizing, countdownActive } = recorder;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the flags are the trigger; the snapshot reads the latest ref.
	useEffect(() => {
		emitAutomationEvent("recording.state", snapshotOf(latest.current));
	}, [recording, paused, starting, finalizing, countdownActive]);

	const wasBusy = useRef(false);
	const clockAtStopRef = useRef<number | null>(null);
	useEffect(() => {
		const busy = recording || finalizing;
		if (wasBusy.current && !busy) {
			void window.electronAPI
				.getCurrentRecordingSession()
				.then((result) => {
					const session = result?.session ?? null;
					emitAutomationEvent("recording.finalized", {
						videoPath: session?.videoPath ?? null,
						session,
						clockMsAtStop: clockAtStopRef.current,
					});
					clockAtStopRef.current = null;
				})
				.catch(() => emitAutomationEvent("recording.finalized", { videoPath: null }));
		}
		wasBusy.current = busy;
	}, [recording, finalizing]);

	// Idle detection: sample the recorded source while recording (not while paused).
	useEffect(() => {
		if (!recording || paused || !automationActive) return;
		let cancelled = false;
		let sampler: SourceSampler | null = null;
		let timer: number | null = null;
		const settings = idleSettings.current;
		const detector = new IdleDetector({
			idleAfterMs: (settings?.idleThresholdSeconds ?? 6) * 1000,
			changeThreshold: settings?.idleChangeThreshold ?? 0.002,
			changeConfirmSamples: 2,
		});
		const recordingNow = () =>
			getRecordingTimeMs(latest.current.getRecordingClockSnapshot(), Date.now());

		void (async () => {
			try {
				sampler = await openSourceSampler(await getSelectedSourceId(), {
					ignoreRects: ignoreRects.current,
				});
			} catch (error) {
				emitAutomationEvent("idle.unavailable", {
					message: error instanceof Error ? error.message : String(error),
				});
				return;
			}
			if (cancelled) {
				sampler.close();
				return;
			}
			detector.reset(recordingNow());
			timer = window.setInterval(() => {
				if (!sampler) return;
				const current = idleSettings.current;
				if (current) {
					detector.configure({
						idleAfterMs: current.idleThresholdSeconds * 1000,
						changeThreshold: current.idleChangeThreshold,
					});
				}
				sampler.setIgnoreRects(ignoreRects.current);
				const fraction = sampler.sampleChange();
				if (fraction === null) return;
				for (const event of detector.push(recordingNow(), fraction)) {
					emitAutomationEvent(event.type, event);
				}
			}, SAMPLE_INTERVAL_MS);
		})();

		return () => {
			cancelled = true;
			if (timer !== null) window.clearInterval(timer);
			sampler?.close();
			for (const event of detector.flush(recordingNow())) {
				emitAutomationEvent(event.type, {
					...event,
					reason: "recording-paused-or-stopped",
				});
			}
		};
	}, [recording, paused, automationActive]);

	const handlers = useRef<AutomationCommandHandlers>({});
	handlers.current = {
		"recording.status": () => snapshotOf(latest.current),

		"recording.configure": async (args) => configure(args),

		"recording.start": async (args) => {
			const current = latest.current;
			if (current.recording || current.starting || current.countdownActive) {
				throw new AutomationCommandError("conflict", "A recording is already in progress.");
			}
			if (current.finalizing) {
				throw new AutomationCommandError(
					"conflict",
					"The previous recording is still saving.",
				);
			}
			await getSelectedSourceId();
			await configure(args);
			capturedAlerts.current = [];
			try {
				latest.current.toggleRecording();
				const countdownMs = (latest.current.countdownDelay ?? 0) * 1000;
				const startedAt = Date.now();
				const outcome = await waitForValue(() => {
					const state = latest.current;
					if (state.recording) return "recording";
					const settled = !state.starting && !state.countdownActive;
					if (settled && Date.now() - startedAt > 1500) return "failed";
					return null;
				}, 60_000 + countdownMs);
				if (outcome !== "recording") {
					const reason = capturedAlerts.current?.join(" ") || "Recording did not start.";
					throw new AutomationCommandError("start_failed", reason);
				}
				return snapshotOf(latest.current);
			} finally {
				capturedAlerts.current = null;
			}
		},

		"recording.pause": async () => {
			const current = latest.current;
			if (!current.recording) throw new AutomationCommandError("conflict", "Not recording.");
			if (current.paused) return snapshotOf(current);
			current.pauseRecording();
			const paused = await waitForValue(() => latest.current.paused, 10_000);
			if (!paused)
				throw new AutomationCommandError("pause_failed", "Recording did not pause.");
			return snapshotOf(latest.current);
		},

		"recording.resume": async () => {
			const current = latest.current;
			if (!current.recording) throw new AutomationCommandError("conflict", "Not recording.");
			if (!current.paused) return snapshotOf(current);
			current.resumeRecording();
			const resumed = await waitForValue(() => !latest.current.paused, 10_000);
			if (!resumed)
				throw new AutomationCommandError("resume_failed", "Recording did not resume.");
			return snapshotOf(latest.current);
		},

		"recording.stop": async () => {
			const current = latest.current;
			if (!current.recording) throw new AutomationCommandError("conflict", "Not recording.");
			const clockMsAtStop = getRecordingTimeMs(
				current.getRecordingClockSnapshot(),
				Date.now(),
			);
			clockAtStopRef.current = clockMsAtStop;
			current.toggleRecording();
			const done = await waitForValue(
				() => !latest.current.recording && !latest.current.finalizing,
				10 * 60_000,
				100,
			);
			if (!done)
				throw new AutomationCommandError("stop_timeout", "Recording did not finalize.");
			const result = await window.electronAPI.getCurrentRecordingSession();
			return { videoPath: result?.session?.videoPath ?? null, clockMsAtStop };
		},

		"recording.cancel": async () => {
			latest.current.cancelRecording();
			await waitForValue(() => !latest.current.recording, 10_000);
			return snapshotOf(latest.current);
		},

		"sources.list": async (args) => {
			const types = Array.isArray(args.types)
				? (args.types.filter((type) => type === "screen" || type === "window") as Array<
						"screen" | "window"
					>)
				: (["screen", "window"] as Array<"screen" | "window">);
			const sources = await window.electronAPI.getSources({
				types,
				thumbnailSize: { width: 0, height: 0 },
				fetchWindowIcons: false,
			});
			return sources.map((source) => {
				const {
					thumbnail: _thumbnail,
					appIcon: _appIcon,
					...rest
				} = source as typeof source & {
					thumbnail?: unknown;
					appIcon?: unknown;
				};
				return rest;
			});
		},

		"visual.wait": async (args) => {
			const condition = readString(args, "condition") === "changed" ? "changed" : "stable";
			const forMs = Math.max(0, readNumber(args, "forMs") ?? 2000);
			const timeoutMs = Math.max(forMs, readNumber(args, "timeoutMs") ?? 60_000);
			const threshold =
				readNumber(args, "threshold") ?? idleSettings.current?.idleChangeThreshold ?? 0.002;
			const sampler = await openSourceSampler(await getSelectedSourceId(), {
				frameRate: 4,
				ignoreRects: readRects(args.ignoreRects),
			});
			const startedAt = Date.now();
			let conditionSince: number | null = null;
			try {
				while (Date.now() - startedAt < timeoutMs) {
					await delay(250);
					const fraction = sampler.sampleChange();
					if (fraction === null) continue;
					const matches =
						condition === "stable" ? fraction <= threshold : fraction > threshold;
					if (!matches) {
						conditionSince = null;
						continue;
					}
					conditionSince ??= Date.now();
					if (condition === "changed" || Date.now() - conditionSince >= forMs) {
						return { met: true, condition, elapsedMs: Date.now() - startedAt };
					}
				}
				return { met: false, condition, elapsedMs: Date.now() - startedAt };
			} finally {
				sampler.close();
			}
		},
	};

	async function configure(args: Record<string, unknown>) {
		const current = latest.current;
		const microphone = readBoolean(args, "microphone");
		const systemAudio = readBoolean(args, "systemAudio");
		const webcam = readBoolean(args, "webcam");
		const microphoneDeviceId = readString(args, "microphoneDeviceId");
		const webcamDeviceId = readString(args, "webcamDeviceId");
		const countdownSeconds = readNumber(args, "countdownSeconds");
		if (microphone !== undefined) current.setMicrophoneEnabled(microphone);
		if (systemAudio !== undefined) current.setSystemAudioEnabled(systemAudio);
		if (webcam !== undefined) current.setWebcamEnabled(webcam);
		if (microphoneDeviceId !== undefined)
			current.setMicrophoneDeviceId(microphoneDeviceId || undefined);
		if (webcamDeviceId !== undefined) current.setWebcamDeviceId(webcamDeviceId || undefined);
		if (countdownSeconds !== undefined) {
			current.setCountdownDelay(Math.max(0, Math.round(countdownSeconds)));
		}
		// Let React re-render so the recorder's start closure sees the new values.
		await waitForValue(() => {
			const state = latest.current;
			return (
				(microphone === undefined || state.microphoneEnabled === microphone) &&
				(systemAudio === undefined || state.systemAudioEnabled === systemAudio) &&
				(webcam === undefined || state.webcamEnabled === webcam) &&
				(countdownSeconds === undefined ||
					state.countdownDelay === Math.max(0, Math.round(countdownSeconds)))
			);
		}, 2000);
		await delay(30);
		return snapshotOf(latest.current);
	}

	useAutomationBridge("hud", handlers);
}
