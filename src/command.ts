/**
 * The /chat-view command.
 *
 * The server is started by the user, never by loading the extension: Pi loads
 * extensions in modes that have no session (and no port to spare), and an
 * implicit listener would be a hidden background process. The command is also
 * the stop switch, and session shutdown closes the socket no matter what the
 * user did in between.
 *
 * A start takes a moment, so the session tracks the start in flight as well as
 * the running server. Stop and shutdown wait the start out and then close what
 * it produced, which is what makes them meet in the same idempotent path.
 */

import { join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readViewConfig } from "./config.ts";
import { startViewServer, type ViewServer, type ViewServerOptions } from "./server.ts";

export const COMMAND_DESCRIPTION = "Start the pi-chat-view web server (/chat-view stop to stop it)";

/** pi-spawn writes its child transcripts here, next to the Pi agent directory. */
export const SPAWN_SESSIONS = "spawn-sessions";

export const USAGE = "usage: /chat-view [stop]";

type Starter = (options: ViewServerOptions) => Promise<ViewServer>;

export interface ChatViewSession {
	run(args: string, ctx: ExtensionCommandContext): Promise<void>;
	/** Idempotent: session shutdown and the command can both converge here. */
	stop(): Promise<void>;
}

export function createChatViewSession(start: Starter = startViewServer): ChatViewSession {
	let server: ViewServer | undefined;
	let pending: Promise<void> | undefined;

	async function close(): Promise<void> {
		await pending;
		const running = server;
		server = undefined;
		await running?.close();
	}

	async function stop(ctx: ExtensionCommandContext): Promise<void> {
		if (server === undefined && pending === undefined) {
			ctx.ui.notify("pi-chat-view is not running", "info");
			return;
		}
		await close();
		ctx.ui.notify("pi-chat-view stopped", "info");
	}

	async function startServer(ctx: ExtensionCommandContext): Promise<void> {
		const agentDir = getAgentDir();
		const { config, warning } = readViewConfig(agentDir);
		if (warning !== undefined) ctx.ui.notify(warning, "warning");
		const attempt = start({ dir: join(agentDir, SPAWN_SESSIONS), port: config.port }).then(
			(started) => {
				server = started;
				ctx.ui.notify(`pi-chat-view: ${started.url}`, "info");
			},
			(error: unknown) => {
				ctx.ui.notify(`pi-chat-view failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			},
		);
		pending = attempt;
		try {
			await attempt;
		} finally {
			if (pending === attempt) pending = undefined;
		}
	}

	return {
		async run(args, ctx) {
			const action = args.trim();
			if (action === "stop") return stop(ctx);
			if (action !== "" && action !== "start") {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			if (pending !== undefined) {
				ctx.ui.notify("pi-chat-view is starting", "info");
				return;
			}
			if (server !== undefined) {
				ctx.ui.notify(`pi-chat-view is already running: ${server.url}`, "info");
				return;
			}
			await startServer(ctx);
		},
		stop: close,
	};
}

export function registerChatViewCommand(pi: ExtensionAPI, start: Starter = startViewServer): void {
	const session = createChatViewSession(start);
	pi.registerCommand("chat-view", {
		description: COMMAND_DESCRIPTION,
		handler: (args, ctx) => session.run(args, ctx),
	});
	pi.on("session_shutdown", () => session.stop());
}
