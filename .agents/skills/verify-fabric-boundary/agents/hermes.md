<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent: Hermes

`AGENT=hermes`, harness `nvidia.fabric.hermes`, 136 checks.
This file adds the Fabric-boundary YAML edits, the shell restriction, native binding hints, prompt constraints, and extension fixtures for Hermes on top of the base YAML that [verify-yaml-deployment's Hermes file](../../verify-yaml-deployment/agents/hermes.md) writes.
[docs/state.md](../../../../docs/state.md) documents the Hermes native home at `/sandbox/artifacts/.fabric/state/nvidia.fabric.hermes/assistant`, on the artifacts volume; record the actual native home of each runtime from its generated configuration or startup log, never from the process environment, which holds credentials.
The native TUI and the Web UI are both in scope.

## Proven Pairs

| Target | Revision | Date | Passed | Failed | Not tested | Notes |
|---|---|---|---|---|---|---|

None yet.

## Fabric-Boundary YAML Edits

First choose the run-scoped extension names: run [mounted-extensions](../features/mounted-extensions.md) step 2's name block, and note the generated plugin's ID, `fb-plugin-$UID8`, as [plugins](../features/plugins.md) step 4 derives it.
Save the image's adapter descriptor, then list the settings and interfaces it declares:

```sh
docker image inspect "$IMAGE" --format '{{index .Config.Labels "io.nemoclaw.fabric.catalog"}}' |
  jq '.adapters[] | select(.descriptor.adapter_id == "nvidia.fabric.hermes") | .descriptor' > "$EVIDENCE/hermes-descriptor.json"
jq -c '.settings_schema.properties | keys' "$EVIDENCE/hermes-descriptor.json"
jq -c '.settings_schema.properties.interfaces.properties | keys' "$EVIDENCE/hermes-descriptor.json"
```

Merge these fields into `spec.sandboxes.assistant`, keeping the base `harness.kind`, `harness.execution`, and inference route:

```yaml
harness:
  settings:
    plugins_enabled: [disk-cleanup]
    interfaces:
      dashboard:
        port: 9119
  config:
    skills:
      paths: [/sandbox/workspace/skills]
agent:
  tools:
    allow: [file, skills, terminal]
```

| Field | Purpose | Source |
|---|---|---|
| `harness.config.skills.paths` | Mounted skill path `/sandbox/workspace/skills` | [docs/agents.md](../../../../docs/agents.md#skills-on-a-mounted-volume) |
| `harness.settings.plugins_enabled` | Enables the bundled `disk-cleanup` plugin for [plugins](../features/plugins.md) | Declared by the adapter: the first `jq` line must list `plugins_enabled` |
| `harness.settings.interfaces.dashboard` | The Web UI, Hermes's dashboard with browser chat | [docs/interfaces.md](../../../../docs/interfaces.md#enable-an-interface) |
| `agent.tools.allow` | Native toolsets `file`, `skills`, and `terminal`; Config change removes `terminal` | [docs/agents.md](../../../../docs/agents.md#agent-tool-restrictions); the identifiers belong to the adapter's tool contract |

Keep the route's `overrides.maxTokens` at 4096 for these multistep checks ([docs/reference/configuration.md](../../../../docs/reference/configuration.md)); if the base sets another value, change it and record the override in `$EVIDENCE/identity.txt`.
If the base YAML already declares `interfaces`, such as the `api` entry, keep it and add `dashboard`.

The rest has no field in v1's docs, so the runner resolves it from the saved descriptor:

- **Native TUI:** [docs/interfaces.md](../../../../docs/interfaces.md#enable-an-interface) documents only `api` and `dashboard` for Hermes. If the second `jq` line lists a terminal UI interface, add it under `interfaces` with the fields its schema requires. Otherwise add nothing: planning rejects an undeclared interface name, and `tui` fails as [native-interfaces](../features/native-interfaces.md) step 1 says.
- **Mounted native tool and plugin locations:** use a declared setting that points the native plugin loader at `/sandbox/workspace/extensions/tools` and `/sandbox/workspace/extensions/plugins`. With none, the YAML-binding and first-start checks in [mounted-extensions](../features/mounted-extensions.md) fail with one missing-implementation finding. Don't guess `plugin_paths`, `tools.paths`, `custom_tools`, or a `HERMES_HOME` override.
- **Per-item enablement and allow-list:** if the descriptor shows that a mounted plugin also needs its ID in `plugins_enabled`, add `$SUPPLIED_TOOL_ID`, `$SUPPLIED_PLUGIN_ID`, and `fb-plugin-$UID8` now, before the first apply. If plugin toolsets need an `agent.tools.allow` entry, add `$SUPPLIED_TOOL_ID` and `fb-plugin-$UID8`, the toolset names the fixtures and the authoring constraint use, only when the adapter's tool contract accepts them. Disclose each in `bindings.md`. An enabled plugin ID doesn't allow its tools.

A field the descriptor doesn't declare fails the matching checks; never add it to see whether plan accepts it.

## Shell Restriction

Config change removes only the `terminal` toolset from `agent.tools.allow`, the documented allow list ([docs/agents.md](../../../../docs/agents.md#agent-tool-restrictions)):

```diff
-    allow: [file, skills, terminal]
+    allow: [file, skills]
```

Keep every other entry, including any plugin toolset that the edits above added.
Before the change, confirm from the descriptor's tool contract and the image's Hermes source that `terminal` holds the shell-launch tool and no file or skill tool, and record that in `bindings.md`.
If the shell-launch tool can't be removed alone through a declared field, `change` fails, as [lifecycle-and-retention](../features/lifecycle-and-retention.md) step 9 says.

## Native Binding Hints

These hints were observed at Hermes `4d04303818b61bf3aa09278af48356315515965b` and Fabric `67acf1c`.
Re-resolve each against the selected image, record any difference in `bindings.md`, and never let a hint decide an outcome.

- **shell-launch tool:** `terminal`, in the `terminal` toolset. The same toolset's `process` tool manages processes that `terminal` started; it isn't a shell-launch tool.
- **file-write tool:** `write_file`, in the `file` toolset with `read_file` and `patch`.
- **skill-authoring tool:** `skill_manage`, in the `skills` toolset. `skills_list` and `skill_view` list and load skills; discovery evidence is their current-turn calls or the runtime's loaded skill list, not the reply.
- **skill directory:** `skills/` under the native home. Record where `skill_manage` actually saved the generated skill, separately from the mounted read path, and never copy it into a new home.
- **native call record:** the native session database in the native home, which [docs/state.md](../../../../docs/state.md) lists. Read the current session's messages and tool calls with the image's `hermes sessions` subcommands, as its help gives them, with `HERMES_HOME` set to the native home; never run a `hermes` command that starts a gateway or loads plugins.
- **install command:** `hermes plugins install` with a Git URL or `owner/repo`. Check whether the selected image's help accepts a local path before choosing the supplied fixture.
- **enable command:** `hermes plugins enable NAME`. The enablement record is the plugin list in the native home's generated `config.yaml`; `hermes plugins list` shows enablement, not registration.
- **Plugin format:** a directory with `plugin.yaml` and an `__init__.py` defining `register(ctx)`, which calls `ctx.register_tool(name=..., toolset=..., schema=..., handler=...)` and `ctx.register_hook("post_tool_call", callback)`. Handlers take an argument dictionary and `**kwargs` and return a JSON string; hooks take `**kwargs`. [Adding tools](https://github.com/NousResearch/hermes-agent/blob/4d04303818b61bf3aa09278af48356315515965b/website/docs/developer-guide/adding-tools.md) routes custom native tools through plugins, so the supplied native tool is a plugin that registers only that tool.
- **Discovery and activation:** [native discovery](https://github.com/NousResearch/hermes-agent/blob/4d04303818b61bf3aa09278af48356315515965b/hermes_cli/plugins_discovery.py) scanned bundled plugins and the native home's `plugins/` directory; project plugins depended on `HERMES_ENABLE_PROJECT_PLUGINS` and the process's working directory. The Fabric adapter discovered plugins at startup, so a new plugin needed one recorded activation restart. A terminal subprocess's working directory isn't the runtime's.
- **Native validation:** Hermes's plugin doctor loads the plugin in a separate home, so it isn't static validation and proves nothing about the managed runtime; write `none` unless the image offers a check that doesn't load the plugin.
- **Bundled plugin:** `disk-cleanup`, whose `post_tool_call` hook records tracked files in `disk-cleanup/tracked.json` under the native home. It tracked a native write of `cache/capability-probe-NONCE.txt` under the native home as category `temp`. Establish from the image's plugin source which entry, if any, it writes for `/sandbox/workspace/results/plugin-hook-trigger.txt`; if it records none, follow [plugins](../features/plugins.md) step 1. Don't use `test_*` file names or run its cleanup, which deletes tracked files.
- A slash command sent through `fabric-agent-ctl invoke` isn't native command execution.

## Prompt Constraints

Append only these to a feature's prompt, after its last line, and save the sent text as usual:

- **Shell checks and `agent-plugin-install`:** `Run it in the foreground; don't start it as a background process.`
- **`agent-plugin-author`:** the plugin format, with `$AGENT_PLUGIN_ID` filled in:

  ```text
  Use the Hermes plugin format: a directory holding plugin.yaml, with name set to $AGENT_PLUGIN_ID, and __init__.py defining register(ctx). Register the tool with ctx.register_tool, in toolset $AGENT_PLUGIN_ID, with an OpenAI function schema and a handler that takes an argument dictionary and **kwargs and returns a JSON string. Register the hook with ctx.register_hook("post_tool_call", callback), where the callback takes **kwargs. Use only the Python standard library.
  ```

- **Every request:** `Don't use slash commands.`

## Extension Fixtures

Seed these as [mounted-extensions](../features/mounted-extensions.md) step 3 describes.
They use the plugin format from the hints, the same format the agent-authored plugin uses.
The hook's keyword names, `tool_name`, `args`, and `tool_call_id`, follow the hinted plugin guide: if the selected image passes others, change only those names before seeding and record the change in `bindings.md`.

**Native tool,** in `extensions/tools/$SUPPLIED_TOOL_ID/`:

`plugin.yaml`

```yaml
name: FB_TOOL_ID
version: 1.0.0
description: Verification fixture that registers one native tool.
provides_tools:
  - FB_TOOL_NAME
```

`__init__.py`

```python
import json

SCHEMA = {
    "name": "FB_TOOL_NAME",
    "description": "Return the given nonce with origin supplied and kind native-tool.",
    "parameters": {
        "type": "object",
        "properties": {"nonce": {"type": "string", "description": "The nonce to return."}},
        "required": ["nonce"],
    },
}


def _handler(args, **kwargs):
    return json.dumps({"origin": "supplied", "nonce": str(args.get("nonce", "")), "kind": "native-tool"})


def register(ctx):
    ctx.register_tool(name="FB_TOOL_NAME", toolset="FB_TOOL_ID", schema=SCHEMA, handler=_handler)
```

**Plugin,** in `extensions/plugins/$SUPPLIED_PLUGIN_ID/`:

`plugin.yaml`

```yaml
name: FB_PLUGIN_ID
version: 1.0.0
description: Verification fixture that records one native file write.
provides_hooks:
  - post_tool_call
```

`__init__.py`

```python
import json
import os

TRIGGER = "/sandbox/workspace/results/supplied-plugin-trigger.txt"
LEDGER = "/sandbox/workspace/results/supplied-plugin-ledger.jsonl"
WRITE_TOOLS = ("write_file", "patch")


def _on_post_tool_call(**kwargs):
    tool = kwargs.get("tool_name")
    args = kwargs.get("args")
    if tool not in WRITE_TOOLS or not isinstance(args, dict):
        return
    path = args.get("path")
    if not isinstance(path, str) or os.path.normpath(path) != TRIGGER:
        return
    with open(TRIGGER, encoding="utf-8") as f:
        nonce = f.readline().strip()
    entry = {"origin": "supplied", "nonce": nonce, "tool": tool}
    call_id = kwargs.get("tool_call_id")
    if call_id:
        entry["call_id"] = call_id
    with open(LEDGER, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def register(ctx):
    ctx.register_hook("post_tool_call", _on_post_tool_call)
```
