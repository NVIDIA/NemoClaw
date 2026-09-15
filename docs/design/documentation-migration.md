<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Plan the User Documentation Migration

Status: proposed work plan, based on the repository on 2026-09-15.
This plan changes documentation; it does not approve new product capabilities or declare a release ready.

Build the next-version guide around a complete desired-state deployment journey, then reconcile every previous page and published route with that guide.
Keep the current-release documentation available while the next-version documentation is in preview.
Make the public documentation switch a release gate, after the examples, migration instructions, and route behavior have been verified.

## Baseline and Size

The comparison uses these immutable revisions:

| Source | Revision | Role |
|---|---|---|
| `origin/main` | `97745a7ad9649f851704493e4b670b3674f875aa` | Previous documentation and publishing inputs |
| This checkout and `origin/v1` | `089a4bffb07c8386b0487bb1c6d7760836f6c4f0` | Implemented behavior and current task guides |

At the source revision, `docs/` contains 125 non-changelog MDX sources and 76 changelog MDX sources, including the changelog overview.
Navigation defines 300 page entries across OpenClaw (109), Hermes (102), Deep Agents (84), and Pi (5), excluding changelog routes.
The Fern configuration contains 410 redirect rules; parameterized rules can cover several URLs.
Page count is therefore not a measure of published route coverage.

The [source inventory](documentation-migration-inventory.md) assigns every non-changelog MDX source a disposition, destination, and work package.
It also identifies release history and supporting publication inputs.
These are proposed editorial dispositions; a held feature has no promised implementation date.

The branch already has useful [task guides](../README.md), [generated configuration reference](../reference/configuration.md), [examples](../../examples/), and [qualification evidence](../validation/README.md).
Extend those owners and extract overloaded sections where needed.
The branch has no Fern configuration, public docs publishing workflows, or general documentation link-checking job; its Rust CI does check generated schema/reference freshness.

## Changes That Determine the Migration

| Previous reader expectation | Current contract | Documentation action |
|---|---|---|
| Install and answer onboarding prompts; use agent-specific CLI aliases | Native verified bundle, desired-state YAML, one `nemoclaw` CLI | Write prerequisites and a complete first-deployment guide; replace installer and alias instructions |
| Run many sandbox, inference, credential, and integration subcommands | `plan`, `apply`, `export`, `destroy`; arguments in [the parser](../../crates/nemoclaw-cli/src/args.rs) | Rebuild the CLI reference; map old tasks to current operations or an explicit limitation |
| Reuse an old export, registry, snapshot, or state directory | Strict revision-sensitive schema and durable deployment ownership; no general adoption or state migration | Explain fresh deployment, separate state, retained old tooling, native-data backup, verification, and rollback boundaries |
| Rebuild or upgrade a sandbox in place | Ordinary apply refuses most replacements; supported managed-service changes have narrower rules | Publish a change-impact table for model, provider, image, API, policy, tools, interfaces, and execution settings |
| Use NemoClaw to manage messaging, MCP servers, plugins, tunnels, and backups | Fabric hosts agents; native integrations retain their ownership; the schema does not provision all integration prerequisites | Preserve old instructions in the previous-version guide; document boundaries without presenting native fixtures as supported end-to-end workflows |
| Choose vendor and host profiles from an onboarding catalog | Explicit API, endpoint, image, model, service, engine, and credential references | Organize inference around supported configurations; qualify named providers and platforms separately |
| Read OpenClaw/Hermes/Deep Agents/Pi variants of shared pages | Ten accepted harness names, with different API and managed-service constraints | Use shared task pages plus a capability matrix and focused harness sections; avoid multiplying every page ten times |
| Import the TypeScript lifecycle package | Public Rust SDK plus OpenTofu provider consumer | Write an SDK migration boundary and provider usage contract; do not promise a compatible TypeScript replacement |
| Read published HTML, Markdown, starter prompts, skills, and docs search | Repository Markdown is the current documentation source | Restore publication and version-aware discovery from one canonical source |

The [accepted scope](scope.md) remains authoritative.
In particular, export is configuration, not a backup of histories, native settings, model weights, or sandbox files.
Destroy deletes sandbox files and conversation history while retaining the documented workspace, model, gateway, and local-state resources.
No migration procedure may infer that retained model storage also preserves an agent conversation.

## Reader Journeys and Page Ownership

Paths marked **new** are proposed deliverables, not existing guides.
Keep canonical prose in repository Markdown; select publication tooling in D00.

| Reader task | Canonical destination | Completion criterion |
|---|---|---|
| Understand NemoClaw and choose an interface | **new** `docs/overview.md`; root README and docs index link to it | Explain SDK, CLI, OpenTofu, OpenShell, Fabric, and resource ownership in user terms |
| Check prerequisites and supported configurations | **new** `docs/prerequisites.md` | Distinguish client OS, engine host, GPU/model host, image architecture, and tested combinations |
| Reach a first working agent interaction | **new** `docs/get-started.md`; retain [build instructions](../build.md) | Build/select a verified bundle and matching image, author YAML, plan, apply, access the native agent, verify a reply, and preview cleanup |
| Configure, inspect, and operate a deployment | [usage.md](../usage.md) | Explain one provider/sandbox per document, OpenClaw multi-agent limits, state selection, output, unchanged apply, and export/reapply |
| Change or recover a deployment | [usage.md](../usage.md); **new** `docs/troubleshooting.md` | Cover refused replacement, drift, failed observations, interrupted apply/destroy, and managed-service recovery |
| Protect state and move from the previous product | **new** `docs/state.md` and `docs/migration.md` | Identify data locations and lifetimes; provide a rehearsed parallel-deployment and rollback procedure without promising adoption |
| Choose inference and place a managed service | [inference.md](../inference.md), [models.md](../models.md), [remote-service.md](../remote-service.md), [recipes.md](../recipes.md) | Separate external endpoints, managed Ollama, managed vLLM, SSH placement, and optional model recipes |
| Select and access an agent | [agents.md](../agents.md), [interfaces.md](../interfaces.md) | State each harness's requirements, native access, configuration ownership, sessions, and qualification limits |
| Configure security and credentials | [sandbox-network.md](../sandbox-network.md); **new** `docs/security.md` | Cover policy, trust, credential storage/access/lifetime/removal, isolation limits, native tokens, and reporting |
| Look up a command or YAML field | **new** `docs/reference/cli.md`; [configuration.md](../reference/configuration.md) | CLI reference agrees with help; configuration reference remains generated from Rust |
| Integrate programmatically | [sdk.md](../sdk.md); **new** `docs/provider.md` | Compile SDK examples; explain provider packaging, state ownership, supported entry points, and stability boundaries |
| Use coding-agent documentation or find project resources | **new** `docs/resources.md`; version-specific starter prompt and routing skill if retained | HTML, Markdown, search, prompts, and skills select the same product version |
| Understand release changes | **new** `docs/release-notes.md`; preserved previous-release history | State breaking changes, removed workflows, tested configurations, known limits, and migration route |

Keep [design rationale](architecture.md), [test procedures](../testing.md), and [retained evidence](../validation/README.md) distinct from getting-started instructions.
Link evidence from support claims; do not make users read internal qualification records to discover basic prerequisites.
When extracting content, remove the duplicate procedure and update inbound links and consumed anchors.

## Decisions Before Authoring

D00 records the maintainer's choices in the relevant owning document.
The defaults below allow planning to proceed; they are not accepted product or release decisions.

| Decision | Proposed default | Needed before |
|---|---|---|
| Release milestone, staffing, and assignments | Relative milestones; one primary author with engineering and independent review time | Committing calendar dates |
| Primary first-deployment configuration | Start from a Linux ARM64 configuration with retained evidence; rehearse the entire path at the release candidate | D03 quickstart and platform claims |
| Installation/distribution promise | Document the existing source-built bundle and local image process for preview; document downloads only when a verified release artifact exists | Public prerequisites and installation copy |
| Public next-version and previous-version URLs | Preserve previous-release docs and add a separately labeled next-version preview; choose final version slugs explicitly | D01 route implementation |
| Publishing tool | Assess reuse of Fern's existing site integration with Markdown as canonical source; isolate any docs-only toolchain | D01 implementation |
| Provider audience | Document its shipped contract; confirm whether direct user-authored OpenTofu configurations are a release workflow | D07 examples; provider existence alone does not settle this |
| Release capability matrix | Approve explicit harness × API × management × host configurations using current evidence | Named-provider, platform, and integration claims |
| Old-to-new native-data transfer | Require a verified transfer procedure for any claimed continuity; otherwise explain fresh start and retaining the old deployment | Migration guide and release notes |

Unresolved feature parity becomes an engineering decision with an owner and a documentation consequence.
It must not become an invented command, an undocumented manual workaround, or an unbounded docs migration dependency.

## Work Packages and Dependencies

Estimates are combined authoring, implementation, and review effort in person-days, not elapsed commitments.
They exclude new product features, new platform qualification, publishing access delays, and artifact distribution work.
Assign a named responsible person to each role at D00; cvillela owns accepted product scope.
Split packages into small green `docs:` changes; changes to validators also need behavioral tests that fail before implementation.

| ID | Deliverable and method | Responsible role | Depends on | Estimate | Exit evidence |
|---|---|---|---|---|---|
| D00 | Confirm decisions, page ownership, source inventory, launch configurations, and release gates | Maintainer + docs lead | None | 2–3 | Reviewed dispositions; named owners; no unsupported workflow assigned as a how-to |
| D01 | Implement versioned preview and build, preserve old publication inputs, derive route/anchor inventory, add link and redirect validation | Docs tooling engineer | D00 URL/tooling decisions | 3–5 | One canonical source renders; old docs remain reachable; representative old routes resolve correctly; CI runs without publishing credentials |
| D02 | Write product overview, task navigation, CLI reference, and harness/capability matrix structure | Docs lead + SDK engineer | D00 | 2–3 | Reviewed conceptual model; every current command documented; proposed claims linked to implementation/evidence |
| D03 | Write prerequisites and first deployment; adapt examples; separate client, engine, and inference hosts | Docs lead + runtime engineer | D02; D00 artifact/configuration decisions | 4–6 | A reviewer follows the selected configuration from a clean environment to an actual agent reply and cleanup preview |
| D04 | Write migration, state/data inventory, change-impact table, recovery, and troubleshooting | Lifecycle engineer + docs lead | D02; D03 walkthrough for rehearsal | 4–6 | Rehearsed old/new coexistence, failed update/recovery, retained-data checks, and return to the untouched old deployment |
| D05 | Consolidate inference/vendor pages into API and service guides; cover managed Ollama/vLLM, models, SSH placement, recipes | Runtime engineer + docs lead | D02 | 3–5 | Each configuration has a maintained example and explicit evidence level; unsupported multi-host and managed-server claims are excluded |
| D06 | Reconcile agent pages, native access, interfaces, tools/heartbeats, and held integrations | Agent engineer + docs lead | D02; D05 for final examples | 2–4 | Every accepted harness has a matrix row; OpenClaw/Hermes procedures reviewed; unsupported integrations have a clear destination |
| D07 | Expand SDK documentation and define provider documentation; verify programmatic examples | SDK/provider engineer | D02; D00 provider decision | 3–5 | SDK snippets compile and exercise meaningful lifecycle behavior; provider reference matches schema and qualified OpenTofu usage |
| D08 | Consolidate security guidance; update notices, project links, starter prompt, skill, and version-aware docs discovery | Security reviewer + docs lead | D03–D06 for security; D01 for discovery | 2–3 | Reviewed credential/data lifetimes and isolation claims; agent entry points select the intended docs version |
| D09 | Reconcile later branch changes, write release notes, complete independent journey review and route sweep, prepare cutover/rollback | Release owner + docs lead | D01–D08 | 3–5 | Release checklist below passes against one candidate revision and a rendered preview |

Total planning allowance: **28–45 person-days**.
Security review starts during D03/D04; D08 completes that review rather than discovering security prerequisites late.
D05, D06, and D07 can proceed concurrently when their owners and shared contracts are available.
D01 can run alongside content work after the URL and tooling decisions.

## When to Do the Work

No target release date or staffing commitment was supplied for this plan.
With one primary contributor and timely specialist review, reserve roughly **6–9 working weeks**, plus external blockers.
More contributors can shorten independent packages, but the first-deployment rehearsal and release-candidate review remain sequential gates.
Replace this allowance with calendar dates after D00.

| Milestone | Timing and dependency | Required result |
|---|---|---|
| M0: scope agreed | First 2–3 working days | D00 decisions and ownership; inventory reviewed |
| M1: reviewable foundation | After D01 and D02; before broad migration | Versioned preview, navigation, CLI contract, route inventory, and checks |
| M2: operator preview | After D03/D04 and initial security review | A new user can deploy, interact, change configuration, recover, understand data loss, and evaluate migration |
| M3: complete candidate | After D05–D08 | All current surfaces covered; every legacy source disposition implemented; SDK/provider and discovery reviewed |
| M4: release cutover | D09, against the final release candidate | Complete validation, final main/v1 delta reconciliation, release notes, approved version routing, and tested docs rollback |

Before M2, label the preview incomplete and keep the previous-release getting-started path authoritative for that release.
Before M4, do not repoint `latest`, default docs search, or starter prompts to the new product.
Tie the final docs snapshot to the released bundle, schema, images, and source revision.
If a configuration lacks qualification, narrow the claim or keep it out of the release guide; do not delay all documentation for speculative parity.

## Per-Page Migration Method

1. Read the entire old page, its applicable variants, generated content, and incoming routes.
2. Identify the reader task and the owning destination in the inventory.
3. Check current behavior against types, parsers, tests, image recipes, and retained evidence.
   Mark facts as implemented, fixture-tested, live-qualified at a named revision, or unsupported.
4. Write the current procedure with prerequisites, named working directory, effects, commands, expected result, verification, and recovery.
   Keep old commands only in explicitly labeled previous-version migration material.
5. Validate examples and changed commands; render affected pages and check navigation, links, and consumed anchors.
6. Obtain independent documentation review with the reader task, changed text, evidence, and [writing guide](../../WRITING.md).
7. Update the source-to-destination and route mapping in the same change.
   A page is complete only when content, links, and its old-route disposition agree.

For held topics, publish a concise capability limitation or preserve the previous-version page as appropriate.
Do not create one empty new page for each unavailable old feature.
Preserve source notices and historical evidence without relabeling old test results as current qualification.

## Publication and Link Migration

D01 must inventory published routes from the old `docs/index.yml`, generated variant rules, changelog paths, and `fern/docs.yml` redirects.
Include `.html`, `/index.html`, extensionless routes, anchors with consumers, HTML-to-Markdown links, raw prompt URLs, and docs-search links.
Inspect root README links, starter prompts, routing skills, and repository metadata as inbound consumers.
Do not derive route names from source filenames alone.

Use three route outcomes:

- A continuing task resolves to its current owning page, with an anchor where appropriate.
- An old-only workflow resolves to the preserved previous-version guide or a specific migration limitation.
- Historical release notes resolve to their original versioned history.

Avoid sending unrelated old tasks to the new home page.
Test redirect order, parameter expansion, missing anchors, loops, and cross-version leakage.
Preserve the previous version's link graph, including links from dated release notes.

The old public workflow accepts release tags only when their commits are reachable from `origin/main`.
It cannot be copied unchanged to publish a release from `v1`.
D01 must specify the release source, trigger, staging instance, public environment, credential boundary, and build inputs before a publish workflow is enabled.
Reconcile this with the repository's `origin/v1` push policy.
Document a rollback that restores the prior site configuration and version pointers without changing user deployments.
Publishing the site belongs to the release step; this planning change publishes nothing.

## Validation and Release Gates

### Every Documentation Change

Follow [documentation contribution requirements](../CONTRIBUTING.md).
Check local links and anchors, navigation ownership, generated reference freshness when applicable, and `git diff --check`.
Run required workspace format, lint, and test checks; documentation-only changes need no new runtime tests or live resources.
Record any checks that could not run and the reason in the handoff.
The future site build must validate both source and rendered links; `npm run docs` from `main` is not a command available on this branch today.

### Executable Examples and Claims

- CLI: verify flags, defaults, stdin, output streams, errors, bundle selection, and state directory behavior against help and process tests.
- YAML: parse maintained examples with the SDK and check the matching schema; label image digests and identifiers that readers must replace.
- SDK: compile snippets and exercise cancellation, progress, secret resolution, observation failure, and state preservation where documented.
- Provider: check the actual resource/configuration schema and pinned OpenTofu protocol; qualify any direct-use example before recommending it.
- Operations: cover unchanged apply, export/reapply, drift, refused replacement, interrupted operations, retained storage, and deletion effects.
- Runtime claims: separate native bundle validation, protocol fixtures, real inference, browser use, GPU capacity, kernel enforcement, and separate-host qualification.

Use [fixture qualification](../testing/fixtures.md) and [live qualification](../testing/live.md) for the appropriate evidence.
Live rehearsals require explicit configuration and owned resources.
Fixture success does not turn every harness/provider/platform combination into a supported deployment.

### Before Public Cutover

- Every inventoried source has an implemented disposition, and every current public surface has an owning guide.
- A new reader completes the primary installation-to-interaction journey without maintainer intervention.
- An existing reader can identify unavailable workflows, protect native data, keep old and new deployments separate, and understand the rollback boundary.
- No unlabeled legacy commands, installer assumptions, agent aliases, or old state paths appear as current instructions.
- The complete generated route inventory resolves to correct versioned content, including historical notes and retained anchors.
- HTML, Markdown, docs search/MCP, `llms.txt`, prompts, and routing skills agree on the product version where those outputs are published.
- Credential handling, native-data deletion, retained storage, isolation claims, and source notices have independent review.
- Release notes identify breaking changes and qualification limits at the release candidate revision.
- Site cutover and docs rollback have been exercised in staging; the previous-release guide remains accessible.

At M3 and again at release cutoff, diff both branches against the baseline SHAs above.
Classify new main documentation and new v1 behavior using the same inventory and ownership rules.
After cutover, make documentation impact part of each user-visible code change and maintain generated references and route checks in CI.
Keep decisions in their owning docs and work items; do not create a running migration journal.
