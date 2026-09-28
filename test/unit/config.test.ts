import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_FILE, DEFAULT_PORT, readViewConfig } from "../../src/config.ts";

function withAgentDir<T>(content: string | undefined, fn: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "pi-chat-view-config-"));
	try {
		if (content !== undefined) writeFileSync(join(dir, CONFIG_FILE), content);
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("a missing config keeps the default port", () => {
	withAgentDir(undefined, (dir) => {
		assert.deepEqual(readViewConfig(dir), { config: { port: DEFAULT_PORT } });
	});
});

test("a valid port is used", () => {
	withAgentDir('{"port": 8080}', (dir) => {
		assert.deepEqual(readViewConfig(dir), { config: { port: 8080 } });
	});
});

test("invalid json, shapes, and ranges fall back with a warning", () => {
	for (const content of ["{", "null", "[]", '{"port": "8080"}', '{"port": 0}', '{"port": 65536}', '{"port": 1.5}']) {
		withAgentDir(content, (dir) => {
			const result = readViewConfig(dir);
			assert.equal(result.config.port, DEFAULT_PORT, content);
			assert.match(result.warning ?? "", /port/, content);
		});
	}
});
