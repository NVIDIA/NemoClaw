<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Managed workload rebuild boundary

This directory is a dormant, provider-neutral transaction foundation. No CLI
command or production action imports it yet. Activation must wait until every
deferred outcome has a durable recovery owner. This change migrates only the
transaction boundary; it does not activate buildless rebuilds.

## Publication and cleanup ownership

- A failed compare-and-swap permits rollback only when NemoClaw observes the exact old durable
  authority or the CAS reports that it did not write.
- An indeterminate publication leaves the staged runtime intact and returns an
  `reconcile-publication` task for `durable-managed-workload-recovery`.
- A failed post-commit retirement returns a `retire-previous` task for
  the same owner. The result object is only a handoff; the
  [durable recovery work tracked by epic #7744](https://github.com/NVIDIA/NemoClaw/issues/7744)
  must persist and reconcile it before this transaction can be wired into a
  user-visible action.

## Snapshot and backup boundary

This slice neither emits nor consumes snapshot or backup manifests. `restoreState`
is a provider-owned rebuild phase receipt, not a backup format or proof of
managed backup authority.

The [snapshot and backup work tracked by epic #7744](https://github.com/NVIDIA/NemoClaw/issues/7744)
owns the shared managed-backup-authority helper and must wire every relevant
caller together: snapshot creation, `backup --all`, stopped-sandbox backup, and
production rebuild.

This boundary remains inert until every relevant backup caller emits the same
normalized managed manifest, the restore gate accepts and validates that
manifest, recovery tasks are durably persisted and reconciled, and protected
qualification passes for OpenClaw, Hermes, and DCode.
