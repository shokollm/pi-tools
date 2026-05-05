/**
 * /read command — pipes last assistant response through a pager (less -R).
 *
 * Renders the response's markdown to ANSI-colored text using pi's own
 * dependencies (marked + chalk), writes to a temp file, suspends the TUI,
 * and opens it in `less -R` for comfortable reading with scroll/search.
 *
 * Requires: npm install in this directory
 *
 * Usage:
 *   /read           # Read last assistant response in pager
 *
 * Based on the interactive-shell.ts example pattern for TUI suspend/resume.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ExtensionAPI, AssistantMessage } from "@mariozechner/pi-coding-agent";

// Load marked and chalk from this extension's own node_modules
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, "package.json"));
const { marked } = require("marked");
const chalk = require("chalk").default;
// Force color output even when writing to a pipe/file
chalk.level = 3;

// ── Markdown → ANSI renderer ──────────────────────────────────────

/**
 * Render inline markdown tokens to an ANSI-colored string.
 */
function renderInline(tokens: any[]): string {
	return (tokens || [])
		.map((t: any) => {
			switch (t.type) {
				case "text":
				case "escape":
					return t.text;
				case "strong":
					return chalk.bold(renderInline(t.tokens));
				case "em":
					return chalk.italic(renderInline(t.tokens));
				case "codespan":
					return chalk.yellow(t.text);
				case "del":
					return chalk.strikethrough(renderInline(t.tokens));
				case "link":
					return chalk.blue.underline(t.text || t.href) + chalk.dim(` (${t.href})`);
				case "image":
					return chalk.dim(`[image: ${t.text || t.href}]`);
				case "br":
					return "\n";
				default:
					return t.text || renderInline(t.tokens) || "";
			}
		})
		.join("");
}

/**
 * Render a block-level marked token to ANSI-colored lines.
 */
function renderBlock(token: any, _width: number): string[] {
	switch (token.type) {
		case "heading": {
			const text = renderInline(token.tokens);
			const prefix = "#".repeat(token.depth);
			const colored =
				token.depth <= 2
					? chalk.bold.cyan(`${prefix} ${text}`)
					: chalk.cyan(`${prefix} ${text}`);
			// Underline H1 with dashes
			if (token.depth === 1) {
				const underline = chalk.dim("─".repeat(Math.min(text.length, 72)));
				return [colored, underline, ""];
			}
			return [colored, ""];
		}

		case "paragraph": {
			const text = renderInline(token.tokens);
			return [text, ""];
		}

		case "code": {
			const lang = token.lang ? chalk.dim(` ${token.lang}`) : "";
			const lines = token.text.split("\n");
			const result: string[] = [chalk.dim(`┌─${lang}`)];
			for (const l of lines) {
				result.push(chalk.yellow(l));
			}
			result.push(chalk.dim("└─"));
			result.push("");
			return result;
		}

		case "list": {
			const result: string[] = [];
			(token.items || []).forEach((item: any, i: number) => {
				const prefix = token.ordered ? chalk.dim(`${token.start + i}.`) : chalk.dim("•");
				const text = renderInline(item.tokens);
				result.push(`  ${prefix} ${text}`);
				// Handle nested list items
				if (item.tasks) {
					(item.tasks || []).forEach((task: any) => {
						const check = task.checked ? chalk.green("[✓]") : chalk.dim("[ ]");
						result.push(`    ${check} ${renderInline(task.tokens)}`);
					});
				}
			});
			result.push("");
			return result;
		}

		case "blockquote": {
			const text = renderInline(token.tokens);
			return text.split("\n").map((l: string) => chalk.dim(`│ ${l}`)).concat([""]);
		}

		case "hr":
			return [chalk.dim("─".repeat(40)), ""];

		case "table": {
			const result: string[] = [];
			// Header
			const headers = (token.header || []).map((cell: any) =>
				chalk.bold(renderInline(cell.tokens)),
			);
			result.push(` ${headers.join(" │ ")} `);
			result.push(chalk.dim(` ${(token.header || []).map((_: any) => "─".repeat(10)).join("─┼─")} `));
			// Rows
			(token.rows || []).forEach((row: any[]) => {
				const cells = row.map((cell: any) => renderInline(cell.tokens));
				result.push(` ${cells.join(" │ ")} `);
			});
			result.push("");
			return result;
		}

		default:
			// For unrecognized tokens (html, etc.), try to get text
			return [(token.text || token.tokens ? renderInline(token.tokens) : ""), ""];
	}
}

/**
 * Render full markdown string to ANSI-colored output.
 */
function renderMarkdownToAnsi(markdown: string): string {
	const tokens = marked.lexer(markdown);
	const width = process.stdout.columns || 80;
	const lines: string[] = [];

	for (const token of tokens) {
		const rendered = renderBlock(token, width);
		lines.push(...rendered);
	}

	// Trim trailing blank lines
	while (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}

	return lines.join("\n");
}

// ── Extension ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("read", {
		description: "Read last assistant response in a pager (less -R)",
		handler: async (_args, ctx) => {
			// Find the last assistant message from session entries
			const entries = ctx.sessionManager.getEntries();
			let lastAssistantMsg: AssistantMessage | null = null;

			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					lastAssistantMsg = entry.message as AssistantMessage;
					break;
				}
			}

			if (!lastAssistantMsg) {
				ctx.ui.notify("No assistant message found to read.", "warning");
				return;
			}

			// Extract text content (skip thinking blocks and tool calls)
			const textParts: string[] = [];
			for (const block of lastAssistantMsg.content) {
				if (block.type === "text" && block.text.trim().length > 0) {
					textParts.push(block.text);
				}
			}

			if (textParts.length === 0) {
				ctx.ui.notify("Assistant message has no text content.", "warning");
				return;
			}

			const markdown = textParts.join("\n\n");

			// Render markdown to ANSI
			let ansiOutput: string;
			try {
				ansiOutput = renderMarkdownToAnsi(markdown);
			} catch (e) {
				ctx.ui.notify(`Failed to render markdown: ${e}`, "error");
				return;
			}

			// Write to temp file
			const tempFile = join(tmpdir(), `pi-read-${Date.now()}.md`);
			writeFileSync(tempFile, ansiOutput, "utf-8");

			// If no TUI (print mode, RPC), just print the file path
			if (!ctx.hasUI) {
				console.log(`Response written to: ${tempFile}`);
				return;
			}

			// Suspend TUI, run less, resume
			ctx.ui.custom<void>((tui, _theme, _kb, done) => {
				// Stop TUI to release terminal
				tui.stop();

				// Clear screen
				process.stdout.write("\x1b[2J\x1b[H");

				// Run less -R with full terminal access (inherits stdin for interactive nav)
				const shell = process.env.SHELL || "/bin/sh";
				const result = spawnSync(shell, ["-c", `less -R "${tempFile}"`], {
					stdio: "inherit",
					env: process.env,
				});

				// Cleanup temp file
				try {
					unlinkSync(tempFile);
				} catch {
					// ignore cleanup failures
				}

				// Restart TUI
				tui.start();
				tui.requestRender(true);

				// Signal completion
				done(undefined);

				return { render: () => [], invalidate: () => {} };
			});
		},
	});
}
