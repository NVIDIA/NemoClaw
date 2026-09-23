<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw terminal UX proposal

Recorded 2026-09-22.
Status: historical proposal, not the current CLI contract.
See the [CLI reference](../../../../docs/reference/cli.md) for implemented behavior, including inline Ratatui progress, output formats, color, and exit codes.
Baseline inspected: NemoClaw revision `a098e179c8789c732c2ead44fcadeec3a2a59a93`.
At that revision, plan defaults to text and accepts `-o json`; apply/destroy results are JSON only, with text progress on stderr.
Authoritative boundaries remain in the repository's `docs/design/scope.md`; operational retention is described in `docs/usage.md` and `docs/state.md`.

## Shared contract

- Default to text for plan, apply, and destroy; offer `-o json` consistently.
- In JSON mode, emit one terminal result on stdout, including handled operation failures; keep progress on stderr and independently suppressible.
- Specify argument-parsing failures separately before implementing the JSON contract; do not imply that a killed process or failed output stream can always emit a result.
- Use `--verbose` for internal addresses, digests, steps, and precise timings.
- Proposed exit codes: success 0, operation failure 1, usage error 2, user interruption 130.
- Expose plan completeness explicitly in JSON; decide and document the exit behavior for a successfully produced but incomplete plan.
- Display operation, input when applicable, and state-directory identity at the start.
- Prefer `11m 7s` to `667.087s`; preserve words when color is disabled.

## Plan

Use configuration names as primary identities.
Show relevant before/after values for updates, and replacement consequences such as downtime or lost files.
Group supporting changes only when every action remains accounted for; never equate workload counts with OpenTofu resource counts.
Unknown/unmapped resources must remain visible using their native address.

Illustrative complete plan:

```text
Plan · deployment.yaml
State: /path/to/deployment-state

ACTION   RESOURCE              CHANGE
create   gateway               http://127.0.0.1:17961
create   inference/qwen        vLLM · Mia-AiLab/Qwen3.8-Flash-Next-NVFP4
create   sandbox/assistant     OpenClaw

Supporting changes: 2 image bindings, 1 provider, 1 provider profile

No resources changed.
```

An unchanged, fully observed plan says `No resource changes planned.`
An incomplete plan says `Plan incomplete`, lists known changes, and explains what remains unknown even when the change list is empty.
Plan does not imply tested inference, reserve resources, or replace apply's checked planning.

## Apply and progress

Keep completed milestones and a compact active block in the normal terminal flow.
Represent concurrent resources together.
Render measured download bytes where available; report model loading only when the runtime supplies that stage.
Otherwise use `Waiting for inference readiness`.

```text
done     Configuration checked
done     Gateway ready                                      2s
running  inference/qwen · loading model                  6m 12s
waiting  sandbox/assistant · requires inference readiness

Elapsed: 6m 15s
```

Show start and stage changes immediately; update elapsed time during waits.
Use append-only stage changes and approximately 30-second heartbeats in CI/logs.
Do not repeat internal initialization or show guessed overall percentages and loading ETAs.

```text
Apply complete · 11m 7s

Gateway             ready · http://127.0.0.1:17961
Inference/qwen      readiness confirmed
Sandbox/assistant  ready
Fabric health      unsupported by the installed runtime

Model and agent responses were not tested.
```

Readiness is an observation at completion, not ongoing monitoring.
Unsupported health is distinct from healthy; unknown supported health cannot become success.
An unchanged apply still reports the readiness/health checks it actually performed.

## Destroy

The preview separates REMOVE and KEEP in user terms.
REMOVE names sandbox files and conversation history, managed workload processes, and deployment provider registrations/profiles as applicable.
KEEP names model downloads/prepared data, retained credential storage, gateway database/keys/network, OpenShell workspace, local state, and images as applicable.
The retained OpenShell workspace does not preserve sandbox files.
Use actual deployment resources; externally owned services are not deletion targets.

```text
Destroy complete · 8s

Deployment workloads removed.
Model cache, gateway storage, and deployment state retained.
```

Repeated completed destroy says `Nothing to remove. Retained data unchanged.`
Do not claim measured cache sizes, a complete retained-file inventory, or verified absence without corresponding observations.

## Errors and interruption

Present operation/resource, cause, measured evidence, known remaining state, and a valid next action.
Example for a memory failure actually observed during apply:

```text
Apply failed · inference/qwen

The runtime stopped because host memory fell below its configured limit.
Observed free memory: 1.0 GiB
Required minimum:    3.0 GiB

The deployment is partially applied.
Model cache and recorded deployment state were retained.

Free host memory, then retry:
  nemoclaw apply deployment.yaml --state-dir /path/to/deployment-state
```

Include a diagnostic file path only if written, and retain the actionable upstream cause rather than only `OpenTofu failed`.
Configuration errors identify file, field, expected value, and source position when available, without exposing credentials.
After partial failures, report unknown state explicitly instead of claiming rollback or complete cleanup.
For Ctrl-C, report interruption and possible completed changes; finish state handling before issuing recovery instructions.
Recovery commands must match the recorded operation boundary; do not suggest apply during unfinished teardown.

## Responsibilities and acceptance

The CLI owns presentation and exit codes; the SDK supplies typed outcomes and progress.
OpenTofu owns actions, graph execution, and resource state; runtime observations supply startup stages; Fabric supplies health semantics.
Do not create a CLI resource poller or recover stages from arbitrary prose logs.
Richer observations may require changes at their owning boundary before a renderer can show them.

Validate six transcripts: unchanged run, long download/startup, concurrent work, incomplete plan, partial failure/interruption, and destroy followed by repeated destroy.
Also verify narrow terminals, independent stdout/stderr redirection, plain output, error visibility, and JSON failure/completeness semantics.
