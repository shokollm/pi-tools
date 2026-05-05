/**
 * /edit command — open any file in $EDITOR with TUI suspend/resume.
 *
 * Enables Mario's file-based handoff pattern:
 *   1. Agent writes draft to draft.md
 *   2. You type /edit draft.md
 *   3. $EDITOR opens the file (vim, nvim, helix, etc.)
 *   4. Save & quit → pi resumes right where you left off
 *   5. @draft.md in next prompt to bring it back
 *
 * Usage:
 *   /edit draft.md
 *   /edit /tmp/review.md
 *   /edit src/main.ts
 *
 * Based on the interactive-shell.ts TUI suspend/resume pattern.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("edit", {
		description: "Open a file in $EDITOR (TUI suspends, resumes on quit)",
		handler: async (args, ctx) => {
			// Parse path from arguments
			const pathArg = (args || "").trim();

			if (!pathArg) {
				ctx.ui.notify("Usage: /edit <filepath>", "warning");
				return;
			}

			// Resolve relative paths against cwd
			const filePath = pathArg.startsWith("/") ? pathArg : resolve(ctx.cwd, pathArg);

			// Determine editor
			const editorCmd = process.env.VISUAL || process.env.EDITOR || "vi";

			// If no TUI (print mode, RPC), just notify
			if (!ctx.hasUI) {
				console.log(`Open ${filePath} in ${editorCmd}`);
				return;
			}

			// Suspend TUI, run editor, resume
			ctx.ui.custom<void>((tui, _theme, _kb, done) => {
				// Notify user
				process.stdout.write(`\x1b[2J\x1b[HOpening ${pathArg} in ${editorCmd}...\n`);

				// Stop TUI to release terminal
				tui.stop();

				// Run editor with full terminal access
				const shell = process.env.SHELL || "/bin/sh";
				const result = spawnSync(shell, ["-c", `${editorCmd} "${filePath}"`], {
					stdio: "inherit",
					env: process.env,
				});

				// Restart TUI
				tui.start();
				tui.requestRender(true);

				// Report exit status
				if (result.status !== 0) {
					process.stdout.write(`\x1b[2J\x1b[H`);
				}

				// Signal completion
				done(undefined);

				return { render: () => [], invalidate: () => {} };
			});

			ctx.ui.notify(`Closed ${pathArg}`, "info");
		},
	});
}
