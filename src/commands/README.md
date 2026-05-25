<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# `src/commands`

This tree is the oclif discovery surface for the packaged `nemoclaw` CLI.
Command entrypoint files define the oclif command class directly. Do not add new
public command shims that only re-export from `src/lib/**`, and do not recreate a
parallel command layer under `src/lib`. Prefer `src/lib/<feature>/**` for shared
parser helpers.

```text
src/commands/<public command path>.ts
  -> parse flags/args
  -> call src/lib/actions/** or small src/lib/<feature> command-support helpers
```

Keep product behavior out of this tree. Command classes should stay thin: product
behavior belongs in `src/lib/actions/**`, pure planning and classification belongs in
`src/lib/domain/**`, and host/runtime boundaries belong in `src/lib/adapters/**`.

Hidden `nemoclaw internal ...` entrypoints live under `src/commands/internal/**`; see
`src/commands/internal/README.md` for their narrower compatibility contract.
