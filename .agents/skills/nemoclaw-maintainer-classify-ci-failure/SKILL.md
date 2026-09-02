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

The script uses authenticated `gh` reads. It performs no GitHub writes. It bounds and redacts log output. When an artifact is selected, it bounds pagination, compressed and expanded sizes, entries, paths, file reads, and reported failures. It rejects malformed ZIPs, links, special files, duplicate or unsafe paths, ambiguous listings, and size mismatches. Temporary files use private directories. The classifier removes them after success or failure when cleanup succeeds. If cleanup fails, it reports a redacted path and a removal command.

Run the script from a Linux NemoClaw checkout with Node.js 22.19 or later, Bash, authenticated `gh`, and GNU coreutils (`base64`, `dd`, `mktemp`, `rm`, `stat`, `tail`, and `wc`).

Stop on GitHub authentication or authorization failure. Follow the repository GitHub access hard stop. Treat `unclassified` as bounded evidence, not proof that no known cause exists.
