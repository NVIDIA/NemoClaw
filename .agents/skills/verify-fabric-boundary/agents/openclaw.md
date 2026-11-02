<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent: OpenClaw

`AGENT=openclaw`, harness `nvidia.fabric.openclaw`, 136 checks.
This file adds the Fabric-boundary YAML edits, the shell restriction, native binding hints, prompt constraints, and extension fixtures for OpenClaw on top of the base YAML that [verify-yaml-deployment's OpenClaw file](../../verify-yaml-deployment/agents/openclaw.md) writes.
[docs/state.md](../../../../docs/state.md) documents OpenClaw's native state as a private temporary directory that the adapter selects and removes when the runtime stops; record the actual native home of each runtime from its generated configuration or startup log, never from the process environment, which holds credentials.
The adapter sends each Fabric request to the native OpenClaw agent that `harness.settings.agent_id` selects, which [docs/agents.md](../../../../docs/agents.md#run-one-headless-openclaw-request) says defaults to `default`; keep that native agent ID separate from the YAML's `agent.name`.
The native TUI and the Web UI are both in scope.

## Proven Pairs

| Target | Revision | Date | Passed | Failed | Not tested | Notes |
|---|---|---|---|---|---|---|

None yet.

## Fabric-Boundary YAML Edits

First choose the run-scoped extension names: run [mounted-extensions](../features/mounted-extensions.md) step 2's name block, and note the generated plugin's ID, `fb-plugin-$UID8`, and tool, `fb_probe_` and the first eight alphanumeric characters of `$UID_`, as [plugins](../features/plugins.md) step 5 derives them.
Save the image's adapter descriptor, then list the settings and interfaces it declares:

```sh
docker image inspect "$IMAGE" --format '{{index .Config.Labels "io.nemoclaw.fabric.catalog"}}' |
  jq '.adapters[] | select(.descriptor.adapter_id == "nvidia.fabric.openclaw") | .descriptor' > "$EVIDENCE/openclaw-descriptor.json"
jq -c '.settings_schema.properties | keys' "$EVIDENCE/openclaw-descriptor.json"
jq -c '.settings_schema.properties.interfaces.properties | keys' "$EVIDENCE/openclaw-descriptor.json"
```

Merge these fields into `spec.sandboxes.assistant`, keeping the base `harness.kind`, `harness.execution`, and inference route:

```yaml
harness:
  settings:
    interfaces:
      dashboard:
        port: 43000
  config:
    skills:
      paths: [/sandbox/workspace/skills]
```

| Field | Purpose | Source |
|---|---|---|
| `harness.config.skills.paths` | Mounted skill path `/sandbox/workspace/skills` | [docs/agents.md](../../../../docs/agents.md#skills-on-a-mounted-volume), whose example uses `nvidia.fabric.openclaw` |
| `harness.settings.interfaces.dashboard` | The Web UI, OpenClaw's Control UI with browser chat | [docs/interfaces.md](../../../../docs/interfaces.md#enable-an-interface); the second `jq` line must list `dashboard` |
| `agent.tools.allow` | An explicit list of the native tools these checks use, so Config change can remove only the shell-launch tool | [docs/agents.md](../../../../docs/agents.md#agent-tool-restrictions); the identifiers belong to the adapter's tool contract |

Write `agent.tools.allow` with the identifiers the descriptor's tool contract declares for the native file-read and file-write tools, the skill tools, the skill-authoring tool, `exec`, and `process`, and record each identifier's source in `bindings.md`.
The [full-featured OpenClaw example](../../../../examples/full-featured-openclaw.yaml) restricts an agent with `allow: [read]`, a native tool name.
If the contract declares none of these, leave `agent.tools` out: the shell checks run on the default tool set, and `change` fails as [Shell Restriction](#shell-restriction) says.

Keep the route's `overrides.maxTokens` at 4096 for these multistep checks ([docs/reference/configuration.md](../../../../docs/reference/configuration.md)); if the base sets another value, change it and record the override in `$EVIDENCE/identity.txt`.
If the base YAML already declares `interfaces.dashboard`, such as the one with `public_origins` for a service exposure, keep it and its port.
The Web UI checks use the loopback `Forward` command that apply prints, so they need no `public_origins` entry or service exposure ([openclaw-dashboard](../../verify-yaml-deployment/features/openclaw-dashboard.md#gotchas)).
OpenClaw reserves the ports from `port` through `port + 110` ([docs/interfaces.md](../../../../docs/interfaces.md#enable-an-interface)).

The rest has no field in v1's docs, so the runner resolves it from the saved descriptor:

- **Native TUI:** [docs/interfaces.md](../../../../docs/interfaces.md#enable-an-interface) documents only `dashboard` for OpenClaw. If the second `jq` line lists a terminal UI interface, add it under `interfaces` with the fields its schema requires. Otherwise add nothing: planning rejects an undeclared interface name, and `tui` fails as [native-interfaces](../features/native-interfaces.md) step 1 says.
- **Bundled plugin:** use a declared setting that enables a harmless plugin bundled in the image's OpenClaw package. With none, follow [plugins](../features/plugins.md) step 1.
- **Mounted native tool and plugin locations:** use a declared setting that points OpenClaw's plugin loader at `/sandbox/workspace/extensions/tools` and `/sandbox/workspace/extensions/plugins`. With none, the YAML-binding and first-start checks in [mounted-extensions](../features/mounted-extensions.md) fail with one missing-implementation finding. Don't guess native keys such as `plugins.load.paths` or `plugins.entries`, edit the generated native configuration, or set `OPENCLAW_STATE_DIR`, which [docs/state.md](../../../../docs/state.md) says doesn't relocate the native state.
- **Per-item enablement and allow-list:** if the descriptor shows that a mounted plugin also needs its ID enabled, add `$SUPPLIED_TOOL_ID`, `$SUPPLIED_PLUGIN_ID`, and `fb-plugin-$UID8` now, before the first apply. If plugin tools need an `agent.tools.allow` entry, add `$SUPPLIED_TOOL` and the generated plugin's tool, the names the fixtures and the authoring prompt use, only when the adapter's tool contract accepts them. Disclose each in `bindings.md`. An enabled plugin ID doesn't allow its tools.

A field the descriptor doesn't declare fails the matching checks; never add it to see whether plan accepts it.

## Shell Restriction

Config change removes only `exec` from `agent.tools.allow`, the documented allow list ([docs/agents.md](../../../../docs/agents.md#agent-tool-restrictions)), and keeps every other entry, including `process` and any plugin tool that the edits above added.
[lifecycle-and-retention](../features/lifecycle-and-retention.md) step 9 saves the diff; it must show one removed identifier.
Before the change, confirm from the descriptor's tool contract and the image's OpenClaw source that `exec` is the only tool that launches a new command, and that `process` and `terminal` can't start one, and record that in `bindings.md`.
If the shell-launch tool can't be removed alone through a declared field, `change` fails, as lifecycle-and-retention step 9 says.

## Native Binding Hints

These hints were observed at OpenClaw `2026.9.4` and the Fabric revision that [docs/agents.md](../../../../docs/agents.md#run-one-headless-openclaw-request) pins, `a3b57155593877135f2557ef37d5e18161a1ad82`.
Re-resolve each against the selected image, record any difference in `bindings.md`, and never let a hint decide an outcome.
No hint is recorded for the file-write tool, the native call record, or the install and enable commands; resolve them as [Record the Native Bindings](../SKILL.md#record-the-native-bindings) describes.

- **shell-launch tool:** `exec`. The `process` tool controlled existing `exec` processes, and the `terminal` tool managed Control UI terminals that an operator opened and couldn't create one. An empty terminal list doesn't mean `exec` is unavailable. Never ask for the native terminal tool while forbidding other tools: that selects a different capability.
- **skill-authoring tool:** `skill_workshop`, which created the generated skill and then applied it.
- **skill directory:** `skill_workshop` saved the generated skill at `state/agents/AGENT_ID/agent/workshop-skills/SKILL_NAME/SKILL.md` under the runtime's `/sandbox/tmp/nemo-fabric-openclaw-*` directory, where `AGENT_ID` is the selected `agent_id`, outside the configured skill path; native skill discovery listed it. That directory is the adapter's temporary native state, which [docs/state.md](../../../../docs/state.md) says it removes when the runtime stops. Record where the skill was actually saved, separately from the mounted read path, and never copy it anywhere.
- **native call record:** the current turn's calls live in that same temporary native state. Save each check's calls before the next transition; a stopped runtime takes them with it.
- **Web UI:** a service in the adapter descriptor doesn't prove the Web UI. Use the loopback `Forward` and `Token` lines from the latest apply, sign in, and chat; the token path names the runtime ID, so read it again after every transition ([openclaw-dashboard](../../verify-yaml-deployment/features/openclaw-dashboard.md#gotchas)). A headless request is never a UI pass.
- **Plugin format:** a directory with an `openclaw.plugin.json` manifest naming the plugin `id` and a `configSchema`, a `package.json` whose `openclaw.extensions` lists the entry file, and an entry module whose default export, `register(api)`, calls `api.registerTool` and `api.on("after_tool_call", handler)`. Establish it from the selected image's OpenClaw plugin documentation and source, which the image copies with OpenClaw's `/app` ([docs/build.md](../../../../docs/build.md#update-the-openclaw-pin)), and record the source in `bindings.md`.
- A slash command sent through `fabric-agent-ctl invoke` isn't native command execution.

## Prompt Constraints

Append only these to a feature's prompt, after its last line, and save the sent text as usual:

- **Shell checks and `agent-plugin-install`:** `If exec is disabled, report that; do not run the command through any alternative.`
- **`agent-plugin-author`:** the plugin format, with `$AGENT_PLUGIN_ID` filled in, unless `bindings.md` records another format, in which case describe that one the same way:

  ```text
  Use the OpenClaw plugin format: a directory holding openclaw.plugin.json, with id set to $AGENT_PLUGIN_ID and configSchema set to an empty object schema, a package.json whose openclaw.extensions lists ./index.js, and index.js, an ES module whose default export is register(api). Register the tool with api.registerTool, with a JSON Schema for its parameters and an execute function that returns the JSON object as text content. Register the hook with api.on("after_tool_call", handler). Use only Node.js built-in modules.
  ```

- **Every request:** `Don't use slash commands.`

## Extension Fixtures

Seed these as [mounted-extensions](../features/mounted-extensions.md) step 3 describes.
They use the plugin format from the hints, the same format the agent-authored plugin uses.
The hook's event fields, `toolName`, `params`, and `toolCallId`, the write tools' `path` argument, and the names in `WRITE_TOOLS` follow that format; `WRITE_TOOLS` must hold the file-write tool from `bindings.md`. If the selected image uses other names, change only those names before seeding and record the change in `bindings.md`.

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
