/**
 * pi-chat-view — one chronological timeline of a pi-spawn conversation.
 *
 * This factory is the entire public surface: Pi loads this file and nothing else
 * needs to be exported. The view reads the child transcripts pi-spawn already
 * writes, so the extension registers no tools and adds no context to a session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChatViewCommand } from "./command.ts";

export default function registerChatViewExtension(pi: ExtensionAPI): void {
	registerChatViewCommand(pi);
}
