<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Lifecycle Transitions

A user restarts the agent's runtime, stops and starts its sandbox, destroys and recreates the deployment, changes its configuration, restores it, and finally tears it down, all through the NemoClaw and OpenShell CLIs.
This file drives each transition so that the other feature files can re-run their checks after it; the transitions have no checks of their own.
These tests cover the transitions:

| Transition | Tests |
|---|---|
| Runtime restart | `stop_runtime` and `restart` in the provider contract [`runtime_changes.tftest.hcl`](../../../../crates/fabric-provider/tests/contract/hcl/agent/tests/runtime_changes.tftest.hcl); [`an_agent_whose_runtime_stopped_starts_again_in_its_sandbox`](../../../../crates/fabric-provider/src/fake_gateway_tests.rs) |
| Stop/start | OpenShell owns sandbox stop and start; after the start, NemoClaw sees a stopped runtime, as in Runtime restart |
| Recreate | [`destroy_matches_preview_and_reapply_creates_a_new_sandbox_and_runtime`](../../../../crates/nemoclaw-e2e/tests/integration/rust/fabric_deployment.rs); [`caller_volumes_remain_external_through_changes_restore_and_recreation`](../../../../crates/nemoclaw-sdk/tests/runtime_compile.rs) |
| Config change, Restore | [`shell_restriction_changes_only_the_enabled_list_and_restores_the_baseline_graph`](../../../../crates/nemoclaw-sdk/tests/agent_tools.rs); [`shell_restriction_and_restore_replace_only_the_target_sandbox`](../../../../crates/nemoclaw-e2e/tests/integration/rust/deployment.rs) |
| Files kept on the caller volumes | `kept_after_replacement` in [`docker-openclaw-hermes-interfaces.tftest.hcl`](../../../../crates/nemoclaw-e2e/tests/e2e/hcl/tests/docker-openclaw-hermes-interfaces.tftest.hcl); `read_marker` in [`docker-dummy.tftest.hcl`](../../../../crates/nemoclaw-e2e/tests/e2e/hcl/tests/docker-dummy.tftest.hcl) |
| Teardown | `destroy` in [`docker-openclaw-hermes-interfaces.tftest.hcl`](../../../../crates/nemoclaw-e2e/tests/e2e/hcl/tests/docker-openclaw-hermes-interfaces.tftest.hcl); `destroy_after_redeploy` in [`docker-dummy.tftest.hcl`](../../../../crates/nemoclaw-e2e/tests/e2e/hcl/tests/docker-dummy.tftest.hcl) |

## Driving it with the nemoclaw CLI, the OpenShell CLI, and fabric-agent-ctl

Preconditions: the [request helpers](README.md#driving-conventions) are defined, and the Initial checks finished in the [map's order](README.md#features).
Run the transitions in the [lifecycle phases](README.md#lifecycle-phases) order, once each.
Each transition uses steps 1, 2, and 3 around its own commands, and keeps its evidence in `$EVIDENCE/$PHASE/transition/`.
When a transition doesn't bring back a usable runtime, record a finding and mark the next phase's checks that need the runtime Not tested, linked to it.

1. **Before a transition:** set `PHASE` to the transition's directory, then record what it should keep or replace:

   ```sh
   CHECK_DIR=$EVIDENCE/$PHASE/transition; mkdir -p "$CHECK_DIR"
   docker inspect "$SANDBOX_CONTAINER" --format '{{.Id}}' > "$CHECK_DIR/container-before.txt"
   echo "$RUNTIME_ID" > "$CHECK_DIR/runtime-before.txt"
   openshell sandbox get assistant > "$CHECK_DIR/sandbox-before.txt" 2>&1
   ```

2. **Plan, apply, and answer:** after the transition's own commands, plan and apply the current YAML, save both outputs in the transition directory, and read the runtime ID again:

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
   WORD=LIFECYCLE_OK-$(openssl rand -hex 8); echo "$WORD" > "$CHECK_DIR/word.txt"
   ask request <<EOF
   Reply with exactly $WORD and nothing else. Do not use any tools.
   EOF
   ```

   Continue when both exits are 0, apply ends with `Apply complete`, `RUNTIME_ID` is one nonempty ID, the doctor passes, and the reply's `response` is `$WORD`.
   [native-interfaces](native-interfaces.md) reads the new entry points from `$APPLY_OUT`.
3. **After a transition:** set `PHASE` to the next phase's directory, write its [fresh phase input](README.md#driving-conventions), and re-run every check whose Phases list names that phase, in the [map's order](README.md#features).
   The [lifecycle phases](README.md#lifecycle-phases) table gives each After-phase's check count; run exactly those.
4. **Runtime restart:** with `PHASE=runtime-restart`, run step 1.
   For Hermes, prepare [the open TUI and in-flight probe](native-interfaces.md#prepare-and-observe-the-stop) before stopping, and finish that check's observations before recovery.
   Stop only the runtime through Fabric's supported control. Save the control's help, the exact command, and its output in `$CHECK_DIR`.
   Run step 2; review the plan before apply and don't proceed if it replaces the sandbox, as the [gotchas](#gotchas) require.
   Expect the same container and a new runtime ID.
   Then run step 3 with `PHASE=after-runtime-restart`.
5. **Stop/start:** with `PHASE=stop-start`, run step 1, then stop the same sandbox through OpenShell's supported control, confirm it is stopped, and start it again. Save the control's help, each command, and its output in `$CHECK_DIR`.
   Wait for `assistant` to return to `Ready` before step 2; the gateway, model service, and Docker daemon keep running throughout.
   Run step 2 with the YAML unchanged, then step 3 with `PHASE=after-stop-start`.
6. **Recreate:** with `PHASE=recreate`, run step 1, then preview and destroy the deployment through NemoClaw, keeping the state directory, bundle, and caller volumes:

   ```sh
   nc plan --destroy > "$CHECK_DIR/destroy-plan.txt" 2>&1
   nc destroy > "$CHECK_DIR/destroy.txt" 2>&1; echo "destroy exit $?"
   nc plan --destroy > "$CHECK_DIR/destroy-check.txt" 2>&1
   grep -q 'No resource changes planned.' "$CHECK_DIR/destroy-check.txt" && echo DESTROYED
   docker volume ls --filter "label=verify-fabric-boundary.uid=$UID_" --format '{{.Name}}' | tee "$CHECK_DIR/caller-volumes.txt"
   [ "$(sha256sum < "$RUN_DIR/deployment.yaml" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$EVIDENCE/baseline.sha256")" ] && echo baseline
   ```

   Continue when the output shows `DESTROYED`, both caller volumes, and `baseline`.
   Then run step 2 with the baseline YAML, and step 3 with `PHASE=after-recreate`.
7. **Config change:** with `PHASE=config-change`, run step 1 and confirm that the YAML is still the baseline, with the same `sha256sum` comparison as step 6.
   Edit `$RUN_DIR/deployment.yaml` by hand to remove only the shell-launch tool from the tool allow-list that the launch added, as `bindings.md` records it, then save the change:

   ```sh
   cp "$RUN_DIR/deployment.yaml" "$EVIDENCE/changed.yaml"
   diff -u "$EVIDENCE/baseline.yaml" "$EVIDENCE/changed.yaml" | tee "$CHECK_DIR/config.diff"
   ```

   The diff must touch only the shell-restriction lines.
   Run step 2, then step 3 with `PHASE=after-config-change`.
   When the adapter offers no supported way to remove only the shell-launch tool, record one missing-implementation finding, don't plan or apply a guessed key, and link `shell-success` in After config change to it, as [invoke-and-tools](invoke-and-tools.md) says.
   Never test the unchanged baseline as the changed phase.
8. **Restore:** with `PHASE=restore`, run step 1, then put back the exact baseline:

   ```sh
   cp "$EVIDENCE/baseline.yaml" "$RUN_DIR/deployment.yaml"
   [ "$(sha256sum < "$RUN_DIR/deployment.yaml" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$EVIDENCE/baseline.sha256")" ] && echo restored
   ```

   Continue when the output shows `restored`.
   Run step 2, then step 3 with `PHASE=after-restore`.
9. **Teardown:** after every check has an outcome, run [this skill's cleanup](../SKILL.md#cleanup).

## Gotchas

- After runtime replacement, the old `RUNTIME_ID` fails with `runtime_unavailable`. Step 2 reads the current runtime and entry points again.
- Stop only what the transition names. Runtime restart stops the Fabric runtime, not the sandbox; Stop/start stops the sandbox, not the gateway, model service, or Docker daemon.
- Don't substitute `docker stop`, `docker restart`, or killing the runtime's process for the supported controls; a killed runtime can leave interface markers behind.
- An explicit `fabric-agent-ctl start`, or a runtime started by hand, is at most a separately recorded diagnostic. Never put its handle in state, and stop it before teardown.
- If a plan after Runtime restart or Stop/start replaces the sandbox, save the plan and ask the user before applying it: replacement deletes the sandbox's own files.
- Never reseed, reinstall, or re-enable anything after a transition; a missing or changed file is evidence.
- Never edit OpenTofu state, erase state to force recovery, or invent plan flags. Keep the state directory and bundle until cleanup.
- The caller volumes carry no `nemoclaw.nvidia.com/uid` label, so destroy keeps them; adding that label blocks teardown.
- Don't keep applying an unchanged YAML that already failed without new evidence; record the failure and continue with the checks that don't need the runtime.
