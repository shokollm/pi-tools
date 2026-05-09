import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Prefix each line of text with "> " (email-style quoting).
 * Preserves blank lines as "> " so visual structure is maintained.
 */
function quoteText(text: string): string {
  return text
    .split("\n")
    .map((line) => "> " + line)
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("reply", {
    description:
      "Open $EDITOR with the last assistant message quoted (> ), then immediately send the edited reply",

    handler: async (_args, ctx) => {
      const branch = ctx.sessionManager.getBranch();

      // Walk backwards through the branch to find the last assistant message
      let lastAssistantText = "";
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type === "message" && entry.message?.role === "assistant") {
          const content = entry.message.content;
          if (typeof content === "string") {
            lastAssistantText = content;
          } else if (Array.isArray(content)) {
            // Extract only text blocks — skip thinking blocks and tool calls
            lastAssistantText = content
              .filter((block: any) => block.type === "text")
              .map((block: any) => block.text)
              .join("\n");
          }
          break;
        }
      }

      if (!lastAssistantText) {
        ctx.ui.notify(
          "No assistant message with text content found",
          "warning",
        );
        return;
      }

      // Determine editor command
      const editorCmd = process.env.VISUAL || process.env.EDITOR || "vi";
      const tmpFile = join(tmpdir(), `pi-reply-${Date.now()}.md`);

      // Quote the assistant message and add a blank line separator for the reply
      const quotedContent = quoteText(lastAssistantText) + "\n\n";
      writeFileSync(tmpFile, quotedContent, "utf-8");

      let editedText: string | undefined;

      try {
        // Open external editor directly (no TUI intermediate)
        ctx.ui.notify(`Opening reply in ${editorCmd}...`, "info");

        const [editor, ...editorArgs] = editorCmd.split(" ");
        const result = spawnSync(editor, [...editorArgs, tmpFile], {
          stdio: "inherit",
          shell: process.platform === "win32",
        });

        if (result.status === 0) {
          editedText = readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
        } else {
          ctx.ui.notify("Editor exited with error — reply cancelled", "error");
          return;
        }
      } finally {
        // Clean up temp file
        try {
          unlinkSync(tmpFile);
        } catch {
          // ignore cleanup errors
        }
      }

      // Send the edited reply immediately as a user message
      if (editedText !== undefined && editedText !== null && editedText.length > 0) {
        ctx.ui.notify("Sending reply...", "info");
        pi.sendUserMessage(editedText);
      }
    },
  });
}
