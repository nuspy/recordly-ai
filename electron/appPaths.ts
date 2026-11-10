import path from "node:path";
import { app } from "electron";
import { importUpstreamSettingsOnce } from "./automation/fork";

if (process.env["VITE_DEV_SERVER_URL"]) {
	const devUserDataPath = path.join(app.getPath("appData"), "Recordly-dev");
	app.setPath("userData", devUserDataPath);
	app.setPath("sessionData", path.join(devUserDataPath, "session"));
} else {
	importUpstreamSettingsOnce(app.getPath("userData"), app.getPath("appData"));
}

export const USER_DATA_PATH = app.getPath("userData");
export const RECORDINGS_DIR = path.join(USER_DATA_PATH, "recordings");
