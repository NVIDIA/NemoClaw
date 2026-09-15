<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Diagnose a Failed Deployment Operation

Retain the original YAML, matching bundle, and entire state directory when an operation fails.
Do not delete bindings or substitute a fresh state directory to bypass an ownership error.
See [state locations](state.md) and the [recovery procedure](usage.md#updates-and-recovery).

## Identify the Failure

| Symptom | Next action |
|---|---|
| Unknown field, duplicate key, or rejected combination | Compare the input with the matching [configuration reference](reference/configuration.md); an earlier schema is not automatically migrated |
| Bundle or schema hash failure | Follow [bundle rebuilding](build.md#build-a-native-bundle) and keep the selected bundle unchanged during operations |
| Deployment lock error | Check for another operation using the same state directory; a lock failure does not authorize state deletion |
| Authentication, transport, or incomplete-observation error | Restore access to the selected service; failed observation does not establish absence or authorize recreation |
| Ownership, generation, or durable identity mismatch | Inspect the selected gateway/engine and retained deployment identity; do not adopt or replace a different resource |
| Plan would remove or replace a resource | Check [update constraints](usage.md#updates-and-recovery) and the relevant configuration guide before choosing a new deployment |
| Interrupted apply | Resolve the cause and reapply the original YAML with its retained state |
| Unfinished destroy | Resume destroy with the same state; other operations refuse unfinished teardown |
| Native configuration or interface-token drift | Follow [agent interface diagnosis](interfaces.md#diagnose-failures); configuration checks do not overwrite conflicts |

The [SDK errors](../crates/nemoclaw-sdk/src/error.rs), [plan checks](../crates/nemoclaw-sdk/src/deployment/plan.rs), and [lifecycle tests](../crates/nemoclaw-sdk/tests/deployment.rs) define these failure boundaries.

## Inference and Agent Readiness

Use [inference verification](inference.md#verify-the-result) to distinguish configuration readiness from a successful reply.
For stopped Ollama, use [the recovery behavior](usage.md#updates-and-recovery); a failed inventory must not be treated as an absent model.
For a managed model or watchdog stop, use [model lifecycle guidance](models.md).
For an external Ollama digest mismatch, use [the proxy guide](inference.md#use-external-ollama-through-a-managed-proxy).

A symptom-to-log-location guide with verified collection commands for every harness and backend: **TBD**.
The current CLI has no `doctor`, `status`, or diagnostic-bundle command.

## Traces and Web Search

OpenClaw tracing and Brave search have their own [configuration and verification limits](agents.md#openclaw-tracing).
Configuration readiness does not prove collector delivery, a valid Brave credential, or available quota.

Production collector troubleshooting and end-to-end hosted search diagnostics: **TBD**.
