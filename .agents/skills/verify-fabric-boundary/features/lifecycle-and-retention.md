<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lifecycle and Retention

A user restarts the agent's runtime, stops and starts its sandbox, destroys and recreates the deployment, changes its configuration, restores it, and finally tears it down, all through the NemoClaw and OpenShell CLIs.
After each transition, the same YAML brings back an agent that answers, and the files the user keeps on the two caller volumes are still there, unchanged.
A restart or stop/start keeps the same sandbox; a recreation replaces it; removing and restoring the shell tool changes which native calls the agent can make.
Teardown removes the deployment's compute and leaves the caller volumes, model data, and evidence for the user.

## Sub-features

- `retention`: the seeded workspace and artifacts markers and the supplied `capability-probe` skill keep their seeded hashes on the same caller volumes, without reseeding. Phases: Initial, After stop/start, After recreate, After config change, After restore.
- `extension-runtime-restart`: stopping only the managed Fabric runtime through `fabric-agent-ctl stop`, then an unchanged plan/apply, gives the same sandbox and container a new runtime that answers. Phases: Runtime restart.
- `stop-start`: stopping the sandbox through OpenShell's supported control stops it and access to it, starting it brings back the same sandbox and container, and after an unchanged plan/apply its runtime answers. Phases: Stop/start.
- `recreate`: destroying the deployment through NemoClaw keeps the state and caller volumes, and plan/apply of the baseline YAML creates a new sandbox. Phases: Recreate.
- `change`: removing only the shell-launch tool blocks shell calls while other native tools still work and the model service and gateway keep running. Phases: Config change.
- `restore`: reapplying the baseline YAML restores shell calls, other native tools still work, and the runtime answers. Phases: Restore.
- `teardown`: NemoClaw's destroy removes the deployment's compute, and the caller volumes, model data, and evidence remain and are listed. Phases: Teardown.

## How to get to it (user POV)

- The `nemoclaw` CLI's `plan`, `apply`, `plan --destroy`, and `destroy`, as [Plan and Apply](../../verify-yaml-deployment/SKILL.md#plan-and-apply) and [Cleanup](../../verify-yaml-deployment/SKILL.md#cleanup) run them through `nc`.
- OpenShell's control for stopping a sandbox while keeping its workspace, and starting it again.
- Fabric's control for stopping only the agent's runtime inside the sandbox.
- The two caller volumes the launch mounted.

## Driving it with the nemoclaw CLI, the OpenShell CLI, and fabric-agent-ctl

Preconditions: the [launch](../SKILL.md#launch) seeded the markers below, the [request helpers](README.md#driving-conventions) are defined, and the Initial checks finished in the [map's order](README.md#features).
Run the transitions in the [lifecycle phases](README.md#lifecycle-phases) order, once each.
Each transition uses steps 3, 4, and 5 around its own commands.

1. **Seed:** the launch writes one run-unique marker into each caller volume, once, before the first apply, and keeps the originals and their hashes outside the sandbox:

   ```sh
   printf 'verify-fabric-boundary workspace marker %s\n' "$UID_" > "$EVIDENCE/workspace-marker.txt"
   printf 'verify-fabric-boundary artifacts marker %s\n' "$UID_" > "$EVIDENCE/artifacts-marker.txt"
   seed "$WORKSPACE_VOLUME" retained/marker.txt < "$EVIDENCE/workspace-marker.txt"
   seed "$ARTIFACTS_VOLUME" retained/marker.txt < "$EVIDENCE/artifacts-marker.txt"
   sha256sum "$EVIDENCE/workspace-marker.txt" "$EVIDENCE/artifacts-marker.txt" >> "$EVIDENCE/seeded.sha256"
   ```

   The markers land at `/sandbox/workspace/retained/marker.txt` and `/sandbox/artifacts/retained/marker.txt`.
2. **`retention`:** in every phase that lists it, read the originals without reseeding:

   ```sh
   CASE=retention; CHECK_DIR=$EVIDENCE/$PHASE/$CASE; mkdir -p "$CHECK_DIR"
   openshell sandbox exec -n assistant --no-tty -- sha256sum /sandbox/workspace/retained/marker.txt /sandbox/artifacts/retained/marker.txt /sandbox/workspace/skills/capability-probe/SKILL.md | tee "$CHECK_DIR/hashes.txt"
   cut -d' ' -f1 "$CHECK_DIR/hashes.txt" | while read -r h; do grep -qF "$h" "$EVIDENCE/seeded.sha256" && echo match || echo MISSING; done
   docker inspect "$SANDBOX_CONTAINER" --format '{{range .Mounts}}{{.Name}} {{.Destination}}{{"\n"}}{{end}}' | grep -E '/sandbox/(workspace|artifacts)' | tee "$CHECK_DIR/mounts.txt"
   ```

   Result: three `match` lines, and the mounts name `$WORKSPACE_VOLUME` at `/sandbox/workspace` and `$ARTIFACTS_VOLUME` at `/sandbox/artifacts`.
   A missing or changed file is Failed. This check doesn't need the runtime, so run it even when the runtime is unusable.
3. **Before a transition:** set `PHASE` to the transition's directory and `CASE` to its check, then record what it should keep or replace:

   ```sh
   CHECK_DIR=$EVIDENCE/$PHASE/$CASE; mkdir -p "$CHECK_DIR"
   docker inspect "$SANDBOX_CONTAINER" --format '{{.Id}}' > "$CHECK_DIR/container-before.txt"
   echo "$RUNTIME_ID" > "$CHECK_DIR/runtime-before.txt"
   docker container ls --filter "label=nemoclaw.nvidia.com/uid=$UID_" --format '{{.ID}} {{.Names}}' > "$CHECK_DIR/owned-before.txt"
   openshell sandbox get assistant > "$CHECK_DIR/sandbox-before.txt" 2>&1
   ```

4. **Plan, apply, and answer:** after the transition's own commands, plan and apply the current YAML, save both outputs in the transition directory, and read the runtime ID again:

   ```sh
   nc plan "$RUN_DIR/deployment.yaml" --progress off > "$EVIDENCE/$PHASE/plan.txt" 2>&1; echo "plan exit $?"
   nc apply "$RUN_DIR/deployment.yaml" --progress plain > "$EVIDENCE/$PHASE/apply.txt" 2>&1; echo "apply exit $?"
   APPLY_OUT=$EVIDENCE/$PHASE/apply.txt
   tail -20 "$APPLY_OUT"
   RUNTIME_ID=$(jq -r '.resources[] | select(.type == "fabric_agent") | .instances[].attributes | select(.name == "assistant") | .runtime_id' "$STATE/terraform.tfstate")
   echo "$RUNTIME_ID" > "$CHECK_DIR/runtime-after.txt"
   ```

   Run the [doctor](../SKILL.md#doctor), which resolves `SANDBOX_CONTAINER` again, then send a fresh request:

   ```sh
   docker inspect "$SANDBOX_CONTAINER" --format '{{.Id}}' > "$CHECK_DIR/container-after.txt"
   docker container ls --filter "label=nemoclaw.nvidia.com/uid=$UID_" --format '{{.ID}} {{.Names}}' > "$CHECK_DIR/owned-after.txt"
   WORD=LIFECYCLE_OK-$(openssl rand -hex 8); echo "$WORD" > "$CHECK_DIR/word.txt"
   ask request <<EOF
   Reply with exactly $WORD and nothing else. Do not use any tools.
   EOF
   ```

   Result: both exits are 0, apply ends with `Apply complete`, `RUNTIME_ID` is one nonempty ID, the doctor passes, and the reply's `response` is `$WORD`.
   [native-interfaces](native-interfaces.md) reads the new entry points from `$APPLY_OUT`.
5. **After a transition:** set `PHASE` to the next phase's directory, write its [fresh phase input](README.md#driving-conventions), and re-run every check whose Phases list names that phase, in the [map's order](README.md#features).
   The [lifecycle phases](README.md#lifecycle-phases) table gives each After-phase's check count; run exactly those.
   Record the transition's own row in `$EVIDENCE/checks.md` once its result is known.
6. **`extension-runtime-restart`:** with `PHASE=runtime-restart` and `CASE=extension-runtime-restart`, run step 3.
   For Hermes, prepare [the open TUI and in-flight probe](native-interfaces.md#prepare-and-observe-the-stop) before stopping; finish that check's stop, cancellation, stale-entry, and persistence observations before recovery.
   Stop only the runtime through Fabric's supported control. Save the control's help, the exact command, and its output in `$CHECK_DIR`.

   Result: the control reports a stop that succeeded, with no error.
   Run step 4; review the plan before apply and do not proceed if it replaces the sandbox, as the [gotchas](#gotchas) require.
   Pass when `container-before.txt` and `container-after.txt` match, `runtime-after.txt` differs from `runtime-before.txt`, and the request in step 4 succeeds on the new runtime.
   A stop with no supported control is Failed, linked to one missing-implementation finding; a runtime that plan/apply doesn't bring back is Failed.
   Then run step 5 with `PHASE=after-runtime-restart`, including `hermes-tui-recovery` for Hermes.
7. **`stop-start`:** with `PHASE=stop-start` and `CASE=stop-start`, run step 3, then stop the same sandbox through OpenShell's supported control, confirm it is stopped and unreachable, and start it again. Save the control's help, each command, and its output in `$CHECK_DIR`. While the sandbox is stopped, record:

   ```sh
   docker inspect "$SANDBOX_CONTAINER" --format '{{.Id}} {{.State.Status}}' | tee "$CHECK_DIR/stopped-container.txt"
   openshell sandbox exec -n assistant --no-tty -- true > "$CHECK_DIR/stopped-exec.txt" 2>&1; echo "stopped exec exit $?"
   ```

   Result: the stop and the start succeed; while stopped, OpenShell shows the sandbox stopped, the container keeps its ID and isn't `running`, and the exec exits nonzero; after the start, `assistant` returns to `Ready`.
   Wait for `Ready` before step 4; the gateway, model service, and Docker daemon keep running throughout.
   Run step 4 with the YAML unchanged.
   Pass when the container IDs match, the plan doesn't replace the sandbox, and the request in step 4 succeeds.
   The desired contract is that the same sandbox recovers with a usable runtime after unchanged plan/apply; anything else is Failed, including a recovery that replaces the sandbox.
   If OpenShell offers no supported stop or start, mark the check Failed with a missing-implementation finding; if the runner can't run them safely, mark it Not tested.
   Then run step 5 with `PHASE=after-stop-start`.
8. **`recreate`:** with `PHASE=recreate` and `CASE=recreate`, run step 3, then preview and destroy the deployment through NemoClaw, keeping the state directory, bundle, and caller volumes:

   ```sh
   nc plan --destroy > "$CHECK_DIR/destroy-plan.txt" 2>&1
   nc destroy > "$CHECK_DIR/destroy.txt" 2>&1; echo "destroy exit $?"
   nc plan --destroy > "$CHECK_DIR/destroy-check.txt" 2>&1
   grep -q 'No resource changes planned.' "$CHECK_DIR/destroy-check.txt" && echo DESTROYED
   docker ps --all --format '{{.Names}}' | grep -c "^openshell-$WORKSPACE--" || true
   docker volume ls --filter "label=verify-fabric-boundary.uid=$UID_" --format '{{.Name}}' | tee "$CHECK_DIR/caller-volumes.txt"
   [ "$(sha256sum < "$RUN_DIR/deployment.yaml" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$EVIDENCE/baseline.sha256")" ] && echo baseline
   ```

   Result: `DESTROYED`, a count of 0, both caller volumes listed, and `baseline`.
   Wait for `DESTROYED` before reapplying. Then run step 4 with the baseline YAML, and check that the old sandbox is gone:

   ```sh
   docker inspect "$(cat "$CHECK_DIR/container-before.txt")" > /dev/null 2>&1 && echo OLD-PRESENT || echo old-gone
   cmp -s "$CHECK_DIR/container-before.txt" "$CHECK_DIR/container-after.txt" && echo SAME || echo new-sandbox
   ```

   Result: `old-gone` and `new-sandbox`.
   Pass when the request in step 4 succeeds; the markers are checked by `retention` in the next phase.
   The integration test [`destroy_matches_preview_and_reapply_creates_a_new_sandbox_and_runtime`](../../../../crates/nemoclaw-e2e/tests/integration/rust/fabric_deployment.rs) checks plan/apply agreement for destroy and recreation. The SDK test [`caller_volumes_remain_external_through_changes_restore_and_recreation`](../../../../crates/nemoclaw-sdk/tests/runtime_compile.rs) checks that caller volumes stay outside the managed graph. Keep the live volume and marker checks: the fixtures cannot prove that OpenShell's Docker driver preserves the volumes or their bytes.
   Then run step 5 with `PHASE=after-recreate`.
9. **`change`:** with `PHASE=config-change` and `CASE=change`, run step 3 and confirm that the YAML is still the baseline, with the same `sha256sum` comparison as step 8.
   Edit `$RUN_DIR/deployment.yaml` by hand to remove only the shell-launch tool from the tool allow-list that the launch added, as `bindings.md` records it, then save the change:

   ```sh
   cp "$RUN_DIR/deployment.yaml" "$EVIDENCE/changed.yaml"
   sha256sum "$EVIDENCE/baseline.yaml" "$EVIDENCE/changed.yaml" > "$CHECK_DIR/hashes.txt"
   diff -u "$EVIDENCE/baseline.yaml" "$EVIDENCE/changed.yaml" | tee "$CHECK_DIR/config.diff"
   ```

   Result: the diff touches only the shell-restriction lines.
   Run step 4.
   Compare `owned-before.txt` with `owned-after.txt`: the model service and gateway must keep their container IDs.
   The Rust integration test `shell_restriction_and_restore_replace_only_the_target_sandbox` covers plan/apply agreement and unchanged gateway objects across both transitions; the SDK test `shell_restriction_changes_only_the_allow_list_and_restores_the_baseline_graph` covers configuration preservation. Neither fixture test observes physical model or gateway containers, so keep that live comparison.
   Pass when apply completes, the request in step 4 succeeds, `shell-success` in After config change shows the shell tool absent or rejected, and the other native-tool checks still pass; settle this row after those checks.
   When the adapter offers no supported way to remove only the shell-launch tool, mark `change` Failed with one missing-implementation finding, don't plan or apply a guessed key, and link the four shell checks in After config change to that finding, as [invoke-and-tools](invoke-and-tools.md#gotchas) says.
   An approval policy or classifier that declines a command isn't the shell restriction: judge by tool exposure and actual calls.
   Never test the unchanged baseline as the changed phase.
   Then run step 5 with `PHASE=after-config-change`.
10. **`restore`:** with `PHASE=restore` and `CASE=restore`, run step 3, then put back the exact baseline:

    ```sh
    cp "$EVIDENCE/baseline.yaml" "$RUN_DIR/deployment.yaml"
    [ "$(sha256sum < "$RUN_DIR/deployment.yaml" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$EVIDENCE/baseline.sha256")" ] && echo restored
    diff -u "$EVIDENCE/changed.yaml" "$RUN_DIR/deployment.yaml" > "$CHECK_DIR/restore.diff"
    ```

    Result: `restored`, and `restore.diff` is the reverse of `config.diff`.
    Run step 4 and compare `owned-before.txt` with `owned-after.txt`: the model service and gateway must keep their container IDs.
    Pass when apply completes, the request in step 4 succeeds, `shell-success` in After restore runs the shell again, and the other native-tool checks still pass; settle this row after those checks.
    If `change` was blocked, keep exercising the baseline in After restore, but mark `restore` Not tested, linked to the `change` finding: there was no change to reverse.
    Then run step 5 with `PHASE=after-restore`.
11. **`teardown`:** with `PHASE=teardown` and `CASE=teardown`, set `CHECK_DIR` as step 3 does, after every other row has an outcome.
    Run the destroy lines of [verify-yaml-deployment's cleanup](../../verify-yaml-deployment/SKILL.md#cleanup), the first block, as [this skill's cleanup](../SKILL.md#cleanup) directs, then record what remains before anything is removed:

    ```sh
    cp "$EVIDENCE/destroy-plan.txt" "$EVIDENCE/destroy.txt" "$EVIDENCE/destroy-check.txt" "$CHECK_DIR/"
    docker ps --all --format '{{.Names}}' | grep -c "^openshell-$WORKSPACE--" || true
    docker container ls --all --filter "label=nemoclaw.nvidia.com/uid=$UID_" --format '{{.Names}} {{.Status}}' | tee "$CHECK_DIR/owned-containers.txt"
    { docker volume ls --filter "label=verify-fabric-boundary.uid=$UID_" --format '{{.Name}}'
      docker volume ls --filter "label=nemoclaw.nvidia.com/uid=$UID_" --format '{{.Name}}'; } | tee "$CHECK_DIR/retained.txt"
    ls "$EVIDENCE" > "$CHECK_DIR/evidence.txt"
    ```

    Result: `DESTROYED` printed, a count of 0, no running owned container, and `retained.txt` lists `$WORKSPACE_VOLUME`, `$ARTIFACTS_VOLUME`, the gateway's storage, and, for a managed model service, its model data.
    Record the `teardown` row now: Passed only when the normal destroy succeeded and the listed resources remain; a failed destroy stays Failed even when [Without State](../../verify-yaml-deployment/SKILL.md#without-state) or a later attempt frees the compute.
    Then let [this skill's cleanup](../SKILL.md#cleanup) remove the retained resources and caller volumes.
## Gotchas

- Never reseed a marker, the supplied skill, or anything else after a transition. A missing or changed file is evidence.
- Retained files prove neither discovery, registration, fresh execution, nor conversation resume. [skills](skills.md) tracks rediscovery of a generated skill separately; don't infer conversation resume from `retention`.
- After runtime replacement, the old `RUNTIME_ID` fails with `runtime_unavailable`; old entry points or tokens must not grant access to that runtime. A leftover launcher file alone proves neither access nor cleanup. Step 4 reads the current runtime and entry points again.
- Stop only what the check names. `extension-runtime-restart` stops the Fabric runtime, not the sandbox; `stop-start` stops the sandbox, not the gateway, model service, or Docker daemon.
- Don't substitute `docker stop`, `docker restart`, or killing the runtime's process for the supported controls; a killed runtime can leave interface markers behind.
- An explicit `fabric-agent-ctl start`, or a runtime started by hand, is at most a separately recorded diagnostic. Never put its handle in state, and stop it before teardown.
- If a plan after `extension-runtime-restart` or `stop-start` replaces the sandbox, the check is Failed. Save the plan and ask the user before applying it: replacement deletes the sandbox's own files.
- Never edit OpenTofu state, erase state to force recovery, or invent plan flags. Keep the state directory and bundle until cleanup.
- The caller volumes carry no `nemoclaw.nvidia.com/uid` label, so destroy keeps them; adding that label blocks teardown.
- Don't keep applying an unchanged YAML that already failed without new evidence; record the failure and continue with the checks that don't need the runtime.
