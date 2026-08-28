<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# LangChain Deep Agents Code Dependency Review

This file records the reviewed dependency baseline for the Deep Agents Code sandbox base image.
Update it whenever `requirements.lock` changes.

- Lockfile: `agents/langchain-deepagents-code/requirements.lock`
- Lockfile SHA-256: `203eeeb3786c736423be60ce2b315ad6f817d4adf0c13de184bf5deee4c793ad`
- Audit command: `uv tool run --python 3.13 pip-audit -r agents/langchain-deepagents-code/requirements.lock --progress-spinner off --disable-pip`
- Audit date: August 11, 2026
- Targeted audit result: `aiohttp 3.14.3, cryptography 50.0.0, uv 0.11.33, langgraph-checkpoint-sqlite 3.1.1, MCP 1.28.1, Pillow 12.3.0, and pyasn1 0.6.4 have no known vulnerabilities`
- Complete-lock audit result: `2 duplicate records in 1 unrelated package`

The Dockerfile installs this lockfile with `pip3 install --require-hashes`, so this review covers the exact package versions selected for the managed image install.
The lock now selects `aiohttp==3.14.3`, `cryptography==50.0.0`, `uv==0.11.33`, `langgraph-checkpoint-sqlite==3.1.1`, `mcp==1.28.1`, `Pillow==12.3.0`, and `pyasn1==0.6.4`.
These selections clear `GHSA-cq5v-8q36-5273`, `GHSA-g6cj-pr64-35w5`, and `GHSA-47pj-3jcm-6whg`.
The direct `langgraph-checkpoint-sqlite==3.1.1` requirement is a hash-locked security constraint for `GHSA-47pj-3jcm-6whg`.
Remove it when the selected Deep Agents Code graph resolves `3.1.1` or later without the direct constraint and the complete-lock audit remains clear.
The Deep Agents Code selector is the published `0.1.55` release at commit
`80fe3d3cbcd23b8ebbc2b1b0d67d7ea318d11ef6`. Its reviewed wheel is
`deepagents_code-0.1.55-py3-none-any.whl` with SHA-256
`3a0d3e332f132d0e910fb3cccb47f77d276e228b6df6e5f7bff08809aa163121`;
the corresponding source archive has SHA-256
`91c30b62cb96d5e803346b0d77e55d589ac1daa04b6c534f80384ceec2717c11`.
This semantic migration through `0.1.55` crosses the MCP and pyasn1 fixes while retaining the
managed hook, approval, credential, update, and startup-mode guards at the
NemoClaw launcher and exact-version package-patch boundaries.

The image build runs `pip3 check` and asserts all eight installed package versions, including Deep Agents Code itself, before publishing.
The complete point-in-time audit now reports only two duplicate database records for `setuptools==82.0.1`; that record is outside the Critical/High remediation scope.
This review does not claim the complete lock is vulnerability-free.

## Progressive MCP Tool Catalog Compatibility

Deep Agents Code `0.1.55` with LangChain `1.3.14` can supply `search_tools` with a `ToolRuntime.tools` view that omits loaded MCP tools.
The next model request can still expose those tools, but a search against only the middleware runtime view reports no match and cannot disclose them.

NemoClaw owns the progressive-disclosure middleware injection at graph construction.
The main-agent middleware retains the parent graph's registered tool tuple.
A declarative local subagent that defines `tools` retains that catalog, including an explicit empty list.
A declarative local subagent that omits `tools` inherits the parent graph's catalog.
An explicit subagent catalog therefore cannot search or expose a parent-only tool.
At search time, the middleware combines that tuple with `ToolRuntime.tools` by object identity and applies the existing name, result, state, and schema limits to the combined catalog.
Model requests still use their request-time tool view, and the existing callable-name validation still rejects ambiguous or reserved owners before graph construction.

Deep Agents Code `0.1.55` also derives MCP approval from protocol annotations.
Its headless guard permits an MCP call without an approval UI only when `readOnlyHint` is literally `true`, `destructiveHint` is not `true`, and every supplied standard hint has a Boolean value.
The guard rejects unannotated, malformed, contradictory, or mutating tools instead of treating them as read-only.
NemoClaw retains that fail-closed behavior.

The live E2E `fake_echo` and `fake_status` tools perform only read-only proof and status operations, so their `tools/list` definitions declare `readOnlyHint: true`.
The compatible-model fixture reports a search failure only when the `search_tools` result omits the target.
After a valid search, the fixture reports a rejected or incorrect target result as an invocation failure.

The focused fixture and installed-image validator give `search_tools` a runtime view that contains only itself.
They require a registered hidden MCP tool to appear in the search response and in the next model tool list.
The focused fixture also assigns separate tools to the parent and one subagent.
It requires an omitted subagent catalog to inherit the parent tool and an explicit subagent catalog to retain only the subagent tool.
The same fixture requires the subagent tool to remain searchable and to appear in the next model request when `ToolRuntime.tools` contains only `search_tools`.
The live Deep Agents MCP E2E test separately requires the tool to be hidden initially, returned by `search_tools`, exposed on the next model request, and invoked through the authenticated managed MCP path.
Remove the retained catalog only after the pinned Deep Agents and LangChain runtime supplies every registered searchable tool to middleware calls and both evidence paths pass without it.

## Deterministic Read-Only MCP Invocation

Deep Agents Code `0.1.55` can expose MCP tools to a model, but it has no public
command that deterministically invokes one tool. Prompting a model to discover
or call an exact task-context tool does not prove that the call occurred, even
when the headless process exits successfully.

NemoClaw adds `dcode tools call-read-only TOOL --json` at the managed wrapper
and exact-version compatibility boundary. The command uses the released DCode
MCP configuration, loader, wrapped executor, protocol metadata, and session
manager. It selects one exact resolved name and invokes it only when DCode marks
it as an MCP tool and its protocol annotations are coherently read-only. It
does not expose a mutating tool command or ask a model to choose the call.

The command accepts one bounded JSON object on standard input. It returns one
JSON envelope of at most 131,072 bytes, followed by one newline delimiter, so
standard output is at most 131,073 bytes. It rejects oversized nested results
before serialization, redacts recognized credential shapes, preserves the MCP
`structuredContent` object under `structured_content`, and suppresses child
diagnostics on standard error. Fixed, content-free errors cover unavailable,
ambiguous, unsafe, failed, malformed, oversized, and timed-out calls. A fixed
deadline covers discovery, invocation, and session cleanup.

The installed-image validator runs the patched DCode process in progressive
mode against a local TLS Streamable HTTP server from the installed MCP SDK. It
requires one exact invocation and exact nested output-attestation fidelity. It
also rejects missing, duplicate, unannotated, malformed, mutating, failed, and
oversized cases, and proves that a hanging tool exits with the fixed timeout
result. Remove this command when a pinned Deep Agents Code release provides an
equivalent deterministic read-only MCP command and the same installed-image
validation passes through that upstream path.

## Managed `fetch_url` Proxy Adapter

Deep Agents Code `0.1.55` deliberately disables ambient proxies and resolves
destination DNS locally before pinning the address used by `fetch_url`. That is
the wrong transport inside a NemoClaw-managed sandbox: ordinary egress and
destination resolution must pass through the policy proxy, so the direct path
fails even when the same approved URL works through the managed route.

NemoClaw owns the managed image, launchers, and policy boundary, but not the
hash-locked third-party `fetch_url` implementation. The exact-version build
patch therefore delegates only managed launches to a proxy URL independently
derived from the image's root-owned host and port files. The runtime rejects a
missing, unsafe, or mismatched file/environment contract, disables Requests'
ambient proxy, `NO_PROXY`, netrc, and CA discovery, and supplies the verified
proxy explicitly on every redirect hop. It separately validates the fixed,
root-owned CA-bundle mount injected into the sandbox and passes it as explicit
TLS transport trust; that bundle cannot select a proxy or authorize a
destination. Imports outside the managed launcher retain the upstream direct
DNS-pinning behavior.

Redirect validation rejects authority userinfo (`user:password@host`). It does
not treat `@` or `:` in a path segment as credentials: RFC 3986 defines those
characters as ordinary path data, and coding tasks can legitimately encounter
them in repository refs or filenames. Focused redirect coverage pins that
distinction, while validation errors avoid echoing candidate URLs and the
policy proxy remains authoritative for every destination.

Focused tests patch the released wheel, exercise managed and unmanaged paths,
reject forged proxy environments and malformed redirects, and prove that
credential-bearing URLs are not reflected. The live Deep Agents Code egress
check requires a nonempty 2xx response from an approved raw GitHub URL and
denial for an unapproved host, cloud metadata, and loopback. Remove this adapter
rather than refreshing it when a pinned Deep Agents Code release exposes a
supported policy-proxy transport with equivalent redirect and fail-closed
behavior.

## Released Nemotron 3 Ultra Profile

Deep Agents Code `0.1.55` pins `deepagents==0.7.5`, whose official wheel
contains the Nemotron 3 Ultra harness profile merged in Deep Agents PR #4192.
NemoClaw no longer vendors or overlays that source.

- Native profile SHA-256: `3b95b118e90c4ae19890c611cc7e1e85261217f971496e9bb7508142133c7d9a`
- Unmodified built-in bootstrap SHA-256: `005a91e7fc4ca6b21220673dd9d02d6686bf63e1e4f1102d124b01f96886efcf`
- First-party adapter: `nemoclaw-deepagents-profile==0.1.0`
- Adapter module SHA-256: `6bb8dc8108c5dd7e7f71c39aacfb0da07d285b7a324eecd691177a9ca460cfc0`
- Adapter project metadata SHA-256: `7be3f7972d7cd78d3ddaf66e2ff8b07a5e6af3611034b956cf0475ba78f5a576`
- Adapter wheel license expression: `Apache-2.0`
- Adapter dependency audit result: `No known vulnerabilities found`. Its only
  requirements are the exact `deepagents-code==0.1.55` and
  `deepagents==0.7.5` entries covered by the lockfile audit command above; no
  additional third-party distribution is introduced.

### Test-only legacy license fixture limitation

> **Removal condition:** Delete the test-only legacy license-table conversion in
> `test/agents/deepagents/langchain-deepagents-code-nemotron-profile-plugin.test.ts` as soon as the
> runner's system setuptools accepts PEP 639 license strings. Production never
> uses this conversion.

The adapter metadata intentionally uses the PEP 639 SPDX expression
`license = "Apache-2.0"`, supported by its pinned production build backend.
The real-wheel test substitutes the equivalent legacy table only for its
offline, no-isolation wrong-version fixture with the runner's older system
setuptools; this is a known fixture limitation, not production metadata. The
production image builds the unchanged project with lock-pinned
`setuptools==82.0.1`, and its isolated validator fails closed unless the
installed wheel exposes `License-Expression: Apache-2.0`.

The adapter is a private, first-party build-context package: NemoClaw does not
publish it to a registry or resolve it from an index. The image verifies its
reviewed source and project-metadata hashes, then builds it offline with
`--no-index --no-deps --no-build-isolation`. There is therefore no separate
published distribution for a registry audit to resolve. If that packaging
boundary ever changes, the publishing workflow must build and audit the wheel
before upload; index publication is not permitted without that release gate.

The adapter project remains recoverable from the image's `COPY` layer after the
later `RUN` removes its duplicate build tree; a failed build may likewise retain
that layer in the trusted local cache. This is accepted because the project
contains only non-secret, first-party Apache-2.0 source and metadata, and the
installed Python module necessarily ships the same source in `site-packages`.
A multi-stage build or secret mount would not make the shipped module
confidential. Revisit this boundary if an adapter build input becomes
secret-bearing or non-public.

Before local build and installation, the managed image verifies that the build
tree contains exactly the two individually copied adapter inputs, then checks
both against the module and project-metadata hashes recorded above. Extra files
cannot enter the wheel through the Docker build context. It then installs the
first-party `nemoclaw-deepagents-profile` package
without consulting an index. Its `deepagents.harness_profiles` entry
point runs after built-in profiles are registered, reads the reviewed canonical
profile through one exact-version/hash-gated private registry lookup, and uses
Deep Agents' public registration API to map it to the two exact `openai:` model
keys used by NemoClaw's managed OpenAI-compatible `ChatOpenAI` route. It layers
one first-party middleware onto those aliases that rejects only a
case-insensitive `[content]` value, with optional whitespace around the token
and brackets, passed as the complete `execute` command;
the canonical NVIDIA profile and unrelated models remain unchanged. The
released SDK has no public profile getter or alias API. The adapter does not add
a provider-wide OpenAI profile.

### Managed Ultra compatibility workarounds

Two localized behaviors close separate invalid states on the managed Ultra
aliases. They are not a new provider profile and do not modify the reviewed
canonical NVIDIA profile.

The two managed model IDs remain language-local constants in the TypeScript
config generator, the managed package patch, and the isolated Python
image/plugin validators. NemoClaw
registers both IDs under the managed OpenAI adapter and the managed OpenRouter
adapter because Deep Agents Code applies provider-native request shaping before
it reaches the shared `inference.local` route. Those components run on opposite
sides of the offline wheel-install boundary, so a shared runtime data file would
enlarge the installed trust surface solely to deduplicate two immutable strings.
The focused profile-plugin suite extracts the identifiers from every production
consumer and requires the exact sets to match, preventing drift without adding
another mutable build artifact.

For `force_nonempty_content`, the invalid state originates in the NVIDIA Ultra
chat template/serving path: a Chat Completions response that combines reasoning
and tool calls can otherwise carry empty assistant content. That response shape
is outside NemoClaw; this repository owns the generated DCode provider
configuration and the managed package patch, so each supplies the model-specific
template argument at its own boundary. `generate-config.ts` writes the per-model
`config.toml` entry. The patched `_get_provider_kwargs` resolver derives the
same argument from its language-local ID set because it never consumes the
mutable `config.toml` params table (#7441). Fixing the serving template, model,
or third-party client in this repository would require vendoring an upstream
component and would violate the released-dependency boundary. The focused config
tests verify that both managed Ultra IDs receive the argument and unrelated
models do not. The focused managed-model-params patch test verifies that the
managed provider resolver supplies it only for those IDs, and the Deep Agents
E2E test verifies the installed request settings.
Remove this argument only after a reviewed serving-template or client update
produces nonempty assistant content for reasoning-plus-tool-call turns without
it, and the live DCode Ultra E2E passes for both managed model IDs with both
supply points deleted.

For the `[content]` guard, the invalid state is a model-produced tool call whose
complete `execute.command` is the placeholder, ignoring case and whitespace
around the token and brackets. The released Deep Agents parser/profile can carry that
argument to normal tool middleware, where an unrestricted execute backend would
otherwise treat it as a shell command. The model/provider emission and the
hash-locked `deepagents==0.7.5` canonical profile are upstream boundaries;
NemoClaw owns the two managed aliases and the final middleware immediately before
dispatch. The adapter therefore rejects only that observed complete argument and
leaves concrete commands, other tools, the canonical NVIDIA profile, and
unrelated models unchanged. Focused fixture tests plus the isolated image
validator cover sync and async rejection, concrete and non-execute pass-through,
and graph dispatch with shell restrictions disabled; the Deep Agents E2E repeats
the installed guard contract. Remove the guard only after a reviewed model,
serving-template, and Deep Agents update no longer emits or converts `[content]`
into an execute call across native and repaired tool-call paths, and those tests
plus the live DCode Ultra E2E pass with the middleware removed.

The adapter verifies the exact DCode and Deep Agents versions plus the official
native-profile and bootstrap source hashes. It also binds the imported Deep
Agents package to the distribution that supplied the reviewed version.
Registration uses the Deep Agents registry itself as its only idempotency
source, serializes the multi-key transaction for concurrent plugin discovery
within one Python interpreter, and rejects missing canonical, partial, or
conflicting alias state. The Deep Agents registry is process-local, so separate
agent processes have separate registries and cannot interleave writes; a
filesystem lock would not protect shared state. Revisit that assumption if an
upstream release moves the registry out of process. The image validator runs
under isolated Python, verifies the installed entry-point metadata and adapter
source hash before the upstream source checks, checks both upstream files again
after profile loading,
resolves the complete native middleware plus the managed guard for both aliases,
proves the canonical middleware remains unchanged, compiles a graph, exercises
sync and async placeholder rejection, proves concrete-command and parser/native
dispatch parity through the actual graph, and confirms an unrelated OpenAI model
receives no Ultra behavior. The Docker build separately imports the adapter,
Deep Agents, and DCode under isolated Python immediately after installation;
the validator then binds the installed module to its distribution and rechecks
the module hash. A DCode-only CI regression builds the current, hash-locked
`Dockerfile.base` instead of consuming a mutable registry tag, strips both
upstream distributions, and proves the production build stops at that import
gate before the later dependency-consistency check. The targeted E2E job invokes
`scripts/check-dcode-profile-import-gate.sh` with real Docker before live tests;
the fake-Docker unit suite separately pins its diagnostic failure branches.

The reviewed native-profile and bootstrap files stay byte-for-byte unchanged.
Focused fixtures cover the reviewed version/hash, missing-source,
missing-canonical, partial/conflicting, rollback, idempotence, exact placeholder
rejection, and unchanged concrete-command states. The
deleted source-backport license path, `LICENSE.langchain-deepagents`, is not
staged into the image, and image regression tests enforce that absence.

Deep Agents Code `0.1.55` is the released consumer; prerelease risk is limited
to its exact `deepagents==0.7.5` SDK pin. That risk is accepted because the
consumer and SDK are hash locked and all source, version, middleware, graph,
and dispatch contracts are enforced by the isolated image-build validator.
Separately, the point-in-time audit reports no known vulnerabilities for
Pillow `12.3.0`. The validator is the fail-closed gate because Deep Agents
deliberately isolates and logs third-party plugin callback failures.

The exact version and source-hash gates remain the executable lifecycle check
for the alias adapter: any dependency change stops the image build and requires
this review to revalidate the managed adapter. Remove it instead of refreshing
its hashes only if a future reviewed dependency already provides both exact
mappings; no external contribution is required. Issue #6424 records the
NemoClaw-owned replacement of the previous installed-bootstrap mutation.

## Managed observability and ordered policy cleanup

The managed observability marker closes a sandbox lifecycle gap rather than an
authorization gap. OpenShell policy replacement can clear ephemeral `/tmp`, and
independent sandbox exec/login processes do not inherit the entrypoint's
environment, while the host registry and the active OTLP network policy remain
enabled. OpenShell owns those lifecycle semantics; NemoClaw owns the DCode
startup and launcher boundary but does not modify OpenShell here. Create,
rebuild, and snapshot-clone paths pass an explicit `1` or `0`; an environment-
less policy restart preserves the validated durable state. The startup script
writes only the credential-free enable bit to persistent
`/sandbox/.deepagents/.nemoclaw-observability-enabled`. The launcher accepts
only a non-symlink regular marker containing exactly `1`, and the network policy
remains the authority for OTLP access.

Focused launcher fixtures delete unrelated ephemeral state and prove the marker
survives, reject unsafe directory and marker types, and cover enabled and
disabled values. The ordered live checks prove Tavily removal restores the
deny-by-default policy while check 11 independently requires the host registry,
live policy, and durable sandbox marker to agree. Remove this marker and its
launcher recovery only when OpenShell propagates the selected observability bit
to every exec/login process across policy replacement, or when DCode no longer
needs the bit.

Tavily cleanup persists across sandbox rebuilds because `policy-remove` first
applies the narrowed live policy and then removes the preset from the sandbox's
registry-backed policy list, which is the source used by rebuild. The
`policy-add-remove-session-sync` tests cover successful persisted removal, and
the snapshot regression `does not resurrect an earlier removed preset` guards
restore behavior. The E2E EXIT trap is still required for early probe failures
so the ordered suite cannot leave the current sandbox broader than the registry.
Remove that trap only when each check receives an isolated sandbox or no longer
mutates policy.
