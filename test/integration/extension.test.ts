/**
 * The command is the only way the server starts, so these tests drive it the
 * way Pi does: through the registered handler, with the agent directory the
 * environment points at. The server really listens, because "the view shows the
 * conversations on disk" is the behavior under test, not a mock of it. Every
 * test that starts a real server closes it in `finally`, shutdown included, so
 * one failing assertion cannot leave a listening socket behind.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ChatViewSession, createChatViewSession } from "../../src/command.ts";
import { CONFIG_FILE } from "../../src/config.ts";
import chatViewExtension from "../../src/index.ts";
import { startViewServer, type ViewServer } from "../../src/server.ts";
import { writeChildSession } from "../helpers/child.ts";
import { harness } from "../helpers/harness.ts";

function withAgentDir<T>(fn: (agentDir: string, sessions: string) => Promise<T> | T): Promise<T> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-chat-view-agent-"));
	const sessions = join(agentDir, "spawn-sessions");
	const saved = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	return Promise.resolve()
		.then(() => fn(agentDir, sessions))
		.finally(() => {
			if (saved === undefined) delete process.env["PI_CODING_AGENT_DIR"];
			else process.env["PI_CODING_AGENT_DIR"] = saved;
			rmSync(agentDir, { recursive: true, force: true });
		});
}

async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
	const address = probe.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}

function writeFixtures(sessions: string): void {
	writeChildSession(sessions, {
		id: "aaaaaaaa",
		start: "2026-09-28T12:11:23.882Z",
		briefing: "bob (bbbbbbbb)",
		events: [{ type: "assistant", at: "2026-09-28T12:11:40.000Z", send: { to: "bbbbbbbb", text: "hello bob" } }],
	});
	writeChildSession(sessions, {
		id: "bbbbbbbb",
		start: "2026-09-28T12:11:23.883Z",
		briefing: "alice (aaaaaaaa)",
		task: "listen",
	});
}

async function reachable(url: string): Promise<boolean> {
	try {
		const response = await fetch(`${url}/api/threads`);
		return response.ok;
	} catch {
		return false;
	}
}

test("the extension registers one command and a shutdown hook, and no tools", () => {
	const h = harness(chatViewExtension);
	assert.deepEqual([...h.commands.keys()], ["chat-view"]);
	assert.deepEqual([...h.events.keys()], ["session_shutdown"]);
});

test("the command starts the view, serves the directory, and stops on shutdown", async () => {
	await withAgentDir(async (agentDir, sessions) => {
		writeFixtures(sessions);
		writeFileSync(join(agentDir, CONFIG_FILE), JSON.stringify({ port: await freePort() }));
		const h = harness(chatViewExtension);
		try {
			assert.equal(h.notifications.length, 0, "loading the extension must not start anything");
			await h.run("");
			const url = h.notifications.at(-1)?.message.replace("pi-chat-view: ", "") ?? "";
			assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
			assert.ok(await reachable(url), "the server must answer once the command ran");
			assert.deepEqual(await (await fetch(`${url}/api/threads`)).json(), {
				dir: sessions,
				threads: [
					{
						id: "aaaaaaaa+bbbbbbbb",
						participants: [
							{ id: "aaaaaaaa", label: "alice" },
							{ id: "bbbbbbbb", label: "bob" },
						],
						firstMs: Date.parse("2026-09-28T12:11:23.882Z"),
						lastMs: Date.parse("2026-09-28T12:11:40.000Z"),
						unparsedBriefing: false,
					},
				],
			});

			await h.run("");
			assert.match(h.notifications.at(-1)?.message ?? "", /already running/);

			await h.emit("session_shutdown");
			assert.equal(await reachable(url), false, "shutdown must close the socket");

			await h.run("stop");
			assert.equal(h.notifications.at(-1)?.message, "pi-chat-view is not running");
		} finally {
			await h.emit("session_shutdown");
		}
	});
});

test("a second command after stop starts a fresh server", async () => {
	await withAgentDir(async (agentDir) => {
		writeFileSync(join(agentDir, CONFIG_FILE), JSON.stringify({ port: await freePort() }));
		const h = harness(chatViewExtension);
		try {
			await h.run("");
			const first = h.notifications.at(-1)?.message ?? "";
			await h.run("stop");
			assert.equal(h.notifications.at(-1)?.message, "pi-chat-view stopped");
			await h.run("");
			assert.equal(h.notifications.at(-1)?.message, first, "the configured port is reused");
		} finally {
			await h.emit("session_shutdown");
		}
	});
});

test("the default port and directory come from the configuration", async () => {
	await withAgentDir(async (agentDir, sessions) => {
		const seen: Array<{ dir: string; port: number }> = [];
		const session = createChatViewSession(async (options) => {
			seen.push(options);
			return { url: "http://127.0.0.1:0", port: 0, close: async () => {} };
		});
		const h = harness(() => {});
		await session.run("", h.ctx);
		assert.deepEqual(seen, [{ dir: sessions, port: 7787 }]);
		assert.equal(h.notifications.at(-1)?.message, "pi-chat-view: http://127.0.0.1:0");

		writeFileSync(join(agentDir, CONFIG_FILE), '{"port": "nope"}');
		await session.stop();
		await session.run("start", h.ctx);
		assert.deepEqual(seen[1], { dir: sessions, port: 7787 });
		assert.match(h.notifications.at(-2)?.message ?? "", /using port 7787/);
		await session.stop();
	});
});

test("a stop during startup closes the server that arrives afterwards", async () => {
	const deferred: { resolve: (server: ViewServer) => void } = { resolve: () => {} };
	const closed: string[] = [];
	const session = createChatViewSession(
		() =>
			new Promise<ViewServer>((resolve) => {
				deferred.resolve = resolve;
			}),
	);
	const h = harness(() => {});
	const starting = session.run("", h.ctx);
	const stopping = session.stop();
	deferred.resolve({
		url: "http://127.0.0.1:1",
		port: 1,
		close: async () => {
			closed.push("closed");
		},
	});
	await Promise.all([starting, stopping]);
	assert.deepEqual(closed, ["closed"], "the late server must not stay listening");
	await session.run("stop", h.ctx);
	assert.equal(
		h.notifications.at(-1)?.message,
		"pi-chat-view is not running",
		"after the stop the session holds no server",
	);
});

test("startup failures and unknown arguments are reported, not thrown", async () => {
	const h = harness(() => {});
	const failing = createChatViewSession(async () => {
		throw new Error("port 1 is already in use");
	});
	await failing.run("", h.ctx);
	assert.deepEqual(h.notifications.at(-1), { message: "pi-chat-view failed: port 1 is already in use", type: "error" });

	await failing.run("bogus", h.ctx);
	assert.deepEqual(h.notifications.at(-1), { message: "usage: /chat-view [start|stop|status]", type: "warning" });
});

test("a real server rejects an occupied port through the command", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-chat-view-blocker-"));
	const blocker = await startViewServer({ dir, port: 0 });
	const session: ChatViewSession = createChatViewSession((options) =>
		startViewServer({ ...options, port: blocker.port }),
	);
	const h = harness(() => {});
	try {
		await session.run("", h.ctx);
		assert.equal(h.notifications.at(-1)?.type, "error");
		assert.match(h.notifications.at(-1)?.message ?? "", /already in use/);
	} finally {
		await blocker.close();
		await session.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an injected server is started and closed by the session", async () => {
	const started: ViewServer[] = [];
	await withAgentDir(async (agentDir, sessions) => {
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(agentDir, CONFIG_FILE), '{"port": 1}');
		const h = harness(() => {});
		const session = createChatViewSession(async (options) => {
			const server = await startViewServer({ ...options, port: 0 });
			started.push(server);
			return server;
		});
		await session.run("", h.ctx);
		const url = started[0]?.url ?? "";
		assert.ok(await reachable(url));
		await session.stop();
		assert.equal(await reachable(url), false);
	});
});

test("status reports the port in effect and the running server", async () => {
	await withAgentDir(async (agentDir) => {
		const h = harness(chatViewExtension);
		const config = join(agentDir, CONFIG_FILE);
		await h.run("status");
		assert.deepEqual(h.notifications.at(-1), {
			message: `pi-chat-view: stopped\nport: 7787\nconfig: ${config}`,
			type: "info",
		});

		const port = await freePort();
		writeFileSync(config, JSON.stringify({ port }));
		try {
			await h.run("start");
			await h.run("status");
			assert.equal(
				h.notifications.at(-1)?.message,
				`pi-chat-view: running at http://127.0.0.1:${port}\nport: ${port}\nconfig: ${config}`,
			);
		} finally {
			await h.emit("session_shutdown");
		}
	});
});

test("status reports a broken config instead of hiding it", async () => {
	await withAgentDir(async (agentDir) => {
		writeFileSync(join(agentDir, CONFIG_FILE), "{");
		const h = harness(chatViewExtension);
		await h.run("status");
		const message = h.notifications.at(-1)?.message ?? "";
		assert.match(message, /^pi-chat-view: stopped$/m);
		assert.match(message, /^port: 7787$/m);
		assert.match(message, /^warning: chat-view\.json: invalid JSON/m);
	});
});

test("status reports a start in flight", async () => {
	await withAgentDir(async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const session = createChatViewSession(async () => {
			await gate;
			return { url: "http://127.0.0.1:0", port: 0, close: async () => {} };
		});
		const h = harness(() => {});
		const starting = session.run("", h.ctx);
		await session.run("status", h.ctx);
		assert.match(h.notifications.at(-1)?.message ?? "", /^pi-chat-view: starting$/m);
		release?.();
		await starting;
		await session.stop();
	});
});
