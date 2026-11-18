<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Proposed v1 Roadmap

**Draft for team review, 17 November 2026.**
Ship the selected GTC DC experience first, then deliver the agreed Classic parity as complete user journeys.
Use the [Classic-to-v1 matrix](../docs/get-started/classic-v1-matrix.md) to judge current migration readiness; a roadmap entry does not make a feature available.

This proposal follows the **V1 Transition - In/Coming/Out Matrix** meeting on 17 November, the saved workshop decisions, and current code at v1 `459a78500600eb810e76bc68cc2080d3bf346a9f`.
That revision pins Fabric `135147a0fe6ce6bc2ebf21fa1068d1bd5af71780`.
It proposes phase order and grouping, not calendar dates, assigned owners, or effort estimates.
GTC DC is the only milestone with a fixed release target used here; the team must confirm capacity and the selected release scenarios before attaching dates.

## Keep Scope and Milestones Aligned

[Milestone 12: GTC DC](https://github.com/NVIDIA/NemoClaw/milestone/12) tracks the release work and historical implementation behind the matrix's Available list.
[Milestone 14: Classic parity](https://github.com/NVIDIA/NemoClaw/milestone/14) tracks the seven agreed Planned parity outcomes, without a due date.
The matrix links Available entries to selected milestone-12 issues or implementation PRs and Planned parity entries to their primary milestone-14 trackers.
These are scope and evidence links, not automatically generated support claims.

When scope changes, update the matrix and catalog together, then reconcile the primary issue's milestone.
When an issue closes, review its acceptance and documented limits before moving a capability to Available; closure for replanning or supersession does not establish delivery.
Keep Needs review items outside the committed parity backlog until their scope is agreed.

| Planned outcome | Primary tracker | Proposed work package |
|---|---|---|
| Onboard with familiar choices | [#14606](https://github.com/NVIDIA/NemoClaw/issues/14606) | A: onboarding |
| Set up web search | [#14607](https://github.com/NVIDIA/NemoClaw/issues/14607) | A: search |
| Connect and manage messaging | [#12037](https://github.com/NVIDIA/NemoClaw/issues/12037) | C: messaging |
| Agent assisted migration | [#14580](https://github.com/NVIDIA/NemoClaw/issues/14580) | A: migration |
| Trace and review activity | [#14609](https://github.com/NVIDIA/NemoClaw/issues/14609) | D: Relay/activity |
| Broader local model support | [#14608](https://github.com/NVIDIA/NemoClaw/issues/14608) | A: broader local combinations |
| Run llama.cpp and NIM | [#14556](https://github.com/NVIDIA/NemoClaw/issues/14556) | B2: managed runners |

Migration #14580 and managed runners #14556 move from GTC DC into the parity milestone to match their agreed work category.
This does not assign a delivery date or prevent an increment from landing earlier.
Keep initial roadmap/matrix publication #14557 in GTC DC; its later documentation-automation work can be sequenced separately.
The chart-setting decision #14588 is Kubernetes scope, not Classic parity, and remains in GTC DC for release-scope review.

## Proposed Sequence and Fabric Capacity

Use one new Fabric implementation workstream at a time as the initial planning assumption, subject to that team's agreement.
Review and finish already-open release work before starting a broad new integration.
NemoClaw can prepare user flows, acceptance scenarios, examples, and documentation in parallel without inventing Fabric behavior or API fields.

| Phase | User outcome | NemoClaw work that can proceed | Fabric allocation |
|---|---|---|---|
| 0 — before GTC DC | Install and use the selected release/demo configuration with matched artifacts and instructions. | Distribution, image availability, source/version selection, selected demos, documentation. | Finish the release-relevant P0 work already tracked in #577; avoid adding messaging or Relay to this milestone. |
| 1 — first parity increment | Configure useful tools/search and evaluate a move from Classic. | A: onboarding, search examples, migration guidance; B: application-data demonstration and small-runner assessment. | Consume existing capabilities; finish remaining phase-0 fixes. Request only a concrete demonstrated upstream gap. |
| 2 — next Fabric implementation workstream | Connect and manage a selected messaging channel through its complete lifecycle. | C: acceptance cases, channel selection, onboarding and YAML changes against an agreed contract. | Messaging contract and selected native channel support. |
| 3 — subsequent Fabric/Relay integration | Export traces and inspect the agreed activity signals. | D: collector/access configuration and user-facing diagnostics. | Relay/OpenClaw tracing with the Relay team, after messaging by proposed capacity order. |
| Decision lane — throughout | Resolve uncertain scope without blocking independent work. | Classic inventory, enterprise-owner review, diagnostics, native memory and distributed inference decisions. | Discovery and scoped consultation; no unbounded implementation request. |

Phases 2 and 3 have no established technical dependency on each other.
Their order limits competing upstream work; reverse it if the teams prefer and the selected contracts are ready.
Small NemoClaw-only work in phase 1 can finish while upstream release work continues.

## Phase 0: Install and Deliver the GTC DC Experience

The call explicitly required packaging and installation before GTC DC (24:30–25:27).
The artifact/docs work below supports that user outcome; it is not a decision to make every open parity issue a GTC blocker.

| Work package | Completion condition | Evidence / dependency |
|---|---|---|
| Download and install without a checkout | On a clean supported client, obtain a matched bundle, install it on PATH, follow the documented first deployment, reach the native interface, and get a reply. | [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638); packaging format/channel still needs agreement. |
| Obtain usable release images | A user on the selected host can pull the image referenced by the guide and run it with the matched Fabric adapter. | [#13516](https://github.com/NVIDIA/NemoClaw/issues/13516); image publication precedes a clean-machine rehearsal. |
| Account for artifact provenance and licenses | Record source/image identities and resolve release provenance and license review for the selected deliverables. | [#13521](https://github.com/NVIDIA/NemoClaw/issues/13521), [#13524](https://github.com/NVIDIA/NemoClaw/issues/13524). The call's assumption of unchanged licensing is not a completed review. |
| Publish matched user and agent guidance | Users can choose v1, find its supported matrix and installation path, and distinguish Classic instructions. | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644); README should link to detailed migration/support information after review. |
| Rehearse selected demos | Verify the exact selected host, model, native tools, policy/guard behavior, and data expectations; record material limitations. | Existing [GTC examples](../examples/gtc-dc/) and [live validation](contributing/live-tests.md). Select the required scenarios rather than reopening every completed story. |

Fabric's [#577](https://github.com/NVIDIA/NeMo-Fabric/issues/577) is an existing upstream release plan, not additional scope granted by this draft.
Reconcile its priorities with the exact scenarios selected for GTC:

| Existing upstream work | State checked on 17 November | Downstream action |
|---|---|---|
| Busy shutdown/replacement | #628 is in the pin; [#631](https://github.com/NVIDIA/NeMo-Fabric/pull/631) merged after the pinned commit. | Check whether #631 is needed for the selected scenario, then consume a reviewed pin and rerun affected checks; do not request the merged implementation again. |
| OpenClaw retention/cold resume | [#612](https://github.com/NVIDIA/NeMo-Fabric/pull/612) remains open under [#578](https://github.com/NVIDIA/NeMo-Fabric/issues/578). | If the scenario promises continuation, wait for the supported contract and verify it through replacement; otherwise state the limitation. |
| Lost/late invocation result recovery | [#629](https://github.com/NVIDIA/NeMo-Fabric/pull/629) remains open. | Qualify recovery without blindly replaying side effects when this outcome is required. |
| Hermes native interface with custom credentials | [#652](https://github.com/NVIDIA/NeMo-Fabric/pull/652) remains open. | Qualify the supported credential path; do not claim every native-access variant works. |

OpenShell [DNS TTL reconnection #4674](https://github.com/NVIDIA/OpenShell/issues/4674) is a separate upstream limit affecting long-lived OpenClaw requests.
Confirm the chosen experience against it; neither a Fabric merge nor a successful first reply resolves it.

## A: Configure Tools, Search, and an Agent-Assisted Move

Group onboarding, tool/search examples, and migration evaluation because all produce a coherent desired-state configuration that a user and their agent can inspect and rerun.
Meeting basis: 5:12–12:13, 25:27–33:58, 43:08–44:22.
Stories: E05-S01, E12-S09, E14-S01, and workshop NEW-001.

1. Inventory Classic onboarding scenarios; Kao offered to share the missing-scenario list.
2. Demonstrate a selected search path through ordinary plugin/MCP settings, endpoint grants, and protected credentials.
   Separate actual search behavior from the integration that supplies a key.
3. Decide whether to expose search and similar integrations as onboarding presets that generate normal YAML.
4. Define export as a starting point for an agent-assisted recreation journey, including missing settings, resource identities, mounted data, and validation.
5. Qualify broader local model combinations and the separately selected Gemini/Bedrock provider paths; keep native plugin configuration and supported conversation continuation in Available with their harness-specific limits.

**Acceptance:** start with the documented inputs, produce or adapt YAML, plan/apply it to a separate deployment, get a tool-backed reply, export, and reapply unchanged.
For a migration example, preserve Classic and verify required data/native history separately before retirement; demonstrate no claim of automatic adoption or rollback.

**Dependencies:** search examples require a supported native plugin or MCP tool, credentials, egress, and a real result.
Optional presets depend on a working configuration example, not on a new general third-party plugin manager.
Fabric's merged skills/configuration work can be consumed now; [#614](https://github.com/NVIDIA/NeMo-Fabric/issues/614) remains a separate lifecycle proposal.
If the selected tool requires browser OAuth rather than a key, track [Fabric #633](https://github.com/NVIDIA/NeMo-Fabric/pull/633) as that path's dependency; it is MCP OAuth sign-in, not generic model-provider sign-in or a prerequisite for key-authenticated MCP.
The inspection API in [#641](https://github.com/NVIDIA/NeMo-Fabric/pull/641) may improve admission UX but is not an established prerequisite for basic YAML onboarding.

## B: Run Local Workloads and Explain Data Retention

The application journey and inference-runner assessment can proceed in the same phase, with independent acceptance and no dependency on each other.

### B1: Compose Applications and Retain Their Data

Group the container declaration, application inputs, storage, update/removal, and a demo as one user outcome: run an application alongside an agent and understand what survives changes.
Meeting basis: 35:20–40:16, 45:17–46:40, 58:02–59:36.
Stories: E04-S04/E04-S09, E17-S02/E17-S04/E17-S06/E17-S07.

The [generic container contract](../docs/build-deploy/container-services.md) already exists, but it explicitly provides disposable `data`, literal environment, and nonsecret files.
The meeting's volume-retention expectation is not yet a demonstrated generic-container guarantee.
First establish whether a supported platform-owned storage path meets the intended example; otherwise return the specific gap for a scope decision under [#12568](https://github.com/NVIDIA/NemoClaw/issues/12568).
Do not close [#12569](https://github.com/NVIDIA/NemoClaw/issues/12569) on the assumption that literal environment fields provide protected secret delivery; review the linked implementation first.

**Acceptance:** declare and start an application, verify agent access, write identifiable application data, update/replace/remove it through the claimed storage path, and verify both expected retention and removal behavior.
Keep application schema compatibility and platform backup ownership explicit.
If that storage path is unavailable, the retention outcome stays unavailable; a running container is not completion.

### B2: Assess Additional Managed Inference Runners

In parallel with B1, estimate and sequence managed llama.cpp and NIM support, now included in Planned parity by the follow-up review decision.
The earlier NIM exclusion in [#12649](https://github.com/NVIDIA/NemoClaw/issues/12649) and current limits describes the inspected implementation and predates this new direction.
Reconcile that issue and the owning scope documentation when implementing the planned runner; external NIM endpoints remain a separate current path.
Any runner work needs its own model readiness, hardware, credential, storage, and tool-backed response acceptance; it does not follow automatically from generic-container support.

**Fabric load:** no new general Fabric service is established by this package.
NemoClaw/platform discovery can proceed while Fabric finishes release work.

## C: Connect and Manage Messaging as One Journey

Messaging is agreed Classic parity; its channel and implementation contract need investigation.
Meeting basis: 50:04–53:42.
Group E06-S01–E06-S06: enroll, chat, choose allowed senders, retain connection through updates, rotate credentials, and disconnect.

Agree one channel/harness/runtime combination first, using Classic's [channel behavior](https://github.com/NVIDIA/NemoClaw/blob/495896a404/docs/manage-sandboxes/messaging-channels.mdx) as the inventory rather than promising all channels at once.
The owners must resolve native enrollment/handshake, webhook or local-service requirements, credentials, egress/ingress, and retention before finalizing YAML fields and onboarding prompts.
Opening a port does not complete signup or pairing.
Track the journey with [#12037](https://github.com/NVIDIA/NemoClaw/issues/12037); its prior closure for replanning is not delivery evidence.

**Acceptance:** enroll a test account, send/receive a message, reject an unapproved sender, restart and replace according to the retention contract, rotate the credential, then disconnect and verify access removal.
Export/reapply must preserve the declared configuration while keeping secrets out of it.
Repeat channel-specific acceptance before claiming another channel supported.

**Dependencies:** Fabric/native channel contract → supported runtime configuration and retention → NemoClaw spec/onboarding → full lifecycle acceptance.
Scenario design and UI preparation can overlap contract work; implementation must not guess undocumented native behavior.
This is the proposed next new Fabric workstream after release stabilization.

## D: Trace Agent Behavior and Review Activity

Group native trace emission, collector routing, and the selected activity view so the result is useful to an operator.
Meeting basis: 34:17–34:45 and 54:21–55:41.
Stories: E13-S05 and E13-S09.

Hermes Relay configuration already exists; OpenClaw Relay work in [Fabric #625](https://github.com/NVIDIA/NeMo-Fabric/issues/625) has an explicit post-GTC deferral.
With Relay owners, define which events, identities, access decisions, destinations, retention, and access controls the first increment promises.
Keep enterprise audit requirements distinct from tool traces and NemoClaw operation telemetry.

**Acceptance:** produce a known agent action and access decision, find the expected correlated records at the selected destination, verify visibility/access and retention, and verify behavior after restart and export/reapply.
Failure to reach the collector must have documented behavior.
Do not claim an enterprise audit system from trace emission alone.

**Dependencies:** Relay contract and selected harness trace support precede collector/activity acceptance.
Messaging is not a technical prerequisite; sequencing it first is the capacity assumption.
Shareable diagnostic bundles remain a separate decision because logs/debug artifacts are not the same as traces.

## Decisions Needed Before Scheduling More Work

These are review items, not new implementation commitments or an exhaustive “never” list.
Use the matrix's review queue to preserve the conflicting evidence.

| Decision | Next step |
|---|---|
| Which current-main features are permanently excluded? | Complete a Classic source/docs and user-workflow inventory. Keep historical shields, platform-owned backup, dropped stories, and deferred features distinct. |
| Distributed inference | Revisit the call's incorrect premise that Classic lacked it; its two-node guides describe experimental functionality. The call dropped it from parity; no permanent ban was agreed. |
| Native memory and credential rotation | Verify the native/OpenShell path for the actual Classic workflow; neither needs a newly invented NemoClaw subsystem by default. |
| Diagnostics sharing | Inspect Classic's bundle/log behavior before including or dropping E13-S03. |
| Enterprise enrollment, identity, and policy | Review with the enterprise owners requested in the call. Preserve already-delivered scoped APF/OAuth work; do not infer completion or absence of the whole journey. |
| Lost-start reply safety | Decide the required release guarantee under [Fabric #487](https://github.com/NVIDIA/NeMo-Fabric/issues/487)/#577; status lookup is not start idempotency. |
| Additional harness scope | Preserve the workshop's Deep Agents Code versus LangChain Deep Agents deferral; do not bundle it into OpenClaw/Hermes parity. |

## Keep the Matrix and Roadmap Aligned

Maintain the matrix as the user/agent support statement and this document as the proposed implementation sequence.
After team review, add a short README pointer to both; keep detailed planning in this repository rather than duplicating it in the README.
Use existing story IDs and component issues for traceability; create scoped follow-up issues only after the unresolved decisions have been reviewed.

The call proposed carrying over documentation/release-note automation and updating capability status as work merges (1:06:05–1:11:40).
Start with a manual review per accepted increment; a future automation should propose evidence-backed matrix/roadmap changes for review rather than infer support from merged PR counts.
Before advertising an increment, record the consumed upstream revision and the selected supported path, update its limits and migration guidance, and verify the complete user journey.
