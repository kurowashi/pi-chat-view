/**
 * Reading pi-spawn child transcripts.
 *
 * The view owns no state: every answer is derived from the JSONL files that
 * pi-spawn already writes under `<agentDir>/spawn-sessions`. A child transcript
 * is append-only, and one file keeps growing across `resume_run_id` rounds, so
 * a conversation that spans several rounds stays in one thread.
 *
 * Threads are discovered without the parent session: each child's first user
 * message starts with the sibling briefing, which names every peer of the same
 * spawn call. Following those references joins exactly the runs that could talk
 * to each other. Run ids are deliberately not used for lookup, because a
 * resumed run gets a fresh run id while its transcript keeps the original
 * session id.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Threads listed by default; the rest stay reachable by id. */
export const THREAD_LIMIT = 100;

/** Bytes read per chunk while streaming a transcript. */
const CHUNK_BYTES = 64 * 1024;

/** Smaller chunks for the header scan, which stops in the first lines of a file. */
const HEAD_CHUNK_BYTES = 8 * 1024;

/** Bytes read from the end of a transcript to find its last timestamp. */
const TAIL_BYTES = 8 * 1024;

/** Upper bound on the header scan, so one broken file cannot stall a list request. */
const MAX_HEAD_LINES = 200;
/** The sibling list pi-spawn prepends to a child's task. */
const BRIEFING_MARKER = "Siblings you can message with message_agent:";

/** The header pi-spawn puts in front of a delivered message. */
const DELIVERY_HEADER = /^message_agent from_run_id=\S+ name=(?:"(?:[^"\\]|\\.)*"|[^\n]+)\n\n/;

/** What one timeline line is: sibling speech, the agent's prose, its reasoning, a task, or a tool call. */
export type EntryKind = "statement" | "narration" | "thinking" | "instruction" | "tool";

/** One agent's display identity inside a thread. */
export interface Participant {
	/** Session id, which is the run id of the run that created the file. */
	id: string;
	label: string;
	agent?: string;
}

/** A peer named by a sibling briefing. */
export interface SiblingRef {
	id: string;
	label: string;
	agent?: string;
}

/** One child transcript file. */
export interface ChildFile {
	id: string;
	path: string;
	createdMs: number;
	lastMs: number;
	refs: SiblingRef[];
	/**
	 * Index of the first message this run wrote.
	 *
	 * A child that inherited its parent's conversation (`inheritConversation`) owns
	 * a copy of that history in its own file; those messages came from the parent
	 * session and are not part of the child conversation. Zero when nothing was
	 * inherited, or when the boundary could not be established.
	 */
	ownFrom: number;
}

export interface ThreadSummary {
	/** Joined file ids, e.g. `47aac6be+f83c6332`. Stable across rounds. */
	id: string;
	participants: Participant[];
	firstMs: number;
	lastMs: number;
}

/** One line of the merged timeline. */
export interface TimelineEntry {
	kind: EntryKind;
	ts: number;
	/** Participant id of the file this entry came from. */
	agent: string;
	text: string;
	/** Recipient of a statement, when the briefing names it. */
	toLabel?: string;
	/** One-line digest for a `tool` entry. */
	summary?: string;
}

export interface ThreadTimeline {
	id: string;
	participants: Participant[];
	entries: TimelineEntry[];
}

/** Newest threads first. A missing directory reads as "no threads yet". */
export function listThreads(dir: string, limit: number = THREAD_LIMIT): ThreadSummary[] {
	return buildThreads(scanSpawnDir(dir))
		.map(summarize)
		.sort((left, right) => right.lastMs - left.lastMs)
		.slice(0, limit);
}

/** The merged timeline of one thread, or undefined when the id names no files. */
export function readThread(dir: string, id: string): ThreadTimeline | undefined {
	const thread = buildThreads(scanSpawnDir(dir)).find((candidate) => candidate.id === id);
	if (thread === undefined) return undefined;
	const labels = referenceLabels(thread.files);
	const parsed = thread.files.map((file) => ({ file, messages: parseMessages(file.path).slice(file.ownFrom) }));
	const outbound = outboundTexts(parsed);
	const entries = parsed
		.flatMap(({ file, messages }, fileIndex) =>
			filterDeliveries(messages, outbound).flatMap((message, messageIndex) =>
				messageEntries(message, file, labels).map((entry) => ({ entry, fileIndex, messageIndex })),
			),
		)
		.sort((left, right) => comparePlacement(left, right))
		.map((placed) => placed.entry);
	return { id: thread.id, participants: thread.participants, entries };
}

/** A quoted JSON string or a bare token, as a briefing value. */
const BRIEFING_VALUE = '(?:"(?:[^"\\\\]|\\\\.)*"|\\S+)';

/** The briefing block: `- target_run_id=<id> name=<label> agent=<agent>` per peer. */
const KEYED_BRIEFING = new RegExp(
	`- target_run_id=(\\S+)\\s+name=(${BRIEFING_VALUE})\\s+agent=(${BRIEFING_VALUE})`,
	"g",
);

/** Parse the sibling list out of a child's first user message. */
export function extractBriefing(text: string): SiblingRef[] {
	if (!text.startsWith(BRIEFING_MARKER)) return [];
	const block = text.slice(BRIEFING_MARKER.length).split("\n\n")[0] ?? "";
	const keyed = [...block.matchAll(KEYED_BRIEFING)];
	if (keyed.length > 0) {
		return keyed.map((match) => {
			const id = match[1] ?? "";
			const label = unquote(match[2] ?? "");
			const agent = unquote(match[3] ?? "");
			return { id, label: label.length > 0 ? label : id, agent };
		});
	}
	const legacy = [...(block.split("\n")[0] ?? "").matchAll(/(?:^|,\s*)([^,()]+?)\s*\(([0-9a-zA-Z-]{4,})\)/g)];
	return legacy.map((match) => ({ id: match[2] ?? "", label: (match[1] ?? "").trim() }));
}

/* ------------------------------------------------------------------ */
/* Scan                                                                */
/* ------------------------------------------------------------------ */

interface ScannedThread {
	id: string;
	files: ChildFile[];
	participants: Participant[];
}

interface PlacedEntry {
	entry: TimelineEntry;
	fileIndex: number;
	messageIndex: number;
}

function scanSpawnDir(dir: string): ChildFile[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const files: ChildFile[] = [];
	const parents: ParentIds = new Map();
	for (const name of names) {
		const id = fileIdOf(name);
		if (id === undefined) continue;
		try {
			const file = scanChildFile(join(dir, name), id, parents);
			if (file !== undefined) files.push(file);
		} catch {
			// A file can vanish between readdir and open; the next scan picks up the truth.
		}
	}
	return files;
}

/** The session id a spawn-session file name carries, or undefined for other files. */
function fileIdOf(name: string): string | undefined {
	if (!name.endsWith(".jsonl") || name.startsWith(".")) return undefined;
	const stem = name.slice(0, -".jsonl".length);
	const separator = stem.lastIndexOf("_");
	if (separator <= 0) return undefined;
	const id = stem.slice(separator + 1);
	return /^[0-9a-zA-Z-]{4,}$/.test(id) ? id : undefined;
}

/**
 * Read only the head and the tail of a transcript: the session header and the
 * sibling briefing are in the first lines, and the last timestamp is in the last
 * line. The body is read in full only when a thread is opened.
 */
function scanChildFile(path: string, id: string, parents: ParentIds): ChildFile | undefined {
	const stat = statSync(path);
	const head = scanHead(path, parents);
	const createdMs = head.createdMs ?? timestampFromName(path) ?? stat.mtimeMs;
	return {
		id,
		path,
		createdMs,
		lastMs: readTailTimestamp(path, stat.size),
		refs: head.refs,
		ownFrom: head.ownFrom,
	};
}

/** Entry ids per session file, so a forked prefix can be told apart from own messages. */
type ParentIds = Map<string, Set<string> | undefined>;

interface HeadScan {
	createdMs: number | undefined;
	refs: SiblingRef[];
	ownFrom: number;
}

/** The session header, the sibling briefing, and where this run's own messages start. */
function scanHead(path: string, parents: ParentIds): HeadScan {
	const state: HeadState = { refs: [], ownFrom: -1, messages: 0, lines: 0 };
	forEachLine(path, (line) => scanHeadLine(state, line, parents), HEAD_CHUNK_BYTES);
	return { createdMs: state.createdMs, refs: state.refs, ownFrom: Math.max(state.ownFrom, 0) };
}

interface HeadState {
	createdMs?: number | undefined;
	refs: SiblingRef[];
	parentPath?: string | undefined;
	ownFrom: number;
	messages: number;
	lines: number;
}

/** One line of the header scan; returns false to stop reading. */
function scanHeadLine(state: HeadState, line: string, parents: ParentIds): boolean {
	const entry = asRecord(parseJson(line));
	if (entry === undefined) return countScannedLine(state);
	if (entry["type"] === "session") {
		state.createdMs = finiteMs(Date.parse(String(entry["timestamp"] ?? "")));
		state.parentPath = typeof entry["parentSession"] === "string" ? entry["parentSession"] : undefined;
		return true;
	}
	if (entry["type"] !== "message") return true;
	// The render path keeps only well-formed messages, so the scan counts only those:
	// `ownFrom` is an index into that same list.
	const message = asRecord(entry["message"]);
	if (message === undefined || typeof message["role"] !== "string") return true;
	// A forked prefix can be arbitrarily long and proves nothing about this file.
	if (isInherited(state, entry, parents)) {
		state.messages += 1;
		return true;
	}
	// A system message is prompt plumbing, not conversation: the run's own messages start later.
	if (state.ownFrom < 0 && message["role"] !== "system") state.ownFrom = state.messages;
	state.messages += 1;
	if (!countScannedLine(state)) return false;
	return !taskPromptStops(state, message, parents);
}

/** Budget for how much of a file the scan reads before it gives up. */
function countScannedLine(state: HeadState): boolean {
	state.lines += 1;
	return state.lines < MAX_HEAD_LINES;
}

function isInherited(state: HeadState, entry: Record<string, unknown>, parents: ParentIds): boolean {
	return state.parentPath !== undefined && readEntryIds(state.parentPath, parents)?.has(String(entry["id"])) === true;
}

/**
 * Record the sibling briefing when this line is a task prompt.
 *
 * The first user message a run wrote is its task, so its briefing cannot come
 * later. Only a child whose parent file is gone has no provable boundary and
 * keeps looking; for it the briefing may sit behind an inherited prefix.
 */
function taskPromptStops(state: HeadState, message: Record<string, unknown>, parents: ParentIds): boolean {
	if (message["role"] !== "user") return false;
	const briefing = extractBriefing(textOf(message["content"]));
	if (briefing.length > 0) {
		state.refs = briefing;
		return true;
	}
	return state.parentPath === undefined || readEntryIds(state.parentPath, parents) !== undefined;
}

/**
 * The entry ids a session file contains.
 *
 * Undefined when the file cannot be read: the fork boundary is then unknown and
 * the child is read best-effort instead of failing.
 */
function readEntryIds(path: string, cache: ParentIds): Set<string> | undefined {
	if (cache.has(path)) return cache.get(path);
	let ids: Set<string> | undefined;
	try {
		const found = new Set<string>();
		forEachLine(path, (line) => {
			const entry = asRecord(parseJson(line));
			if (typeof entry?.["id"] === "string") found.add(entry["id"]);
			return true;
		});
		ids = found;
	} catch {
		ids = undefined;
	}
	cache.set(path, ids);
	return ids;
}

function readTailTimestamp(path: string, size: number): number {
	if (size === 0) return 0;
	const length = Math.min(size, TAIL_BYTES);
	const buffer = Buffer.allocUnsafe(length);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buffer, 0, length, size - length);
	} finally {
		closeSync(fd);
	}
	const lines = buffer.toString("utf8").split("\n");
	// The first line is cut mid-way unless the whole file fit in the buffer.
	if (size > length) lines.shift();
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const entry = asRecord(parseJson(lines[index] ?? ""));
		const ts = entry === undefined ? undefined : finiteMs(Date.parse(String(entry["timestamp"] ?? "")));
		if (ts !== undefined) return ts;
	}
	return 0;
}

/** Stream a file line by line; the visitor returns false to stop early. */
function forEachLine(path: string, visit: (line: string) => boolean, chunkBytes: number = CHUNK_BYTES): void {
	const fd = openSync(path, "r");
	const decoder = new StringDecoder("utf8");
	const buffer = Buffer.allocUnsafe(chunkBytes);
	let carry = "";
	try {
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, null);
			if (read <= 0) break;
			const lines = (carry + decoder.write(buffer.subarray(0, read))).split("\n");
			carry = lines.pop() ?? "";
			for (const line of lines) if (!visit(line)) return;
		}
		carry += decoder.end();
		if (carry.length > 0) visit(carry);
	} finally {
		closeSync(fd);
	}
}

/* ------------------------------------------------------------------ */
/* Threads                                                             */
/* ------------------------------------------------------------------ */

/**
 * Join child files into threads by following sibling references.
 *
 * Only ids that name a scanned file become edges: a briefing may name a run id
 * from before a resume, and such a reference must not invent a thread member.
 * Files created in the same spawn call reference each other, so each call is one
 * component; a resume appends to the same file and keeps the component.
 */
function buildThreads(files: readonly ChildFile[]): ScannedThread[] {
	const known = new Set(files.map((file) => file.id));
	const neighbours = new Map<string, Set<string>>(files.map((file) => [file.id, new Set<string>()]));
	for (const file of files) {
		for (const ref of file.refs) {
			if (ref.id === file.id || !known.has(ref.id)) continue;
			neighbours.get(file.id)?.add(ref.id);
			neighbours.get(ref.id)?.add(file.id);
		}
	}
	const threads: ScannedThread[] = [];
	const visited = new Set<string>();
	for (const file of files) {
		if (visited.has(file.id)) continue;
		const component = collectComponent(file.id, neighbours, visited);
		const members = component.map((id) => files.find((candidate) => candidate.id === id)).filter(isFile);
		threads.push({
			id: [...component].sort().join("+"),
			files: members.sort((left, right) => left.createdMs - right.createdMs),
			participants: participantsOf(members),
		});
	}
	return threads;
}

/** The labels every sibling briefing in the thread attaches to a file id. */
function referenceLabels(files: readonly ChildFile[]): Map<string, string> {
	const labels = new Map<string, string>();
	for (const file of files) {
		for (const ref of file.refs) setIfAbsent(labels, ref.id, ref.label);
	}
	// An id no briefing named stays visible as itself, after the names are in.
	for (const file of files) setIfAbsent(labels, file.id, file.id);
	return labels;
}

function summarize(thread: ScannedThread): ThreadSummary {
	return {
		id: thread.id,
		participants: thread.participants,
		firstMs: Math.min(...thread.files.map((file) => file.createdMs)),
		lastMs: Math.max(...thread.files.map((file) => file.lastMs)),
	};
}

function collectComponent(start: string, neighbours: Map<string, Set<string>>, visited: Set<string>): string[] {
	const component: string[] = [];
	const queue = [start];
	visited.add(start);
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) break;
		component.push(current);
		for (const next of neighbours.get(current) ?? []) {
			if (visited.has(next)) continue;
			visited.add(next);
			queue.push(next);
		}
	}
	return component;
}

function participantsOf(files: readonly ChildFile[]): Participant[] {
	return files.map((file) => {
		const named = files.flatMap((peer) => peer.refs).find((ref) => ref.id === file.id);
		return {
			id: file.id,
			label: named?.label ?? file.id,
			...(named?.agent === undefined ? {} : { agent: named.agent }),
		};
	});
}

/* ------------------------------------------------------------------ */
/* Timeline                                                            */
/* ------------------------------------------------------------------ */

interface ParsedMessage {
	role: string;
	ts: number;
	content: unknown;
}

function parseMessages(path: string): ParsedMessage[] {
	const messages: ParsedMessage[] = [];
	forEachLine(path, (line) => {
		const entry = asRecord(parseJson(line));
		if (entry?.["type"] !== "message") return true;
		const message = asRecord(entry["message"]);
		if (message === undefined) return true;
		const role = message["role"];
		if (typeof role !== "string") return true;
		messages.push({
			role,
			ts: finiteMs(Date.parse(String(entry["timestamp"] ?? ""))) ?? finiteMs(Number(message["timestamp"])) ?? 0,
			content: message["content"],
		});
		return true;
	});
	return messages;
}

/**
 * Drop the copies of sibling messages.
 *
 * pi-spawn delivers a message as a user turn, so the receiver's transcript
 * repeats text the sender already recorded. The sender's `message_agent` call is
 * the single source: it carries the recipient and the same text.
 */
function filterDeliveries(messages: readonly ParsedMessage[], outbound: ReadonlySet<string>): ParsedMessage[] {
	const firstUserIndex = messages.findIndex((message) => message.role === "user");
	return messages.filter((message, index) => {
		if (message.role !== "user" || index === firstUserIndex) return true;
		if (outbound.size === 0) return true;
		const text = textOf(message.content);
		return !outbound.has(text) && !outbound.has(stripDeliveryHeader(text));
	});
}

function outboundTexts(parsed: readonly { messages: readonly ParsedMessage[] }[]): Set<string> {
	const texts = parsed
		.flatMap(({ messages }) => messages)
		.flatMap((message) => contentParts(message.content))
		.filter((part) => part["type"] === "toolCall" && part["name"] === "message_agent")
		.map((part) => textOf(asRecord(part["arguments"])?.["text"]))
		.filter((text) => text.length > 0);
	return new Set(texts);
}

function messageEntries(message: ParsedMessage, file: ChildFile, labels: ReadonlyMap<string, string>): TimelineEntry[] {
	const base = { ts: message.ts, agent: file.id };
	if (message.role === "user") {
		return [{ ...base, kind: "instruction", text: stripBriefing(stripDeliveryHeader(textOf(message.content))) }];
	}
	if (message.role !== "assistant") return [];
	return contentParts(message.content).flatMap((part) => partEntries(part, base, labels));
}

/** Classify one assistant content block. Unknown blocks are ignored, not guessed at. */
function partEntries(
	part: Record<string, unknown>,
	base: { ts: number; agent: string },
	labels: ReadonlyMap<string, string>,
): TimelineEntry[] {
	const kind = part["type"];
	if (kind === "thinking" || kind === "reasoning")
		return textEntry(part["thinking"] ?? part["reasoning"], "thinking", base);
	if (kind === "text") return textEntry(part["text"], "narration", base);
	if (kind === "toolCall") return [toolEntry(part, base, labels)];
	return [];
}

function textEntry(
	value: unknown,
	kind: "thinking" | "narration",
	base: { ts: number; agent: string },
): TimelineEntry[] {
	const text = textOf(value);
	return text.trim().length > 0 ? [{ ...base, kind, text }] : [];
}

function toolEntry(
	part: Record<string, unknown>,
	base: { ts: number; agent: string },
	labels: ReadonlyMap<string, string>,
): TimelineEntry {
	const args = asRecord(part["arguments"]) ?? {};
	const name = typeof part["name"] === "string" ? part["name"] : "tool";
	if (name !== "message_agent") {
		return { ...base, kind: "tool", text: "", summary: `${name} ${digest(args)}` };
	}
	const target = typeof args["target_run_id"] === "string" ? args["target_run_id"] : String(args["to"] ?? "");
	const toLabel = labels.get(target);
	return {
		...base,
		kind: "statement",
		text: textOf(args["text"]),
		...(toLabel === undefined ? {} : { toLabel }),
	};
}

function comparePlacement(left: PlacedEntry, right: PlacedEntry): number {
	if (left.entry.ts !== right.entry.ts) return left.entry.ts - right.entry.ts;
	if (left.fileIndex !== right.fileIndex) return left.fileIndex - right.fileIndex;
	return left.messageIndex - right.messageIndex;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function parseJson(line: string): unknown {
	const trimmed = line.trim();
	if (trimmed.length === 0) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function contentParts(content: unknown): Record<string, unknown>[] {
	if (!Array.isArray(content)) return [];
	return content.map(asRecord).filter((part): part is Record<string, unknown> => part !== undefined);
}

/** Message content as text: a plain string, or the text parts of a block list. */
function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map((part) => textOf(asRecord(part)?.["text"])).join("\n");
	const record = asRecord(value);
	return record === undefined ? "" : textOf(record["text"]);
}

function stripDeliveryHeader(text: string): string {
	return text.replace(DELIVERY_HEADER, "");
}

/**
 * Drop the sibling briefing in front of a task.
 *
 * The briefing is how a child learns its peers; the view already shows the
 * thread's members, so repeating the machine-readable list in the timeline is
 * noise. Everything after the blank line is the task the parent actually wrote.
 */
function stripBriefing(text: string): string {
	if (!text.startsWith(BRIEFING_MARKER)) return text;
	return text.slice(BRIEFING_MARKER.length).split("\n\n").slice(1).join("\n\n");
}

/** A short, single-line digest of a tool call's arguments. */
function digest(args: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string") parts.push(`${key}=${value.split("\n")[0] ?? ""}`);
	}
	const joined = parts.join(" ");
	return joined.length > 80 ? `${joined.slice(0, 80)}...` : joined;
}

function unquote(token: string): string {
	try {
		const parsed: unknown = JSON.parse(token);
		return typeof parsed === "string" ? parsed : token;
	} catch {
		return token.replace(/^"|"$/g, "");
	}
}

function finiteMs(value: number): number | undefined {
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

function timestampFromName(path: string): number | undefined {
	const stamp = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(path);
	if (stamp === null) return undefined;
	return finiteMs(Date.parse(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}.${stamp[5]}Z`));
}

function isFile(file: ChildFile | undefined): file is ChildFile {
	return file !== undefined;
}

function setIfAbsent(map: Map<string, string>, key: string, value: string): void {
	if (!map.has(key)) map.set(key, value);
}
