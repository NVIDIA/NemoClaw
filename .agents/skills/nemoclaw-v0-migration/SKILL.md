---
name: nemoclaw-v0-migration
description: Use a report-capable NemoClaw v0 configuration export to prepare YAML for a separate OpenClaw or Hermes deployment with NemoClaw Agent Configs. Check settings against the matching documentation and Fabric adapter schema, and explain which settings cannot carry over. This skill does not move the existing deployment or its data.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Preparing a Separate Deployment From a NemoClaw v0 Export

Use the YAML from NemoClaw v0's `nemoclaw config export` to prepare and review a plan for a separate NemoClaw Agent Configs deployment. Follow the [evaluation guide](../../../docs/get-started/migration.md) before applying that plan.

## Boundaries

- **V0 stays untouched.** Inspect it only with V0's read-only commands, such as `nemoclaw <sandbox> status` and `nemoclaw config export`. Never stop, rebuild, reconfigure, or destroy it, and never edit its files.
- **No native data moves.** Conversations, memory, workspace files, and credentials stay in V0. Moving mounted data belongs to the platform; see [state and retention](../../../docs/build-deploy/state.md).
- **No guessed settings.** Write a setting only after this checkout's docs and the selected image's Fabric adapter schema confirm what it means. Otherwise tell the user it is lost.
- **Ask first** before sudo, before building images, and before `apply`, which pulls images, starts containers, and can incur inference charges.
- This skill grants no permission to destroy anything, revoke credentials, or send agent requests.

Use the docs in this checkout and a bundle built from the same revision; the [user guide skill](../nemoclaw-user-guide/SKILL.md) explains how to match them.

## 1. Get the Export

Ask the user for the export file.
It must come from a V0 release with the export report: its first line is `# nemoclaw-export-report: 1`.
Without one, they run on the V0 host, with that release's CLI:

```sh
nemoclaw config export SANDBOX --output v0-export.yaml
```

File output works only on Linux; on other hosts use `--output -` and redirect it.
Read V0's own `docs/reference/commands.mdx` for that command; it is not a v1 command.

### Refused Exports

A refused export writes no YAML.
V0 prints `Config export failed (<categories>).` and then one line per finding:

```text
<field> (<category>): <diagnostic>
```

Each finding names a V0 capability the export cannot carry, such as messaging, host mounts, sandbox GPU, custom or locally built images, OpenClaw image input, or Hermes OAuth.
Don't change the V0 deployment to make the export pass.
For each finding, tell the user what it means and where v1 stands, using the [task map](../../../docs/get-started/migration.md#mapping-the-user-task) and [limits](../../../docs/resources/limits.md).
Some diagnostics name a way to get an export, such as onboarding a new V0 sandbox without the capability; relay it, and leave the choice to the user, since it changes what they migrate.
Otherwise, if the user still wants v1, start a new document with `nemoclaw onboard` or from an [example](../../../examples), and stop here: without an export, this skill has nothing to start from.

## 2. Read the Report

The export's first line must be `# nemoclaw-export-report: 1`.
If the marker is missing or names another version, stop: this skill reads version 1 only.

The next comment lines each describe one setting:

```text
# <kind> <field> [value=<json>] [before=<json> after=<json|omitted>]: <reason>
```

- `omitted`: the export left the setting out. `value` is its V0 value.
- `placeholder`: the export wrote a stand-in to replace.
- `changed`: the export rewrote the value. `before` is V0's, `after` is the exported one, and `after=omitted` means the field was dropped.
- `review`: the export kept the value, but it may not hold in v1. `value` lists what to check.

The last line, `# gateway endpoint=... port=...`, gives V0's gateway port, which the export reuses.

Copy the export to a new file, `deployment.yaml`, and edit only the copy.
Keep the report comments: they record what V0 had.
List every report line in a working note and mark each one as you handle it in steps 3 to 6.

## 3. Give the Deployment Its Own Identity

The v1 deployment must not share an identity, port, network, or state with V0 or with any other deployment on the host.

1. Set `metadata.uid` to a fresh UUID from `uuidgen`, and change `metadata.name` if the user wants to tell them apart.
2. Choose a state directory that no deployment uses, such as `.local/v1-<name>/state`, and use it for every command.
3. Choose a free gateway port.
   Don't reuse the port from the `# gateway` line while V0 runs.
   On Linux, `ss -ltn` lists ports in use; on macOS, `lsof -nP -iTCP -sTCP:LISTEN`.
   If the export's `spec.gateway` has `runtime` and `endpoint`, the shape before `target`, `plan` refuses them; replace both with the managed `docker` target.
   Set the port in the target's `port`, such as `17921`:

   ```yaml
   gateway:
     management: managed
     target:
       docker:
         port: 17921
   ```

4. Check the gateway network.
   Without `networkCIDR` in the `docker` target, a managed gateway takes `172.30.N.0/24`, where `N` is the first byte of SHA-256 of `metadata.uid`; see the [field reference](../../../docs/reference/configuration.md).
   List the subnets on the engine:

   ```sh
   docker network ls -q | xargs docker network inspect --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
   ```

   If another network holds that subnet, set the target's `networkCIDR` to a free `/24`.
5. If the export has `spec.services` entries, their names and published ports must not collide with V0's either.

## 4. Select an Agent Image

`image.ref` is the placeholder `REPLACE-ME@sha256:000…0`, because no V0 image ships Fabric.
v1 publishes no agent images yet ([#13516](https://github.com/NVIDIA/NemoClaw/issues/13516)), so the user supplies one:

- **An image they already have.** Ask for its digest reference. `plan` checks that its Fabric label provides the harness.
- **A local build.** With the user's consent, build it from this checkout on a host of the image's platform, as [build agent images](../../../docs/build-deploy/build.md#building-agent-images) describes:

  ```sh
  cargo images build --platform linux/arm64 openclaw   # or hermes; linux/amd64 on AMD64
  docker image inspect nc-fabric:openclaw --format '{{index .RepoDigests 0}}'
  ```

Write the printed digest reference to every sandbox's `image.ref`.
The gateway's engine must hold the image.

`harness.kind` must name the adapter the image provides, exactly as the descriptor's `adapter_id` spells it.
Older exports wrote bare or outdated kinds; correct them and tell the user:

| Export says | v1 adapter |
|---|---|
| `openclaw` | `nvidia.fabric.openclaw` |
| `hermes` | `nvidia.fabric.hermes` |
| `deepagents` or `nvidia.fabric.deepagents` | `nvidia.fabric.langchain.deepagents` |

No Deep Agents migration has been run yet, so say so with the result.

## 5. Handle Each Report Entry

Find the v1 home, if any, for each line.
Confirm it in two places before writing it:

- the v1 doc named below, in this checkout;
- the adapter's descriptor in the selected image. The image's `io.nemoclaw.fabric.catalog` label holds it, as the [image metadata contract](../../../internal-docs/design/fabric-management.md#image-metadata) describes:

  ```sh
  docker image inspect IMAGE --format '{{index .Config.Labels "io.nemoclaw.fabric.catalog"}}' \
    | jq '.adapters[].descriptor | select(.adapter_id == "nvidia.fabric.openclaw") | {settings_schema, model_schema}'
  ```

  `settings_schema` holds what `harness.settings` accepts, and `model_schema` holds what a route's `overrides.settings` accepts.

If the schema lacks the field, or its meaning differs from V0's, don't write it: tell the user the setting is lost.
The table shows what the pinned Fabric adapters accept; the image's descriptor decides.

| Report field | v1 home | Notes |
|---|---|---|
| `image.ref` (placeholder) | `sandboxes.<name>.image.ref` | Step 4 |
| `execution.heartbeatEvery` | OpenClaw: `harness.settings.agents.defaults.heartbeat.every` | Same duration format, such as `30m`. Hermes has no heartbeat setting. |
| `tools.disclosure` | `progressive`: OpenClaw `harness.settings.tools.toolSearch: true`; Hermes `harness.settings.tools.tool_search.enabled: on`. `direct`: `false` and `off` | V0's `progressive` uses the agent's native tool search and `direct` shows every tool, which matches these fields' descriptions in the adapters' `settings_schema`. Write the value explicitly: when it's omitted, the adapters keep the native release's default, which neither the schema nor Fabric's adapter docs state. Tell the user the setting is now explicit. See [agent tool restrictions](../../../docs/agents-inference/agents.md#agent-tool-restrictions). |
| `interfaces` | `harness.settings.interfaces`: OpenClaw `dashboard`; Hermes `api`, `dashboard` | Write each interface V0 had on, with its `port`, after the user confirms; skip one with `enabled: false`. The port is inside the sandbox; when forwarding it, choose a local port that V0's forward doesn't hold. See [native interfaces](../../../docs/agents-inference/agents.md#native-interfaces) and [interfaces](../../../docs/agents-inference/interfaces.md). |
| `inference.reasoning`, `inference.reasoningEffort` | None for OpenClaw | The OpenClaw adapter's model schema has no reasoning field. Hermes's `harness.settings.reasoning_config` exists, but V0 reports these only for OpenClaw. |
| `inference.contextWindow` | None for OpenClaw or Hermes | Neither adapter's model schema has one. |
| `proxy` | None | v1 has no sandbox proxy setting. Egress goes through the sandbox's network policy. |
| `observability` | None confirmed | OpenClaw's adapter has no telemetry. Hermes has [Relay tracing](../../../docs/agents-inference/agents.md#hermes-relay-tracing), which isn't V0's OTLP export. |
| `network.policy.explicit.filesystem_policy`, `.process`, `.landlock` | The image's runtime policy | Step 6. `value` is V0's section, for the user's reference. |
| `network_policies.<key>` | None needed | OpenShell generated the entry from a V0 provider and generates it again for the v1 deployment's providers. |
| `network_policies[].binaries` (`review`) | Same rules, with v1 paths | Step 6. |
| `network_policies[].endpoints[].tls` (`changed`) | Already written | `skip` is v1's raw TLS tunnel; omitted `tls` is automatic termination. Tell the user, and see [sandbox network](../../../docs/security/sandbox-network.md). |

Report a line that isn't in this table to the user unchanged, without guessing a home.

## 6. Check the Rest of the Document

- **Credentials.** `credential.env` names an environment variable. The user exports it before `plan`; never ask for the value in chat or write it to YAML.
- **Managed services.** An exported `spec.services` entry has a placeholder image, reported as `# placeholder services.<name>.image`; older exports wrote `image: null`. Build or select its image as [models](../../../docs/agents-inference/models.md) or [inference](../../../docs/agents-inference/inference.md) describes, and check the vLLM `hardware.architecture` against the host. No migration with a managed service has been run yet.
- **Policy.** v1 needs the selected image's user and writable directories, and `plan` checks neither.
  With V0's sections, apply fails at agent start with `start_failed`; without any, an explicit policy gets OpenShell's defaults, which no run has shown to start a v1 agent.
  Read the image's runtime policy:

  ```sh
  docker image inspect IMAGE --format '{{index .Config.Labels "io.nemoclaw.fabric.catalog"}}' \
    | jq '.runtime.policy | {filesystem_policy, process, landlock}'
  ```

  Put its three sections in `network.policy.explicit`, and tell the user what changed from V0:
  - A current export reports V0's sections as `omitted network.policy.explicit.<section>` lines and has none in the YAML; add them.
  - An older export carries V0's sections, with `process.run_as_user` such as `"1000"`; replace them.

  Keep the `network_policies` entries: they are the user's egress rules.
  Review them with the user against [sandbox network](../../../docs/security/sandbox-network.md); the export doesn't prove they have the same effect in v1.
  Each rule's `binaries` name V0's executable paths; the `review network_policies[].binaries` line lists them, and an older export has no such line.
  Check each path in the v1 image without starting the agent:

  ```sh
  printf '%s\n' PATH... | docker run --rm -i --network none --entrypoint /bin/sh IMAGE \
    -c 'while read -r p; do if ls -d $p >/dev/null 2>&1; then echo "found $p"; else echo "missing $p"; fi; done'
  ```

  Quote each path on the host, as `printf` does here, so that patterns such as `/usr/bin/python3*` expand inside the image and not on the host.

  A rule grants access only to the executables it names ([sandbox network](../../../docs/security/sandbox-network.md)), so a rule whose paths are all missing doesn't serve the v1 agent. Show the user each missing path and the image's executable of the same name, if any, and change it only when they agree.
  An older export also carries entries whose key starts with `_provider_`; remove them and tell the user.
  OpenShell generates those entries from a sandbox's attached providers and rejects them in authored policy; `plan` accepts them, but `apply` fails at sandbox creation.
  Current exports leave them out and report each as `omitted network_policies.<key>`.

## 7. Plan

Put the bundle's `bin` on `PATH`, export the credential variables, and plan:

```sh
nemoclaw plan --state-dir STATE deployment.yaml
```

A diagnostic names the field to fix; fix it in `deployment.yaml` and plan again.
Finish every edit in steps 3 to 6 before the first apply, even when `plan` succeeds without them.
If OpenShell rejects a resource during the first apply, the state can refuse both a corrected apply and `destroy`, and the user must then remove that deployment's containers, network, and volumes by hand.
A plan with deferred work exits 0, so read its deferred items.
Before a managed gateway's first apply, expect two: the gateway's version and compute-driver check, and the image's Fabric capabilities, which apply checks once the gateway runs; see [usage](../../../docs/build-deploy/usage.md).
Resolve any other deferred item, such as a missing credential, before apply.

When the plan is complete, give the user:

- the final YAML and a diff from the export;
- each report line and what you did with it: written, already handled, or lost;
- the state directory, gateway port, subnet, and image;
- the next steps: `apply`, then the verification in [migration](../../../docs/get-started/migration.md#evaluating-v1-beside-the-existing-deployment).

Apply only when the user asks.

## Runs

These migrations were run with this skill.
A harness not listed is unproven; say so with the result.

| Harness | Export shape and exporter | v1 revision | Host | Date | Result |
|---|---|---|---|---|---|
| OpenClaw | Policy sections reported, from v0.0.144 sandbox by `56fb96ebac` | `37d85995d6` | DGX Spark, managed Docker | 2026-11-19 | Plan, apply, agent reply, and unchanged plan |
| Hermes | Policy sections reported, from v0.0.144 sandbox by `56fb96ebac` | `37d85995d6` | DGX Spark, managed Docker | 2026-11-19 | Plan |
| OpenClaw | Policy sections carried, from v0.0.144 sandbox by `9e6033585f` | `37d85995d6` | DGX Spark, managed Docker | 2026-11-18 | Plan, apply, agent reply, and unchanged plan; plan again on 2026-11-19 after the step 6 changes |
| Hermes | Policy sections carried, from v0.0.144 sandbox by `9e6033585f` | `37d85995d6` | DGX Spark, managed Docker | 2026-11-18 | Plan, apply, agent reply, and unchanged plan; plan again on 2026-11-19 after the step 6 changes |
