<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Knowledge Foundation Examples on OpenClaw

Run the three Agent Knowledge Foundation examples as OpenClaw agents, each in its own sandbox, and grade their answers with each example's eval kit.
The examples, their data, prompts, skills and eval kits live in the Agent Knowledge Foundation examples repository, which is NVIDIA internal for now; this directory holds only the deployment, the image recipe and these steps.

| Sandbox | Example | The decision it supports | Eval kit |
|---|---|---|---|
| `supply-chain` | `supply-chain-analytics-stack` | Which customers get stock after a supplier cuts a shipment, through six questions ending in a proposal for review | `evals/supply-chain-analytics-stack/evaluate_run.py`: independent checks and a model judge |
| `market-analysis` | `market-analysis` | Six questions over a synthetic equity market: price and news joins, peers, risk, and what is likely next | `evals/market-analysis/evaluate_run.py`: reference answers, a model judge, and an optional baseline |
| `provider-billing` | `provider-billing-integrity` | Which of 80 synthetic providers to refer for investigation, and which policy supports it, through 22 questions | `evals/provider-billing-integrity/grade.py`: reference answers checked in code, with rubric tasks left for a model judge |

## How the Pieces Fit

[deployment.yaml](deployment.yaml) is one deployment with three sandboxes.
They share one image, one inference route and one API integration, so one gateway serves all three; each sandbox still has its own workspace, runtime and network policy, and each eval kit grades one sandbox's run.

- **Agent:** OpenClaw, through Fabric, on `nvidia/nemotron-3.5-super-vl-120b-a12b` at `integrate.api.nvidia.com`.
- **Skills:** the examples' 14 skills, which their repository vendors and pins in `skills.lock.json`, in `/opt/akf/skills` of the image. Each agent loads that folder through `skills.directories`, with `duplicates: reject`.
- **Tools:** OpenClaw's shell and file tools run the examples' Python utilities. [The Dockerfile](Dockerfile) adds Python 3.12 with the examples' CPU libraries as `python3.12`; the sandbox's `python3` is Fabric's own environment, without them.
- **Hosted models the tools call:** Nemotron embed, rerank and parse, and Kumo, on `integrate.api.nvidia.com` and `ai.api.nvidia.com`. The `nvidia` integration sends the gateway-held key to both hosts and shows the sandbox only a placeholder, in `NVIDIA_API_KEY`, the variable the examples' utilities read.
- **Network:** each sandbox uses the isolated preset: inference, the two NVIDIA hosts for the harness's executables and the processes they start, and nothing else.
- **Run directory:** you prepare it on your machine with the example's own commands, upload it to the sandbox, and download it after the run for the eval kit. The agent never sees the eval kit or its reference answers.

## Prerequisites

- Linux with Docker Buildx and the [containerd image store](../../docs/build-deploy/build.md#build-agent-images), and the [build prerequisites](../../docs/build-deploy/build.md).
- A checkout of the Agent Knowledge Foundation examples repository, called `$AKF` below.
- A build.nvidia.com API key in `NVIDIA_API_KEY`. It pays for the agent's model and the tools' hosted models; hosted requests may incur charges.
- Python 3.12 on your machine, for preparing run directories and running the eval kits.
- The OpenShell CLI, to upload and download run directories and invoke the agents.

No GPU is needed.

## Build the Images and the Bundle

Run commands from the repository root.
Build the OpenClaw image and the bundle, then the derived image from the examples checkout:

```sh
cargo images build --platform linux/arm64 openclaw
cargo run --locked -p nemoclaw-build -- bundle --platform linux_arm64
docker build --build-context akf="$AKF" -t nc-akf:akf-openclaw examples/agent-knowledge-foundation
docker image inspect nc-akf:akf-openclaw --format '{{.Id}}'
```

On AMD64, use `linux/amd64` and `linux_amd64`.
The derived image keeps everything NemoClaw reads from the base; see [derived agent images](../../docs/build-deploy/derived-images.md).
Its Python packages follow the version ranges in the examples' own requirement files, so rebuilding later can install newer releases within them.

## Deploy

Copy the deployment, give it a fresh UUID, and replace the three zero digests with the image ID printed above:

```sh
mkdir -p .local/akf
cp examples/agent-knowledge-foundation/deployment.yaml .local/akf/deployment.yaml
# Edit .local/akf/deployment.yaml: metadata.uid and the image digests.
export NVIDIA_API_KEY=...   # or let plan and apply prompt for it
dist/linux_arm64/bin/nemoclaw plan --state-dir .local/akf/state .local/akf/deployment.yaml
dist/linux_arm64/bin/nemoclaw apply --state-dir .local/akf/state .local/akf/deployment.yaml
```

Apply prints the gateway and workspace selection and each agent's runtime ID and invoke command.
Run the selection lines in each terminal you use below:

```sh
unset OPENSHELL_GATEWAY
export OPENSHELL_GATEWAY_ENDPOINT=http://127.0.0.1:17931
export OPENSHELL_WORKSPACE=nc-...   # as apply printed
```

## Run an Example

Each example runs the same way: prepare its run directory, upload it, ask the agent, then download the result.

1. Prepare the run directory with the example's own steps, without the parts this deployment lacks: the GPU path and Auto Ontology.

   ```sh
   R=.local/akf/runs
   # supply-chain: the prompt, the scenario, and the runtimes the agent may use.
   mkdir -p $R/supply-chain
   cp $AKF/examples/supply-chain-analytics-stack/{scenario.json,PROMPT.md,RUNTIMES.md,models.json} $R/supply-chain/
   python3.12 $AKF/scripts/install_skills.py $R/supply-chain/.agents/skills
   # Then delete the GPU and Auto Ontology entries from $R/supply-chain/RUNTIMES.md.

   # market-analysis: its preparation script writes settings.json and the data.
   python3.12 $AKF/examples/market-analysis/utilities/prepare_run.py $R/market-analysis --ontology off --gpu off

   # provider-billing: the prompt, the commands, the data and the utilities, without earlier receipts.
   mkdir -p $R/provider-billing
   (cd $AKF/examples/provider-billing-integrity && cp -r PROMPT.md RUNBOOK.md models.json data utilities ontology "$OLDPWD/$R/provider-billing/")
   python3.12 $AKF/scripts/install_skills.py $R/provider-billing/.agents/skills
   ```

   Copy no part of `$AKF/evals`: it holds the reference answers, and the agent must not see them.

2. Upload it into the sandbox's workspace, where it becomes `/sandbox/workspace/<directory name>`. `--no-git-ignore` is needed because `.local` is ignored in this repository and the upload would otherwise skip every file:

   ```sh
   openshell sandbox upload --no-git-ignore provider-billing $R/provider-billing /sandbox/workspace
   ```

3. Ask the agent, replacing `RUNTIME_ID` with the ID apply printed for the sandbox.
   An answer can take tens of minutes; the harness allows each request an hour.

   ```sh
   printf '%s' '"Your run directory is /sandbox/workspace/provider-billing. Read PROMPT.md there and answer every question as it says, writing answers/<id>.json and answers/run.json in that directory; RUNBOOK.md has the commands. Work only in that directory. Run every Python command with python3.12, which has pandas and the Kumo client; python3 is a different environment without them. This machine has no GPU and no Auto Ontology deployment."' |
     openshell sandbox exec -n provider-billing --no-tty -- \
     fabric-agent-ctl invoke --agent provider-billing --runtime-id RUNTIME_ID --input -
   ```

   For the other two, name their run directory and their instructions: `PROMPT.md` and `RUNTIMES.md` for `supply-chain`, `RUNBOOK.md` for `market-analysis`.

4. Download the run directory; the command copies the directory's contents into the destination:

   ```sh
   openshell sandbox download provider-billing /sandbox/workspace/provider-billing .local/akf/results/provider-billing
   ```

Replacing a sandbox, for example by changing its image, deletes its workspace; download what you need first.

## Evaluate a Run

Run each example's eval kit on your machine, against the downloaded run directory, as the examples repository describes.
The model judges call `NVIDIA_INFERENCE_ENDPOINT` with `NVIDIA_INFERENCE_API_KEY`; for build.nvidia.com, set them from your key and pick a judge other than the agent's model:

```sh
export NVIDIA_INFERENCE_ENDPOINT=https://integrate.api.nvidia.com/v1 NVIDIA_INFERENCE_API_KEY="$NVIDIA_API_KEY"
JUDGE=nvidia/nemotron-3-ultra-550b-a55b
P=.local/akf/results
python3.12 $AKF/evals/provider-billing-integrity/grade.py $P/provider-billing $P/provider-billing-eval
python3.12 $AKF/evals/market-analysis/evaluate_run.py $P/market-analysis $P/market-analysis-eval --judge $JUDGE
python3.12 $AKF/evals/supply-chain-analytics-stack/evaluate_run.py $P/supply-chain $P/supply-chain-eval --judge $JUDGE
```

`grade.py` checks the set, exact and numeric answers in code and writes the rubric tasks to `judge-episodes.json` for a model judge.
The supply-chain kit also reads a harness trace when given `--trace`; this procedure has none to give it.
The eval kits' arm comparisons need several graded runs per arm; prepare one run directory per arm, as each kit describes.

## What Is Not Covered

- **GPU paths:** the image has no CUDA libraries and the sandboxes request no GPU, so cuDF, cuML, cuGraph and cuOpt are unavailable; the agents use the CPU controls the examples allow, and their GPU questions report what is blocked.
- **Auto Ontology:** no deployment is included, and the ontology questions report it as unavailable. A deployment you run could be reached through a second `kind: api` integration for its URL with `sandboxEnv: AUTO_ONTOLOGY_API_TOKEN`, with its URL given to the agent in the request; this has not been tried.
- **Equivalence with the published results:** those runs used other harnesses and models; these examples change the harness and the model, so expect different answers and scores.
- **Harness traces:** OpenClaw's session history stays inside the runtime, so the supply-chain kit's trace checks have no input.
- **Persistence:** run directories live in each sandbox's workspace and are lost when the sandbox is replaced; mount [volumes](../../docs/build-deploy/state.md#keep-agent-files-on-mounted-volumes) to keep them.
