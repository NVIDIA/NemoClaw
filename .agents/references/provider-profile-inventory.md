<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Provider profile inventory

Source baseline: `main` commit `42d2ae6938a5a22a307644168aa888506d69f96a`.
Acceptance owners: [#13345](https://github.com/NVIDIA/NemoClaw/issues/13345),
[#12940](https://github.com/NVIDIA/NemoClaw/issues/12940), and
[#12558](https://github.com/NVIDIA/NemoClaw/issues/12558).

Fresh native inference, messaging, search, MCP, and runtime-identity paths verify profiles before use.
Retained shared-route paths still depend on gateway catalog entries. They prevent a claim that every
supported selection works with an empty catalog. The OpenShell pin and selected-release execution
remain outside this inventory.

## Import and mutation contracts

[The CLI provider adapter](../../src/lib/adapters/openshell/provider-adapter-cli.ts) exports a profile
before importing it. A matching definition is reused; a conflicting definition blocks mutation.
Only a reported missing profile permits import, followed by export and contract verification.
An import or verification failure cannot establish successful setup.

The adapter remembers verified profiles per adapter instance and gateway target. After provider
creation or attachment, it re-exports a remembered profile. Drift, export failure, or timeout produces
a credential-free warning without changing the completed mutation's result. These separate commands
cannot prove an atomic bind. A new adapter has no verification history unless its caller establishes it.

Native inference also verifies provider identity and ownership receipts. A matching profile alone
does not authorize adoption of an existing provider. Ambiguous mutations require observation before
another mutation. Restart and rebuild verify recorded authority; they do not authorize automatic
migration of old shared-route sandboxes.

## Owned inference profiles

All fixed definitions below are in
[`managed-inference/provider-profiles/`](../../managed-inference/provider-profiles).
The filename is the profile ID followed by `.yaml`.

| Selection | Profile ID or generation rule | Import and create owner | Attach, repeat, collision, and tests |
| --- | --- | --- | --- |
| NVIDIA hosted (`nvidia-prod`) | `nemoclaw-nvidia-inference-v1` | [Native NVIDIA lifecycle](../../src/lib/inference/native-nvidia/index.ts) uses the [shared fixed lifecycle](../../src/lib/inference/native-provider/index.ts) before creating `nemoclaw-nvidia-prod-v1`. `credentials add nvidia-prod` uses this boundary too. | The lifecycle verifies the profile again before attachment. Repeat setup requires the recorded provider ID; profile or provider collisions block. [Lifecycle tests](../../src/lib/inference/native-nvidia.test.ts) cover ordering, reuse, collisions, failures, ambiguous creation, and attachment. |
| OpenAI | `nemoclaw-openai-inference-v1` | [Hosted setup](../../src/lib/inference/native-provider/setup.ts) imports through the fixed lifecycle before provider creation. | [Hosted tests](../../src/lib/inference/native-provider/hosted.test.ts) cover restricted definitions, ownership refusal, profile collision, uncertain creation, and attachment. The shared lifecycle verifies profiles before attach and checks provider IDs on reuse. |
| Anthropic | `nemoclaw-anthropic-inference-v1` | Same hosted setup and fixed lifecycle; credential `ANTHROPIC_API_KEY`. | Same lifecycle and hosted tests; the definition retains the Anthropic Messages boundary. |
| Gemini | `nemoclaw-gemini-inference-v1` | Same hosted setup and fixed lifecycle; credential `GEMINI_API_KEY`. | Same lifecycle and hosted tests; Gemini's OpenAI-compatible API remains distinct from its credential source. |
| OpenRouter | `nemoclaw-openrouter-inference-v1` | Same hosted setup and fixed lifecycle; credential `OPENROUTER_API_KEY`. | Same lifecycle and hosted tests. Normal setup selects this native path before the legacy OpenRouter runtime-adapter branch. |
| Hermes Provider | `nemoclaw-hermes-inference-v1`; an authenticated returned endpoint uses `nemoclaw-hermes-inference-<hash>-v1` | [Hosted definitions](../../src/lib/inference/native-provider/hosted.ts) hash the canonical endpoint with SHA-256, retaining 20 hex characters. [Hermes profile binding](../../src/lib/inference/native-provider/hermes-profile.ts) binds the checked-in template before the lifecycle imports it. | Default and recorded returned endpoints use native authority. Explicit custom Hermes endpoints retain the legacy route. [Hermes binding tests](../../src/lib/inference/native-provider/hermes-binding.test.ts) cover endpoint isolation and receipt validation. |
| Hosted custom OpenAI-compatible or Anthropic-compatible endpoint, including Bedrock | `nemoclaw-custom-<hash>-v1` | [Custom setup](../../src/lib/inference/native-provider/custom-setup.ts) admits the endpoint before importing a bound OpenAI or Anthropic template through the fixed lifecycle. [The ID](../../src/lib/inference/native-provider/custom.ts) uses 32 hex characters of SHA-256 over the canonical provider, endpoint, API, credential name, sorted IP pins, and optional Bedrock adapter endpoint. | Repeat setup preserves the recorded binding and credential without rotating it. A changed binding requires new authority. [Custom tests](../../src/lib/inference/native-provider/custom.test.ts) cover admission, import collision, reuse, ambiguous creation, attachment, and Bedrock credential custody. Existing shared-route sandboxes remain legacy until recreated. |
| Native host-local Ollama, standalone vLLM, llama.cpp, and eligible local compatible endpoints | `nemoclaw-local-<authMode>-v1-<hash>` | [Local profile generation](../../src/lib/inference/native-local/profile.ts) defines the restricted endpoint, methods, credential, and agent executables in code. [Identity generation](../../src/lib/inference/native-local/contract.ts) retains 24 hex SHA-256 characters over provider, applicable agent, endpoint, credential name, and auth mode. Gateway, sandbox, and optional transaction identify the provider instance separately. The [local lifecycle](../../src/lib/inference/native-provider/lifecycle.ts) imports before creation. | Applies to the eligible OpenClaw, Deep Agents Code, Hermes, and Pi paths in [eligibility](../../src/lib/inference/native-local/eligibility.ts). Attachment inspects the generated contract and recorded provider ID. Repeat setup checks authority; collisions block. [Local tests](../../src/lib/inference/native-local.test.ts) cover generation, ordering, collisions, reuse, ambiguous creation, scope denial, and cleanup. Post-attach warning coverage remains a separate gap below. |

## Credential, messaging, and runtime profiles

| Path and profile ID | Definition or operator contract | Import, create, and attach points | Repeat, collision, and evidence |
| --- | --- | --- | --- |
| Search: `brave`, `tavily`, `tavily-hermes-v1` | Corresponding YAML files in [blueprint provider profiles](../../nemoclaw-blueprint/provider-profiles); agent selection owns Tavily's executable boundary. | [Messaging application](../../src/lib/messaging/applier/provider-application.ts) resolves the owned file. [The applier](../../src/lib/messaging/applier/openshell-provider.ts) prepares profiles before creation and attachment. [Credentials add](../../src/lib/actions/credentials-add.ts) imports bundled profiles before registration. | Matching profiles are reused; mismatches block. [Applier tests](../../src/lib/messaging/applier/openshell-provider.test.ts), [application tests](../../src/lib/messaging/applier/provider-application.test.ts), and [credential tests](../../src/lib/actions/credentials-provider-adapter.test.ts) cover the shared boundaries. |
| Langfuse: `langfuse-hermes-v1` | [Bundled endpointless definition](../../nemoclaw-blueprint/provider-profiles/langfuse-hermes-v1.yaml). | Credentials add imports before registration. [Sandbox publication](../../src/lib/onboard/sandbox-create/provider-publication.ts) verifies it before binding an extra provider during creation or rebuild. | #13356 added this extra-provider verification. [Publication tests](../../src/lib/onboard/sandbox-create/provider-publication.test.ts) cover verification, conflict rejection, recovery guidance, and cleanup. |
| Messaging and MCP: `nemoclaw-mcp-v1` | [Bundled endpointless definition](../../nemoclaw-blueprint/provider-profiles/nemoclaw-mcp-v1.yaml). | Messaging applier and credentials add import before creation. [MCP mutation](../../src/lib/actions/sandbox/mcp-bridge-provider-mutation.ts) ensures the profile before registration; [MCP attachment](../../src/lib/actions/sandbox/mcp-bridge-provider-attachments.ts) binds the provider. Sandbox publication verifies direct-create attachments. | Repeat setup checks declared credential bindings. Unowned or missing messaging types fail before mutation. [MCP profile tests](../../src/lib/actions/sandbox/mcp-bridge-provider-profile.test.ts), application tests, and publication tests cover these boundaries. |
| Google Chat: `google-chat-bridge`, `google-chat-hermes-bridge` | [OpenClaw definition](../../src/lib/messaging/channels/googlechat/provider-profile/openclaw.yaml) and [Hermes definition](../../src/lib/messaging/channels/googlechat/provider-profile/hermes.yaml). | Messaging profile discovery supplies the agent-specific file to the applier. The applier imports before creation and attachment; direct sandbox publication rechecks known bridge types. | Matching definitions are reused; conflicts block. [Bridge discovery tests](../../src/lib/onboard/messaging-bridge-provider.test.ts), applier tests, and publication tests cover the common path. |
| Discord on Hermes: `discord-hermes-static-v1` | [Hermes definition](../../src/lib/messaging/channels/discord/provider-profile/hermes.yaml). | Same bridge discovery, messaging applier, and sandbox-publication path. | Same matching-profile and collision contract. Bridge discovery and applier tests cover the shared mechanism. |
| Hermes tool gateway: `nemoclaw-hermes-tool-gateway-v1` | [Host broker profile](../../agents/hermes/host/nemoclaw-hermes-tool-gateway-v1.yaml). | [Broker inspection](../../src/lib/hermes-tool-gateway-broker.ts) imports through [the shared resolver](../../src/lib/hermes-tool-gateway-provider-profile.ts) before its `upsertProvider` call. Sandbox publication uses that resolver before binding. | An existing `generic` provider is reused only with the former non-secret credential-only binding; it cannot authorize a new `generic` create. [Resolver tests](../../src/lib/hermes-tool-gateway-provider-profile.test.ts), [broker tests](../../test/agents/hermes/hermes-tool-gateway-broker.test.ts), and publication tests cover the boundary. #13196 is complete. |
| Additional NVIDIA credentials using the native profile | `nemoclaw-nvidia-inference-v1`, with a separately named provider. | Credentials add imports the owned definition. Sandbox publication identifies the provider by its observed type and verifies the profile before direct create or rebuild (#13356). | Publication tests cover conflicts and known-owned type resolution. A separate `--type nvidia` operator-catalog provider is a different contract below. |
| Operator-supplied `credentials add --type <type>` | The operator supplies the gateway catalog definition. A non-bundled ID is never imported as NemoClaw-owned. | Credentials add calls `inspectProviderProfile` before creation, including declared credential-name checks or `from-existing` inspection. | Missing, unreadable, or incompatible profiles stop registration. [Adapter tests](../../src/lib/adapters/openshell/provider-adapter-cli-profile-warning.test.ts) cover refusal and post-mutation warnings. #13343 / merged #13353 establish this supported catalog dependency. `--type nvidia` on another name uses `NVIDIA_API_KEY`; pending #13556 only improves its diagnostic. |
| Runtime identity: `okta-runtime-v1`, `entra-runtime-v1`, or a reviewed configured ID | [Okta](../../nemoclaw-blueprint/provider-profiles/okta-runtime-v1.yaml) and [Entra](../../nemoclaw-blueprint/provider-profiles/entra-runtime-v1.yaml) are reference templates. The configured `profile_path` and trust policy own the actual definition. | [Runtime identity](../../nemoclaw/src/blueprint/runtime-identity.ts) validates a private snapshot, imports and exports it, then creates/configures the provider and attaches it. | Matching profiles and owned attachments are reused; conflicts stop before identity mutation. [Runtime identity tests](../../nemoclaw/src/blueprint/runtime-identity.test.ts) cover import, timeout, collision, changed source bytes, credential isolation, attachment, advisory warnings, and cleanup. Arbitrary operator definitions are not bundled profiles. |

## Every production `upsertProvider` create caller

The shared [helper](../../src/lib/onboard/providers.ts) can create without importing a profile.
Its call sites require caller-specific classification. An update of an existing provider is not
evidence that its create branch works with an empty catalog.

| Caller | Classification and reachable behavior |
| --- | --- |
| [setup-inference.ts](../../src/lib/onboard/setup-inference.ts): gateway binding and selected-provider wrapper | Supported dispatcher. Fixed hosted and custom hosted selections use their native lifecycle. `selectedUpsertProvider` intercepts eligible local selections with `prepareNativeLocalSelection`; retained selections can still reach the raw helper. |
| [credential-provider-registration.ts](../../src/lib/onboard/credential-provider-registration.ts) | Supported forwarding wrapper, not an independent profile owner. Messaging registration now uses the typed applier with owned definitions; remaining inference callers inherit their selection's classification. |
| [remote.ts](../../src/lib/onboard/inference-providers/remote.ts) | Native local selections use the intercepted upsert. Fresh native hosted selections return before this branch. Remaining custom and compatible shared routes are legacy pending their own migration or retirement. |
| [ollama-local.ts](../../src/lib/onboard/inference-providers/ollama-local.ts) | Supported native selections are intercepted before the raw create. Retained legacy selections remain catalog-dependent (`openai`). |
| [vllm-local.ts](../../src/lib/onboard/inference-providers/vllm-local.ts) | Standalone native vLLM is intercepted. Local NIM is deliberately excluded and retains the shared route, owned by #13116 and #12975. It still depends on `openai`. |
| [bedrock-runtime.ts](../../src/lib/onboard/bedrock-runtime.ts) | Legacy pending retirement for existing shared-route custom sandboxes. Fresh hosted Bedrock uses native custom setup, including a profile check before adapter startup. The leaf `openai` upsert is not evidence of a fresh native gap. |
| [openrouter-runtime.ts](../../src/lib/onboard/openrouter-runtime.ts) | Legacy runtime-adapter branch. The fixed hosted OpenRouter selection returns through native setup first. The retained branch uses catalog type `openai`. |
| [routed-inference.ts](../../src/lib/onboard/routed-inference.ts) | Retained Model Router route, pending native migration or retirement under #12558. It can create `nvidia-router` with catalog type `openai`; it has no owned import here. Profile ownership remains unresolved under #12940. |
| [compatible-endpoint-gateway-route.ts](../../src/lib/onboard/inference-providers/compatible-endpoint-gateway-route.ts) | Legacy recovered-provider URL repair. It first checks that the provider exists; a later disappearance can still expose the helper's create branch. No owned profile import is established by this wrapper. |
| [hermes-provider-auth.ts](../../src/lib/hermes-provider-auth.ts) | Native Hermes setup injects a native credential registrar. The fallback `openai` create remains for explicit custom Hermes endpoints and legacy rebuilds without a native receipt. These are retained legacy catalog paths. |
| [hermes-tool-gateway-broker.ts](../../src/lib/hermes-tool-gateway-broker.ts) | Supported owned-profile create, imported before upsert. Exact legacy `generic` reuse passes `knownExists: true`; it does not create a new unowned profile. |
| [experimental Hermes portable transaction](../../src/lib/onboard/experimental/hermes-portable-ollama-gateway-transaction.ts) | Outside #12940's supported provider setup. This object method implements its own experimental journaled gateway transaction; it is not a call to the shared helper. Its `openai` catalog dependency remains unqualified. |

Retained catalog dependencies above are not import-only completion evidence. #12558's route retirement
must wait for every retained selection; #12940 must resolve profile ownership for any path that remains
supported on the selected release. Do not import broad `openai`, `anthropic`, `nvidia`, or `generic`
profiles to hide those decisions.

## Reconcile the earlier inventory

The [#12940 inventory](https://github.com/NVIDIA/NemoClaw/issues/12940#issuecomment-6149986823)
used commit `19d994a0086c59e945a2456b1264ca1444a37fc7`.

- Custom hosted #12889 closed without merge; #13201 supplies the merged implementation.
- Deep Agents Code #13203, OpenClaw #13293, Pi #13007, and Hermes #13292 are merged.
  Their profile generation and agent eligibility are now part of the baseline. Merge alone does not
  establish selected-release runtime qualification.
- #13356 verifies owned Langfuse and separately named native NVIDIA providers before sandbox creation.
- Messaging's unowned `generic` fallback is rejected by merged #13351, resolving #13344.
- Operator credential-profile inspection is established by merged #13353, resolving #13343.
- [Token rotation](../../src/lib/sandbox/config-rotate-token.ts) now calls only `provider update`.
  A failed or missing-provider update stops before host credential persistence; it never recreates a provider.
  [The CLI regression](../../test/cli/config-rotate-token-update-only.test.ts) covers the failure boundary.
- The [extra-provider E2E fixture](../../test/e2e/fixtures/provider-profiles/nemoclaw-e2e-extra-provider-v1.yaml)
  imports its test-owned profile; [fixture tests](../../test/e2e/support/gateway-extra-provider-profile.test.ts)
  cover reuse, collision, failures, and credential isolation (#13136).
- The direct inference branch in [the experimental blueprint runner](../../nemoclaw/src/blueprint/runner.ts)
  retains its recorded separate disposition and catalog dependency. Runtime identity uses its separate verified path.
- Pending #13528 owns Personal-tier custom routing; pending #13556 owns credential mismatch diagnostics.
  Their proposed behavior is absent from this baseline. #13504 owns native-provider authority cleanup.

## Warning evidence and focused follow-up

[Adapter warning tests](../../src/lib/adapters/openshell/provider-adapter-cli-profile-warning.test.ts)
cover successful creation, attachment, and direct sandbox-create bindings after prior verification.
They include profile drift, export failure, timeout, credential-free output, and preserved success.
[Publication tests](../../src/lib/onboard/sandbox-create/provider-publication.test.ts) also ensure resumed
creation does not claim original bind-time verification. Runtime-identity tests independently cover
post-create and post-attach warnings.

Native local attachment has a missing advisory boundary. `checkedAttachment()` in
[`native-local/profile.ts`](../../src/lib/inference/native-local/profile.ts) validates `expectedProfile`
through `inspectProviderProfile()`. That inspection does not remember the verified contract for later
warnings. With a fresh adapter, a successful attach therefore has no post-attach export or warning.
Pre-attachment collisions still block. Generic adapter warning tests do not prove this caller's behavior.

[Focused repair #13557](https://github.com/NVIDIA/NemoClaw/issues/13557) owns this gap.
A disposable regression on the baseline failed in both drift and timeout cases: attachment succeeded,
but the warning callback received zero calls. The temporary test was removed; it is not committed coverage.
The repair must retain failing regressions first, then carry the verified contract into the adapter's
post-attachment check in a separate PR linked to #13345 and #12940. Assert credential-free warnings and
unchanged success. Keep pre-mutation rejection and matching-profile silence. Selected-release execution
remains #13346.

## Representative selected-release qualification

Decision: Deepak Jain selects the native NVIDIA hosted path, `nemoclaw-nvidia-inference-v1`.
Reason: it has a checked-in definition and focused lifecycle tests for creation, reuse, collision, and attachment.
Placement: this inventory records the selection; [#13346](https://github.com/NVIDIA/NemoClaw/issues/13346)
owns execution and cleanup.
Accountable maintainer: Deepak Jain (@deepujain).

Validation plan: use one disposable empty catalog on the selected target OpenShell release. Record the
binary or image identity, NemoClaw commit, gateway, sandbox, and run link. Prove import before create
and attach, matching-profile reuse, and collision refusal before provider or sandbox mutation.
Record terminal provider, profile, sandbox, and gateway cleanup, or an owned recovery issue.
Keep credential values out of commands and artifacts. Do not change the repository pin.

Selected-release execution and cleanup are unverified here. Existing lifecycle and adapter tests are
focused code evidence; they do not replace the #13346 run.
