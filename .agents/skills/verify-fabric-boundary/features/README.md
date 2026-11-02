<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fabric-Boundary Feature Map

## Baseline Preconditions

- The [launch](../SKILL.md#launch) completed for this run, including the Fabric-boundary YAML edits, the seeded caller volumes, and `bindings.md`, and the [doctor](../SKILL.md#doctor) passes.
- `$EVIDENCE/checks.md` lists every selected check with an empty outcome: 136 rows, or 131 for `deepagents-code`.
- The inference source the target file chose answers its `/models` request.
- The OpenShell CLI matching `versions.json` on `PATH`, with `OPENSHELL_GATEWAY_ENDPOINT` and `OPENSHELL_WORKSPACE` set by the doctor.
- `jq`, `curl`, and `openssl` on the host.

## Driving Conventions

- Use the variables the launch sets, as [verify-yaml-deployment's conventions](../../verify-yaml-deployment/features/README.md#driving-conventions) list, plus `SKILL_DIR`, `WORKSPACE_VOLUME`, `ARTIFACTS_VOLUME`, and the `seed` function.
  For each check, set `PHASE` to the phase's directory name from [Lifecycle Phases](#lifecycle-phases), `CASE` to its Sub-feature ID, and save its files in `CHECK_DIR=$EVIDENCE/$PHASE/$CASE`.
- Send requests with [deploy-and-answer](../../verify-yaml-deployment/features/deploy-and-answer.md)'s `fabric-agent-ctl invoke` command, and read the runtime ID again after every transition.
  Reach native interfaces through the entry points apply prints.
- **Native evidence.** Exercise each capability through the agent's native mechanism in the managed runtime: its tool calls, skill discovery, plugin registration and events, or interface.
  A headless request can't substitute for native interaction.
  Never launch a second loader or standalone harness process, dispatch a hook by hand, or paste a skill's contents into a prompt to bypass discovery.
- **Current-turn tool calls.** Save the current turn's native calls separately from earlier conversation history.
  A reply or call from an earlier turn proves nothing for this check.
- **Independent effect checks.** Read every effect yourself, outside the agent's reply, for example with `openshell sandbox exec -n assistant --no-tty -- cat PATH`, a hash, or an exit code.
  The agent's report alone never passes a check.
  Before retrying a request that timed out, check its effects and the current turn's calls: it may have succeeded.
- **Fresh phase input.** Before each phase, save a copy of `results/`, write a fresh nonce and the phase into the inputs, and remove only the stale outputs of the check about to run:

  ```sh
  NONCE=$(openssl rand -hex 8)
  printf '{"nonce":"%s","phase":"%s"}\n' "$NONCE" "$PHASE" | openshell sandbox exec -n assistant --no-tty -- sh -c 'cat > /sandbox/workspace/fixtures/probe-input.json'
  printf '%s\n' "$NONCE" | openshell sandbox exec -n assistant --no-tty -- sh -c "cat > /sandbox/workspace/fixtures/$PHASE-script-input.txt"
  ```

  The input JSON holds only `nonce` and `phase`.
  Before a plugin event check, confirm that its trigger and ledger entries for this nonce are absent.
  Never put the input nonce or a skill's hidden recipe in a file or skill prompt; use a unique request ID when the harness supports one.
- **Prompts.** Send each feature file's prompt exactly. Replace only its `<...>` placeholders, with values from `bindings.md`, and send the same text in every phase.
  Save the exact text sent in `CHECK_DIR`.
  The agent file may add a harness constraint; it must not change the requested behavior or the expected output.
  Write and review prompts by these rules:
  - Put each command alone on the line after `Run this exact command:`. Don't end that line with punctuation: the agent can pass a trailing `.` to the command as an argument.
  - Send one script run or installer command per request, so one timeout or refusal affects one check.
  - State output formats literally, including spacing, and give an example that does not use the phase input.
  - Ask only for results the agent sees in its own tool output. Resolve save locations, registration, and output yourself; don't ask the agent to search for where a native tool saved something.
  - Name the native tool from `bindings.md`. For shell checks, use the agent's shell-launch tool, not a UI terminal tool.
  - Before sending, check the filled prompt: no `<...>` placeholder remains, each command matches `bindings.md` and executable help, and nothing follows a command on its line.

  If a defective prompt reaches the agent, keep its request and reply as the check's evidence.
  Send a corrected prompt as a separately recorded diagnostic; it doesn't replace the check.

  | Placeholder | Value from `bindings.md` |
  |---|---|
  | `<shell-tool>` | The shell-launch tool |
  | `<file-write-tool>` | The native file-write tool |
  | `<skill-authoring>` | The native skill-authoring tool; if none is established, `your native file tools` |
  | `<skill-name>`, `<marker>` | The run-scoped generated skill name and marker |
  | `<skill-dir>` | The documented native skill directory, used only if authoring requires a location |
  | `<script>` | `supplied-script.sh` or `generated-script.sh` |
  | `<input-file>` | `/sandbox/workspace/fixtures/$PHASE-script-input.txt` |
  | `<install-command>` | The reviewed native installer command |

- Read any interface credential into a shell variable just before a request and unset it after.
- A feature that needs a supplied fixture gives it in a fenced block under a **Seed** step; the [launch](../SKILL.md#provision-and-seed-the-volumes) writes it into the volume once.

## Proof Rules

Each check gets one of three outcomes:

| Outcome | Meaning |
|---|---|
| Passed | Exercised; native and independent evidence support every assertion |
| Failed | Exercised and contradicted, or the adapter, harness, or integration lacks support for an in-scope capability |
| Not tested | A runner, access, credential, procedure, or evidence problem prevented a valid check, or the check depends on an earlier finding that left no usable runtime |

- **Missing support is Failed.** Link every check it affects to one shared finding with revision-specific source or image evidence. Never weaken a check to match what a revision supports.
- **Shared findings.** Explain each immediate problem once in `findings.md` and link every affected check to its ID. Every check that isn't Passed names a finding, and every finding is used.
- **Dependent checks.** A check blocked by an earlier finding's unusable runtime is Not tested, linked to that finding. Keep checking what stays independent, such as file retention, and reassess blocked checks after each transition.
- A later diagnostic, recovery, or retry never turns an earlier failure into a pass.
- YAML acceptance, apply success, and files on disk prove no capability. Retained files prove neither native discovery, registration, fresh execution, nor conversation resume.
- An expected command failure or policy rejection passes when the native evidence shows the asserted behavior.
- A proof through one entry point doesn't cover the others a feature lists; a result for one agent or model doesn't cover another.

## Lifecycle Phases

Phases run in this order, once each. A transition phase holds one lifecycle check; the phase after it re-runs the checks that list it.

| Phase | Directory | What happens | Checks (`hermes`, `openclaw` / `deepagents-code`) |
|---|---|---|---|
| Initial | `initial` | First apply; first-start discovery, then inference, then every feature's first checks, including authoring, install, activation, and use; unchanged plan/apply for `agent-plugin-reconcile` | 33 / 32 |
| Runtime restart | `runtime-restart` | Stop only the managed Fabric runtime through supported control, then unchanged plan/apply; the same sandbox gets a new usable runtime | 1 |
| After runtime restart | `after-runtime-restart` | Re-run the mounted script, skill, extension, and agent-plugin reuse checks | 9 |
| Stop/start | `stop-start` | Stop and start the same sandbox through OpenShell's supported commands, confirming the stopped state and lost access, then unchanged plan/apply | 1 |
| After stop/start | `after-stop-start` | Re-run every check that lists this phase | 22 / 21 |
| Recreate | `recreate` | Preview and destroy the deployment, keeping state and caller volumes, then plan/apply the baseline YAML; a new sandbox replaces the old one | 1 |
| After recreate | `after-recreate` | Re-run every check that lists this phase | 22 / 21 |
| Config change | `config-change` | Change only the agent's supported shell restriction from the baseline, save the diff, then plan/apply | 1 |
| After config change | `after-config-change` | Re-run every check that lists this phase; shell checks expect rejection with no other execution path | 22 / 21 |
| Restore | `restore` | Restore the exact baseline YAML, then plan/apply | 1 |
| After restore | `after-restore` | Re-run every check that lists this phase; shell execution returns | 22 / 21 |
| Teardown | `teardown` | Preview and destroy, then list the retained caller volumes, model cache, and evidence | 1 |

[lifecycle-and-retention](lifecycle-and-retention.md) drives each transition and gives its commands.

## Features

| File | Sub-feature IDs | Feature |
|---|---|---|
| [invoke-and-tools.md](invoke-and-tools.md) | `inference`, `file-read`, `file-write`, `shell-success`, `shell-failure`, `mounted-supplied-script`, `mounted-generated-script` | The agent answers through Fabric and uses its native file and shell tools on mounted scripts |
| [native-interfaces.md](native-interfaces.md) | `tui`, `web-ui` | The agent's native terminal UI and web UI, with a file effect and a reconnect |
| [skills.md](skills.md) | `skill-discovery`, `skill-execution`, `mounted-skill-yaml`, `mounted-skill-first-start`, `mounted-supplied-skill`, `generated-skill`, `mounted-generated-skill`, `mounted-generated-skill-save` | Supplied skills load from the mounted directory, and a skill the agent creates is saved there and found again |
| [plugins.md](plugins.md) | `plugin-load`, `plugin-hooks`, `agent-plugin-author`, `agent-plugin-install`, `agent-plugin-activate`, `agent-plugin-reuse`, `agent-plugin-reconcile` | Bundled plugins load and fire hooks, and a plugin the agent writes and installs stays active |
| [mounted-extensions.md](mounted-extensions.md) | `mounted-native-tool-yaml`, `mounted-native-tool-first-start`, `mounted-plugin-yaml`, `mounted-plugin-first-start`, `mounted-supplied-native-tool`, `mounted-generated-native-tool`, `mounted-supplied-plugin`, `mounted-generated-plugin` | Native tools and plugins on the mounted workspace, supplied or agent-written, register and run |
| [lifecycle-and-retention.md](lifecycle-and-retention.md) | `retention`, `extension-runtime-restart`, `stop-start`, `recreate`, `change`, `restore`, `teardown` | Each lifecycle transition, and the workspace and artifact files that survive it |

In the Initial phase, run the checks in this order:

1. The three `-first-start` checks and the `-yaml` checks, before any request that changes content.
2. `inference`.
3. The rest of each file in table order, with `agent-plugin-reconcile` last.
4. `retention`.

For `deepagents-code`, `web-ui` is out of this skill's scope; the check log omits it.

Each Sub-feature line ends with `Phases:` and its comma-separated phase names, as the [check log](../SKILL.md#evidence) reads them.
