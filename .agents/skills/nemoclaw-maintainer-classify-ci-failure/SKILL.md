---
name: nemoclaw-maintainer-classify-ci-failure
description: Classify one NemoClaw GitHub Actions job failure from bounded, redacted logs and an optional retained artifact. Use for CI failure classification, failed job diagnosis, or artifact-backed failure evidence.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Classify a CI Failure

Run the classifier from a NemoClaw checkout:

```bash
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-classify-ci-failure/scripts/classify-ci-failure.mts \
  --workdir "$PWD" --job-id <job-id>
```

The repository is fixed to `NVIDIA/NemoClaw`. Optional flags include `--artifact-name`. `--max-lines` accepts integers from `1` through `500` and defaults to `120`. `--clip-mode` accepts `head` or `tail` and defaults to `tail`.

The script uses authenticated `gh` reads. It performs no GitHub writes. It bounds and redacts log output. When an artifact is selected, it bounds pagination, compressed and expanded sizes, entries, paths, file reads, and reported failures. It rejects malformed ZIPs, links, special files, duplicate or unsafe paths, ambiguous listings, and size mismatches. Temporary files use process-owned directories under a fixed private root. The classifier attempts to remove them directly through the filesystem after success or failure. If removal fails, the classifier exits nonzero. It reports a bounded, redacted diagnostic with a direct removal command. Each command runs beneath a stable detached group leader that stays alive until every group descendant exits. This is an internal trusted-subprocess boundary: the classifier invokes Bash and GNU coreutils by fixed paths. It finds `gh` only in `/usr/bin`, `/usr/local/bin`, or `$HOME/.local/bin` after it validates the path, ownership, permissions, and file type. It treats artifacts as data and never executes artifact content or caller-selected programs. On `SIGHUP`, `SIGINT`, or `SIGTERM`, the classifier rejects new commands, terminates and drains every owned group, synchronously removes tracked directories, and exits with the conventional cancellation code. If normal cleanup fails, it reports a bounded, redacted error and a removal command that remains valid if `TMPDIR` changes.

Run the script from a Linux NemoClaw checkout with Node.js 22.19 or later, `/proc`, Bash, authenticated `gh` in a trusted location, and GNU coreutils (`dd`, `stat`, `tail`, and `wc`).

Any nonzero log acquisition result is a classifier failure. After the cleanup attempt, the script exits nonzero with no success JSON and reports a bounded, redacted diagnostic. On GitHub authentication or authorization failure, stop, follow the repository GitHub access hard stop, and ask the user to correct the configured `gh` access (including SSO or token scope) before rerunning. Treat `unclassified` as bounded evidence, not proof that no known cause exists.
