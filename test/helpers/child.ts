/**
 * Fixture writer for pi-spawn child transcripts.
 *
 * The files mirror the real shape (session header, system message, briefing
 * prefixed to the first user message, assistant messages with thinking/text/
 * toolCall parts, deliveries as user messages) so the reader is exercised
 * against the format it will meet on disk. Text is neutral: the repository is
 * public and the shape is what matters, not the prose.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ChildEvent =
	| {
			type: "assistant";
			at: string;
			thinking?: string;
			narration?: string;
			/** A `message_agent` call. The peer's delivery is a separate event. */
			send?: { to: string; text: string };
			/** Any other tool call. */
			call?: { name: string; args: Record<string, unknown> };
	  }
	/** A message copied from the parent's session, as `inheritConversation` writes it. */
	| { type: "inherited"; at: string; id: string; role: "user" | "assistant"; text: string }
	| { type: "delivery"; at: string; from: string; text: string; labelled?: boolean }
	| { type: "prompt"; at: string; text: string }
	| { type: "compaction"; at: string };

export interface ChildScript {
	/** Session id, also the run id of the run that created the file. */
	id: string;
	/** ISO timestamp of the session header; also names the file. */
	start: string;
	cwd?: string;
	/** Set for a child that inherited the parent's conversation. */
	parentSession?: string;
	/** Text after `Siblings you can message with message_agent: `, if any. */
	briefing?: string;
	task?: string;
	events?: ChildEvent[];
}

export function writeChildSession(dir: string, script: ChildScript): string {
	const path = join(dir, `${stampOf(script.start)}_${script.id}.jsonl`);
	const setup: unknown[] = [
		{
			type: "session",
			version: 3,
			id: script.id,
			timestamp: script.start,
			cwd: script.cwd ?? "/tmp/project",
			...(script.parentSession === undefined ? {} : { parentSession: script.parentSession }),
		},
		{ type: "model_change", provider: "test", modelId: "test-model", timestamp: script.start },
		{ type: "thinking_level_change", thinkingLevel: "low", timestamp: script.start },
		messageEntry(script.start, "system", "", "sys"),
	];
	const events = (script.events ?? []).flatMap((event, index) => eventEntries(event, index));
	// A forked child copies the parent's history first, so its own task comes after it.
	const taskAt = script.parentSession === undefined ? 0 : lastInheritedIndex(script.events ?? []) + 1;
	const entries = [
		...setup,
		...events.slice(0, taskAt),
		messageEntry(script.start, "user", briefingText(script), "task"),
		...events.slice(taskAt),
	];
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

/** Index of the last inherited event, or -1 when there is none. */
function lastInheritedIndex(events: readonly ChildEvent[]): number {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		if (events[index]?.type === "inherited") return index;
	}
	return -1;
}

/** Write the parent session a forked child copies its history from. */
export function writeParentSession(path: string, ids: readonly string[]): void {
	const entries: unknown[] = [
		{ type: "session", version: 3, id: "parent-1", timestamp: "2026-09-28T00:00:00.000Z", cwd: "/tmp/project" },
		...ids.map((id, index) => ({
			type: "message",
			id,
			parentId: null,
			timestamp: new Date(Date.parse("2026-09-28T00:00:01.000Z") + index).toISOString(),
			message: { role: index % 2 === 0 ? "user" : "assistant", content: `parent message ${id}` },
		})),
	];
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

/** The text a child's first user message carries: briefing, then the task. */
export function briefingText(script: ChildScript): string {
	const prefix =
		script.briefing === undefined ? "" : `Siblings you can message with message_agent: ${script.briefing}\n\n`;
	return `${prefix}${script.task ?? "do the task"}`;
}

/** The file name pi-spawn derives from a session timestamp. */
export function stampOf(start: string): string {
	return start.replace(/[:.]/g, "-");
}

function eventEntries(event: ChildEvent, index: number): unknown[] {
	const id = `e${index}`;
	if (event.type === "prompt") return [messageEntry(event.at, "user", event.text, id)];
	if (event.type === "compaction") return [{ type: "compaction", id, parentId: null, timestamp: event.at }];
	if (event.type === "inherited") {
		return [
			{
				type: "message",
				id: event.id,
				parentId: null,
				timestamp: event.at,
				message: { role: event.role, content: event.text, timestamp: Date.parse(event.at) },
			},
		];
	}
	if (event.type === "delivery") return [messageEntry(event.at, "user", deliveryText(event), id)];
	return assistantEntries(event, id);
}

function deliveryText(event: Extract<ChildEvent, { type: "delivery" }>): string {
	return event.labelled === false ? event.text : `message_agent from_run_id=${event.from} name="peer"\n\n${event.text}`;
}

function assistantEntries(event: Extract<ChildEvent, { type: "assistant" }>, id: string): unknown[] {
	const content: unknown[] = [];
	if (event.thinking !== undefined) content.push({ type: "thinking", thinking: event.thinking });
	if (event.narration !== undefined) content.push({ type: "text", text: event.narration });
	if (event.send !== undefined) {
		content.push({
			type: "toolCall",
			id: `${id}-call`,
			name: "message_agent",
			arguments: { target_run_id: event.send.to, text: event.send.text },
		});
	}
	if (event.call !== undefined) {
		content.push({ type: "toolCall", id: `${id}-call`, name: event.call.name, arguments: event.call.args });
	}
	const entries: unknown[] = [
		{
			type: "message",
			id,
			parentId: null,
			timestamp: event.at,
			message: {
				role: "assistant",
				content,
				provider: "test",
				model: "test-model",
				stopReason: event.send !== undefined || event.call !== undefined ? "toolUse" : "stop",
				timestamp: Date.parse(event.at),
			},
		},
	];
	if (event.send !== undefined || event.call !== undefined) {
		entries.push({
			type: "message",
			id: `${id}-result`,
			parentId: id,
			timestamp: event.at,
			message: {
				role: "toolResult",
				toolCallId: `${id}-call`,
				toolName: event.send !== undefined ? "message_agent" : (event.call?.name ?? "tool"),
				content: [{ type: "text", text: "delivered" }],
				isError: false,
				timestamp: Date.parse(event.at),
			},
		});
	}
	return entries;
}

function messageEntry(at: string, role: string, text: string, id: string): unknown {
	const content = role === "assistant" || role === "system" ? [{ type: "text", text }] : text;
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: at,
		message: { role, content, timestamp: Date.parse(at) },
	};
}
