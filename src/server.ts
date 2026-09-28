/**
 * The local view server.
 *
 * Read-only and loopback-only. It answers three requests — the page, the thread
 * list, and one timeline — and writes nothing, so a leaked port cannot corrupt
 * a transcript or reach outside the machine. The page polls these endpoints;
 * the server keeps no state between requests, which is what makes a running
 * spawn visible without touching pi-spawn itself.
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { listThreads, readThread, THREAD_LIMIT } from "./transcript.ts";

/** Any interface other than loopback would expose transcripts to the network. */
const LOOPBACK = "127.0.0.1";

const PAGE_PATH = fileURLToPath(new URL("./web/index.html", import.meta.url));

export interface ViewServerOptions {
	/** Directory holding pi-spawn child transcripts. */
	dir: string;
	port: number;
}

export interface ViewServer {
	url: string;
	port: number;
	/** Stop accepting connections; safe to call more than once. */
	close(): Promise<void>;
}

/** Bind the view server. Rejects with a usable message when the port is taken. */
export async function startViewServer(options: ViewServerOptions): Promise<ViewServer> {
	const server = createServer((request, response) => {
		try {
			route(request, response, options.dir);
		} catch (error) {
			sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	});
	await listen(server, options.port);
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : options.port;
	return {
		url: `http://${LOOPBACK}:${port}`,
		port,
		close: () => close(server),
	};
}

function route(request: IncomingMessage, response: ServerResponse, dir: string): void {
	if (request.method !== "GET") {
		sendJson(response, 405, { error: "this view is read-only" });
		return;
	}
	const url = new URL(request.url ?? "/", `http://${LOOPBACK}`);
	if (url.pathname === "/") {
		sendPage(response);
		return;
	}
	if (url.pathname === "/favicon.ico") {
		sendEmpty(response);
		return;
	}
	if (url.pathname === "/api/threads") {
		sendJson(response, 200, { dir, threads: listThreads(dir, limitOf(url)) });
		return;
	}
	if (url.pathname.startsWith("/api/thread/")) {
		const id = decodeURIComponent(url.pathname.slice("/api/thread/".length));
		const thread = readThread(dir, id);
		if (thread === undefined) sendJson(response, 404, { error: `unknown thread '${id}'` });
		else sendJson(response, 200, thread);
		return;
	}
	sendJson(response, 404, { error: "not found" });
}

function limitOf(url: URL): number {
	const requested = Number(url.searchParams.get("limit") ?? "");
	return Number.isInteger(requested) && requested > 0 ? Math.min(requested, 1000) : THREAD_LIMIT;
}

function sendPage(response: ServerResponse): void {
	const page = readFileSync(PAGE_PATH);
	response.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"content-length": page.byteLength,
		"cache-control": "no-cache",
	});
	response.end(page);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
	const body = JSON.stringify(payload);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
	});
	response.end(body);
}

function sendEmpty(response: ServerResponse): void {
	response.writeHead(204, { "cache-control": "no-store" });
	response.end();
}

function listen(server: Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		server.on("error", (error: NodeJS.ErrnoException) => {
			if (server.listening) return;
			reject(
				error.code === "EADDRINUSE"
					? new Error(`port ${port} is already in use; set another port in chat-view.json`)
					: error,
			);
		});
		server.listen(port, LOOPBACK, () => resolve());
	});
}

function close(server: Server): Promise<void> {
	// Long-lived keep-alive sockets would otherwise hold the process open.
	server.closeAllConnections();
	return new Promise((resolve) => server.close(() => resolve()));
}
