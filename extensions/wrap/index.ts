/**
 * /wrap command — generates a structured session summary for clean resumption.
 *
 * Unlike /handoff (which dumps raw messages), /wrap asks the LLM to produce
 * a structured markdown file with: goal, progress, key decisions, next steps,
 * and files touched. This gives you a clean, readable checkpoint you can
 * bring into a new session with `@wrap-xxx.md`.
 *
 * Usage:
 *   /wrap                      Summarize all messages to cwd/wrap-<timestamp>.md
 *   /wrap --last 10            Summarize only last 10 exchanges
 *   /wrap notes.md             Write to cwd/notes.md
 *   /wrap --last 5 out.md      Last 5 exchanges, custom path
 *
 * Workflow:
 *   1. Context getting full → /wrap → writes structured summary
 *   2. /new (start fresh session)
 *   3. @wrap-xxx.md "Continue from here"
 *
 * The original session stays intact in ~/.pi/agent/sessions/ for reference.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename, resolve, isAbsolute, dirname } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, AssistantMessage, AgentMessage } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";

function formatTimestamp(): string {
	const now = new Date();
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	const h = String(now.getHours()).padStart(2, "0");
	const min = String(now.getMinutes()).padStart(2, "0");
	const s = String(now.getSeconds()).padStart(2, "0");
	return `${y}${m}${d}-${h}${min}${s}`;
}

function extractMessageText(msg: AgentMessage): string {
	if (msg.role === "user") {
		if (typeof (msg as any).content === "string") return (msg as any).content;
		const content = (msg as any).content;
		if (Array.isArray(content)) {
			return content
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join("\n");
		}
		return "";
	}
	if (msg.role === "assistant") {
		const assistantMsg = msg as AssistantMessage;
		const parts: string[] = [];
		for (const block of assistantMsg.content) {
			if (block.type === "text") parts.push(block.text);
		}
		return parts.join("\n\n");
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("wrap", {
		description: "Generate a structured session summary. " +
			"Usage: /wrap [[path]] [--last N]",
		handler: async (args, ctx) => {
			const rawArgs = (args || "").trim();

			let lastCount: number = 0; // Default: all messages (summarize everything)
			let customPath: string | null = null;

			const tokens = rawArgs.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
			const positional: string[] = [];

			for (let i = 0; i < tokens.length; i++) {
				const t = tokens[i];
				if (t === "--last" && i + 1 < tokens.length) {
					lastCount = parseInt(tokens[++i], 10);
					if (isNaN(lastCount)) lastCount = 10;
				} else {
					positional.push(t.replace(/^"|"$/g, ""));
				}
			}

			if (positional.length > 0) {
				const first = positional[0];
				if (first.includes("/") || first.includes(".") || first.startsWith("~")) {
					customPath = first;
				}
			}

			// Get session entries
			const entries = ctx.sessionManager.getEntries();
			let messageEntries = entries.filter(
				(e) => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"),
			);

			if (messageEntries.length === 0) {
				ctx.ui.notify("No messages found in session.", "warning");
				return;
			}

			// Apply --last
			if (lastCount > 0) {
				messageEntries = messageEntries.slice(-lastCount * 2);
			}

			// Build the session transcript for the LLM
			const conversationParts: string[] = [];
			for (const entry of messageEntries) {
				const label = entry.message.role === "user" ? "User" : "Assistant";
				const text = extractMessageText(entry.message);
				if (!text.trim()) continue;
				conversationParts.push(`## ${label}\n\n${text}`);
			}

			if (conversationParts.length === 0) {
				ctx.ui.notify("No text content found in messages.", "warning");
				return;
			}

			const conversation = conversationParts.join("\n\n---\n\n");

			// Build the summarization prompt
			const summaryPrompt = `Summarize the following coding session as a structured wrap-up.

Output format:
\`\`\`
# Wrap: <project or task name>

## Goal
What was the main objective of this session?

## Progress
- [x] Completed items
- [ ] In-progress items

## Key Decisions
- Decision 1: rationale
- Decision 2: rationale

## Next Steps
1. What should happen next
2. ...

## Files Touched
- path/to/file.ts
\`\`\`

Only output the structured summary. No preamble, no commentary.

Session:
${conversation}`;

			ctx.ui.notify("Generating wrap summary...", "info");

			// Get the current model and API key
			const currentModel = ctx.model;
			if (!currentModel) {
				ctx.ui.notify("No model available for summarization.", "error");
				return;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(currentModel);
			if (!auth.ok) {
				ctx.ui.notify(`API key error: ${auth.error}`, "error");
				return;
			}

			// Make the LLM call
			let summary: string;
			try {
				const response = await complete(currentModel, {
					systemPrompt: "You are a precise session summarizer. Extract structure from conversations.",
					messages: [
						{ role: "user", content: [{ type: "text", text: summaryPrompt }], timestamp: Date.now() },
					],
				}, {
					apiKey: auth.apiKey,
					headers: auth.headers,
				});

				summary = response.content
					.filter((b: any) => b.type === "text")
					.map((b: any) => b.text)
					.join("\n");
			} catch (e: any) {
				ctx.ui.notify(`Summarization failed: ${e.message}`, "error");
				return;
			}

			// Write to file
			let filepath: string;
			if (customPath) {
				if (customPath.startsWith("~")) {
					filepath = customPath.replace(/^~/, homedir());
				} else if (isAbsolute(customPath)) {
					filepath = customPath;
				} else {
					filepath = resolve(ctx.cwd, customPath);
				}
				const parentDir = dirname(filepath);
				if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
			} else {
				const filename = `wrap-${formatTimestamp()}.md`;
				filepath = join(ctx.cwd, filename);
			}

			writeFileSync(filepath, summary, "utf-8");

			ctx.ui.notify(`Wrap written to ${filepath}`, "success");
		},
	});
}
