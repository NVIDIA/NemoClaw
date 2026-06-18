---
name: "skill-card-generator"
description: "Use only to generate or update a governance skill card for a specified existing agent skill directory. Do not use for explaining, listing, comparing, or discussing skill capabilities."
license: CC-BY-4.0 AND Apache-2.0
compatibility: "Any agent that can run Python scripts and write files"
metadata:
  author: "Trustworthy AI Projects <trustworthyaiprojects@nvidia.com>"
  tags:
    - skill-card
    - governance
    - documentation
    - trustworthy-ai
  domain: documentation
permissions:
  file_read:
    - "target_skill_directory"
    - "references/"
    - "scripts/"
  file_write:
    - "target_skill_directory"
    - "/tmp/"
  shell:
    allowed_scripts:
      - "scripts/discover_assets.py"
      - "scripts/render_card.py"
      - "scripts/validate_submission.py"
---

# Generate Skill Card

**Skill directory to analyze**: $ARGUMENTS

## Purpose

Create a draft NVIDIA governance skill card for an existing agent skill. The skill gathers source signals, guides the agent to build a grounded JSON context, renders a deterministic markdown card, and checks that human-review markers were removed before submission.

Use this when:
- A skill directory already exists and needs a new governance card.
- A changed skill needs its existing card refreshed.
- A skill owner is preparing NVCARPS or legal/safety review material.

Do NOT use for:
- Explaining, listing, comparing, or discussing skills or skill capabilities.
- Creating or rewriting the source skill itself.
- Generating cards for non-skill assets such as models, datasets, containers, or full systems.
- Signing, publishing, or approving a skill card.
- Replacing required human legal, safety, or owner review.

## Prerequisites

- Python 3 is available.
- `jinja2` is installed before running `render_card.py`.
- The target path is a skill directory containing `SKILL.md` or `skill.md`.
- The agent can write a temporary context JSON file and the rendered card output.
- Runtime permissions allow reads from `target_skill_directory` plus this skill's `references/` and `scripts/`, writes only to the target skill directory or `/tmp/`, and shell execution only for the three scripts listed below.

## Instructions

1. First, read this `SKILL.md` completely before running any script.
2. Resolve the target skill directory from `$ARGUMENTS`; if omitted, use the current working directory.
3. Stay within the declared permission scope. Do not read `.env`, credential files, hidden auth folders, or unrelated repo files; do not write outside the target skill directory or `/tmp/`.
4. Run `scripts/discover_assets.py` against the target. Use the structured signal summary first; if output is truncated, read only targeted files or small excerpts.
5. Build a context JSON file from the structured signal summary first, then from extracted file contents only when needed.
6. Follow `references/style-guide.md` for every context field. Use `HUMAN-REQUIRED` only when no source supports a truthful value.
7. Render the card with `scripts/render_card.py` and fix any schema errors before proceeding.
8. Review the card manually, remove resolved VERIFY and SELECT markers, then run `scripts/validate_submission.py`.
9. Before finishing, confirm the rendered card has no unrendered `{{ ... }}` or `{% ... %}` template fragments.

## Available Scripts

| Script | Purpose | Arguments |
| --- | --- | --- |
| `scripts/discover_assets.py` | Extracts skill files, repo signals, style guide, and template into one discovery report. | `<skill_directory>` |
| `scripts/render_card.py` | Validates context JSON and renders the skill card from the Jinja template. | `--context <context.json> --template <skill-card.md.j2> --out <output.md>` |
| `scripts/validate_submission.py` | Fails if the rendered card still contains VERIFY or SELECT review markers. | `<rendered-card.md>` |

## Examples

Discover signals for a target skill:

```text
run_script("scripts/discover_assets.py", args=["/path/to/target-skill"])
```

Render a card from the completed context:

```text
run_script(
  "scripts/render_card.py",
  args=[
    "--context", "/tmp/target-skill-context.json",
    "--template", "references/skill-card.md.j2",
    "--out", "/path/to/target-skill/target-skill-card.md"
  ]
)
```

Validate the reviewed card before submission:

```text
run_script("scripts/validate_submission.py", args=["/path/to/target-skill/target-skill-card.md"])
```

## Limitations

- The generated card is a draft and must be reviewed by a human owner.
- Discovery is limited to local files and repo metadata visible from the target path.
- The renderer validates required context shape, not the legal or safety correctness of field values.
- Canned limitation and risk catalogs are starting points; remove entries that do not apply.

## Troubleshooting

| Error | Cause | Solution |
| --- | --- | --- |
| `directory not found` | The target path is wrong or not mounted in the workspace. | Re-run discovery with the absolute path to the skill directory. |
| `jinja2 not installed` | The renderer dependency is missing. | Install `jinja2`, then re-run `render_card.py`. |
| `Context validation failed` | Required fields are missing or typed incorrectly. | Fix the context JSON using `references/style-guide.md`. |
| Unresolved marker failure | VERIFY or SELECT markers remain after review. | Confirm each marked field, prune catalog entries, then re-run `validate_submission.py`. |

## Files in this skill

- `SKILL.md` - this file (orchestration)
- `references/style-guide.md` - per-context-field guidance
- `references/skill-card.md.j2` - exact card layout
- `references/Skill Card Generator License.txt` - license text for this skill package
- `references/catalog/limitations.json` - canned technical-limitations catalog
- `references/catalog/risks.json` - canned risk-management catalog
- `scripts/discover_assets.py` - discovery and signal extraction
- `scripts/render_card.py` - Jinja renderer with context validation
- `scripts/validate_submission.py` - pre-submission marker validator