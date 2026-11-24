<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Configuration Features

Use these configurations after a [single-agent deployment](../platforms/docker/README.md).
Most require an existing Docker-backed gateway and inference endpoint; the exceptions and extra prerequisites are listed for each file.
Build the selected harness images, copy the YAML, replace deployment identity and illustrative values, and follow the [shared run procedure](../README.md#prepare-and-run-a-yaml-example).

| Configuration | Purpose | Extra prerequisites and expected result |
|---|---|---|
| [multiple-sandboxes.yaml](multiple-sandboxes.yaml) | Different harnesses share inference | OpenClaw, Deep Agents, and Pi images; five independent sandboxes. This does not arrange agent-to-agent communication. |
| [multiple-models.yaml](multiple-models.yaml) | Several model choices at one provider | An endpoint serving both models; the researcher has smart and fast routes, and the writer has only fast. |
| [multiple-providers.yaml](multiple-providers.yaml) | Local and hosted inference | Two compatible endpoints and `HOSTED_API_KEY`; the researcher can select hosted or local inference. |
| [inline-inference.yaml](inline-inference.yaml) | Define a provider at its consuming route | One endpoint; one agent uses the inline provider without a shared definition. |
| [inference-tuning.yaml](inference-tuning.yaml) | Select the Responses API and output-token limit | A compatible Responses endpoint and model; the agent receives the declared limit. |
| [hermes-auth.yaml](hermes-auth.yaml) | Explicit Hermes API-key authentication | A compatible Nous endpoint and `NOUS_API_KEY`; Hermes uses the declared API-key method. |
| [explicit-policy.yaml](explicit-policy.yaml) | Declare a sandbox network policy | The named endpoint and executable must match your workload; the sandbox receives the explicit policy. |
| [web-search.yaml](web-search.yaml) | Share Brave web search across agents | Hermes images and `BRAVE_API_KEY`; two agents receive the shared search integration. Ask a search task to verify tool use. |
| [application-container.yaml](application-container.yaml) | Run an application beside an agent | Managed Docker gateway, hosted inference, and your own application image exposing `/health`; first deploy the agent, copy its sandbox ID into the application settings, then reapply. |
| [combined-openclaw.yaml](combined-openclaw.yaml) | Combine remote inference, shared policy, and several agents | Local Docker, an SSH-accessible AMD64 GPU engine, and the documented proxy; three agent sandboxes share the managed vLLM service and policy. |
| [travel-team.yaml](travel-team.yaml) | Declare researchers, a scheduler, and a buyer | DGX Spark, managed Ollama, hosted inference, and `NVIDIA_API_KEY`, `BRAVE_API_KEY`, and `BOOKINGS_API_KEY`; six Hermes sandboxes use their declared models and integrations. |

The YAML travel team registers a booking key but does not configure Hermes to send its placeholder.
Use the [HCL travel team](../hcl/travel-team/README.md) for authenticated booking, an enforced tool allowlist, templated instructions, and hand-off schemas.
Declaring a team does not itself orchestrate its tasks.

After apply, send explicit requests to each relevant agent and model route.
Check tool behavior with a task requiring the tool; runtime readiness alone does not establish the feature's result.
Follow the shared procedure for unchanged apply, export/reapply, and retained teardown.

## Verification Status

Every file receives the [shared configuration checks](../README.md#verification-status).
SDK tests also exercise feature mappings and validation; fixture integration tests exercise selected deployment paths.
These files are configuration examples, and no new live deployment, inference, or tool-use evidence is claimed.
The application example requires an application supplied by the operator, and the travel team's YAML booking limitation remains.
