<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Diagnose a Failed Deployment Operation

Retain the original YAML, matching bundle, and entire state directory when an operation fails.
Retry the failed stage with `nemoclaw plan FILE` or `nemoclaw apply FILE` after resolving the cause; do not rerun authoring and replace the deployment identity.
Do not delete bindings or substitute a fresh state directory to bypass an ownership error.
See [state locations](state.md) and the [recovery procedure](usage.md#updates-and-recovery).

## Capture the Failing Operation

Record the command, exit status, stderr, source revision/bundle, state path, and the step at which the operation stopped.
The CLI writes operation results to stdout and failures to stderr; it has no separate persistent CLI log.
Do not rerun apply just to collect output after an uncertain mutation.
First resolve the reported failure using the table below.

When planning is appropriate, collect a read-only runtime preview from the directory containing `deployment.yaml`:

```sh
diagnostic_dir=$(mktemp -d)
nemoclaw plan -o json --state-dir .local/deployment deployment.yaml > "$diagnostic_dir/plan.json" 2> "$diagnostic_dir/plan.stderr"
diagnostic_status=$?
printf 'Exit status: %s\nDiagnostics: %s\n' "$diagnostic_status" "$diagnostic_dir"
```

Replace the YAML and state paths with the ones from the failed operation.
Planning can write local planning files, but does not mutate runtime resources.
For an unfinished destroy, use `plan --destroy -o json` with the same state instead of the YAML command.
On nonzero exit, read `plan.stderr`; empty stdout does not mean the deployment has no changes.
Review diagnostics before sharing them: endpoints, resource identities, and agent output may be private even when credential values are redacted.
Do not attach environment dumps, TLS private keys, interface tokens, or the entire state directory to a public report.

## Identify the Failure

| Symptom | Next action |
|---|---|
| Unknown field, duplicate key, or rejected combination | Use the [document path and source position](#correct-a-document-validation-error), then compare the input with the matching [configuration reference](reference/configuration.md) |
| Bundle or schema hash failure | Follow [bundle rebuilding](build.md#build-a-native-bundle) and keep the selected bundle unchanged during operations |
| `state is bound to a different deployment UID or gateway` | Restore the original UID and gateway endpoint; a new target needs separate state and resources |
| `unfinished apply has different intent` | Reapply the exact YAML from the unfinished operation before trying another configuration |
| Deployment lock error | Check for another operation using the same state directory; a lock failure does not authorize state deletion |
| Authentication, transport, or incomplete-observation error | Restore access to the selected service; failed observation does not establish absence or authorize recreation. For a persistently unknown runtime after an invocation failure, follow the [replacement procedure](usage.md#replace-workloads-after-an-unusable-runtime) |
| Ownership, generation, or durable identity mismatch | Inspect the selected gateway/engine and retained deployment identity; do not adopt or replace a different resource |
| Provider-profile identity mismatch after upgrading a bundle | Check the [gateway profile format break](provider.md#gateway-profile-format-upgrade); old `profile-v1` profiles require the original bundle for teardown or a separate deployment |
| Plan would remove or replace a resource | Check [update constraints](usage.md#updates-and-recovery) and the relevant configuration guide before choosing a new deployment |
| Managed model replacement is refused by `updatePolicy: Preserve` | The update requires replacing a running Docker model container. Keep the current configuration, or explicitly choose `spec.services.<name>.updatePolicy: Recreate` after reviewing the [downtime and recovery limits](inference.md#set-container-limits-and-update-policy) |
| Interrupted apply | Resolve the cause and reapply the original YAML with its retained state |
| Unfinished destroy | Resume destroy with the same state; other operations refuse unfinished teardown |
| `adapter/<id> compatibility rejected` | Read the named sandbox and canonical field; for `models.<role>.max_tokens`, remove that route's `overrides.maxTokens` or choose an adapter that accepts it, then plan again |
| `Fabric runtime operation failed at STAGE (CODE)` | Read Fabric's message in the file the error names, in the state directory's `diagnostics` directory; it can contain secrets, so read it privately. Then follow [agent interface diagnosis](interfaces.md#diagnose-failures) |
| Public Fabric configuration mismatch or native startup rejection | Follow [agent interface diagnosis](interfaces.md#diagnose-failures); retained public configuration checks do not audit native files or tokens |
| A plan replaces a sandbox because `sandbox exited` | OpenShell reports that the sandbox exited, for example after its gateway restarted; read why with `openshell logs SANDBOX --source sandbox`. Applying replaces it, deleting its files and history; see [replacing workloads](usage.md#replace-workloads-after-an-unusable-runtime) |
| `runtime_unavailable` | The runtime is unusable while its sandbox runs; read why with `openshell logs SANDBOX --source sandbox`. Only a new sandbox recovers it: change the agent's configuration, or follow the [whole-deployment replacement procedure](usage.md#replace-workloads-after-an-unusable-runtime), including loss of sandbox files and history |

OpenShell can add paths of its own, such as read-only `/var/log`, when it loads a sandbox policy.
NemoClaw accepts those additions when the policy first loads, as long as every declared rule is intact, and records the loaded policy's hash.
Any later change to the loaded policy, including new additions, fails observation as drift.

The [SDK errors](../crates/nemoclaw-backend/src/error.rs), [plan checks](../crates/nemoclaw-sdk/src/deployment/plan.rs), and [lifecycle tests](../crates/nemoclaw-sdk/tests/deployment.rs) define these failure boundaries.

An ownership error is not fixed by renaming a resource, deleting `intent.json`, editing OpenTofu state, or rerunning with a fresh state path against the same resources.
Retain the original binding while investigating the selected gateway and engine.

## Correct a Document Validation Error

Schema errors identify the document field, the violated constraint, and the source line and column.
For example, `spec.services.qwen.memory.kvCacheGiB` identifies the `qwen` service; `spec.sandboxes[1]` identifies the second sandbox.
Array indices start at zero; source lines and columns start at one, and columns count characters.
Valid declaration names appear in paths, while arbitrary map keys appear as `[entry]` and rejected values remain omitted.
YAML syntax and duplicate-key errors also include source positions without copying source snippets.
Later semantic checks, such as unresolved references, retain their existing named-field diagnostics and may lack source positions.

For `kvCacheGiB`, use `0` or an integer from `4` through `12` when `gpuMemoryUtilization` is absent.
With `gpuMemoryUtilization`, `kvCacheGiB` must be omitted or zero; see the [Memory reference](reference/configuration.md#memory) for defaults and related settings.
An `empty document` error means no configuration content was supplied.
All explicit YAML tags, including `!!binary`, `!!str`, `!!map`, and `!!seq`, are rejected; write the intended value directly and quote strings when needed.
Tag-like text inside a quoted or block string is preserved.

Correct the input, then rerun plan with the same state directory before choosing apply.

## Recover a Managed Gateway Startup Failure

If a managed Docker gateway stops during readiness, the error names its container and reports the observed exit code, or `unknown` when unavailable.
Read that container's logs on the configured engine using the [log collection procedure](#inspect-an-openshell-sandbox-failure).
The readiness diagnostic omits raw engine errors and log contents because they may contain credentials.
A running but unreachable gateway reports a transport failure; check its endpoint and engine access before retrying.

Keep the YAML, matching bundle, and state directory.
After correcting the image or configuration problem, reapply using the retained state; Docker may replace disposable gateway compute while NemoClaw verifies its retained storage and keys.
If retiring the deployment, preview and [destroy](usage.md#destroy) it with the same state directory.
Gateway readiness is omitted during teardown, so failed bootstrap with saved bindings can be cleaned up before a successful reapply.
If OpenShell resources were already created, their refresh and deletion still require a reachable gateway; restore it before destroying them.

## Inference and Agent Readiness

Use [inference verification](inference.md#verify-the-result) to distinguish configuration readiness from a successful reply.
For stopped Ollama, use [the managed Ollama procedure](inference.md#run-managed-ollama); a failed inventory must not be treated as an absent model.
For a managed model or watchdog stop, inspect [retained status and logs](models.md#diagnose-and-recover-a-stopped-runtime).
For an external Ollama digest mismatch, use [the proxy guide](inference.md#use-external-ollama-through-a-managed-proxy).

| Observation | What it establishes | Next check |
|---|---|---|
| Model appears in the endpoint inventory | The service reports that model | Confirm API compatibility and an inference request |
| Apply succeeds | Declared resources pass readiness checks and each agent started | Verify inference and a native agent turn through the intended interface |
| Agent configuration changed inside the sandbox | Not reported: Fabric reports no applied configuration | Change the configuration in the deployment and apply, which replaces the sandbox |
| Forwarded native service cannot connect | Native service, forwarding, or authentication may be incomplete | Follow [interface diagnosis](interfaces.md#diagnose-failures); keep local forwarding ports consistent |
| Managed runtime stopped after a protection trip | The independent supervisor stopped inference | Inspect [retained status and logs](models.md#diagnose-and-recover-a-stopped-runtime) and correct capacity/startup conditions before explicit recovery |

Terminal sandbox apply errors name the sandbox and report the OpenShell phase, a recognized failure reason, and the main process exit code, or `unknown` when unavailable.
Recognized reasons are `ControlSupervisorExited`, `ContainerExited`, `IdentityResolutionFailed`, and `ControlSupervisorStartFailed`; other backend reasons appear as `unknown`.
`IdentityResolutionFailed` means the workload user or group could not be resolved in the pinned image; check the explicit policy's `process.run_as_user` and `process.run_as_group`.
`ControlSupervisorStartFailed` means the control supervisor could not start; inspect the sandbox policy and attached providers.
These explanations are fixed text, not the gateway's condition message.
Error, completed, stopped, and deleting phases fail immediately and retain resources.
For sandbox status conditions, the SDK excludes unrecognized reasons and raw backend condition messages because they may contain credentials.
Synchronous OpenShell validation rejections for workspace creation, sandbox creation, and provider or provider-profile deletion preserve a sanitized printable-ASCII detail of at most 1024 characters.
For example, a network endpoint ambiguity can report conflicting `allowed_ips` metadata, identifying a policy/profile address-grant disagreement.
Credential-bearing provider creation and update requests, status reads, and exec failures retain category-only diagnostics.
This rejection reporting applies to Docker, Podman, and cluster gateways.
Use the OpenShell inspection and log collection procedure below before cleanup.
If startup requires a different image or policy, change it and apply; that replaces the sandbox, deleting its files ([change paths](usage.md#choose-the-change-path)).
A failed first apply can be [destroyed](usage.md#destroy) when the retained state accounts for its resource identities.

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
Logs can contain prompts, responses, and native errors that have not passed through the SDK's secret redaction; inspect them privately before sharing excerpts.

Three sources cover most failures:

- **OpenShell's sandbox log** shows the sandbox supervisor's messages, each process's network requests with the policy decision, and why a sandbox process exited. It works on a running sandbox and on one that exited, replacing `assistant` with the declared sandbox name:

  ```sh
  openshell logs assistant --source sandbox -n 100
  ```

- **An invocation's result** names the files Fabric kept for that request in `result.artifacts`, such as the adapter's output. Read one without restarting the agent:

  ```sh
  openshell sandbox exec -n assistant --no-tty -- tail -n 100 REPLACE_WITH_ARTIFACT_PATH
  ```

- **Fabric's own message** about a failed start or other runtime operation is in the state directory's `diagnostics/fabric-SANDBOX.json`, which the apply error names; see [failure messages](#identify-the-failure).

The selected Fabric adapter owns where its harness writes anything else.
Use the original apply error and the [failure table](#identify-the-failure) to choose recovery.
Do not replay an uncertain native invocation merely to reproduce a log entry.

## Traces and Web Search

[Hermes Relay tracing](agents.md#hermes-relay-tracing) and [web search](agents.md#web-search) have their own configuration and verification limits.
Configuration readiness does not prove collector delivery, a valid Brave credential, or available quota.

Troubleshooting a production collector is tracked in [#12144](https://github.com/NVIDIA/NemoClaw/issues/12144), and testing hosted search live in [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641).
