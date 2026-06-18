# Consolidated Pre-Flight — Building the Single Gate

The pipeline has exactly one user gate. Before any side-effecting action (docker pull, docker login, any job-launch call delegated to a downstream skill, file mutations under `${RESULTS_DIR}/`), the agent must produce a single consolidated Pre-Flight Summary that subsumes every downstream skill's preflight. Once the user approves, the run is autonomous through all three phases — no further interactive pauses.

The user explicitly does not want to be paged between phases. The DEFT loop's own inline `## Pre-Flight Summary` gate becomes a **zero-question display step** (every value pre-supplied from this consolidated gate) rather than a fresh interrogation. Same for `tao-run-automl`'s shared launch preflight in Phase 1 and Phase 3.

## How to build the consolidated summary

Before printing anything to the user, **open and read every downstream skill's preflight section in full**:

- `skills/applications/tao-run-automl/SKILL.md` → `## Preflight` (Phases 1 and 3). Specifically: shared launch preflight (platform credentials, dataset visibility, model credentials, container image confirmation, compute shape), required inputs (`platform`, `image`, `network_arch`, `train_dataset_uri`, `eval_dataset_uri`, `metric`, `algorithm`, `automl_max_recommendations`), and the runner-freshness rule.
- The DEFT skill invoked in Phase 2 (AOI default: `skills/applications/tao-run-deft-aoi/SKILL.md` → `## Pre-Flight` + `### Pre-Flight Summary`; for non-AOI runs, the corresponding `skills/applications/deft-*` SKILL.md). Specifically: workspace/specs/CSV resolution, `.env` sourcing, NGC + HF token presence, `docker login nvcr.io`, container image resolution from `versions.yaml`, local image inspect, GPU memory rule of thumb (AOI ChangeNet: `batch_size ≤ 16` on 48 GB GPUs, `≤ 8` on 24 GB GPUs), pre-gen ingestion source verification + basename pairing, leakage check, and the loop's defaults (`max_iterations=3`, `top_k_per_target=5`, `min_similarity=0.9`).
- The `tao-launch-workflow` shared intake (referenced by `tao-run-automl`) — platform-specific credentials and compute-shape questions.

Then run **every read-only check** those preflight sections prescribe — image resolution, `docker image inspect`, file existence, basename pairing, row counts, value-count distributions, leakage diff, GPU memory query, host Python dependency check. The user should see the *outcome* of each check in the summary, not be asked to run it themselves.

### Required: run every step of the DEFT skill's `## Pre-Flight`

Run **every check in `skills/applications/tao-run-deft-aoi/SKILL.md` `## Pre-Flight`** (or, for non-AOI runs, the corresponding `skills/applications/deft-*` SKILL.md `## Pre-Flight`) as part of the consolidated pre-flight, before printing the summary. If any step is skipped, the consolidated gate is invalid and the pipeline must not advance.

## Mandatory contents of the consolidated summary

The summary must include, in this order:

1. **Workspace, host, platform, network** — workspace root, GPU model + memory, docker version, platform choice (never default; if user hasn't said, ask in the consolidated gate, not later), `network_arch`.
2. **Credentials status** — `[ -n "$VAR" ]` SET/UNSET for each variable each downstream skill requires. Never print the value.
3. **Container images** — fully resolved URIs from `versions.yaml` (per the DEFT skill's `scripts/resolve_versions_key.py` pattern), with a PRESENT/MISSING column from `docker image inspect`. Missing images are not blockers — the post-approval autonomous run will `docker login nvcr.io` and pull them — but the user must see what will be pulled.
4. **Dataset table** — train/val/test/mining-pool/pre-gen counts; KPI label distribution; train↔val leakage check (must show `0 overlapping rows`).
5. **Phase 1 config** — algorithm, sweep size, metric, HPs to sweep, HPs pinned, results dir, spec source.
6. **Phase 2 config** — every field from the DEFT skill's `## DEFT Loop — Pre-Flight Summary` table (KPI target, max_iterations, training_epochs, top-K, mining cutoff, GPUs, resuming flag) **plus** the pre-seeded baseline source (`${RESULTS_DIR}/baseline/train/` populated from Phase 1's winning checkpoint). Mark the DEFT skill's inline gate as "auto-approved by consolidated gate above".
7. **Phase 3 config** — sweep size, metric, warm-start checkpoint policy, val set (must match Phase 1).
8. **Compute estimate** — Phase 1 train count × per-rec time + Phase 2 iteration count × per-iter time + Phase 3 train count × per-rec time. If per-job time is unknown, ask the user once in this same gate or offer a 1-epoch dry-run option.
9. **Confirmation line** — "Approve all three phases? After 'go' I will not pause again until DEFT's iter-level KPI gate (if reached) or pipeline completion."

## Suppressing downstream interactive gates

When invoking each downstream skill after the consolidated gate, pass through the values collected in the summary so the downstream skill has nothing to ask:

- `tao-run-automl` (Phases 1 + 3): supply `platform`, `image`, `network_arch`, dataset URIs, `metric`, `algorithm`, `automl_max_recommendations`, `spec_overrides`, and (Phase 3 only) the warm-start `pretrained_model_path`. The shared launch preflight then runs as a non-interactive validation pass.
- DEFT loop (Phase 2): write `deft_state.json` with the Phase 1 baseline pre-seed (per the Phase 1 → Phase 2 handoff) **and** pre-populate the DEFT skill's config inputs (`max_iterations`, `top_k_per_target`, `min_similarity`, `training_epochs`, KPI threshold). The DEFT loop's inline summary still prints as an audit-trail display; it must not re-prompt.

The only places the pipeline is *allowed* to pause for user input after the consolidated gate are:

- Mid-run hard-stop gates the downstream skill cannot bypass on safety grounds (e.g. DEFT's KPI regression gate, an unrecoverable preflight failure surfaced after `docker pull`). These are exceptional, not routine. Call them out in the consolidated summary so the user knows when, if ever, they'll be paged.

## When the skill bank version doesn't yet support gate suppression

Older DEFT skill versions that hard-code "STOP — wait for explicit user approval" cannot be silenced by pre-supplied inputs alone. In that case, the agent must still produce the consolidated summary up front and tell the user: "the DEFT skill will re-print its preflight as a display before iter 1 — type 'go' both times, the second one is a known limitation of skill version X." Then file an issue / open a PR against the DEFT skill to make the gate honour pre-supplied approval.
