# Initial scope decisions

This record preserves the local experiment decisions from September 2026.
Use [scope and decisions](../architecture/decisions.md) for deployment boundaries.

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
The [writing guide](../contributing/writing.md) documents the adapted upstream rules.
