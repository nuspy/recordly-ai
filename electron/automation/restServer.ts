import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	HANDLED,
	HttpError,
	type RequestContext,
	readRequestBody,
	sendError,
	sendJson,
} from "./http";
import type { AutomationRouter } from "./router";

export const AUTOMATION_HOST = "127.0.0.1";

/** Routes reachable without a token: liveness only, no data. */
const PUBLIC_ROUTES = new Set(["GET /v1/health"]);

function tokensMatch(expected: string, provided: string) {
	const a = Buffer.from(expected);
	const b = Buffer.from(provided);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Rejects requests that did not come from a local, non-browser client:
 * - the Host header must name the loopback listener (defeats DNS rebinding);
 * - any Origin header means a browser page is calling us (no CORS, ever).
 */
export function checkRequestOrigin(req: IncomingMessage, port: number): HttpError | null {
	const host = (req.headers.host ?? "").toLowerCase();
	const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
	if (!allowedHosts.has(host)) {
		return new HttpError(421, "invalid_host", "Requests must target the loopback address.");
	}
	if (req.headers.origin !== undefined) {
		return new HttpError(403, "browser_origin_rejected", "Browser requests are not accepted.");
	}
	return null;
}

export function checkAuthorization(req: IncomingMessage, token: string): HttpError | null {
	const header = req.headers.authorization ?? "";
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	if (!match || !tokensMatch(token, match[1].trim())) {
		return new HttpError(401, "unauthorized", "Missing or invalid bearer token.");
	}
	return null;
}

export interface AutomationServerOptions {
	router: AutomationRouter;
	token: string;
	port: number;
	onRequestError?: (error: unknown, method: string, path: string) => void;
}

export interface RunningAutomationServer {
	port: number;
	baseUrl: string;
	close(): Promise<void>;
}

export function startAutomationServer(
	options: AutomationServerOptions,
): Promise<RunningAutomationServer> {
	let boundPort = options.port;

	const server: Server = createServer(async (req, res) => {
		const method = (req.method ?? "GET").toUpperCase();
		const url = new URL(req.url ?? "/", `http://${AUTOMATION_HOST}:${boundPort}`);
		const path = url.pathname.replace(/\/+$/, "") || "/";
		try {
			const originError = checkRequestOrigin(req, boundPort);
			if (originError) throw originError;
			if (!PUBLIC_ROUTES.has(`${method} ${path}`)) {
				const authError = checkAuthorization(req, options.token);
				if (authError) throw authError;
			}

			const match = options.router.match(method, path);
			if (match === "method") {
				throw new HttpError(
					405,
					"method_not_allowed",
					`${method} is not allowed on ${path}.`,
				);
			}
			if (!match) {
				throw new HttpError(404, "not_found", `No route for ${method} ${path}.`);
			}

			let rawBody: Promise<Buffer> | null = null;
			const raw = () => {
				rawBody ??= readRequestBody(req);
				return rawBody;
			};
			const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
			const ctx: RequestContext = {
				req,
				res,
				method,
				path,
				params: match.params,
				query: url.searchParams,
				contentType,
				raw,
				json: async <T>() => {
					const buffer = await raw();
					if (buffer.length === 0) return {} as T;
					try {
						const parsed = JSON.parse(buffer.toString("utf8"));
						if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
							throw new Error("not an object");
						}
						return parsed as T;
					} catch {
						throw new HttpError(400, "invalid_json", "Body must be a JSON object.");
					}
				},
			};

			const result = await match.route.handler(ctx);
			if (result !== HANDLED && !res.headersSent) {
				sendJson(res, 200, result ?? { ok: true });
			}
		} catch (error) {
			options.onRequestError?.(error, method, path);
			if (!res.headersSent) {
				sendError(res, error);
			} else {
				res.end();
			}
		}
	});

	// Long-polls and SSE streams must not be cut by Node's default request timeouts.
	server.requestTimeout = 0;
	server.headersTimeout = 60_000;

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, AUTOMATION_HOST, () => {
			server.off("error", reject);
			boundPort = (server.address() as AddressInfo).port;
			resolve({
				port: boundPort,
				baseUrl: `http://${AUTOMATION_HOST}:${boundPort}`,
				close: () =>
					new Promise<void>((done) => {
						server.closeAllConnections();
						server.close(() => done());
					}),
			});
		});
	});
}
