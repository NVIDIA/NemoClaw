# Policy archetypes by deployment context

Common deployment contexts come with predictable category emphases. When the user mentions one of these contexts, pre-seed the category list with the matching archetype, then let their rough words override or extend.

## Consumer chatbot (general purpose)
- All 13 Aegis categories at default severity
- Profanity often relaxed to S1 with no automatic block
- PII tightened: outbound (model emitting PII) more aggressive than inbound (user mentioning PII)

## Enterprise RAG over internal docs
- PII and confidentiality elevated (S3)
- Add custom: `trade_secret`, `competitive_intel`, `unreleased_product_info`
- Hate / sexual / self-harm categories usually low-volume but kept at default
- Add custom: `off_topic` (model refuses out-of-domain queries)

## Kids / education
- Sexual, sexual_minor, profanity all elevated
- Add custom: `age_inappropriate` (gambling, alcohol, tobacco references)
- Self-harm refusal must redirect to youth-specific resources (Crisis Text Line "HOME" to 741741 in US)
- Allow-list scientific discussion of anatomy, reproduction at age-appropriate level

## Healthcare / clinical
- Add custom: `medical_advice_unauthorized`, `diagnosis_claim`, `medication_dosage`
- Controlled_substances often *relaxed* for harm-reduction content (carve-out)
- Self_harm category needs clinician-grade response, not generic 988 redirect
- PII becomes HIPAA-aligned: PHI is a stricter superset

## Financial services
- Add custom: `investment_recommendation`, `regulated_advice`, `account_specific_advice`
- Hate / sexual / violence usually default
- Add custom: `market_manipulation`, `insider_info`
- Often paired with mandatory disclosure phrasing in the response guidance

## Code assistant / developer tools
- Weapons, controlled_substances, sexual: default but rarely hit
- Add custom: `malware`, `vulnerability_exploit`, `unauthorized_access_code`
- PII: model should not invent personal data in code examples
- Add custom: `license_violation` if the assistant generates code from copyrighted sources

## Government / sovereign deployment
- Jurisdiction notes are critical: EU AI Act categories, India IT Rules, etc.
- Add custom: `disinformation`, `election_interference`, `national_security_sensitive`
- Hate_identity definition often expanded to include local protected classes (caste in India, etc.)
- Severity model usually graded with explicit human-review tier

## Synthetic data / labeling rubric
- All categories present but with very tight `examples_safe` and `examples_unsafe` sets
- `edge_cases` field is the most important — labelers will reference it constantly
- Severity model usually binary (the rubric is for label generation, not runtime gating)

---

## How to use this file

When the user mentions a deployment context ("for our internal RAG product", "kids tutoring app", "healthcare bot"), match it to one of the archetypes above. Use the archetype's category list as your starting point, then:

1. Layer in any rough words the user gave that aren't already covered
2. Adjust severities based on user's stated risk tolerance
3. Note the archetype choice in the `# Assumptions` block ("Starting point: enterprise RAG archetype; customized for [user's vertical]")

If the user's context doesn't match any archetype, default to the consumer chatbot archetype and note it as a fallback.
