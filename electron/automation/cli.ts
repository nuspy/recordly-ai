import { DEFAULT_AUTOMATION_PORT } from "./contract";

export interface AutomationLaunchOptions {
	/** `--server`: headless, REST-controlled mode. */
	server: boolean;
	/** `--port <n>` / `--port=<n>`: overrides the configured REST port. */
	port: number | null;
	/** `--show`: keep windows visible in server mode (debugging / supervision). */
	show: boolean;
}

function parsePort(value: string | undefined): number | null {
	if (!value) return null;
	const port = Number.parseInt(value, 10);
	return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

/**
 * Parses Recordly AI launch flags. `RECORDLY_SERVER=1` / `RECORDLY_SERVER_PORT` exist for
 * `npm run dev`, where vite launches Electron without forwarding CLI arguments.
 */
export function parseAutomationArgs(
	argv: readonly string[],
	env: Record<string, string | undefined> = {},
): AutomationLaunchOptions {
	let server = env.RECORDLY_SERVER === "1";
	let show = env.RECORDLY_SERVER_SHOW === "1";
	let port = parsePort(env.RECORDLY_SERVER_PORT);

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--server") {
			server = true;
		} else if (arg === "--show") {
			show = true;
		} else if (arg === "--port") {
			port = parsePort(argv[index + 1]) ?? port;
			index++;
		} else if (arg.startsWith("--port=")) {
			port = parsePort(arg.slice("--port=".length)) ?? port;
		}
	}

	return { server, port, show };
}

export function resolveAutomationPort(options: AutomationLaunchOptions, configuredPort?: number) {
	return options.port ?? configuredPort ?? DEFAULT_AUTOMATION_PORT;
}
