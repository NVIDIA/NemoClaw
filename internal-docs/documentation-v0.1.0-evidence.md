<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Configs v0.1.0 Documentation Handoff

This documentation candidate starts at `4044274395279f5d0d2852a5e31290df3708bc87`. That is the authoring base, not the final release tag commit. The earlier tutorial revisions `1636069b91f402242a35714fde1011042c3f1f70` and `637bdb6276309ea71d1f1fcb68fff518fe2db926` are historical pins, not substitutes for release evidence.

## Sources and Reader Paths

| Public Section | Changed Path and Evidence |
|---|---|
| About | Overview starts with the release workflow. Architecture separates reconciliation from serving an agent request, following `crates/nemoclaw-sdk/src/deployment/mod.rs` and `compile.rs`. The canonical changelog entry stays in place; its existing filename does not establish the publication date. |
| Getting Started | Archive layout and checksum names follow `.github/scripts/pack-cli-bundles.sh`; signing evidence and release verification follow `record-cli-signing.sh` and `.github/workflows/release.yml`. The OpenClaw exercise follows `examples/openclaw.yaml`, CLI `args.rs`, `dispatch.rs`, `formatting.rs`, and the SDK's `OperationResult`. The release example and image must be checked against the final tag. |
| Getting Started: Onboarding and NemoClaw v0 Evaluation | `crates/nemoclaw-onboarding/src/lib.rs`, its TUI and tests, and the CLI dispatch distinguish a fresh authoring file from deployment state, and unverified checks from reported conflicts. NemoClaw v0 evaluation uses separate identity, state, endpoints, and tools. It does not migrate native data. |
| Building and Deploying | SDK `config/types.rs`, `compile.rs`, and `deployment/{plan,reporting}.rs` establish sandbox quantity strings, image checks, and deferred versus advisory checks. The maintenance path connects replacements, retained state, and teardown. Release packaging establishes provider mirror locations; Kubernetes uses the index digest and release metadata as a pair. |
| Agents and Inference | `versions.json` records the inspected OpenShell revision `ce58cf8e9b953281352d98a637e41616295b1318`; the reader takes the runtime version from the release pin. The OpenClaw Fabric adapter at `76bde16c40747062001bd6ea5f5d13cadab3d706`, `formatting.rs`, and the native access guides establish the request and result boundary. The inference guide distinguishes external endpoints from owned service resources and retained data. |
| Observability and Security | The troubleshooting guide separates planning, readiness, and a returned reply. Security directs readers to verify release provenance without treating it as isolation or platform qualification. Credential values stay out of the tutorial and onboarding YAML. |
| References and Resources | CLI syntax and result fields follow parser and SDK contracts. The generated schema and field reference remain unchanged. Resources route readers and coding agents to the release-matched sources. |
| Navigation | `fern/pages.json` adds `onboard`, moves Security after Observability, and leaves existing slugs intact. `fern/docs.yml` retains **Latest (main)** first and the `/nemoclaw/v1/` prefix under **v1 (Agent Configs)**. No redirects changed. Maintainer pages remain outside public navigation. |

## Local Validation

- `cargo run --locked -p nemoclaw-build -- fern check` exited 0 with Cargo and Protobuf 36.2 on `PATH`. It prepared main at `f5c05a0e6a59bd5133c50e31becbff25af274c33` and ran schema drift, generated docs and links, main route, v1 strict-link, and combined site checks. The final rerun reported zero Fern errors and two warnings per pass.
- Expanded warnings report an existing MDX parse issue in the generated configuration table (`<registration>` in the `sandboxEnv` description) and a skipped authenticated missing-redirects check. The offending field text is unchanged from the authoring base. This iteration did not change the generator or generated inputs.
- `target/debug/nemoclaw-build schema --check` and `git diff --check` exited 0. Inspected generated MDX and navigation for numbered commands, the onboarding link, section order, canonical changelog and configuration routes, and the version selector source. Did not verify browser rendering or hosted redirects.

- `cargo test --locked -p nemoclaw-cli args::tests --bin nemoclaw` exited 0: 11 passed, including the checked-in OpenClaw example's engine field and the onboarding and lifecycle parser tests. These tests do not use a release archive or invoke an agent.

## Pre-Release Base Refresh

Merged `origin/v1` at `16c31be663f5415d95242be739352966179fb5a1` into the workflow branch without conflicts or history rewrites. GitHub returned no proposal for this workflow branch, and the remote branch lookup returned no head. The related [first-reply PR](https://github.com/NVIDIA/NemoClaw/pull/14569) and [shared documentation guide PR](https://github.com/NVIDIA/NemoClaw/pull/14795) are merged. The former's token-lifetime finding is already addressed: the terminal UI exits before the reader clears its token. Its comments concern the earlier tutorial, not this candidate.

- The lifecycle guide and CLI reference explain which credentials plan reads and which it can defer. The sources are CLI `dispatch.rs` and `credentials.rs`, SDK `config/mod.rs`, and `crates/nemoclaw-sdk/tests/plan_credentials.rs`.
- Security and lifecycle guidance reflect the in-place network policy updates from [#14774](https://github.com/NVIDIA/NemoClaw/pull/14774), including the connection interruption and replacement exceptions. See `crates/openshell-provider/src/{lib,mutation,network}.rs` and the sandbox contract tests.
- The refreshed base updates the generated schema and configuration reference and adds the main-sourced public agentic documentation guide. This candidate preserves those upstream changes and adds onboarding without replacing an existing route.
- After the merge, Fern, schema, whitespace, and all 11 focused CLI parser tests passed. The last Fern run reported zero errors and two warnings per pass. Logs: `/tmp/nc-refresh-final-fern.log` and `/tmp/nc-refresh-parser.log`. Inspected generated navigation for onboarding, Observability before Security, and the shared guide in both versions. No browser preview ran.
- The final tag still returned no match, GitHub reported `release not found`, and the release page returned HTTP 404. The hosted v1 check failed with a connection reset. This is a pre-release review candidate; final-release verification remains a separate step.

## Independent Review Corrections

Merged `origin/v1` at `105e002500daaacb90ffcadaf59d8ea80268a91c` without conflicts. No remote workflow head or PR was found. The independent review of `e920acfad93bf55e31eba85ae4c940c9e684b14f` requested changes; it did not approve that commit for publication.

- Fixed the generated configuration reference by marking the placeholder as literal code in SDK `config/integrations.rs` and regenerating the schema and field reference.
- Corrected the OpenTofu provider version example using `crates/nemoclaw-build/src/{main,version}.rs`: the manifest gives `0.1.0`, not the CLI banner.
- Verified the NemoClaw v0 exporter against `src/commands/config/export.ts` and `src/lib/domain/config/export-document.ts` at `7892283831683e8b8b7a167b5cf1006d7bc262a5`: it creates a UUID, preserves the gateway port, and emits an image placeholder.
- Moved the installed-CLI procedure out of the onboarding crate README. The public guide now names the review keys and links to plan credential requirements. The task index includes the shared engineering guide. The state guide warns readers to preserve writable-layer files before applying sandbox sizing changes.
- Regeneration, schema freshness, whitespace, and all 11 focused CLI parser tests passed. Fern reported zero errors and one warning per pass. The expanded diagnostics confirmed that only the unauthenticated redirect check remains. Logs: `/tmp/nc-r3-schema.log`, `/tmp/nc-r3-parser.log`, `/tmp/nc-r3-fern.log`, and `/tmp/nc-r3-fern-warnings.log`.
- The final release lookup still returned no tag or release. The corrections do not establish a shipped archive, a live native reply, or hosted rendering.

## First-Reply and Troubleshooting Review Corrections

The independent review of `da0852d7e11a30180b06ec43804c9122af87e935` requested changes. The fetched `origin/v1` still resolves to `105e002500daaacb90ffcadaf59d8ea80268a91c`, which is already merged. The workflow branch has no remote head or proposal.

- Troubleshooting distinguishes `deferred` prerequisites from `unverified` advisories, including missing-image compatibility. See `crates/nemoclaw-cli/src/formatting.rs` and `crates/nemoclaw-sdk/src/deployment/reporting.rs`.
- The first-reply tutorial checks both invocation statuses and the greeting in `result.output.response`. See Fabric's `runtime_server/cli.py` and `adapters/python/openclaw/src/nemo_fabric_adapters/openclaw/adapter.py` at `76bde16c40747062001bd6ea5f5d13cadab3d706`.
- The teardown procedure requires a successful JSON preview with `complete: true` before reviewing removals. See `crates/nemoclaw-sdk/src/deployment/runtime/teardown.rs` and the CLI JSON formatter.
- `cargo run --locked -p nemoclaw-build -- fern check` exited 0 (`/tmp/nc-r4-fern.log`), with zero errors and one warning per pass. Schema freshness and whitespace checks passed. No schema inputs or parser examples changed in this correction.
- GitHub still returned no final `v0.1.0` tag or release. The hosted v1 overview probe failed with a connection reset. No release rehearsal was run.

## Follow-Up on Draft PR #14801

[PR #14801](https://github.com/NVIDIA/NemoClaw/pull/14801) remains open as a draft at `a6a6ea490a357d5f9e681425c39d17471d65e04c`. Its source head matched the local branch before merging `origin/v1` at `a27dd94122960556f12f2f2cac380e5b9dae2788`. The merge was clean; a local skill-sync hook reported dependency and `sdk_sync` errors after the merge.

- The product name is NemoClaw Agent Configs. The README and About explain why the desired-state architecture replaces separate lifecycle commands. The selector, task index, migration guide, and resources use the public product names without changing version slugs or page routes.
- The migration guide makes fresh YAML the path that works without an exporter. It retains export as an option only for readers who already have the report-capable NemoClaw v0 CLI; no shipped version containing it was verified.
- The OpenShell links now use the `versions.json` pin, `ce58cf8e9b953281352d98a637e41616295b1318`. Checked the gateway authentication guide, CLI source, Microsoft Graph tutorial, and sandbox heading at that revision. The existing `#expose-long-running-services` fragment already matches the heading.
- The parallel OpenClaw example checks the exit status, both invocation statuses, and `result.output.response` using the same pinned Fabric adapter contract as the first-deployment tutorial.
- The upstream merge changes how an agent uses state when the image's adapter lacks `keep_state`, and how onboarding handles a rejected automatically selected image. The generated schema and configuration reference came from the merged source. Onboarding guidance follows `withdraw_rejected_images` in `crates/nemoclaw-authoring/src/journey_state/observations.rs` and the TUI review path in `crates/nemoclaw-onboarding/src/tui/app.rs`.
- Fern passed both its standalone v1 and combined-site checks with zero errors and one warning per pass (`/tmp/nc-r5-fern-final.log`). Generated documentation and schema freshness checks and `git diff --check` passed. All 11 focused CLI parser tests passed (`/tmp/nc-r5-parser.log`). Local navigation keeps the `migration`, `latest`, and `v1` slugs, with Latest first. The authenticated redirect check and live deployment checks were not run.
- The PR bot reported a Fern preview. Direct probes of its v1 overview and migration routes failed with connection resets. The exact final tag and release were still not found. No release rehearsal or site publication was performed.

## Resolving the PR Conflicts With the v1 Publishing Update

PR #14801 was open and conflicting at remote head `a6a6ea490a357d5f9e681425c39d17471d65e04c`. Merged `origin/v1` at `bd95ea3f4c1e3e105d2b8848ad20e45c8ba69b23` without rewriting branch history. Resolved conflicts in the migration guide, resources page, and maintainer build guide using `fern/product.yml`, `crates/nemoclaw-build/src/fern.rs`, and `.github/workflows/docs.yml`. The official hosted products now publish independently. The local combined build retains its Latest default. The v1 product selector uses the public name NemoClaw Agent Configs without changing routes.

- `cargo run --locked -p nemoclaw-build -- fern check` exited 0 with zero errors and one warning in each of its three passes (`/tmp/nc-r6-final.log`). The imported layout revision was `4649634639d2ddcb26b84cb34db63b2d4176a8a1`.
- `cargo test --locked -p nemoclaw-build --test integration fern::` passed all seven selected tests (`/tmp/nc-r6-integration.log`). Generated docs, schema freshness, and whitespace checks passed.
- Requests to the staging v1 home and Markdown index failed with connection resets; public v1 overview and v0 home probes returned HTTP 404. The final `v0.1.0` tag and release were still not found. No live release rehearsal or site publication was performed.

## Naming and Navigation Review Corrections

The review of `2743e5b7dddea184d4426bae679366b21adbad05` covered naming and directly affected routes. The fetched `origin/v1` and draft PR #14801 head were already ancestors; no further merge was needed.

- The main layout builder at `4649634639d2ddcb26b84cb34db63b2d4176a8a1` adds a `home` navigation entry backed by `docs/preview-v1-home.mdx`. `checked_product` now installs the tracked `fern/home.mdx` at that destination. The page leads to the Agent Configs install, deployment, and native reply check without exposing v0 installation instructions. The v0 switcher retains its destination and is labeled NemoClaw v0.
- The task index links to the imported engineering example at the `fern/main-source.json` revision. Its navigation label identifies it as a v0 example; its source and route are unchanged. The resource guide and user-guide skill distinguish the hosted Markdown indexes from the combined local preview's Latest default.
- The seven v1 aliases in `fern/docs.yml` have matching destinations in the assembled standalone product. A local check compared both configurations and inspected the assembled home and generated guide routes. The home check failed against the old builder and passed after the change. These are local assembly checks, not hosted redirect tests.
- Fern validation passed with zero errors and one warning per pass (`/tmp/nc-home-final.log`). The seven targeted Fern integration tests passed (`/tmp/nc-home-tests.log`), as did generated docs, schema freshness, and whitespace checks. No runtime examples or schema inputs changed.

## NemoClaw v0 Markdown Discovery Correction

The review of `972f4bfc50edb00c6c21301a70a61c57ff9c29f9` found that `/nemoclaw/v0/llms.txt` did not serve a Markdown index. A follow-up request confirmed that it redirected to `/nemoclaw/v0.md` and returned a not-found body despite HTTP 200. The parent `/nemoclaw/llms.txt` returned the Markdown index with a **Latest** entry. The owning user-guide skill on main at `4649634639d2ddcb26b84cb34db63b2d4176a8a1` directs readers to that parent index.

The resources page and skill now use the parent index for NemoClaw v0 discovery, keep Agent Configs discovery separate, and require revision matching before using commands. **Latest (main)** describes the combined local preview's default. The fetched PR and base heads were already ancestors. Fern validation passed with zero errors and one warning per pass (`/tmp/nc-v0-index-fern.log`); generated docs, schema freshness, and whitespace checks passed. This does not verify hosted v1 behavior.

## Release Evidence Still Needed

`git ls-remote --tags origin refs/tags/v0.1.0` returned no match. The final release page returned HTTP 404. The v1 hosted overview first returned 404 and later failed to connect. The API request was rate-limited. These observations do not establish the contents of a private release. No draft RC assets were substituted and nothing was published.

| Rehearsal Stage | Status and Evidence Needed |
|---|---|
| Install | Not run. Obtain the final bundle, `SHA256SUMS`, attestations, signing evidence, and exact tag commit. Verify the archive and check `nemoclaw --version`. |
| Plan | Not run. Obtain the tagged example, OpenClaw digest, and an approved disposable gateway and inference endpoint with a compatible model. Record resource changes, deferred checks, and advisories. |
| Apply | Not run. Record image acquisition, catalog checks, and the resulting gateway/workspace selectors. |
| Reply | Not run. Record the exact model and capture a redacted native invocation result showing success and the returned reply. |
| Cleanup | Not run. No resources were created. In the rehearsal, preview destroy and verify owned removal and external/retained resources separately. |

Independent review is pending. Publication, final-release qualification, and any shared deployment changes are outside this handoff.
