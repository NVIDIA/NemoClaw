<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw catalog skills signing flow

This diagram shows the required sequence for publishing NemoClaw user-facing skills into the NVIDIA Verified Skills catalog through the generated `skills/` export.

```mermaid
sequenceDiagram
    autonumber
    actor Maintainer as Human maintainer
    participant Source as NemoClaw source<br/>.agents/skills + .agents/catalog-skills.yaml
    participant Exporter as scripts/export-catalog-skills.py
    participant Export as Generated export<br/>skills
    participant PRCI as PR workflow<br/>CI / Pull Request
    participant Refresh as Skills / Catalog Refresh workflow
    participant PR as Same-repo refresh PR
    participant NVSkills as NVSkills CI signer
    participant Main as NVIDIA/NemoClaw main
    participant Target as NVIDIA/skills sync

    Note over Source,Export: Implementation PR path added by issue #4282
    Maintainer->>Source: Curate catalog-safe skills in .agents/catalog-skills.yaml
    Maintainer->>Exporter: Run python3 scripts/export-catalog-skills.py
    Exporter->>Export: Copy allowlisted skills as real files<br/>write catalog-metadata.json<br/>preserve skill.oms.sig + skill-card.md if present
    Maintainer->>PRCI: Open implementation or content PR
    PRCI->>Exporter: python3 scripts/export-catalog-skills.py --check --allow-missing
    Exporter-->>PRCI: Pass before first export exists;<br/>after refresh PR, fail if skills is stale or hand-edited
    Maintainer->>Main: Merge reviewed PR after checks pass

    Note over Refresh,PR: Post-merge refresh automation added by this PR
    Maintainer->>Refresh: Optional manual workflow_dispatch<br/>dry_run=true first
    Refresh->>Exporter: Regenerate export and show diff only
    Refresh-->>Maintainer: No branch or PR created in dry run
    Maintainer->>Refresh: Run dry_run=false when ready<br/>optionally request_nvskills_ci=true
    Refresh->>Exporter: Regenerate export
    Exporter->>Export: Update generated files if source changed
    Refresh->>PR: Create/update automation/catalog-skills-refresh PR<br/>with export diff

    alt request_nvskills_ci=true and bot is accepted
        Refresh->>PR: Comment /nvskills-ci
    else bot rejected or manual process preferred
        Maintainer->>PR: Comment /nvskills-ci manually
    end

    NVSkills->>PR: Push signing artifacts<br/>skill.oms.sig + skill-card.md
    PRCI->>Exporter: Re-run --check; signer artifacts are preserved
    Maintainer->>PR: Review generated export and signing artifacts
    Maintainer->>Main: Merge signed refresh PR
    Target->>Main: Sync configured NemoClaw catalog path
    Target->>Target: Keep only skills with skill.oms.sig and skill-card.md
```

## Human handoff points

These are the manual review and approval points in the catalog signing flow.

- Curate `.agents/catalog-skills.yaml` when public skill scope changes.
- Review the generated `skills/` diff in the same PR as the allowlist/source update.
- Manually comment `/nvskills-ci` if the workflow bot cannot request signing.
- Review and merge the signer-updated PR before expecting `NVIDIA/skills` to sync the signed skills.

## Workflow steps added in this PR

These checks and workflow steps automate export freshness while keeping signing under maintainer control.

- `CI / Pull Request` runs `python3 scripts/export-catalog-skills.py --check --allow-missing` so this infrastructure PR can merge before the first generated export, while later export PRs still reject stale or hand-edited files.
- `Skills / Catalog Refresh` supports:
  - `dry_run=true` to regenerate and report changes without pushing.
  - `dry_run=false` to create or update `automation/catalog-skills-refresh`.
  - `request_nvskills_ci=true` to attempt the `/nvskills-ci` comment after opening/updating the PR.
  - scheduled no-op/refresh behavior using the same exporter.

## Next Steps

- Review the exporter implementation in [`scripts/export-catalog-skills.py`](../scripts/export-catalog-skills.py).
- Update the catalog allowlist in [`.agents/catalog-skills.yaml`](../.agents/catalog-skills.yaml) when public skill scope changes.
- Review generated export diffs under `skills/` in the refresh PR before requesting or accepting signing artifacts.
- Check the workflow definitions in [`.github/workflows/pr.yaml`](workflows/pr.yaml) and [`.github/workflows/catalog-skills-refresh.yaml`](workflows/catalog-skills-refresh.yaml).
