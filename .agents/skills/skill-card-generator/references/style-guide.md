# Skill Card Style Guide

You are producing a filled skill card from the source files of an agent skill. Your output is a JSON **context** that is rendered by Jinja into the final card markdown; you do not author the card's layout. Your job is to decide what each context field should contain.

This guide defines every context field: its purpose, where to look for a value, what a good answer looks like, and common mistakes to avoid.

## The context object — keys at a glance

```
skill_name, skill_kind, description_sentence, usage_posture,
owner, license_identifier, use_case,
deployment_geography, references, output,
skill_version, evaluation
```

Every required key must be present. Lists may be empty. Strings may be `""` only if the field genuinely has no grounding in any source you were given. Otherwise write an informed value — even if uncertain — and mark it INFERRED in the review table. Writing "" or HUMAN-REQUIRED is a last resort, not a default.

`evaluation` is optional. Include it only when source evidence or user-provided context supports at least one evaluation field. If no evaluation evidence exists, omit `evaluation` entirely so the optional evaluation sections do not render.

## Verify markers (read this before filling in `owner` and `license_identifier`)

The rendered card uses an inline markdown convention to hand off uncertainty to the human reviewer without requiring a review UI. The same convention also makes it easy for a pre-submission validator script to fail CI if the reviewer forgot to resolve something.

- **Red VERIFY markers** — for fields where the value is inferred or defaulted and the reviewer must either confirm or correct before submission. Rendered as `<span style="color:#d73a49">value</span>` followed by an HTML comment of the form `<!-- VERIFY: reason -->`. The reviewer reads the red text, edits or keeps the value, then strips both the span and the comment.

You (the agent filling in context) control whether `owner` and `license_identifier` render with VERIFY markers (via the `owner.verify` and `license_verify` fields described below).

Known Risks and Mitigations are hardcoded in the template as boilerplate — no context input is needed.

## Where to look

Two scopes matter:

- **Skill scope** — the skill directory itself: the SKILL.md (with YAML frontmatter), the `references/` folder, any `scripts/`.
- **Repo scope** — the repo containing the skill. Skills living under `.agents/skills/<name>/` inherit licensing, versioning, and often other governance signals from the parent repo. The discovery output's **"Repo-root signals"** block surfaces these: LICENSE identifier, CHANGELOG top entry (version + date + release notes body), pyproject/package.json version, git tag and remote URL, README, SECURITY.md, docs index.

Prefer skill-scope signals when they conflict with repo-scope ones (the skill's own frontmatter is authoritative for `description`, for example), but for governance fields (license, version) the repo scope usually wins.

## Field-by-field

### `skill_name` (string)
The display name, title-cased.

Primary source: the `name` key in SKILL.md frontmatter, normalized to title case (e.g., `nemotron-voice-agent-deploy` → `Nemotron Voice Agent Deploy`). If the frontmatter has a `display_name` or the skill's H1 differs from the slug, prefer those.

### `skill_kind` (string)
`"Agent"` is the default. Use a different label only if the template author or the skill itself specifies one.

### `description_sentence` (string)
One sentence describing what the skill does. Prefer the `description` key in frontmatter verbatim. If absent, compose one sentence from the Overview or opening paragraph. Do not use more than one sentence. Do not invent capabilities the source doesn't claim.

### `usage_posture` (enum)
One of: `"commercial"`, `"research_dev"`, `"demonstration"`.

- `"commercial"` — the default for production/commercial/customer-facing skills and anything released under a permissive license without a research-only restriction.
- `"research_dev"` — the skill's docs explicitly say "research only", "not for production", or similar. Non-commercial licenses also point here.
- `"demonstration"` — the skill is a sample/tutorial/blueprint that explicitly warns against production use.

Read the full skill directory and the repo README before choosing. Don't default to the safest one out of caution — choose the one the source evidence supports.

### `owner` (object)
```
{"kind": "nvidia", "verify": false}             # NVIDIA-owned skill, high-confidence
{"kind": "nvidia", "verify": true,              # NVIDIA-owned by default, but inferred
 "verify_reason": "defaulted; no explicit ownership signal in repo"}
{"kind": "third_party", "verify": true,         # Third-party skill
 "name": "Vendor Name",
 "card_link": "https://...",
 "verify_reason": "inferred from repo host domain"}
```

Decide `kind`:
- `"nvidia"` if the author email is `@nvidia.com`, the repo is under an NVIDIA GitHub org (NVIDIA, NVIDIA-AI-Blueprints, etc.), or the content is primarily about NVIDIA products.
- `"third_party"` otherwise. Provide `name` and `card_link` when available; leave `card_link` empty string if unknown (validation will accept empty string; review table will flag it).

Decide `verify`:
- Set `verify: false` only when ownership is unambiguous — e.g., author email on `@nvidia.com`, repo under a known NVIDIA org, explicit `owner:` key in the skill's frontmatter, or a LICENSE/NOTICE naming NVIDIA Corporation.
- Set `verify: true` whenever the value is a default or an inference, including the `"nvidia"` fallback when no explicit ownership signal was found. Include a one-line `verify_reason` explaining what's uncertain so the reviewer doesn't have to re-derive it.

The rendered card wraps the displayed owner value in a red VERIFY span when `verify: true`. The reviewer either confirms (strips the span) or edits (rewrites the value and strips the span) before the pre-submission validator will pass.

### `license_identifier` (string or null)
Short license name as it would appear in a license-selector dropdown, not a file excerpt.

Primary source: `license_identifier` from the Repo-root signals block (parsed from the LICENSE file's first non-empty line). Fallback: a `license:` key in SKILL.md frontmatter, or a license header comment in a script. Examples: `"MIT"`, `"Apache 2.0"`, `"BSD 2-Clause"`, `"BSD 3-Clause"`, `"NVIDIA AI Foundation Models Community License"`.

Use `null` only if truly nothing was found. Do not write "TBD" or paraphrase license text.

### `license_verify` (bool) and `license_verify_reason` (string, optional)

Governance policy: **license is always human-verified unless the identifier was extracted verbatim from a documentation file.** Use `license_verify: false` only when the signal summary attributes the license to a LICENSE file, a NOTICE file, a license header in a script, or an explicit `license:` key in the skill's frontmatter. In any other case (inferred from a repo-name heuristic, inherited from a parent repo, guessed from a framework's typical license, or set to `null`), use `license_verify: true` and include a short `license_verify_reason`.

The rendered card wraps the displayed license in a red VERIFY span when `license_verify: true`. Reviewers are expected to confirm the exact license terms against whatever is authoritative for the skill before the pre-submission validator will pass.

### `use_case` (string)
One or two sentences: *who* uses the skill and *what they use it for*. The template asks for audience (Employees, External, Developers) plus task.

Draw from Overview, When-to-Use, or the skill's introductory material. Technical deployment/conversion/analysis skills almost always have "Developers and engineers" as the audience — write that rather than saying nothing. Non-trivial skills always have a describable purpose — write one, mark it INFERRED if uncertain.

### `deployment_geography` (string)
The template's default guidance: assume `"Global"` unless the skill's documentation restricts it. Use one of:

- `"Global"` — typical default.
- A region list, e.g. `"North America (NAM) and Europe, Middle East, and Africa (EMEA)"`.
- A specific country, if the skill states one.

This is a business/legal decision; reviewers may adjust it. Writing `"Global"` is the correct default, not a placeholder.

### `references` (list of `{label, url}`)
Technical documentation, model cards, papers, and reference material. Includes:
- Relative paths to files in the skill's `references/` folder (`url` is the relative path, `label` is the filename or H1 title).
- External URLs to blog posts, papers, or model cards that the skill body links to.
- Docs-folder URLs if the skill references them.

Do **not** include:
- Legal/process URLs.
- Every URL the skill happens to mention — keep it to genuine references.

### `output` (object)
```
{
  "types": ["Shell commands", "Configuration instructions"],
  "format": "Markdown with inline bash code blocks",
  "parameters": "1D",
  "other_properties": "None"
}
```

- `types` — high-level categories: `"Analysis"`, `"API Calls"`, `"Code"`, `"Files"`, `"Shell commands"`, `"Configuration instructions"`, etc.
- `format` — concrete format the output takes: `"String"`, `"JSON"`, `"Markdown"`, `"Markdown with inline bash code blocks"`, etc.
- `parameters` — dimension label: `"1D"` for single-stream output, rarely anything else.
- `other_properties` — post-processing details, token caps, or `"None"`.

### `skill_version` (string)
Format: `"<version> (source: <where>)"`.

Prefer in order:
1. `version:` in SKILL.md frontmatter → `"1.2.0 (source: frontmatter)"`
2. CHANGELOG top entry version → `"1.0.0 (source: changelog, released 2026-03-03)"`
3. `pyproject.toml` or `package.json` `version` → `"1.0.0 (source: pyproject.toml)"`
4. git tag from the signal summary's `git.describe` → `"v1.0.0 (source: git tag)"`
5. git SHA if no tag is available → `"bfcfc90 (source: git SHA, committed 2026-03-03)"` — write the SHA verbatim; do **not** fabricate a semver.

When multiple sources agree, cite them together: `"1.0.0 (source: pyproject.toml, CHANGELOG, git tag)"`. When they disagree, use the CHANGELOG version and flag the discrepancy in the review table.

### `evaluation` (object, optional)

Use only when evaluation details are grounded in evaluation docs, benchmark notes, red-team/security reports, validation logs, test output, or explicit user-provided context. Do not create placeholders for missing evaluation data; omit missing subfields. If no subfield can be grounded, omit the whole `evaluation` object.

Shape:

```
{
  "agents": [
    "Agent Name (`model-or-version`)"
  ],
  "tasks": "Evaluated against 3 internal skill directories.",
  "metrics": {
    "dimensions": [
      {
        "name": "Dimension name",
        "description": "What this reported benchmark dimension checks."
      }
    ],
    "signals": [
      {
        "name": "signal_name",
        "description": "What this underlying evaluation signal verifies."
      }
    ]
  },
  "results_markdown": "| Dimension | Num | Agent Name |\n|---|---:|---:|\n| Dimension name | 1 | 95% |",
  "testing_completed": {
    "agent_red_teaming": true,
    "network_security": false,
    "product_security": false
  }
}
```

- `agents` — list of agent display strings used for evaluation. Include versions or model identifiers when known, e.g. `"Agent Name (`model-version`)"`. For backward compatibility, a legacy string `agent` is still accepted.
- `tasks` — the dataset, task set, benchmark, or nature/size of internal evaluation cases.
- `metrics.dimensions` — reported benchmark dimensions and what each checks. Write clear descriptions of the items being checked, such as safety, correctness, discoverability, effectiveness, or efficiency criteria when those are actually used by the evaluation.
- `metrics.signals` — underlying evaluation signals and what each verifies, such as skill execution, routing quality, final-answer accuracy, goal completion, expected behavior checks, or token efficiency when those are actually present in the evaluation. For backward compatibility, a legacy string `metrics` is still accepted.
- `results_markdown` — a complete Markdown table copied or composed from the evaluation report. Include all listed metrics/dimensions and values. Do not use this field for prose; if there is no table-backed result, omit it.
- `testing_completed` — include only when all three explicit boolean values are known: `agent_red_teaming`, `network_security`, and `product_security`. `true` renders a checked row; `false` renders an unchecked row.

Prefer concise, evidence-backed prose. If the discovery output says no evaluation artifacts were detected and the user did not provide evaluation details, do not include this object.

## Cross-field consistency checks

Before finalizing the context, verify:

- **Owner vs. license**: an NVIDIA-owned skill typically has a permissive OSS license or NVIDIA community license. An Apache/MIT license on a `"third_party"` owner is fine; a proprietary license on `"nvidia"` is unusual.
- **`usage_posture` vs. `deployment_geography`**: `"research_dev"` is usually Global; commercial skills may have regional restrictions.

## What goes in the review table

For every required context key, emit a row with: Section (card section name), Field (context key), Confidence (`HIGH` / `INFERRED` / `HUMAN-REQUIRED`), Review Needed (`Yes` / `No`), Reasoning (short sentence), Source Files (comma-separated relative paths, or `None`). If `evaluation` is present, emit rows for its populated subfields.

Rules:
- `HIGH` when the value is copied verbatim or structurally from a specific source (frontmatter key, LICENSE file, explicit URL).
- `INFERRED` for paraphrases, classifications, or values derived from multiple signals.
- `HUMAN-REQUIRED` only when the field genuinely cannot be sourced and you set it to a placeholder.
- Review Needed is `Yes` for `INFERRED` and `HUMAN-REQUIRED`, `No` for `HIGH`.

## Workflow summary

1. Run the discovery script and read its output top-to-bottom.
2. Build the context JSON field by field, using this guide.
3. Validate cross-field consistency.
4. Run the render script to produce the card.
5. Author the review table alongside the rendered card.