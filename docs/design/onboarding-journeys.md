<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onboarding Journey Prototype

This is a design for an authoring prototype, not a deployment support claim.
The [accepted scope](scope.md) remains authoritative for SDK, Fabric, and target responsibilities.

## Goal

One Rust journey definition combines a partial desired-state document with guidance about which decisions to ask for or omit.
The authoring library resolves questions using SDK and Fabric schemas, then produces an SDK document only when required decisions are complete.
The example TUI and a tree printer should consume the same resolver.
No separate journey YAML format is needed for this prototype.

## Terms and boundaries

| Term | Meaning |
| --- | --- |
| Deployment template | Supplied desired-state values, which may omit required fields during authoring. |
| Journey definition | A partial template, `ask` and `omit` guidance, and target prerequisites. |
| Journey state | Supplied values, answers, explicit omissions, and provenance of defaults or observations. |
| Question | One currently applicable unresolved decision, with choices and a suggestion where known. |
| Validation result | Invalid supplied value, pending decision, SDK-valid document, or target compatibility still unverified. |

The current `PartialTemplate` starts from complete OpenClaw defaults and governs only guided fields.
Its name does not imply a partial SDK document today.
The prototype should grow this API toward `JourneyDefinition` rather than add a serialization layer first.
The SDK owns complete document validation; Fabric owns adapter compatibility; target probes supply evidence without changing authored intent.

## Partial document

Parse authored YAML with the SDK's safe YAML limits into a sparse value tree before constructing `Document`.
Keep absence distinct from an explicit `null`, an accepted answer, an SDK suggestion, and an intentional omission.
For the first slice, use a fixed v1 single-sandbox envelope with only the minimum viable structural values.
Do not maintain a second hand-written deployment schema.

Inspect `jsonschema`'s `iter_errors` and structured `evaluate` results from the SDK-generated input schema.
The existing validator reports validity for a complete instance, not whether an incomplete instance can still become valid.
Use its constraints for supplied values and first classify missing, invalid, and deferred full-schema errors conservatively.
Add a bounded partial evaluator for required fields, references, alternatives, and conditionals only after the probe shows which distinctions error classification cannot prove.
Report a constraint as pending when a missing discriminator prevents evaluation; never silently accept an unknown condition.
Reject a supplied value as soon as its applicable constraint is known to fail.
When all required values are resolved, materialize through `Document::parse` so SDK semantic checks and normalization remain authoritative.

## Question guidance

`ask(field)` prompts even when the partial document supplies a valid value; that value is a suggestion.
An applicable missing field prompts by default, including optional fields in the supported question surface.
`omit(field)` leaves an absent optional field unset without a prompt.
Reject `omit` for a required or supplied field, and reject `ask` plus `omit` for the same field.
Fabric determines which native settings exist, apply, and are required; guidance only controls deliberate prompts and omissions.
Keep guidance for a currently unreachable adapter and warn in the tree preview instead of rejecting the journey; it may become reachable if the harness choice changes.
Re-evaluate the current state after every answer and after a descriptor or target change.
Keep independent answers and explain any dependent answer that reopens.

## Tree inspection

Build a deterministic, bounded symbolic question tree from the same resolver used by interactive authoring.
Branch on finite choices and on the omit choice for an optional question.
Represent free input as one valid-value branch and continue when later questions do not depend on its exact value.
When later branches depend on a free value, partition by known schema predicates or mark the branch as dependent on an answer; never present an incomplete branch as complete.
Show the SDK schema and Fabric catalog revisions, unsupported schema constructs, unresolved target evidence, repeated states, and truncation limits in the output.
The printed tree must not include arbitrary supplied native setting values; it may indicate that a suggestion exists.
Tree printing reads fixtures only and does not probe or apply resources.

## Delivery slices

1. **Schema probe and partial values.** Add behavioral tests for a missing required field, an invalid supplied value, and a conditional choice; observe them fail, then parse sparse values and report invalid versus pending without constructing `Document`.
2. **Journey definition.** Add a real base partial document with `ask` and `omit` guidance. Resolve the minimum viable values and fully supplied fixtures through the same API. Preserve current guided behavior while moving the example's policy into the new definition.
3. **Question resolver and tree printer.** Start with a bounded preview of identity, harness choices, and top-level adapter settings. Expand SDK and Fabric conditional branches through the same resolver used by interactive authoring rather than listing schema properties statically.
4. **Fabric and deployment coverage.** Incorporate adapter settings, model settings, and SDK deployment fields. Validate against the selected descriptor; retain an unverified result when no trusted descriptor is available.
5. **TUI integration.** Drive the example TUI from journey state and the shared next-question result. Retire the separate guided, setting, and deployment cursor loops after equivalent cases pass.

Each implementation slice starts with a failing behavioral test, then focused tests.
Before committing, run the workspace format, Clippy, and test gates required by `AGENTS.md`.
Keep each commit small and green.

## Inspection scenarios

| Scenario | Inspect in printed tree and state |
| --- | --- |
| Minimum viable values | Reach every applicable supported question; show optional omit branches and conditional Fabric questions. |
| Fully supplied | Zero configuration questions; SDK validation passes, while target compatibility is reported separately. |
| Existing example | Keep its deliberate onboarding prompts and suggestions without extra optional or prefilled-field screens. |
| Harness change | Drop inapplicable adapter questions; reopen incompatible dependent values; retain independent answers. |
| Unknown descriptor or target | Mark the branch unverified and explain the missing evidence rather than claiming compatibility. |

First inspect these outputs manually to find omissions or misleading branches.
Add assertions for agreed behavior before relying on the printer as a regression check.

Run `cargo run -p nemoclaw-authoring --example print_journey_tree` from the repository root to print the offline minimum-values, express, and guided previews.
The first preview shows an unresolved SDK frontier rather than claiming to enumerate all questions.
The express preview reports zero questions only in its inspected surface; model settings, deployment fields, and target compatibility still need coverage.

The prototype now also exposes `JourneyDefinition::start`, `JourneyState::answer`, and `JourneyState::resolve`.
Each open question reports whether a value is missing, deliberately asked, or invalid for its current field schema.
The tree printer uses this same resolver for its identity, harness, and top-level adapter-setting questions.
A supplied complete template can finish a guided journey through that surface and materialize an SDK document after its prompted answers and omissions.
The minimum-values case still stops at the unresolved SDK frontier.

## Prototype decisions and limits

- The SDK exposes a bounded YAML value parser so sparse authoring input uses the same syntax limits as complete documents.
- The first partial assessment preserves supplied values and classifies full-schema errors. A compound rule remains deferred unless branch errors prove that adding values cannot satisfy it. This classification is a probe, not the final partial evaluator.
- The first tree preview names its inspected surface and prints an unresolved SDK frontier. It does not yet qualify the complete journey or drive the TUI.
- Explicit omission guidance currently covers top-level optional adapter settings with an advertised schema. Conditional omissions need the later resolver slice.
- The tree preview redacts suggestion values because native settings may contain sensitive data.
- Invalid supplied SDK fields stay visible in the preview even when their paths are in the question surface. A harness without a schema in the current Fabric catalog is marked unverified, so the preview does not claim that no questions remain.
- The first mutable journey state keeps accepted answers and explicit omissions separate from supplied values. It preserves each adapter's settings while changing harnesses and recomputes active questions after every answer. Missing catalog schemas leave guidance in place with a warning.
- SDK materialization and journey completion are separate: a fully supplied document can be SDK-valid while explicit `ask` questions remain. The caller must also consider unresolved Fabric and target evidence before treating the journey as ready.
- The example TUI still uses the complete-document `Draft` and its guided, setting, route, and deployment cursors. Moving it to `JourneyState` requires those question sources to join the resolver so there is one answer state.

## Decisions to revisit after the prototype

- Whether the partial evaluator can cover the generated SDK schema constructs used by the supported single-sandbox journey without duplicating constraints.
- Which optional schema regions belong to the bounded onboarding question surface.
- Whether a journey that switches harness retains adapter-specific guidance for each possible harness or changes to another journey definition.
- Which terminal state should block authoring when SDK-valid YAML exists but Fabric or target compatibility is unverified.

Update the relevant design rule here when implementation evidence changes it; describe the reason and affected slice in that rule.
Do not keep a running activity journal.
