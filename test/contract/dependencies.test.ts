/**
 * Contract: the dependency allowance and the import boundary.
 *
 * A Pi extension runs inside the user's agent process, so every runtime
 * dependency is paid for by the user and every stray import is a new supply
 * chain. Both are pinned here instead of being left to review.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Pi supplies these to extensions; anything else must be justified in an ADR. */
const ALLOWED_PEER_DEPENDENCIES = new Set(["@earendil-works/pi-coding-agent"]);

/** Development tooling allowlist. Adding one is a decision, not an accident. */
const ALLOWED_DEV_DEPENDENCIES = new Set([
	"@biomejs/biome",
	"@earendil-works/pi-coding-agent",
	"@types/node",
	"knip",
	"lefthook",
	"typescript",
]);

interface Manifest {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as Manifest;

test("ships no runtime dependencies", () => {
	assert.deepEqual(manifest.dependencies ?? {}, {}, "runtime dependencies must stay empty");
});

test("every dev dependency is on the allowlist", () => {
	for (const name of Object.keys(manifest.devDependencies ?? {})) {
		assert.ok(ALLOWED_DEV_DEPENDENCIES.has(name), `dev dependency ${name} is not allowlisted`);
	}
});

test("every peer dependency is supplied by Pi", () => {
	for (const name of Object.keys(manifest.peerDependencies ?? {})) {
		assert.ok(ALLOWED_PEER_DEPENDENCIES.has(name), `peer dependency ${name} is not supplied by Pi`);
	}
});

test("source imports only node builtins, relative files, and Pi-provided packages", () => {
	const offenders: string[] = [];
	for (const file of listSourceFiles(join(PACKAGE_ROOT, "src"))) {
		for (const specifier of extractImportSpecifiers(readFileSync(file, "utf8"))) {
			if (isAllowedSpecifier(specifier)) continue;
			offenders.push(`${file.replace(PACKAGE_ROOT, ".")}: ${specifier}`);
		}
	}
	assert.deepEqual(offenders, [], "imports must resolve from the Pi-provided packages or a relative .ts file");
});

function isAllowedSpecifier(specifier: string): boolean {
	if (specifier.startsWith("node:")) return true;
	if (specifier.startsWith(".")) return specifier.endsWith(".ts");
	const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
	return packageName !== undefined && ALLOWED_PEER_DEPENDENCIES.has(packageName);
}

function extractImportSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	for (const match of source.matchAll(/(?:from|import)\s+"([^"]+)"/g)) {
		const specifier = match[1];
		if (specifier !== undefined) specifiers.push(specifier);
	}
	return specifiers;
}

function listSourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => join(entry.parentPath, entry.name));
}
