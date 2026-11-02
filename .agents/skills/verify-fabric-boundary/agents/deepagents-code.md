<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent: Deep Agents Code

`AGENT=deepagents-code`, harness `nvidia.fabric.langchain.deepagents-code`.
This file adds the availability check, the Fabric-boundary YAML edits, the shell restriction, native binding hints, prompt constraints, and extension fixtures for Deep Agents Code on top of the base YAML that [verify-yaml-deployment's Deep Agents Code file](../../verify-yaml-deployment/agents/deepagents-code.md) writes.
Native home: `/sandbox/artifacts/.fabric/deepagents-code/runtimes/RUNTIME_ID/deepagents`, one per runtime, on the artifacts volume, as [docs/state.md](../../../../docs/state.md) documents.
The native TUI is the terminal interface, `dcode`'s terminal UI, which [docs/interfaces.md](../../../../docs/interfaces.md#open-deep-agents-codes-terminal) documents.
`web-ui` is out of this skill's scope for this agent, so the check log omits it: 131 checks.

## Proven Pairs

| Target | Inference source | Revision | Date | Passed | Failed | Not tested | Notes |
|---|---|---|---|---|---|---|---|

None yet.

## Fabric-Boundary YAML Edits

After the **Adapter fields** step in [SKILL.md](../SKILL.md#add-the-fabric-boundary-yaml-edits) saves `$EVIDENCE/descriptor.json`, check for `dcode`, which [docs/build.md](../../../../docs/build.md) says the image installs in `/opt/deepagents-code`:

```sh
docker run --rm --entrypoint sh "$IMAGE" -c 'command -v dcode || ls /opt/deepagents-code/bin/dcode' | tee "$EVIDENCE/dcode-path.txt"
```

If `dcode` doesn't list, the adapter's image is absent: follow that step's absence rule.
Never substitute the Deep Agents SDK adapter, `nvidia.fabric.langchain.deepagents`, or a standalone `dcode` for a pass.

Deep Agents Code adds these fields to `spec.sandboxes.assistant`:

```yaml
harness:
  settings:
    approval_mode: auto
    interfaces:
      terminal: {}
```

| Field | Purpose | Source |
|---|---|---|
| `harness.settings.approval_mode` | Kept from the base: `auto` lets `dcode`'s classifier review gated actions | [verify-yaml-deployment's YAML edits](../../verify-yaml-deployment/agents/deepagents-code.md#yaml-edits); the settings `jq` line in the **Adapter fields** step must list `approval_mode` |
| `harness.settings.interfaces.terminal` | The native TUI, `dcode`'s terminal UI | [docs/interfaces.md](../../../../docs/interfaces.md#open-deep-agents-codes-terminal); the `interfaces` `jq` line must list `terminal` |
| `agent.tools.allow` | An explicit list of the native tools these checks use, so Config change can remove only the shell-launch tool | [docs/agents.md](../../../../docs/agents.md#agent-tool-restrictions); the `config.accepts` `jq` line must list `tools` or `tools.enabled`, and the identifiers belong to the adapter's tool contract |

Add each field only when its source line lists it; otherwise leave it out.
Add skill paths, tool lists, and an output-token limit only when `config.accepts` lists them: plan accepts a public Fabric field that this adapter doesn't accept, and apply then fails ([verify-yaml-deployment's Deep Agents Code file](../../verify-yaml-deployment/agents/deepagents-code.md#yaml-edits)), so an unlisted field costs the whole run.
Write `agent.tools.allow` with the identifiers the descriptor's tool contract declares for the native file-read and file-write tools, the skill tools, the skill-authoring tool, and the shell-launch tool, and record each identifier's source in `bindings.md`.
If the contract declares none of these, leave `agent.tools` out: the shell checks run on the default tool set, and `change` fails as [Shell Restriction](#shell-restriction) says.

Keep the route without `overrides.maxTokens`, as the base does, unless `config.accepts` lists a field for the output-token limit; then set 4096. Record in `$EVIDENCE/identity.txt` which limit the run used.
Keep the base's `approval_mode` for every phase; switching it isn't a repair the run may make.

The rest has no field in v1's docs, so the runner resolves it from `$EVIDENCE/descriptor.json`:

- **Native TUI:** if the `interfaces` `jq` line doesn't list `terminal`, leave `interfaces` out: planning rejects an undeclared interface name, and `tui` fails as the **Read the entry points** step in [native-interfaces](../features/native-interfaces.md) says.
- **Bundled plugin:** use a declared setting that enables a harmless plugin bundled in the image's `dcode`. With none, follow the **Record the plugin bindings** step in [plugins](../features/plugins.md).
- **Mounted native tool and plugin locations:** use a declared setting that points `dcode`'s loader at `/sandbox/workspace/extensions/tools` and `/sandbox/workspace/extensions/plugins`. With none, the YAML-binding and first-start checks in [mounted-extensions](../features/mounted-extensions.md) fail with one missing-implementation finding. Don't guess keys, edit the generated `config.toml`, or point `dcode`'s home at the workspace through the environment.
- **Per-item enablement and allow-list:** if the descriptor shows that a mounted plugin also needs its ID enabled, add `$SUPPLIED_TOOL_ID`, `$SUPPLIED_PLUGIN_ID`, and `fb-plugin-$UID8` now, before the first apply. If plugin tools need an `agent.tools.allow` entry, add `$SUPPLIED_TOOL` and the generated plugin's tool, the names the fixtures and the authoring prompt use, only when the adapter's tool contract accepts them. Disclose each in `bindings.md`. An enabled plugin ID doesn't allow its tools.

## Shell Restriction

Config change removes only the shell-launch tool's identifier from `agent.tools.allow`, the documented allow list ([docs/agents.md](../../../../docs/agents.md#agent-tool-restrictions)), and keeps every other entry, including any plugin tool that the edits above added.
The `change` step in [lifecycle-and-retention](../features/lifecycle-and-retention.md) saves the diff; it must show one removed identifier.
Before the change, confirm from the descriptor's tool contract and the image's `dcode` source that the identifier holds the shell-launch tool and no file or skill tool, and record that in `bindings.md`.
A stricter `approval_mode`, or the classifier declining a command, isn't a shell restriction: evaluate tool exposure and actual calls.
If `agent.tools` is absent, or the shell-launch tool can't be removed alone through a declared field, `change` fails, as that step says.

## Native Binding Hints

These hints were observed at NemoClaw `7cc29a4a3e`, the revision [verify-yaml-deployment's Proven Pairs](../../verify-yaml-deployment/agents/deepagents-code.md#proven-pairs) records, and the Fabric revision that [docs/state.md](../../../../docs/state.md) pins, `a3b57155593877135f2557ef37d5e18161a1ad82`.
No hint is recorded for the shell-launch, file-write, or skill-authoring tool, the skill directory, the install and enable commands, or the plugin format; resolve them as [Record the Native Bindings](../SKILL.md#record-the-native-bindings) describes.
Also record whether `dcode`'s file tools write the sandbox filesystem or a virtual backend: a file that exists only in tool state doesn't pass a filesystem check.

- **Public configuration:** the descriptor's `config.accepts` listed only `models` and `models.base_url`. Plan accepted `maxTokens`, `execution.timeoutSeconds`, skill paths, and tool lists, and apply rejected them with `validation_failed`.
- **Invocation:** Fabric's invocation contract for this adapter was backed by `dcode --acp` *(syntax unverified)*. Don't use the SDK adapter's `create_deep_agent` bindings.
- **native call record:** the runtime's thread and any terminal sessions were in `sessions.db` in that runtime's `dcode` home. A new runtime got a new home and a new thread, and didn't read the old `sessions.db`. Read calls from the current `RUNTIME_ID`'s home only; copy the database out and query the copy, and never open it with a `dcode` command that starts an agent.
- **Terminal launcher:** `/sandbox/artifacts/.fabric/deepagents-code/runtimes/RUNTIME_ID/interfaces/terminal`, opened with the `Open` line from the latest apply, `openshell sandbox exec -n assistant --tty -- LAUNCHER`. Read `Open` again after every transition. Never use `openshell sandbox connect`, which attaches to the sandbox's main process, or start an unrelated `dcode`.
- **Terminal sessions:** the terminal opened a separate `dcode` session that shared the runtime's configuration and `sessions.db`; it didn't attach to the live ACP thread, and the runtime's own thread couldn't be resumed while the runtime held it. Record each session or thread ID. To reconnect, resume the persisted terminal session through a `dcode` option the image's help gives; don't require automatic resumption or a shared live conversation for `tui`.
- **Terminal driving:** a new home showed a first-run screen once per runtime home, and Escape skipped it; Ctrl-D before an answer finished interrupted the turn; the launcher printed `This NeMo Fabric runtime is not running.` when the runtime had stopped. [deepagents-code-terminal](../../verify-yaml-deployment/features/deepagents-code-terminal.md#gotchas) has the driver.
- **Terminal agent server:** while the terminal UI ran, its own agent server listened on loopback in the sandbox without authentication. Don't forward or expose it.

## Prompt Constraints

- **Shell checks and `agent-plugin-install`:** `If your shell tool is unavailable or refused, report that; do not run the command through any alternative.`
- **`agent-plugin-author`:** the plugin format that `bindings.md` records, with `$AGENT_PLUGIN_ID` filled in, described the way the [Hermes](hermes.md#prompt-constraints) and [OpenClaw](openclaw.md#prompt-constraints) files describe theirs: the manifest and its ID field, the entry file, how to register the tool with its JSON Schema and handler, how to register the hook that runs after each native file-write call, and `Use only the Python standard library.` When `bindings.md` records `none`, [plugins](../features/plugins.md) settles those rows and no prompt is sent.

## Extension Fixtures

No native manifest or registration wrapper is recorded for `dcode`, so each fixture holds only the behavior, in Python because `dcode` runs on Python ([docs/build.md](../../../../docs/build.md)).
Before seeding, add the manifest and registration wrapper *(syntax unverified)* that `bindings.md` records under **Fixture format** as further files in the same directory, keep these files unchanged, and record each wrapper's source in `bindings.md`. The agent-authored plugin uses that same format.
When `bindings.md` records `none`, the **Record the mounted-extension bindings** step in [mounted-extensions](../features/mounted-extensions.md) marks the rows Failed; seed nothing.
The hook `after_tool_call` and its arguments, `tool_name`, `args`, and `tool_call_id`, the write tools' `file_path` or `path` argument, and the names in `WRITE_TOOLS` *(syntax unverified)* are this fixture's convention; `WRITE_TOOLS` must hold the file-write tools from `bindings.md`.

**Native tool,** in `extensions/tools/$SUPPLIED_TOOL_ID/`:

`tool.py`

```python
import json

TOOL_ID = "FB_TOOL_ID"
SCHEMA = {
    "name": "FB_TOOL_NAME",
    "description": "Return the given nonce with origin supplied and kind native-tool.",
    "parameters": {
        "type": "object",
        "properties": {"nonce": {"type": "string", "description": "The nonce to return."}},
        "required": ["nonce"],
        "additionalProperties": False,
    },
}


def FB_TOOL_NAME(nonce: str) -> str:
    """Return the given nonce with origin supplied and kind native-tool."""
    return json.dumps({"origin": "supplied", "nonce": str(nonce), "kind": "native-tool"})
```

**Plugin,** in `extensions/plugins/$SUPPLIED_PLUGIN_ID/`:

`plugin.py`

```python
import json
import os

PLUGIN_ID = "FB_PLUGIN_ID"
TRIGGER = "/sandbox/workspace/results/supplied-plugin-trigger.txt"
LEDGER = "/sandbox/workspace/results/supplied-plugin-ledger.jsonl"
WRITE_TOOLS = ("write_file", "edit_file")


def after_tool_call(tool_name, args, tool_call_id=None):
    if tool_name not in WRITE_TOOLS or not isinstance(args, dict):
        return
    path = args.get("file_path", args.get("path"))
    if not isinstance(path, str) or os.path.normpath(path) != TRIGGER:
        return
    with open(TRIGGER, encoding="utf-8") as f:
        nonce = f.readline().strip()
    entry = {"origin": "supplied", "nonce": nonce, "tool": tool_name}
    if tool_call_id:
        entry["call_id"] = tool_call_id
    with open(LEDGER, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
```
