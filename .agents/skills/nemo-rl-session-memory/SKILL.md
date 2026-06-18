---
name: nemo-rl-session-memory
license: Apache-2.0
description: "Manage durable working-session memory for coding agents. Use when a user asks to preserve or recover agent context across disconnects, VS Code restarts, long-running work, handoffs, or any session where important state should be written periodically under the repo's session directory. Do NOT use for: simple questions, short tasks, one-off commands, linting, or code review."
when_to_use: Preserving or recovering coding-agent context; creating checkpoints for long-running work, handoffs, disconnects, VS Code restarts, branch switches, or nontrivial edits.
---

# Session Memory

Keep a durable, human-readable record of the current working session so another agent can resume after a disconnect with minimal context loss.

## When To Use

Use this skill when:
- The user asks to preserve, recover, checkpoint, or manage agent memory.
- Work is long-running, experimental, or likely to span disconnects.
- You are about to make nontrivial edits, run long jobs, switch branches, or pause for user input.
- You resume in a repo that already has `./session/` directories.

## Session Directory

Create one directory per working session:

```bash
mkdir -p session
date +%Y%m%d_%H%M%S
mkdir -p session/<session_date_time>
```

Use local time from the machine. Reuse the same session directory for all checkpoints in the same conversation unless the user explicitly starts a new session.

Expected files:
- `session_state.md` - overall goal, current subtask, loaded skills, status, plan, assumptions, blockers, and next actions.
- `timeline.md` - append-only log of major actions, commands, results, and decisions.
- `files.md` - files inspected, files changed, and why they matter.
- `handoff.md` - concise resume instructions for the next agent.

Add other files only when useful, such as `experiments.tsv`, `review_notes.md`, or copied command logs.

## Start Or Resume

At the start of a session:
1. Check for existing session directories:

```bash
ls -dt session/* 2>/dev/null | head
```

2. If the user is resuming work, read the latest relevant `session_state.md`, `timeline.md`, and `handoff.md`.
3. If no relevant session exists, create a new timestamped directory.
4. Write an initial `session_state.md` with the user's overall goal, current subtask, loaded skills, repo path, branch, and known constraints.

Do not treat session notes as the only source of truth. Verify important claims against git state, files, and command output before acting.

## Checkpoint Rhythm

Write a checkpoint:
- After gathering enough context to form a plan.
- Before and after meaningful code edits.
- Before long-running commands, experiments, branch switches, or anything hard to reconstruct from chat.
- When the user changes direction.
- Before final response if the session has meaningful state worth resuming.
- At least every 30 minutes during active long-running work.

Prefer updating the same files rather than creating many small checkpoint files. Keep the record compact and scannable.

## File Templates

### `session_state.md`

```markdown
# Session State

- Session: <session_date_time>
- Repo: <absolute repo path>
- Branch: <branch name>
- Started: <local timestamp>
- Updated: <local timestamp>

## Goal
<Stable overall user goal in one or two sentences. Preserve this across follow-up steering unless the user explicitly changes it.>

## Current Subtask
<Immediate task or steering request currently being handled.>

## Loaded Skills
- `<skill-name>` - <why it was loaded and any important instructions to preserve.>

## Current Status
<What is true now. Include completed work and verification status.>

## Plan
- [ ] <Next concrete step>
- [ ] <Next concrete step>

## Assumptions
- <Assumption and how to verify it if needed.>

## Blockers
- <Blocker or "None known".>
```

### `timeline.md`

```markdown
# Timeline

## <local timestamp>
- User asked: <brief request>
- Context gathered: <files/commands and key result>
- Decision: <important choice and rationale>
- Result: <edits/tests/outcome>
```

### `files.md`

```markdown
# Files

## Inspected
- `<path>` - <why it mattered>

## Changed
- `<path>` - <what changed and why>

## Generated
- `<path>` - <purpose>
```

### `handoff.md`

```markdown
# Handoff

## Resume From Here
<One paragraph summary of the current state.>

## Next Actions
- <Most important next action>
- <Verification or cleanup still needed>

## Watch Outs
- <Risks, user preferences, or repo constraints the next agent must preserve.>
```

## Recovery Workflow

When resuming after a disconnect:
1. Find the likely latest session directory.
2. Read `handoff.md` first, then `session_state.md`, then recent `timeline.md`.
3. Run lightweight verification such as `git status --short`, `git branch --show-current`, and targeted file reads.
4. Continue from the latest verified next action.
5. Append a timeline entry noting the recovery and any mismatches found.

## Quality Rules

- Keep notes factual and terse. Future agents need state, not a transcript.
- Record command outcomes that matter, especially failed tests or skipped verification.
- Mention uncommitted changes and whether they were made by the current agent or pre-existing.
- Do not store secrets, tokens, private credentials, or large logs in session files.
- If a session file becomes large, summarize old details and keep the latest next actions near the top of `handoff.md`.
