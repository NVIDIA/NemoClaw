<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Diagnose a Failed Deployment Operation

Retain the original YAML, matching bundle, and entire state directory when an operation fails.
Composed onboarding publishes its selected YAML before credential fulfillment and plan, so a credential, plan, or apply failure leaves that recovery input in place.
Retry the failed stage with standalone `nemoclaw plan FILE` or `nemoclaw apply FILE` after resolving the cause; do not rerun authoring and replace the deployment identity.
If you decline the distinct apply prompt, the published YAML remains available and no apply is attempted.
Do not delete bindings or substitute a fresh state directory to bypass an ownership error.
See [state locations](state.md) and the [recovery procedure](usage.md#updates-and-recovery).

## Capture the Failing Operation

Record the command, exit status, stderr, source revision/bundle, state path, and the step at which the operation stopped.
The CLI writes operation results to stdout and failures to stderr; it has no separate persistent CLI log.
Do not rerun apply just to collect output after an uncertain mutation.
First resolve the reported failure using the table below.

When ordinary planning is appropriate, collect a read-only runtime preview from the directory containing `deployment.yaml`:

```sh
diagnostic_dir=$(mktemp -d)
nemoclaw plan --state-dir .local/deployment deployment.yaml > "$diagnostic_dir/plan.json" 2> "$diagnostic_dir/plan.stderr"
diagnostic_status=$?
printf 'Exit status: %s\nDiagnostics: %s\n' "$diagnostic_status" "$diagnostic_dir"
```

Replace the YAML and state paths with the ones from the failed operation.
Planning can write local planning files, but does not mutate runtime resources.
For an unfinished destroy, use `plan --destroy` with the same state instead of the YAML command.
On nonzero exit, read `plan.stderr`; empty stdout does not mean the deployment has no changes.
Review diagnostics before sharing them: endpoints, resource identities, and agent output may be private even when credential values are redacted.
Do not attach environment dumps, TLS private keys, interface tokens, or the entire state directory to a public report.

## Identify the Failure

| Symptom | Next action |
|---|---|
| Unknown field, duplicate key, or rejected combination | Compare the input with the matching [configuration reference](reference/configuration.md); an earlier schema is not automatically migrated |
| Bundle or schema hash failure | Follow [bundle rebuilding](build.md#build-a-native-bundle) and keep the selected bundle unchanged during operations |
| `state is bound to a different deployment UID or gateway` | Restore the original UID and gateway endpoint; a new target needs separate state and resources |
| `unfinished apply has different intent` | Reapply the exact YAML from the unfinished operation before trying another configuration |
| Deployment lock error | Check for another operation using the same state directory; a lock failure does not authorize state deletion |
| Authentication, transport, or incomplete-observation error | Restore access to the selected service; failed observation does not establish absence or authorize recreation |
| Ownership, generation, or durable identity mismatch | Inspect the selected gateway/engine and retained deployment identity; do not adopt or replace a different resource |
| Plan would remove or replace a resource | Check [update constraints](usage.md#updates-and-recovery) and the relevant configuration guide before choosing a new deployment |
| Interrupted apply | Resolve the cause and reapply the original YAML with its retained state |
| Unfinished destroy | Resume destroy with the same state; other operations refuse unfinished teardown |
| Native configuration or interface-token drift | Follow [agent interface diagnosis](interfaces.md#diagnose-failures); configuration checks do not overwrite conflicts |

For proxy policies, the pinned OpenShell supervisor can add read-only `/var/log` access to the loaded policy.
NemoClaw accepts that runtime addition while preserving the authored policy; other loaded-policy differences still fail observation.

The [SDK errors](../crates/nemoclaw-sdk/src/error.rs), [plan checks](../crates/nemoclaw-sdk/src/deployment/plan.rs), and [lifecycle tests](../crates/nemoclaw-sdk/tests/deployment.rs) define these failure boundaries.

An ownership error is not fixed by renaming a resource, deleting `intent.json`, editing OpenTofu state, or rerunning with a fresh state path against the same resources.
Retain the original binding while investigating the selected gateway and engine.

## Inference and Agent Readiness

Use [inference verification](inference.md#verify-the-result) to distinguish configuration readiness from a successful reply.
For stopped Ollama, use [the managed Ollama procedure](inference.md#run-managed-ollama); a failed inventory must not be treated as an absent model.
For a managed model or watchdog stop, inspect [retained status and logs](models.md#diagnose-and-recover-a-stopped-runtime).
For an external Ollama digest mismatch, use [the proxy guide](inference.md#use-external-ollama-through-a-managed-proxy).

| Observation | What it establishes | Next check |
|---|---|---|
| Model appears in the endpoint inventory | The service reports that model | Confirm API compatibility and an inference request |
| Apply succeeds | Declared resources and agent configuration pass readiness checks | Verify inference and a native agent turn through the intended interface |
| Agent configuration drift | Native settings differ from retained intent | Restore expected settings; checks do not overwrite them |
| Dashboard cannot connect | Native service, forwarding, authentication, or browser pairing may be incomplete | Follow [interface diagnosis](interfaces.md#diagnose-failures); keep local forwarding ports consistent |
| Managed runtime stopped after a protection trip | The independent supervisor stopped inference | Inspect [retained status and logs](models.md#diagnose-and-recover-a-stopped-runtime) and correct capacity/startup conditions before explicit recovery |

Terminal sandbox errors report the OpenShell phase, a recognized failure reason, and the main process exit code, or `unknown` when unavailable.
Recognized reasons are `ControlSupervisorExited` and `ContainerExited`; other backend reasons appear as `unknown`.
Error, completed, stopped, and deleting phases fail immediately and retain resources.
The SDK excludes unrecognized reasons and raw backend condition messages because they may contain credentials.
The CLI points to OpenShell inspection and log collection; use the procedure below before cleanup.
The [current main-process environment blocker](validation/rust-native-inference-linux-arm64.md#live-attempt-and-blocker) can stop startup before native log files exist.

The current CLI has no `doctor`, `status`, or diagnostic-bundle command.

## Inspect an OpenShell Sandbox Failure

Use the original deployment's gateway and workspace, following [interface selection](interfaces.md#select-the-gateway-and-workspace).
The temporary directories below are private to the collecting user.
Raw status and logs may contain credentials or agent content; inspect and redact them before sharing, and remove diagnostic copies when the investigation ends.
From any directory on the client host, replace `assistant` with the declared sandbox name:

```sh
diagnostic_dir=$(mktemp -d)
openshell sandbox get assistant -o json > "$diagnostic_dir/sandbox.json"
```

Inspect the phase, exit code, and readiness conditions in the result.
`ControlSupervisorExited` identifies failure of the OpenShell supervisor; it does not establish that the agent or model failed.
Read the condition message privately: it can include backend log excerpts and values excluded from NemoClaw's diagnostics.
A successful earlier apply establishes readiness at that time, not continuous health or a successful model response.
An unsupported Fabric health check provides no health assurance.

For a managed gateway and Docker sandbox on the same local engine, run these read-only commands on that engine host with the deployment workspace selected:

```sh
engine_diagnostic_dir=$(mktemp -d)
model_engine=unix:///var/run/docker.sock
docker --host "$model_engine" ps -a --filter "name=$OPENSHELL_WORKSPACE" --format 'table {{.Names}}\t{{.Status}}'
docker --host "$model_engine" logs --timestamps --since 1h "$OPENSHELL_WORKSPACE-gateway" > "$engine_diagnostic_dir/gateway.log" 2>&1
```

Use the deployment's actual engine socket and a time range covering the failure.
For a remote engine, collect on that host; for an external gateway or another driver, ask its operator for the matching logs.
The Docker listing includes stopped containers.
Copy the exact sandbox or supervisor container name from it to collect that component's output:

```sh
sandbox_container=REPLACE_WITH_CONTAINER_NAME
docker --host "$model_engine" logs --timestamps --since 1h "$sandbox_container" > "$engine_diagnostic_dir/component.log" 2>&1
```

OpenShell can remove the supervisor container after failure; the gateway may retain a tail of its logs.
For a controlled reproduction, start `docker logs --follow` collection while the supervisor exists so its full output survives container removal.
Keep the YAML, bundle, state directory, and sandbox files until the cause and recovery path are understood.
NemoClaw does not reconnect OpenShell's internal transport or automatically replace the failed sandbox.

## Read Native Service Logs

For a reachable sandbox, [select its gateway and workspace](interfaces.md#select-the-gateway-and-workspace) on the client host.
Run the command for its harness from any directory, replacing `assistant` with the declared sandbox name.
These commands read native process output without restarting it.
Logs can contain prompts, responses, and native errors that have not passed through the SDK's secret redaction; inspect them privately before sharing excerpts.

OpenClaw writes gateway stdout and stderr to its retained native home:

```sh
openshell sandbox exec -n assistant -- tail -n 100 /sandbox/.openclaw/gateway.log
```

The default local Hermes adapter writes its Fabric-owned API process output separately from dashboard sessions:

```sh
openshell sandbox exec -n assistant -- tail -n 100 /sandbox/.hermes/api.log
```

Expect the latest process output, which may be empty before the process emits a message.
A missing file can mean startup stopped before opening the log; it does not establish that the sandbox or its data is absent.
Use the original apply error and the [failure table](#identify-the-failure) to choose recovery.
Do not replay an uncertain native invocation merely to reproduce a log entry.
The [OpenClaw](../image/fabric/openclaw_adapter.py) and [Hermes](../image/fabric/hermes_adapter.py) adapters define these paths and append behavior.
The experimental [Hermes Relay mode](agents.md#hermes-relay-tracing) without explicit `interfaces` uses another adapter; its trace artifacts do not imply that the local API process or `api.log` exists.

Collection procedures for other harnesses, Hermes dashboard logs, and an inaccessible sandbox: **TBD** pending evidence for each process and access path.

## Traces and Web Search

OpenClaw tracing and Brave search have their own [configuration and verification limits](agents.md#openclaw-tracing).
Configuration readiness does not prove collector delivery, a valid Brave credential, or available quota.

Production collector troubleshooting and end-to-end hosted search diagnostics: **TBD**.
