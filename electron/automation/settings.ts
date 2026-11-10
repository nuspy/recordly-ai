import { readAppSetting, writeAppSetting } from "../appSettingsStore";
import {
	type AutomationSettings,
	DEFAULT_AUTOMATION_SETTINGS,
	normalizeAutomationSettings,
} from "./contract";

export const AUTOMATION_SETTINGS_KEY = "recordlyAi.automation";

export function readAutomationSettings(): AutomationSettings {
	return normalizeAutomationSettings(readAppSetting(AUTOMATION_SETTINGS_KEY) ?? {});
}

export function writeAutomationSettings(patch: Partial<AutomationSettings>): AutomationSettings {
	const next = normalizeAutomationSettings({ ...readAutomationSettings(), ...patch });
	writeAppSetting(AUTOMATION_SETTINGS_KEY, next);
	return next;
}

export { DEFAULT_AUTOMATION_SETTINGS };
