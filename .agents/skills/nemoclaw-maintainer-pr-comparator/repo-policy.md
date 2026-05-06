# Repo Policy

Configurable defaults that adapt the skill to a specific repository. Edit this file when adopting the skill in a new repo. The skill reads these values to know what to gate on.

## Contents

- Required reviewer teams (CODEOWNERS)
- Sign-off policy (DCO)
- Automated reviewer (CodeRabbit, Copilot, etc.)
- Documentation directory
- Coverage threshold files
- Bot author logins to filter

## Required reviewer teams

CODEOWNERS approval is enforced via branch protection. The skill checks `reviewDecision: APPROVED` and trusts branch protection to enforce the right teams.

```yaml
codeowners_enforced_via_branch_protection: true
```

If your repo does NOT enforce CODEOWNERS via branch protection, set this to `false` and add an explicit list of required teams to check.

## Sign-off policy

NemoClaw default: DCO sign-off required, enforced by `dco-check` workflow.

```yaml
dco_required: true
dco_check_name: dco-check
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
