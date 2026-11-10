import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AUTOMATION_API_VERSION } from "./contract";

export interface AutomationServerInfo {
	pid: number;
	port: number;
	baseUrl: string;
	apiVersion: number;
	appVersion: string;
	serverMode: boolean;
	startedAt: string;
	tokenFile: string;
}

export function getAutomationDir(userDataPath: string) {
	return path.join(userDataPath, "automation");
}

export function getTokenPath(userDataPath: string) {
	return path.join(getAutomationDir(userDataPath), "token");
}

export function getServerInfoPath(userDataPath: string) {
	return path.join(getAutomationDir(userDataPath), "server.json");
}

/** Reads the REST bearer token, creating a random one on first use (or when `rotate`). */
export function ensureAutomationToken(userDataPath: string, rotate = false): string {
	const tokenPath = getTokenPath(userDataPath);
	if (!rotate) {
		try {
			const existing = fs.readFileSync(tokenPath, "utf8").trim();
			if (existing.length >= 32) return existing;
		} catch {
			// Created below.
		}
	}
	const token = randomBytes(32).toString("hex");
	fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
	fs.writeFileSync(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
	return token;
}

export function writeServerInfo(userDataPath: string, info: AutomationServerInfo) {
	const infoPath = getServerInfoPath(userDataPath);
	fs.mkdirSync(path.dirname(infoPath), { recursive: true });
	const tempPath = `${infoPath}.${process.pid}.tmp`;
	fs.writeFileSync(tempPath, JSON.stringify(info, null, 2), "utf8");
	fs.renameSync(tempPath, infoPath);
}

export function readServerInfo(userDataPath: string): AutomationServerInfo | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(getServerInfoPath(userDataPath), "utf8"));
		return parsed && typeof parsed.port === "number" ? (parsed as AutomationServerInfo) : null;
	} catch {
		return null;
	}
}

export function removeServerInfo(userDataPath: string, pid = process.pid) {
	const info = readServerInfo(userDataPath);
	if (info && info.pid === pid) {
		fs.rmSync(getServerInfoPath(userDataPath), { force: true });
	}
}

export function isProcessAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function createServerInfo(options: {
	port: number;
	appVersion: string;
	serverMode: boolean;
	userDataPath: string;
}): AutomationServerInfo {
	return {
		pid: process.pid,
		port: options.port,
		baseUrl: `http://127.0.0.1:${options.port}`,
		apiVersion: AUTOMATION_API_VERSION,
		appVersion: options.appVersion,
		serverMode: options.serverMode,
		startedAt: new Date().toISOString(),
		tokenFile: getTokenPath(options.userDataPath),
	};
}

/**
 * Where the app is installed, refreshed on every start: launchers (`recordly_ai.py launch`)
 * find the executable here even when an installer put it in a custom folder.
 */
export function writeAppInfo(userDataPath: string, info: { executable: string; version: string }) {
	try {
		const target = path.join(getAutomationDir(userDataPath), "app.json");
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(
			target,
			JSON.stringify({ ...info, updatedAt: new Date().toISOString() }, null, 2),
			"utf8",
		);
	} catch (error) {
		console.warn("[automation] could not write app.json:", error);
	}
}
