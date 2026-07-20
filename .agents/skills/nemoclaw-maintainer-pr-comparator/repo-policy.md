<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Repo Policy

Repository settings for this skill. Edit this file when you use the skill in another repository.

## Contents

- Required reviewer teams (CODEOWNERS)
- PR compliance policy (DCO declaration and GitHub verified signatures)
- Automated reviewer (CodeRabbit, Copilot, etc.)
- Documentation directory
- Coverage threshold files
- Bot author logins to filter

## Required reviewer teams

CODEOWNERS approval is enforced via branch protection. The skill checks `reviewDecision: APPROVED` and trusts branch protection to enforce the right teams.

```yaml
codeowners_enforced_via_branch_protection: true
```

If branch protection does not enforce CODEOWNERS, set this value to `false` and add the required teams.

## Commit compliance policy

NemoClaw requires a `Signed-off-by:` line in the PR description.
GitHub must show each PR commit as `Verified`.
The `dco-check` workflow, comparator, and merge gate check DCO.
The comparator and merge gate check commit verification. Branch protection is a separate gate.

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

If CI does not enforce coverage, report that this skill does not compute the coverage change.

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
