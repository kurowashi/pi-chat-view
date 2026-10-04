/**
 * The view's configuration.
 *
 * There is one setting, the port, because the server is read-only and bound to
 * loopback. A broken file degrades to the default instead of failing the
 * command, and the caller decides how to report the warning.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE = "chat-view.json";

export const DEFAULT_PORT = 7787;

interface ViewConfig {
	port: number;
}

export interface ConfigResult {
	config: ViewConfig;
	warning?: string;
}

export function readViewConfig(agentDir: string): ConfigResult {
	const path = join(agentDir, CONFIG_FILE);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { config: { port: DEFAULT_PORT } };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return { config: { port: DEFAULT_PORT }, warning: `${CONFIG_FILE}: invalid JSON, using port ${DEFAULT_PORT}` };
	}
	const port = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["port"] : undefined;
	if (typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535) {
		return { config: { port } };
	}
	return {
		config: { port: DEFAULT_PORT },
		warning: `${CONFIG_FILE}: port must be an integer between 1 and 65535, using port ${DEFAULT_PORT}`,
	};
}
