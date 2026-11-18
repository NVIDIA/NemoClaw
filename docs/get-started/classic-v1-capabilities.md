<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Classic-to-v1 Capability Catalog

**Draft for review, 17 November 2026.**
Each entry explains one row in the [capability matrix](classic-v1-matrix.md).
The scope is brief; implementation guides and issue links carry the detailed contracts.

This comparison inspects v1 at `459a78500600eb810e76bc68cc2080d3bf346a9f`, with Fabric `135147a0fe6ce6bc2ebf21fa1068d1bd5af71780`, and Classic `main` at `495896a404`.
Match the bundle, images, harness, model, host, and credentials you intend to use.
An upstream merge, a spreadsheet completion label, or accepted YAML does not by itself establish support in that combination.
This document adds no new live qualification.

## Use This Catalog

Evaluate a separate v1 deployment when its documented paths cover your required workflows and you can preserve your Classic deployment and data during the evaluation.
Keep using Classic for any essential workflow marked planned, confirmation pending, or unavailable until you have verified a suitable v1 path.
Features delegated to OpenShell, a native harness, or platform storage can remain available through those components, with a different operator workflow.

Follow [the migration guide](migration.md) for separate identities, state directories, data protection, and evaluation steps.
Export describes configuration; it does not copy native data or adopt existing resources.
There is no general in-place migration or automatic return of v1 data to Classic.

## Capabilities

### Deploy and manage agents

**Status:** Available.

**Scope:** Select an agent, create and preview its configuration, start it, and manage its deployment.

**Select and start OpenClaw or Hermes.**
Desired-state configuration, apply, and native access are available through [agents](../agents-inference/agents.md) and [interfaces](../agents-inference/interfaces.md).
Match the image and Fabric adapter; check the actual native interface and a model reply. Other harnesses have separate limits.

**Create, preview, change, export, or remove a deployment.**
[Desired-state lifecycle](../build-deploy/usage.md) replaces the Classic command model.
Confirm replacement effects and retained resources; command names and deployment state are not compatible with Classic.

### Connect and serve models

**Status:** Available.

**Scope:** Connect a model endpoint or run a supported managed vLLM/Ollama service.

**Connect hosted inference or an existing model server.**
[Inference connections](../agents-inference/inference.md), including external OpenAI-compatible services and vLLM, are available.
Verify the actual API, model, authentication, streaming, and tool behavior. This does not qualify every named provider.

**Let NemoClaw manage local inference.**
Managed [vLLM/Ollama](../agents-inference/models.md) paths exist.
Host/GPU/harness combinations have [limits](../resources/limits.md); existing external endpoints and managed services are different outcomes.

### Retain agent files

**Status:** Available.

**Scope:** Keep selected agent files on caller-supplied volumes through sandbox replacement.

**Keep agent files through replacement.**
[Caller-supplied volumes](../build-deploy/state.md#keep-agent-files-on-mounted-volumes) retain files.
File retention is separate from native settings/history compatibility and conversation resume.

### Supply skills and settings

**Status:** Available.

**Scope:** Load supplied skills and configure supported native harness settings.

**Supply skills and native settings.**
Public Fabric sections and [skills on mounted volumes](../agents-inference/agents.md#skills-on-a-mounted-volume) are available.
Harness discovery rules differ; skill loading does not prove arbitrary plugin acquisition, installation, upgrade, or removal.

### Connect MCP tools

**Status:** Available.

**Scope:** Connect a key-authenticated MCP service through the supported harness and credential path.

**Connect a key-authenticated MCP tool.**
Public Fabric MCP configuration plus gateway-held keys; see [key-authenticated APIs](../agents-inference/agents.md#key-authenticated-apis).
The documented Hermes HCL path enforces MCP tool restrictions. YAML `kind: api` grants a REST subtree; it does not establish equivalent MCP tool restriction. Server provisioning and OAuth remain separate.

### Apply network and key policy

**Status:** Available.

**Scope:** Declare destination access and route credentials through OpenShell.

**Enforce destination policy and protect inference/API keys.**
[OpenShell policy and credential routing](../security/security.md) remain available through declared configuration.
Dropping a separate NemoClaw enforcement story does not remove network policy. Do not put protected secrets in literal application environment fields.

### Extend images and run apps

**Status:** Available.

**Scope:** Use a derived agent image or declare a supported application container.

**Extend an agent image or run an application container.**
[Derived agent images](../build-deploy/derived-images.md) and [generic container services](../build-deploy/container-services.md) are distinct supported contracts.
Generic containers are local managed Docker only; their `data` is disposable and their literal environment/files do not provide protected secrets.

### Use SDKs and providers

**Status:** Available.

**Scope:** Manage desired-state deployments through the Rust SDK or OpenTofu providers.

**Use a native SDK or OpenTofu provider.**
[Rust SDK and providers](../references/sdk.md) exist.
The Classic TypeScript package has no compatible replacement API; dropping a Rust parity story does not remove the implemented Rust SDK.

### Use company runtime identity

**Status:** Available.

**Scope:** Attach operator-managed OAuth-refresh credentials through the documented OpenShell workflow.

**Use company runtime identity.**
[Operator-managed OAuth-refresh providers](../agents-inference/oauth-refresh.md) provide a documented path.
Manual attachments and refresh material are outside exported deployment YAML; do not infer completion of the entire enterprise-governance journey.

### Inspect health and failures

**Status:** Available.

**Scope:** Inspect runtime readiness and collect deployment-failure diagnostics.

**Inspect runtime readiness and deployment failures.**
[Troubleshooting](../observability/troubleshooting.md) and native runtime observations are available.
Readiness is not functional inference; deployment diagnostics are not a shareable diagnostic bundle or enterprise audit system.

### Download and install NemoClaw

**Status:** Available at publication; implementation pending in the inspected revision.

**Scope:** Download and install a matched NemoClaw release for the user's platform, put the executable on PATH, and verify installation using the guide.

**Spreadsheet reference:** E01-S01 — Packaging & Installation of NemoClaw.

The follow-up review places this capability in Available because it must be finished before the matrix is public.
The inspected revision does not yet provide the release installer/download channel; this classification does not claim it is complete today.
Select the packaging and distribution method, produce the supported platform packages, provide matching runtime images and installation instructions, and verify a clean-machine install without a source checkout.
Completion remains a publication prerequisite and a pre-GTC DC deliverable under [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638), roadmap phase 0.

### Onboard with familiar choices

**Status:** Planned parity.

**Scope:** Guide users through the agreed Classic onboarding choices and generate ordinary YAML.

**Onboard with familiar Classic choices.**
A YAML-writing onboarding command exists; the full Classic scenario inventory is incomplete.
Define the missing journeys and optional presets, rather than reproducing every old prompt. Roadmap A.

### Set up web search

**Status:** Planned parity.

**Scope:** Configure and demonstrate real web search, then decide whether to provide onboarding presets.

**Search the web.**
Credential routing exists; native OpenClaw search configuration and selected end-to-end search paths remain limited.
Generic plugin/MCP, endpoint, and credential configuration plus a YAML demo; separately decide an onboarding preset. [#13361](https://github.com/NVIDIA/NemoClaw/issues/13361), roadmap A.

### Connect and manage messaging

**Status:** Planned parity.

**Scope:** Enroll, chat, restrict senders, reconnect through updates, rotate credentials, and disconnect.

**Use and manage messaging channels.**
Enrollment, chat, access control, reconnection, rotation, and disconnect are not a complete v1 journey.
Agreed parity; investigate the Fabric contract and deliver onboarding plus lifecycle together. [#12037](https://github.com/NVIDIA/NemoClaw/issues/12037), roadmap C.

**Review question:** Which messaging providers and enterprise controls are required?
Inventory the Classic channel lifecycle and company enrollment/policy workflows with their owners. The call deferred the enterprise discussion to the relevant team.

### Agent assisted migration

**Status:** Planned parity.

**Scope:** Use Classic export to help an agent recreate and verify a separate v1 deployment.

**Move Classic configuration and data.**
No guaranteed migrator, state adoption, or native-data conversion.
Agent-assisted recreation from export, with documented gaps and a separately verified platform data-transfer path. Roadmap A.

### Trace and review activity

**Status:** Planned parity.

**Scope:** Route selected agent traces and activity/access signals through the agreed Relay integration.

**Export traces and review activity/access decisions.**
Hermes Relay configuration exists; OpenClaw tracing and broader activity/audit semantics remain separate.
Post-GTC Relay integration; define collector, identity, retention, and access requirements. [Fabric #625](https://github.com/NVIDIA/NeMo-Fabric/issues/625), roadmap D.

### Broader local model support

**Status:** Planned parity.

**Scope:** Expand the supported local model, hardware, and harness combinations beyond the currently documented paths.

Broader local model support is planned by the follow-up review decision.
Managed llama.cpp and NIM delivery is tracked separately in [Run llama.cpp and NIM](#run-llamacpp-and-nim).
Verify each selected model's fit, configuration, authentication, inference, and tool behavior before adding it to the available support matrix.

The original card also raised Gemini and Bedrock provider validation.
Those are separate provider paths, not evidence of local serving support: the call expected them to work through the harness/OpenShell but supplied no successful qualification for the selected combinations.
Keep their identity, API, and model checks explicit; Gemini must not be conflated with downloadable Gemma models.
See [#12035](https://github.com/NVIDIA/NemoClaw/issues/12035), [models](../agents-inference/models.md), and [provider guidance](../agents-inference/inference.md).

### Configure native plugins

**Status:** Available.

**Scope:** Configure native plugins supported by the selected harness and image.

Native plugin configuration is Available by the follow-up review decision, consistent with the call's report that this capability had shipped.
Use the selected adapter's supported settings, supply its dependencies and credentials, and follow its native discovery rules.
Skill loading alone does not establish arbitrary plugin support.
Broad third-party acquisition, installation, versioning, upgrade, and removal remain a separate proposal in [Fabric #614](https://github.com/NVIDIA/NeMo-Fabric/issues/614).
See [agent configuration](../agents-inference/agents.md) for the supported configuration boundary.

### Continue conversations

**Status:** Available.

**Scope:** Continue a saved conversation through the selected harness's supported session-resume path.

Conversation continuation is Available by the follow-up review decision.
For the inspected Fabric pin, Hermes supports explicit SDK resume using a saved `SessionRef` and retained native storage.
Select the intended session and preserve the storage its harness requires.

This classification does not promise automatic continuation after every NemoClaw runtime or sandbox replacement.
The inspected NemoClaw replacement flow is not documented to select the saved reference automatically, and OpenClaw cold resume remains separately tracked.
See [pinned Hermes resume](https://github.com/NVIDIA/NeMo-Fabric/blob/135147a0fe6ce6bc2ebf21fa1068d1bd5af71780/adapters/python/hermes/README.md), [Fabric #578](https://github.com/NVIDIA/NeMo-Fabric/issues/578), and [per-harness limits](../build-deploy/state.md#choose-what-to-retain-for-each-harness).

### Retain application data

**Status:** Needs review.

**Scope:** Keep application-owned data through supported update and removal operations.

**Retain generic application data through update/removal.**
The meeting expected volumes to cover it; the current generic container contract explicitly calls its data disposable.
Reconcile scope and storage ownership before claiming completion; prove a documented supported path in a demo. [#12568](https://github.com/NVIDIA/NemoClaw/issues/12568), roadmap B.

### Run llama.cpp and NIM

**Status:** Planned parity.

**Scope:** Add managed llama.cpp and NIM model-serving support with documented configuration and lifecycle behavior.

Managed llama.cpp and NIM support are planned by the follow-up review decision.
Estimate the work and sequence implementation with model readiness, hardware fit, credential handling, storage, and an actual agent response; see roadmap B2.
Existing external NIM endpoints remain a separate available connection path.

The inspected code and current limits predate this planning decision: managed llama.cpp is absent and managed NIM was previously excluded under [#12649](https://github.com/NVIDIA/NemoClaw/issues/12649).
The follow-up decision changes the planned scope; it does not add either managed runner to the inspected implementation.
Update the owning issue and current limits as the new direction is implemented.

### Share diagnostic bundles

**Status:** Needs review.

**Scope:** Collect useful debugging artifacts in a bundle that is safe to share.

**Share a diagnostic bundle.**
Current logs and debugging artifacts do not establish a complete sharing workflow.
Inspect Classic behavior before deciding scope; do not equate logs with Relay traces. Roadmap decisions.

### Review distributed inference

**Status:** Needs review.

**Scope:** Decide whether experimental multi-machine serving should return to the parity scope.

**Review question:** Should distributed inference return to planned scope?
Meeting 37:25–40:16 dropped it on the premise Classic lacked it, but Classic documents experimental [two-Spark](https://github.com/NVIDIA/NemoClaw/blob/495896a404/docs/inference/set-up-vllm-on-two-dgx-sparks.mdx) and [two-Station](https://github.com/NVIDIA/NemoClaw/blob/495896a404/docs/inference/set-up-vllm-on-two-dgx-stations.mdx) serving. Dropped scope is not a permanent exclusion.

### Verify native memory search

**Status:** Needs review.

**Scope:** Preserve the needed native harness memory indexing and search behavior.

**Review question:** What native memory behavior must carry over?
Classic documents [embedding-backed memory search](https://github.com/NVIDIA/NemoClaw/blob/495896a404/docs/configure-agents/configure-memory-search.mdx). The meeting dropped a separate NemoClaw subsystem, not all native memory. Verify the selected harness path.

### Verify credential rotation

**Status:** Needs review.

**Scope:** Replace and revoke MCP credentials through a documented v1 workflow.

**Review question:** What is the supported credential-rotation journey?
Classic has [MCP credential rotation](https://github.com/NVIDIA/NemoClaw/blob/495896a404/docs/manage-sandboxes/manage-mcp-servers.mdx). Dropping a standalone v1 story does not prove equivalence; a value change behind an unchanged reference is not rotated by unchanged apply.

### Review enterprise parity

**Status:** Needs review.

**Scope:** Confirm the required company enrollment, identity, policy, and recovery workflows with their owners.

**Review question:** Which enterprise controls must carry over?
The meeting deferred company-policy and enterprise workflow decisions to the relevant owners (53:55–54:26). Existing scoped APF/OAuth work does not establish either completion or absence of the whole journey.

### Built-in backup commands

**Status:** Not planned in NemoClaw.

**Scope:** NemoClaw-owned backup, restore, and snapshot commands; platform backup remains separate.

**NemoClaw-owned backup, restore, and snapshot commands.**
No equivalent NemoClaw command; platform operators own backup/restore/transfer of mounted native data.
Meeting 59:36–1:00:25; [state ownership](../build-deploy/state.md). Retention itself remains available.

### Guaranteed automatic migration

**Status:** Not planned in NemoClaw.

**Scope:** A guaranteed migrator covering arbitrary Classic state, drift, resources, and native data.

**A guaranteed automatic migration of arbitrary Classic deployments, including drift and native data.**
Use export as input to an agent-assisted evaluation; no general adoption or conversion guarantee.
Meeting 5:12–9:23; [migration](migration.md).

### Classic CLI and API compatibility

**Status:** Not planned in NemoClaw.

**Scope:** Compatibility with the Classic imperative CLI and TypeScript lifecycle API.

**Compatible Classic imperative CLI and TypeScript lifecycle API.**
Use desired state and the Rust SDK/provider; no command/API compatibility promise.
[Migration task mapping](migration.md#map-the-user-task), [compatibility](../references/compatibility.md).

### Built-in policy approval UI

**Status:** Not planned in NemoClaw.

**Scope:** NemoClaw-owned interactive approvals, policy explanation, and the old preset interface.

**NemoClaw-owned interactive network approvals, policy explanation, and old named preset interface.**
OpenShell owns approval/explanation; declarative grants extend the isolated policy.
[#12651](https://github.com/NVIDIA/NemoClaw/issues/12651), [current security limits](../resources/limits.md#security).

### Historical shields interface

**Status:** Not planned in NemoClaw.

**Scope:** Restoration of the historical shields up/down and configuration-sealing interface.

**Historical shields up/down and configuration sealing.**
No commitment to restore that interface. Assess required protection through current OpenShell policy and native settings.
Meeting 59:36–1:00:25. Already absent from current-main implementation; historical retirement, not a newly lost current-main feature.

## Remaining Inventory Review

Resolve the specific gaps above before converting workshop completion labels into user-facing support claims.
Keep provider/channel choices and the enterprise workflow inventory explicit; this draft does not claim to enumerate every Classic capability.

## Review Sources and Maintenance

The planning source is the 17 November 2026 **V1 Transition - In/Coming/Out Matrix** meeting, especially 5:12–12:13, 24:30–59:36, and 1:00:36–1:11:40.
The [review spreadsheet](https://docs.google.com/spreadsheets/d/1owWSyW3HlRkflAqIVjZNLosqnsmnQI1UuRx1QHg9SWY/edit#gid=193000003) records decisions DL-043–DL-071, including explicit verification follow-ups.
The implementation links above qualify what users can rely on; meeting decisions describe intent.

For each update, record the inspected revision and move a row to available only after linking its bounded implementation and applicable qualification.
Keep component ownership changes separate from permanent feature removal, and preserve unresolved contradictions until the product decision is explicit.
