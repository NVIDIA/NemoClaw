<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw CLI Reference

Use `nemoclaw` from a [verified native bundle](../get-started/install.md).
Run commands from the directory containing your deployment YAML, and select the same state directory for every operation.
The [CLI parser](../../crates/nemoclaw-cli/src/args.rs) defines the following commands and options.
The [process tests](../../crates/nemoclaw-cli/tests/commands.rs) cover execution behavior.

## Commands

Use these commands for deployment authoring and lifecycle operations.
Invocation of the running agent belongs to its native interface.
Each command takes the following input and has the following result:

| Syntax | Input | Result and Effect |
|---|---|---|
| `nemoclaw onboard [FILE]` | Optional supported YAML template | Interactive authoring. Reads the target without changing it and saves validated YAML to a new file. |
| `nemoclaw plan FILE` | YAML path or `-` for stdin | Text preview. Observes resources without mutating runtime resources. |
| `nemoclaw plan --destroy` | Retained state, without YAML | Text preview of workload deletion and retention. |
| `nemoclaw apply FILE` | YAML path or `-` for stdin | Text result. Computes a checked plan and applies it. |
| `nemoclaw export` | Retained state, without YAML | Observed YAML after configuration and ownership checks. |
| `nemoclaw destroy` | Retained state, without YAML | Text result. Removes owned workloads under the retention rules. |
| `nemoclaw openshell [--] ARGS` (alias `osh`) | Retained state and any referenced TLS files | Runs the bundle's pinned OpenShell CLI against the saved gateway and workspace. Supports plaintext, mTLS, and external OIDC gateways. |

### Running OpenShell Against a Deployment

`nemoclaw osh` runs the bundle's OpenShell CLI, pinned to the gateway version, against the deployment's gateway and workspace.
The bundle includes it on Linux amd64, Linux arm64, and macOS Apple silicon; on Windows, use WSL 2.

```sh
nemoclaw osh --state-dir .nemoclaw sandbox list
nemoclaw osh --state-dir .nemoclaw -- sandbox exec -n assistant --tty -- sh
```

Use the same state directory and bundle as apply.
NemoClaw reads its own options, such as `--state-dir` and `--bundle`, up to the first OpenShell argument or the optional `--`, and passes the rest to OpenShell unchanged.
OpenShell replaces the NemoClaw process, so input, output, signals, and the exit status are OpenShell's.
OpenShell keeps the deployment's configuration in `<state-dir>/openshell/`, apart from your own OpenShell profiles.

`nemoclaw osh` supports these gateways:

| Gateway | Authentication | Setup |
|---|---|---|
| Managed Docker or Podman | None | None. |
| External | mTLS | Keep the files that `spec.gateway.tls` references, and their environment variables, available. NemoClaw links them into OpenShell's configuration. |
| External | OIDC | Add `gateway.oidc` and sign in once, as [Logging In to an External OIDC Gateway](#logging-in-to-an-external-oidc-gateway) describes. |
| Managed Kubernetes or OpenShift, published with `expose` | OIDC (`oidc` profile) | Sign in once, as [Reaching the Gateway From the OpenShell CLI](../build-deploy/kubernetes.md#reaching-the-gateway-from-the-openshell-cli) describes. |

An external gateway can run on any platform, including Kubernetes and OpenShift.
Unpublished managed Kubernetes and OpenShift gateways, and external gateways that accept only a bearer token, need a [separately configured OpenShell CLI](../agents-inference/interfaces.md#selecting-a-standalone-cli-for-bearer-token-gateways).

#### Logging In to an External OIDC Gateway

Add the gateway operator's OIDC client settings to the deployment YAML:

```yaml
gateway:
  management: external
  endpoint: https://gateway.example.com
  credential: {env: GATEWAY_TOKEN}
  oidc:
    issuer: https://idp.example.com/realms/openshell
    clientId: openshell-cli
    audience: openshell
    scopes: openid offline_access
```

`audience` and `scopes` are optional.
Plan and apply then print two commands, with the same `--state-dir` and `--bundle` options:

- `Register once:` registers the gateway with OpenShell and signs in. Run it before any other `nemoclaw osh` command; until then, OpenShell reports missing mTLS certificate files.
- `Sign in again:` runs `gateway login`, for when the session ends.

For example:

```sh
nemoclaw osh --state-dir .nemoclaw-first -- gateway add https://gateway.example.com --name=nc-3f9a1c2b7d4e8a60 \
  --oidc-issuer=https://idp.example.com/realms/openshell --oidc-client-id=openshell-cli \
  --oidc-audience=openshell '--oidc-scopes=openid offline_access'
```

OpenShell handles sign-in, token storage, and renewal, as [its authentication guide](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/how-it-works/gateways/authentication.mdx#oidc) describes:

- Without a browser, set `OPENSHELL_NO_BROWSER=1` before signing in to use a code on another device.
- For automation, set `OPENSHELL_OIDC_CLIENT_SECRET` to a confidential client's secret, and keep it set while commands run. Never put it in YAML.

The signed-in identity needs membership in the deployment's workspace.
Deployment operations still authenticate with `credential`.
After changing `gateway.oidc`, run `nemoclaw osh -- gateway remove NAME` with the same options, then register again.

The `development` authentication profile of managed Kubernetes and OpenShift gateways is for isolated testing and has no OpenShell CLI access.

Apply can download models and check readiness.
It does not request model or agent responses.
Destroy does not prompt for confirmation and deletes sandbox files and conversation history.
Read [deployment lifecycle](../build-deploy/usage.md) and preview deletion before destroying a deployment.

`nemoclaw onboard [FILE] --output FILE` starts a new deployment document with a fresh UID.
It uses the template's answers as suggestions, or built-in defaults when no template is supplied.
The output defaults to `deployment.yaml`.
Onboarding never overwrites an existing file.
It requires a terminal and does not create deployment state or apply resources.
It reads the target's engines, the selected image, and the model catalog without a bundle or OpenTofu.
An unverified read or absent image can leave an advisory and allow saving. A confirmed conflict blocks saving.
The saved file holds only the template's values and your answers.
`plan` fills the omitted fields with the defaults of the release in use.
Known engine incompatibility or conflicting image platform, manifest digest, or NVIDIA NeMo Fabric adapter requirements blocks onboarding review and saving.
The [onboarding guide](../get-started/onboard.md) describes how to run it, what it reads from the target, and what to do with the saved file.

## Credential Resolution

Plan and apply derive credential requirements from the parsed document.
Apply requires every credential reference.
Plan requires only the gateway, cluster, and image metadata references, which it reads.
It takes inference, web search, and API integration credentials from the environment when they are set, and reports a missing one as deferred work.
Each command uses a matching nonempty environment variable first and prompts only for unresolved required references.
Terminal prompts hide entered values.
When configuration is read from stdin, the required references must already be satisfied by nonempty environment variables because stdin is occupied by the document stream.
The CLI retains collected values only in memory for the current operation and supplies them through the SDK secrets boundary.
Use `--non-interactive` with plan or apply to fail with the unresolved reference names instead of prompting.
Credential values are not written to desired state, output, diagnostics, or deployment state by this fulfillment step.

## Options

Global options can appear before or after the subcommand.
Each option applies to the commands in its scope:

| Option | Scope | Meaning |
|---|---|---|
| `--state-dir DIR` | All commands | Deployment state directory for lifecycle commands. Defaults to `.nemoclaw`. |
| `--bundle DIR` | All commands | Explicit verified bundle for lifecycle commands. Defaults to the bundle containing the CLI. |
| `--verbose`, `-v` | All commands | Include internal resource addresses and completed-step timings. |
| `--progress MODE` | All commands | `auto` (default) selects inline terminal progress or plain redirected output. `plain` disables animation. `off` suppresses progress. |
| `--output FILE`, `-o FILE` | `export`, `onboard` | Write YAML to a file. Onboarding requires a new file. |
| `--output FORMAT`, `-o FORMAT` | `plan`, `apply`, `destroy` | Select `text` (default) or `json`, including destroy previews. |
| `--non-interactive` | `plan`, `apply` | Resolve credential references from nonempty environment variables and fail instead of prompting when a required reference remains unresolved. |
| `--destroy` | `plan` | Preview destroy. Cannot be combined with a YAML input. |
| `--help`, `-h` | CLI and subcommands | Display help. |
| `--version`, `-V` | CLI | Display the CLI version. |

Global options can appear before or after the subcommand.
Plan and apply require an explicit input.
Use `-` to read stdin.
Export and destroy do not accept a YAML path.

## Output and Failure

Plan, apply, and destroy write text results to stdout unless `-o json` is selected.
Export continues to write YAML to stdout or its selected file.
Use explicit JSON output for scripts:

```sh
nemoclaw plan -o json --progress off --state-dir .local/deployment deployment.yaml
nemoclaw apply -o json --progress off --state-dir .local/deployment deployment.yaml
nemoclaw plan --destroy -o json --progress off --state-dir .local/deployment
```

Text plans identify resource actions, retained resources, deferred work, and unverified checks.
Friendly labels replace known internal addresses.
Verbose output includes those addresses, and unknown resources keep their native identity.
Scoped and route-inline inference registrations include their authored provider name and definition path in result text.
Search-provider labels name the integration type.
Use verbose output to distinguish registrations with different credential references.
Normal output groups image bindings by action sequence.
Verbose output lists each binding.
Deferred work produces a prominent incomplete-plan result even when the known change list is empty.
A plan with deferred work returns 0 because the preview succeeded.
Scripts must also check `complete` before treating it as a complete plan.
Unresolved engine, hardware, image, or gateway prerequisites and missing credential references appear as deferred work.
A known engine or image or adapter incompatibility rejects planning.
Service readiness scheduled for apply appears under `unverified`, without making the resource plan incomplete.
`complete: true` means resource planning has no deferred work.
It does not establish service readiness or working inference.
Failures refreshing managed-resource identity or required gateway observations still return a nonzero exit code.
Text output partitions established resources into unchanged plans and planned changes, and reports new resources separately.
Refresh differences have a separate count: they can include computed metadata even when no resource action is planned.
Text output also summarizes advertised models and credential-reference availability.
`--verbose` adds observation statuses.
JSON output preserves the full discovery report, including query provenance and separate runtime and deployment resource scopes.

Apply summarizes actual changes.
A successful operation does not establish working model or agent responses.
Plan and apply text list each sandbox's agent with the runtime ID that state records, and print the command that invokes it.
A plan lists the runtimes the last apply left.
For each enabled agent interface, apply text also prints the commands that forward it and read its token, and how to sign in.
It never prints a token.
Destroy distinguishes removed resources from retained storage.
The retained list describes tracked resources, not every surviving host file or external service.
Refer to [agent runtimes during apply](../build-deploy/usage.md#agent-runtimes-during-apply) and [retention](../build-deploy/state.md#deletion-and-retention).

Progress goes to stderr independently of the result format.
The default inline Ratatui display uses the normal terminal screen, preserving completed milestones in scrollback.
It uses a compact panel for active resource operations and elapsed time without taking keyboard input or entering fullscreen mode.
Interactive operation starts stay in the panel.
Completed milestones and errors remain in scrollback.
Interactive progress starts with a compact NVIDIA / NemoClaw wordmark.
Recognized Kitty (0.28 or later) and Ghostty terminals add the NVIDIA eye above the progress panel without querying the terminal or reading input.
Unknown terminals, tmux, GNU Screen, Zellij, narrow windows, and nonempty `NO_COLOR` use the text wordmark.
Successful completion headings are green, including destroy.
Destructive actions and retention warnings remain amber, and failures use red.
Labels carry the same meaning without color.
A nonempty `NO_COLOR` disables styling while preserving inline progress.
Redirected streams and JSON and YAML results have no added styling.
`--progress plain` also disables styling and the wordmark.
Plain output reports stage changes and throttled waiting updates without cursor movement.
Use `--progress plain` for a terminal transcript or accessibility.
Use `--progress off` to suppress progress while preserving results and errors.
Warnings remain in final text and JSON output even when progress is off or the operation fails.
Redirected stderr uses plain progress by default, so scripts requiring a quiet stream should explicitly select `off`.

Resource operations come from OpenTofu's machine-readable events.
Download progress shows bytes and a percentage only when a valid total is known.
It is not overall deployment completion.
Elapsed time is a heartbeat, not evidence that the runtime advanced to another startup stage.
Model-loading details unavailable from the existing event stream remain generic readiness or infrastructure waits.
Default progress omits known implementation steps.
Unrecognized resources and errors remain visible.
Verbose output adds implementation steps, internal addresses, timings, and outcomes.
Progress is best-effort and never determines the operation's success.

The CLI preserves the [SDK result fields](../../crates/nemoclaw-sdk/src/deployment/mod.rs) and adds plan completeness and collected warnings for scripts:

| Field | Meaning |
|---|---|
| `outcome` | `planned`, `succeeded`, or `destroyed`. |
| `complete` | Whether a planned result has no deferred work. Inspect this alongside the exit code. |
| `warnings` | Operator-action messages collected during the operation, also reported on failures. They do not change `complete`. Omitted when empty. |
| `changes` | Resource addresses and planned or applied action lists. An empty list does not mean apply skipped readiness checks. |
| `connection` | Gateway endpoint and UID-derived workspace selectors from plan or apply. They do not establish access or configure NVIDIA OpenShell CLI credentials. `gatewayEndpoint` is omitted for a managed Kubernetes or OpenShift gateway without `expose`. `openshellCliUnavailable`, when present, explains why this client platform or gateway authentication cannot use the bundled CLI. `openshellRegistration`, for an external OIDC gateway, lists the `openshell` arguments that register it and sign in once. |
| `serviceUrls` | Apply-only URLs the gateway reports for sandbox service exposures, by sandbox and service name, with `""` for the unnamed endpoint. The URLs carry no credential, so the service must authenticate its own clients. Omitted when empty. When apply cannot read them, `warnings` says so. |
| `agents` | Each sandbox's agent, by sandbox name: `agent`, its name, and `runtimeId`, the runtime ID that `fabric-agent-ctl invoke --runtime-id` takes. A plan reports the runtimes the last apply left, and apply reports the runtimes after its changes. `runtimeId` is omitted while state records no runtime. Never contains a credential. Omitted when empty. When apply cannot read state, `warnings` says so. Refer to [invoke an agent](../agents-inference/interfaces.md#invoking-an-agent). |
| `deferred` | Unresolved planning prerequisites. Omitted when empty. |
| `resourceSources` | Authored provider `name` and definition `path`, keyed by opaque scoped resource address. Intent metadata, not proof of an established resource. Omitted when empty. |
| `unverified` | Advisories about checks such as apply-time service readiness or an unavailable catalog. Does not change `complete`. Omitted when empty. |
| `discovery` | Plan query targets, typed observations, credential-reference availability, and resource inventory. Refer to the [SDK report contract](sdk.md#reading-plan-discovery-and-resource-inventory). Omitted when empty. |
| `retained` | Retained resource addresses reported by the operation, not an inventory of every surviving file or external service. Omitted when empty. |
| `interfaces` | After apply, each enabled agent interface: `sandbox`, `interface`, its loopback `port` for an HTTP interface, the `tokenPath` in the sandbox for an interface with a token, `signIn` (`token_in_url_fragment`, `bearer_token`, `none`, or `adapter_documented`), and, for an interface with a terminal UI, the `terminal` command to run in the sandbox with `TOKEN` in place of the token. Never contains a token. Omitted when empty. Refer to [agent interfaces](../agents-inference/interfaces.md#reaching-an-agent-interface). |

Handled operation errors use the selected format: text on stderr, or one JSON result on stdout with `outcome: failed` or `outcome: interrupted`.
The failure object includes `operation`, `stateDirectory`, optional `input`, and `error.message`.
For an invalid document, `error.diagnostics` lists its errors in document order, at most 20, each with its `message` and, when the error has a place, its `path`, such as `spec.sandboxes.coding.agent.auth`, and its `line` and `column` in the input.
When available, `remainingState` describes the known effects and `help` supplies a next step.
Apply and destroy failures before a mutating subprocess launches report “No runtime resources changed.”
Local planning state might still have been written.
After a mutating subprocess launches, later failures report retained resources when known or keep the uncertainty warning, even with progress disabled.
The warning does not assert that changes completed.
Provider-generated replacement refusals name the retained resource and changed provider fields without printing their values.
External Ollama model failures identify the service's upstream field and its validated local endpoint.
Diagnostics identify the operation, cause, and confirmed retention where available.
They do not imply rollback or cleanup when resource state is unknown.
Short protected values cause child error details and resource and download progress to be withheld.
Refer to [diagnostic disclosure](../security/security.md#diagnostic-disclosure).
On Unix, SIGINT and SIGTERM cancel ongoing work, including credential prompts.
During an apply or destroy, the first signal stops OpenTofu from starting further resource operations.
The command waits until those in progress finish and the state records them, which takes as long as the slowest of them, such as a Helm install that waits for its gateway.
A second signal stops OpenTofu immediately.
A resource that it was creating can then be missing from the state.
Interruption preserves the recorded recovery boundary.
Follow [recovery](../build-deploy/usage.md#updates-and-recovery) before retrying.
The CLI exits with one of these codes:

| Exit Code | Meaning |
|---|---|
| 0 | Operation completed. A plan can still report deferred work. |
| 1 | Operation or output failure. |
| 2 | Argument-parser error. |
| 130 | Operation interrupted. |

Help, version output, and argument-parser diagnostics remain text.
An output-stream failure or forced process termination can prevent a complete JSON result.
Do not treat missing or partial output as an empty plan.
Use [inference verification](../agents-inference/inference.md#verifying-the-result) to interpret successful apply results.

An export observation failure does not replace an existing file selected by `--output`.
Shell redirection can truncate a file before the CLI runs.
Check success before using redirected output.
Refer to [recovery](../build-deploy/usage.md#updates-and-recovery) for interrupted operations and preserved state.
