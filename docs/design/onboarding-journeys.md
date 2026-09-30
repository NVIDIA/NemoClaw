<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onboarding Journey Prototype

This is a design for an authoring prototype, not a deployment support claim.
The [accepted scope](scope.md) remains authoritative for SDK, Fabric, and target responsibilities.

## Goal

One Rust journey definition combines a partial desired-state document with guidance about which decisions to ask for or omit.
The authoring library resolves questions using SDK and Fabric schemas, then produces an SDK document only when required decisions are complete.
The example TUI and tree printer consume the same resolver.
No separate journey YAML format is needed for this prototype.

## Domain model

The [authoring domain model](authoring-domain.md) defines the concepts, ownership, answer transitions, and validation gates implemented by this prototype.
Use it to distinguish reusable journey configuration from a mutable run and its computed resolution.
This page owns the design choices, supported surface, and inspection criteria.

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
The resolver checks active native settings even when the definition gives no native prompt guidance.
Keep guidance for a currently unreachable SDK or adapter field and warn in the tree preview instead of rejecting the journey when the field exists in another valid schema branch; it may become reachable after another answer or catalog change. Reject guidance for a field absent from every SDK branch.
Re-evaluate the current state after every answer and after a descriptor or target change.
Keep independent answers and explain any dependent answer that reopens.
When both the selected route's inference API and model are open, present the API first; either active question may still be answered directly.

## Tree inspection

Build a deterministic, bounded symbolic question tree from the same resolver used by interactive authoring.
Branch on finite choices and on the omit choice for an optional question.
Represent free input as one valid-value branch and continue when later questions do not depend on its exact value.
When later branches depend on a free value, partition by known schema predicates or mark the branch as dependent on an answer; never present an incomplete branch as complete.
Show the SDK schema and Fabric catalog revisions, unsupported schema constructs, unresolved target evidence, repeated states, and truncation limits in the output.
The printed tree must not include arbitrary supplied native setting values; it may indicate that a suggestion exists.
Tree printing reads fixtures only and does not probe or apply resources.

## Delivery status

| Slice | Implemented | Remaining work |
| --- | --- | --- |
| Schema probe and partial values | Safe sparse parsing and conservative missing, invalid, and deferred assessment using the SDK schema. | A broader partial evaluator for unresolved SDK constructs. |
| Journey definition | Sparse base, exact and scope guidance, explicit omissions, and target prerequisites. | Additional prerequisite types and a decision on broader optional surfaces. |
| Shared resolver and tree printer | One resolver and answer API for TUI and bounded symbolic inspection. | Broader structural traversal and free-value branch analysis. |
| Fabric and deployment coverage | Adapter, workflow, model, and deployment questions under their owner schemas. | Native model questions before complete SDK projection; complete partial-document coverage. |
| TUI integration | The example uses the new state and resolver for question selection, answers, review, and delegation. | Live requalification against an explicitly configured bundle. |

The original five slices have working implementations within the bounded single-sandbox surface.
The limits below define what broader coverage still requires.

## Inspection scenarios

| Scenario | Inspect in printed tree and state |
| --- | --- |
| Minimum viable values | Reach every applicable supported question; show optional omit branches and conditional Fabric questions. |
| Fully supplied | Zero configuration questions; SDK validation passes, while target compatibility is reported separately. |
| Existing example | Keep deliberate prompts and suggestions; include additional applicable settings selected by the definition's scopes. |
| Harness change | Drop inapplicable adapter questions; reopen incompatible dependent values; retain independent answers. |
| Unknown descriptor or target | Mark the branch unverified and explain the missing evidence rather than claiming compatibility. |

First inspect these outputs manually to find omissions or misleading branches.
Add assertions for agreed behavior before relying on the printer as a regression check.

Run `cargo run -p nemoclaw-authoring --example print_journey_tree` from the repository root to print the offline structural-frontier, minimum-inline, express, and guided previews.
The first preview shows an unresolved SDK frontier rather than claiming to enumerate all questions.
The checked-in `crates/nemoclaw-authoring/tests/fixtures/minimum-inline.yaml` supplies inline harness and inference forms, one route, and an external endpoint while leaving identity, gateway management, harness, provider kind, route name, and model unanswered. It materializes through one resolver after those answers and explicit optional omissions; the example TUI also completes it through the watchable replay.
The express preview reports zero questions for its current single-sandbox document. The resolver checks native model settings without prompt guidance; target compatibility remains a separate assessment. This preview does not establish complete coverage of arbitrary partial documents.

The prototype now also exposes `JourneyDefinition::start`, `JourneyState::answer`, and `JourneyState::resolve`.
Each open question reports whether a value is missing, deliberately asked, or invalid for its current field schema.
The tree printer uses this same resolver for every current question and follows finite choices through `JourneyState::answer`, with explicit branch and depth limits.
A supplied complete template can finish a guided journey through that surface and materialize an SDK document after its prompted answers and omissions.
The minimum-values case still stops at the unresolved SDK frontier.

## Prototype decisions and limits

- The SDK exposes a bounded YAML value parser so sparse authoring input uses the same syntax limits as complete documents.
- The first partial assessment preserves supplied values and classifies full-schema errors. A compound rule remains deferred unless branch errors prove that adding values cannot satisfy it. The resolver can expand a `oneOf` with a shared required `const` discriminator directly from the SDK schema; this bounded case does not make the assessment a general partial evaluator.
- The tree preview names its inspected surface and prints an unresolved SDK frontier. It follows schema-derived finite choices, including gateway management, the external endpoint branch, and exclusive Sandbox, Agent, and Route forms, without a separate question implementation for those SDK branches. An empty sandbox asks whether to use an inline harness or `harnessRef` before exposing the inline harness kind. It does not enumerate every SDK conditional branch or every combination of independent choices; the TUI calls the mutable resolver after each answer.
- Explicit omission guidance covers absent optional SDK fields and adapter settings. SDK field omission is checked against the generated schema, including when a question scope would otherwise ask that field. The TUI also offers an omit action for optional questions, including native model settings.
- The tree preview redacts suggestion values and authored route names because supplied values may contain sensitive data.
- The tree header identifies the generated SDK input schema by SHA-256 and a catalog-backed Fabric snapshot by its source revision and exact serialized SHA-256. Harness-only capabilities report catalog provenance as unverified.
- Invalid supplied SDK scalar fields become editable questions even without explicit guidance and stay visible in the preview without printing their values. Optional invalid fields can be omitted. A harness without a schema in the current Fabric catalog is marked unverified, so the preview does not claim that no questions remain.
- The first mutable journey state keeps accepted answers and explicit omissions separate from supplied values. It preserves each adapter's settings while changing harnesses and recomputes active questions after every answer. An accepted answer reopened by a changed API, endpoint, or inference preset names that earlier answer in the question and TUI. Missing catalog schemas leave guidance in place with a warning.
- Guidance can ask SDK fields found through object properties, array items, references, and alternative schema branches. A field declared in a later branch stays in the definition and becomes applicable after the selecting answer; guidance for a field absent from every branch is rejected. The resolver preserves authored question order, validates each answer against that field schema, and can complete a partially supplied onboarding document. The earlier `Draft` guide and projection have been removed. Missing unconditional scalar fields under known SDK object shapes become questions without guidance, including required leaves beneath an absent parent object. A `oneOf` whose branches share a required, distinct `const` discriminator yields a finite question and exposes required leaves of the selected branch. The resolver also recognizes two exclusive required-field forms directly or within `allOf`, including the sandbox's inline harness versus `harnessRef`. Other conditional alternatives and array structure remain unresolved frontiers.
- `inference:preset` is a guided question over the existing `ProviderPreset` profiles, not a desired-state field. Each selected route resolves its provider by reference. A changed preset updates that external provider's connection settings and the selected route's model suggestion. It preserves the provider name so every reference remains valid, and reopens model decisions on every route using that provider. An accepted matching preset preserves a supplied custom endpoint, credential, and model. Managed-service routes do not offer external presets. API answers belong to the provider; model answers belong to the selected route.
- The sparse resolver uses Fabric schema traversal for nested adapter settings and conditionals. When root adapter settings have alternatives without a discoverable discriminator, it asks for one schema-validated JSON object instead of declaring the settings unverified; an absent object remains a missing value, and an invalid supplied object is not offered as a suggestion. `JourneyDefinition::ask` accepts either an exact field or a schema-discovered `JourneyScope`; both use the same state and tree preview. Exact guidance can name nested adapter, workflow, and model settings; the active Fabric schema determines whether each applies or is required. Unreachable guidance is a warning, while an active required or supplied setting cannot be omitted. Native settings are validated even without native prompt guidance. Supplied adapter and native values remain editable suggestions. Accepted or omitted native settings can be revisited through `JourneyState::answer`, using the active Fabric schema. The resolver follows `harnessRef` and `inferenceRef` to edit their named definitions without creating inline replacements. Deployment guidance can review supplied values before unrelated required answers are complete. Once the SDK document is valid, the same field collector also offers SDK-filled defaults for review. Both cases use SDK field lookup for branch selection, answer schema, and requiredness. Native workflow questions also follow the selected harness before SDK completion; native model questions wait for the SDK's complete Fabric projection. An optional supplied deployment value can be omitted interactively. Route selection runs after the selected route's model questions.
- SDK field choices are derived from finite schema alternatives. A runtime change fills a managed gateway engine only when the template did not supply one. An explicitly supplied engine remains authored intent.
- `JourneyState::resolve_with_evidence` combines endpoint model suggestions and target compatibility in one resolution used by the TUI for questions and review. Endpoint observations add model suggestions for the current route without restricting custom text. Bulk acceptance of remaining suggestions requires current compatible engine and image observations, an advertised selected model, and observed credentials. Target evidence never changes the desired state.
- SDK assessment and journey completion are separate: a fully supplied document can be SDK-valid while explicit `ask` questions remain. `JourneyResolution::materialized_document` returns the SDK document only when current questions are answered and Fabric schema gaps are cleared. A definition may additionally require compatible engine and image observations. `ready_document` rejects any observed target conflict and waits for compatible evidence when the definition requires it; unknown evidence otherwise remains unverified. Observations never change the authored document, and the TUI does not reject a runtime choice based on the author's workstation OS.
- The executable example TUI loads a sparse `PartialDocument`, runs `JourneyState`, and saves only its `ready_document` result. Resolver errors surface as errors rather than appearing to finish the questionnaire. The repeatable tmux replay and single-sandbox example tests exercise this path.

## Alignment to the intended model

| Design decision | Prototype behavior | Remaining gap |
| --- | --- | --- |
| One journey definition combines sparse values and guidance | `JourneyDefinition` owns the partial document, exact field guidance, schema-discovered scopes, omissions, and an optional target compatibility prerequisite; it starts `JourneyState` and prints its bounded preview. | Conditional guidance and prerequisites beyond engine and image compatibility are not represented yet. |
| One run separates question selection from answer transitions | A read-only `QuestionResolver` discovers candidates and applies one prompting policy; typed question targets identify answer operations. `JourneyState::answer` validates and applies a decision, while `AuthoredValues`, `DecisionRecord`, and `JourneyPosition` own their respective state. The TUI uses this API for routes, native settings, deployment fields, and evidence-gated bulk acceptance. | Automatic discovery of every missing SDK requirement remains outside the bounded single-sandbox surface; guidance still addresses fields with string selectors. |
| Constraints come from SDK and Fabric | SDK field schemas validate asked values; Fabric schemas determine active settings and detect invalid native model combinations; `Document::parse` is the final SDK gate | The preset is curated authoring policy. SDK conditional branches without a shared required constant discriminator still need a partial evaluator. |
| Asked supplied values are suggestions | The resolver retains supplied values and asks for acceptance; explicit dependency changes name the answer that reopened a question | A changed external schema can invalidate a value without a specific earlier answer to name. |
| Visual inspection uses the same resolver | The tree prints current questions and branches over finite choices returned by the resolver | It still has an explicit unresolved frontier and cannot claim to enumerate the full journey. |

The direct suite covers the default and minimum-inline replays, complete single-sandbox examples, mixed local and hosted routes, discovered model choices, and safe delegation. The earlier pinned live Fabric qualification belongs to its recorded revision; this implementation still needs live requalification against an explicitly configured bundle.

## Remaining work

- Whether the partial evaluator can cover the generated SDK schema constructs used by the supported single-sandbox journey without duplicating constraints.
- Which optional schema regions belong to the bounded onboarding question surface.
- Whether a journey that switches harness retains adapter-specific guidance for each possible harness or changes to another journey definition.
- Which terminal state should block authoring when SDK-valid YAML exists but Fabric or target compatibility is unverified.

Update the relevant design rule here when implementation evidence changes it; describe the reason and affected slice in that rule.
Do not keep a running activity journal.
