---
name: "nemoclaw-user-agent-skills"
description: "Helps users obtain and load NemoClaw's bundled agent skills into Claude Code, Cursor, Copilot, or another skills-aware AI coding assistant by cloning the NemoClaw repository and pointing the assistant at the .agents/skills/ directory. Use when the user wants to install, copy, mount, or activate NemoClaw skills inside their assistant — not for general discovery of which skills exist (use nemoclaw-skills-guide for catalog browsing). Trigger keywords - install nemoclaw agent skills, clone nemoclaw skills, load .agents/skills, point cursor at nemoclaw skills, claude code nemoclaw skills, copy nemoclaw skills into assistant."
license: "Apache-2.0"
metadata:
  author: "Miyoung Choi <miyoungc@nvidia.com>"
  tags:
    - nemoclaw
    - agent-skills
    - installation
    - claude-code
    - cursor
    - copilot
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Agent Skills for Your AI Coding Assistant

## Instructions

Use this skill only when the user wants to **install or load** NemoClaw's agent skills into their AI coding assistant. If the user is asking *which* skills exist or *what they do*, hand off to `nemoclaw-skills-guide` instead.

Follow this fixed sequence. Do not exceed the listed tool budget.

1. **Confirm intent.** In one sentence, restate what the user wants (e.g., "You want to load NemoClaw's bundled skills into Claude Code on macOS"). Do not call any tools yet.
2. **Read the reference once.** Load `references/agent-skills.md` exactly one time. Do not re-read it on the same request.
3. **Answer with the install steps** scoped to the assistant the user named (Claude Code, Cursor, Copilot, generic). Use the clone command and the assistant-specific skills directory pattern from the reference.
4. **Verify and stop.** Tell the user how to confirm the assistant sees the skills (typically `ls` of the target directory or the assistant's skill listing command). Do not run additional tool calls after the verification instruction.

Tool budget per invocation: at most **one** Read of `references/agent-skills.md` and at most **one** shell or filesystem call if the user asks for a verification command. If the user's request expands beyond install/load, return the answer and suggest the appropriate sibling skill rather than chaining more tool calls.

## Examples

**Example 1 — Claude Code on macOS.** User says "I want to use NemoClaw's skills in Claude Code." Restate intent, read `references/agent-skills.md`, then provide: `git clone https://github.com/NVIDIA/NemoClaw && ln -s "$(pwd)/NemoClaw/.agents/skills" ~/.claude/skills/nemoclaw`, followed by the verification command.

**Example 2 — Cursor.** User says "How do I get NemoClaw skills into Cursor?" Same flow, but point the assistant at Cursor's skills location instead of `~/.claude/skills/`. Do not list every NemoClaw skill — that's the job of `nemoclaw-skills-guide`.

**Example 3 — Out-of-scope handoff.** User says "What can NemoClaw skills do for me?" Do **not** load this skill's reference. Recommend `nemoclaw-skills-guide` and stop.

## References

- **Load [references/agent-skills.md](references/agent-skills.md)** once per request when the user wants to install or load NemoClaw's agent skills into their AI coding assistant. Describes the clone-and-link workflow for accessing the bundled `.agents/skills/` directory.
