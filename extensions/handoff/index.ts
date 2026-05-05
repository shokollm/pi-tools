/**
 * /handoff command — dumps session context to a markdown file for cross-session handoff.
 *
 * Follows Mario's file-as-artifact philosophy. Instead of subagents or context
 * sharing, write the session context to a file. Another pi session (or a human)
 * can pick it up with `@file.md`.
 *
 * Usage:
 *   /handoff                    Write all messages to cwd/handoff-<timestamp>.md
 *   /handoff --last 5           Write last 5 exchanges only
 *   /handoff review.md          Write to cwd/review.md
 *   /handoff --last 3 out.md    Combine: last 3 exchanges to custom path
 *
 * Cleanup: `rm handoff-*`
 *
 * Flow:
 *   Session A (researcher):  /handoff
 *     → writes cwd/handoff-20260505-123456.md (full context)
 *   Session B (reviewer):    starts with @handoff-xxx.md + review skill
 *     → does review
 *   Session B:               /handoff --last 3
 *     → writes review result (only final output)
 *   Session A:               /edit handoff-yyy.md  → read review
 *   Session A:               @handoff-yyy.md        → bring review into context
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename, resolve, isAbsolute, dirname } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, AssistantMessage, AgentMessage } from "@mariozechner/pi-coding-agent";

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
		if (typeof (msg as any).content === "string") {
			return (msg as any).content;
		}
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
			if (block.type === "text") {
				parts.push(block.text);
			} else if (block.type === "thinking") {
				parts.push(`[thinking: ${block.thinking.slice(0, 200)}${block.thinking.length > 200 ? "..." : ""}]`);
			}
		}
		return parts.join("\n\n");
	}

	if (msg.role === "toolResult") {
		const content = (msg as any).content;
		if (Array.isArray(content)) {
			return content
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join("\n")
				.slice(0, 500);
		}
		return "";
	}

	return "";
}

function roleLabel(role: string): string | null {
	switch (role) {
		case "user":
			return "**User**";
		case "assistant":
			return "**Assistant**";
		case "toolResult":
			return null;
		default:
			return `**${role}**`;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Dump session context to a markdown file. " +
			"Usage: /handoff [[path]] [--last N]",
		handler: async (args, ctx) => {
			const rawArgs = (args || "").trim();

			// Default: last 10 exchanges. --last N overrides. --last 0 = all.
			let lastCount: number = 10; // Default: last 10 exchanges
			let customPath: string | null = null;

			const tokens = rawArgs.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
			const positional: string[] = [];

			for (let i = 0; i < tokens.length; i++) {
				const t = tokens[i];
				if (t === "--last" && i + 1 < tokens.length) {
					lastCount = parseInt(tokens[++i], 10);
					if (isNaN(lastCount)) lastCount = null;
				} else {
					positional.push(t.replace(/^"|"$/g, ""));
				}
			}

			// First positional arg is a custom path if it looks like one
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

			// Default: last 10. --last 0 = all.
			if (lastCount > 0) {
				messageEntries = messageEntries.slice(-lastCount * 2);
			}

			// Build markdown
			const projectName = basename(ctx.cwd);
			const timestamp = formatTimestamp();
			const lines: string[] = [];

			lines.push(`# Handoff: ${projectName}`);
			lines.push(`**Date:** ${new Date().toISOString()}`);
			lines.push(`**Project:** ${ctx.cwd}`);
			lines.push(`**Session:** ${ctx.sessionManager.getSessionId()}`);
			lines.push("");
			lines.push("---");
			lines.push("");

			for (const entry of messageEntries) {
				const label = roleLabel(entry.message.role);
				if (!label) continue;

				const text = extractMessageText(entry.message);
				if (!text.trim()) continue;

				lines.push(`### ${label}`);
				lines.push("");
				lines.push(text);
				lines.push("");
				lines.push("---");
				lines.push("");
			}

			const content = lines.join("\n");

			// Determine output path
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
				if (!existsSync(parentDir)) {
					mkdirSync(parentDir, { recursive: true });
				}
			} else {
				const filename = `handoff-${timestamp}.md`;
				filepath = join(ctx.cwd, filename);
			}

			writeFileSync(filepath, content, "utf-8");
			ctx.ui.notify(`Handoff written to ${filepath}`, "success");
		},
	});
}
