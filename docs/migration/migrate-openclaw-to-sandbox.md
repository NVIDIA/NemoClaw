<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Migrate an Existing OpenClaw Installation to a Sandbox

Move a host-installed OpenClaw into an OpenShell sandbox.
The migration creates a snapshot of your current state so that you can roll back if needed.

## Prerequisites

- An existing OpenClaw installation on the host.
- NemoClaw installed. Install with `npm install -g nemoclaw`.
- The OpenShell CLI on your `PATH`.
- Docker, or [Colima](https://github.com/abiosoft/colima) on macOS, running.

## Preview the Migration

Run a dry run to review what the migration changes without modifying any files:

```console
$ openclaw nemoclaw migrate --dry-run
```

The output lists the resources that the blueprint runner plans to create or update, including the gateway, inference providers, sandbox, and policy.
Review this output before proceeding.

## Run the Migration

Start the migration.
NemoClaw creates a snapshot of your current OpenClaw state before making changes:

```console
$ openclaw nemoclaw migrate
```

The migration performs the following steps:

1. Creates a backup snapshot of your host OpenClaw configuration.
2. Resolves and verifies the blueprint artifact.
3. Plans the required OpenShell resources.
4. Applies the plan by calling the OpenShell CLI.

## Verify the Migration

Check the sandbox status after the migration completes:

```console
$ openclaw nemoclaw status
```

The output should show the sandbox as running with the default inference profile active.

## Connect to the Sandbox

Open an interactive shell inside the new sandbox:

```console
$ openclaw nemoclaw connect
```

Run a test agent prompt to confirm that inference routing works:

```console
$ openclaw agent --agent main --local -m "Hello from the sandbox" --session-id test
```

## Select a Non-Default Profile

To migrate with a specific inference profile, pass the `--profile` flag:

```console
$ openclaw nemoclaw migrate --profile vllm
```

```console
$ openclaw nemoclaw migrate --profile nim-local
```

## Skip the Backup

If you do not need a rollback snapshot, pass the `--skip-backup` flag:

```console
$ openclaw nemoclaw migrate --skip-backup
```

:::{warning}
Skipping the backup disables the ability to eject back to the host installation.
Use this option only if you are certain that you do not need a rollback.
:::

## Related Topics

- [Roll Back a Migration](roll-back-migration.md) to restore the pre-migration state.
- [Commands](../reference/commands.md) for the full `migrate` command reference.
- [Architecture](../about/architecture.md) for details on the blueprint lifecycle.
