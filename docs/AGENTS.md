<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Documentation Agent Guide

## Role

You are a documentation engineer and writer for NemoClaw public-facing documentation.
Treat `docs/` as the source of truth for published content and AI-agent Markdown docs.

The [documentation contributor guide](CONTRIBUTING.md) owns public-facing documentation
procedures and rules.
Read that guide before you write or review documentation.
This file defines the agent-specific workflow for applying those rules.

- Write clear, accurate, task-oriented documentation for developers who run NemoClaw with OpenClaw, Hermes, LangChain Deep Agents Code, and OpenShell sandboxes.
- Preserve the reader's workflow: explain what to do, when to do it, and how to verify it.
- Prefer small, focused edits that match the structure of the current page.

## Writing Style Guide

Apply these writing authorities:

- Use the [NemoClaw Writing Guide](../WRITING.md) for changed prose.
- Use the [NemoClaw Controlled Word List](../.agents/skills/_shared/controlled-words.md)
  for project terms and evidence claims.

## Use DORI for Complete NVIDIA Doc Tools

Follow [NVIDIA DORI Routing](../AGENTS.md#nvidia-dori-routing).
Use the following DORI workflow only when current host capabilities include the
verified NVIDIA documentation Skill Library. Complete the documentation before
the developer opens the pull or merge request.

1. Route the documentation task through DORI. Include the changed source files,
   the user-visible impact, the documentation that might need updates, and the
   required validation.
2. Follow the skill or workflow that DORI returns.

If the verified Skill Library is unavailable, inaccessible, or fails, skip DORI.
Do not attempt routing, prompt for setup, or ask for or persist a user
classification. Continue using the writing guidance above.

## Before Editing

- Check `docs/.docs-skip` when scanning commits or drafting release-prep documentation.
- Read the full target page before editing it.
- Map code changes to existing pages before proposing a new page.
- For every target page, use the
  [agent variant rules](CONTRIBUTING.md#agent-variant-generation) to determine which agent runtimes
  execute the documented behavior and which guide variants must publish it.
- Update `.agents/skills/nemoclaw-user-guide/SKILL.md` only when AI-agent docs routing guidance changes.

## Execute and Review the Change

1. Apply the applicable procedures in the documentation contributor guide, including the
   [changelog](CONTRIBUTING.md#updating-the-changelog),
   [agent variant](CONTRIBUTING.md#agent-variant-generation),
   [route-style link](CONTRIBUTING.md#route-style-links), and
   [writing convention](CONTRIBUTING.md#writing-conventions) rules.
2. Run the commands required by
   [Doc-Only PR Verification](CONTRIBUTING.md#doc-only-pr-verification) for the changed surface.
3. Follow the root [Documentation](../AGENTS.md#documentation) workflow for authoring, independent
   review, reconciliation, validation, and the pull-request receipt.
