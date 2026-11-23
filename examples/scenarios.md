<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deployment Scenarios

Each row names an example and the machine it needs.
On a machine that has everything a row needs, the scenario runner deploys the example unchanged except for the values that bind it to that machine: a fresh deployment UID, free ports and subnet, the Docker engine, and images built from the checkout.
It then plans, applies, asks every agent the row's question, checks the reply, plans again to see no changes, and destroys the deployment.
A row whose needs the machine lacks is reported as skipped, with the need it lacks, and a paused row is reported as skipped without running.

| On | ID | Scenario | Example | Needs | Model | Ask | Expect |
|---|---|---|---|---|---|---|---|
| ✅ | T-144 | OpenClaw on a managed Docker gateway | [onboarding/openclaw.yaml](onboarding/openclaw.yaml) | docker | stub | Reply to this NemoClaw live test. | nemoclaw-stub-reply |
| ⏸️ | T-172 | Hermes with Nemotron Super on DGX Spark | [gtc-dc/hermes-dgx-spark.yaml](gtc-dc/hermes-dgx-spark.yaml) | linux, arm64, docker, gpu GB10 | Nemotron 3 Super on vLLM | What is 2 plus 2? Answer in one short sentence. | any reply |
| ⏸️ | T-359 | OpenClaw with Nemotron Super on DGX Spark | [gtc-dc/openclaw-dgx-spark.yaml](gtc-dc/openclaw-dgx-spark.yaml) | linux, arm64, docker, gpu GB10 | Nemotron 3 Super on vLLM | What is 2 plus 2? Answer in one short sentence. | any reply |
| ⏸️ | T-019 | Deep Agents with Nemotron Super on DGX Spark | [gtc-dc/deepagents-dgx-spark.yaml](gtc-dc/deepagents-dgx-spark.yaml) | linux, arm64, docker, gpu GB10 | Nemotron 3 Super on vLLM | What is 2 plus 2? Answer in one short sentence. | any reply |
| ⏸️ | T-439 | Hermes with Nemotron Super on DGX Station | [gtc-dc/hermes-dgx-station.yaml](gtc-dc/hermes-dgx-station.yaml) | linux, arm64, docker, gpu GB300 | Nemotron 3 Super on vLLM | What is 2 plus 2? Answer in one short sentence. | any reply |
| ⏸️ | T-205 | Hermes with Nemotron Super on RTX Spark with WSL2 | [gtc-dc/hermes-windows-wsl2-rtx-spark.yaml](gtc-dc/hermes-windows-wsl2-rtx-spark.yaml) | wsl2, arm64, docker, gpu RTX Spark | Nemotron 3 Super on vLLM | What is 2 plus 2? Answer in one short sentence. | any reply |
| ⏸️ | T-528 | OpenClaw and Hermes on Kubernetes with NVIDIA cloud inference | [gtc-dc/kubernetes-amd64.yaml](gtc-dc/kubernetes-amd64.yaml) | kubernetes, $NVIDIA_INFERENCE_API_KEY | Nemotron 3.5 Super VL, hosted | What is 2 plus 2? Answer in one short sentence. | any reply |

The columns mean:

- **On** is ✅ for a row the runner runs and ⏸️ for a row it skips; change it to enable or pause a scenario.
- **Needs** lists what the machine must have: `linux`, `wsl2`, `arm64`, or `amd64` for the host; `docker` for a reachable Docker engine; `gpu NAME` for an NVIDIA GPU whose name contains `NAME`; `kubernetes` for a cluster that `NEMOCLAW_CLUSTER_KUBECONFIG` names; and `$NAME` for a credential in the environment.
- **Model** is `stub` when the runner serves a stub model in place of every inference endpoint the example names, so the row needs no GPU or credential; otherwise the example's own model answers.
- **Expect** is the one word the reply must be, or `any reply` when any text passes.

## Run the Scenarios

Build the bundle and the agent images the rows use, then run from the repository root:

```sh
NEMOCLAW_TEST_BUNDLE="$PWD/dist/<platform>" \
  cargo test -p nemoclaw-e2e --test e2e -- scenarios::page --exact --ignored --nocapture
```

Set `NEMOCLAW_SCENARIOS` to a comma-separated list of IDs, such as `T-144`, to run only those rows.
To use a model that already serves on the machine instead of the services an example declares, set `NEMOCLAW_SCENARIO_MODEL_ENDPOINT` to its OpenAI-compatible `/v1` URL, `NEMOCLAW_SCENARIO_MODEL_NAME` to the model it serves, and `NEMOCLAW_SCENARIO_MODEL_KEY` to its bearer key; the row then checks the agent and its deployment but not the model service.
To use agent images built under another `IMAGE_PREFIX`, set `NEMOCLAW_SCENARIO_AGENT_REPOSITORY` to that prefix.
