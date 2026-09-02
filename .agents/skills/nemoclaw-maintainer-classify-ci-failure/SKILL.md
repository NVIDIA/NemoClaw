---
name: nemoclaw-maintainer-classify-ci-failure
description: Classify one NemoClaw GitHub Actions job failure from bounded, redacted logs and an optional retained artifact. Use for CI failure classification, failed job diagnosis, or artifact-backed failure evidence.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Classify a CI Failure

Run the read-only classifier from a NemoClaw checkout:

```bash
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-classify-ci-failure/scripts/classify-ci-failure.mts \
  --workdir "$PWD" --job-id <job-id>
```

The default repository is `NVIDIA/NemoClaw`. Optional flags are `--repo`, `--artifact-name`, `--max-lines`, and `--clip-mode head|tail`.

The script uses authenticated `gh` reads. It performs no GitHub writes. It bounds and redacts log output. When an artifact is selected, it bounds pagination, compressed and expanded sizes, entries, paths, file reads, and reported failures. It rejects malformed ZIPs, links, special files, duplicate or unsafe paths, ambiguous listings, and size mismatches. Temporary files use process-owned directories under a fixed private root. The classifier removes them directly through the filesystem after success or failure. Each command runs beneath a stable detached group leader that stays alive until every group descendant exits. This is an internal trusted-subprocess boundary: the classifier invokes only its fixed `gh`, Bash, and GNU coreutils commands, treats artifacts as data, and never executes artifact content or caller-selected programs. On `SIGHUP`, `SIGINT`, or `SIGTERM`, the classifier rejects new commands, terminates and drains every owned group, synchronously removes tracked directories, and exits with the conventional cancellation code. If normal cleanup fails, it reports a bounded, redacted error and a removal command that remains valid if `TMPDIR` changes.

Run the script from a Linux NemoClaw checkout with Node.js 22.19 or later, `/proc`, Bash, authenticated `gh`, and GNU coreutils (`base64`, `dd`, `rm`, `stat`, `tail`, and `wc`).

Any nonzero log acquisition result is a classifier failure: the script exits nonzero with no success JSON and reports a bounded, redacted diagnostic after removing its temporary log directory. On GitHub authentication or authorization failure, stop, follow the repository GitHub access hard stop, and ask the user to correct the configured `gh` access (including SSO or token scope) before rerunning. Treat `unclassified` as bounded evidence, not proof that no known cause exists.
