<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Internal commands

Hidden `nemoclaw internal ...` commands are compatibility entrypoints for repo-owned scripts and migration helpers. They are not a public API.

Keep command files thin:

```text
src/commands/internal/<area>/<verb>.ts
  -> parse flags/args
  -> call src/lib/actions/<area>/<verb>.ts
```

Behavior belongs in `src/lib/actions/**`, pure decisions belong in `src/lib/domain/**`, and process/filesystem/Docker/OpenShell boundaries belong in `src/lib/adapters/**`.
