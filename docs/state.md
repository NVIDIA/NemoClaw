<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Locate and Preserve Deployment State

Keep the desired-state YAML, its matching bundle, and the entire deployment state directory for recovery.
The CLI defaults to `.nemoclaw` in the working directory; use `--state-dir` to select another directory.
Separate deployments need separate state directories and deployment UUIDs.

## Local Deployment Files

These files are managed by the SDK and OpenTofu.
They are implementation details for identifying retained state, not a manual editing interface.

| Location under the state directory | Purpose |
|---|---|
| `intent.json` | Desired document, ownership generations, digest, and operation progress |
| `deployment.lock` | Excludes concurrent NemoClaw operations on this state directory |
| `terraform.tfstate` | OpenTofu resource state and durable bindings |
| `main.tf.json`, `providers.tfrc` | SDK-generated graph and provider configuration |
| `helm-recovery.json` | Private checkpoint for a bound Helm release during destroy; keep it with the OpenTofu state until recovery or removal completes |
| `kubernetes/` | Managed Kubernetes ownership receipt, development issuer key material, and gateway client credentials |

The [state store](../crates/nemoclaw-sdk/src/state/mod.rs), [deployment lifecycle](../crates/nemoclaw-sdk/src/deployment/mod.rs), and [OpenTofu configuration](../crates/nemoclaw-sdk/src/deployment/opentofu.rs) define these files.
Keep the whole directory after failure; deleting state does not establish that its runtime resources are absent.
The local lock does not exclude other clients of the same gateway.
State records carry a format version; the SDK rejects a different version without rewriting the directory or adopting its resources.

## Agent Files

These paths are inside the sandbox, not the client's deployment state directory.
Use authenticated [native access](interfaces.md) for the selected deployment.
The [SDK's Fabric configuration](../crates/nemoclaw-sdk/src/fabric_config.rs) sets the working directory to `/sandbox/workspace` and the artifact root to `/sandbox/artifacts`.
The [image runtime environment](../image/fabric/runtime.json) sets `HOME=/sandbox`.
Native settings can select other locations; inspect the selected harness configuration before collecting files.

| Agent data | Location and lifetime |
|---|---|
| Agent working files | `/sandbox/workspace`, the Fabric environment workspace NemoClaw configures |
| Agent artifacts | `/sandbox/artifacts`; Hermes Relay traces go under `relay/`; deleted with the sandbox unless stored on a mounted volume |
| Harness configuration, history, and caches | Owned by the selected Fabric adapter, under its own home or temporary directories; see the adapter's documentation |
| Claude adapter files | `/sandbox/artifacts/.fabric/claude`; generated MCP configuration and skill plugins, not a conversation backup |
| Codex adapter files | `/sandbox/artifacts/.fabric/codex`; for a non-OpenAI model provider, the adapter sets `CODEX_HOME` to its `custom-provider-home` subdirectory |
| Deep Agents conversation checkpoints | `/sandbox/artifacts/.fabric/deepagents/runtimes/<key>.sqlite`, where `<key>` is the SHA-256 hexadecimal digest of the Fabric runtime ID |
| Hermes native home | `/sandbox/artifacts/.fabric/hermes/runtimes/<runtime-id>`; contains the runtime's generated configuration and native session database |
| OpenClaw native state | A private temporary directory selected by the adapter, removed when the runtime stops; setting `OPENCLAW_STATE_DIR` does not relocate it |
| Pi conversation | Held in the running Pi process; switching declared choices preserves it, while applying configuration changes or restarting the runtime loses it |
| mini-SWE-agent conversation | Held by the live runtime; discarded when that runtime stops |
| OO Agents (`nooa`) and BenchAgent (`nooa-bench`) | Working files use the configured workspace; persistence beyond those files belongs to the selected native target, with no common backup path defined by these adapters |
| Remote agent | Conversation history is held by the live Fabric adapter and discarded when it stops; server-side data remains under the remote service's control and is not backed up by collecting sandbox files |

NemoClaw sets the workspace and artifact locations in the agent's Fabric configuration; the [pinned Fabric adapters](https://github.com/NVIDIA/NeMo-Fabric/tree/e7913b6c473a15095a1b4c3583a127e558e0c124/adapters/python) define the rest.
The table covers the harness targets in the [image build matrix](../docker-bake.hcl); a descriptor in the image catalog alone does not establish that a harness is installed or qualified on a platform.
Replacing or deleting the sandbox, as any agent configuration change does, deletes files in its writable layer.
Use mounted volumes for files that must survive replacement; retaining files does not by itself resume a native conversation.
Each declared agent runs in its own OpenShell sandbox; workspace directories do not further isolate processes within that sandbox.

### Conversation and Credential Boundaries

Claude and Codex reuse one native client or thread within a started Fabric runtime.
The pinned adapters start a new client or thread on runtime start; NemoClaw has no procedure to reattach a restarted runtime to a saved native conversation.
Claude's adapter directory contains generated integration files; it does not inventory the native SDK's conversation or login storage.
For Codex's OpenAI provider with an API-key environment reference, the adapter creates a temporary `CODEX_HOME` outside the artifact root and removes it on stop.
Without that reference, the native client's storage rules apply.
Do not assume the adapter directories contain every native credential or conversation file.

Deep Agents opens its SQLite checkpointer at runtime start and closes it at stop, but the live runtime owns the LangGraph thread identity.
Preserving the SQLite file alone does not establish that a new runtime resumes the same conversation.
Relay traces are telemetry artifacts, not an import format for restoring native conversations.

Treat collected native homes, checkpoints, workspaces, and traces as sensitive: they can contain credentials, prompts, tool output, and conversation data.
Keep them separate from public diagnostics; see [credential ownership](security.md#credentials-and-authentication).
The mounted-volume guidance below describes file retention and the pinned adapters' conversation limits; it does not qualify conversation restore or compatibility across harness versions.

## Keep Agent Files on Mounted Volumes

Ask the platform operator to provision storage before applying the deployment.
Backing up, restoring, and moving that storage is the platform's job; NemoClaw has no native-data backup or transfer command.
Use a separate volume for each agent's workspace and artifacts so unrelated agents do not share credentials or conversation data.

For a managed Docker gateway, merge this fragment into the deployment YAML: the gateway setting allows sandboxes to use driver configuration, and the sandbox mounts the volumes.

```yaml
gateway:
  management: managed
  config:
    openshell.drivers.docker:
      allow_driver_config: true
sandboxes:
  assistant:
    driverConfig:
      docker:
        mounts:
          - type: volume
            source: assistant-workspace
            target: /sandbox/workspace
            read_only: false
          - type: volume
            source: assistant-artifacts
            target: /sandbox/artifacts
            read_only: false
```

The platform must create both named volumes on the gateway's Docker engine, grant the deployment's OpenShell workspace access through the required approval labels, and make their contents writable by the sandbox's identity.
Default admission requires `openshell.ai/sandbox-attachable=true` and `openshell.ai/sandbox-attachable-workspace=<OpenShell-workspace-name>` on each volume; an operator-configured label map replaces these defaults.
Use the authorized OpenShell workspace name, not the sandbox name or Kubernetes namespace; see [external resource admission](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/docs/how-it-works/gateways/configuration.mdx#external-resource-admission).
The bundled images use UID/GID `10001:10001`; check the identity for a custom image or OpenShift namespace.
The gateway must allow driver configuration, and the sandbox's filesystem policy must allow writes to both target paths.
For a managed gateway, set `allow_driver_config: true` in the compute driver's table of [`spec.gateway.config`](usage.md#configure-a-managed-gateway), as above; Podman and Kubernetes gateways use `openshell.drivers.podman` and `openshell.drivers.kubernetes`. Changing it later replaces a Docker or Podman gateway's container, keeping its data, and upgrades a Kubernetes gateway's chart release.
OpenShell's admission settings use the same format, such as a replacement label map in an `openshell.drivers.docker.resource_admission.required_labels` table.
For an external gateway, its administrator enables OpenShell's `allow_driver_config` for the compute driver.
Mounts default to read-only, so `read_only: false` is required for agent writes.
Do not mount over `/sandbox` or the image's working directory: OpenShell protects its workspace root and control paths.
For driver-specific settings and admission labels, follow the pinned OpenShell [Docker](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/crates/openshell-driver-docker/README.md), [Podman](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/crates/openshell-driver-podman/README.md), or [Kubernetes](https://github.com/NVIDIA/OpenShell/blob/ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47/crates/openshell-driver-kubernetes/README.md) instructions; Kubernetes uses PVCs rather than Docker named volumes.

### Choose What to Retain for Each Harness

All image-build targets use `/sandbox/workspace` for working files.
Mount that directory for each target below; add the listed mounts for native files when needed.
Paths describe the pinned Fabric adapters linked above, not a common history import format.

| Harness | Additional mount and retained files | Conversation after runtime replacement |
|---|---|---|
| [OpenClaw](https://github.com/NVIDIA/NeMo-Fabric/blob/e7913b6c473a15095a1b4c3583a127e558e0c124/adapters/python/openclaw/src/nemo_fabric_adapters/openclaw/adapter.py) | Workspace files only; the adapter overrides native state/config paths with its private temporary directory and removes it on stop | Mounting the workspace does not preserve the adapter's temporary native history |
| [Hermes](https://github.com/NVIDIA/NeMo-Fabric/blob/e7913b6c473a15095a1b4c3583a127e558e0c124/adapters/python/hermes/src/nemo_fabric_adapters/hermes/adapter.py) | `/sandbox/artifacts` retains the native home and session database under `.fabric/hermes/runtimes/<runtime-id>`, plus Relay traces when enabled | A new runtime starts with empty conversation memory; retaining its database does not establish automatic resume |
| [Claude Code](https://github.com/NVIDIA/NeMo-Fabric/blob/e7913b6c473a15095a1b4c3583a127e558e0c124/adapters/python/claude/src/nemo_fabric_adapters/claude/adapter.py) | `/sandbox/artifacts` retains generated MCP configuration and skill plugins under `.fabric/claude`; this is not an inventory of the native client's home | The adapter starts a new native client; no saved-conversation reattachment procedure is provided |
| [Codex](https://github.com/NVIDIA/NeMo-Fabric/blob/e7913b6c473a15095a1b4c3583a127e558e0c124/adapters/python/codex/README.md#authentication) | `/sandbox/artifacts` retains `.fabric/codex`, including `custom-provider-home` for non-OpenAI providers; cached native login uses `CODEX_HOME` (default `/sandbox/.codex`), which needs its own mount if retained | The adapter starts a new thread; OpenAI API-key login instead uses a temporary home outside artifacts and removes it on stop, even if `CODEX_HOME` was supplied |
| [LangChain Deep Agents](https://github.com/NVIDIA/NeMo-Fabric/blob/e7913b6c473a15095a1b4c3583a127e558e0c124/adapters/python/deepagents/src/nemo_fabric_adapters/deepagents/adapter.py) | `/sandbox/artifacts` retains the SQLite checkpoints under `.fabric/deepagents/runtimes` | Each runtime creates a new LangGraph thread ID; the saved SQLite file alone does not resume the old thread |
| [Pi](https://github.com/NVIDIA/NeMo-Fabric/blob/e7913b6c473a15095a1b4c3583a127e558e0c124/adapters/typescript/pi/src/pi-sdk.ts) | Workspace files; the adapter uses an in-memory session manager | No conversation file to retain; stopping the runtime loses its conversation |
| [OpenCode](https://github.com/NVIDIA/NeMo-Fabric/blob/e7913b6c473a15095a1b4c3583a127e558e0c124/adapters/typescript/opencode/README.md) | Workspace files, and each invocation's reported diff under `opencode/` in the artifact directory | No conversation file to retain; stopping the runtime removes its session |
| [Deep Agents Code](https://github.com/NVIDIA/NeMo-Fabric/blob/e7913b6c473a15095a1b4c3583a127e558e0c124/adapters/typescript/deepagents-code/README.md#state-and-outbound-requests) | `/sandbox/artifacts` retains `dcode`'s home under `.fabric/deepagents-code/runtimes/<runtime-id>/deepagents`: its generated `config.toml`, memory, and `sessions.db` with the runtime's thread and any terminal sessions, beside the terminal launcher under `interfaces/` | A new runtime starts a new thread; the old thread stays in the old runtime's `sessions.db`, which the new runtime's `dcode` doesn't read |
| [mini-SWE-agent](https://github.com/NVIDIA/NeMo-Fabric/blob/e7913b6c473a15095a1b4c3583a127e558e0c124/adapters/python/mini-swe-agent/src/nemo_fabric_adapters/mini_swe_agent/adapter.py) | Workspace files; the adapter keeps the conversation in the live runtime | No conversation file to retain; stopping the runtime loses its conversation |
| [OO Agents (`nooa`)](https://github.com/NVIDIA/NeMo-Fabric/blob/e7913b6c473a15095a1b4c3583a127e558e0c124/adapters/python/nooa/src/nemo_fabric_adapters/nooa/adapter.py) | Workspace files; additional storage depends on the selected native target | The adapter defines no common persistent conversation path or restore procedure |
| [BenchAgent (`nooa-bench`)](https://github.com/NVIDIA/NeMo-Fabric/blob/e7913b6c473a15095a1b4c3583a127e558e0c124/adapters/python/nooa/src/nemo_fabric_adapters/nooa/bench_adapter.py) | Workspace files; additional storage depends on the selected native target | The adapter defines no common persistent conversation path or restore procedure |
| [Remote agent](https://github.com/NVIDIA/NeMo-Fabric/blob/e7913b6c473a15095a1b4c3583a127e558e0c124/adapters/python/remote-agent/src/nemo_fabric_adapters/remote_agent/adapter.py) | Workspace files and any requested local artifacts; remote service data stays with that service | Local adapter history is in memory; a local volume does not back up the remote service |

Mounting the whole home or a temporary directory does not establish conversation resume.
Homes can contain login tokens and generated authentication configuration, while adapter cleanup can still delete files on a mounted temporary directory.
Native conversation reattachment needs support from Fabric and the selected harness.

### Verify Retention before Relying on It

From the deployment's working directory, plan and apply the edited YAML with its original state directory using [the update procedure](usage.md#updates-and-recovery).
Adding or changing `driverConfig` replaces the sandbox, so first preserve any files needed from its existing writable layer through authenticated native access.
A new mount does not move those files into the volume.

Select the authenticated gateway and workspace using [native access](interfaces.md#select-the-gateway-and-workspace).
From the same client terminal, replace `assistant` with the sandbox name and create two non-sensitive markers:

```sh
openshell sandbox exec -n assistant --no-tty --no-login-shell -- sh -c '
  set -eu
  umask 077
  for directory in /sandbox/workspace /sandbox/artifacts; do
    marker=$(mktemp "$directory/nemoclaw-retention.XXXXXX")
    printf "%s\n" "nemoclaw-retention-check" > "$marker"
    cat "$marker"
    printf "marker: %s\n" "$marker"
  done
'
```

Expect `nemoclaw-retention-check` and a newly created file path for each directory; record both paths.
For a deployment whose replacement you have authorized, read those exact paths after replacement, substituting the suffixes printed above:

```sh
openshell sandbox exec -n assistant --no-tty --no-login-shell -- cat /sandbox/workspace/nemoclaw-retention.REPLACE /sandbox/artifacts/nemoclaw-retention.REPLACE
```

Expect the two marker lines again and inspect the named volume or PVC from the platform side to confirm the intended storage is attached.
Remove only the two marker files you created after checking them.
These commands are checked against the pinned CLI parser. Retention of both directories through a sandbox replacement was verified on a managed Docker gateway.
The check verifies file retention only; separately verify any native history workflow before depending on conversation continuity.
If the mount is rejected or unwritable, retain the original state and volumes, correct admission labels, driver settings, policy, or filesystem ownership, then retry with the same deployment state.
Do not delete the volume as a recovery step.

Before the platform takes a backup or transfers a volume, stop writers and follow the native harness's database consistency requirements.
Keep the source volumes and the original harness version until the destination can read the required files and its native history workflow has been verified.
Protect native homes and artifacts as credential-bearing data; volume retention is separate from credential revocation.

## Configuration Export and Agent Data

Export produces checked desired-state YAML with credential references.
It does not copy agent files, histories, native settings, or model weights.
Use [the export workflow](usage.md) for configuration and [native agent access](agents.md) to identify agent-owned state.

Use [mounted volumes](#keep-agent-files-on-mounted-volumes) to retain agent files; the platform owns backups, restore and transfer of those volumes.
The current CLI has no snapshot or lost-state adoption command.

## Deletion and Retention

**Destroy deletes the sandbox's writable layer and its in-memory conversation history.**
Files on caller-supplied mounted volumes remain under the platform's control; preserve or retire them separately.
The [destroy guide](usage.md#destroy) owns the workload removal, retained-storage, and recovery procedure.
Destroy also deletes the OpenShell workspace; re-applying the same configuration recreates it.

Credentials can also remain in retained runtime storage.
See [managed vLLM authentication](inference.md#authenticate-a-managed-vllm-service), [Ollama proxy credentials](inference.md#use-external-ollama-through-a-managed-proxy), and [security](security.md) before retiring storage.

To retire a deployment, follow [Remove Retained Resources](usage.md#remove-retained-resources).

### Understand the Retained Resources

| Resource or data | Result of a completed destroy |
|---|---|
| Sandbox writable layer and in-memory conversation history | Deleted; caller-supplied mounted volumes remain under platform control |
| Kubernetes sandbox workspace claim | Deleted; under the `Retain` reclaim policy, its volume remains `Released` with the workspace files |
| Deployment provider profiles and registrations, including declared Brave integration resources | Removed; upstream keys are not revoked |
| External gateway, inference service, external Ollama daemon/model, and externally owned engine/network | Remain under their operators' control |
| OpenShell workspace | Deleted; re-applying the configuration recreates it |
| Managed vLLM/Ollama process containers and service-owned networks | Removed; model storage remains tracked |
| Managed model downloads and prepared data | Native Docker volumes retained by default; missing caches may be reconstructed separately from credentials |
| Managed vLLM credentials | Separate tracked credential volume retained |
| Managed Ollama proxy | Container removed; tracked credential volume retained |
| Managed Docker or Podman gateway | Process removed; database, signing/encryption keys, bridge, and stopped initializer retained |
| Managed Kubernetes gateway | Release and development issuer removed; namespace, credential key Secret, and the gateway's persistent volumes retained |
| Local deployment state, bundle, and container images | Remain; removing the CLI bundle is separate from destroying its deployment |

The [teardown implementation](../crates/nemoclaw-sdk/src/deployment/runtime/teardown.rs) selects retained bindings.
Destroy's JSON `retained` list identifies tracked resource addresses; it is not an inventory of every host file or externally owned resource.
Record those addresses and keep the state directory if you need to account for retained storage later.

### Find Retained Docker Objects

On Docker engines, each retained resource consists of Docker objects labelled `nemoclaw.nvidia.com/uid` with the deployment's UID.
Their names start with the deployment's workspace, `WS` below: `nc-` followed by the first 16 hexadecimal digits of the SHA-256 digest of `metadata.uid`.

| `plan --destroy` entry | Docker objects |
|---|---|
| `gateway storage` | Volume `WS-gateway-data`, network `WS-network`, and exited container `WS-gateway-initialize` |
| `model cache/NAME` | Volume `WS-inference-NAME-data` for vLLM, or `WS-ollama-NAME-data` for Ollama |
| `inference credentials/NAME` | Volume `WS-inference-NAME-auth` |
| `proxy credentials/NAME` | Volume `WS-ollama-proxy-NAME-auth` |

On Podman, the same objects exist with the same names and label, in the Podman engine the deployment selects.

### Find Retained Kubernetes Objects

On a managed Kubernetes or OpenShift gateway, destroy keeps these objects, all in the namespace that `gateway.kubernetes.namespace` names:

| Object | Holds |
|---|---|
| The namespace itself | Everything below. NemoClaw creates it, or binds an existing one by UID without changing it |
| Secret `GATEWAY-kek`, where `GATEWAY` is the gateway's release name | The gateway's key-encryption key |
| The gateway's PersistentVolumeClaims, and the volumes bound to them | The gateway's database |
| Secrets `GATEWAY-server-tls`, `GATEWAY-client-tls` and `GATEWAY-jwt-keys`, and the ServiceAccount, Role and RoleBinding `GATEWAY-certgen` | The chart's certificates and signing key, and the hook account that writes them; Helm doesn't remove hook objects |

Volumes are cluster-wide, outside the namespace.
Under the `Retain` reclaim policy, each destroyed sandbox's workspace volume also remains, `Released`, with a claim reference that names the namespace.

The state directory keeps the ownership receipt, which records the namespace's UID, and, for the `development` authentication profile, the development issuer's keys.

## Recovery and Transfer

Use [operation recovery](usage.md#updates-and-recovery) with the original configuration and retained state.
For a failed or interrupted native Helm release removal, use [Helm removal recovery](usage.md#recover-an-interrupted-helm-removal); preserve the checkpoint and current state together.
For a move from an earlier product version, use [migration](migration.md).
The platform owns transfer of mounted native data; a copied volume does not move deployment ownership or establish compatibility with another harness version.
Moving deployment state to another host is unqualified, and native conversation continuity depends on Fabric and the selected harness.
