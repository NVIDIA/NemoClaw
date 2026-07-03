# Issue 6002: Sandbox creation takes 8-10 minutes on Brev

- **URL:** https://github.com/NVIDIA/NemoClaw/issues/6002
- **Title:** [All Platforms][Sandbox][GitHub Issue #6002] Sandbox creation takes 8–10 minutes on Brev — significantly exceeds acceptable time budget for developer onboarding
- **Labels:** NV QA, area: onboarding, area: sandbox, area: performance
- **Verdict:** Fixable from NemoClaw side

<!-- triage-actionability-start -->
## Current Actionability (2026-07-02)

- GitHub state: OPEN
- Assignees: none
- Labels: NV QA, area: onboarding, area: sandbox, area: performance
- Analysis verdict: Fixable from NemoClaw side
- Actionability: Still actionable: open, unassigned, no excluded labels, no active local handoff, and no linked PRs found.
- Linked PR check: none found in timeline, comments, or issue body.
<!-- triage-actionability-end -->

## Linked PR And Duplicate Check

- Timeline cross-references: none.
- Comments: self-referential related issue comment only.
- Issue body/title PR references: none.
- Potential relation: https://github.com/NVIDIA/NemoClaw/issues/6043 is DGX Spark terminal Error, not same as Brev performance unless logs prove same underlying gateway/sandbox phase.

## Root Cause

The report combines two fixable NemoClaw-owned UX/performance issues:

1. Total first-run path is 8-10 minutes on Brev GPU instances.
2. Phases may be silent >60s with no granular progress, so users cannot tell whether the install stalled.

Current source already has coarse sandbox-create heartbeats:

- `src/lib/sandbox/create-stream.ts:440-459` emits phase-specific "Still building/pulling/uploading/creating/waiting..." messages every elapsed bucket when child output is silent.

But reporter says the overall installer/onboard path still has silent phases spanning gateway startup, image build, and provider configuration. Current heartbeat coverage is incomplete across the full workflow: install script, gateway startup, build context preparation, provider setup, first inference, and OpenClaw/Hermes setup need phase timing and progress events.

The performance budget (≤3 minutes) may require deeper optimization, but a closable NemoClaw PR can own measurable phase timing + reduction of known avoidable delays (image build context size, base image pulls, repeated setup work, provider verification timeouts) and no-silent-progress guarantee.

## Reproduction

Reporter workflow:

1. Start fresh Brev GPU instance.
2. Start stopwatch.
3. Run `curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash`.
4. Select Cloud API provider.
5. Complete all onboarding steps.
6. Stop stopwatch when `openclaw tui` accepts first message and returns a response.

Expected: ≤3 minutes and no phase silent >60s.
Actual: 8-10 minutes with long silent phases.

## Fix Plan

1. Add phase timing instrumentation across install/onboard:
   - installer start/end;
   - gateway startup;
   - build context staging;
   - image build/pull/upload/create/ready;
   - provider setup;
   - OpenClaw setup;
   - first inference verification.
2. Persist timing artifacts in E2E logs and print user-facing progress at least every 60s for every long phase, not only `create-stream`.
3. Use timing data to target avoidable delay:
   - skip/reuse build context work when unchanged;
   - avoid repeated `npm install`/plugin registry operations when cached;
   - reduce provider verification waits when prior health signal is fresh;
   - make base image pulls/builds visible and cache-aware.
4. Add a Brev/Linux GPU E2E performance budget test in warning mode first (records timings), then enforce no silent phase >60s.
5. Use Linux + GPU host `yimoj-colossus-dev.dyn.nvidia.com` for local gate; exact Brev runner or pipeline should validate wall-clock before closing.

## Why PR Can Close

NemoClaw owns installer/onboard UX and progress reporting. A PR can close if reporter workflow becomes bounded and observable: either wall-clock meets agreed budget or the issue is split into concrete optimization follow-ups while this issue's no-silent-progress requirement and largest avoidable delays are fixed.

## Key Files

- `scripts/install.sh`
- `src/lib/onboard.ts`
- `src/lib/onboard/machine/definition.ts`
- `src/lib/onboard/machine/handlers/*`
- `src/lib/sandbox/create-stream.ts`
- `src/lib/sandbox/build-context.ts`
- `test/e2e/live/*`
