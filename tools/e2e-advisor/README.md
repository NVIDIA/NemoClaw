# E2E Advisor

The E2E Advisor recommends which NemoClaw end-to-end tests should run for a pull request. It combines a deterministic risk-domain baseline with a Pi semantic review, then posts a sticky PR comment with required/optional E2E recommendations and a dispatch hint.

## What it does

On pull requests, `.github/workflows/e2e-advisor.yaml`:

1. Computes the changed files for the current PR head SHA.
2. Runs `tools/e2e-advisor/advisor.mjs` to classify deterministic risk domains from `rules.yaml` and `test/e2e/e2e-manifest.yaml`.
3. Runs `tools/e2e-advisor/pi-analyze.mjs` to ask Pi to semantically refine the recommendation.
4. Writes JSON/Markdown artifacts under `artifacts/e2e-advisor/`.
5. Posts or updates a sticky PR comment marked with `<!-- nemoclaw-e2e-advisor -->`.

The advisor recommends tests only. Merge enforcement is expected to be added by a follow-up dynamic gate that checks whether the recommended E2E jobs passed for the same PR head SHA.

## Outputs

The workflow uploads:

- `e2e-advisor-input.json` — deterministic advisor input context.
- `e2e-advisor-result.json` — deterministic baseline result.
- `e2e-advisor-pi-prompt.md` — prompt sent to Pi.
- `e2e-advisor-pi-raw-output.txt` — raw Pi response.
- `e2e-advisor-pi-result.json` — parsed Pi result, or failure/skip metadata.
- `e2e-advisor-final-result.json` — result downstream tooling should consume.
- `e2e-advisor-summary.md` — deterministic Markdown summary.
- `e2e-advisor-pi-summary.md` — Pi Markdown summary.

## Required secrets

### `PI_E2E_ADVISOR_API_KEY`

Required for Pi semantic analysis. This key is rendered into a temporary Pi config at runtime and should be provided as a repository or organization Actions secret.

If no Pi provider credential is available, `pi-analyze.mjs` skips semantic analysis and leaves the deterministic baseline as the final result.

### `E2E_ADVISOR_GITHUB_TOKEN`

Optional. Used to post/update the PR comment when the default `github.token` does not have sufficient write permissions.

The workflow falls back to `github.token`, but PR comment creation is best-effort and `continue-on-error` so recommendations still appear in artifacts and the workflow summary if commenting is blocked.

## Safety model

The E2E Advisor is static analysis only:

- It does not execute PR-provided scripts, tests, package managers, or generated code.
- Pi runs with read-only tools only: `read,grep,find,ls`.
- Pi is invoked with `--no-session`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--no-context-files`.
- Generated Pi credential config is written under `/tmp/nemoclaw-e2e-advisor-pi-config-<pid>`, not under uploaded artifacts.
- Commenting is best-effort; lack of write permission does not block the advisor result.

## Key files

- `.github/workflows/e2e-advisor.yaml` — PR workflow.
- `test/e2e/e2e-manifest.yaml` — inventory of available E2E jobs/scripts/domains.
- `tools/e2e-advisor/rules.yaml` — deterministic path-to-domain/test rules.
- `tools/e2e-advisor/advisor.mjs` — deterministic baseline generator.
- `tools/e2e-advisor/pi-analyze.mjs` — Pi semantic analysis and JSON parsing.
- `tools/e2e-advisor/comment.mjs` — sticky PR comment writer.
- `tools/e2e-advisor/schema.json` — result schema.
- `tools/e2e-advisor/pi-models.template.json` — Pi model/provider template for NVIDIA inference keys.

## Manual target-PR analysis

The workflow supports manual analysis of another PR without installing the advisor in that target PR branch:

```bash
gh workflow run e2e-advisor.yaml \
  --repo jyaunches/NemoClaw \
  --ref ci/e2e-advisor-prototype \
  -f target_repo=NVIDIA/NemoClaw \
  -f target_pr=3244 \
  -f run_pi=true \
  -f pi_provider=anthropic
```

The workflow keeps advisor code in the primary checkout and checks out the target PR separately under `/tmp/e2e-advisor-target`.

## Toward merge enforcement

Branch protection cannot require a dynamic list of E2E jobs directly. The intended enforcement path is a single required check, for example `E2E Recommendation Gate`, that:

1. Reads `e2e-advisor-final-result.json` or a trusted advisor comment/check for the current PR head SHA.
2. Extracts `requiredTests`.
3. Verifies each required E2E job passed for that same head SHA.
4. Fails with a clear missing-job list until all recommended E2E jobs pass.

This PR adds the recommendation/commenting layer; the dynamic gate is a follow-up.
