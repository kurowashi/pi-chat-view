/**
 * Contract: the extension's surface and its context cost.
 *
 * pi-chat-view is a viewer. It must add a command and nothing else that Pi
 * tracks: no tools (which would be re-sent every request), and no work at load
 * time (Pi loads extensions in modes that never start a session). The assertion
 * on `session_start` is what keeps the server from becoming a hidden background
 * listener.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { COMMAND_DESCRIPTION } from "../../src/command.ts";
import chatViewExtension from "../../src/index.ts";
import { harness } from "../helpers/harness.ts";

/** Command descriptions appear in the palette; keep them readable, not essays. */
const MAX_DESCRIPTION_CHARS = 160;

test("the extension registers one command and no tools", () => {
	const h = harness(chatViewExtension);
	assert.deepEqual([...h.commands.keys()], ["chat-view"]);
	assert.equal(h.commands.get("chat-view")?.description, COMMAND_DESCRIPTION);
	assert.ok(COMMAND_DESCRIPTION.length <= MAX_DESCRIPTION_CHARS);
});

test("only session shutdown is hooked", () => {
	const h = harness(chatViewExtension);
	assert.deepEqual([...h.events.keys()], ["session_shutdown"]);
});

test("loading the extension starts nothing and says nothing", () => {
	const h = harness(chatViewExtension);
	assert.deepEqual(h.notifications, []);
});
