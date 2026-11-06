---
name: verify-fabric-boundary
description: Verify, as a user of a Fabric-managed agent on a DGX Spark, the NemoClaw–NeMo Fabric boundary — inference, native tools and interfaces, skills, plugins, mounted extensions, and their retention across runtime restart, stop/start, recreation, a configuration change, restore, and teardown. Choose the agent from the skill's agent table. Use after changing adapters, harness images, Fabric, OpenShell, mounts, or lifecycle code, before claiming that an agent's native capabilities work through NemoClaw.
disable-model-invocation: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Verify the Fabric Boundary

This skill drives one Fabric-managed agent the way its user does: through its native tools, interfaces, skills, and plugins, across every lifecycle transition NemoClaw offers.
It checks desired-state assertions: each check records whether the agent does what a user of that agent expects through NemoClaw, not what the selected revision happens to support.
It reuses [verify-yaml-deployment](../verify-yaml-deployment/SKILL.md) for the run's identity, build, inference, base YAML, plan and apply, doctor, credential scan, and cleanup, and owns only the Fabric-boundary additions.
It owns one deployment per run and never touches another.

The [live tests](../../../internal-docs/contributing/live-tests.md) stay the gate; when a check must hold on every change, add a test at the layer the `write-tests` skill picks.
Use existing automated tests for configuration mapping and provider planning rules; do not repeat those assertions as skill checks.
The feature files retain native discovery, registration, fresh use, and physical lifecycle evidence that those tests cannot prove.
Keep the configuration and identity needed to drive a run as prerequisites, not separate proof of native behavior.

The SDK tests [`public_fabric_configuration_passes_through_without_overriding_deployment_bindings`](../../../crates/nemoclaw-sdk/tests/fabric_compatibility.rs) and [`sandboxes_pass_driver_configuration_through`](../../../crates/nemoclaw-sdk/tests/compile.rs) cover skills passthrough with and without mounts and preservation of caller-owned writable mount payloads, respectively.
Fabric owns adapter-native path mapping; its [OpenClaw test](https://github.com/NVIDIA/NeMo-Fabric/blob/e5b5ebf2b81cc3c6325301ea419ebf2453dab12e/tests/adapters/test_openclaw.py#L530) asserts `skills.load.extraDirs`.

## Scope

- **Gateway:** a managed Docker gateway on the DGX Spark running the skill, as in [verify-yaml-deployment's scope](../verify-yaml-deployment/SKILL.md#scope).
- **Agent:** one sandbox named `assistant` with one Fabric agent from the [agent table](#choose-the-agent-and-target).
- **Target:** [dgx-spark](../verify-yaml-deployment/targets/dgx-spark.md) only. Another host type needs its own target file and proof first.
- **Run:** one deployment, one pass through the 12 [lifecycle phases](features/README.md#lifecycle-phases), and one teardown. Every selected check gets an outcome: 137 checks for `hermes`, 135 for `openclaw`.

[Completed Runs](#completed-runs) lists the agent–target pairs run to completion, with the revision, date, and counts by outcome; a completed run doesn't prove the pair.
A pair that isn't listed has no completed run: say so with the result.

## Choose the Agent and Target

| `AGENT` | Harness (`ADAPTER_ID`) | Scope |
|---|---|---|
| `hermes` | `nvidia.fabric.hermes` | Every feature |
| `openclaw` | `nvidia.fabric.openclaw` | Every feature |

| Target file | `TARGET` |
|---|---|
| [../verify-yaml-deployment/targets/dgx-spark.md](../verify-yaml-deployment/targets/dgx-spark.md) | `dgx-spark` |

Read the matching [verify-yaml-deployment agent file](../verify-yaml-deployment/agents) and the target file before launching: they set the base YAML and the variables this file uses.

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
Check the target's [running and retained inference](../verify-yaml-deployment/targets/dgx-spark.md#discover-running-and-retained-inference-first) before proposing a new model download.
Record the chosen source and model in `$EVIDENCE/identity.txt`; results bound to that model don't cover another.

### Write the YAML

Run [Write the YAML](../verify-yaml-deployment/SKILL.md#write-the-yaml), all five edits, then add the edits below before saving `$EVIDENCE/deployment.yaml`.

### Add the Fabric-Boundary YAML Edits

Add what the checks need to the base YAML, then save it:

1. **Volumes.** Mount `$WORKSPACE_VOLUME` at `/sandbox/workspace` and `$ARTIFACTS_VOLUME` at `/sandbox/artifacts`, with `read_only: false` on both mounts; OpenShell defaults them to read-only. Follow [caller-owned volumes](../../../docs/build-deploy/state.md) for admission and filesystem access.
2. **Skills.** Keep the supplied skill under `/sandbox/workspace/skills/capability-probe`. Check the selected adapter's path validation before setting `harness.config.skills.paths`: OpenClaw at Fabric `e5b5ebf2b81cc3c6325301ea419ebf2453dab12e` requires individual skill directories containing `SKILL.md`, so use `[/sandbox/workspace/skills/capability-probe]`, not the parent directory. Record this per-item configuration separately from native discovery; do not claim directory scanning or automatic discovery of generated skills from it.
3. **Capabilities.** Choose the run-scoped extension names first: run step 2 of [mounted-extensions](features/mounted-extensions.md), and note the generated plugin's ID, `fb-plugin-$UID8`, as step 4 of [plugins](features/plugins.md) derives it.
   Then enable each capability the feature files check: the native TUI and, where in scope, the Web UI; a harmless bundled plugin; the mounted native tool and plugin locations under `/sandbox/workspace/extensions`, with any per-item enablement; and a tool allow-list from which Config change can remove only the shell-launch tool.
4. **Merge rules.** Keep everything the base YAML sets, including its harness kind, execution, approval settings, and inference route.
   Set the route's output-token limit to 4096 for these multistep checks when the adapter accepts one, and record the limit used in `$EVIDENCE/identity.txt`.
   Use only fields that the selected revision documents or the image's adapter declares, and record each field and its source in `bindings.md`.
   A capability with no supported field is Failed for the checks that need it, linked to one missing-implementation finding; never add an undeclared field to see whether plan accepts it.
5. **Adapter.** Save the image's adapter descriptor in `$EVIDENCE/descriptor.json` before the first plan.
   If the image has no matching adapter, or no image matches the selected revision, the adapter or its image is absent.
   Create no resources: skip [Provision and Seed the Volumes](#provision-and-seed-the-volumes) and [Plan and Apply](#plan-and-apply), and write one absence finding, F1, that names what is missing with the revision and image digest.
   Mark every selected check in `checks.md` Failed and linked to F1, except `teardown`, which is Not tested and linked to F1, then run [Report](#report).
   If access or credentials prevent the check, mark the rows Not tested with that cause instead.
   An image that has the adapter but fails to start is a failure with its own finding.
   Never substitute another adapter, a standalone harness process, or another image for a pass.

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

Save the baseline that Config change and Restore compare against:

```sh
cp "$RUN_DIR/deployment.yaml" "$EVIDENCE/deployment.yaml"
cp "$RUN_DIR/deployment.yaml" "$EVIDENCE/baseline.yaml"
sha256sum "$EVIDENCE/baseline.yaml" > "$EVIDENCE/baseline.sha256"
```

### Record the Native Bindings

Before the first apply, write `$EVIDENCE/bindings.md`: for each feature, the YAML fields it relies on, the native mechanism it uses, and the evidence for that choice.
Resolve each binding against the selected YAML, the image's adapter descriptor, and that image's harness source and executable help, in that order.
Record each runtime's actual native home from its generated configuration or startup log, never from the process environment, which holds credentials.
Fill in every prompt placeholder that the [driving conventions](features/README.md#driving-conventions) list.
Start it with these lines, which the [request helpers](features/README.md#driving-conventions) read:

```text
- shell-launch tool: `NAME`
- file-write tool: `NAME`
- skill-authoring tool: `NAME`
- skill directory: `PATH`
- plugin format: `SUMMARY`
- install command: `COMMAND`
- enable command: `COMMAND`
- native call record: `PATH OR COMMAND`
```

When no supported mechanism exists, write `none`, record the finding, and mark the checks that need it Failed without sending their prompts; for the skill-authoring tool, write `your native file tools` instead.
Resolve the install and enable commands when [plugins](features/plugins.md) reviews them, before `agent-plugin-install`.
Stop researching a binding once the evidence shows the route or the missing layer; a missing layer is a finding, not a reason to try speculative settings.

### Provision and Seed the Volumes

Run the plan line from [Plan and Apply](../verify-yaml-deployment/SKILL.md#plan-and-apply) first, and check that it names `$WORKSPACE`:

```sh
grep -F "$WORKSPACE" "$EVIDENCE/plan.txt"
```

Create both volumes so the deployment's OpenShell workspace may attach them and the sandbox identity can write them. Label each with `verify-fabric-boundary.uid=$UID_`, `openshell.ai/sandbox-attachable=true`, and `openshell.ai/sandbox-attachable-workspace=$WORKSPACE` for the gateway's default admission policy.
Set `SANDBOX_IDS` to that identity's `UID:GID`, then define `seed`, which writes one file as that identity:

```sh
seed() {  # seed VOLUME PATH < CONTENT
  docker run --rm -i --user "$SANDBOX_IDS" -v "$1:/v" --entrypoint sh "$IMAGE" \
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
    case "$id" in hermes-tui-*) [ "$AGENT" = hermes ] || continue ;; esac
    printf '%s\n' "$phases" | tr ',' '\n' | sed 's/^ *//' |
      while read -r phase; do echo "| $id | $phase | | | |"; done
  done; } > "$EVIDENCE/checks.md"
grep -c '^| [a-z-]* | [A-Z]' "$EVIDENCE/checks.md"
```

The count must be 137 for `hermes`, 135 for `openclaw`.
Fill in each row's outcome, finding ID, and evidence path as the check finishes; leave no row empty at the end.
Write each finding in `findings.md` as:

```text
## F1: One-line title

- **What happened:** the observed behavior against the expected, with exact inputs.
- **Revision:** the commit, image digest, and adapter or harness version it was observed at.
- **Evidence:** paths under $EVIDENCE.
- **Owner:** the component that must change to resolve it, NemoClaw or an upstream one, per the upstream boundaries in internal-docs/design/scope.md.
- **Next step:** what would resolve it.
```

Never write a token, key, or full environment into evidence.

## Cleanup

Preserve any existing external inference service, including containers labeled `org.nemoclaw.lifecycle=persistent` or `org.nemoclaw.test-cleanup=preserve`, and its network, images and volumes; none belong to this run's teardown.

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
Add the pair to [Completed Runs](#completed-runs) only after a complete run, including cleanup, and record its inference source and counts by outcome there.
Mark an interrupted run as interrupted, keep its evidence, and don't add it.

## Completed Runs

Counts below describe each run's archived suite. The two Hermes TUI lifecycle checks added afterward have no live result here; historical completion does not qualify them.

| Agent | Target | Inference source | Revision | Date | Passed | Failed | Not tested | Notes |
|---|---|---|---|---|---|---|---|---|
| openclaw | dgx-spark | External persistent Nemotron 3 Super NVFP4 | `ed47e1c29022e22559fb8b7c4916dd6e9b3a3a79` | 2026-11-03 | 6 | 40 | 90 | Original outcomes for `20261103T155036Z-openclaw-fabric-ed47e1c290`; not a working-agent qualification. Later diagnosis traced startup failure to the runner's parent skill path, rejected as `openclaw_skill_invalid`. The original pinned image starts with the individual skill directory. Original records remain unchanged; a fresh suite is needed for native capability results. Cleanup preserved external inference. |
| openclaw | dgx-spark | External persistent Nemotron 3 Super NVFP4 | `ed47e1c29022e22559fb8b7c4916dd6e9b3a3a79` | 2026-11-03 | 52 | 75 | 9 | Complete rerun `20261103T162432Z-openclaw-fabric-ed47e1c290` with the individual skill directory. All 136 outcomes recorded; normal teardown and run-owned resource cleanup passed, with persistent inference preserved. Missing plugin/tool bindings, native TUI, generated-skill activation, and request-level skill/reporting failures remain; completion is not full capability qualification. |
| hermes | dgx-spark | External persistent Nemotron 3 Super NVFP4 | `ed47e1c29022e22559fb8b7c4916dd6e9b3a3a79` | 2026-11-03 | 62 | 59 | 15 | Complete run `20261103T195021Z-hermes-fabric-ed47e1c290`: all 136 outcomes recorded and scoped cleanup passed; persistent inference preserved. Dashboard and supplemental API passed. Missing native bindings, fresh skill-load assertions, plugin visibility and authoring failures remain; completion is not full capability qualification. |

## Hand Off

Keep the map current with the [maintain-verification-skill](../maintain-verification-skill/SKILL.md) skill.
