# Managed workload rebuild boundary

This directory is a dormant, provider-neutral transaction foundation. No CLI
command or production action imports it yet. Activation must wait until every
deferred outcome has a durable recovery owner.

## Publication and cleanup ownership

- A failed compare-and-swap is rollback-safe only when the exact old durable
  authority is positively observed or the CAS reports that it did not write.
- An indeterminate publication leaves the staged runtime intact and returns an
  exact `reconcile-publication` task for `durable-managed-workload-recovery`.
- A failed post-commit retirement returns an exact `retire-previous` task for
  the same owner. The result object is only a handoff; a later recovery slice
  must durably persist and reconcile it before this transaction can be wired
  into a user-visible action.

## Snapshot and backup boundary

This slice neither emits nor consumes snapshot or backup manifests.
`restoreState` is a provider-owned rebuild phase receipt, not a backup format
or proof of managed backup authority.

The next snapshot/backup slice (PR3.8 in the current stack) owns the shared
managed-backup-authority helper and must wire every relevant caller together:
snapshot creation, `backup --all`, stopped-sandbox backup, and production
rebuild. Until those callers produce the same managed manifest accepted by the
restore gate, this rebuild transaction remains inert.
