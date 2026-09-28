/**
 * The reader is the whole reason this plugin exists, so these tests use
 * transcript files shaped like the ones pi-spawn writes: two children of one
 * spawn call that address each other, a later resume round, and the delivery
 * copies that must not appear twice.
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractBriefing, listThreads, readThread, type TimelineEntry } from "../../src/transcript.ts";
import { writeChildSession } from "../helpers/child.ts";

function withDir<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "pi-chat-view-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Two siblings of one spawn call. Bob opens with a message, alice receives it
 * and answers. `resumed` adds a second round to alice's transcript, the way
 * `resume_run_id` appends to the same file.
 */
function writePair(dir: string, options: { resumed?: boolean } = {}): void {
	writeChildSession(dir, {
		id: "aaaaaaaa",
		start: "2026-09-28T12:11:23.882Z",
		briefing: "bob (bbbbbbbb)",
		task: "greet each other",
		events: [
			{ type: "assistant", at: "2026-09-28T12:11:30.000Z", thinking: "wait first", narration: "alice waits." },
			{ type: "delivery", at: "2026-09-28T12:11:40.000Z", from: "bbbbbbbb", text: "hello alice" },
			{ type: "assistant", at: "2026-09-28T12:11:50.000Z", send: { to: "bbbbbbbb", text: "hello bob" } },
			...(options.resumed === true
				? ([
						{
							type: "prompt",
							at: "2026-09-28T12:16:24.000Z",
							text: "Siblings you can message with message_agent: bob (99999999)\n\nround two",
						},
						{ type: "assistant", at: "2026-09-28T12:16:30.000Z", send: { to: "99999999", text: "again" } },
					] as const)
				: []),
		],
	});
	writeChildSession(dir, {
		id: "bbbbbbbb",
		start: "2026-09-28T12:11:23.883Z",
		briefing: "alice (aaaaaaaa)",
		task: "greet each other",
		events: [{ type: "assistant", at: "2026-09-28T12:11:40.000Z", send: { to: "aaaaaaaa", text: "hello alice" } }],
	});
}

function kindsOf(entries: readonly TimelineEntry[]): string[] {
	return entries.map((entry) => entry.kind);
}

test("siblings that address each other form one thread", () => {
	withDir((dir) => {
		writePair(dir);
		const threads = listThreads(dir);
		assert.equal(threads.length, 1);
		const [thread] = threads;
		assert.ok(thread);
		assert.equal(thread.id, "aaaaaaaa+bbbbbbbb");
		assert.deepEqual(
			thread.participants.map((participant) => participant.label),
			["alice", "bob"],
		);
		assert.equal(thread.firstMs, Date.parse("2026-09-28T12:11:23.882Z"));
		assert.equal(thread.lastMs, Date.parse("2026-09-28T12:11:50.000Z"));
	});
});

test("the timeline merges both children in time order", () => {
	withDir((dir) => {
		writePair(dir);
		const thread = readThread(dir, "aaaaaaaa+bbbbbbbb");
		assert.ok(thread);
		assert.deepEqual(kindsOf(thread.entries), [
			"instruction",
			"instruction",
			"thinking",
			"narration",
			"statement",
			"statement",
		]);
		assert.deepEqual(
			thread.entries
				.filter((entry) => entry.kind === "statement")
				.map((entry) => [entry.text, entry.toLabel, entry.agent]),
			[
				["hello alice", "alice", "bbbbbbbb"],
				["hello bob", "bob", "aaaaaaaa"],
			],
		);
	});
});

test("a delivered message is not repeated next to the sender's statement", () => {
	withDir((dir) => {
		writePair(dir);
		const thread = readThread(dir, "aaaaaaaa+bbbbbbbb");
		assert.ok(thread);
		assert.equal(
			thread.entries.filter((entry) => entry.text === "hello alice").length,
			1,
			"the delivered copy must not appear as an instruction",
		);
		assert.ok(thread.entries.some((entry) => entry.kind === "thinking" && entry.text === "wait first"));
	});
});

test("a delivery header is stripped before matching", () => {
	withDir((dir) => {
		writeChildSession(dir, {
			id: "aaaaaaaa",
			start: "2026-09-28T12:11:23.882Z",
			briefing: "bob (bbbbbbbb)",
			events: [
				{ type: "delivery", at: "2026-09-28T12:11:40.000Z", from: "bbbbbbbb", text: "hello alice" },
				{ type: "assistant", at: "2026-09-28T12:11:50.000Z", send: { to: "bbbbbbbb", text: "hello bob" } },
			],
		});
		writeChildSession(dir, {
			id: "bbbbbbbb",
			start: "2026-09-28T12:11:23.883Z",
			briefing: "alice (aaaaaaaa)",
			events: [{ type: "assistant", at: "2026-09-28T12:11:40.000Z", send: { to: "aaaaaaaa", text: "hello alice" } }],
		});
		const thread = readThread(dir, "aaaaaaaa+bbbbbbbb");
		assert.ok(thread);
		assert.deepEqual(
			thread.entries.filter((entry) => entry.kind === "statement").map((entry) => entry.text),
			["hello alice", "hello bob"],
		);
	});
});

test("a resume round stays in the same thread", () => {
	withDir((dir) => {
		writePair(dir, { resumed: true });
		const threads = listThreads(dir);
		assert.equal(threads.length, 1, "a fresh run id in a briefing must not invent a thread member");
		assert.equal(threads[0]?.participants.length, 2);
		assert.equal(threads[0]?.lastMs, Date.parse("2026-09-28T12:16:30.000Z"));
		const thread = readThread(dir, "aaaaaaaa+bbbbbbbb");
		assert.ok(thread);
		const prompts = thread.entries.filter((entry) => entry.kind === "instruction");
		assert.deepEqual(
			prompts.map((entry) => entry.text),
			["greet each other", "greet each other", "round two"],
		);
		assert.equal(thread.entries.filter((entry) => entry.kind === "statement").length, 3);
	});
});

test("a child that never talked to a sibling is a thread of its own", () => {
	withDir((dir) => {
		writeChildSession(dir, {
			id: "cccccccc",
			start: "2026-09-28T13:00:00.000Z",
			task: "review the draft",
			events: [{ type: "assistant", at: "2026-09-28T13:00:05.000Z", narration: "reviewed" }],
		});
		const threads = listThreads(dir);
		assert.equal(threads.length, 1);
		assert.equal(threads[0]?.id, "cccccccc");
		assert.deepEqual(threads[0]?.participants, [{ id: "cccccccc", label: "cccccccc" }]);
	});
});

test("threads are listed newest first and the limit is applied", () => {
	withDir((dir) => {
		for (const [index, id] of ["aaaaaaaa", "bbbbbbbb", "cccccccc"].entries()) {
			writeChildSession(dir, {
				id,
				start: `2026-09-28T1${index}:00:00.000Z`,
				events: [{ type: "assistant", at: `2026-09-28T1${index}:00:05.000Z`, narration: "done" }],
			});
		}
		assert.deepEqual(
			listThreads(dir).map((thread) => thread.id),
			["cccccccc", "bbbbbbbb", "aaaaaaaa"],
		);
		assert.deepEqual(
			listThreads(dir, 2).map((thread) => thread.id),
			["cccccccc", "bbbbbbbb"],
		);
	});
});

test("unknown files and missing directories read as no threads", () => {
	withDir((dir) => {
		writeFileSync(join(dir, "notes.txt"), "ignore me");
		writeFileSync(join(dir, ".hidden.jsonl"), "{}");
		writeFileSync(join(dir, "no-id.jsonl"), "{}\n");
		assert.deepEqual(listThreads(dir), []);
		assert.deepEqual(listThreads(join(dir, "missing")), []);
		assert.equal(readThread(dir, "aaaaaaaa"), undefined);
	});
});

test("a transcript without a session header still yields a thread", () => {
	withDir((dir) => {
		writeFileSync(
			join(dir, "2026-09-28T14-00-00-000Z_dddddddd.jsonl"),
			`${JSON.stringify({ type: "message", timestamp: "2026-09-28T14:00:01.000Z", message: { role: "user", content: "hi" } })}\n`,
		);
		const threads = listThreads(dir);
		assert.equal(threads.length, 1);
		assert.equal(threads[0]?.firstMs, Date.parse("2026-09-28T14:00:00.000Z"));
		assert.equal(threads[0]?.lastMs, Date.parse("2026-09-28T14:00:01.000Z"));
	});
});

test("a partially written last line does not become the last timestamp", () => {
	withDir((dir) => {
		const path = writeChildSession(dir, {
			id: "eeeeeeee",
			start: "2026-09-28T15:00:00.000Z",
			events: [{ type: "assistant", at: "2026-09-28T15:00:05.000Z", narration: "done" }],
		});
		appendFileSync(path, '{"type":"message","timestamp":"2026-09-28T15:00:09');
		assert.equal(listThreads(dir)[0]?.lastMs, Date.parse("2026-09-28T15:00:05.000Z"));
	});
});

test("a forked child finds its briefing after the inherited conversation", () => {
	withDir((dir) => {
		writeChildSession(dir, {
			id: "ffffffff",
			start: "2026-09-28T16:00:00.000Z",
			parentSession: "/tmp/parent.jsonl",
			events: [
				{
					type: "prompt",
					at: "2026-09-28T16:00:01.000Z",
					text: "Siblings you can message with message_agent: gggggggg (gggggggg)\n\ninherited task",
				},
			],
		});
		writeChildSession(dir, { id: "gggggggg", start: "2026-09-28T16:00:00.001Z", task: "peer" });
		const threads = listThreads(dir);
		assert.equal(threads.length, 1);
		assert.equal(threads[0]?.id, "ffffffff+gggggggg");
	});
});

test("other tool calls become tool entries with a digest", () => {
	withDir((dir) => {
		writeChildSession(dir, {
			id: "hhhhhhhh",
			start: "2026-09-28T17:00:00.000Z",
			events: [
				{ type: "assistant", at: "2026-09-28T17:00:01.000Z", call: { name: "read", args: { path: "/tmp/notes.md" } } },
			],
		});
		const thread = readThread(dir, "hhhhhhhh");
		assert.ok(thread);
		const tool = thread.entries.find((entry) => entry.kind === "tool");
		assert.equal(tool?.summary, "read path=/tmp/notes.md");
		assert.equal(tool?.text, "");
	});
});

test("empty thinking and narration parts produce no entries", () => {
	withDir((dir) => {
		writeChildSession(dir, {
			id: "iiiiiiii",
			start: "2026-09-28T18:00:00.000Z",
			events: [{ type: "assistant", at: "2026-09-28T18:00:01.000Z", thinking: "  ", narration: "\n" }],
		});
		assert.deepEqual(kindsOf(readThread(dir, "iiiiiiii")?.entries ?? []), ["instruction"]);
	});
});

test("a delivery is kept when the sibling transcript has no statement to match", () => {
	withDir((dir) => {
		writeChildSession(dir, {
			id: "jjjjjjjj",
			start: "2026-09-28T19:00:00.000Z",
			briefing: "peer (kkkkkkkk)",
			events: [{ type: "delivery", at: "2026-09-28T19:00:05.000Z", from: "kkkkkkkk", text: "unmatched" }],
		});
		const thread = readThread(dir, "jjjjjjjj");
		assert.ok(thread);
		assert.deepEqual(
			thread.entries.map((entry) => [entry.kind, entry.text]),
			[
				["instruction", "do the task"],
				["instruction", "unmatched"],
			],
		);
	});
});

test("extractBriefing reads both briefing formats and ignores other text", () => {
	assert.deepEqual(extractBriefing("unrelated"), []);
	assert.deepEqual(extractBriefing("Siblings you can message with message_agent: \n\nnothing here"), []);
	assert.deepEqual(
		extractBriefing("Siblings you can message with message_agent: nemu (cccccccc), sakura (dddddddd)\n\ntask"),
		[
			{ id: "cccccccc", label: "nemu" },
			{ id: "dddddddd", label: "sakura" },
		],
	);
	assert.deepEqual(
		extractBriefing(
			'Siblings you can message with message_agent:\n- target_run_id=98e5d8af name="ねむ R2" agent="nemu"\n\n2026/4/1 task',
		),
		[{ id: "98e5d8af", label: "ねむ R2", agent: "nemu" }],
	);
	assert.deepEqual(
		extractBriefing(
			"Siblings you can message with message_agent:\n- target_run_id=unquoted name=plain agent=agent\n\ntask",
		),
		[{ id: "unquoted", label: "plain", agent: "agent" }],
	);
});
