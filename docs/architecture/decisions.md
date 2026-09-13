# Scope and decisions

This independent prototype tests whether Go, OpenTofu, and OpenShell can implement a desired-state workflow with a small amount of new code.
It implements a subset of the configuration analysis in issue #10904, not the entire proposed schema or product integration.

## Accepted local experiments

The accountable maintainer is cv.
These decisions authorize local experiments; they do not establish product support or artifact redistribution readiness.

| Date | Decision | Boundary |
| --- | --- | --- |
| 2026-09-11 | Accept the independent desired-state prototype, initially on `codex/desired-state-prototype` | Explicit UID, strict YAML, secret references, ownership checks, non-destructive omission, partial-effect reconciliation |
| 2026-09-11 | Add managed Ollama and the pinned Qwen3.8 Flash Next recipe on DGX Spark | Local runtime experiments; host drivers, kernel tuning, system packages, and unrelated resources remain outside scope |
| 2026-09-12 | Provision Fabric and delegate agent execution to its adapters | External gateway and inference; nine upstream adapters plus the local OpenClaw adapter |
| 2026-09-12 | Use native messaging interfaces and retire the channel-control extension | No NemoClaw invocation or channel commands, new Fabric client, or upstream Fabric patches |

Git publication to `origin/v1` was authorized in the experiment's original task.
Artifact publication and migration of unrelated deployments were excluded.
The original implementation started without source or documentation from the previous NemoClaw implementation.
The current [writing guide](../contributing/writing.md) adapts upstream documentation guidance explicitly.

## Acceptance criteria

The experiment evaluates these behaviors:

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

## Remaining boundaries

There is no adoption, pruning, migration, automatic rollback, or lost-state recovery command.
The combined Ollama resource needs a separate storage boundary before destroy can handle it.
Fabric with managed gateway or inference, real messaging infrastructure, and live account qualification remain outside the current slice.
Native macOS, Windows, and Podman operation require their own runtime evidence.
Interrupted Ollama downloads through OpenTofu, stopped-parent repair, credential installation versions, qualified taint recovery, and measured maintenance reduction remain open.
The historical RFC records broader [adoption gates](../archive/desired-state-rfc.md#9-adoption-gates).
