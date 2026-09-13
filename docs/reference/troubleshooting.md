# Troubleshoot a deployment

Preserve the selected state directory when an operation fails.
A failed or incomplete observation is not proof that a resource is absent.
Do not delete state, import a same-name object, or remove data to force a plan to succeed.

| Symptom | Cause or boundary | Next action |
| --- | --- | --- |
| Apply interrupted or a mutation response was lost | External effects can exist before their response is recorded | Apply the original YAML with the same state directory; reads reconcile recorded UID, generation, and resource IDs |
| Another YAML is rejected after failed apply | The previous operation has unfinished intent | Reconcile the original YAML first |
| Plan or export fails on authentication, transport, permissions, or incomplete data | Configuration is unknown | Restore access to the owning API and retry the requested operation; retain state |
| Export fails while inference is unhealthy | Inference health alone does not block export; required configuration may be missing or mismatched | Inspect the configuration diagnostic and restore observability or the expected settings |
| Model probe or endpoint validation fails | Endpoint reachability, protocol, or model readiness can differ from the CLI host | Check the endpoint from the gateway's inference environment and verify the [required protocol](fabric-harnesses.md) |
| Native OpenClaw changes fail readiness | A deployment-owned gateway, route, or workspace setting changed | Restore those settings; native channel and session settings can remain |
| Fabric runtime crashed | The host does not replay invocations or automatically recover a failed runtime | Inspect retained runtime logs and use an explicit recovery path; if OpenShell reports terminal `Error`, follow the next row |
| OpenShell sandbox is in `Error` | OpenShell 0.0.116 has no public recovery operation for this terminal phase | Preserve needed files, then use [explicit teardown](../guides/lifecycle.md#destroy-a-deployment) before fresh creation; do not edit the gateway database |
| A required image digest is unavailable | Rebuilding a local tag can remove an older digest from the engine | Restore the exact required image on the gateway's engine before retrying creation |
| Managed Ollama is stopped and planning fails | Model inventory cannot refresh, which blocks planning the service restart | Identify and explicitly start the owned container, then retry; ordinary apply cannot perform this repair |
| Spark inference stays stopped after watchdog shutdown | Shutdown is latched and Docker restart is disabled | Use explicit apply after capacity checks; refer to [Spark recovery](../guides/dgx-spark.md#verify-watchdog-recovery) |
| Destroy fails or another operation reports pending teardown | Deletion is incomplete or unobservable | Restore gateway access if needed and rerun destroy with the same state directory |
| A bound resource is missing or ownership differs | Ordinary apply does not adopt or replace foreign or lost bindings | Retain evidence and resolve the identity conflict before proceeding; there is no lost-state recovery command |
| Bundle verification fails | Executables do not match the local manifest | [Rebuild the complete bundle](../get-started/build.md) |

Mutations have no automatic retry loop.
An explicit reapply reconciles uncertain outcomes before further effects.
A failed readiness probe does not justify discarding completed configuration.
Unknown fields, inline credentials, unsupported combinations, omission, and unexpected replacement stop ordinary apply.
