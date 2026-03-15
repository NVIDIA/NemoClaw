<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Roll Back a Migration

Restore your host OpenClaw installation from a pre-migration snapshot.
The `eject` command reverses the migration and returns your system to the exact state before the sandbox was created.

## Prerequisites

- A NemoClaw sandbox that was created with `openclaw nemoclaw migrate` and includes a backup snapshot.
- The OpenShell CLI on your `PATH`.

## Check the Current State

Verify the sandbox status and identify the blueprint run ID:

```console
$ openclaw nemoclaw status --json
```

The JSON output includes the `lastRunId` field.
Note this value if you need to target a specific run.

## Run the Eject Command

Roll back to the most recent pre-migration snapshot:

```console
$ openclaw nemoclaw eject
```

The command prompts for confirmation before proceeding.
To skip the confirmation prompt, add the `--confirm` flag:

```console
$ openclaw nemoclaw eject --confirm
```

## Target a Specific Snapshot

If you have multiple migration runs and need to roll back to a specific one, pass the `--run-id` flag:

```console
$ openclaw nemoclaw eject --run-id <id>
```

Without this flag, `eject` restores from the most recent run.

## Verify the Rollback

After the rollback completes, verify that the host OpenClaw installation works:

```console
$ openclaw --version
```

Confirm that the sandbox is no longer running:

```console
$ openclaw nemoclaw status
```

## What the Eject Command Does

The eject process performs the following steps:

1. Loads the snapshot that was created during the migration.
2. Stops and removes the OpenShell sandbox.
3. Restores the host OpenClaw configuration files from the snapshot.
4. Updates NemoClaw state to reflect the rollback.

## Related Topics

- [Migrate an Existing OpenClaw Installation](migrate-openclaw-to-sandbox.md) to re-run the migration.
- [Commands](../reference/commands.md) for the full `eject` command reference.
