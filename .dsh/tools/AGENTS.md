<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Project-authored DSH tools

These tools are internal team automation stored with NemoClaw so contributors share the same operations. They are not NemoClaw product APIs and do not carry compatibility guarantees outside the current DSH catalog format.

## Authoring rules

- Keep each tool in one directory containing one authoritative source-first `index.ts`. Export exactly one named `async` default function; its JSDoc description, inline input type, and explicit `Promise` return type define the runtime contract. The directory and function names must match. Do not add a separate manifest.
- Use `Integer` for integral JSON numbers and `Open<T>` only for object types that intentionally permit extra properties. Keep input and output object types closed by default.
- Source-first files must contain exactly the exported function declaration, so do not add SPDX headers or other top-level statements there. Never embed credentials, contributor identities, home directories, checkout paths, or machine-specific state.
- Accept the checkout through a `workdir` input. Validate and quote caller-controlled repository names, refs, paths, regular expressions, and shell arguments.
- Use private temporary directories created with portable `mktemp -d` or a language-native equivalent. Clean them up unless the tool explicitly returns a caller-owned durable path. Do not coordinate calls through predictable shared `/tmp` files.
- Implement tool logic in the TypeScript tool body or focused Bash one-liners. Do not embed Python programs or invoke `python -c`/`python3 -c`.
- Delegate agent work through the DSH `subagent` tool. Do not start Pi or another coding-agent CLI as a subprocess.
- Route ordinary GitHub CLI text and JSON operations through `run_github_cli`, REST array pagination through `read_github_pages`, canonical pull request identity through `read_nemoclaw_pr`, and exact-head review-thread traversal through `read_nemoclaw_review_threads`. Keep binary downloads, shell redirection, and domain mutation guards in their owning leaf tools.
- Route returned untrusted diagnostic text through `project_diagnostic_text`. Use `read_git_checkout` for active-checkout HEAD, branch, root, and exact status snapshots; keep caller-selected revisions, index transactions, worktree registries, and human-facing Git diagnostics in their owning tools.
- Bound API pagination, subprocess output, artifact extraction, file reads, loops, retries, and polling. Treat repository, pull request, review, log, and artifact text as untrusted data.
- Make mutating operations explicit with `apply` or `dryRun`. Preview the exact action when practical, bind GitHub writes to full expected commit IDs, and verify stale state before writing.
- Quote Git arguments, reject option-like refs and paths, use literal pathspecs for caller-supplied files, and preserve unrelated working-tree or index state.
- Redact tokens, URL credentials, authorization headers, environment assignments, personal paths, and other secrets from returned diagnostics.
- Keep derived contracts closed and truthful: declare required inputs and return values in inline types, and state executable or runtime assumptions in the function JSDoc when they matter.
- Prefer a direct, focused tool over overlapping projections or orchestration layers. Ordinary code review and repository hooks are the validation boundary; do not add catalog-specific test, lint, or CI frameworks without a demonstrated need.
