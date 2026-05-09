# pi-tools

A collection of quality-of-life extensions for the [pi coding agent](https://pi.dev).

## Install

```bash
pi install git:github.com/shokollm/pi-tools
```

Then restart pi or run `/reload`. All commands are available immediately.

## Commands

### `/read`

Open the last assistant response in `less -R` with ANSI-formatted markdown rendering.

```
/read
```

Uses pi's own `marked` + `chalk` to render markdown to colored terminal output, then opens it in a pager. You get `less`'s full navigation: `/search`, `G`/`gg`, `f`/`b` page up/down, arrow keys, `q` to quit.

Works well for long responses that are painful to read in the terminal's scrollback buffer.

---

### `/edit <path>`

Open any file in `$EDITOR` (or `$VISUAL`, falling back to `vi`) with full TUI suspend/resume.

```
/edit draft.md
/edit /tmp/review.md
/edit src/main.ts
```

Pi's TUI suspends while the editor runs, then resumes when you quit. The file is on disk — you can reference it in your next prompt with `@draft.md`.

---

### `/handoff [path] [--last N]`

Dump session context to a markdown file for cross-session handoff. Follows Mario's file-as-artifact philosophy — pass context between sessions without sub-agents or context mixing.

```
/handoff                    Write last 10 exchanges to cwd/handoff-<timestamp>.md
/handoff --last 5           Write last 5 exchanges
/handoff --last 0           Write ALL exchanges
/handoff review.md          Write to cwd/review.md
/handoff --last 3 out.md    Combine
```

**Typical flow:**
```
Session A (researcher):
  /handoff
  → writes cwd/handoff-20260505-123456.md

Session B (reviewer):
  starts with @handoff-xxx.md
  does review work
  /handoff --last 3
  → writes review result

Session A (researcher):
  /edit handoff-yyy.md        → read review
  @handoff-yyy.md              → bring review into next prompt
```

Clean up with `rm handoff-*`.

---

### `/reply`

Open the **last assistant message quoted** (`> ` prefix per line) in `$EDITOR`, then write your reply below and send it on save.

```
/reply
```

When you invoke `/reply`, the editor opens with:

```
> What the assistant just said
> line two of the response
> line three

← type your reply here
```

This uses the standard email-quoting pattern — the quoted assistant text gives the model context for what you're responding to, and you write your message below the blank line.

Use cases:
- Correct a misunderstanding without retyping everything
- Add context or refine before the model continues
- Reference something the model just said in your reply

When you save and quit (`:wq`), the full content (quote + your reply) is sent as your next user message. If you quit without saving (`:q!`), the reply is cancelled.

---

### `/wrap [path] [--last N]`

Generate a structured session summary (Goal, Progress, Key Decisions, Next Steps, Files Touched) using the LLM. Unlike `/handoff` which dumps raw messages, `/wrap` produces a condensed, readable checkpoint you can bring into a fresh session.

```
/wrap                    Summarize ALL messages into cwd/wrap-<timestamp>.md
/wrap --last 10          Summarize only last 10 exchanges
/wrap notes.md           Write to cwd/notes.md
```

**Output format:**
```markdown
# Wrap: project-name

## Goal
Refactor the auth module to use JWT

## Progress
- [x] Designed token structure
- [ ] Implemented middleware

## Key Decisions
- Tokens expire in 15 minutes (security req)

## Next Steps
1. Write verification middleware
2. Update tests
```

**Typical flow:**
```
1. Context getting full → /wrap → writes structured summary
2. /new (start fresh session)
3. @wrap-xxx.md "Continue from here"
```

The original session stays intact in `~/.pi/agent/sessions/` for reference.

## Development

```bash
git clone https://github.com/shokollm/pi-tools
cd pi-tools

# Install dependencies for extensions that need them
cd extensions/read-response && npm install && cd ../..
cd extensions/wrap && npm install && cd ../..

# Test locally
pi -e extensions/read-response -e extensions/edit-file -e extensions/handoff -e extensions/wrap -e extensions/reply-command
```

## License

MIT
