/**
 * Format compatibility: the sibling briefing is the only link between children,
 * so a silent change on pi-spawn's side would split one conversation into
 * several threads with no other symptom. These tests pin the formats this reader
 * understands, the signal it raises when one moves on, and the older shapes a
 * live conversation still produces.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listThreads, readThread } from "../../src/transcript.ts";
import { writeChildSession } from "../helpers/child.ts";

function withDir<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "pi-chat-view-format-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("a briefing this reader cannot parse is reported, not hidden", () => {
	withDir((dir) => {
		writeChildSession(dir, {
			id: "dddddddd",
			start: "2026-09-29T01:00:00.000Z",
			briefing: '- peer=eeeeeeee name="peer" agent="peer"',
			events: [{ type: "assistant", at: "2026-09-29T01:00:01.000Z", narration: "answers" }],
		});
		const threads = listThreads(dir);
		assert.equal(threads.length, 1);
		assert.equal(threads[0]?.unparsedBriefing, true);
		assert.deepEqual(threads[0]?.participants, [{ id: "dddddddd", label: "dddddddd" }]);
	});
});

test("a child without siblings carries no marker and stays quiet", () => {
	withDir((dir) => {
		writeChildSession(dir, { id: "ffffffff", start: "2026-09-29T02:00:00.000Z", task: "alone" });
		assert.equal(listThreads(dir)[0]?.unparsedBriefing, false);
	});
});

test("a parsed briefing never reports a warning", () => {
	withDir((dir) => {
		writeChildSession(dir, {
			id: "aaaaaaaa",
			start: "2026-09-29T03:00:00.000Z",
			briefing: "peer (bbbbbbbb)",
			events: [{ type: "assistant", at: "2026-09-29T03:00:01.000Z", send: { to: "bbbbbbbb", text: "hi" } }],
		});
		writeChildSession(dir, { id: "bbbbbbbb", start: "2026-09-29T03:00:00.001Z", briefing: "peer (aaaaaaaa)" });
		const thread = listThreads(dir)[0];
		assert.equal(thread?.id, "aaaaaaaa+bbbbbbbb");
		assert.equal(thread?.unparsedBriefing, false);
		assert.equal(readThread(dir, thread?.id ?? "")?.entries.length, 3);
	});
});

test("an older pi-spawn that targets an agent name still shows the recipient", () => {
	withDir((dir) => {
		writeChildSession(dir, {
			id: "aaaaaaaa",
			start: "2026-09-29T04:00:00.000Z",
			briefing: "sakura (bbbbbbbb)",
			events: [{ type: "assistant", at: "2026-09-29T04:00:01.000Z", send: { to: "sakura", text: "hello sakura" } }],
		});
		writeChildSession(dir, { id: "bbbbbbbb", start: "2026-09-29T04:00:00.001Z", briefing: "nemu (aaaaaaaa)" });
		const thread = readThread(dir, "aaaaaaaa+bbbbbbbb");
		const statement = thread?.entries.find((entry) => entry.kind === "statement");
		assert.equal(statement?.toLabel, "sakura");
	});
});
