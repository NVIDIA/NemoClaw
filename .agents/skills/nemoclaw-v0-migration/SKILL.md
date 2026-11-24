---
name: nemoclaw-v0-migration
description: Use a report-capable NemoClaw v0 configuration export to prepare YAML for a separate OpenClaw or Hermes deployment with NemoClaw Agent Configs. Check settings against the matching documentation and Fabric adapter schema, and explain which settings cannot carry over. This skill does not move the existing deployment or its data.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Preparing a Separate Deployment From a NemoClaw v0 Export

Use the YAML from NemoClaw v0's `nemoclaw config export` to prepare and review a plan for a separate NemoClaw Agent Configs deployment. Follow the [evaluation guide](../../../docs/get-started/migration.md) before applying that plan.

## Boundaries

- **Leave the NemoClaw v0 deployment untouched.** Use its read-only commands, such as `nemoclaw <sandbox> status` and `nemoclaw config export`. Never stop, rebuild, reconfigure, or destroy it, and never edit its files.
- **No native data moves.** Conversations, memory, workspace files, and credentials stay in NemoClaw v0. Moving mounted data belongs to the platform; see [state and retention](../../../docs/build-deploy/state.md).
- **No guessed settings.** Write a setting only after this checkout's docs and the selected image's Fabric adapter schema confirm what it means. Otherwise tell the user it is lost.
- **Ask first** before sudo, before building images, and before `apply`, which pulls images, starts containers, and can incur inference charges.
- This skill grants no permission to destroy anything, revoke credentials, or send agent requests.

Use the docs in this checkout and a bundle built from the same revision; the [user guide skill](../nemoclaw-user-guide/SKILL.md) explains how to match them.

## 1. Get the Export

This skill requires an export from a NemoClaw v0 CLI that supports the export report. The first line of the file is `# nemoclaw-export-report: 1`.

1. Ask the user for the export file.
2. If the user hasn't exported the file, direct them to the `config export` reference for their installed NemoClaw v0 revision. This command belongs to NemoClaw v0, not Agent Configs.
3. If the installed CLI supports the export report, have the user run the export on the NemoClaw v0 host:

   ```sh
   nemoclaw config export SANDBOX --output v0-export.yaml
   ```

   File output requires Linux. On other hosts, use `--output -` and redirect it.
   If the CLI doesn't support the report, [author separate deployment YAML](../../../docs/get-started/onboard.md) instead.

### Refused Exports

A refused export writes no YAML.
NemoClaw v0 prints `Config export failed (<categories>).` and then one line per finding:

```text
<field> (<category>): <diagnostic>
```

Each finding names a NemoClaw v0 capability the export cannot carry, such as messaging, host mounts, sandbox GPU, custom or locally built images, OpenClaw image input, or Hermes OAuth. Don't change the existing deployment to make the export pass.

1. Explain each finding using the [Agent Configs task map](../../../docs/get-started/migration.md#mapping-the-user-task) and [limits](../../../docs/resources/limits.md).
2. Relay any option the diagnostic suggests, such as onboarding a new NemoClaw v0 sandbox without the capability. Let the user decide whether to use those different settings as the starting point.
3. If there's no export to work from, direct the user to [onboarding](../../../docs/get-started/onboard.md) or an [example](../../../examples) for a fresh deployment document.

## 2. Read the Report

The export's first line must be `# nemoclaw-export-report: 1`.
If the marker is missing or names another version, stop: this skill reads version 1 only.

The next comment lines each describe one setting:

```text
# <kind> <field> [value=<json>] [before=<json> after=<json|omitted>]: <reason>
```

- `omitted`: the export left the setting out. `value` comes from the earlier deployment.
- `placeholder`: the export wrote a stand-in to replace.
- `changed`: the export rewrote the value. `before` is the value in NemoClaw v0, `after` is the exported value, and `after=omitted` means the field was dropped.
- `review`: the export kept the value, but it may not apply in Agent Configs. `value` lists what to check.

The last line, `# gateway endpoint=... port=...`, gives the NemoClaw v0 gateway port, which the export reuses.

Copy the export to a new file, `deployment.yaml`, and edit only the copy.
Keep the report comments: they record the source settings.
List every report line in a working note and mark each one as you handle it in steps 3 to 6.

## 3. Give the Deployment Its Own Identity

The new deployment must not share an identity, port, network, or state with the NemoClaw v0 deployment or with any other deployment on the host.

1. Set `metadata.uid` to a fresh UUID from `uuidgen`, and change `metadata.name` if the user wants to tell them apart.
2. Choose a state directory that no deployment uses, such as `.local/v1-<name>/state`, and use it for every command.
3. Choose a free gateway port.
   Don't reuse the port from the `# gateway` line while the NemoClaw v0 gateway runs.
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
5. If the export has `spec.services` entries, their names and published ports must not collide with those of the existing deployment.

## 4. Select an Agent Image

The export leaves `image.ref` as `REPLACE-ME@sha256:000…0`. Use an agent image that provides the selected Fabric adapter and matches the bundle's source revision.

1. Select a verified immutable reference for the harness from the **Images** list for the installed Agent Configs release, if available.
2. If you can't verify a matching release digest, follow the [source-build procedure](../../../docs/build-deploy/build.md#building-agent-images) at the bundle's source revision. Get the user's consent before building.
3. Set each sandbox's `image.ref` to its selected digest reference. The gateway's engine needs access to the image. [Plan doesn't pull images](../../../docs/build-deploy/usage.md#pulling-from-private-registries).
4. Set `harness.kind` to the selected image descriptor's exact `adapter_id`. Older exports can contain bare or outdated kinds:

   | Export says | Agent Configs adapter |
   |---|---|
   | `openclaw` | `nvidia.fabric.openclaw` |
   | `hermes` | `nvidia.fabric.hermes` |
   | `deepagents` or `nvidia.fabric.deepagents` | `nvidia.fabric.langchain.deepagents` |

5. Explain any adapter ID correction to the user.

The recorded evaluations don't cover Deep Agents.

## 5. Handle Each Report Entry

For each report entry, confirm that Agent Configs supports the setting in both sources before writing it:

- The linked Agent Configs guide in this checkout.
- the adapter's descriptor in the selected image. The image's `io.nemoclaw.fabric.catalog` label holds it, as the [image metadata contract](../../../internal-docs/design/fabric-management.md#image-metadata) describes:

  ```sh
  docker image inspect IMAGE --format '{{index .Config.Labels "io.nemoclaw.fabric.catalog"}}' \
    | jq '.adapters[].descriptor | select(.adapter_id == "nvidia.fabric.openclaw") | {settings_schema, model_schema}'
  ```

  `settings_schema` holds what `harness.settings` accepts, and `model_schema` holds what a route's `overrides.settings` accepts.

If the schema lacks the field, or its meaning differs from the meaning in NemoClaw v0, don't write it: tell the user the setting is lost.
The table shows what the pinned Fabric adapters accept; the image's descriptor decides.

| Report field | Agent Configs setting | Notes |
|---|---|---|
| `image.ref` (placeholder) | `sandboxes.<name>.image.ref` | Step 4 |
| `execution.heartbeatEvery` | OpenClaw: `harness.settings.agents.defaults.heartbeat.every` | Same duration format, such as `30m`. Hermes has no heartbeat setting. |
| `tools.disclosure` | `progressive`: OpenClaw `harness.settings.tools.toolSearch: true`; Hermes `harness.settings.tools.tool_search.enabled: on`. `direct`: `false` and `off` | In NemoClaw v0, `progressive` uses the agent's native tool search and `direct` shows every tool, which matches these fields' descriptions in the adapters' `settings_schema`. Write the value explicitly: when it's omitted, the adapters keep the native release's default, which neither the schema nor Fabric's adapter docs state. Tell the user the setting is now explicit. See [agent tool restrictions](../../../docs/agents-inference/agents.md#agent-tool-restrictions). |
| `interfaces` | `harness.settings.interfaces`: OpenClaw `dashboard`; Hermes `api`, `dashboard` | Write each interface that was enabled in NemoClaw v0, with its `port`, after the user confirms; skip one with `enabled: false`. The port is inside the sandbox; when forwarding it, choose a local port that the existing port forward doesn't hold. See [native interfaces](../../../docs/agents-inference/agents.md#native-interfaces) and [interfaces](../../../docs/agents-inference/interfaces.md). |
| `inference.reasoning`, `inference.reasoningEffort` | None for OpenClaw | The OpenClaw adapter's model schema has no reasoning field. Hermes's `harness.settings.reasoning_config` exists, but NemoClaw v0 reports these only for OpenClaw. |
| `inference.contextWindow` | None for OpenClaw or Hermes | Neither adapter's model schema has one. |
| `proxy` | None | Agent Configs has no sandbox proxy setting. Egress goes through the sandbox's network policy. |
| `observability` | None confirmed | OpenClaw's adapter has no telemetry. Hermes has [Relay tracing](../../../docs/agents-inference/agents.md#hermes-relay-tracing), which isn't the NemoClaw v0 OTLP export. |
| `network.policy.explicit.filesystem_policy`, `.process`, `.landlock` | The image's runtime policy | Step 6. `value` is the original section, for the user's reference. |
| `network_policies.<key>` | None needed | OpenShell generated the entry from a NemoClaw v0 provider and generates it again for the new deployment's providers. |
| `network_policies[].binaries` (`review`) | Same rules, with paths from the selected image | Step 6. |
| `network_policies[].endpoints[].tls` (`changed`) | Already written | `skip` selects a raw TLS tunnel; omitted `tls` is automatic termination. Tell the user, and see [sandbox network](../../../docs/security/sandbox-network.md). |

Report a line that isn't in this table to the user unchanged, without guessing a home.

## 6. Check the Rest of the Document

- **Credentials.** `credential.env` names an environment variable. The user exports it before `plan`; never ask for the value in chat or write it to YAML.
- **Managed services.** An exported `spec.services` entry has a placeholder image, reported as `# placeholder services.<name>.image`; older exports wrote `image: null`. Build or select its image as [models](../../../docs/agents-inference/models.md) or [inference](../../../docs/agents-inference/inference.md) describes, and check the vLLM `hardware.architecture` against the host. The recorded evaluations don't cover managed services.
- **Policy.** Agent Configs needs the selected image's user and writable directories, and `plan` checks neither.
  With the NemoClaw v0 policy sections, apply fails at agent start with `start_failed`; without any, an explicit policy gets OpenShell's defaults, which the recorded evaluations haven't shown to start an agent.
  Read the image's runtime policy:

  ```sh
  docker image inspect IMAGE --format '{{index .Config.Labels "io.nemoclaw.fabric.catalog"}}' \
    | jq '.runtime.policy | {filesystem_policy, process, landlock}'
  ```

  Put its three sections in `network.policy.explicit`, and tell the user what changed from the earlier policy:
  - A current export reports the earlier sections as `omitted network.policy.explicit.<section>` lines and has none in the YAML; add them.
  - An older export carries the earlier sections, with `process.run_as_user` such as `"1000"`; replace them.

  Keep the `network_policies` entries: they are the user's egress rules.
  Review them with the user against [sandbox network](../../../docs/security/sandbox-network.md); the export doesn't prove they have the same effect in the new deployment.
  Each rule's `binaries` name executable paths from the NemoClaw v0 image; the `review network_policies[].binaries` line lists them, and an older export has no such line.
  Check each path in the selected image without starting the agent:

  ```sh
  printf '%s\n' PATH... | docker run --rm -i --network none --entrypoint /bin/sh IMAGE \
    -c 'while read -r p; do if ls -d $p >/dev/null 2>&1; then echo "found $p"; else echo "missing $p"; fi; done'
  ```

  Quote each path on the host, as `printf` does here, so that patterns such as `/usr/bin/python3*` expand inside the image and not on the host.

  A rule grants access only to the executables it names ([sandbox network](../../../docs/security/sandbox-network.md)), so a rule whose paths are all missing doesn't serve the agent in the new deployment. Show the user each missing path and the image's executable of the same name, if any, and change it only when they agree.
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
A new managed gateway can defer gateway checks, and a missing local image can defer its Fabric compatibility check. With the Docker inspection engine, apply acquires and checks the image before creating the gateway. See [usage](../../../docs/build-deploy/usage.md#pulling-from-private-registries).
Resolve actionable deferred items, such as missing credentials, before apply.

When the plan is complete, give the user:

- the final YAML and a diff from the export;
- each report line and what you did with it: written, already handled, or lost;
- the state directory, gateway port, subnet, and image;
- the next steps: `apply`, then the verification in the [evaluation guide](../../../docs/get-started/migration.md#evaluating-v1-beside-the-existing-deployment).

Apply only when the user asks.

## Runs

These runs evaluated separate deployments using settings from NemoClaw v0 exports. The results apply only to the listed harnesses, revisions, and hosts.

| Harness | Export shape and exporter | Agent Configs revision | Host | Date | Result |
|---|---|---|---|---|---|
| OpenClaw | Policy sections reported, from v0.0.144 sandbox by `56fb96ebac` | `37d85995d6` | DGX Spark, managed Docker | 2026-11-19 | Plan, apply, agent reply, and unchanged plan |
| Hermes | Policy sections reported, from v0.0.144 sandbox by `56fb96ebac` | `37d85995d6` | DGX Spark, managed Docker | 2026-11-19 | Plan |
| OpenClaw | Policy sections carried, from v0.0.144 sandbox by `9e6033585f` | `37d85995d6` | DGX Spark, managed Docker | 2026-11-18 | Plan, apply, agent reply, and unchanged plan; plan again on 2026-11-19 after the step 6 changes |
| Hermes | Policy sections carried, from v0.0.144 sandbox by `9e6033585f` | `37d85995d6` | DGX Spark, managed Docker | 2026-11-18 | Plan, apply, agent reply, and unchanged plan; plan again on 2026-11-19 after the step 6 changes |
