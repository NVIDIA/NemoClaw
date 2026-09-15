<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Diagnose a Failed Deployment Operation

Retain the original YAML, matching bundle, and entire state directory when an operation fails.
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

The [SDK errors](../crates/nemoclaw-sdk/src/error.rs), [plan checks](../crates/nemoclaw-sdk/src/deployment/plan.rs), and [lifecycle tests](../crates/nemoclaw-sdk/tests/deployment.rs) define these failure boundaries.

An ownership error is not fixed by renaming a resource, deleting `intent.json`, editing OpenTofu state, or rerunning with a fresh state path against the same resources.
Retain the original binding while investigating the selected gateway and engine.

## Inference and Agent Readiness

Use [inference verification](inference.md#verify-the-result) to distinguish configuration readiness from a successful reply.
For stopped Ollama, use [the recovery behavior](usage.md#updates-and-recovery); a failed inventory must not be treated as an absent model.
For a managed model or watchdog stop, use [model lifecycle guidance](models.md).
For an external Ollama digest mismatch, use [the proxy guide](inference.md#use-external-ollama-through-a-managed-proxy).

| Observation | What it establishes | Next check |
|---|---|---|
| Model appears in the endpoint inventory | The service reports that model | Confirm API compatibility and an inference request |
| Apply's API probe succeeds | The configured route answers the probe | Complete a native agent turn through the intended interface |
| Agent configuration drift | Native settings differ from retained intent | Restore expected settings; checks do not overwrite them |
| Dashboard cannot connect | Native service, forwarding, authentication, or browser pairing may be incomplete | Follow [interface diagnosis](interfaces.md#diagnose-failures); keep local forwarding ports consistent |
| Managed runtime stopped after a protection trip | The independent supervisor stopped inference | Inspect the [model lifecycle](models.md) and correct capacity/startup conditions before explicit recovery |

A symptom-to-log-location guide with verified collection commands for every harness and backend: **TBD**.
The current CLI has no `doctor`, `status`, or diagnostic-bundle command.

## Traces and Web Search

OpenClaw tracing and Brave search have their own [configuration and verification limits](agents.md#openclaw-tracing).
Configuration readiness does not prove collector delivery, a valid Brave credential, or available quota.

Production collector troubleshooting and end-to-end hosted search diagnostics: **TBD**.
