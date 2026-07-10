<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# LangChain Deep Agents Code Dependency Review

This file records the reviewed dependency baseline for the Deep Agents Code sandbox base image.
Update it whenever `requirements.lock` changes.

- Lockfile: `agents/langchain-deepagents-code/requirements.lock`
- Lockfile SHA-256: `d8b01f36a0f325f38d18b4dc2cfdf452125987571a86ca58d9c93e08b7b06a14`
- Audit command: `uv tool run --python 3.13 pip-audit -r agents/langchain-deepagents-code/requirements.lock --progress-spinner off --disable-pip`
- Audit date: 2026-07-07
- Audit result: `No known vulnerabilities found`

The Dockerfile installs this lockfile with `pip3 install --require-hashes`, so this review covers the exact package versions selected for the managed image install.

## Managed `fetch_url` Proxy Adapter

Deep Agents Code `0.1.34` deliberately disables ambient proxies and resolves
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

Deep Agents Code `0.1.34` pins `deepagents==0.7.0a6`, whose official wheel
contains the Nemotron 3 Ultra harness profile merged in Deep Agents PR #4192.
NemoClaw no longer vendors or overlays that source.

- Native profile SHA-256: `c8e8dd2b0182334b54be4f46ff0c7b45fbb95dc13bd9a92c249eb47a14fa13d7`
- Unmodified built-in bootstrap SHA-256: `005a91e7fc4ca6b21220673dd9d02d6686bf63e1e4f1102d124b01f96886efcf`
- First-party adapter: `nemoclaw-deepagents-profile==0.1.0`
- Adapter module SHA-256: `1cee6afafcbe545f5d095c94cb0ad81ff2a1512f84ad9d128a69a9b3d72b3def`
- Adapter project metadata SHA-256: `7ba7b77bd6f889cc861eddbe3e38fc1f4433a85b7bc2a9b516e19a19a37a7686`
- Adapter wheel license expression: `Apache-2.0`
- Adapter dependency audit result: `No known vulnerabilities found`. Its only
  requirements are the exact `deepagents-code==0.1.34` and
  `deepagents==0.7.0a6` entries covered by the lockfile audit command above; no
  additional third-party distribution is introduced.

### Test-only legacy license fixture limitation

> **Removal condition:** Delete the test-only legacy license-table conversion in
> `test/langchain-deepagents-code-nemotron-profile-plugin.test.ts` as soon as the
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
config generator and the isolated Python image/plugin validators. Those
components run on opposite sides of the offline wheel-install boundary, so a
shared runtime data file would enlarge the installed trust surface solely to
deduplicate two immutable strings. The focused profile-plugin suite extracts
the identifiers from every production consumer and requires the exact sets to
match, preventing drift without adding another mutable build artifact.

For `force_nonempty_content`, the invalid state originates in the NVIDIA Ultra
chat template/serving path: a Chat Completions response that combines reasoning
and tool calls can otherwise carry empty assistant content. That response shape
is outside NemoClaw; this repository owns only the generated DCode provider
configuration, so `generate-config.ts` supplies the model-specific template
argument at that request boundary. Fixing the serving template, model, or
third-party client in this repository would require vendoring an upstream
component and would violate the released-dependency boundary. The focused config
tests prove both managed Ultra IDs receive the argument and unrelated models do
not; the Deep Agents E2E verifies the installed request shape. Remove this
argument only after a reviewed serving-template or client update produces
nonempty assistant content for reasoning-plus-tool-call turns without it, and
the live DCode Ultra E2E passes for both managed model IDs with the override
deleted.

For the `[content]` guard, the invalid state is a model-produced tool call whose
complete `execute.command` is the placeholder, ignoring case and whitespace
around the token and brackets. The released Deep Agents parser/profile can carry that
argument to normal tool middleware, where an unrestricted execute backend would
otherwise treat it as a shell command. The model/provider emission and the
hash-locked `deepagents==0.7.0a6` canonical profile are upstream boundaries;
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

Deep Agents Code `0.1.34` is the released consumer; prerelease risk is limited
to its exact `deepagents==0.7.0a6` SDK pin. That risk is accepted because the
consumer and SDK are hash locked, the dependency audit is clean, and all source,
version, middleware, graph, and dispatch contracts are enforced by the isolated
image-build validator. That validator is the fail-closed gate because Deep
Agents deliberately isolates and logs third-party plugin callback failures.

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
