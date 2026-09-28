/**
 * Contract: the page and the code that drives it stay in sync.
 *
 * There is no browser in the test environment, so this pins the failure mode
 * that would otherwise reach the user: a `getElementById` that names no element
 * renders an empty page. It also keeps the rendering path text-only, because
 * every string on the page comes from model output.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE = readFileSync(fileURLToPath(new URL("../../src/web/index.html", import.meta.url)), "utf8");

test("every element the script looks up exists in the markup", () => {
	const ids = [...PAGE.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]);
	assert.ok(ids.length > 0, "the page must look up its elements by id");
	for (const id of ids) {
		assert.match(PAGE, new RegExp(`id="${id}"`), `id ${id} is missing from the markup`);
	}
});

test("the toggles, the status line, and their styles exist", () => {
	for (const marker of ['id="reasoning"', 'id="tools"', 'id="status"', ".show-reasoning", ".show-tools"]) {
		assert.ok(PAGE.includes(marker), `${marker} is missing from the page`);
	}
});

test("rendered text never goes through innerHTML", () => {
	assert.ok(!PAGE.includes("innerHTML"), "model output must be inserted as text nodes");
});

test("the page asks only the two read-only endpoints", () => {
	const paths = [...PAGE.matchAll(/["`](\/api\/[^"`$]*)/g)].map((match) => match[1]);
	assert.deepEqual([...new Set(paths)].sort(), ["/api/thread/", "/api/threads"]);
});
