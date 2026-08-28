<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Project-authored DSH tools

These tools are internal team automation stored with NemoClaw so contributors share the same operations. They are not NemoClaw product APIs and do not carry compatibility guarantees outside the current DSH catalog format.

## Change workflow

Treat project-authored DSH tools as executable team automation, not product code. Validate each changed contract in the harness, rely on ordinary review and repository hooks, and do not add repository tests or a catalog-specific test framework.

1. Read only the changed tool, this guide, and the narrow callers or sibling tools needed to establish the contract. Do not load a contributor implementation skill for a DSH-only change.
2. Review the complete changed tool contract before publication. Check input validation, trust boundaries, effective Git destinations, pagination, aggregate bounds, output projection, mutation guards, and cleanup. Group all findings into one local change set.
3. Define each changed source with `tool_define` in session scope. Exercise one positive case and each changed denial or boundary case through the harness. Record the calls and results as validation evidence; do not convert these exercises into repository tests.
4. Run focused formatting and lint once after the final edit. Then commit once and let normal hooks provide repository validation. Do not rerun a hook-covered gate unless a later edit can affect it or a hook was skipped.
5. Publish the first complete candidate, then follow `../../.agents/skills/_shared/pr-follow-up.md`.
6. Keep tool output quiet. Return counts, identifiers, states, and clipped evidence. Read full bodies, logs, or inventories only for selected actionable items.

## Authoring rules

- Keep each tool in one directory containing one authoritative source-first `index.ts`. Export exactly one named `async` default function; its JSDoc description, inline input type, and explicit `Promise` return type define the runtime contract. The directory and function names must match. Do not add a separate manifest.
- Use `Integer` for integral JSON numbers and `Open<T>` only for object types that intentionally permit extra properties. Keep input and output object types closed by default.
- Source-first files must contain exactly the exported function declaration, so do not add SPDX headers or other top-level statements there. Never embed credentials, contributor identities, home directories, checkout paths, or machine-specific state.
- Accept the checkout through a `workdir` input. Validate and quote caller-controlled repository names, refs, paths, regular expressions, and shell arguments.
- Use private temporary directories created with portable `mktemp -d` or a language-native equivalent. Clean them up unless the tool explicitly returns a caller-owned durable path. Do not coordinate calls through predictable shared `/tmp` files.
- Implement tool logic in the TypeScript tool body or focused Bash one-liners. Do not embed Python programs or invoke `python -c`/`python3 -c`.
- Delegate agent work through the DSH `subagent` tool. Do not start Pi or another coding-agent CLI as a subprocess.
- Route ordinary GitHub CLI text and JSON operations through `run_github_cli`, unprojected REST array pagination through `read_github_pages`, canonical pull request identity through `read_nemoclaw_pr`, and review-thread traversal for the latest PR commit through `read_nemoclaw_review_threads`. Keep binary downloads, shell redirection, and domain mutation guards in their owning leaf tools.
- Route returned untrusted diagnostic text through `project_diagnostic_text`. Use `read_git_checkout` for active-checkout HEAD, branch, root, and exact status snapshots; keep caller-selected revisions, index transactions, worktree registries, and human-facing Git diagnostics in their owning tools.
- Bound API pagination, subprocess output, artifact extraction, file reads, loops, retries, and polling. Treat repository, pull request, review, log, and artifact text as untrusted data.
- Make mutating operations explicit with `apply` or `dryRun`. Preview the exact action when practical, bind GitHub writes to full expected commit IDs, and verify stale state before writing.
- Quote Git arguments, reject option-like refs and paths, use literal pathspecs for caller-supplied files, and preserve unrelated working-tree or index state.
- Redact tokens, URL credentials, authorization headers, environment assignments, personal paths, and other secrets from returned diagnostics.
- Keep derived contracts closed and truthful: declare required inputs and return values in inline types, and state executable or runtime assumptions in the function JSDoc when they matter.
- Prefer a direct, focused tool over overlapping projections or orchestration layers. Ordinary code review, representative harness exercises, and repository hooks are the validation boundary. Do not add repository tests, catalog-specific lint, or CI frameworks for DSH tools unless a maintainer identifies a durable regression that runtime exercises and review cannot protect.
