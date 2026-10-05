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
`omit(JourneyScope::ActiveAdapterSettings)` does the same for every absent optional setting of whichever harness is active; required, supplied, and invalid settings still follow the normal rules, and exact `ask` guidance still asks its setting.
Reject `omit` for a required or supplied field, reject other omit scopes, and reject `ask` plus `omit` for the same field or scope.
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

Each slice works within the bounded single-sandbox surface.
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

Run `cargo run -p nemoclaw-authoring --example print_journey_tree` from the repository root to print four offline previews:

| Preview | Input | Result |
| --- | --- | --- |
| Minimum viable values | One empty sandbox, with explicit `ask` guidance for the name. | Stops at an unresolved SDK frontier; it does not enumerate every question. |
| Minimum inline scaffold | `crates/nemoclaw-authoring/tests/fixtures/minimum-inline.yaml`: inline harness and inference forms, one route, and an external endpoint. | Asks the deployment, sandbox, agent, and route names, gateway management, harness, provider kind, and model. `minimally_supplied_inline_envelope_materializes_through_one_resolver` materializes it after those answers and explicit optional omissions. |
| Express | `examples/onboarding/openclaw.yaml`. | Zero questions, with absent optional adapter settings omitted through the `ActiveAdapterSettings` scope. Target compatibility remains a separate assessment. |
| Guided preview | The express template without a route model, with explicit `ask` guidance for the name, harness, runtime, provider, API, and model fields. | Asks each of those fields. |

Starting a journey generates a missing deployment uid, so the uid is never a question.
These previews do not establish complete coverage of arbitrary partial documents.

## Prototype decisions and limits

- The SDK exposes a bounded YAML value parser so sparse authoring input uses the same syntax limits as complete documents.
- The first partial assessment preserves supplied values and classifies full-schema errors. A compound rule remains deferred unless branch errors prove that adding values cannot satisfy it. The resolver can expand a `oneOf` with a shared required `const` discriminator directly from the SDK schema; this bounded case does not make the assessment a general partial evaluator.
- The tree preview names its inspected surface and prints an unresolved SDK frontier. It follows schema-derived finite choices, including gateway management, the external endpoint branch, and exclusive Sandbox, Agent, and Route forms, without a separate question implementation for those SDK branches. An empty sandbox asks whether to use an inline harness or `harnessRef` before exposing the inline harness kind. It does not enumerate every SDK conditional branch or every combination of independent choices; the TUI calls the mutable resolver after each answer.
- Explicit omission guidance covers absent optional SDK fields and adapter settings, either by exact field or through the `ActiveAdapterSettings` scope. SDK field omission is checked against the generated schema, including when a question scope would otherwise ask that field. The TUI also offers an omit action for optional questions, including native model settings.
- The tree preview redacts suggestion values and authored route names because supplied values may contain sensitive data.
- The tree header identifies the generated SDK input schema by SHA-256 and a catalog-backed Fabric snapshot by its source revision and exact serialized SHA-256. Harness-only capabilities report catalog provenance as unverified.
- Invalid supplied SDK scalar fields become editable questions even without explicit guidance and stay visible in the preview without printing their values. Optional invalid fields can be omitted. A harness without a schema in the current Fabric catalog is marked unverified, so the preview does not claim that no questions remain.
- The first mutable journey state keeps accepted answers and explicit omissions separate from supplied values. It preserves each adapter's settings while changing harnesses and recomputes active questions after every answer. An accepted answer reopened by a changed API, endpoint, or inference preset names that earlier answer in the question and TUI. Missing catalog schemas leave guidance in place with a warning.
- Guidance can ask SDK fields found through object properties, array items, references, and alternative schema branches. A field declared in a later branch stays in the definition and becomes applicable after the selecting answer; guidance for a field absent from every branch is rejected. The resolver preserves authored question order, validates each answer against that field schema, and can complete a partially supplied onboarding document. Missing unconditional scalar fields under known SDK object shapes become questions without guidance, including required leaves beneath an absent parent object. A `oneOf` whose branches share a required, distinct `const` discriminator yields a finite question and exposes required leaves of the selected branch. The resolver also recognizes two exclusive required-field forms directly or within `allOf`, including the sandbox's inline harness versus `harnessRef`. Other conditional alternatives and array structure remain unresolved frontiers.
- `inference:preset` is a guided question over the existing `ProviderPreset` profiles, not a desired-state field. Each selected route resolves its provider by reference. A changed preset updates that external provider's connection settings and the selected route's model suggestion. It preserves the provider name so every reference remains valid, and reopens model decisions on every route using that provider. An accepted matching preset preserves a supplied custom endpoint, credential, and model. Managed-service routes do not offer external presets. API answers belong to the provider; model answers belong to the selected route.
- Adapter settings: the resolver uses Fabric schema traversal for nested adapter settings and conditionals. When root adapter settings have alternatives without a discoverable discriminator, it asks for one schema-validated JSON object instead of declaring the settings unverified. An absent object remains a missing value, and an invalid supplied object is not offered as a suggestion.
- Guidance selectors: `JourneyDefinition::ask` accepts either an exact field or a schema-discovered `JourneyScope`; both use the same state and tree preview. Exact guidance can name nested adapter, workflow, and model settings; the active Fabric schema determines whether each applies or is required. Unreachable guidance is a warning, while an active required or supplied setting cannot be omitted.
- Native settings: the resolver validates them even without native prompt guidance. Supplied adapter and native values remain editable suggestions. `JourneyState::answer` can revisit accepted or omitted native settings using the active Fabric schema. Native workflow questions follow the selected harness before SDK completion; native model questions wait for the SDK's complete Fabric projection.
- References: the resolver follows `harnessRef` and `inferenceRef` to edit their named definitions without creating inline replacements.
- Deployment fields: guidance can review supplied values before unrelated required answers are complete. Once the SDK document is valid, the same field collector also offers SDK-filled defaults for review. Both cases use SDK field lookup for branch selection, answer schema, and requiredness. An optional supplied deployment value can be omitted interactively. A supplied deployment key that the SDK schema does not define becomes an optional question whose only answer is to remove the key.
- Answer safety: changing an SDK discriminator removes supplied fields that only the previous branch defined. An answer that would leave the journey unable to resolve is rejected and the state is unchanged.
- Route order: route selection runs after the selected route's model questions.
- SDK field choices are derived from finite schema alternatives. A runtime change fills a managed gateway engine only when the template did not supply one. An explicitly supplied engine remains authored intent.
- `JourneyState::resolve_with_evidence` combines endpoint model suggestions and target compatibility in one resolution used by the TUI for questions and review. Endpoint observations add model suggestions for the current route without restricting custom text. Bulk acceptance of remaining suggestions requires an accepted harness, current compatible engine and image observations, an advertised selected model, and observed credentials. Target evidence never changes the desired state.
- `AuthoringFacts` and `DiscoveryEvidence` exist only after the document is SDK-valid, because discovery reads its inputs from a `Document`. Target observations never change questions; only endpoint facts add model choices. Hardware and gateway observations are collected but do not affect questions or readiness yet.
- The TUI offers harness choices and settings schemas from the bundled Fabric catalog for the whole run. The selected image's catalog only feeds the target assessment, where a harness the image does not advertise is a conflict that blocks `ready_document`.
- SDK assessment and journey completion are separate: a fully supplied document can be SDK-valid while explicit `ask` questions remain. `JourneyResolution::materialized_document` returns the SDK document only when current questions are answered and Fabric schema gaps are cleared. A definition may additionally require compatible engine and image observations. `ready_document` rejects any observed target conflict and waits for compatible evidence when the definition requires it; unknown evidence otherwise remains unverified. Observations never change the authored document, and the TUI does not reject a runtime choice based on the author's workstation OS.
- The executable example TUI loads a sparse `PartialDocument`, runs `JourneyState`, and saves only its `ready_document` result. Resolver errors surface as errors rather than appearing to finish the questionnaire. The default-path and per-example TUI tests exercise this path.

## Alignment to the intended model

| Design decision | Prototype behavior | Remaining gap |
| --- | --- | --- |
| One journey definition combines sparse values and guidance | `JourneyDefinition` owns the partial document, exact field guidance, schema-discovered scopes, omissions, and an optional target compatibility prerequisite; it starts `JourneyState` and prints its bounded preview. | Conditional guidance and prerequisites beyond engine and image compatibility are not represented yet. |
| One run separates question selection from answer transitions | A read-only `QuestionResolver` discovers candidates and applies one prompting policy; typed question targets identify answer operations. `JourneyState::answer` validates and applies a decision, while `AuthoredValues`, `DecisionRecord`, and `JourneyPosition` own their respective state. The TUI uses this API for routes, native settings, deployment fields, and evidence-gated bulk acceptance. | Automatic discovery of every missing SDK requirement remains outside the bounded single-sandbox surface; guidance still addresses fields with string selectors. |
| Constraints come from SDK and Fabric | SDK field schemas validate asked values; Fabric schemas determine active settings and detect invalid native model combinations; `Document::parse` is the final SDK gate | The preset is curated authoring policy. SDK conditional branches without a shared required constant discriminator still need a partial evaluator. |
| Asked supplied values are suggestions | The resolver retains supplied values and asks for acceptance; explicit dependency changes name the answer that reopened a question | A changed external schema can invalidate a value without a specific earlier answer to name. |
| Visual inspection uses the same resolver | The tree prints current questions and branches over finite choices returned by the resolver | It still has an explicit unresolved frontier and cannot claim to enumerate the full journey. |

The TUI tests cover the default path, every single-sandbox example, mixed local and hosted routes, discovered model choices, and safe delegation; the authoring tests cover the minimum-inline journey. This implementation has not been qualified live against an explicitly configured bundle.

## Open design questions

The prototype has not settled these; the rules above stand until one is decided.

- **Partial evaluation:** can a partial evaluator cover the generated SDK schema constructs used by the single-sandbox journey without duplicating constraints?
- **Question surface:** which optional schema regions belong to the bounded onboarding question surface?
- **Harness changes:** when a journey switches harness, does it keep adapter-specific guidance for every harness, or change to another journey definition?
- **Unverified targets:** which terminal state should block authoring when SDK-valid YAML exists but Fabric or target compatibility is unverified?
- **Early target observation:** how can the target be observed before the document is SDK-valid, so the image catalog and environment can shape early choices such as harness, runtime, and engine?

When implementation settles a question, change the affected rule above and remove the question.
