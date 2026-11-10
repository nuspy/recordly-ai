import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "HttpError";
	}
}

export const badRequest = (message: string, details?: unknown) =>
	new HttpError(400, "bad_request", message, details);
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
export const conflict = (message: string, details?: unknown) =>
	new HttpError(409, "conflict", message, details);
export const unavailable = (code: string, message: string) => new HttpError(503, code, message);

export interface RequestContext {
	req: IncomingMessage;
	res: ServerResponse;
	method: string;
	path: string;
	params: Record<string, string>;
	query: URLSearchParams;
	/** Lazily parsed JSON body (empty object when there is no body). */
	json<T = Record<string, unknown>>(): Promise<T>;
	/** Raw body bytes (for `audio/*` uploads). */
	raw(): Promise<Buffer>;
	contentType: string;
}

/** Marker result: the handler already wrote the response (SSE, binary). */
export const HANDLED = Symbol("handled");
export type HandlerResult = unknown | typeof HANDLED;
export type RouteHandler = (ctx: RequestContext) => Promise<HandlerResult> | HandlerResult;

export const MAX_BODY_BYTES = 256 * 1024 * 1024;

export function readRequestBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new HttpError(413, "payload_too_large", `Body exceeds ${limit} bytes.`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
	const payload = JSON.stringify(body ?? null);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-store",
	});
	res.end(payload);
}

export function sendError(res: ServerResponse, error: unknown) {
	if (error instanceof HttpError) {
		sendJson(res, error.status, {
			error: { code: error.code, message: error.message, details: error.details },
		});
		return;
	}
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof Error && error.name === "BridgeError") {
		// Agents fall back to their own TTS/STT on this code.
		sendJson(res, 502, { error: { code: "bridge_unavailable", message } });
		return;
	}
	sendJson(res, 500, { error: { code: "internal_error", message } });
}

// ── Small validation helpers (no schema library in the main bundle) ──

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw badRequest(`"${key}" must be a string.`);
	return value;
}

export function requireString(body: Record<string, unknown>, key: string): string {
	const value = optionalString(body, key);
	if (!value || !value.trim()) throw badRequest(`"${key}" is required.`);
	return value;
}

export function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(numeric)) throw badRequest(`"${key}" must be a number.`);
	return numeric;
}

export function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") throw badRequest(`"${key}" must be a boolean.`);
	return value;
}
