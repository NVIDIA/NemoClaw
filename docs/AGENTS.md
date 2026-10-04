<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Documentation Agent Guide

## Role

You are a documentation engineer and writer for NemoClaw public-facing documentation.
Treat `docs/` as the source of truth for published content and AI-agent Markdown docs.

The [documentation contributor guide](CONTRIBUTING.md) owns public-facing documentation
procedure and rules.
Read that guide before you write or review documentation.
This file owns agent-specific documentation routing and workflow.

- Write clear, accurate, task-oriented documentation for developers who run NemoClaw with OpenClaw, Hermes, LangChain Deep Agents Code, and OpenShell sandboxes.
- Preserve the reader's workflow: explain what to do, when to do it, and how to verify it.
- Prefer small, focused edits that match the structure of the current page.

## NVIDIA DORI Routing

Select the documentation path from current host capabilities.
Do not ask the user to classify themselves or store repository-scoped identity state during a
normal documentation task.

1. Check whether the current agent exposes `dori_handle` or `dori_route` and `dori_collections`.
   If the user explicitly asks not to use DORI, continue with the documentation contributor guide.
2. When those tools are available, list the installed collections.
   - Use DORI for task routing only when the collection matches the
     [canonical Skill Library source](#verify-the-skill-library-source).
   - If the collection is missing, inaccessible, or cannot be verified, continue with the
     documentation contributor guide.
3. When the DORI tools are unavailable, continue with the documentation contributor guide.
   Do not inspect a shell-visible CLI, install software, or configure the host during a normal
   documentation task.
4. Use [NVIDIA DORI Setup](DORI_SETUP.md) only when the user explicitly asks to install or configure
   DORI.

Capability detection does not approve installation or host configuration.
DORI unavailability must not block documentation work.

### Verify the Skill Library Source

Treat a collection as the NVIDIA Skill Library only when its normalized source is exactly
`gitlab-master.nvidia.com/tech-docs/skill-library`. Before comparing the source, remove an HTTPS
scheme and one optional `.git` suffix or trailing slash.

A different host, a hostname with an added prefix or suffix, or a longer project path does not
qualify even when it contains `tech-docs/skill-library`. A `gitlab:tech-docs/skill-library`
shorthand value does not establish the host. If the source metadata does not resolve that shorthand
to the exact normalized source, continue without DORI.

When DORI is available, route the task with the changed source files, user-visible impact, likely
documentation updates, and required validation.
Follow the skill or workflow that DORI returns.

## Choose a Repository Skill

- Use `nemoclaw-contributor-update-docs` to find documentation impact or complete post-merge and
  direct documentation catch-up.
- Use `nemoclaw-maintainer-refactor-docs` for maintainer-owned information architecture, page
  splits, navigation changes, or content ownership changes.

## Before Editing

- Check `docs/.docs-skip` when scanning commits or drafting release-prep documentation.
- Read the full target page before editing it.
- Map code changes to existing pages before proposing a new page.
- For every target page, use the
  [agent variant rules](AUTOMATION.md#agent-variant-generation) to determine which agent runtimes
  execute the documented behavior and which guide variants must publish it.
- Update `.agents/skills/nemoclaw-user-guide/SKILL.md` only when AI-agent docs routing guidance changes.

## Execute the Change

1. Apply the documentation [style](STYLE.md) and [automation](AUTOMATION.md) contracts for the
   changed surface.
2. Follow the contributor guide's [validation](CONTRIBUTING.md#validate-the-change) procedure and
   obtain an independent documentation writer review before a direct documentation-only handoff.
