<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Configuring and Accessing Native Agents

NemoClaw owns deployment resources, credential routing, isolation policy, and the lifecycle of the agent runtime.
NVIDIA NeMo Fabric owns adapter identifiers, descriptors, native configuration schemas, and native process behavior.
Use the descriptor installed in the selected image to establish what that adapter accepts.
An SDK parser accepting a field doesn't establish native support.

The sandbox commands below use the [bundled CLI](interfaces.md#selecting-the-gateway-and-workspace) for plaintext and mTLS gateways.
For bearer-token gateways, select a standalone OpenShell CLI and replace `nemoclaw osh --` with `openshell`.
If apply used a custom state directory, pass it with `nemoclaw osh --state-dir DIR --`.

## Configuring the Agent and the Harness

Set `harness.kind` to the exact Fabric adapter identifier and select an image containing that adapter.
For example, the [OpenClaw configuration](../../examples/features/inference-tuning.yaml) uses `nvidia.fabric.openclaw`.
Identifiers are opaque strings.
NemoClaw doesn't translate short aliases or maintain a native harness allowlist.

Put adapter settings in `harness.settings` and model settings in each route's `overrides.settings`.
These objects retain their exact authored values, including nested nulls.

The other sections of Fabric's agent configuration go where they belong, under Fabric's own names, and NemoClaw passes each to Fabric unchanged:

| Section | Set on | Holds |
|---|---|---|
| `instructions` | `agent` | The agent's system prompt and instruction files |
| `tools` | `agent` | Fabric's `enabled`, `blocked`, and `definitions` tool lists |
| `skills` | `agent` | Skill folders; see [skills on a mounted volume](#skills-on-a-mounted-volume) |
| `mcp` | `agent` | MCP servers |
| `workflow` | `agent` | The registered workflow target the agent runs |
| `runtime` | `harness` | Limits such as `timeout_seconds` and `max_turns` |
| `environment` | `harness` | Environment variables for the harness and its tools |
| `discovery` | `harness` | Additional descriptor discovery paths |
| `telemetry` and `relay` | `harness` | Telemetry providers and Relay plugins; see [Hermes Relay tracing](#hermes-relay-tracing) |

Sandboxes that share a harness definition through `harnessRef` share its `runtime` and `telemetry`, and each agent keeps its own instructions, tools, and skills.
The [travel team example](../../examples/features/travel-team/travel-team.yaml) gives four researchers one harness definition and each its own instructions.
The deployment sets the configuration's `metadata`, `harness`, and `models`, `runtime.artifacts`, `runtime.keep_state` where both the CLI's Fabric catalog and the image's adapter accept it, and `environment.provider` and `environment.workspace`.
An authored section that sets one of those fields to another value fails planning.
See [the SDK configuration projection](../../crates/nemoclaw-sdk/src/fabric_config.rs) for the deployment boundary.

Plan checks that the selected image provides the harness at NemoClaw's Fabric revision.
A mismatched revision leaves compatibility unknown.
Fabric validates the configuration through its installed API when the agent is configured, so a configuration the harness rejects fails during apply.
Issue [#14148](https://github.com/NVIDIA/NemoClaw/issues/14148) tracks checking it at plan time.
Neither check establishes successful model inference.

## Choosing Native Access

Select the deployment's [NVIDIA OpenShell gateway and workspace](interfaces.md#selecting-the-gateway-and-workspace) before forwarding ports or running sandbox commands.
Fabric's adapter contract defines supported input, output, native interfaces, and authentication.
The [Fabric documentation](https://github.com/NVIDIA/NeMo-Fabric/tree/main/docs) owns native integration guidance.
Use the source revision pinned in the selected image when following it.
A successful generic invocation doesn't imply that every result has an `output.response` field.

### Deploying Several Agents

Each sandbox owns one agent runtime and its selected model and provider attachments.
Use several sandbox definitions to isolate agents, credentials, and lifecycles.
The [multiple-agent example](../../examples/features/multiple-models.yaml) demonstrates shared inference definitions with independent sandbox selections.
An agent's model choices don't restrict other processes within its sandbox beyond the sandbox's provider and network policy.

### Running One Agent Request

Every harness takes a request through the same Fabric command.
The [headless OpenClaw request](#running-one-headless-openclaw-request) shows a complete example.
Use the exact adapter's public Fabric input contract and inspect its public result contract.
Inside the sandbox, `fabric-agent-ctl invoke --agent NAME --runtime-id ID --input FILE` sends one JSON value from a file to the running agent and returns Fabric's run result in `result`.
`NAME` is the agent's YAML `agent.name`, and `ID` is its current runtime ID.
Plan and apply print this command for each agent with both filled in, after the commands that select the deployment's gateway and workspace, and JSON results report them under `agents`.
See [invoke an agent](interfaces.md#invoking-an-agent).
Use `--input -` to read the value from stdin instead.
See the [bridge commands](../../internal-docs/design/fabric-management.md#bridge-commands).
Fabric receives the value unchanged.
The bundled adapters use a string as the prompt and send any other value as its JSON text.
A request can incur inference charges and affect retained agent history.
Don't assume a universal result shape.
Check `result.status` as well as the outer `status`: the outer one only reports that `fabric-agent-ctl` completed the call, while a failed run reports `result.status: failed` with Fabric's error in `result.error`.
`result.artifacts` names the files Fabric kept for that request, such as the adapter's output.

To send a prompt from the client host and keep the full result, pipe a JSON string to `--input -` and save stdout, then show the statuses with `jq`:

```sh
printf '%s\n' '"Reply with exactly READY."' |
  nemoclaw osh -- sandbox exec -n SANDBOX --no-tty -- fabric-agent-ctl invoke --agent NAME --runtime-id ID --input - > reply.json
jq '{status, result_status: .result.status, error: .result.error}' reply.json
```

The prompt keeps its double quotes because it is a JSON string; empty stdin is not a prompt.
Continue only if the command exits 0 and both statuses are `succeeded`, then read the reply from the fields that the adapter's result contract names.
Keep `reply.json` private, and review it for credentials and personal data before sharing.

### Diagnosing an Authentication Failure

An HTTP 401 or 403 reported by the inference request is evidence of rejection for that request; a successful model listing does not establish permission to invoke the selected model.
Check the YAML's inference base URL, exact model, and `credential.env` reference.
The NVIDIA Endpoints preset uses `https://integrate.api.nvidia.com/v1` and a key from [NVIDIA API Catalog](https://build.nvidia.com/settings/api-keys).
An SSO session at `inference.nvidia.com` does not supply that API key.
Do not infer a key's issuer or validity from its prefix.

If a request to the same model and base URL through the provider's supported client also returns 401 or 403 with the same key, resolve that rejection with the provider.
If that request succeeds while the sandbox request fails, check the deployment's selected endpoint, credential registration, and running process revision.
Without that comparison, retain both possibilities; a 401 alone does not identify which deployment setting is wrong.
Do not put the key in command arguments or shared debug logs.
Use [managed credential rotation](../security/credential-rotation.md#inference-web-search-and-api-keys-you-supply) to register a replacement value and restart affected agents through apply.
That apply replaces affected sandboxes and deletes their files and conversations except on mounted volumes; preserve required data first.
Do not recreate the whole deployment or run `hermes setup` as the credential-update procedure.

### Running One Headless OpenClaw Request

Headless operation follows the same public Fabric invocation boundary.
The [pinned OpenClaw adapter](https://github.com/NVIDIA/NeMo-Fabric/blob/76bde16c40747062001bd6ea5f5d13cadab3d706/adapters/python/openclaw/README.md) takes a text prompt and sends it to the native OpenClaw agent selected by `harness.settings.agent_id`, which defaults to `default`.
A request can incur inference charges and affect retained conversation history.

With the [v0.1.0 OpenClaw example](../get-started/first-deployment.md) applied, use its sandbox key `assistant`, agent name `main`, and state directory. Run these steps from the directory that holds `deployment.yaml`:

1. [Select the deployment's gateway and workspace](interfaces.md#selecting-the-gateway-and-workspace) in this terminal.

2. Read the runtime ID from a plan using the deployment's original YAML, state directory, and credential environment.

   ```sh
   nemoclaw plan -o json --progress off --non-interactive --state-dir .nemoclaw-first deployment.yaml > applied-plan.json &&
     RUNTIME_ID=$(jq -er '.agents.assistant.runtimeId | strings | select(length > 0)' applied-plan.json)
   ```

   If the lookup fails, stop and inspect the apply result instead of invoking with an empty ID.

3. Send one JSON prompt string to the agent.

   ```sh
   nemoclaw osh -- sandbox exec -n assistant --no-tty -- fabric-agent-ctl invoke --agent main --runtime-id "$RUNTIME_ID" --input - <<'JSON'
   "Reply with exactly READY."
   JSON
   ```

   `--agent` selects the deployment's YAML `agent.name`.

4. Verify that the command exited successfully.
5. Verify that the outer `status` is `succeeded`.
6. Verify that `result.status` is `succeeded`.
   If the command failed or either status is missing or not `succeeded`, stop and consult [native diagnostics](../observability/troubleshooting.md#reading-native-service-logs).
7. Verify that `result.output.response` contains `READY`.
   If the reply is missing or unexpected, stop and consult [inference and agent readiness](../observability/troubleshooting.md#inference-and-agent-readiness).
   Other adapters can use different output fields, and one reply does not establish general model compatibility.

If later invocations fail with `runtime_unavailable`, plan and apply again: apply starts a new runtime in the same sandbox.
If the plan shows no change, replace the sandbox using the [CLI replacement procedure](../build-deploy/usage.md#replacing-workloads-after-an-unusable-runtime).
To reach an agent from the client host, see [agent interfaces](interfaces.md).

## Native Interfaces

OpenClaw's Control UI and Hermes's API server and dashboard are native interfaces that the agent's Fabric runtime serves inside its sandbox.
Enable them under `harness.settings.interfaces` with an exact `port`, then reach them as [Reaching an Agent Interface](interfaces.md#reaching-an-agent-interface) describes.
Fabric's adapter starts each interface, generates its token, and stops it with the runtime.
NemoClaw checks each interface against its schema in the image's adapter descriptor while planning, and after apply prints the commands that forward each interface and read its token.
The agent's own tools can read those tokens and reach the interfaces, so the agent can sign in to its own interfaces.
Hermes's dashboard has no sign-in, and its browser chat runs the agent without approvals.

## Native Controls at Initialization

Author native controls through the selected adapter's settings and model schemas.
NemoClaw doesn't supply per-harness defaults, compatibility matrices, or alternate native adapters based on those controls.
Settings accepted by a different adapter or revision aren't evidence that the selected image accepts them.

## Agent Tool Restrictions

`agent.tools` is Fabric's tools section: `enabled` lists the tools the agent may use, `blocked` lists tools to withhold, and `definitions` names tool groups the adapter resolves.
NemoClaw passes the section to Fabric unchanged.
Fabric owns the identifiers' meanings and validates the adapter's tool contract.
The SDK doesn't rename tool identifiers or infer which native tools are read-only.
Use a policy supported by the selected adapter and verify the actual tool behavior separately.
Native disclosure or tool-search controls belong in adapter settings.

Tool selection is separate from OpenShell filesystem and network isolation.
A native tool policy doesn't revoke a credential or network grant already available to another process in that sandbox.
See [security](../security/security.md) for the deployment boundary.

## OpenClaw Execution Settings

Set the invocation timeout in the harness's `runtime.timeout_seconds`, which NemoClaw passes to Fabric.
Omission uses Fabric's default.
NemoClaw doesn't choose a native timeout from the adapter name.
The adapter's own startup, connection, and shutdown timeouts belong in `harness.settings` under the schema supplied by Fabric.
See the [full OpenClaw example](../../examples/platforms/docker/vllm/remote/amd64/full-featured-openclaw.yaml) and [timeout budgets](inference.md#understanding-timeout-budgets).

## OpenClaw Tracing

The pinned OpenClaw adapter supports neither Relay telemetry nor native OpenTelemetry.
Review [trace data exposure](../security/security.md) before enabling collection for another harness.

## Hermes Relay Tracing

Relay configuration belongs to Fabric's public configuration and the exact Hermes adapter contract.
It doesn't trigger adapter selection in NemoClaw.
The Hermes image installs Hermes Agent v0.22.7 on Python 3.14 with its Relay 0.11 dependency and the Switchyard Relay plugin 0.3.2.
On the harness, enable `telemetry.providers.relay` and add Switchyard under `relay.plugins.dynamic`.
NemoClaw passes both sections to Fabric without interpreting them, and Relay owns validation and activation.
Set `manifest` to `/opt/nemo-relay/plugins/switchyard/relay-plugin.toml` and provide either `config.switchyard_config` or `config.switchyard_config_path`.
Don't infer native API availability from a tracing setting.

## Defining and Attaching Integrations

Define an integration in `spec.integrations` or a sandbox's `integrations` map and attach it through the agent's `integrationRefs`.
An agent can also declare its own inline `integrations` map.
The [shared authoring rules](../build-deploy/configuration-references.md#the-authoring-rule) define scope, references, and collisions.

The managed `kind: webSearch` integration supports Brave and Tavily credential routing.
One sandbox can attach one search definition.
Unused enclosing definitions create no resources, credential requirements, or grants.
The managed binding doesn't enable a native search tool.
Declare its native plugin or public Fabric MCP configuration separately and validate it against the selected adapter.
A deployment credential grant isn't a native capability claim.

## Key-Authenticated APIs

Use `kind: api` when an agent calls an HTTP API, such as an MCP service, with a key the gateway holds:

```yaml
agent:
  name: buyer
  integrations:
    bookings:
      kind: api
      endpoints: [https://bookings.example.com/mcp]
      credential:
        env: BOOKINGS_API_KEY
```

NemoClaw registers the API with OpenShell for each image and harness that attaches it, as `openshell_api` does in HCL.
The profile grants access to the harness's executables.
OpenShell replaces the placeholder on requests to each endpoint's host, port, and path subtree, and the sandbox never sees the key.
When one key serves several hosts or path subtrees, list each URL in `endpoints`.
One registration then covers them all.

The sandbox sees the placeholder in `NEMOCLAW_API_<NAME>_<IMAGE>_KEY`, a name derived from the integration's name and the sandbox's image.
Set `sandboxEnv` when the agent's tools read the key from a fixed variable, as clients of NVIDIA's hosted APIs read `NVIDIA_API_KEY`:

```yaml
    nvidia:
      kind: api
      endpoints:
        - https://integrate.api.nvidia.com/v1
        - https://ai.api.nvidia.com/v1
      credential:
        env: NVIDIA_API_KEY
      sandboxEnv: NVIDIA_API_KEY
```

OpenShell rejects, during apply, a sandbox whose attached registrations put keys in the same variable, including a `sandboxEnv` that matches a web search's variable.
Give each integration its own `sandboxEnv`, or list the URLs that share a key in one integration's `endpoints`.
The key goes in `Authorization` as a bearer token by default.
Set `authStyle: header` and `headerName` to send the raw value in another header.
Set the referenced variable on the applying host.
Exported YAML and OpenTofu state retain only the reference.
Registering a key doesn't configure the harness to send it.
The HCL travel team configures Hermes to send the placeholder in its MCP `Authorization` header and gives the credential profile an enforced MCP tool allowlist.
A smaller Docker deployment verified that the MCP service received the key on both the quote and booking requests.
See the [HCL travel-team test result](../../examples/features/travel-team/hcl/README.md#booking-authentication).
The YAML `kind: api` integration creates a full-access REST rule for the endpoint's path subtree.
An additional sandbox MCP allowlist doesn't restrict that rule.
Use the HCL example when OpenShell must enforce which tools the agent can call on a key-authenticated endpoint.

For OAuth-refresh credentials, use an [operator-managed OpenShell provider](oauth-refresh.md).
NemoClaw doesn't wrap its refresh contract, and manual sandbox attachments affect drift checks.

## GPU Access for Agent Tools

`gpus` asks OpenShell for that many GPUs for the programs the agent runs in its sandbox:

```yaml
spec:
  sandboxes:
    assistant:
      gpus: 1
```

Merge this fragment into a complete deployment configuration.
OpenShell picks the devices and refuses the sandbox when its compute driver can't provide them: Docker needs CDI enabled, and Kubernetes needs nodes with allocatable `nvidia.com/gpu`.
To pick specific GPUs on Docker or Podman, also list their CDI names in `driverConfig`, one for each requested GPU.
`nvidia-ctk cdi list` prints the names:

```yaml
spec:
  sandboxes:
    assistant:
      gpus: 1
      driverConfig:
        docker:
          cdi_devices: ["nvidia.com/gpu=1"]
```

Kubernetes takes only the count.
The request gives the sandbox's programs device access, not CUDA libraries.
Provide those in the agent image or on a read-only [mounted volume](../build-deploy/state.md#keeping-agent-files-on-mounted-volumes).
Changing `gpus` replaces the sandbox and its agent, so keep files that must survive on mounted volumes.

## CPU and Memory Limits

`cpu` and `memory` set the limits OpenShell gives a sandbox, as quantities in OpenShell's `sandbox create --cpu` and `--memory` format:

```yaml
spec:
  sandboxes:
    assistant:
      cpu: "2"
      memory: 4Gi
```

Merge this fragment into a complete deployment configuration.
CPU takes cores or millicores, such as `2`, `0.5`, or `500m`; memory takes a byte count or a quantity such as `512Mi`, `4Gi`, or `8G`.
Quote a plain number, such as `"2"`, because both fields are strings.
NemoClaw passes both to OpenShell unchanged, and OpenShell validates them.
Docker and Podman apply each value as a runtime limit; Kubernetes applies it as both the container's request and its limit, so a node must have that much allocatable.
Omitting a field sets no limit of that kind.
Changing either one replaces the sandbox and its agent, because OpenShell can't resize a running sandbox, so keep files that must survive on [mounted volumes](../build-deploy/state.md#keeping-agent-files-on-mounted-volumes).

## Skills on a Mounted Volume

Fabric passes the skills in `fabric_agent`'s `skills` block to the harness.
For OpenClaw and Hermes, list them in `directories`, where each entry sets one key:

- `folder`: A folder of skills.
  The harness finds the skills inside it and ignores its other files.
  A folder that holds no skills, such as a new, empty volume, adds none.
- `skill`: One skill's folder, which must hold a readable `SKILL.md`.

Set `duplicates: reject` so that the agent doesn't start when two skills from your entries share a name.
Fabric's error names both.
Without `duplicates`, each harness decides which copy to load, as the table below describes.
The agent also doesn't start when an entry's path doesn't exist or isn't a folder, when a `skill` entry has no readable `SKILL.md`, or when a `folder` entry can't be listed.
Fabric's error names the entry and its path.

Use `directories` or `paths`, not both.
Each adapter defines what a `paths` entry means: OpenClaw requires each one to hold `SKILL.md`, and Hermes passes it to its `skills.external_dirs` unchecked.
For other harnesses, the [pinned Fabric adapters](https://github.com/NVIDIA/NeMo-Fabric/tree/76bde16c40747062001bd6ea5f5d13cadab3d706/adapters) say which fields they support and what a path must hold.
The `bundled` field selects which of the harness's own skills load.
Leave it out to keep the harness's default.

To give an agent skills that outlive its sandbox, mount a volume into the sandbox through OpenShell's driver configuration and point `skills` at the mount.
The gateway must allow driver configuration.
For a managed gateway, set `allow_driver_config: true` in the driver's table of `spec.gateway.config` when you create the deployment, as [mounted volumes](../build-deploy/state.md#keeping-agent-files-on-mounted-volumes) describes.
For an external gateway, its administrator enables OpenShell's `allow_driver_config`.

Mix the two entry kinds to share a folder of skills between agents and give one agent a skill of its own, with its own mount settings.
In this example, the `team-skills` volume holds a folder per skill, and the `review-skill` volume holds one skill at its root:

```text
team-skills            review-skill
├── summarize/         └── SKILL.md
│   └── SKILL.md
└── translate/
    └── SKILL.md
```

Both agents mount `team-skills` read-only.
Only the OpenClaw agent mounts `review-skill`, and it can write there.
In YAML, set each sandbox's `driverConfig` and list its mounts in the agent's `skills`:

```yaml
sandboxes:
  assistant:
    driverConfig:
      docker:
        mounts:
          - type: volume
            source: team-skills
            target: /sandbox/skills
            read_only: true
          - type: volume
            source: review-skill
            target: /sandbox/review-skill
            read_only: false
    harness:
      kind: nvidia.fabric.openclaw
    agent:
      skills:
        directories:
          - folder: /sandbox/skills
          - skill: /sandbox/review-skill
        duplicates: reject
  researcher:
    driverConfig:
      docker:
        mounts:
          - type: volume
            source: team-skills
            target: /sandbox/skills
            read_only: true
    harness:
      kind: nvidia.fabric.hermes
    agent:
      skills:
        directories:
          - folder: /sandbox/skills
        duplicates: reject
```

The `assistant` agent loads `summarize`, `translate`, and the skill in `review-skill`.
The `researcher` agent loads `summarize` and `translate`.

In HCL, use `openshell_sandbox`'s [`driver_config`](../references/provider.md#openshell-resources-and-data-sources) and `fabric_agent`'s `skills` block, with one `directories` block per entry:

```hcl
resource "openshell_sandbox" "assistant" {
  # ...
  driver_config = jsonencode({
    docker = {
      mounts = [
        { type = "volume", source = "team-skills", target = "/sandbox/skills", read_only = true },
        { type = "volume", source = "review-skill", target = "/sandbox/review-skill", read_only = false },
      ]
    }
  })
}

resource "fabric_agent" "assistant" {
  # ...
  skills {
    directories {
      folder = "/sandbox/skills"
    }
    directories {
      skill = "/sandbox/review-skill"
    }
    duplicates = "reject"
  }
}
```

OpenShell's mount settings decide whether the agent can write to the volume, and the sandbox's filesystem policy decides which paths its process may read or write.
The volume's contents persist when the sandbox is replaced, including anything the agent writes there.
How the volume gets its contents is up to the platform.
OpenShell's documentation describes the volume labels it requires.

Each harness finds the skills in a `folder` entry by its own rules:

| Volume layout | Hermes | OpenClaw |
| --- | --- | --- |
| A `folder` entry holds `SKILL.md` itself | Loads the folder as a skill, along with the skills below it. | Doesn't start; use a `skill` entry. |
| A skill folder contains other skill folders | Also loads the nested skills, except in a skill's `references`, `templates`, `assets`, and `scripts` folders. | Loads only the outer skill. |
| Skills sit deep below a `folder` entry | Searches every level. | Searches 2 levels, or 6 in a folder named `skills`. |
| A folder's name starts with `.`, such as `.archive` | Skips the folders Hermes skips, such as `.git` and `.archive`. | Skips it. |
| A skill's `SKILL.md` has no `description` | Loads it. | Skips it. |
| Two skills share a name and `duplicates` is left out | Loads neither. | Loads the one from the later entry. |
| A skill shares a name with the harness's own skill | The skill in Hermes's home, such as a bundled skill or one the agent wrote, loads. | A workspace skill, a skill in OpenClaw's state folder, or a shipped skill loads. |

`duplicates` doesn't change which copy loads when a skill shares a name with the harness's own skill.
Fabric doesn't expand `~` or `${VAR}` in a path.
Use absolute sandbox paths.
The [pinned Fabric skills guide](https://github.com/NVIDIA/NeMo-Fabric/blob/76bde16c40747062001bd6ea5f5d13cadab3d706/docs/integrations/harness/skills.mdx) lists every difference Fabric knows of.

## Web Search

Declare the credential reference and attach the definition to each agent that searches:

```yaml
agent:
  name: researcher
  integrations:
    search:
      kind: webSearch
      provider: brave
      credential:
        env: BRAVE_API_KEY
```

Use `provider: tavily` for Tavily.
The [web search example](../../examples/features/web-search.yaml) shows two agents sharing one definition.
Set the referenced variable on the applying host through your secret-management mechanism.
NemoClaw registers the search API as an [`openshell_api`](../references/provider.md#api-credentials) credential: a workspace-scoped provider profile and credential-bearing provider in OpenShell.
The sandbox receives a placeholder, `BRAVE_API_KEY` or `TAVILY_API_KEY` even when the host reference has another name, and OpenShell substitutes the real key for authorized requests to the search API.
Set `sandboxEnv` when the harness reads the key under another name.
Hermes's Brave plugin, for example, reads `BRAVE_SEARCH_API_KEY`:

```yaml
    search:
      kind: webSearch
      provider: brave
      credential:
        env: BRAVE_API_KEY
      sandboxEnv: BRAVE_SEARCH_API_KEY
```

Exported YAML and OpenTofu state retain the host reference, not its value.
Destroy removes the owned provider and profile without revoking the upstream key.
Apply registers a new value behind an unchanged reference and replaces the sandboxes that use the search; see [rotating credentials](../security/credential-rotation.md).
Follow [credential retirement](../security/security.md#credentials-and-authentication) when replacing or revoking the key.

The profile admits only the search requests the harness's executables make: Brave's `GET /res/v1/web/search`, or Tavily's `POST /search` and `POST /extract`.
Inference provider and `api` integration names can't use the reserved `brave-search` or `tavily-search` registration prefixes.
Unused definitions create no resources or credentials.

OpenShell supplies the credential and the network grant.
The agent's own tools make the search requests.
NemoClaw doesn't install search plugins or configure harness-native search.
OpenClaw's Brave and Tavily plugins can't be configured through Fabric's OpenClaw adapter ([#13361](https://github.com/NVIDIA/NemoClaw/issues/13361)).
The [managed search tests](../../crates/nemoclaw-sdk/tests/web_search.rs) cover profile selection, grants, credentials, and authored scope.
Native tool behavior, account quota, and live search results require separate qualification ([#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).

## Pi Model Selection

The [Pi example](../../examples/agents/fabric-pi.yaml) selects a model by name.
For a model Pi doesn't ship, which includes every model served through OpenShell's inference gateway, Pi needs the model's API, context window, and output limit.
With the pinned Fabric, Pi also fails a request with `pi_model_error` unless `input` and `cost` are set, although Fabric's schema lists them as optional:

```yaml
overrides:
  model: qwen3:4b
  maxTokens: 4096
  extensions:
    context_window: 32768
    input: ["text"]
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}
```

NemoClaw sends the provider's API to any adapter whose Fabric descriptor declares a model `api`.
Set it in `extensions` only to override that.
`extensions` holds the model fields the selected adapter declares, and Fabric validates them.
`extensions` can't set a field the deployment already sets.
The SDK preserves each named route plus the `default` role.

Any model or settings update replaces the agent and its sandbox, deleting its writable layer and in-memory conversation.
Use [mounted agent-data volumes](../build-deploy/state.md#keeping-agent-files-on-mounted-volumes) for files that must survive.
Retained files don't by themselves resume a native conversation.

## Runtime Lifecycle

Build the selected agent image with its installed Fabric metadata using the [image procedure](../build-deploy/build.md#building-agent-images).
Use an immutable image reference available to the sandbox compute daemon.
Deployment identity and ownership checks protect provider registrations and retained storage.

Fabric validates public Fabric configuration when the runtime starts.
Apply starts the agent after OpenTofu establishes the required dependencies.
A configuration change replaces the agent's sandbox rather than starting another runtime inside it.
Removing `fabric_agent` stops the runtime.
Unchanged configuration doesn't request inference or restart the runtime.
The host reports its active runtime identity and remembered public configuration.
This observation isn't a native filesystem audit or proof of successful inference.

Export checks owned resource bindings and the observed public configuration against retained intent.
Unknown, missing, or conflicting observations preserve state for inspection.
Destroy removes owned deployment resources according to their retention policy.
It doesn't revoke external provider credentials.
Keep the matching bundle and state for teardown of older deployments instead of adopting them implicitly.

## Additional Agent Integrations

Fabric's MCP, workflow, telemetry, and adapter settings remain available through the agent's and the harness's sections and `harness.settings`, subject to Fabric's schemas.
NemoClaw doesn't provision every external service named by those objects.
Declare required deployment egress and credentials explicitly and follow the owner's lifecycle instructions.
Configuration acceptance is distinct from native behavior, external service availability, and live qualification.
