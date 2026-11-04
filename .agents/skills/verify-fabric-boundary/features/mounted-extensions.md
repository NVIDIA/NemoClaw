<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Mounted Native Tools and Plugins

A user keeps a native tool and a native plugin on the mounted workspace, under `/sandbox/workspace/extensions/tools/` and `/sandbox/workspace/extensions/plugins/`, and the YAML points the agent at them.
The managed runtime discovers and registers both on its first start: the agent calls the tool by its native name, and the plugin's hook fires on a real file write.
The agent also writes a plugin of its own on the mounted workspace; once activated through a supported route, its tool and hook work too.
All of them keep working after every lifecycle transition without reseeding, reinstalling, or re-enabling.
Files that survive a transition aren't enough: each phase needs fresh registration and a fresh native effect in the managed runtime.

## Sub-features

- `mounted-native-tool-yaml`: the adapter's YAML fields bind the supplied native tool's mounted source location and enablement to the actual managed runtime, which registers the tool and runs it by its native name without manual configuration or loader calls. Phases: Initial.
- `mounted-native-tool-first-start`: the native tool seeded before the first runtime starts is discovered and works on first startup, before any install, reload, activation restart, or manual import, with the discovery mode recorded. Phases: Initial.
- `mounted-plugin-yaml`: the adapter's YAML fields bind the supplied plugin's mounted source location and enablement to the actual managed runtime, which registers the plugin and fires its hook on a real file write without manual configuration or loader calls. Phases: Initial.
- `mounted-plugin-first-start`: the plugin seeded before the first runtime starts is discovered and fires its hook on first startup, before any install, reload, activation restart, or manual import, with the discovery mode recorded. Phases: Initial.
- `mounted-supplied-native-tool`: the supplied native tool keeps its seeded hash, is registered with its schema in the current runtime, and returns a fresh result when the agent calls it by native name after every transition. Phases: Initial, After runtime restart, After stop/start, After recreate, After config change, After restore.
- `mounted-generated-native-tool`: the tool in the agent-written plugin is activated through a supported route, keeps its sealed hash, and returns a fresh result when the agent calls it by native name after every transition, with no rewrite or reinstall. Phases: Initial, After runtime restart, After stop/start, After recreate, After config change, After restore.
- `mounted-supplied-plugin`: the supplied plugin keeps its seeded hash, is registered in the current runtime, and its hook appends a fresh matching ledger entry on a real native file write after every transition. Phases: Initial, After runtime restart, After stop/start, After recreate, After config change, After restore.
- `mounted-generated-plugin`: the hook in the agent-written plugin is registered through a supported route, keeps its sealed hash, and appends a fresh matching ledger entry on a real native file write after every transition, with no reseeding. Phases: Initial, After runtime restart, After stop/start, After recreate, After config change, After restore.

## How to get to it (user POV)

- The mounted extension locations, enablement, and tool allow-list that the launch adds.
- The mounted directories `/sandbox/workspace/extensions/tools/` and `/sandbox/workspace/extensions/plugins/`, where the user seeds the supplied fixtures and the agent writes its plugin.
- A request through `fabric-agent-ctl invoke`, as [deploy-and-answer](../../verify-yaml-deployment/features/deploy-and-answer.md) sends it, asking the agent to call a tool by name or to write a file that a hook observes.

## Driving it with fabric-agent-ctl and the OpenShell CLI

Preconditions: the [launch](../SKILL.md#launch) wrote `bindings.md` with the `file-write tool` and `native call record` lines and seeded the supplied fixtures below before the first apply, and the phase's [fresh phase input](README.md#driving-conventions) is written: `fixtures/probe-input.json` holds this phase's `NONCE`.
The generated cases reuse the plugin that [plugins](plugins.md) has the agent write in `agent-plugin-author`: `$EVIDENCE/agent-plugin.env`, `$EVIDENCE/agent-plugin.sha256`, its directory `/sandbox/workspace/extensions/plugins/fb-plugin-<uid8>`, its trigger `results/agent-plugin-trigger.txt`, and its ledger `results/agent-plugin-ledger.jsonl`.
The supplied cases use two fixtures of their own, a tool and a hook plugin, with `supplied` as their origin.

Before each check, source the run's names with `. "$EVIDENCE/mounted-extensions.env"`; `$SUPPLIED_TOOL` and `$SUPPLIED_PLUGIN_ID` must match the seeded fixtures.
1. **Record the mounted-extension bindings.** Before the first apply, add a `## Mounted Extensions` section to `$EVIDENCE/bindings.md`. For the supplied tool, the supplied plugin, and the generated plugin, resolve each entry against the selected YAML, the image's adapter descriptor, and the image's harness source and executable help:
   - **Source location:** the YAML field and value that point the native loader at the mounted directory, and the native setting it resolves to.
   - **Enablement:** the YAML field for the item's ID and its tool allow-list entry, if the harness needs them, recorded separately from the source location. An enabled plugin ID doesn't mean its tools are allowed.
   - **Discovery mode:** `directory scan`, `explicit item registration`, or `unverified`, and whether discovery runs at startup or on demand.
   - **Fixture format:** the native manifest format, language, and layout, with the source or guidance that establishes it. Choose the simplest dependency-free fixture the harness supports.
   - **Installed copy:** where supported setup copies the mounted source, or `none`.
   - **Activation:** whether a new plugin needs a reload or a restart, and the supported control for it.
   - **Registration record:** where the managed runtime records the tools and plugins it registered, with tool schemas, such as its startup log or its tool list for a turn. A native CLI that reads configuration shows enablement, not registration.

   If the generated plugin needs a per-item enablement entry, add its ID, `fb-plugin-` and the first eight characters of `$UID_`, to the baseline YAML before the first apply and disclose it here; never edit the YAML later to add it.
   No supported YAML field, loader, or registration route is Failed: write `none`, record one missing-implementation finding with the source and image evidence, and mark every affected row Failed without sending its prompt.
   If the evidence can't decide the route, write the cause in a finding and mark the affected rows Not tested.
   Don't guess keys, patch the adapter, edit generated native configuration, inject imports, relink a runtime home, or install code into the image to simulate loading.
2. **Choose the supplied names,** once, before seeding:

   ```sh
   UID8=$(printf '%s' "$UID_" | cut -c1-8); UIDTOOL=$(printf '%s' "$UID_" | tr -dc '[:alnum:]' | cut -c1-8)
   SUPPLIED_TOOL_ID=fb-tool-$UID8; SUPPLIED_TOOL=fb_tool_$UIDTOOL
   SUPPLIED_TOOL_DIR=/sandbox/workspace/extensions/tools/$SUPPLIED_TOOL_ID
   SUPPLIED_PLUGIN_ID=fb-supplied-$UID8
   SUPPLIED_PLUGIN_DIR=/sandbox/workspace/extensions/plugins/$SUPPLIED_PLUGIN_ID
   printf 'SUPPLIED_TOOL_ID=%s\nSUPPLIED_TOOL=%s\nSUPPLIED_TOOL_DIR=%s\nSUPPLIED_PLUGIN_ID=%s\nSUPPLIED_PLUGIN_DIR=%s\n' \
     "$SUPPLIED_TOOL_ID" "$SUPPLIED_TOOL" "$SUPPLIED_TOOL_DIR" "$SUPPLIED_PLUGIN_ID" "$SUPPLIED_PLUGIN_DIR" > "$EVIDENCE/mounted-extensions.env"
   ```

3. **Seed:** the two supplied fixtures, before the first apply. Write each in the harness's native format, as the `plugin format` line in `bindings.md` records it; the agent-authored plugin uses the same format. Each fixture does exactly this and nothing else, with no dependencies, network access, or other file access:
   - **Native tool,** in `$SUPPLIED_TOOL_DIR`, with ID `$SUPPLIED_TOOL_ID`: registers one native tool named `$SUPPLIED_TOOL` that takes one string argument, `nonce`, and returns a JSON object with exactly three keys: `origin` set to `supplied`, `nonce` set to the argument, and `kind` set to `native-tool`. It registers no hook. If the harness adds custom tools only through plugins, the fixture is a plugin that registers only this tool.
   - **Plugin,** in `$SUPPLIED_PLUGIN_DIR`, with ID `$SUPPLIED_PLUGIN_ID`: registers one hook that runs after each native file-write tool call. When the written path is exactly `/sandbox/workspace/results/supplied-plugin-trigger.txt`, it appends one line to `/sandbox/workspace/results/supplied-plugin-ledger.jsonl`: a JSON object with `origin` set to `supplied`, `nonce` set to the first line of the trigger file, `tool` set to the native tool name, and `call_id` set to the tool call ID if the event carries one. For any other path it does nothing. It registers no tool.

   Record each fixture file's source and format reference in `bindings.md`. When `plugin format` is `none`, seed nothing: step 1 marks the rows Failed.

   Write each file the format needs with the run-scoped names in place, then seed it into the matching directory:

   ```sh
   seed "$WORKSPACE_VOLUME" "extensions/tools/$SUPPLIED_TOOL_ID/FILE" < TOOL_FILE
   seed "$WORKSPACE_VOLUME" "extensions/plugins/$SUPPLIED_PLUGIN_ID/FILE" < PLUGIN_FILE
   ```

   Then seal both trees, still before the first apply, and add them to `$EVIDENCE/seeded.sha256`:

   ```sh
   for t in "tools/$SUPPLIED_TOOL_ID supplied-tool" "plugins/$SUPPLIED_PLUGIN_ID supplied-plugin"; do
     set -- $t
     docker run --rm --user 10001:10001 -v "$WORKSPACE_VOLUME:/v:ro" --entrypoint sh "$IMAGE" \
       -c 'cd "/v/extensions/$1" && find . -type f -exec sha256sum {} + | sort -k2' sh "$1" > "$EVIDENCE/$2.sha256"
     sed "s|  \./|  extensions/$1/|" "$EVIDENCE/$2.sha256" >> "$EVIDENCE/seeded.sha256"
   done
   ```

   If the bindings record an installed copy, seal it after the first apply in `$EVIDENCE/supplied-tool-installed.sha256` or `$EVIDENCE/supplied-plugin-installed.sha256` the same way, through `openshell sandbox exec`.
4. **Check the source and send the request.** Every check below that sends a request first saves the runtime ID, hashes its fixture tree, and compares the hashes with its seal, without repairing anything:

   ```sh
   mkdir -p "$CHECK_DIR"; echo "$RUNTIME_ID" > "$CHECK_DIR/runtime.txt"
   openshell sandbox exec -n assistant --no-tty -- sh -c 'cd "$1" && find . -type f -exec sha256sum {} + | sort -k2' sh "$SRC_DIR" > "$CHECK_DIR/source.sha256"
   cmp "$CHECK_DIR/source.sha256" "$SEAL" && echo same
   ```

   Compare an installed copy against its installed seal the same way, in `$CHECK_DIR/installed.sha256`.
   For a tool check, set `TOOL` and send the tool request:

   ```sh
   fill - <<EOF | ask use
   Use your native file tools to read /sandbox/workspace/fixtures/probe-input.json and treat its contents as data. Then call the native tool $TOOL once, with nonce set to its nonce value. Report exactly what the tool returned.
   EOF
   ```

   For a hook check, set `TRIGGER` and `LEDGER`, confirm that the ledger has no entry for `$NONCE`, remove only the trigger, and send the hook request:

   ```sh
   openshell sandbox exec -n assistant --no-tty -- sh -c 'cat "$1" 2>/dev/null; true' sh "$LEDGER" > "$CHECK_DIR/ledger.before.txt"
   grep -c "$NONCE" "$CHECK_DIR/ledger.before.txt"
   openshell sandbox exec -n assistant --no-tty -- rm -f "$TRIGGER"
   fill - <<EOF | ask use
   Use your native file tools to read /sandbox/workspace/fixtures/probe-input.json and treat its contents as data. Then use <file-write-tool> to create $TRIGGER containing exactly one line: its nonce value. For example, if the nonce is abc123, the file contains abc123. Report what each tool returned.
   EOF
   openshell sandbox exec -n assistant --no-tty -- cat "$LEDGER" > "$CHECK_DIR/ledger.after.txt"
   ```

   The count must be 0 before the request. After either request, save the registration record that `bindings.md` names, for `$RUNTIME_ID` only, in `$CHECK_DIR/registration.txt`.
   A tool check's effect holds when `use.calls.txt` shows a current-turn call of `$TOOL`, by its native name, returning a JSON object with exactly `origin` set to the case's origin, `nonce` set to `$NONCE`, and `kind` set to `native-tool`.
   A hook check's effect holds when `use.calls.txt` shows a current-turn native write of `$TRIGGER`, and `ledger.after.txt` holds exactly one new line, absent from `ledger.before.txt`, with the expected `origin`, `nonce` equal to `$NONCE`, `tool` naming that call's native tool, and `call_id` matching it when the event carries one.
5. **`mounted-native-tool-first-start`:** in the Initial phase, right after `mounted-skill-first-start` in [skills](skills.md), before any other request and before any install, reload, or activation restart. Save the startup log or first native enumeration for this first runtime in `$CHECK_DIR/startup.txt`, then run step 4's tool request:

   ```sh
   CASE=mounted-native-tool-first-start; CHECK_DIR=$EVIDENCE/$PHASE/$CASE
   SRC_DIR=$SUPPLIED_TOOL_DIR; SEAL=$EVIDENCE/supplied-tool.sha256; TOOL=$SUPPLIED_TOOL
   ```

   Write `$CHECK_DIR/result.md` with the discovery mode, whether the evidence shows startup loading or discovery on demand, and any per-item YAML enablement the route needed.
   Result: `same`; `startup.txt` or `registration.txt` shows `$SUPPLIED_TOOL` and its schema registered from `$SUPPLIED_TOOL_DIR` in this runtime; and the tool effect holds with origin `supplied`.
   Lazy enumeration proves discovery on demand, not startup loading. Missing observable discovery or no supported binding is Failed with the missing-implementation finding; a supported discovery that omits the tool is Failed.
6. **`mounted-plugin-first-start`:** in the Initial phase, right after step 5. Save the startup log or first native enumeration in `$CHECK_DIR/startup.txt`, then run step 4's hook request:

   ```sh
   CASE=mounted-plugin-first-start; CHECK_DIR=$EVIDENCE/$PHASE/$CASE
   SRC_DIR=$SUPPLIED_PLUGIN_DIR; SEAL=$EVIDENCE/supplied-plugin.sha256
   TRIGGER=/sandbox/workspace/results/supplied-plugin-trigger.txt; LEDGER=/sandbox/workspace/results/supplied-plugin-ledger.jsonl
   ```

   Write `$CHECK_DIR/result.md` as in step 5.
   Result: `same`; the record shows `$SUPPLIED_PLUGIN_ID` registered from `$SUPPLIED_PLUGIN_DIR` in this runtime; and the hook effect holds with origin `supplied`.
   The same failure rules as step 5 apply.
7. **`mounted-native-tool-yaml`** and **`mounted-plugin-yaml`:** in the Initial phase, right after step 6, with no new request. For each, copy the native configuration the adapter generated from the YAML, redacting credentials, into `$CHECK_DIR/config.txt`, and write `$CHECK_DIR/yaml.md`: each YAML field and value from `bindings.md`, the native setting it resolved to, and links to step 5's or step 6's `registration.txt` and `use.calls.txt`.
   Result: `config.txt` shows the declared mounted source location and enablement reaching the native runtime, and step 5 or step 6 passed its registration and effect with no manual configuration or loader call.
   An enabled bundled plugin or toolset alone can't pass. A route other than YAML, such as a native installer, passes only its own case.
   No supported declarative binding is Failed with the missing-implementation finding; binding evidence that can't decide is Not tested, with the cause in a finding.
8. **`mounted-supplied-native-tool`:** in every phase it lists. In Initial, send no second request: link step 5's evidence in `$CHECK_DIR/result.md`. After each transition, use step 5's `SRC_DIR`, `SEAL`, and `TOOL` with this `CASE`, and run step 4's tool request. Write `$CHECK_DIR/result.md` with three separate lines:
   - **Source:** `same`, and the installed copy, if any, matches its seal.
   - **Registration:** `registration.txt` shows `$SUPPLIED_TOOL` and its schema registered in the runtime with `$RUNTIME_ID`.
   - **Effect:** the tool effect holds with origin `supplied`.

   Result: all three hold. No loading binding is Failed with the missing-implementation finding.
9. **`mounted-supplied-plugin`:** in every phase it lists. In Initial, link step 6's evidence. After each transition, use step 6's `SRC_DIR`, `SEAL`, `TRIGGER`, and `LEDGER` with this `CASE`, and run step 4's hook request. Write `result.md` as in step 8, with the hook effect and origin `supplied`. Result: all three hold.
10. **Activate the generated plugin.** In the Initial phase, after [plugins](plugins.md)' `agent-plugin-author` sealed `$EVIDENCE/agent-plugin.sha256`:

    ```sh
    . "$EVIDENCE/agent-plugin.env"; echo "$AGENT_PLUGIN_ID $AGENT_PLUGIN_TOOL $AGENT_PLUGIN_DIR"
    ```

    If `agent-plugin-author` left no plugin, give every `mounted-generated-native-tool` and `mounted-generated-plugin` row its outcome, linked to its finding.
    Activate the plugin only through the route `bindings.md` records for the generated plugin. If that route needs a restart and the harness has no supported live reload, restart the runtime once through the supported control that [lifecycle-and-retention](lifecycle-and-retention.md) uses for Runtime restart, record it as setup in `$EVIDENCE/initial/mounted-generated-native-tool/activation-restart.md`, with who did it and the old and new runtime IDs, and read `RUNTIME_ID` again.
    If `agent-plugin-activate` already restarted the runtime after the seal, record that instead of restarting again. The Runtime restart phase still runs later.
    Never enable, copy, install, or load the plugin for the agent. No supported activation route is Failed with the missing-implementation finding.
11. **`mounted-generated-native-tool`:** in every phase it lists, starting in Initial after step 10. Run step 4's tool request with:

    ```sh
    CASE=mounted-generated-native-tool; CHECK_DIR=$EVIDENCE/$PHASE/$CASE
    SRC_DIR=$AGENT_PLUGIN_DIR; SEAL=$EVIDENCE/agent-plugin.sha256; TOOL=$AGENT_PLUGIN_TOOL
    ```

    Write `result.md` as in step 8, for `$AGENT_PLUGIN_TOOL`. Result: all three hold, with origin `agent-generated`.
    A script the shell tool runs never passes; the call must be the registered native tool.
12. **`mounted-generated-plugin`:** in every phase it lists, after step 11. Run step 4's hook request with:

    ```sh
    CASE=mounted-generated-plugin; CHECK_DIR=$EVIDENCE/$PHASE/$CASE
    SRC_DIR=$AGENT_PLUGIN_DIR; SEAL=$EVIDENCE/agent-plugin.sha256
    TRIGGER=/sandbox/workspace/results/agent-plugin-trigger.txt; LEDGER=/sandbox/workspace/results/agent-plugin-ledger.jsonl
    ```

    Write `result.md` as in step 8, for `$AGENT_PLUGIN_ID`. Result: all three hold, with origin `agent-generated`. Retained source alone doesn't pass. No supported loading or reload route is Failed with the missing-implementation finding.
## Gotchas

- Keep the origins separate: the supplied tool, the supplied plugin, the agent-written plugin, the bundled plugin, and the agent-installed plugin in [plugins](plugins.md) each need their own evidence. A pass for one covers no other.
- YAML acceptance, apply success, an enabled ID, and files on disk prove no registration. Registration evidence comes from the managed runtime with the current `RUNTIME_ID`.
- Never launch a second loader, a standalone harness process, or a validator that loads the extension, call a tool handler directly, or dispatch a hook by hand.
- A tool without a hook can't pass a hook case, and a hook without a tool can't pass a tool case. If the harness supports only one effect, the other case is Failed with its own finding.
- If `agent-plugin-install` installed the supplied plugin fixture, the installed copy shares this ledger. Two registered copies under one ID make both checks ambiguous: record a finding, as [plugins](plugins.md) warns.
- Fixtures are dependency-free. A missing third-party dependency is an environment problem: Not tested, with the cause in a finding.
- An activation restart in Initial is setup. Record it, and still run the Runtime restart phase; it doesn't count as retention evidence.
- Never reseed, rewrite, reinstall, or re-enable an extension after a transition, and don't clean up a ledger; missing or changed files are evidence.
- A timed-out request may still have run: read the ledger and the current turn's calls before retrying.
