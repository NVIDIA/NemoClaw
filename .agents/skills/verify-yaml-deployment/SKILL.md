---
name: verify-yaml-deployment
description: Verify, as a configuration author, that a hand-written NemoClaw v1 YAML deploys a Fabric agent on a local Docker gateway, gets a reply, exports, reapplies, and tears down cleanly. Choose the agent and target from the files under agents/ and targets/. Use after changing configuration, compilation, provider, Fabric, OpenShell, or image inputs, before claiming that an agent works on a target.
disable-model-invocation: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Verify a Hand-Written YAML Deployment

This skill drives the `nemoclaw` CLI the way a configuration author does: start from a repository example, edit it into one YAML file, plan, apply, talk to the agent, export, reapply, and destroy.
It owns one deployment per run and never touches another.
The [live tests](../../../docs/contributing/live-tests.md) stay the gate; turn a journey that must hold on every change into a Rust live test.

## Scope

- **Gateway:** a managed Docker gateway on the host running the skill. Kubernetes, OpenShift, Podman, and external gateways launch, inspect, and clean up differently; they need their own skill.
- **Agent:** one sandbox with one Fabric agent, chosen from [agents/](agents/).
- **Target:** one host type, chosen from [targets/](targets/), which names the example to start from and the inference source.

Each agent file lists the agent–target pairs proven live, with the revision and date.
A pair that isn't listed is unproven: say so with the result.

## Choose the Agent and Target

| Agent file | `AGENT` | Harness |
|---|---|---|
| [agents/openclaw.md](agents/openclaw.md) | `openclaw` | `nvidia.fabric.openclaw` |
| [agents/hermes.md](agents/hermes.md) | `hermes` | `nvidia.fabric.hermes` |

| Target file | `TARGET` |
|---|---|
| [targets/dgx-spark.md](targets/dgx-spark.md) | `dgx-spark` |

Add a file for a new agent or target before driving it; copy the shape of an existing one.
Read both chosen files before launching: they set variables and add steps that this file refers to.

Ask the user before a run that sends model requests to a shared or paid endpoint, needs credentials, downloads a model, or uses sudo.

## Launch

Run every command from the repository root, in one shell; the variables carry between steps.

### Choose This Run's Identity

```sh
AGENT=hermes
TARGET=dgx-spark
RUN=$(date -u +%Y%m%dT%H%M%SZ)
RUN_DIR=$HOME/nemoclaw-verify/$TARGET-$AGENT/$RUN
EVIDENCE=$RUN_DIR/evidence
STATE=$RUN_DIR/state
mkdir -p "$EVIDENCE"
UID_=$(cat /proc/sys/kernel/random/uuid)
WORKSPACE=nc-$(printf %s "$UID_" | sha256sum | cut -c1-16)
echo "$AGENT $TARGET $UID_ $WORKSPACE" > "$EVIDENCE/identity.txt"
```

Pick a gateway port and a `/24` that nothing on the engine uses:

```sh
ss -ltn | awk '{print $4}' | grep -E ':17[0-9]{3}$'
docker network ls -q | xargs docker network inspect --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}' | grep 172.30.
GATEWAY_PORT=17911
SUBNET=172.30.190.0/24
echo "$GATEWAY_PORT $SUBNET" >> "$EVIDENCE/identity.txt"
```

The committed examples use gateway ports 17901–17909 and networks 172.30.180.0/24–172.30.188.0/24; stay outside them and outside anything already listed.
The target file says how this host reaches Docker; where it uses sudo, put `sudo` before every `docker` command in this skill.

### Build the Bundle and Image

```sh
cargo ci bundle
PLATFORM=$(ls dist)
BUNDLE=$RUN_DIR/bundle
cp -a "dist/$PLATFORM" "$BUNDLE"
sha256sum "$BUNDLE/bin/nemoclaw" > "$EVIDENCE/bundle.sha256"
git rev-parse HEAD > "$EVIDENCE/revision.txt"
cargo images build --platform "linux/$(uname -m | sed 's/aarch64/arm64/;s/x86_64/amd64/')" "$AGENT"
IMAGE=$(docker image inspect "nc-fabric:$AGENT" --format '{{index .RepoDigests 0}}')
echo "$IMAGE" > "$EVIDENCE/image.txt"
```

Copy the bundle so a later `cargo ci bundle` can't change it mid-run, as [Spark and Fabric](../../../docs/contributing/live-tests.md#spark-and-fabric) advises.
`ls dist` must print one platform; remove stale platform directories first.
The agent file says when to replace `IMAGE`, such as with a patched image for a native interface.

### Choose the Inference Source

The target file names one of these and gives its commands:

- **Existing endpoint:** an OpenAI-compatible server already running on the host or network. The YAML declares an external provider whose credential is an environment reference. Read the server and its key; never change them.
- **Managed service from the example:** the example's `services` entry. Its first apply can download tens of gigabytes and load for many minutes; ask before choosing it.
- **Hosted API:** an endpoint such as NVIDIA's. It needs a credential and can incur charges; ask before choosing it.

Each source sets `PROVIDER_KEY_ENV` (the variable the YAML's credential names, or empty) and exports that variable.

### Write the YAML

Start from the example the target file names for this agent, then apply these edits, and only these:

```sh
cp "$EXAMPLE" "$RUN_DIR/deployment.yaml"
```

1. `metadata.uid` → `$UID_`; `metadata.name` → `verify-$AGENT-$TARGET`.
2. `spec.gateway.endpoint` → `http://127.0.0.1:$GATEWAY_PORT`; `spec.gateway.networkCIDR` → `$SUBNET`.
3. Every `image.ref` and service `image` with a zero digest → the built references (`$IMAGE` for the sandbox).
4. The inference source's edits from the target file, such as replacing `services` and `inferenceProviders`.
5. The agent file's edits, such as `serviceExposures` and `harness.settings`.

Edit the file by hand or with the target file's snippet; keep the sandbox name `assistant`.
Then check that it parses and save it:

```sh
cp "$RUN_DIR/deployment.yaml" "$EVIDENCE/deployment.yaml"
grep -c "$UID_" "$RUN_DIR/deployment.yaml"
```

Starting from the example keeps the run honest: a changed example changes what the skill tests.
Never copy a secret value into the YAML; credentials are environment references.

### Plan and Apply

```sh
nc() {
  case "$1" in plan|apply) set -- "$@" --non-interactive ;; esac
  "$BUNDLE/bin/nemoclaw" "$@" --state-dir "$STATE"
}
nc plan "$RUN_DIR/deployment.yaml" --progress off > "$EVIDENCE/plan.txt" 2>&1
nc apply "$RUN_DIR/deployment.yaml" --progress plain > "$EVIDENCE/apply.txt" 2>&1
tail -20 "$EVIDENCE/apply.txt"
```

`--non-interactive` applies only to `plan` and `apply`; `export` and `destroy` reject it.
The target file gives the `nc` variant for its Docker access and credential passing.
The first plan lists the gateway, provider, sandbox, and workspace to create; apply ends with `Apply complete` and prints `OpenShell workspace: $WORKSPACE`.
When the YAML declares `serviceExposures`, apply also lists each one's URL under **Service URLs**, as `assistant/SERVICE: URL`; plan never does, because the gateway assigns the URL at creation.
It also prints `Model and agent responses were not tested.`: the deployment isn't ready until [deploy-and-answer](features/deploy-and-answer.md) gets a reply.

## Doctor

Read-only; run it before the first drive, after any surprise, and after any sandbox replacement:

```sh
export PATH=$HOME/.local/bin:$PATH OPENSHELL_GATEWAY_ENDPOINT=http://127.0.0.1:$GATEWAY_PORT OPENSHELL_WORKSPACE=$WORKSPACE
unset OPENSHELL_GATEWAY
grep -q "uid: $UID_" "$RUN_DIR/deployment.yaml" && jq -e --arg uid "$UID_" '.document.metadata.uid == $uid' "$STATE/intent.json"
sha256sum -c "$EVIDENCE/bundle.sha256"
docker container ls --filter "label=nemoclaw.nvidia.com/uid=$UID_" --format '{{.Names}} {{.Status}}'
openshell --version
openshell sandbox list
SANDBOX_CONTAINER=$(docker ps --filter "label=openshell.ai/managed-by=openshell" --format '{{.Names}}' | grep -E "^openshell-$WORKSPACE--assistant-[0-9a-f-]+$")
docker inspect "$SANDBOX_CONTAINER" --format '{{.Image}}'
```

Pass when the intent's UID is this run's, the bundle checksum matches, the gateway container is `Up`, the OpenShell CLI matches `versions.json`'s `openshell`, `assistant` is `Ready`, and the sandbox's image ID is the one `$EVIDENCE/image.txt` names.
Install a missing OpenShell CLI from its matching release into `~/.local/bin`, checking the archive against the release's checksum file.
Never act on a workspace or UID other than this run's.

## Drive

Follow the [feature map](features/README.md), and the agent file's extra features.
Run [deploy-and-answer](features/deploy-and-answer.md) first: it establishes readiness for the others.
Run one step at a time: two model requests at once can make a reply arrive after the check that waits for it, and two builds at once wait on Cargo's lock and can run stale code.

## Evidence

Write everything under `$EVIDENCE`, outside the checkout and the state directory, so it survives cleanup.
Each feature file names its files.
Keep credentials out of evidence: capture command output, never request headers, and never run with `set -x`.
Give each screenshot a new file name; an image viewer can show a cached earlier file at the same path.
Before handing off, check that no credential value appears:

```sh
[ -z "$PROVIDER_KEY_ENV" ] || grep -rlF "$(printenv "$PROVIDER_KEY_ENV")" "$EVIDENCE" | wc -l
grep -rl -E '(TOKEN|KEY)=[^ ]{16,}|Bearer [A-Za-z0-9_-]{20,}' "$EVIDENCE" | wc -l
```

Both counts must be 0.

## Cleanup

```sh
nc plan --destroy > "$EVIDENCE/destroy-plan.txt" 2>&1
nc destroy > "$EVIDENCE/destroy.txt" 2>&1
nc plan --destroy > "$EVIDENCE/destroy-check.txt" 2>&1
grep -q 'No resource changes planned.' "$EVIDENCE/destroy-check.txt" && echo DESTROYED
```

Continue only after `DESTROYED` prints.
When destroy fails, keep the state directory and the bundle: they are the only record of what to remove. Fix the cause and destroy again; [Updates and Recovery](../../../docs/usage.md#updates-and-recovery) covers interrupted operations.
Run destroy and the removal below in one sequence, never concurrently: removing the state or bundle mid-destroy fails it and strands the deployment.

Destroy retains the gateway's storage and, for a managed model service, its model data.
Remove what this run created with [Remove Retained Resources](../../../docs/usage.md#remove-retained-resources), selecting by this run's UID only:

```sh
owner_label="label=nemoclaw.nvidia.com/uid=$UID_"
docker container ls --all --filter "$owner_label" --format '{{.Names}} {{.Status}}'
docker volume ls --filter "$owner_label" --format '{{.Name}}'
docker network ls --filter "$owner_label" --format '{{.Name}}'
```

Continue only when every name starts with `$WORKSPACE` and no container is running, then:

```sh
docker container ls --all --quiet --filter "$owner_label" | xargs -r docker container rm
docker volume ls --quiet --filter "$owner_label" | xargs -r docker volume rm
docker network ls --quiet --filter "$owner_label" | xargs -r docker network rm
{ docker container ls --all --quiet --filter "$owner_label"; docker volume ls --quiet --filter "$owner_label"; docker network ls --quiet --filter "$owner_label"; } | wc -l
docker ps --all --format '{{.Names}}' | grep -c "^openshell-$WORKSPACE--" || true
rm -rf "$STATE" "$BUNDLE" "$RUN_DIR/pw"
ls "$EVIDENCE"
```

Both counts must be 0, and the evidence must still list.
Remove images only when this run built them and no other deployment uses them; the agent file names any it builds.
Keep a downloaded model when the user may reuse it; removing it is the user's decision.
Never remove anything without this run's UID; never stop processes or containers by name.
Run cleanup after a failed run too.

### Without State

If the state directory is lost, NemoClaw can't destroy the deployment: there is no adoption workflow.
Remove its parts by the run's identity, in this order, after confirming each name belongs to `$WORKSPACE`:

```sh
export OPENSHELL_GATEWAY_ENDPOINT=http://127.0.0.1:$GATEWAY_PORT OPENSHELL_WORKSPACE=$WORKSPACE
openshell workspace list
openshell sandbox delete assistant
openshell provider list
openshell provider delete REPLACE_WITH_PROVIDER_NAME
docker container ls --all --filter "$owner_label" --format '{{.Names}} {{.Status}}'
docker container stop "$WORKSPACE-gateway"
```

`openshell workspace list` must show `$WORKSPACE` labeled with `$UID_`; stop otherwise.
Then run the removal above; with its gateway stopped, the volume and network come off too.

## Report

State the agent, target, revision, inference source, and each feature's result with its evidence file.
List the agent file's known gaps that applied.
Add the pair to the agent file's proof table only after a full pass, including cleanup.

## Hand Off

Keep the map current with the [maintain-verification-skill](../maintain-verification-skill/SKILL.md) skill.
