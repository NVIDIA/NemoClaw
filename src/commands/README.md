<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `src/commands`

This tree is the oclif discovery surface for the packaged `nemoclaw` CLI.
Each file is intentionally thin: it exports a command class from `src/lib/commands/**`
and attaches NemoClaw's public display metadata.

```text
src/commands/<public command path>.ts
  -> import command implementation from src/lib/commands/**
  -> wrap with src/lib/cli/command-display.ts metadata
```

Keep behavior out of this tree. Product behavior belongs in `src/lib/actions/**`, pure
planning and classification belongs in `src/lib/domain/**`, and host/runtime boundaries
belong in `src/lib/adapters/**`.

Hidden `nemoclaw internal ...` entrypoints live under `src/commands/internal/**`; see
`src/commands/internal/README.md` for their narrower compatibility contract.
