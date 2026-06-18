# Keeping This Router Up to Date

The upstream `nurec-index` skill (at
`https://github.com/NVIDIA/nurec-skills/blob/main/.agents/skills/SKILL.md`)
is hand-curated by the NRS team. When it adds or restructures
sibling skills:

1. Add a row to `Pick a skill` in `SKILL.md` for any new use case.
2. Add a row to `Sibling skills (upstream)` in `SKILL.md`.
3. If the new skill changes a multi-step pipeline, update
   `references/workflows.md`.
4. Re-verify the upstream URL and the per-sibling `metadata.upstream`
   fields still point at live canonical sources (NCore, NGC
   NRE / NRE-tools containers, Asset Harvester, NVIDIA Harmonizer +
   Hugging Face `nvidia/DiffusionHarmonizer`, `nvidia/PhysicalAI-*`).
5. If the upstream renames a sibling skill (e.g.
   `ncore-data-conversion` → `ncore`, or any future Fixer →
   DiffusionHarmonizer-style rename), search this skill for the old
   name and update every occurrence — the picker table, workflow
   steps, sibling skills table, mix-ups, and hard rules.

Treat the upstream `nurec-index` at
<https://github.com/NVIDIA/nurec-skills/blob/main/.agents/skills/SKILL.md>
as authoritative; this skill mirrors only the picker tables, the
workflow ordering, and the upstream fetch recipe.
