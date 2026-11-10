import type { RouteHandler } from "./http";

export interface RouteDefinition {
	method: string;
	pattern: string;
	summary: string;
	handler: RouteHandler;
}

interface CompiledRoute extends RouteDefinition {
	segments: string[];
}

export interface RouteMatch {
	route: RouteDefinition;
	params: Record<string, string>;
}

function splitPath(path: string) {
	return path.split("/").filter(Boolean);
}

/** Tiny `(method, "/v1/presets/:id")` router; `:name` segments become params. */
export class AutomationRouter {
	private readonly routes: CompiledRoute[] = [];

	add(method: string, pattern: string, summary: string, handler: RouteHandler) {
		this.routes.push({
			method: method.toUpperCase(),
			pattern,
			summary,
			handler,
			segments: splitPath(pattern),
		});
		return this;
	}

	list(): RouteDefinition[] {
		return this.routes.map(({ method, pattern, summary, handler }) => ({
			method,
			pattern,
			summary,
			handler,
		}));
	}

	/** Returns the match, `"method"` when only the method is wrong, or null. */
	match(method: string, path: string): RouteMatch | "method" | null {
		const segments = splitPath(path);
		let methodMismatch = false;
		for (const route of this.routes) {
			if (route.segments.length !== segments.length) continue;
			const params: Record<string, string> = {};
			const matches = route.segments.every((segment, index) => {
				if (segment.startsWith(":")) {
					params[segment.slice(1)] = decodeURIComponent(segments[index]);
					return true;
				}
				return segment === segments[index];
			});
			if (!matches) continue;
			if (route.method !== method.toUpperCase()) {
				methodMismatch = true;
				continue;
			}
			return { route, params };
		}
		return methodMismatch ? "method" : null;
	}
}
