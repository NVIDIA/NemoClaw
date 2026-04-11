# Hotspots Workflow

Find files hurting throughput and reduce their future blast radius.

## Step 1: Run the Hotspot Script

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/hotspots.ts
```

This combines 30-day git churn on `main` with open PR file overlap, flags risky areas, and outputs a ranked JSON list.

Pipe into state:

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/hotspots.ts | node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/state.ts set-hotspots
```

## Step 2: Prioritize

Review the ranked output. Most urgent: high `combinedScore` + `isRisky: true` + weak tests.

## Step 3: Choose Cooling Strategy

Smallest change to reduce future collisions:

- extract stable logic from giant file into tested helper
- split parsing from execution
- add regression tests around repeated breakage
- deduplicate workflow logic
- narrow interfaces with typed helpers

Prefer changes that also improve testability.

## Step 4: Keep Small

One file cluster per pass. Stop if next step is large redesign → follow [SEQUENCE-WORK.md](SEQUENCE-WORK.md).

## Step 5: Validate

Run relevant tests. If risky code, also follow [TEST-GAPS.md](TEST-GAPS.md).

## Notes

- Goal is lower future merge pain, not aesthetic cleanup.
- No giant refactors inside contributor PRs.
