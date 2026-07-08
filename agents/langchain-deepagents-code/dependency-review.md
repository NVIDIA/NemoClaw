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

## Released Nemotron 3 Ultra Profile

Deep Agents Code `0.1.34` pins `deepagents==0.7.0a6`, whose official wheel
contains the Nemotron 3 Ultra harness profile merged in Deep Agents PR #4192.
NemoClaw no longer vendors or overlays that source.

- Native profile SHA-256: `c8e8dd2b0182334b54be4f46ff0c7b45fbb95dc13bd9a92c249eb47a14fa13d7`
- Unmodified built-in bootstrap SHA-256: `005a91e7fc4ca6b21220673dd9d02d6686bf63e1e4f1102d124b01f96886efcf`
- First-party adapter: `nemoclaw-deepagents-profile==0.1.0`
- Adapter module SHA-256: `691c07906ff2df0fdc6d4bcd6d9af2fe9c8d2640db30463cd4f79235912629b2`
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

Before local build and installation, the managed image verifies both copied
adapter build inputs against the module and project-metadata hashes recorded
above. It then installs the first-party `nemoclaw-deepagents-profile` package
without consulting an index. Its `deepagents.harness_profiles` entry
point runs after built-in profiles are registered, reads the reviewed canonical
profile through one exact-version/hash-gated private registry lookup, and uses
Deep Agents' public registration API to map it to the two exact `openai:` model
keys used by NemoClaw's managed OpenAI-compatible `ChatOpenAI` route. It layers
one first-party middleware onto those aliases that rejects only a trimmed,
case-insensitive `[content]` value passed as the complete `execute` command;
the canonical NVIDIA profile and unrelated models remain unchanged. The
released SDK has no public profile getter or alias API. The adapter does not add
a provider-wide OpenAI profile.

### Managed Ultra compatibility workarounds

Two localized behaviors close separate invalid states on the managed Ultra
aliases. They are not a new provider profile and do not modify the reviewed
canonical NVIDIA profile.

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

For the exact `[content]` guard, the invalid state is a model-produced tool call
whose complete `execute.command` is the literal placeholder (ignoring only outer
whitespace and case). The released Deep Agents parser/profile can carry that
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
Registration is atomic, idempotent, and rejects missing canonical, partial, or
conflicting alias state. The image validator runs under isolated Python,
verifies the installed entry-point metadata and adapter source hash before the
upstream source checks, checks both upstream files again after profile loading,
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
