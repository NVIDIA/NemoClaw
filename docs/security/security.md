<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security and Credential Ownership

Select controls for the actual sandbox image, engine host, gateway, and inference endpoint.
Verify the [CLI archive's provenance](../get-started/install.md) before extracting it and pin runtime images by digest. Artifact verification does not qualify the sandbox or inference endpoint. Parser acceptance and protocol fixtures do not establish security qualification on a deployment host.

## Isolation and Trust

NVIDIA OpenShell enforces the declared sandbox policy.
NVIDIA NeMo Fabric runs the native agent within that sandbox.
Use [sandbox policy](sandbox-network.md) for filesystem, process, egress, and proxy configuration.
An explicit policy replaces the preset.
A change to network rules, middleware bindings, or grants updates the running sandbox in place and closes connections opened under its previous rules.
A change to filesystem, Landlock, or process settings replaces the sandbox, as does any change to a policy APF governs.
Replacement deletes the sandbox's files and conversations except on mounted volumes.
See [how policy changes take effect](sandbox-network.md#verifying-and-changing-the-configuration).

The isolated preset uses Landlock `best_effort`.
Unavailable restrictions are not enforced.
Each declared agent has its own OpenShell sandbox.
Tool grants do not further isolate processes or files within that sandbox.
Refer to [agent tool restrictions](../agents-inference/agents.md#agent-tool-restrictions).
Fabric's Hermes adapter defaults `HERMES_YOLO_MODE` and `HERMES_ACCEPT_HOOKS` to `1`, so Hermes runs commands and hooks without asking for approval.
Rely on the sandbox policy for isolation.

Refer to the [threat model](threat-model.md) for what a deployment protects and from whom, and the [hardening checklist](#hardening-a-deployment) for reducing the remaining risks.
Host-specific security qualification is part of [qualification](https://github.com/NVIDIA/NemoClaw/issues/12641).

### Identifying the Trust Boundaries

Account for host operators, gateway operators, sandbox processes, and endpoint operators separately.
Each actor or component has the following access:

| Actor or Component | Access to Account For |
|---|---|
| Client running the CLI or SDK | Reads declared credential references and TLS files, operates the deployment state, and starts the matched provider and OpenTofu processes. |
| Docker or Podman host administrator | Controls containers, images, mounted storage, and process environments. Container-local file permissions do not exclude this administrator. |
| OpenShell gateway and supervisor proxy | Enforce the configured routing and policy and install or substitute provider credentials. |
| Fabric and native agent inside a sandbox | Share the sandbox's permitted files, processes, and native credentials. The sandbox is the isolation boundary. |
| Inference endpoint operator | Receives the requests routed to that endpoint. |
| Recipe tools and runtime images | Execute within their declared runtime. Select reviewed immutable artifacts and retain their source notices. |

Before granting access, identify the destination, executing binary, files, and credentials the task needs.
Use [explicit network policy](sandbox-network.md#choosing-a-policy) for an allowed destination.
Selecting an HTTP proxy alone does not grant egress.
An explicit policy replaces the entire preset, so retain the intended filesystem and process settings too.

## Credentials and Authentication

Each credential procedure must identify who supplies the value, where it persists, who can read it, and how it is retired.
Use the owning guide for the selected credential type:

| Credential or Connection | Storage, Access, and Retirement | Owning Procedure |
|---|---|---|
| Gateway bearer credential and TLS files | Caller supplies environment values and local files. The SDK and provider need access. Gateway operator owns revocation, while the caller removes local values and files when no longer needed. | [Configuration and credentials](../build-deploy/usage.md#configuration-and-credentials) |
| Literal application-container environment key | Caller places the value in private YAML. It enters plans, state, exports, and Docker configuration. The application and engine administrators can read it. Caller owns artifact cleanup and upstream revocation. | [Application environment](../build-deploy/container-services.md#protecting-application-credentials) |
| External inference key, including Hermes provider authentication | Caller resolves the reference. OpenShell retains the installed value for routing. Destroy removes the provider registration, not the upstream account or key. | [Inference authentication](../agents-inference/inference.md#authenticating-hermes-through-the-provider) |
| Key for a model server you run in a Kubernetes or OpenShift cluster | Caller supplies the value where `nemoclaw` runs, and a Kubernetes Secret supplies it to the server. Principals who can read Secrets or create Pods in the server's namespace, or exec into the server's Pod, and node administrators can read it. OpenShell retains the installed value for routing. Destroy removes the provider registration, not the Secret or the server's key. | [In-cluster model server](../build-deploy/kubernetes.md#using-a-model-server-in-the-cluster) |
| Generated managed vLLM key | Private file in a separate retained credential volume, available to runtime root and engine administrators. Recreation reuses it. Retiring the container does not erase the key. | [Managed service authentication](../agents-inference/inference.md#authenticating-a-managed-vllm-service) |
| Generated external-Ollama proxy key | Private credential volume, available to proxy root and engine administrators. Retained across destroy and recreation and never forwarded to Ollama. | [Ollama proxy](../agents-inference/inference.md#using-external-ollama-through-a-managed-proxy) |
| Brave or Tavily search key | Caller supplies the value. OpenShell holds it and replaces the agent's placeholder. Destroy removes managed registrations but does not revoke the upstream key. | [Web search](../agents-inference/agents.md#web-search) |

Removing a caller's environment variable does not revoke an upstream key or erase a credential retained by a gateway.
Unchanged apply does not automatically detect changed values behind the same reference.
Managed private HTTP endpoints with bearer authentication do not provide TLS.

To rotate any of these credentials, follow the [rotation runbook](credential-rotation.md).
For a corporate CA, refer to [Trusting a Corporate Certificate Authority](#trusting-a-corporate-certificate-authority).

Keep credential values out of committed or shared YAML, shell arguments, shared URLs, and published diagnostics.
Generic application containers have no protected credential delivery: their environment values are literal and appear in configuration and state.
Use credential references where the selected provider supports them, rather than copying that plaintext approach into gateway or inference settings.
The example authoring TUI saves credential references and never resolves their values.
Authoring and lifecycle operations are separate commands.
Accepting an authored document does not authorize apply.
Inspect a secret-free plan before invoking apply.
For `plan` or `apply`, `--non-interactive` requires environment-provided credentials and fails instead of prompting when a reference the command requires is unresolved.
Plan requires only the gateway, cluster, and image metadata references, so a host without inference or integration credentials can preview a deployment.
Use environment references for provider secrets and protected files for gateway TLS keys.
Configuration export preserves references.
It cannot recover a lost credential value.
Retiring a deployment requires separate decisions about upstream revocation, retained gateway, model, and proxy storage, and caller-owned files.
[Removing Retained Resources](../build-deploy/usage.md#removing-retained-resources) removes retained storage from Docker engines.

### Diagnostic Disclosure

The SDK keeps resolved credential-reference values out of its own error construction and filters child-process errors and progress as a backstop.
Arbitrary literal container environment values are not automatically registered for this protection.
Treat resulting diagnostics as potentially sensitive.
For values of at least eight Unicode characters, the filter replaces matching spans in one pass, merging overlaps without rescanning `[redacted]` markers.
This exact-value filter does not cover encoded or transformed secrets.
Providers must still avoid putting credentials in diagnostics.

When any protected value has fewer than eight characters, the SDK withholds child error text and detailed child resource and download progress uniformly, whether or not that value appears in the output.
Failures report `child diagnostic withheld because a credential is too short for safe redaction`.
This prevents character-position disclosure.
The threshold does not reject credentials or validate their strength.
SDK stage progress, operation results, and known remaining-state guidance remain available.

Protected values include resolved environment references passed to the child, including gateway TLS file paths, and nonempty values in the SDK process environment whose names contain `KEY`, `TOKEN`, `SECRET`, or `PASSWORD`, ignoring case.
The environment scan includes values subsequently excluded from the child environment or overridden.
If withholding is unexpected, check those references and remove unrelated credential-like environment variables from the invocation.
The [subprocess tests](../../crates/nemoclaw-sdk/src/process.rs) and [bundled CLI fixture](../../crates/nemoclaw-e2e/tests/integration/rust/deployment.rs) exercise these boundaries.

### Separating the TLS Connections

Each connection has its own trust and authentication settings.
Trusting one layer does not configure the others.
The current configuration boundaries are:

| Connection | Current Configuration Boundary |
|---|---|
| Client to OpenShell gateway | HTTPS uses trust verification. Optional `gateway.tls` names a CA that replaces the system roots, and a client certificate and key for mutual TLS, through environment references to file paths. |
| Client to inference catalog during onboarding | Uses the client machine's trust store or `SSL_CERT_FILE`. This trust does not configure the inference path. |
| OpenShell to external inference | NemoClaw accepts HTTP and HTTPS URLs, with or without a credential. OpenShell checks destinations when a sandbox connects. Prefer HTTPS for credentialed endpoints: over plain HTTP, the key crosses the network unencrypted. |
| Managed vLLM or Ollama proxy private endpoint | Optional or generated bearer authentication does not add TLS to the private HTTP transport. |
| Client to native dashboard | Authenticated OpenShell forwarding carries the connection to the sandbox-local listener. Keep the local bind on loopback. |

### Trusting a Corporate Certificate Authority

Each layer that makes outbound TLS connections has its own trust store:

| Layer | How It Trusts a Corporate CA |
|---|---|
| The machine running NemoClaw: catalog reads during onboarding, and OpenTofu's providers | The system trust store, or `SSL_CERT_FILE`. Refer to [custom CA trust](../agents-inference/inference.md#trusting-a-custom-certificate-authority). |
| The engine pulling images | The Docker or Podman daemon's own registry trust, configured on the engine host. |
| The OIDC issuer of a managed Kubernetes gateway | `caConfigMap` in the [OIDC profile](../build-deploy/kubernetes.md). |
| OpenShell's gateway and sandbox egress | OpenShell's images' trust store. For sandbox egress, OpenShell also trusts the CAs in its gateway's [additional CA bundle](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/how-it-works/gateways/configuration.mdx#additional-destination-cas). No managed gateway can receive it ([current limits](../resources/limits.md#security)). A CA in the bundle authenticates every policy-permitted destination whose certificate chains to it, so include only CAs that sandboxes should trust. |
| A corporate proxy that OpenShell chains egress through | OpenShell's `proxy_ca_bundle` driver setting, a file on the gateway. No managed gateway can receive it ([current limits](../resources/limits.md#security)). |
| Model downloads inside managed vLLM and Ollama | The runtime image's trust store. Not configurable. |
| Image builds (`docker buildx bake`) | Not supported behind TLS-intercepting proxies. Build on a network that does not intercept TLS. |

Do not reuse gateway mTLS settings as a trust configuration for any other layer.

## Retained Data and Telemetry

Read [state and retention](../build-deploy/state.md) before deleting a deployment or disposing of its storage.
For tracing, review [Hermes Relay tracing](../agents-inference/agents.md#hermes-relay-tracing) and, for any collector, its operator's data access and retention policy.
Before enabling export, identify who can read the collector's stored data and how long it is retained.
The current integration selects an existing collector.
It does not provision or manage that retention policy.
Experimental [Hermes Relay tracing](../agents-inference/agents.md#hermes-relay-tracing) instead writes local sandbox artifacts without adding a collector or egress rule.
Its full-payload setting is disabled, but trace contents still need privacy review before sharing.
Deleting the sandbox deletes those files.

Traces can contain prompts, model output, tool calls and their arguments, and file contents, so treat them like agent data:

- **Local traces:** Hermes Relay writes them into the sandbox. Destroying or replacing the sandbox deletes them, unless they are on a [mounted volume](../build-deploy/state.md#keeping-agent-files-on-mounted-volumes), where the volume's owner controls their retention.
- **Collectors:** retention and access are the collector operator's policy. NemoClaw does not configure them.
- **Before sharing a trace:** review it for credentials, personal data, and confidential files. Keep the full-payload setting disabled unless you need it.

### Usage Telemetry

The `nemoclaw` CLI sends one usage record to NVIDIA when `apply` or `destroy` finishes, and when `onboard` writes the configuration.
`plan` and `export` send nothing.
Telemetry is on by default, and the CLI does not prompt for consent.

To turn it off, set `NEMOCLAW_DISABLE_TELEMETRY` in the environment that runs `nemoclaw`:

```bash
export NEMOCLAW_DISABLE_TELEMETRY=1
```

Any value other than empty, `0`, or `false` in any letter case turns telemetry off, so `yes` and `TRUE` also work.
The CLI also sends nothing when any of these CI variables is set by the same rule: `CI`, `GITHUB_ACTIONS`, `TF_BUILD`, `BUILD_ID`, `TEAMCITY_VERSION`, or `CODEBUILD_BUILD_ID`.

The CLI makes one HTTPS POST request to `https://events.telemetry.data.nvidia.com/v1.1/events/json` with a 3-second timeout.
It never retries, and a failed send never changes the command's output or exit code.
The record carries these fields:

| What | Fields |
|---|---|
| Install and build | `nvidiaSource`, `installId`, `firstRun`, `version`, `previousVersion`, `buildKind`, `testLabel` |
| The command | `operation`, `outcome`, `effect`, `failureStage`, `durationMs` |
| The machine | `os`, `arch`, `hostContext`, `deploymentSource`, `cloud`, `hardware` |
| The configuration | `harnesses`, `models`, `inferenceHosts`, `computeDriver`, `sandboxCount`, `agentCount`, `webSearch`, `mcpConfigured` |

The [telemetry design](../../internal-docs/design/telemetry.md) lists every field with its values and source.
These rules limit what the configuration and machine fields carry:

- **Model names** are sent as written in the configuration, from each sandbox's default route. A name longer than 64 characters or containing `://` is sent as `unknown`.
- **Harness IDs** are sent as written only when the bundled Fabric catalog lists them. Any other ID is sent as `other`.
- **Inference endpoints** are matched on the machine against `local`, `build.nvidia.com`, `inference.nvidia.com`, `openai`, and `anthropic`. Only the matched word is sent, or `other`; the URL is never sent.
- **Machine details** are read locally from the operating system, DMI vendor and product names, and the `/etc/nemoclaw/deployment-source` marker that a platform image sets. Only a word from a fixed list is sent.

The record never carries deployment, sandbox, service, agent, user, or host names, file paths, URLs, endpoint or IP addresses, image names, credentials, prompts, or error text.

The install ID is a random UUID kept in `telemetry.json` in a `nemoclaw` directory under the user configuration directory: `$XDG_CONFIG_HOME` or `~/.config` on Linux, `~/Library/Application Support` on macOS, and `%APPDATA%` on Windows.
It is not derived from the machine.
Deleting the file creates a new install ID on the next run.
Uninstalling the CLI does not remove the file.

QA runs set `NEMOCLAW_TELEMETRY_TEST_LABEL` to a label such as `qa-1120a:onboard-hermes:attempt-2`, which the record carries as `testLabel` so reports can leave QA runs out.
The label must match `qa-<run>:<case>:attempt-<n>`, with lowercase letters, digits, and `-` in `<run>` and `<case>`.
When the variable is set to any other value, the CLI sends nothing.

The OpenShell gateway has its own telemetry, separate from this record.
For a gateway that NemoClaw manages, the gateway's telemetry follows the same switch and CI variables.
NemoClaw reads the switch when it plans the deployment, so set it before `plan` and `apply`.
Changing the switch for an existing deployment replaces a Docker or Podman gateway on the next apply, keeping its storage, and upgrades a Kubernetes gateway's release.
NemoClaw does not change an external gateway's telemetry; configure it with OpenShell's own settings.

## Hardening a Deployment

Apply the controls at the boundary that enforces them and verify the resulting permissions before admitting untrusted work.
Harden a deployment with these controls:

- **Give each agent its own sandbox and volumes,** and grant only the hosts, methods, and tools its task needs.
- **Use rootless Podman or a dedicated Docker host,** and limit who administers the engine. Administrators can read every container's data.
- **Run on hosts with Landlock support,** so the isolated preset's filesystem restrictions are enforced.
- **Use HTTPS** for credentialed endpoints, external gateways, and model servers on other hosts.
- **Prefer credential references** to literal values, and keep the state directory private.
- **Use the OIDC profile** for managed Kubernetes gateways in shared clusters.
- **Pin images by digest,** and use a fresh `metadata.uid` for each deployment.
- **Rotate keys** on a schedule with the [rotation runbook](credential-rotation.md), and revoke old keys after their sandboxes are replaced.

## Reporting a Vulnerability

Use the private channels in [SECURITY.md](../../SECURITY.md), including NVIDIA's disclosure program and encrypted PSIRT email.
Do not include vulnerability details or credentials in a public issue.

## Implementation and Tests

The [policy validator](../../crates/nemoclaw-openshell/src/policy.rs), [credential handling](../../crates/nemoclaw-docker/src/credentials.rs), [runtime authentication](../../crates/nemoclaw-runtime/src/execution/authentication.rs), and [managed-auth tests](../../crates/nemoclaw-sdk/tests/managed_auth.rs) implement parts of these controls.
