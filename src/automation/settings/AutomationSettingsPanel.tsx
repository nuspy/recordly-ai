import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { SettingsRow } from "@/components/video-editor/SettingsRow";
import type { AutomationSettings } from "../../../electron/automation/contract";
import type { AutomationServerStatus } from "../../../electron/automation/preloadApi";
import { getAutomationApi } from "../bridge";

type NumericKey = "port" | "idleThresholdSeconds" | "idleTargetSeconds" | "idleMaxSpeed";

const NUMBER_FIELDS: Array<{
	key: NumericKey;
	title: string;
	description: string;
	min: number;
	max: number;
	step: number;
}> = [
	{
		key: "idleThresholdSeconds",
		title: "Detect a still screen after (s)",
		description:
			"When the recorded window shows no visual change for this long, agents get an idle event and the wait is marked for speed-up.",
		min: 1,
		max: 600,
		step: 1,
	},
	{
		key: "idleTargetSeconds",
		title: "Accelerated wait lasts (s)",
		description:
			"Each long wait (e.g. an AI image or video being generated) is compressed to about this duration in the edit.",
		min: 1,
		max: 600,
		step: 1,
	},
	{
		key: "idleMaxSpeed",
		title: "Maximum speed",
		description: "Up to 16×. Longer waits keep their start and end and cut the middle.",
		min: 1,
		max: 16,
		step: 0.5,
	},
	{
		key: "port",
		title: "REST port",
		description: "Local port of the automation API (127.0.0.1 only).",
		min: 1024,
		max: 65535,
		step: 1,
	},
];

/** Settings for the agent-facing REST API and the idle speed-up behaviour. */
export function AutomationSettingsPanel() {
	const api = getAutomationApi();
	const [settings, setSettings] = useState<AutomationSettings | null>(null);
	const [status, setStatus] = useState<AutomationServerStatus | null>(null);
	const [drafts, setDrafts] = useState<Partial<Record<NumericKey, string>>>({});
	const [showToken, setShowToken] = useState(false);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		if (!api) return;
		const [nextSettings, nextStatus] = await Promise.all([
			api.getSettings(),
			api.getServerStatus(),
		]);
		setSettings(nextSettings);
		setStatus(nextStatus);
	}, [api]);

	useEffect(() => {
		void refresh().catch((error) => toast.error(String(error)));
	}, [refresh]);

	const update = async (patch: Partial<AutomationSettings>) => {
		if (!api) return;
		setBusy(true);
		try {
			setSettings(await api.setSettings(patch));
			setStatus(await api.getServerStatus());
		} catch (error) {
			toast.error(String(error));
		} finally {
			setBusy(false);
		}
	};

	if (!api || !settings) {
		return <p className="text-xs text-muted-foreground">Automation is not available here.</p>;
	}

	const commitNumber = (key: NumericKey) => {
		const draft = drafts[key];
		if (draft === undefined) return;
		const value = Number(draft);
		setDrafts((current) => ({ ...current, [key]: undefined }));
		if (Number.isFinite(value) && value !== settings[key]) void update({ [key]: value });
	};

	const statusText = status?.running
		? `Listening on ${status.baseUrl}`
		: status?.error
			? `Not running: ${status.error}`
			: "Off. Agents can still start Recordly AI with --server.";

	return (
		<div className="space-y-6">
			<SettingsRow title="REST API for AI agents" description={statusText}>
				<Switch
					aria-label="REST API for AI agents"
					checked={settings.restEnabled || Boolean(status?.running)}
					disabled={busy}
					onCheckedChange={(enabled) => void update({ restEnabled: enabled })}
				/>
			</SettingsRow>

			{status?.running && status.token && (
				<SettingsRow
					title="Access token"
					description={
						<span className="block truncate font-mono" title={status.tokenFile ?? ""}>
							{showToken ? status.token : "••••••••••••••••"}
						</span>
					}
				>
					<div className="flex gap-2">
						<Button
							variant="secondary"
							size="sm"
							onClick={() => setShowToken((v) => !v)}
						>
							{showToken ? "Hide" : "Show"}
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={() =>
								void navigator.clipboard
									.writeText(status.token ?? "")
									.then(() => toast.success("Token copied"))
							}
						>
							Copy
						</Button>
						<Button
							variant="secondary"
							size="sm"
							disabled={busy}
							onClick={() =>
								void api
									.rotateToken()
									.then((next) => {
										setStatus(next);
										toast.success("New token generated");
									})
									.catch((error) => toast.error(String(error)))
							}
						>
							Regenerate
						</Button>
					</div>
				</SettingsRow>
			)}

			{NUMBER_FIELDS.map((field) => (
				<SettingsRow key={field.key} title={field.title} description={field.description}>
					<Input
						aria-label={field.title}
						type="number"
						className="w-24"
						min={field.min}
						max={field.max}
						step={field.step}
						value={drafts[field.key] ?? String(settings[field.key])}
						onChange={(event) =>
							setDrafts((current) => ({
								...current,
								[field.key]: event.target.value,
							}))
						}
						onBlur={() => commitNumber(field.key)}
						onKeyDown={(event) => {
							if (event.key === "Enter") commitNumber(field.key);
						}}
					/>
				</SettingsRow>
			))}

			<SettingsRow
				title="Speed up waits in agent recordings"
				description="Applied automatically when an agent-driven recording opens in the editor. Narration is never accelerated."
			>
				<Switch
					aria-label="Speed up waits in agent recordings"
					checked={settings.autoEditOnStop}
					disabled={busy}
					onCheckedChange={(enabled) => void update({ autoEditOnStop: enabled })}
				/>
			</SettingsRow>

			<SettingsRow
				title="Show ⏩ speed badge"
				description="Labels accelerated spans with the speed and the real waiting time."
			>
				<Switch
					aria-label="Show speed badge"
					checked={settings.idleSpeedBadge}
					disabled={busy}
					onCheckedChange={(enabled) => void update({ idleSpeedBadge: enabled })}
				/>
			</SettingsRow>

			<SettingsRow
				title="Narration voice (CallAPICall TTS)"
				description="Voice and language used when an agent asks Recordly AI to speak a text."
			>
				<div className="flex gap-2">
					<Input
						aria-label="TTS voice"
						className="w-28"
						defaultValue={settings.ttsVoice}
						onBlur={(event) => {
							const value = event.target.value.trim();
							if (value && value !== settings.ttsVoice)
								void update({ ttsVoice: value });
						}}
					/>
					<Input
						aria-label="TTS language"
						className="w-16"
						defaultValue={settings.ttsLanguage}
						onBlur={(event) => {
							const value = event.target.value.trim();
							if (value !== settings.ttsLanguage) void update({ ttsLanguage: value });
						}}
					/>
				</div>
			</SettingsRow>
		</div>
	);
}
