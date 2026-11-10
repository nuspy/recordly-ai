import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { badRequest } from "./http";
import { type RunningAutomationServer, startAutomationServer } from "./restServer";
import { AutomationRouter } from "./router";

const TOKEN = "test-token-123";

function call(
	port: number,
	options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: unknown }> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				method: options.method ?? "GET",
				path: options.path,
				headers: { Authorization: `Bearer ${TOKEN}`, ...options.headers },
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
				});
			},
		);
		req.on("error", reject);
		if (options.body) req.write(options.body);
		req.end();
	});
}

describe("automation REST server", () => {
	let server: RunningAutomationServer | null = null;

	afterEach(async () => {
		await server?.close();
		server = null;
	});

	async function start() {
		const router = new AutomationRouter()
			.add("GET", "/v1/health", "health", () => ({ ok: true }))
			.add("GET", "/v1/presets/:id", "preset", (ctx) => ({ id: ctx.params.id }))
			.add("POST", "/v1/echo", "echo", async (ctx) => {
				const body = await ctx.json();
				if (!body.text) throw badRequest("text missing");
				return body;
			});
		server = await startAutomationServer({ router, token: TOKEN, port: 0 });
		return server.port;
	}

	it("serves health without a token but requires it elsewhere", async () => {
		const port = await start();
		await expect(
			call(port, { path: "/v1/health", headers: { Authorization: "" } }),
		).resolves.toMatchObject({ status: 200 });
		await expect(
			call(port, { path: "/v1/presets/a", headers: { Authorization: "Bearer wrong" } }),
		).resolves.toMatchObject({ status: 401 });
		await expect(call(port, { path: "/v1/presets/a%20b" })).resolves.toEqual({
			status: 200,
			body: { id: "a b" },
		});
	});

	it("rejects browser origins and foreign Host headers", async () => {
		const port = await start();
		await expect(
			call(port, { path: "/v1/health", headers: { Origin: "https://evil.example" } }),
		).resolves.toMatchObject({ status: 403 });
		await expect(
			call(port, { path: "/v1/health", headers: { Host: `evil.example:${port}` } }),
		).resolves.toMatchObject({ status: 421 });
	});

	it("maps errors to JSON responses", async () => {
		const port = await start();
		await expect(call(port, { path: "/v1/missing" })).resolves.toMatchObject({ status: 404 });
		await expect(call(port, { method: "DELETE", path: "/v1/echo" })).resolves.toMatchObject({
			status: 405,
		});
		await expect(
			call(port, { method: "POST", path: "/v1/echo", body: "{not json" }),
		).resolves.toMatchObject({ status: 400, body: { error: { code: "invalid_json" } } });
		await expect(
			call(port, { method: "POST", path: "/v1/echo", body: JSON.stringify({ x: 1 }) }),
		).resolves.toMatchObject({ status: 400, body: { error: { code: "bad_request" } } });
		await expect(
			call(port, { method: "POST", path: "/v1/echo", body: JSON.stringify({ text: "hi" }) }),
		).resolves.toEqual({ status: 200, body: { text: "hi" } });
	});
});
