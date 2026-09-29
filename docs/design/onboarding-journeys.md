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

`JourneyDefinition` owns the sparse template and its question guidance.
The minimum-inline fixture fixes topology in the partial document; the definition's guidance decides which supplied values to revisit, and `JourneyState` derives missing leaf questions from the SDK and Fabric schemas.
The example TUI and tree preview start the same `JourneyState` resolver from it.
A resolved question identifies its domain kind so terminal presentation can request model discovery and offer custom model text without inferring meaning from a document path.
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
5. **TUI integration.** Move question selection into authoring, then drive the example TUI from journey state and the shared next-question result. Retire the separate guided, setting, and deployment cursor loops after equivalent cases pass.

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

Run `cargo run -p nemoclaw-authoring --example print_journey_tree` from the repository root to print the offline structural-frontier, minimum-inline, express, and guided previews.
The first preview shows an unresolved SDK frontier rather than claiming to enumerate all questions.
The checked-in `crates/nemoclaw-authoring/tests/fixtures/minimum-inline.yaml` supplies inline harness and inference forms, one route, and an external endpoint while leaving identity, gateway management, harness, provider kind, route name, and model unanswered. It materializes through one resolver after those answers and explicit optional omissions; the example TUI also completes it through the watchable replay.
The express preview reports zero questions only in its inspected surface; model settings, deployment fields, and target compatibility still need coverage.

The prototype now also exposes `JourneyDefinition::start`, `JourneyState::answer`, and `JourneyState::resolve`.
Each open question reports whether a value is missing, deliberately asked, or invalid for its current field schema.
The tree printer uses this same resolver for every current question and follows finite choices through `JourneyState::answer`, with explicit branch and depth limits.
A supplied complete template can finish a guided journey through that surface and materialize an SDK document after its prompted answers and omissions.
The minimum-values case still stops at the unresolved SDK frontier.

## Prototype decisions and limits

- The SDK exposes a bounded YAML value parser so sparse authoring input uses the same syntax limits as complete documents.
- The first partial assessment preserves supplied values and classifies full-schema errors. A compound rule remains deferred unless branch errors prove that adding values cannot satisfy it. The resolver can expand a `oneOf` with a shared required `const` discriminator directly from the SDK schema; this bounded case does not make the assessment a general partial evaluator.
- The tree preview names its inspected surface and prints an unresolved SDK frontier. It follows schema-derived finite choices, including gateway management, the external endpoint branch, and exclusive Sandbox, Agent, and Route forms, without a separate question implementation for those SDK branches. An empty sandbox asks whether to use an inline harness or `harnessRef` before exposing the inline harness kind. It does not enumerate every SDK conditional branch or every combination of independent choices; the TUI calls the mutable resolver after each answer.
- Explicit omission guidance covers optional adapter settings. The TUI also offers an omit action for optional questions, including native model settings.
- The tree preview redacts suggestion values and authored route names because supplied values may contain sensitive data.
- The tree header identifies the generated SDK input schema by SHA-256 and a catalog-backed Fabric snapshot by its source revision and exact serialized SHA-256. Harness-only capabilities report catalog provenance as unverified.
- Invalid supplied SDK scalar fields become editable questions even without explicit guidance and stay visible in the preview without printing their values. Optional invalid fields can be omitted. A harness without a schema in the current Fabric catalog is marked unverified, so the preview does not claim that no questions remain.
- The first mutable journey state keeps accepted answers and explicit omissions separate from supplied values. It preserves each adapter's settings while changing harnesses and recomputes active questions after every answer. Missing catalog schemas leave guidance in place with a warning.
- Guidance can ask SDK fields found through object properties, array items, and references in the generated input schema. The resolver preserves authored question order, validates each answer against that field schema, and can complete a partially supplied onboarding document. The earlier `Draft` guide and projection have been removed. Missing unconditional scalar fields under known SDK object shapes become questions without guidance, including required leaves beneath an absent parent object. A `oneOf` whose branches share a required, distinct `const` discriminator yields a finite question and exposes required leaves of the selected branch. The resolver also recognizes two exclusive required-field forms directly or within `allOf`, including the sandbox's inline harness versus `harnessRef`. Other conditional alternatives and array structure remain unresolved frontiers.
- `inference:preset` is a guided question over the existing `ProviderPreset` profiles, not a desired-state field. Each selected route resolves its provider by reference. A preset changes only that external provider and route; an accepted matching preset preserves a supplied custom endpoint, credential, and model. Managed-service routes do not offer external presets. API and model answers remain specific to the selected route.
- The sparse resolver uses Fabric schema traversal for nested adapter settings and conditionals. `JourneyDefinition::ask` accepts either an exact field or a schema-discovered `JourneyScope`; both use the same state and tree preview. Supplied adapter and native values remain editable suggestions. The resolver follows `harnessRef` and `inferenceRef` to edit their named definitions without creating inline replacements. Deployment questions use SDK schema traversal after the document is SDK-valid. Route selection runs after the selected route's model questions.
- SDK field choices are derived from finite schema alternatives. A runtime change fills a managed gateway engine only when the template did not supply one. An explicitly supplied engine remains authored intent.
- Endpoint observations add model suggestions for the current route without restricting custom text. Bulk acceptance of remaining suggestions requires current compatible engine and image observations, an advertised selected model, and observed credentials. Target evidence never changes the desired state.
- SDK assessment and journey completion are separate: a fully supplied document can be SDK-valid while explicit `ask` questions remain. `JourneyResolution::materialized_document` returns the SDK document only when current questions are answered and Fabric schema gaps are cleared. A definition may additionally require compatible engine and image observations. `ready_document` then waits for current compatible evidence; the observations never change the authored document.
- The executable example TUI loads a sparse `PartialDocument`, runs `JourneyState`, and saves only its materialized SDK document. The repeatable tmux replay and single-sandbox example tests exercise this path.

## Alignment to the intended model

| Design decision | Prototype behavior | Remaining gap |
| --- | --- | --- |
| One journey definition combines sparse values and guidance | `JourneyDefinition` owns the partial document, exact field guidance, schema-discovered scopes, omissions, and an optional target compatibility prerequisite; it starts `JourneyState` and prints its bounded preview. | Conditional guidance and prerequisites beyond engine and image compatibility are not represented yet. |
| One resolver owns question selection and answers | The executable TUI uses `JourneyState` for every question and answer, including routes, native settings, deployment fields, and evidence-gated bulk acceptance | Automatic discovery of every missing SDK requirement remains outside the bounded single-sandbox surface. |
| Constraints come from SDK and Fabric | SDK field schemas validate asked values; Fabric schemas determine active settings and detect invalid native model combinations; `Document::parse` is the final SDK gate | The preset is curated authoring policy. SDK conditional branches without a shared required constant discriminator still need a partial evaluator. |
| Asked supplied values are suggestions | The resolver retains supplied values and asks for acceptance | Reopened questions identify their state, but do not yet explain which earlier answer changed them. |
| Visual inspection uses the same resolver | The tree prints current questions and branches over finite choices returned by the resolver | It still has an explicit unresolved frontier and cannot claim to enumerate the full journey. |

The direct suite covers the default and minimum-inline replays, complete single-sandbox examples, mixed local and hosted routes, discovered model choices, and safe delegation. The earlier pinned live Fabric qualification belongs to its recorded revision; this implementation still needs live requalification against an explicitly configured bundle.

## Decisions to revisit after the prototype

- Whether the partial evaluator can cover the generated SDK schema constructs used by the supported single-sandbox journey without duplicating constraints.
- Which optional schema regions belong to the bounded onboarding question surface.
- Whether a journey that switches harness retains adapter-specific guidance for each possible harness or changes to another journey definition.
- Which terminal state should block authoring when SDK-valid YAML exists but Fabric or target compatibility is unverified.

Update the relevant design rule here when implementation evidence changes it; describe the reason and affected slice in that rule.
Do not keep a running activity journal.
