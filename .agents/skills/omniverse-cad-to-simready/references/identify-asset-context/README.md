# Identify Asset Context

## When to Use

Use this reference before `convert-to-usd` and before Content Agents property assignment when the original source asset may contain product names, part numbers, manufacturer clues, CAD metadata, or other identifiers. The goal is to replace pure visual guessing with a small evidence-backed context report that can be passed into `material-agent-client` and `physics-agent-client` prompts.

This reference combines deterministic local inspection with web research. The reference's `scripts/run.py` extracts local clues from the source file; the agent then uses the recommended queries plus exact filename searches to gather public evidence and write an asset context report.

## Inputs

Collect:

| Input | Requirement |
|---|---|
| `source_asset` | Required raw source asset path, preferably before conversion. |
| `output_directory` | Required directory for local inspection and research reports. |
| `web_search` | Required when network/tools are available; if unavailable, mark web research blocked. |
| `converted_usd_path` | Optional converted USD path for render or geometry context after conversion. |
| `preview_image_path` | Optional render preview used only as secondary visual evidence. |

## Instructions

1. Confirm the source asset exists.
2. Run this reference's `scripts/run.py` on the original source file and save JSON plus Markdown reports.
3. Search the web using the exact source filename, internal filename from the report when present, local identifiers, and recommended query list.
4. Prefer manufacturer datasheets, product pages, standards documents, package labels, or official catalogs over forums and reseller snippets.
5. Summarize likely identity, manufacturer, product family, application, material candidates, physics/use assumptions, confidence, and cited evidence.
6. Produce a concise `material_physics_prompt` suitable for `--prompt` on Material and Physics Agent commands.
7. If evidence conflicts or only weak matches exist, keep uncertainty explicit and do not overfit the downstream prompt.

## CLI Pattern

Local inspection:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/identify-asset-context/scripts/run.py /path/to/source_asset \
  --report /path/to/output_dir/asset-context/asset-context.json \
  --markdown-report /path/to/output_dir/asset-context/asset-context.md
```

Use the report's `recommended_web_queries` as the starting query list. Always add exact filename and internal STEP/IGES `FILE_NAME` searches when those differ.

## Research Report

Write `asset-context.md` and, when useful, `asset-context.json` with:

| Field | Meaning |
|---|---|
| `source_asset_path` | Original source asset path. |
| `local_identifiers` | Filename, internal filename, product codes, and extracted part-number-like tokens. |
| `web_queries` | Queries actually searched. |
| `evidence` | Cited web sources with short relevance notes. |
| `likely_identity` | Best concise identity, such as product family and part description. |
| `manufacturer` | Manufacturer or vendor when supported by evidence. |
| `product_family` | Product line, standard, connector family, robot model, fixture family, etc. |
| `application` | Expected real-world use context. |
| `material_hints` | Evidence-backed or clearly inferred visual material candidates. |
| `physics_hints` | Rigid-body, collider, mass, friction, compliance, and use-case assumptions. |
| `confidence` | `high`, `medium`, or `low`, with a short reason. |
| `material_physics_prompt` | A compact prompt to pass into assignment agents. |

## Handoff Prompts

For `material-agent-client`, include:

- likely asset identity and manufacturer
- product family/application
- visible material candidates and finish, clearly separating evidence from inference
- any constraints, such as connector housing, metal latch, gold contacts, rubber cable, or PCB laminate

For `physics-agent-client`, include:

- whether the asset is a connector, cover, bracket, robot, tool, fixture, or flexible object
- likely rigid/static behavior for robotics simulation
- candidate component materials and density assumptions
- collider strategy when the asset is one merged CAD mesh
- confidence and any unsupported assumptions

## Pass/Fail Policy

This context stage passes when local inspection succeeds and the research report is written. It can pass with low confidence if uncertainty is explicit.

Block when the source file is missing. Mark web research as blocked, not failed, when browsing is unavailable or the user explicitly asks not to search the web.

## Next Steps

- Run `convert-to-usd` after the context report is created.
- Pass the `material_physics_prompt` into `material-agent-client --prompt` and `physics-agent-client --prompt`.
- Include source links and confidence in the final CAD-to-SimReady report.
