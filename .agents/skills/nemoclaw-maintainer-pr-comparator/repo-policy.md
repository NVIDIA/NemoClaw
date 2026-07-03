<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Repo Policy

Configurable defaults that adapt the skill to a specific repository. Edit this file when adopting the skill in a new repo. The skill reads these values to know what to gate on.

## Contents

- Required independent human approval and optional CODEOWNERS enforcement
- PR compliance policy (DCO declaration and GitHub verified signatures)
- Automated reviewer (CodeRabbit, Copilot, etc.)
- Documentation directory
- Coverage threshold files
- Bot author logins to filter

## Required human approval

Do not infer reviewer independence from CODEOWNERS or `reviewDecision: APPROVED`. Require the
`independent-human-approval` check, which excludes the append-only PR contributor set and accepts
one eligible human approval for the latest reviewable push.

Pin that required check to its dedicated GitHub App or service source in the repository ruleset. A
status with the same name from another source is not qualifying evidence. In particular, the
repository-side Actions adapter is interim defense in depth because all workflows share the
`github-actions` App identity and its PR-comment observations are not tamper-proof storage.

```yaml
codeowners_enforced_via_branch_protection: false
independent_approval_check: independent-human-approval
```

Enable CODEOWNERS in the repository ruleset when team ownership is also required. CODEOWNERS
establishes expertise; it does not replace the independent-approval check.

## Commit compliance policy

NemoClaw default: a DCO sign-off declaration is required in the PR description, and GitHub verified commit signatures are required for every PR commit.
DCO is enforced by the `dco-check` workflow and checked directly in the PR body by the comparator and merge gate.
Verified signatures are checked directly for every PR commit by the comparator and merge gate; repository rules remain a separate enforcement layer.

```yaml
dco_required: true
dco_location: pr_description
dco_check_name: dco-check
github_verified_signatures_required: true
```

## Automated reviewers

Resolution of automated review threads is a Tier 0 gate. Defaults assume CodeRabbit.

```yaml
auto_reviewers:
  - login: coderabbitai
    is_bot: true
    require_resolution: true
```

If your repo uses Copilot, Gemini Code Assist, or similar, add their bot logins. The script `scripts/check-coderabbit-threads.sh` filters by these logins via GraphQL.

## Documentation directory

For the public-surface-preservation check (Tier 2), the skill greps `docs/` for affected commands/flags when behavior changes.

```yaml
docs_dir: docs
```

If your docs live elsewhere (e.g., `documentation/`, `website/src/pages/`, `docs/source/`), update this.

## Coverage threshold files

The skill defers to ratchet enforcement in CI. NemoClaw uses `ci/coverage-threshold-*.json`.

```yaml
coverage_ratchet_enforced_via_ci: true
```

If your repo does NOT ratchet coverage in CI, the skill needs to compute coverage delta itself — flag this as a v2 gap.

## Discovery search

Default candidate-PR discovery order is fixed (see `scripts/find-candidates.sh`). Per-repo tuning:

```yaml
title_token_jaccard_threshold: 0.4
max_candidates: 10
```

`title_token_jaccard_threshold` is the minimum Jaccard similarity between issue title and PR title to count as a candidate during fallback expansion.

## Bot author filter

Some authors (bots, dependency updaters) should be excluded from author-quality signals. Currently the skill has no merge-ratio tiebreaker, but if you re-enable one, filter these:

```yaml
excluded_bot_authors:
  - dependabot[bot]
  - renovate[bot]
  - github-actions[bot]
```
