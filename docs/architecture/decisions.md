# Scope and decisions

NemoClaw uses Go, OpenTofu, and OpenShell to manage deployment infrastructure from desired-state configuration.
It implements a subset of the configuration analysis in issue #10904, not the entire proposed schema or product integration.

The [initial decision record](../archive/initial-decisions.md) preserves the dated experiment scope and task-specific publication authorization.

## Acceptance criteria

Deployment validation covers these behaviors:

1. Create a working agent from YAML against a real local OpenShell gateway.
2. Apply unchanged YAML without resource changes.
3. Change inference model without replacing the sandbox.
4. Reconcile an interrupted apply without duplicate resources.
5. Export reusable YAML without secret values and recreate a separate deployment.
6. Reject foreign ownership, changed identities, unknown fields, inline secrets, and unsupported ordinary deletion or replacement.
7. Build the five bundle targets and report native execution separately from cross-compilation.

Spark additionally requires actual replies, retained artifact identities, interrupted download/preparation checks, capacity rejection, watchdog shutdown, and explicit recovery.
Teardown requires ordered deletion, read-only preview, retained storage, failure reconciliation, and reapply.
The [validation summary](../validation/index.md) separates evidence from these criteria.

## Deployment boundaries

There is no adoption, pruning, migration, automatic rollback, or lost-state recovery command.
The combined Ollama resource needs a separate storage boundary before destroy can handle it.
Fabric deployments require external gateway and inference services.
Real messaging requires generic egress, secrets, and retained-storage facilities plus live account qualification.
Native macOS, Windows, and Podman operation require their own runtime evidence.
Interrupted Ollama downloads through OpenTofu, stopped-parent repair, credential installation versions, qualified taint recovery, and measured maintenance reduction require separate implementation or qualification.
The historical RFC records broader [adoption gates](../archive/desired-state-rfc.md#9-adoption-gates).
