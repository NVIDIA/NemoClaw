<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent: OpenClaw

`AGENT=openclaw`, harness `nvidia.fabric.openclaw`.
This file adds the Fabric-boundary YAML edits, the shell restriction, native binding hints, prompt constraints, and extension fixtures for OpenClaw on top of the base YAML that [verify-yaml-deployment's OpenClaw file](../../verify-yaml-deployment/agents/openclaw.md) writes.
Native home: a private temporary directory that the adapter selects and removes when the runtime stops ([docs/state.md](../../../../docs/state.md)).
The adapter sends each Fabric request to the native OpenClaw agent that `harness.settings.agent_id` selects, which [docs/agents.md](../../../../docs/agents.md#run-one-headless-openclaw-request) says defaults to `default`; keep that native agent ID separate from the YAML's `agent.name`.
The native TUI and the Web UI are both in scope.

## Proven Pairs

| Target | Inference source | Revision | Date | Passed | Failed | Not tested | Notes |
|---|---|---|---|---|---|---|---|

None yet.

## Fabric-Boundary YAML Edits

```yaml
harness:
  settings:
    interfaces:
      dashboard:
        port: 43000
```

| Field | Purpose | Source |
|---|---|---|
| `harness.settings.interfaces.dashboard` | The Web UI, OpenClaw's Control UI with browser chat | [docs/interfaces.md](../../../../docs/interfaces.md#enable-an-interface); the `interfaces` `jq` line in the **Adapter fields** step of [SKILL.md](../SKILL.md#add-the-fabric-boundary-yaml-edits) must list `dashboard` |
| `agent.tools.allow` | An explicit list of the native tools these checks use, so Config change can remove only the shell-launch tool | [docs/agents.md](../../../../docs/agents.md#agent-tool-restrictions); the identifiers belong to the adapter's tool contract |

Write `agent.tools.allow` with the identifiers the descriptor's tool contract declares for the native file-read and file-write tools, the skill tools, the skill-authoring tool, `exec`, and `process`, and record each identifier's source in `bindings.md`.
The [full-featured OpenClaw example](../../../../examples/full-featured-openclaw.yaml) restricts an agent with `allow: [read]`, a native tool name.
If the contract declares none of these, leave `agent.tools` out: the shell checks run on the default tool set, and `change` fails as [Shell Restriction](#shell-restriction) says.

If the base YAML already declares `interfaces.dashboard`, keep it and its port.
The Web UI checks use the loopback `Forward` command that apply prints, so they need no service exposure ([openclaw-dashboard](../../verify-yaml-deployment/features/openclaw-dashboard.md#gotchas)).
OpenClaw reserves the ports from `port` through `port + 110` ([docs/interfaces.md](../../../../docs/interfaces.md#enable-an-interface)).

The rest has no field in v1's docs, so the runner resolves it from `$EVIDENCE/descriptor.json`:

- **Native TUI:** [docs/interfaces.md](../../../../docs/interfaces.md#enable-an-interface) documents only `dashboard` for OpenClaw. If the `interfaces` `jq` line in the **Adapter fields** step lists a terminal UI interface, add it under `interfaces` with the fields its schema requires. Otherwise add nothing: planning rejects an undeclared interface name, and `tui` fails as the **Read the entry points** step in [native-interfaces](../features/native-interfaces.md) says.
- **Bundled plugin:** use a declared setting that enables a harmless plugin bundled in the image's OpenClaw package. With none, follow the **Record the plugin bindings** step in [plugins](../features/plugins.md).
- **Mounted native tool and plugin locations:** use a declared setting that points OpenClaw's plugin loader at `/sandbox/workspace/extensions/tools` and `/sandbox/workspace/extensions/plugins`. With none, the YAML-binding and first-start checks in [mounted-extensions](../features/mounted-extensions.md) fail with one missing-implementation finding. Don't guess native keys such as `plugins.load.paths` or `plugins.entries`, edit the generated native configuration, or set `OPENCLAW_STATE_DIR`, which [docs/state.md](../../../../docs/state.md) says doesn't relocate the native state.
- **Per-item enablement and allow-list:** if the descriptor shows that a mounted plugin also needs its ID enabled, add `$SUPPLIED_TOOL_ID`, `$SUPPLIED_PLUGIN_ID`, and `fb-plugin-$UID8` now, before the first apply. If plugin tools need an `agent.tools.allow` entry, add `$SUPPLIED_TOOL` and the generated plugin's tool, `fb_probe_` and the first eight alphanumeric characters of `$UID_`, as the `agent-plugin-author` step in [plugins](../features/plugins.md) derives it, the names the fixtures and the authoring prompt use, only when the adapter's tool contract accepts them. Disclose each in `bindings.md`. An enabled plugin ID doesn't allow its tools.

## Shell Restriction

Config change removes only `exec` from `agent.tools.allow`, the documented allow list ([docs/agents.md](../../../../docs/agents.md#agent-tool-restrictions)), and keeps every other entry, including `process` and any plugin tool that the edits above added.
The `change` step in [lifecycle-and-retention](../features/lifecycle-and-retention.md) saves the diff; it must show one removed identifier.
Before the change, confirm from the descriptor's tool contract and the image's OpenClaw source that `exec` is the only tool that launches a new command, and that `process` and `terminal` can't start one, and record that in `bindings.md`.
If the shell-launch tool can't be removed alone through a declared field, `change` fails, as that step says.

## Native Binding Hints

These hints were observed at OpenClaw `2026.9.4` and Fabric `a3b57155593877135f2557ef37d5e18161a1ad82`.
No hint is recorded for the file-write tool, the native call record, or the install and enable commands.

- **shell-launch tool:** `exec`. The `process` tool controlled existing `exec` processes, and the `terminal` tool managed Control UI terminals that an operator opened and couldn't create one. An empty terminal list doesn't mean `exec` is unavailable. Never ask for the native terminal tool while forbidding other tools: that selects a different capability.
- **skill-authoring tool:** `skill_workshop`, which created the generated skill and then applied it.
- **skill directory:** `skill_workshop` saved the generated skill at `state/agents/AGENT_ID/agent/workshop-skills/SKILL_NAME/SKILL.md` under the runtime's `/sandbox/tmp/nemo-fabric-openclaw-*` directory, where `AGENT_ID` is the selected `agent_id`, outside the configured skill path; native skill discovery listed it. That directory is the adapter's temporary native state, which [docs/state.md](../../../../docs/state.md) says it removes when the runtime stops. Record where the skill was actually saved, separately from the mounted read path, and never copy it anywhere.
- **native call record:** the current turn's calls live in that same temporary native state. Save each check's calls before the next transition; a stopped runtime takes them with it.
- **Web UI:** a service in the adapter descriptor doesn't prove the Web UI. Use the loopback `Forward` and `Token` lines from the latest apply, sign in, and chat; the token path names the runtime ID, so read it again after every transition ([openclaw-dashboard](../../verify-yaml-deployment/features/openclaw-dashboard.md#gotchas)). A headless request is never a UI pass.
- **Plugin format:** a directory with an `openclaw.plugin.json` manifest naming the plugin `id` and a `configSchema`, a `package.json` whose `openclaw.extensions` lists the entry file, and an entry module whose default export, `register(api)`, calls `api.registerTool` and `api.on("after_tool_call", handler)` *(syntax unverified)*. Establish it from the selected image's OpenClaw plugin documentation and source, which the image copies with OpenClaw's `/app` ([docs/build.md](../../../../docs/build.md#update-the-openclaw-pin)), and record the source in `bindings.md`.

## Prompt Constraints

- **Shell checks and `agent-plugin-install`:** `If exec is disabled, report that; do not run the command through any alternative.`
- **`agent-plugin-author`:** the plugin format, with `$AGENT_PLUGIN_ID` filled in, unless `bindings.md` records another format, in which case describe that one the same way:

  ```text
  Use the OpenClaw plugin format: a directory holding openclaw.plugin.json, with id set to $AGENT_PLUGIN_ID and configSchema set to an empty object schema, a package.json whose openclaw.extensions lists ./index.js, and index.js, an ES module whose default export is register(api). Register the tool with api.registerTool, with a JSON Schema for its parameters and an execute function that returns the JSON object as text content. Register the hook with api.on("after_tool_call", handler). Use only Node.js built-in modules.
  ```

## Extension Fixtures

The hook's event fields, `toolName`, `params`, and `toolCallId` *(syntax unverified)*, the write tools' `path` argument, and the names in `WRITE_TOOLS` follow the hints' plugin format; `WRITE_TOOLS` must hold the file-write tool from `bindings.md`.

**Native tool,** in `extensions/tools/$SUPPLIED_TOOL_ID/`:

`openclaw.plugin.json`

```json
{
  "id": "FB_TOOL_ID",
  "name": "FB_TOOL_ID",
  "description": "Verification fixture that registers one native tool.",
  "configSchema": { "type": "object", "additionalProperties": false, "properties": {} }
}
```

`package.json`

```json
{
  "name": "FB_TOOL_ID",
  "version": "1.0.0",
  "type": "module",
  "openclaw": { "extensions": ["./index.js"] }
}
```

`index.js`

```js
export default function register(api) {
  api.registerTool({
    name: "FB_TOOL_NAME",
    description: "Return the given nonce with origin supplied and kind native-tool.",
    parameters: {
      type: "object",
      properties: { nonce: { type: "string", description: "The nonce to return." } },
      required: ["nonce"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params) {
      const result = { origin: "supplied", nonce: String(params?.nonce ?? ""), kind: "native-tool" };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
}
```

**Plugin,** in `extensions/plugins/$SUPPLIED_PLUGIN_ID/`:

`openclaw.plugin.json`

```json
{
  "id": "FB_PLUGIN_ID",
  "name": "FB_PLUGIN_ID",
  "description": "Verification fixture that records one native file write.",
  "configSchema": { "type": "object", "additionalProperties": false, "properties": {} }
}
```

`package.json`

```json
{
  "name": "FB_PLUGIN_ID",
  "version": "1.0.0",
  "type": "module",
  "openclaw": { "extensions": ["./index.js"] }
}
```

`index.js`

```js
import { appendFileSync, readFileSync } from "node:fs";
import { normalize } from "node:path";

const TRIGGER = "/sandbox/workspace/results/supplied-plugin-trigger.txt";
const LEDGER = "/sandbox/workspace/results/supplied-plugin-ledger.jsonl";
const WRITE_TOOLS = ["write", "edit"];

export default function register(api) {
  api.on("after_tool_call", (event, ctx) => {
    const tool = event?.toolName;
    const path = event?.params?.path;
    if (!WRITE_TOOLS.includes(tool) || typeof path !== "string" || normalize(path) !== TRIGGER) {
      return;
    }
    const nonce = readFileSync(TRIGGER, "utf8").split("\n")[0].trim();
    const entry = { origin: "supplied", nonce, tool };
    const callId = event?.toolCallId ?? ctx?.toolCallId;
    if (callId) {
      entry.call_id = callId;
    }
    appendFileSync(LEDGER, JSON.stringify(entry) + "\n", "utf8");
  });
}
```
