<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Bundled and Agent-Installed Plugins

A user enables a harmless plugin that ships with the agent's harness, and the managed runtime registers it and runs its hook when the agent acts.
The user also asks the agent to write a native plugin of its own, and to install and enable a pinned plugin through the harness's native installer and controls, without the operator doing either for it.
The installed plugin keeps working after an unchanged apply and after every lifecycle transition, with its code, dependencies, and enablement unchanged.
Files that survive a transition aren't enough: each phase needs fresh registration and a fresh plugin effect in the managed runtime.

## Sub-features

- `plugin-load`: the bundled plugin that the YAML enables is registered in the actual managed runtime, as the runtime's own registration record shows, not only the deployed configuration. Phases: Initial, After stop/start, After recreate, After config change, After restore.
- `plugin-hooks`: a real native agent action fires the bundled plugin's recorded hook in that runtime, and its exact effect appears at the recorded evidence path; no hook is dispatched by hand. Phases: Initial, After stop/start, After recreate, After config change, After restore.
- `agent-plugin-author`: the agent writes one run-scoped native plugin with a probe tool and a file-write hook through its own file tools, and its source and packaging pass independent inspection and any static native validation. Phases: Initial.
- `agent-plugin-install`: the agent runs the reviewed native installer for a pinned harmless plugin through its shell-launch tool, the installer completes in the managed environment, and the installed identity matches the source. Phases: Initial.
- `agent-plugin-activate`: the agent enables the installed plugin through supported native controls, and the managed runtime registers it. Phases: Initial.
- `agent-plugin-reuse`: the installed plugin keeps its code, dependencies, and enablement, and gives a fresh native tool result or hook event after activation and after every transition, with no reinstall or repair. Phases: Initial, After runtime restart, After stop/start, After recreate, After config change, After restore.
- `agent-plugin-reconcile`: an unchanged plan/apply on a healthy runtime keeps the agent-installed plugin enabled and usable, with the declared configuration unchanged. Phases: Initial.

## How to get to it (user POV)

- The bundled plugin that the launch enables, with its plugin and tool settings.
- A request through `fabric-agent-ctl invoke`, as [deploy-and-answer](../../verify-yaml-deployment/features/deploy-and-answer.md) sends it, asking the agent to act, to write a plugin, or to run its native installer and enablement.
- The mounted plugin directory `/sandbox/workspace/extensions/plugins/`, where the agent writes its plugin, and the harness's native plugin install location, as `bindings.md` records them.

## Driving it with fabric-agent-ctl and the OpenShell CLI

Preconditions: the [launch](../SKILL.md#launch) wrote `bindings.md` with the `shell-launch tool`, `file-write tool`, and `native call record` lines, and the phase's [fresh phase input](README.md#driving-conventions) is written: `fixtures/probe-input.json` holds this phase's `NONCE`.
The runner never installs, enables, or loads a plugin for the agent, and never pre-enables the agent-installed plugin in YAML.

1. **Record the plugin bindings.** Before the first apply, add a `## Plugins` section to `$EVIDENCE/bindings.md`. Resolve each entry against the selected YAML, the image's adapter descriptor, and the image's harness source and executable help:
   - **Bundled plugin:** a harmless plugin that ships in the selected image, the YAML field that enables it, the event its hook observes, the exact effect it writes, and the evidence path that shows the effect. Choose one whose event a native tool call or model turn fires. A tool, MCP service, middleware, or separate diagnostic process is not a native plugin.
   - **Registration record:** where the managed runtime records the plugins it registered, such as its startup log or its tool list for a turn. A native CLI that reads configuration shows enablement, not registration.
   - **Plugin format:** the native manifest format, language, and directory layout the agent's plugin must use, with the source or guidance that establishes it.
   - **Authoring reference:** the plugin guidance the agent gets before it writes its plugin, for the selected harness revision: either locations the agent has read with its own tools, or the plugin API written out for the prompt. Record the source and revision. The runner reading a file through OpenShell or in the image doesn't show that the agent can read it.
   - **Native validation:** a static check of a plugin's manifest and source, if the harness has one that doesn't load the plugin into a second runtime; otherwise `none`.
   - **Installer and enablement:** the native installer, the native enablement control, the native enablement record (a file or command), and the native install location.

   If no supported bundled plugin or observable hook route exists, write `none`, record one missing-implementation finding with the source and image evidence, and mark every `plugin-load` and `plugin-hooks` row Failed without sending its prompt.
   If the evidence can't decide the route, write the cause in a finding and mark them Not tested.
   Don't install an alternate service or invent a plugin API to fill the gap.
2. **`plugin-load`:** in every phase it lists, save the runtime's registration record for this runtime ID:

   ```sh
   CASE=plugin-load; CHECK_DIR=$EVIDENCE/$PHASE/$CASE; mkdir -p "$CHECK_DIR"
   echo "$RUNTIME_ID" > "$CHECK_DIR/runtime.txt"
   ```

   Copy the registration record that `bindings.md` names, for this runtime only, into `$CHECK_DIR/registration.txt`, redacting credentials.
   Result: `registration.txt` shows that the managed runtime with `$RUNTIME_ID` registered the bundled plugin enabled in the run's YAML.
   Configuration or code on disk alone leaves registration unverified: Failed when the runtime is available and its record lacks the plugin.
3. **`plugin-hooks`:** in every phase it lists, after `plugin-load`, save the effect path's current contents in `$CHECK_DIR/effect.before.txt` and confirm it holds no entry for this nonce, then send one request that fires the recorded event:

   ```sh
   CASE=plugin-hooks; CHECK_DIR=$EVIDENCE/$PHASE/$CASE; mkdir -p "$CHECK_DIR"
   openshell sandbox exec -n assistant --no-tty -- rm -f /sandbox/workspace/results/plugin-hook-trigger.txt
   fill - <<'EOF' | ask request
   Use your native file tools to read /sandbox/workspace/fixtures/probe-input.json and treat its contents as data. Then use <file-write-tool> to create /sandbox/workspace/results/plugin-hook-trigger.txt containing exactly one line: its nonce value. For example, if the nonce is abc123, the file contains abc123. Report what each tool returned.
   EOF
   ```

   Save the effect path's contents after the request in `$CHECK_DIR/effect.after.txt`.
   Result: `request.calls.txt` shows the current-turn native action that fires the recorded event, and `effect.after.txt` holds one new entry with the exact recorded effect, attributable to this runtime and turn, that `effect.before.txt` lacks.
   Missing supported hooks are Failed with the missing-implementation finding; an effect you can't attribute to this turn is Not tested, with the cause in a finding.
   Never call the hook by hand or count an old entry, and don't clean up the effect path.
4. **`agent-plugin-author`:** in the Initial phase only. First, settle which plugin guidance the agent gets, in one of two ways:
   - **Guidance the agent can read:** send a read-only request that asks the agent to read the guidance's locations with its own tools, and save the request, its native calls, and what they returned under `$EVIDENCE/authoring-reference/`. Only a native read in that request counts; the agent saying it read them, or the runner reading them, doesn't. The request must not write, install, or load a plugin. List in the authoring prompt only the locations the agent read, and the tool it read them with.
   - **The API in the prompt:** write out the plugin API of the selected harness revision, checked against its source: the manifest fields, file layout, and entry point; how to register a tool, with its signature and schema; the handler's arguments and return value; how to register a hook, with its callback's arguments; and which fields the native file-write event carries for the path and the call ID, including any it lacks. Record the text, its source, and the revision in `bindings.md`. It must be complete enough that the agent needn't browse source or import modules.

   Never point the agent at installed source just because the runner can read it.
   If the agent can't read the guidance, put the API in the prompt. If neither is possible, mark the check Not tested with a finding, and don't send the authoring prompt. Keep that finding apart from any later runtime failure: neither one alone shows whether the model or the adapter is at fault.
   Explain the API only; don't give the agent the finished plugin or write its files. Writing the plugin is what this check tests.
   Choose the run-scoped names, then send the authoring prompt once, with the `plugin format` and `authoring reference` that `bindings.md` records appended:

   ```sh
   CASE=agent-plugin-author; CHECK_DIR=$EVIDENCE/$PHASE/$CASE
   AGENT_PLUGIN_ID=fb-plugin-$(printf '%s' "$UID_" | cut -c1-8)
   AGENT_PLUGIN_TOOL=fb_probe_$(printf '%s' "$UID_" | tr -dc '[:alnum:]' | cut -c1-8)
   AGENT_PLUGIN_DIR=/sandbox/workspace/extensions/plugins/$AGENT_PLUGIN_ID
   printf 'AGENT_PLUGIN_ID=%s\nAGENT_PLUGIN_TOOL=%s\nAGENT_PLUGIN_DIR=%s\n' "$AGENT_PLUGIN_ID" "$AGENT_PLUGIN_TOOL" "$AGENT_PLUGIN_DIR" > "$EVIDENCE/agent-plugin.env"
   fill - <<EOF | ask create
   Use <file-write-tool> to create a native plugin for this harness in $AGENT_PLUGIN_DIR, in the harness's native plugin format, with plugin ID $AGENT_PLUGIN_ID. Use the plugin guidance appended below. Read guidance only at the locations it lists, and don't search for or import harness source that isn't listed. The plugin must do exactly two things and nothing else. First, register a native tool named $AGENT_PLUGIN_TOOL that takes one string argument, nonce, and returns a JSON object with exactly three keys: origin set to agent-generated, nonce set to the argument, and kind set to native-tool. For example, for nonce abc123 it returns {"origin":"agent-generated","nonce":"abc123","kind":"native-tool"}. Second, register a hook that runs after each native file-write tool call. When the written path is exactly /sandbox/workspace/results/agent-plugin-trigger.txt, it appends one line to /sandbox/workspace/results/agent-plugin-ledger.jsonl: a JSON object with origin set to agent-generated, nonce set to the first line of the trigger file, tool set to the native tool name, and call_id set to the tool call ID if the event carries one. For any other path it does nothing. The plugin must have no dependencies, network access or other file access. Do not install, enable, load or run it. Report what each tool returned.
   EOF
   ```

   Record whether the request completed in `$CHECK_DIR/create.status.txt`; a timed-out request may still have written files.
   Copy the source into `$CHECK_DIR/source/`, run the static validation that `bindings.md` names, and write `$CHECK_DIR/review.md`: the manifest and plugin ID, the tool and its schema, the hook and its event, the exact trigger and ledger paths, and no dependencies, network access, or other effects.
   If validation or review finds a concrete error, send the error text back to the agent in a corrective request saved as `fix-1`, `fix-2`, and so on, and stop when a request makes no progress or needs more authority. Keep every attempt and record the first attempt's errors.
   Then seal the source:

   ```sh
   openshell sandbox exec -n assistant --no-tty -- sh -c 'cd "$1" && find . -type f -exec sha256sum {} + | sort -k2' sh "$AGENT_PLUGIN_DIR" > "$EVIDENCE/agent-plugin.sha256"
   ```

   Result: `create.calls.txt` or a `fix-N.calls.txt` shows current-turn native writes of every file in `agent-plugin.sha256`, and `review.md` and the validation show valid native packaging.
   Never write or fix the plugin for the agent.
   No native authoring route is Failed with a missing-implementation finding; a plugin format that the evidence can't establish is Not tested, with the cause in a finding.
   Authoring proves neither loading nor use. [mounted-extensions](mounted-extensions.md) reuses this plugin, `agent-plugin.env`, and `agent-plugin.sha256` for its generated tool and hook checks; a missing Fabric loader doesn't block authoring.
5. **Choose and review the installed plugin.** Before `agent-plugin-install`, choose a pinned harmless plugin that produces the same bounded tool or hook evidence as step 4's plugin:
   - Prefer the supplied plugin fixture that [mounted-extensions](mounted-extensions.md) seeds, if the native installer accepts a local path and the installed copy doesn't collide with that fixture's mounted registration.
   - Otherwise choose a reviewed immutable package and revision, and record its dependencies and the network access it needs. Ask the user before an install that downloads from the network.

   Install only inside this run's sandbox and writable storage, within the existing policy. Don't change host packages or widen network policy to make it pass; record an unmet prerequisite in a finding.
   Resolve the installer command from the image's executable help, review it, write it to `bindings.md` as the `install command` line, and read it:

   ```sh
   INSTALL_COMMAND=$(binding 'install command'); echo "$INSTALL_COMMAND"
   ```

   Record the plugin's identity and its effect in `$EVIDENCE/agent-plugin-install.env` as `INSTALLED_PLUGIN` and either `INSTALLED_TOOL` or `INSTALLED_TRIGGER` and `INSTALLED_LEDGER`, leaving the unused ones empty.
   If no native installer exists, write `none`, record a missing-implementation finding, and mark `agent-plugin-install` Failed without sending its prompt.
6. **`agent-plugin-install`:** in the Initial phase only, send the install prompt once:

   ```sh
   CASE=agent-plugin-install; CHECK_DIR=$EVIDENCE/$PHASE/$CASE
   fill - <<'EOF' | ask install
   Use the native <shell-tool> tool. Run this exact command:
   <install-command>
   Report the actual installer output and exit status, and the installed path or identity if the installer prints one. Stop at the first installer failure. Do not retry, change configuration or network policy, copy files manually or use another installer.
   EOF
   ```

   From `install.calls.txt`, save the installer's command, output, exit status, and any approval in `$CHECK_DIR/installer.txt`.
   Resolve the installed directory yourself from the installer output and the native install location in `bindings.md`, and append it to `$EVIDENCE/agent-plugin-install.env` as `INSTALLED_DIR`.
   Save the installed manifest in `$CHECK_DIR/manifest.txt` and the dependency versions in `$EVIDENCE/agent-plugin-deps.txt`, then seal the installed tree:

   ```sh
   . "$EVIDENCE/agent-plugin-install.env"
   openshell sandbox exec -n assistant --no-tty -- sh -c 'cd "$1" && find . -type f -exec sha256sum {} + | sort -k2' sh "$INSTALLED_DIR" > "$EVIDENCE/agent-plugin-installed.sha256"
   ```

   Result: `install.calls.txt` shows one current-turn `$SHELL_TOOL` call running `$INSTALL_COMMAND` with exit 0, and the installed manifest's identity and version match the reviewed source.
   Generated code, files the runner copied, or the agent's claims alone don't pass. If only an operator can install, record that limitation in the finding.
   A failed install makes `agent-plugin-activate`, every `agent-plugin-reuse` row, and `agent-plugin-reconcile` Not tested, linked to its finding.
7. **`agent-plugin-activate`:** in the Initial phase only. Save the native enablement record from `bindings.md` in `$CHECK_DIR/enablement.before.txt`.
   If the installer already enabled the plugin, record that and send no prompt.
   Otherwise resolve the native enablement command from the image's executable help, review it, write it to `bindings.md` as the `enable command` line, and send:

   ```sh
   CASE=agent-plugin-activate; CHECK_DIR=$EVIDENCE/$PHASE/$CASE
   ENABLE_COMMAND=$(binding 'enable command'); echo "$ENABLE_COMMAND"
   fill - <<EOF | ask enable
   Use the native <shell-tool> tool. Run this exact command:
   $ENABLE_COMMAND
   Report the actual output and exit status. Stop at the first failure. Do not retry, install anything, copy files manually or change any other configuration.
   EOF
   ```

   Save the enablement record again in `$CHECK_DIR/enablement.after.txt`, and copy it to `$EVIDENCE/agent-plugin-enablement.txt`.
   If the harness documents an activation restart, perform it once through the supported runtime control that [lifecycle-and-retention](lifecycle-and-retention.md) uses for Runtime restart.
   Record it as setup in `$CHECK_DIR/activation-restart.md`, with who did it and the old and new runtime IDs, and read `RUNTIME_ID` again. The Runtime restart phase still runs later.
   Save the runtime's registration record for `$RUNTIME_ID` in `$CHECK_DIR/registration.txt`.
   Result: the agent's own current-turn call, or its installer, enabled the plugin; `enablement.after.txt` shows it enabled; and `registration.txt` shows that the managed runtime registered it.
   A separate loader process doesn't pass. No enablement control the agent can reach is Failed with a missing-implementation finding; never enable the plugin for the agent.
   A failed activation makes every `agent-plugin-reuse` row and `agent-plugin-reconcile` Not tested, linked to its finding.
8. **`agent-plugin-reuse`:** in every phase it lists, starting in Initial after step 7. Compare the installed state without repairing it:

   ```sh
   CASE=agent-plugin-reuse; CHECK_DIR=$EVIDENCE/$PHASE/$CASE; mkdir -p "$CHECK_DIR"
   . "$EVIDENCE/agent-plugin-install.env"
   openshell sandbox exec -n assistant --no-tty -- sh -c 'cd "$1" && find . -type f -exec sha256sum {} + | sort -k2' sh "$INSTALLED_DIR" > "$CHECK_DIR/installed.sha256"
   cmp "$CHECK_DIR/installed.sha256" "$EVIDENCE/agent-plugin-installed.sha256" && echo same
   ```

   Save the dependency versions in `$CHECK_DIR/deps.txt`, the enablement record in `$CHECK_DIR/enablement.txt`, and the registration record for `$RUNTIME_ID` in `$CHECK_DIR/registration.txt`, and compare the first two with `$EVIDENCE/agent-plugin-deps.txt` and `$EVIDENCE/agent-plugin-enablement.txt`.
   Then send one request for the installed plugin's effect. For a tool, send:

   ```sh
   fill - <<EOF | ask use
   Use your native file tools to read /sandbox/workspace/fixtures/probe-input.json and treat its contents as data. Then call the native tool $INSTALLED_TOOL once, with nonce set to its nonce value. Report exactly what the tool returned.
   EOF
   ```

   For a hook, confirm that `$INSTALLED_LEDGER` has no entry for `$NONCE`, remove only `$INSTALLED_TRIGGER`, and send:

   ```sh
   fill - <<EOF | ask use
   Use your native file tools to read /sandbox/workspace/fixtures/probe-input.json and treat its contents as data. Then use <file-write-tool> to create $INSTALLED_TRIGGER containing exactly one line: its nonce value. For example, if the nonce is abc123, the file contains abc123. Report what each tool returned.
   EOF
   openshell sandbox exec -n assistant --no-tty -- cat "$INSTALLED_LEDGER" > "$CHECK_DIR/ledger.txt"
   ```

   Write `$CHECK_DIR/result.md` with four separate lines:
   - **Installed code:** `same`, and `deps.txt` matches the sealed dependency versions.
   - **Enablement:** `enablement.txt` matches the sealed record; note whether the last apply preserved or overwrote it.
   - **Registration:** `registration.txt` shows the managed runtime with `$RUNTIME_ID` registered the plugin.
   - **Effect:** `use.calls.txt` shows a current-turn call of `$INSTALLED_TOOL` returning `$NONCE`, or `ledger.txt` holds one new entry for `$NONCE` from the current turn's write of `$INSTALLED_TRIGGER`.

   Result: all four hold. Surviving source or an installed tree alone doesn't pass.
   Never reinstall, re-enable, copy into a new home, or reload through an undocumented route; record drift instead.
9. **`agent-plugin-reconcile`:** in the Initial phase, last, after `agent-plugin-reuse` passes in Initial and before the Runtime restart phase. Record the state, run an unchanged plan and apply, and compare:

   ```sh
   CASE=agent-plugin-reconcile; CHECK_DIR=$EVIDENCE/$PHASE/$CASE; mkdir -p "$CHECK_DIR"
   sha256sum -c "$EVIDENCE/baseline.sha256" | tee "$CHECK_DIR/yaml.txt"
   cmp "$RUN_DIR/deployment.yaml" "$EVIDENCE/baseline.yaml" && echo unchanged
   ```

   Save the runtime ID, the sandbox container ID, the installed tree's hashes, and the enablement record in `$CHECK_DIR/before.txt`.
   Run [Plan and Apply](../../verify-yaml-deployment/SKILL.md#plan-and-apply) with the unchanged YAML, saving the plan and apply output in `$CHECK_DIR/`, then the [doctor](../SKILL.md#doctor), and read `RUNTIME_ID` again.
   Save the same four values in `$CHECK_DIR/after.txt`, write a fresh nonce as [fresh phase input](README.md#driving-conventions) does, then send step 8's request for the plugin's effect in this `CHECK_DIR`.
   Result: `unchanged`; the plan lists no change to the declared configuration; the sandbox container ID is the same; the installed hashes and enablement in `after.txt` match `before.txt`; registration and the fresh effect hold as in step 8.
   Overwritten enablement is Failed, even under a documented reset policy. Don't export the change back into YAML or re-enable the plugin to make it pass.
## Gotchas

- Keep the origins separate: the bundled plugin, the mounted supplied and generated plugins in [mounted-extensions](mounted-extensions.md), and the agent-installed plugin each need their own evidence. A pass for one covers no other.
- A native CLI that lists plugins from configuration shows enablement, not registration. Registration evidence comes from the managed runtime with the current `RUNTIME_ID`.
- Never launch a second loader, a standalone harness process, or a validator that loads the plugin, and never dispatch a hook by hand, to show registration or an effect.
- The agent installs and enables the plugin; the runner reviews the commands and reads the effects. If only the operator can do a step, it's a finding, not a reason to do it for the agent.
- If installing the supplied fixture would register a second copy under the same ID as its mounted copy, choose a pinned package instead and record why: a collision makes both checks ambiguous.
- An activation restart in Initial is setup. Record it, and still run the Runtime restart phase; it doesn't count as retention evidence.
- The agent writes its plugin once, in the Initial phase. Never rewrite, reseed, reinstall, or re-enable it after a transition; missing or changed files are evidence.
- A timed-out install or enable request may still have run: read its effects and the current turn's calls before deciding the outcome. Never retry the installer in the check itself.
