<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native Shell Tool and Its Restriction

A user's agent runs a bounded command with its native shell-launch tool.
When the configuration change removes the shell-launch tool, the managed runtime no longer offers it or rejects its calls, and nothing runs the command another way; after the restore, the shell runs again.
NemoClaw's part, writing the restriction into `tools.enabled` and restoring the baseline, is covered by the SDK test [`shell_restriction_changes_only_the_enabled_list_and_restores_the_baseline_graph`](../../../../crates/nemoclaw-sdk/tests/agent_tools.rs) and the integration test [`shell_restriction_and_restore_replace_only_the_target_sandbox`](../../../../crates/nemoclaw-e2e/tests/integration/rust/deployment.rs).
Whether the running agent follows `tools.enabled` belongs to Fabric: [NVIDIA/NeMo-Fabric#669](https://github.com/NVIDIA/NeMo-Fabric/issues/669).

## Sub-features

- `shell-success`: the native shell-launch tool runs `printf 'shell-ok\n'` and returns `shell-ok` with exit 0; after the config change, the shell is rejected and no shell call runs. Phases: Initial, After stop/start, After recreate, After config change, After restore.

## How to get to it (user POV)

- A request through `fabric-agent-ctl invoke`, as [deploy-and-answer](../../verify-yaml-deployment/features/deploy-and-answer.md) sends it.
- The tool allow-list in the YAML, from which [lifecycle-and-retention](lifecycle-and-retention.md) removes only the shell-launch tool for Config change.

## Driving it with fabric-agent-ctl and the OpenShell CLI

Preconditions: the [request helpers](README.md#driving-conventions) are defined.

1. **`shell-success`:**

   ```sh
   CASE=shell-success; CHECK_DIR=$EVIDENCE/$PHASE/$CASE
   fill <<'EOF' | ask request
   Use the native <shell-tool> tool. Run this exact command:
   printf 'shell-ok\n'
   Report the actual stdout and exit status. If <shell-tool> is disabled, report that and do not run the command another way.
   EOF
   ```

   Result: `request.calls.txt` shows a current-turn `$SHELL_TOOL` call with that command, stdout `shell-ok`, and exit 0, and the reply reports the same.
2. **After config change:** the shell is disabled, so send the same prompt and pass when:
   - the runtime's native tool list for this turn lacks `$SHELL_TOOL`, or its call returns a native policy rejection;
   - no current-turn call runs the command through another tool, such as a code-execution, process, or UI terminal tool; and
   - the reply reports the tool disabled.

   Save the runtime's tool list for the turn in `$CHECK_DIR/tools.txt`.
   A model that declines while the tool is still exposed doesn't pass: the restriction didn't take effect, and the check is Failed.
   When the adapter offers no supported way to remove only the shell-launch tool, this row is Failed, linked to one missing-implementation finding, as [lifecycle-and-retention](lifecycle-and-retention.md) step 7 records it.
3. **After restore:** step 1's result holds again.
   If Config change was blocked, this row is Not tested, linked to that finding: there was no change to reverse.

## Gotchas

- Name the tool that launches a new command. A UI terminal or process-control tool may need an existing session and isn't interchangeable with it; asking for a "terminal" can select a different capability.
- Don't ask the agent to run a command "another way" or allow any alternative: the shell-disabled phase passes only on rejection.
- An approval policy or classifier that declines a command isn't the shell restriction: judge by tool exposure and actual calls.
- Keep the prompt the same across phases. If wording changes during diagnosis, record the change and compare both prompts on the same healthy runtime before blaming a transition.
- A timed-out request may still have run: read the current turn's calls before retrying.
