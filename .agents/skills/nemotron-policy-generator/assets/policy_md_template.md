# {{POLICY_NAME}}

**Version:** {{VERSION}}
**Date:** {{DATE}}
**Owner:** {{OWNER}}
**Target model(s):** {{TARGET_MODELS}}
**Intended use cases:** {{USE_CASES}}
**Taxonomy mode:** {{TAXONOMY_MODE}}  <!-- clean_v2 | v2_plus_custom | mostly_custom -->

## Assumptions

{{ASSUMPTIONS_BLOCK}}
<!-- One bullet per assumption. Examples:
- Deployment: consumer chat, EN-US, US jurisdiction
- Severity model: graded S0–S4 (chosen because runtime guardrails require it)
- Modality: text-only (NCS, not NCS-VL)
- Starting archetype: consumer chatbot
- 9 of 12 rough words mapped cleanly to Aegis; 3 added as custom categories
-->

## Allow-list (explicit affordances)

What this policy explicitly *permits* even when it sounds adjacent to a blocked category. Misses in this section are the #1 source of false-positive blocks.

{{ALLOW_LIST}}

## Refusal & response guidance

{{RESPONSE_GUIDANCE}}
<!-- For each severity band, how the model should respond:
- S0 (safe): proceed normally
- S1: proceed with caveat
- S2: refuse + brief explanation
- S3: refuse + redirect to resources where applicable (e.g., 988 for self-harm)
- S4: refuse + log for human review
-->

## Jurisdiction / locale notes

{{JURISDICTION}}

## Calibration notes

{{CALIBRATION}}
<!-- Customer's stated tolerance for false-positives vs. false-negatives.
e.g., "Prioritize recall on S3+ even at cost of precision; S1-S2 should optimize for user experience." -->

---

## Categories

{{CATEGORY_BLOCKS}}

<!-- Each category follows this template:

### {{N}}. {{display_name}} (`{{name}}`)

**Severity:** {{severity}} | **Custom:** {{custom}}

**Definition:** {{definition}}

**In scope:**
- {{in_scope_bullet_1}}
- {{in_scope_bullet_2}}

**Out of scope (carve-outs):**
- {{out_of_scope_bullet_1}}
- {{out_of_scope_bullet_2}}

**Safe examples (should NOT trigger):**
1. {{safe_example_1}}
2. {{safe_example_2}}

**Unsafe examples (clear violations):**
1. {{unsafe_example_1}}
2. {{unsafe_example_2}}

**Edge cases:**
- *{{edge_case_1}}* — Resolution: {{resolution_1}}. Reasoning: {{reasoning_1}}.

**Modality notes:** {{modality_notes}}
-->

---

## CoT-specific rules (NCS-Reasoning only)

{{COT_RULES}}
<!-- Omit this section entirely if the policy is not for NCS-Reasoning. -->

## Change log

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| {{VERSION}} | {{DATE}} | {{OWNER}} | Initial draft generated from rough words by nemotron-policy-generator skill. |
