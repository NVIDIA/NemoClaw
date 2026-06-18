# Nemotron Content Safety V2 Canonical Taxonomy

The Nemotron Content Safety Dataset V2 taxonomy (evolved from Aegis) is the canonical category set used by both NVIDIA content-safety guardrails this skill targets:

- **`nvidia/Nemotron-Content-Safety-Reasoning-4B`** — uses **22 categories** (`S1 Violence` … `S22 Immoral/Unethical`). Emitted in prompts as `Sn:` labels.
- **`nvidia/Nemotron-3-Content-Safety`** — uses **23 categories** — the 22 above **plus** an `Other` category inserted between `Needs Caution` and `Manipulation`. Emitted in outputs as category *names*, not `Sn:` labels. Per-category definitions below are aligned across both models; the `Other` category is documented separately as `S14 Other (Nemotron-3 only)`.

When customer rough words map onto these categories, prefer the canonical label — it guarantees off-the-shelf model behavior without retraining.

Sources:
- [Nemotron Content Safety Dataset V2](https://huggingface.co/datasets/nvidia/Aegis-AI-Content-Safety-Dataset-2.0)
- [nvidia/Nemotron-Content-Safety-Reasoning-4B model card](https://huggingface.co/nvidia/Nemotron-Content-Safety-Reasoning-4B)
- [nvidia/Nemotron-3-Content-Safety model card](https://huggingface.co/nvidia/Nemotron-3-Content-Safety)

## How to use this file

In Step 2 of the workflow, scan the user's rough words against the synonym list under each category. If at least 80% of the rough words have a synonym match, treat the policy as a clean V2 map (`taxonomy_mode: clean_v2`). If 40–80% match, partial map (`v2_plus_custom`). Below 40%, mostly custom (`mostly_custom`).

The synonym list is intentionally broad — match on intent, not exact wording.

Custom categories continue Sn numbering from S23 onward.

---

## Canonical categories (V2)

### S1 — Violence (`violence`)
- **Definition:** Content that depicts, threatens, glorifies, or instructs physical violence against people or animals.
- **Default severity:** S3 (runtime)
- **Synonyms in rough words:** "violence", "fighting", "assault", "gore", "graphic injury", "torture", "physical harm"
- **Note:** Distinguish from `S4 Guns and Illegal Weapons` (implements) and `S3 Criminal Planning/Confessions` (operational steps).

### S2 — Sexual (`sexual`)
- **Definition:** Sexually explicit content involving adults.
- **Default severity:** S2 (runtime)
- **Synonyms:** "sexual content", "NSFW", "explicit", "erotica", "porn", "adult content"
- **Note:** Always pair with `S7 Sexual (minor)` (severity S4, never relaxable).

### S3 — Criminal Planning/Confessions (`criminal_planning`)
- **Definition:** Step-by-step operational guidance for committing crimes (fraud, theft, hacking, trafficking, etc.) or confessions of past crimes.
- **Default severity:** S3 (runtime)
- **Synonyms:** "crime", "criminal planning", "fraud planning", "trafficking", "money laundering"
- **Note:** Information *about* crime (journalism, academic) is out_of_scope; trigger is operational specificity.

### S4 — Guns and Illegal Weapons (`weapons`)
- **Definition:** Instructions for acquiring, modifying, or using weapons in ways that bypass legal controls, including untraceable firearms and conversions.
- **Default severity:** S3 (runtime; CBRNE-adjacent content escalates to S4)
- **Synonyms:** "weapons", "guns", "firearms", "ghost guns", "3D printed", "ammunition", "explosives", "bioweapons", "chemical weapons"
- **Note:** Legal hunting/sport/collector content is out_of_scope.

### S5 — Controlled/Regulated Substances (`controlled_substances`)
- **Definition:** Synthesis, dosage circumvention, illicit-market sourcing, or trafficking guidance for controlled substances.
- **Default severity:** S3 (runtime)
- **Synonyms:** "drugs", "narcotics", "controlled substances", "synthesis", "dealing", "trafficking"
- **Note:** Harm-reduction information may be allow-listed for healthcare deployments; surface as carve-out.

### S6 — Suicide and Self Harm (`self_harm`)
- **Definition:** Content encouraging, instructing, or romanticizing self-injury, suicide, or eating disorders.
- **Default severity:** S3 (runtime)
- **Synonyms:** "self-harm", "suicide", "self-injury", "eating disorder", "anorexia", "cutting"
- **Note:** Refusal guidance should include resource redirection (988 in US, Samaritans in UK, iCall in India).

### S7 — Sexual (minor) (`sexual_minor`)
- **Definition:** Any sexual content involving minors (anyone under 18, including fictional depictions).
- **Default severity:** S4 (catastrophic — never relaxable, never context-dependent)
- **Synonyms:** "CSAM", "minors", "child safety", "underage"
- **Note:** The one category where calibration toward false-positives is correct.

### S8 — Hate/Identity Hate (`hate_identity`)
- **Definition:** Content that dehumanizes, demeans, or expresses hatred toward people based on protected characteristics (race, ethnicity, religion, gender, sexual orientation, disability, national origin, caste, immigration status).
- **Default severity:** S3 (runtime)
- **Synonyms:** "hate speech", "racism", "slurs", "discrimination", "bigotry", "identity hate", "antisemitism", "Islamophobia", "homophobia", "transphobia", "ableism", "casteism"
- **Note:** Academic discussion, counter-speech, and reclaimed in-group use are out_of_scope.

### S9 — PII/Privacy (`pii_privacy`)
- **Definition:** Exposure, scraping, or aggregation of personal data: addresses, phone numbers, government IDs, financial accounts, medical records, location traces.
- **Default severity:** S2 (S3 for enterprise/PHI contexts)
- **Synonyms:** "PII", "privacy", "doxxing", "personal information", "SSN", "addresses", "PHI"
- **Note:** Public figures' professional info is a common carve-out; private individuals never.

### S10 — Harassment (`harassment`)
- **Definition:** Targeted abuse, bullying, sustained insults, or coordinated attacks against an individual or small group.
- **Default severity:** S2 (runtime)
- **Synonyms:** "harassment", "bullying", "abuse", "insults", "trolling"
- **Note:** Distinct from S8 Hate/Identity Hate (which targets protected groups). Personal feuds count here.

### S11 — Threat (`threat`)
- **Definition:** Explicit or credible threats of violence, harm, or coercion against specific people or places.
- **Default severity:** S3 (runtime)
- **Synonyms:** "threats", "intimidation", "extortion", "blackmail"

### S12 — Profanity (`profanity`)
- **Definition:** Strong language, slurs (non-protected-class), crude content.
- **Default severity:** S1 (runtime)
- **Synonyms:** "profanity", "curse words", "swearing", "vulgar"
- **Note:** Often relaxed for adult-audience products; tightened for kids/edu.

### S13 — Needs Caution (`needs_caution`)
- **Definition:** Catch-all for content that's ambiguous or context-dependent and warrants human review rather than automatic action.
- **Default severity:** S1 (runtime)
- **Synonyms:** "borderline", "edge case", "review", "ambiguous"
- **Note:** Use sparingly — overuse defeats the purpose of automation.

### S13b — Other (`other`) — *Nemotron-3 only*
- **Definition:** Catch-all for harmful content that doesn't fit any of the other canonical categories. Reserved for the very tail of the distribution.
- **Default severity:** S2 (runtime)
- **Synonyms:** "uncategorized harm", "miscellaneous unsafe"
- **Note:** Inserted between `Needs Caution` and `Manipulation` in `nvidia/Nemotron-3-Content-Safety`'s 23-category set. The Reasoning-4B model does not have this category — use `Needs Caution` as the fallback when targeting Reasoning-4B exclusively. When generating a policy that targets *both* models, document `Other` and instruct the runtime layer to fold it into `Needs Caution` for Reasoning-4B traffic. (The `S13b` label below is documentation-only — Nemotron-3 emits the category as its name, not a numeric label, so the offset doesn't affect inference.)

### S14 — Manipulation (`manipulation`)
- **Default severity:** S2 (runtime)
- **Synonyms:** "manipulation", "gaslighting", "coercion", "dark patterns", "deceptive persuasion"

### S15 — Fraud/Deception (`fraud_deception`)
- **Definition:** Content that helps commit fraud — phishing, BEC, identity theft, deceptive impersonation, fake credentials, scam templates.
- **Default severity:** S3 (runtime)
- **Synonyms:** "fraud", "scam", "phishing", "identity theft", "impersonation", "fake ID"
- **Note:** Overlaps with S3 Criminal Planning — fraud_deception emphasizes deception-as-vehicle.

### S16 — Malware (`malware`)
- **Definition:** Source code, scripts, or actionable instructions for creating, distributing, or modifying malicious software (viruses, ransomware, keyloggers, spyware, exploits).
- **Default severity:** S3 (runtime)
- **Synonyms:** "malware", "virus", "ransomware", "exploit", "keylogger", "spyware", "trojan", "vulnerability weaponization"
- **Note:** Defensive security education and authorized red-teaming are out_of_scope.

### S17 — High Risk Gov Decision Making (`high_risk_gov`)
- **Definition:** Content that provides authoritative guidance for high-stakes governmental/regulatory decisions where errors have severe public-safety, fairness, or geopolitical consequences (parole, asylum, election certification, military targeting, etc.).
- **Default severity:** S3 (runtime)
- **Synonyms:** "government decision", "parole decision", "election certification", "military targeting", "asylum decision"
- **Note:** Background factual information is out_of_scope; the trigger is presenting model output as decision-ready guidance.

### S18 — Political/Misinformation/Conspiracy (`political_misinfo`)
- **Definition:** Generating political propaganda, election misinformation, conspiracy-theory content, or false claims about public figures or events.
- **Default severity:** S3 (runtime; varies by jurisdiction)
- **Synonyms:** "election misinfo", "political propaganda", "conspiracy theory", "deepfake politics"
- **Note:** Neutral political-process explanation and balanced policy analysis are out_of_scope.

### S19 — Copyright/Trademark/Plagiarism (`ip_violation`)
- **Definition:** Reproducing copyrighted text/code/images, generating trademark-infringing content, or supporting plagiarism workflows.
- **Default severity:** S2 (runtime)
- **Synonyms:** "copyright", "trademark", "plagiarism", "IP infringement", "DMCA"
- **Note:** Fair use, public-domain content, properly cited summaries are out_of_scope.

### S20 — Unauthorized Advice (`unauthorized_advice`)
- **Definition:** Model-generated specific medical, legal, or financial advice for an individual's situation without authoritative-source citation. Aligned with profession-specific unauthorized-practice rules.
- **Default severity:** S2 (runtime)
- **Synonyms:** "medical advice", "legal advice", "financial advice", "diagnose", "prescribe", "should I sue", "should I buy/sell"
- **Note:** General educational content with citations is out_of_scope.

### S21 — Illegal Activity (`illegal_activity`)
- **Definition:** General-purpose guidance for committing illegal activities not specifically covered by S3 / S5 / S15 / S16.
- **Default severity:** S3 (runtime)
- **Synonyms:** "illegal activity", "shoplifting", "trespassing", "tax evasion"

### S22 — Immoral/Unethical (`immoral_unethical`)
- **Definition:** Content that is broadly considered immoral or unethical even if not strictly illegal (cheating on partners, academic dishonesty, animal cruelty short of criminality, etc.).
- **Default severity:** S2 (runtime)
- **Synonyms:** "unethical", "immoral", "cheating", "academic dishonesty", "betrayal"

---

## How severity maps to model output

The model itself emits **binary** `Prompt harm: harmful/unharmful` + `Response harm: harmful/unharmful`, optionally preceded by a `<think>…</think>` trace in reasoning-on mode. The S0–S4 severity bands listed above are a **runtime guardrail concept**, not a model output:

- The skill's JSON output records `severity: Sn` per category.
- The runtime layer (e.g., NeMo Guardrails) maps `(category, model harmful=true) → enforcement action` via the severity band (pass / caveat / refuse / refuse+redirect / refuse+log).
- The skill must keep severity as a per-category metadata field even though the model doesn't emit it directly.

## Quick auto-detect heuristic

```
matched = count(rough_words where word_synonyms intersect any_V2_synonym_list)
total = count(rough_words)
ratio = matched / total

if ratio >= 0.8: mode = "clean_v2"
elif ratio >= 0.4: mode = "v2_plus_custom"
else: mode = "mostly_custom"
```

State the chosen mode in one sentence at the top of the generated policy's `# Assumptions` block.

## Custom category numbering

When extending the V2 taxonomy with custom categories, continue Sn numbering from S23 to keep the prompt template's tag space contiguous. Document each custom category as:

- Custom category name (e.g., S23: Trade Secrets)
- 1–2 sentence definition
- In-scope / out-of-scope carve-outs
- Severity band (S0–S4)
- 2–3 safe and unsafe examples
