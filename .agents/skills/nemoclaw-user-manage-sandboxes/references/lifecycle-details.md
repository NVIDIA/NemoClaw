<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Manage Sandbox Lifecycle: Details

## What Changes During a Rebuild

Each rebuild destroys the existing container and creates a new one.
NemoClaw protects your data through the same backup-and-restore flow as `nemoclaw <name> rebuild` (use the `nemoclaw-user-reference` skill):

- NemoClaw preserves manifest-defined workspace state. Before deleting the old container, NemoClaw snapshots the state directories and durable state files defined in the agent manifest, typically `/sandbox/.openclaw/workspace/`; for Hermes this also includes `SOUL.md` and the SQLite database behind `.hermes/state.db`. Stored credentials (`~/.nemoclaw/credentials.json`) and registered policy presets live on the host and are re-applied to the new sandbox automatically.
- NemoClaw does not preserve runtime changes outside the workspace state directories. This includes packages installed inside the running container with `apt` or `pip`, files in non-workspace paths, and in-memory or process state. If you have customized the running container at runtime, capture that as `Dockerfile` changes for `nemoclaw onboard --from` or a manual `openshell sandbox download` before the rebuild starts.

Aborts before the destroy step are non-destructive.
The flow refuses to proceed past preflight if a credential is missing or past backup if required manifest-defined state cannot be copied, so a failed run leaves the original sandbox intact and ready to retry.
When a backup command reports partial archive output, NemoClaw keeps the usable entries and reports only the manifest-defined paths that could not be archived.

See [Backup and Restore](backup-restore.md) for the full list of state-preservation guarantees, snapshot retention, and instructions for manual backups when the auto-flow is not enough.

**If the rebuild aborts with `Missing credential: <KEY>`:**

The rebuild preflight reads the provider credential recorded by your last `nemoclaw onboard` session.
If you have switched providers since onboarding, for example from a remote API to a local Ollama setup, the preflight may still reference the old key and fail before any destroy step runs.

To recover, re-run `nemoclaw onboard` and select your current provider.
This refreshes the session metadata.
Your existing container keeps serving traffic until the new image is ready.
