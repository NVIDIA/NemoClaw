---
name: verify-fabric-boundary
description: Verify, as a user of a Fabric-managed agent on a DGX Spark, the NemoClaw–NeMo Fabric boundary — inference, native tools and interfaces, skills, plugins, mounted extensions, and their retention across runtime restart, stop/start, recreation, a configuration change, restore, and teardown. Choose the agent from the files under agents/. Use after changing adapters, harness images, Fabric, OpenShell, mounts, or lifecycle code, before claiming that an agent's native capabilities work through NemoClaw.
disable-model-invocation: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Verify the Fabric Boundary

This skill drives one Fabric-managed agent the way its user does: through its native tools, interfaces, skills, and plugins, across every lifecycle transition NemoClaw offers.
It checks desired-state assertions: each check records whether the agent does what a user of that agent expects through NemoClaw, not what the selected revision happens to support.
It reuses [verify-yaml-deployment](../verify-yaml-deployment/SKILL.md) for the run's identity, build, inference, base YAML, plan and apply, doctor, credential scan, and cleanup, and owns only the Fabric-boundary additions.
It owns one deployment per run and never touches another.
The [live tests](../../../docs/contributing/live-tests.md) stay the gate; turn a check that must hold on every change into a Rust live test.

## Scope

- **Gateway:** a managed Docker gateway on the DGX Spark running the skill, as in [verify-yaml-deployment's scope](../verify-yaml-deployment/SKILL.md#scope).
- **Agent:** one sandbox named `assistant` with one Fabric agent, chosen from [agents/](agents/).
- **Target:** [dgx-spark](../verify-yaml-deployment/targets/dgx-spark.md) only. Another host type needs its own target file and proof first.
- **Run:** one deployment, one pass through the 12 [lifecycle phases](features/README.md#lifecycle-phases), and one teardown. Every selected check gets an outcome: 136 checks for `hermes` and `openclaw`, 131 for `deepagents-code`.

Each agent file lists the agent–target pairs run to completion, with the revision, date, and counts by outcome.
A pair that isn't listed is unproven: say so with the result.

## Choose the Agent and Target

| Agent file | `AGENT` | Harness | Checks |
|---|---|---|---|
| [agents/hermes.md](agents/hermes.md) | `hermes` | `nvidia.fabric.hermes` | 136 |
| [agents/openclaw.md](agents/openclaw.md) | `openclaw` | `nvidia.fabric.openclaw` | 136 |
| [agents/deepagents-code.md](agents/deepagents-code.md) | `deepagents-code` | `nvidia.fabric.langchain.deepagents-code` | 131 |

| Target file | `TARGET` |
|---|---|
| [../verify-yaml-deployment/targets/dgx-spark.md](../verify-yaml-deployment/targets/dgx-spark.md) | `dgx-spark` |

Read the chosen agent file here, the matching [verify-yaml-deployment agent file](../verify-yaml-deployment/agents/), and the target file before launching: they set variables and add steps that this file refers to.
The agent file here holds the Fabric-boundary YAML edits, the native binding hints, and the prompt constraints for that harness.

Ask the user before every run: each run uses the Spark's GPU through its inference source, and some sources need credentials or a paid service.
Also ask before a run that downloads a model, uses sudo, or installs a plugin package from the network.
Drive one agent per run; run agents one after another, with cleanup verified between them.

## Launch

Run every command from the repository root, in one shell; the variables carry between steps.

### Choose This Run's Identity

Run [Choose This Run's Identity](../verify-yaml-deployment/SKILL.md#choose-this-runs-identity), then name this run's caller volumes and start its logs:

```sh
SKILL_DIR=$PWD/.agents/skills/verify-fabric-boundary
WORKSPACE_VOLUME=$WORKSPACE-fb-workspace
ARTIFACTS_VOLUME=$WORKSPACE-fb-artifacts
echo "$WORKSPACE_VOLUME $ARTIFACTS_VOLUME" >> "$EVIDENCE/identity.txt"
printf '# Findings\n' > "$EVIDENCE/findings.md"
```

### Build the Bundle and Image

Run [Build the Bundle and Image](../verify-yaml-deployment/SKILL.md#build-the-bundle-and-image) unchanged.

### Choose the Inference Source

Run [Choose the Inference Source](../verify-yaml-deployment/SKILL.md#choose-the-inference-source) with the target file's commands.
Record the chosen source and model in `$EVIDENCE/identity.txt`; results bound to that model don't cover another.

### Write the YAML

Run [Write the YAML](../verify-yaml-deployment/SKILL.md#write-the-yaml), all five edits, then add the edits below before saving `$EVIDENCE/deployment.yaml`.

### Add the Fabric-Boundary YAML Edits

Every agent gets the same two caller volumes:

1. Under `spec.gateway.config`, add `openshell.drivers.docker` with `allow_driver_config: true`.
2. Under `spec.sandboxes.assistant`, add `driverConfig.docker.mounts`:

   ```yaml
   driverConfig:
     docker:
       mounts:
         - type: volume
           source: REPLACE_WITH_WORKSPACE_VOLUME
           target: /sandbox/workspace
           read_only: false
         - type: volume
           source: REPLACE_WITH_ARTIFACTS_VOLUME
           target: /sandbox/artifacts
           read_only: false
   ```

   Replace the two sources with `$WORKSPACE_VOLUME` and `$ARTIFACTS_VOLUME`.
   [Keep Agent Files on Mounted Volumes](../../../docs/state.md#keep-agent-files-on-mounted-volumes) explains each field.
3. Add the edits in the chosen agent file's **Fabric-Boundary YAML Edits** section: its skill path for `/sandbox/workspace/skills`, its native tool and plugin locations under `/sandbox/workspace/extensions`, its plugin and tool settings, and its interfaces.

The workspace volume has this layout; the feature files seed or read each path:

| Path | Contents |
|---|---|
| `/sandbox/workspace/skills/` | Mounted skills, starting with the supplied `capability-probe` skill |
| `/sandbox/workspace/scripts/` | The supplied script; the agent writes the generated script here |
| `/sandbox/workspace/extensions/tools/` | Mounted native tools, supplied and generated |
| `/sandbox/workspace/extensions/plugins/` | Mounted plugins, supplied and generated |
| `/sandbox/workspace/fixtures/` | Each phase's fresh input files |
| `/sandbox/workspace/results/` | Files the agent writes for a check |
| `/sandbox/workspace/retained/` | The workspace retention marker |

The artifacts volume holds `/sandbox/artifacts/retained/` with the artifacts retention marker, beside the adapter's native state.
Use only fields the selected image's adapter declares.
A capability with no declared field is not a reason to invent a key: the matching checks fail with a finding.

Save the baseline that Config change and Restore compare against:

```sh
cp "$RUN_DIR/deployment.yaml" "$EVIDENCE/deployment.yaml"
cp "$RUN_DIR/deployment.yaml" "$EVIDENCE/baseline.yaml"
sha256sum "$EVIDENCE/baseline.yaml" > "$EVIDENCE/baseline.sha256"
```

### Record the Native Bindings

Before the first apply, write `$EVIDENCE/bindings.md`: for each feature, the YAML fields it relies on, the native mechanism it uses, and the evidence for that choice.
Resolve each binding against the selected YAML, the image's adapter descriptor, and that image's harness source and executable help, in that order.
The agent file's hints are observed at a named revision; re-resolve them against the selected image and record any difference.
Fill in every prompt placeholder that the [driving conventions](features/README.md#driving-conventions) list.
Stop researching a binding once the evidence shows the route or the missing layer; a missing layer is a finding, not a reason to try speculative settings.

### Provision and Seed the Volumes

Run the plan line from [Plan and Apply](../verify-yaml-deployment/SKILL.md#plan-and-apply) first, and check that it names `$WORKSPACE`:

```sh
grep -F "$WORKSPACE" "$EVIDENCE/plan.txt"
```

Create both volumes with OpenShell's admission labels and this run's UID, and give them to the sandbox identity `10001:10001`:

```sh
for v in "$WORKSPACE_VOLUME" "$ARTIFACTS_VOLUME"; do
  docker volume create --label openshell.ai/sandbox-attachable=true \
    --label "openshell.ai/sandbox-attachable-workspace=$WORKSPACE" \
    --label "verify-fabric-boundary.uid=$UID_" "$v"
  docker run --rm --user 0 -v "$v:/v" --entrypoint sh "$IMAGE" -c 'chown 10001:10001 /v'
done
seed() {  # seed VOLUME PATH < CONTENT
  docker run --rm -i --user 10001:10001 -v "$1:/v" --entrypoint sh "$IMAGE" \
    -c 'mkdir -p "$(dirname "/v/$1")" && cat > "/v/$1"' sh "$2"
}
```

Don't give these volumes the `nemoclaw.nvidia.com/uid` label: NemoClaw didn't create them, and a managed label that differs from state blocks teardown.
Seed each fixture that a feature file's `Seed` step names, with `seed VOLUME PATH` and the fenced content as standard input, and record its SHA-256 in `$EVIDENCE/seeded.sha256`.
Seed only supplied fixtures and the two retention markers, once; the agent writes every generated fixture.
Never reseed after a transition.

### Plan and Apply

Run the apply line from [Plan and Apply](../verify-yaml-deployment/SKILL.md#plan-and-apply).
The deployment is ready when the doctor passes and `inference` passes in the Initial phase.

## Doctor

Run [verify-yaml-deployment's doctor](../verify-yaml-deployment/SKILL.md#doctor), then check the mounts, read-only:

```sh
docker volume ls --filter "label=verify-fabric-boundary.uid=$UID_" --format '{{.Name}}'
docker inspect "$SANDBOX_CONTAINER" --format '{{range .Mounts}}{{.Name}} {{.Destination}} {{.RW}}{{"\n"}}{{end}}' | grep -E '/sandbox/(workspace|artifacts)'
openshell sandbox exec -n assistant --no-tty -- ls -ln /sandbox/workspace /sandbox/artifacts/retained
```

Pass when both volumes list, the sandbox mounts each at its target with `true`, and both directories list with owner `10001`.
Run it before the first check, after every transition, and after any surprise.
The doctor is not a check; a failing doctor after a transition is evidence for the transition's check.

## Drive

Follow the [feature map](features/README.md) in phase order:

1. **Initial:** run each feature's Initial checks in the [map's order](features/README.md#features), starting with the `-first-start` checks before any request that changes content, then `inference`.
2. **Transitions:** let [lifecycle-and-retention](features/lifecycle-and-retention.md) drive each transition in turn: Runtime restart, Stop/start, Recreate, Config change, Restore.
3. **After each transition:** run the doctor, then re-run every check that lists the matching After-phase, such as `After stop/start`, with fresh phase input.
4. **Teardown:** lifecycle-and-retention runs the `teardown` check through [Cleanup](#cleanup).

Run checks only at their listed phases; don't add repetitions.
Run one request at a time: two model requests at once can make a reply arrive after the check that waits for it.
Continue independent checks after a failure; reassess blocked checks after each transition.
Never repair the baseline between phases: no reseeding, reinstalling, re-enabling, or editing state or generated native configuration.

## Evidence

Write everything under `$EVIDENCE`, as [verify-yaml-deployment's evidence rules](../verify-yaml-deployment/SKILL.md#evidence) require, and run its credential scan before handing off.
This skill adds:

| File | Contents |
|---|---|
| `checks.md` | One row per selected check: case, phase, outcome, finding, evidence |
| `findings.md` | One section per shared finding |
| `bindings.md` | The native bindings and the evidence for each |
| `baseline.yaml`, `baseline.sha256` | The YAML that Config change and Restore compare against |
| `seeded.sha256` | Hashes of the supplied fixtures and retention markers |
| `PHASE/CASE/` | Each check's request, native reply and calls, and independent effect checks |

`PHASE` is the phase's directory name from the [lifecycle phases](features/README.md#lifecycle-phases) table.
Before the first check, write every selected check to `checks.md` with an empty outcome:

```sh
{ echo '| case | phase | outcome | finding | evidence |'; echo '|---|---|---|---|---|'
  sed -n 's/^- `\([a-z-]*\)`: .* Phases: \(.*\)\.$/\1|\2/p' "$SKILL_DIR"/features/*.md |
  while IFS='|' read -r id phases; do
    [ "$AGENT" = deepagents-code ] && [ "$id" = web-ui ] && continue
    printf '%s\n' "$phases" | tr ',' '\n' | sed 's/^ *//' |
      while read -r phase; do echo "| $id | $phase | | | |"; done
  done; } > "$EVIDENCE/checks.md"
grep -c '^| [a-z-]* | [A-Z]' "$EVIDENCE/checks.md"
```

The count must be 136, or 131 for `deepagents-code`.
Fill in each row's outcome, finding ID, and evidence path as the check finishes; leave no row empty at the end.
Write each finding in `findings.md` as:

```text
## F1: One-line title

- **What happened:** the observed behavior against the expected, with exact inputs.
- **Revision:** the commit, image digest, and adapter or harness version it was observed at.
- **Evidence:** paths under $EVIDENCE.
- **Next step:** what would resolve it.
```

Never write a token, key, or full environment into evidence.

## Cleanup

The `teardown` check in [lifecycle-and-retention](features/lifecycle-and-retention.md) runs the destroy steps of [verify-yaml-deployment's cleanup](../verify-yaml-deployment/SKILL.md#cleanup) and records its outcome first.
Then finish that cleanup, including removal of retained resources by this run's UID, and remove this run's caller volumes:

```sh
docker volume ls --filter "label=verify-fabric-boundary.uid=$UID_" --format '{{.Name}}'
```

Continue only when the list is exactly `$WORKSPACE_VOLUME` and `$ARTIFACTS_VOLUME`, then:

```sh
docker volume ls --quiet --filter "label=verify-fabric-boundary.uid=$UID_" | xargs -r docker volume rm
docker volume ls --quiet --filter "label=verify-fabric-boundary.uid=$UID_" | wc -l
ls "$EVIDENCE"
```

The count must be 0, and the evidence must still list.
A failed destroy stays Failed in `checks.md` even when [Without State](../verify-yaml-deployment/SKILL.md#without-state) or a later attempt removes the resources.
Run cleanup after a failed or interrupted run too.

## Report

State the agent, target, revision, inference source and model, and the counts by outcome, derived from `checks.md`:

```sh
for o in Passed Failed 'Not tested'; do printf '%s: ' "$o"; grep -c "| $o |" "$EVIDENCE/checks.md"; done
grep -c '^| [a-z-]* | [A-Z][^|]* | *|' "$EVIDENCE/checks.md"
```

The last count is the checks still without an outcome; it must be 0 for a complete run.
Include the `checks.md` table and `findings.md`, with each finding's affected checks.
A run is complete when every selected check has an outcome and cleanup finished; a complete run is not a claim that every check passed.
Add the pair to the agent file's Proven Pairs only after a complete run, including cleanup, and record its counts by outcome there.
Mark an interrupted run as interrupted, keep its evidence, and don't add it.

## Hand Off

Keep the map current with the [maintain-verification-skill](../maintain-verification-skill/SKILL.md) skill.
