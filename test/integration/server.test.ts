/**
 * The server is the only network surface this plugin adds, so these tests pin
 * what it answers and what it refuses: loopback only, three read-only routes,
 * and a clear failure when the port is taken.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startViewServer, type ViewServer } from "../../src/server.ts";
import { writeChildSession } from "../helpers/child.ts";

function fixtureDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-chat-view-server-"));
	writeChildSession(dir, {
		id: "aaaaaaaa",
		start: "2026-09-28T12:11:23.882Z",
		briefing: "bob (bbbbbbbb)",
		events: [
			{ type: "assistant", at: "2026-09-28T12:11:40.000Z", send: { to: "bbbbbbbb", text: "hello bob" } },
			{ type: "assistant", at: "2026-09-28T12:11:41.000Z", call: { name: "bash", args: { command: "ls" } } },
		],
	});
	writeChildSession(dir, {
		id: "bbbbbbbb",
		start: "2026-09-28T12:11:23.883Z",
		briefing: "alice (aaaaaaaa)",
		events: [{ type: "assistant", at: "2026-09-28T12:11:45.000Z", narration: "listens" }],
	});
	return dir;
}

async function withServer<T>(fn: (server: ViewServer, dir: string) => Promise<T>): Promise<T> {
	const dir = fixtureDir();
	const server = await startViewServer({ dir, port: 0 });
	try {
		return await fn(server, dir);
	} finally {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

test("the page is served for the root path", async () => {
	await withServer(async (server) => {
		const response = await fetch(server.url);
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
		const page = await response.text();
		assert.match(page, /pi-chat-view/);
		assert.match(page, /\/api\/threads/);
	});
});

test("the thread list carries the directory and the participants", async () => {
	await withServer(async (server, dir) => {
		const data = (await (await fetch(`${server.url}/api/threads`)).json()) as {
			dir: string;
			threads: Array<{ id: string; participants: Array<{ label: string }> }>;
		};
		assert.equal(data.dir, dir);
		assert.equal(data.threads.length, 1);
		assert.equal(data.threads[0]?.id, "aaaaaaaa+bbbbbbbb");
		assert.deepEqual(
			data.threads[0]?.participants.map((participant) => participant.label),
			["alice", "bob"],
		);
	});
});

test("one thread is served by id, with delivery copies dropped", async () => {
	await withServer(async (server) => {
		const response = await fetch(`${server.url}/api/thread/aaaaaaaa%2Bbbbbbbbb`);
		assert.equal(response.status, 200);
		assert.match(response.headers.get("cache-control") ?? "", /no-store/);
		const thread = (await response.json()) as { entries: Array<{ kind: string; text: string; summary?: string }> };
		assert.deepEqual(
			thread.entries.filter((entry) => entry.kind === "statement").map((entry) => entry.text),
			["hello bob"],
		);
		assert.ok(thread.entries.some((entry) => entry.kind === "tool" && entry.summary === "bash command=ls"));
		assert.equal(
			thread.entries.filter((entry) => entry.text === "hello bob" && entry.kind === "instruction").length,
			0,
		);
	});
});

test("the limit parameter is bounded and invalid values fall back", async () => {
	await withServer(async (server) => {
		for (const query of ["?limit=1", "?limit=abc", "?limit=0", "?limit=99999"]) {
			const response = await fetch(`${server.url}/api/threads${query}`);
			assert.equal(response.status, 200, query);
			const data = (await response.json()) as { threads: unknown[] };
			assert.equal(data.threads.length, 1, query);
		}
	});
});

test("unknown paths and threads answer 404, and the favicon is empty", async () => {
	await withServer(async (server) => {
		const missing = await fetch(`${server.url}/api/thread/nope`);
		assert.equal(missing.status, 404);
		assert.deepEqual(await missing.json(), { error: "unknown thread 'nope'" });
		assert.equal((await fetch(`${server.url}/nope`)).status, 404);
		const favicon = await fetch(`${server.url}/favicon.ico`);
		assert.equal(favicon.status, 204);
	});
});

test("anything but GET is refused, so the view cannot be written through", async () => {
	await withServer(async (server, dir) => {
		for (const method of ["POST", "PUT", "DELETE"]) {
			const response = await fetch(`${server.url}/api/threads`, { method });
			assert.equal(response.status, 405, method);
			assert.deepEqual(await response.json(), { error: "this view is read-only" });
		}
		// The transcripts themselves are untouched by the refusals.
		const listing = (await (await fetch(`${server.url}/api/threads`)).json()) as { dir: string };
		assert.equal(listing.dir, dir);
	});
});

test("a port already in use is reported as such", async () => {
	const dir = fixtureDir();
	const blocker = createServer(() => undefined);
	await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
	const address = blocker.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	try {
		await assert.rejects(startViewServer({ dir, port }), /port \d+ is already in use/);
	} finally {
		await new Promise<void>((resolve) => blocker.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	}
});

test("close is idempotent", async () => {
	await withServer(async (server) => {
		await server.close();
		await server.close();
		assert.ok(server.port > 0);
	});
});
