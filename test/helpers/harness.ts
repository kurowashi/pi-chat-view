/**
 * A fake Pi runtime for extension tests.
 *
 * It records what the extension registers and forwards the calls Pi would make,
 * so tests can drive commands and lifecycle events without starting Pi. Tools
 * are not just ignored: registering one throws, because this extension promises
 * to cost no model context.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type EventHandler = (event: unknown, ctx: unknown) => unknown;

export interface CapturedCommand {
	description?: string;
	handler: (args: string, ctx: unknown) => unknown;
}

export interface Notify {
	message: string;
	type?: string;
}

export interface ExtensionHarness {
	commands: Map<string, CapturedCommand>;
	events: Map<string, EventHandler[]>;
	notifications: Notify[];
	ctx: ExtensionCommandContext;
	run(args?: string): Promise<unknown>;
	emit(event: string): Promise<unknown>;
}

export function harness(register: (pi: ExtensionAPI) => void): ExtensionHarness {
	const commands = new Map<string, CapturedCommand>();
	const events = new Map<string, EventHandler[]>();
	const notifications: Notify[] = [];
	const api = {
		on(event: string, handler: EventHandler) {
			events.set(event, [...(events.get(event) ?? []), handler]);
			return () => {};
		},
		registerCommand(name: string, command: CapturedCommand) {
			commands.set(name, command);
		},
		registerTool() {
			throw new Error("pi-chat-view must not register tools");
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (message: string, type?: string) =>
				notifications.push(type === undefined ? { message } : { message, type }),
		},
	} as unknown as ExtensionCommandContext;
	register(api);
	return {
		commands,
		events,
		notifications,
		ctx,
		async run(args = "") {
			const command = commands.get("chat-view");
			if (command === undefined) throw new Error("the chat-view command is not registered");
			return await command.handler(args, ctx);
		},
		async emit(event: string) {
			let result: unknown;
			for (const handler of events.get(event) ?? []) result = await handler({ type: event }, ctx);
			return result;
		},
	};
}
