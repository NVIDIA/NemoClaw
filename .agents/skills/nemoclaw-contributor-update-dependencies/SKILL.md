---
name: nemoclaw-contributor-update-dependencies
description: Audit and implement dependency upgrades as semantic migrations rather than version-only bumps. Use when changing a library, CLI, service, container image, runtime, installer artifact, or transitive dependency pin; especially when the upgrade crosses multiple releases or tags, changes security or lifecycle behavior, or requires changelog, source-code, upstream-test, downstream-callsite, compatibility, and provenance analysis. Trigger keywords - update dependency, upgrade dependency, bump version, dependency migration, update OpenShell, update OpenClaw, update Hermes, changelog audit, release-by-release audit.
---

# Update Dependencies

Treat every dependency upgrade as a migration across two codebases. A valid upgrade explains
what changed upstream, where NemoClaw consumes those contracts, which migrations are required,
and how each concern was resolved. Artifact hashes and green tests are gates, not substitutes
for that analysis.

## Mutation boundary

Treat every dependency repository, registry, release workflow, issue tracker, and pull-request
queue as read-only. This skill authorizes changes only in NVIDIA/NemoClaw. Do not open upstream
pull requests or issues, push upstream branches, post upstream comments, rerun upstream workflows,
or change any repository other than NemoClaw. If the audit finds an upstream defect, record the
exact evidence and downstream gate; require a separate explicit user request outside this workflow
for any upstream action.

## Progress checklist

Copy this checklist into the working plan and keep it current:

```text
Dependency-upgrade progress:
- [ ] Resolve exact current and target identities, ancestry, and release status
- [ ] Enumerate every adjacent release/tag range in the upgrade gap
- [ ] Read release notes, changelog, commits, source diffs, and upstream tests per range
- [ ] Map changed upstream contracts to direct and indirect NemoClaw consumers
- [ ] Inventory downstream workarounds and verify each removal condition
- [ ] Record every concern with evidence, failure mode, and disposition
- [ ] Implement migrations in dependency-release order
- [ ] Add concern-specific tests and runtime proofs
- [ ] Audit immutable artifacts and every downstream selector
- [ ] Re-run the migration audit on the final tag and exact PR head
- [ ] Report resolved concerns, exclusions, and remaining external gates
```

## 1. Establish the upgrade boundary

Resolve these before editing:

- Dependency name and authoritative upstream repository.
- Current downstream version, tag, commit, package, image, and artifact identities.
- Candidate version or exact commit. Do not treat `latest`, a branch name, or a moving image tag
  as the final identity.
- Authoritative remote target SHA compared with the supplied local upstream worktree. Fetch refs
  read-only or record drift; never silently audit a stale checkout.
- Whether every endpoint is an ancestor of the next. Stop on forks, rewritten tags, or ambiguous
  release lineage.
- Every downstream selector: manifests, lockfiles, installers, workflows, fallback constants,
  images, fixtures, generated files, docs, and compatibility gates.

Use `scripts/collect-release-ledger.py` to enumerate adjacent semantic-version boundaries and
exact Git evidence. Write output outside the repository unless the migration record is an
intentional reviewed artifact:

```bash
.agents/skills/nemoclaw-contributor-update-dependencies/scripts/collect-release-ledger.py \
  --repo <upstream-worktree> \
  --from <current-tag> \
  --to <target-tag-or-commit> \
  --output <temporary-ledger.json>
```

For a multi-release upgrade, never collapse the result into one aggregate `old..new` summary.
Read [references/release-ledger.md](references/release-ledger.md) and complete every adjacent
range. Include unreleased target commits as a terminal range, but do not represent them as a
published release.

## 2. Audit each upstream release

For every adjacent range, inspect all of the following:

1. Official release notes and changelog entries.
2. The complete commit list and changed-path inventory.
3. Source diffs for changed or adjacent contract-owning code.
4. Upstream tests that define old behavior, new behavior, defaults, errors, and cleanup.
5. Packaging and workflow changes that determine what was actually published.

Release notes are leads, not proof. They may omit silent defaults, bug fixes, packaging changes,
or contracts the downstream project relies on accidentally. If a tag has no successful release,
record that anomaly and continue the source audit without treating the tag as shippable. A failed
or missing publishing workflow is a hard blocker for the final stable pin.

Classify every change using the risk surfaces in
[references/contract-audit.md](references/contract-audit.md). Read source for plausible
consumer-facing changes even when the commit title says `refactor`, `test`, `chore`, or `fix`.

## 3. Trace changed contracts into NemoClaw

Search for more than the dependency name and old version. Derive search keys from upstream
source and tests:

- commands, flags, positional arguments, output fields, status text, and exit codes;
- environment variables, config keys, defaults, precedence rules, and file locations;
- API, protobuf, schema, enum, endpoint, header, and error identifiers;
- image names, labels, annotations, artifact names, architectures, and platform floors;
- lifecycle states, cleanup order, retry rules, timeouts, and idempotency markers;
- credential placeholders, secret boundaries, policy fields, TLS behavior, DNS behavior, and
  network denial semantics.

Trace each key through production code, scripts, workflows, fixtures, tests, docs, and generated
outputs. Include indirect consumers such as parsers of human-readable output, assumptions about
defaults, sibling-binary discovery, and tests that encode old behavior without naming the
dependency.

Do not mark a change irrelevant because a literal search returned no result. An exclusion needs
both upstream source evidence describing the boundary and downstream evidence showing NemoClaw
does not enter or depend on it.

## 4. Build the concern ledger

Use the schema in [references/contract-audit.md](references/contract-audit.md). Every concern must
name:

- adjacent release range and upstream evidence;
- old and new contract;
- exact downstream consumer or evidence-backed exclusion;
- plausible failure mode, including silent behavior drift;
- severity and confidence;
- disposition: `migrate`, `pin`, `guard`, `test`, `runtime-proof`, `document`, or `no-impact`;
- implementation and verification evidence;
- remaining assumptions or external gates.

An unresolved high-impact concern blocks the version bump. `No impact` is a conclusion that needs
evidence, not an empty row. Keep separate concerns separate even when one code change resolves
several of them.

## 5. Implement in release order

Apply migrations in the order the upstream contracts changed. This preserves causality and makes
conflicting changes visible. For each concern:

1. Add or update the narrow downstream contract before changing the final version selector.
2. Add a regression that would fail under the old downstream assumption and pass under the new
   upstream behavior.
3. Remove obsolete workarounds only when source and runtime evidence prove their removal
   condition. Do not infer removal from a version number.
4. Preserve historical release notes, compatibility reviews, fixtures, and origin statements.
   Update only current operational guidance and active selectors.
5. Re-run affected downstream generation after source edits; review generated diffs rather than
   accepting them mechanically.

When sequential intermediate versions expose incompatible migrations, use focused intermediate
branches or tests to isolate the boundary. Do not ship unsupported intermediate pins merely to
make the analysis easier.

## 6. Verify concerns, then verify the repository

Verification must answer the concern ledger row by row:

- Use unit or integration tests for parsers, schemas, defaults, selection, and error contracts.
- Use source comparison for negative claims such as unchanged authentication or attribution
  boundaries.
- Use live E2E for process topology, images, credentials, network behavior, restarts, rotations,
  rebuilds, cleanup, and platform-specific behavior.
- For a security control, exercise the bypass path and inspect the installed enforcement state.
  A successful request through the intended proxy does not prove direct egress is blocked.
- Use affected hardware when the issue or migration is hardware-specific.
- Scan artifacts independently when secrets or credentials cross the boundary.

For each runtime or stateful migration, cover the applicable happy path, negative path, degraded
state, restart or rotation, persisted-state transition, rollback, and teardown. State explicitly
when one of these paths is inapplicable and cite the boundary that makes it so.

Existing green tests only prove what they cover. If no test would fail for the identified
migration concern, add one or retain a specific source/runtime proof. After concern-specific
verification, run the repository's normal targeted checks, hooks, exact-head CI, and automated
review gates.

Inspect test selectors, version gates, conditional skips, expected-failure markers, and matrix
exclusions at the candidate identity. A green run is invalid migration evidence when the changed
contract or candidate version was skipped.

Treat matrix flags, environment toggles, and workflow labels as selection intent, not proof of
execution. For every required case, retain positive evidence that the runner collected and passed
the exact test identifier: an unskipped result plus a case-specific post-success marker or artifact.
Compare the intended matrix with the observed test IDs and count. A filtered one-case run cannot
stand in for a three-case matrix even when the workflow configuration says the matrix is enabled.

## 7. Audit release identity separately

After semantic migration work is complete, verify the final release and consumed artifacts:

- immutable tag commit, ancestry, signature or platform verification, and release status;
- exact producer workflow run and rerun attempt;
- release attestations and source/build identity;
- local, manifest, and release-API hashes for every consumed asset;
- exact archive member names, types, paths, and duplicates before extraction; reject absolute or
  parent-traversal paths, links, devices, and unexpected outputs;
- decompressed or extracted binary hashes where packaging can hide drift;
- multi-architecture image index and per-platform availability;
- OCI image attestations bound to the source and producer workflow. If none exist, record the
  provenance gap, inspect every consumed child manifest and config/source label, and verify how
  the downstream runtime extracts or executes image contents;
- coherence of every downstream selector and fallback with the trusted hash tables.

Repeat source comparisons and the concern ledger against the final tag. Candidate-main evidence
does not become stable-release evidence merely because the expected version was tagged.

Use these NemoClaw precedents for durable evidence shape, not as inherited conclusions:

- `docs/security/openclaw-2026.6.10-dependency-review.md` and
  `test/openclaw-dependency-review.test.ts` for a tracked dependency review with contract tests;
- `docs/security/openshell-0.0.72-compatibility-review.mdx` for a runtime compatibility boundary;
- `scripts/checks/dependency-pins.ts` and `test/dependency-pins-check.test.ts` for selector
  coherence; and
- `scripts/check-installer-hash.sh` and `test/installer-hash-check.test.ts` for independently
  trusted release manifests and consumed artifacts.

These artifacts prove only their own versions and invariants. Re-audit source and regenerate the
evidence for the candidate release.

## 8. Hand off reviewable evidence

The PR summary must state the number of crossed release ranges and commits, link or include the
concern ledger, identify migrations made for each material upstream change, and separate:

- resolved semantic concerns;
- supply-chain and artifact evidence;
- tests and runtime proofs;
- evidence-backed exclusions;
- remaining external gates.

Do not summarize a wide upgrade as “bump dependency and update hashes.” Do not mark the PR ready
while the final release, exact-head runtime proof, or a material migration concern remains open.

## Reference map

| Need | Read |
|---|---|
| Adjacent tags, release notes, missing releases, per-range evidence | [references/release-ledger.md](references/release-ledger.md) |
| Contract surfaces, downstream tracing, concern schema, dispositions | [references/contract-audit.md](references/contract-audit.md) |

## Script

- `scripts/collect-release-ledger.py` — collect exact adjacent release endpoints, commits, changed
  paths, and diff sizes. Execute it; inspect source only when modifying the script.
