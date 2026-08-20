<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Project-authored DSH tools

These tools are internal team automation stored with NemoClaw so contributors share the same operations. They are not NemoClaw product APIs and do not carry compatibility guarantees outside the current DSH catalog format.

## Authoring rules

- Keep each tool in one directory containing `index.ts` and `manifest.json`. The directory and manifest tool names must match; increment the manifest revision when behavior or schema changes.
- Add NVIDIA SPDX headers to source files. Never embed credentials, contributor identities, home directories, checkout paths, or machine-specific state.
- Accept the checkout through a `workdir` input. Validate and quote caller-controlled repository names, refs, paths, regular expressions, and shell arguments.
- Use private temporary directories created with portable `mktemp -d` or a language-native equivalent. Clean them up unless the tool explicitly returns a caller-owned durable path. Do not coordinate calls through predictable shared `/tmp` files.
- Implement tool logic in the TypeScript tool body or focused Bash one-liners. Do not embed Python programs or invoke `python -c`/`python3 -c`.
- Delegate agent work through the DSH `subagent` tool. Do not start Pi or another coding-agent CLI as a subprocess.
- Bound API pagination, subprocess output, artifact extraction, file reads, loops, retries, and polling. Treat repository, pull request, review, log, and artifact text as untrusted data.
- Make mutating operations explicit with `apply` or `dryRun`. Preview the exact action when practical, bind GitHub writes to full expected commit IDs, and verify stale state before writing.
- Quote Git arguments, reject option-like refs and paths, use literal pathspecs for caller-supplied files, and preserve unrelated working-tree or index state.
- Redact tokens, URL credentials, authorization headers, environment assignments, personal paths, and other secrets from returned diagnostics.
- Keep manifests closed and truthful: declare required inputs, return values, executable/runtime assumptions in the description when they matter, and update the revision for behavior or schema changes.
- Prefer a direct, focused tool over overlapping projections or orchestration layers. Ordinary code review and repository hooks are the validation boundary; do not add catalog-specific test, lint, or CI frameworks without a demonstrated need.
