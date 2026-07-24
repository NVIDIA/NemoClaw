<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Advisory Early Warning and Audit Provenance

Status: correlation module, scan CLI, and audit provenance implemented. The
scheduled workflow and the policy defaults below are proposals and take effect
only after product/security-owner sign-off recorded on issue #7338 (evidence
from #7276).

Public upstream GitHub Security Advisories are often published weeks before the
global reviewed ecosystem record that `npm audit` enforces. For
`fast-uri` (GHSA-4c8g-83qw-93j6) the upstream repository advisory appeared on
June 29 while the reviewed record propagated on July 21, so the same vulnerable
version audited clean at 18:46 UTC and reported High at 20:09 UTC. This page
documents the early-warning correlation that narrows that gap and the
provenance every audit now records so such timelines are provable from retained
artifacts.

The correlation draws on all three types of the global advisory database, which
contribute differently:

- reviewed records are the corpus `npm audit` enforces — a match here means
  package-level enforcement is imminent or already active, and the signal
  confirms the reviewed gate will catch it;
- unreviewed records are NVD-sourced and often appear before curation reaches
  the reviewed feed — they usually lack a verified npm mapping, so they flow
  through the ambiguous, informational-only path and provide the earlier
  heads-up;
- malware records name npm packages published as malware — a match against the
  reviewed inventory correlates like any other record and is equally
  non-blocking.

Polling upstream *repository* advisories directly (the earliest public signal,
e.g. `fastify/fast-uri`'s own advisory) needs a package-to-repository map and
is the planned extension; the correlation module already accepts that record
shape unchanged.

## How the early-warning correlation works

- `scripts/lib/advisory-early-warning.mts` correlates GitHub Security Advisory
  JSON (repository-level and global records share the shape) with the reviewed
  npm inventory and emits structured signals:
  `{advisoryId, package, vulnerableRange, matchedVersions, source, confidence, action}`.
- The inventory is derived from `ci/reviewed-npm-audit.json`: every committed
  archive package spec plus the installed packages of each locked graph's
  `package-lock.json`.
- Confidence is encoded, never guessed: only an exact npm ecosystem +
  package-name + parseable semver-range match yields `confidence: "exact"` and
  `action: "investigate"`. Name collisions from non-npm (CPE-derived) records
  and unparseable ranges yield `confidence: "ambiguous"` and
  `action: "informational"`. Ambiguous matches never block or mutate a release.
- The reviewed npm audit gate (`scripts/audit-reviewed-npm-graph.mts`, enforced
  in CI) remains enabled and authoritative for exact npm package/version-range
  decisions. The early-warning path only triggers investigation and rescanning.

`scripts/advisory-early-warning-scan.mts` is the CLI over the module.
It reads only local files and exits 0 whether or not signals are found.
It does not modify input files or external state.
With `--output`, it writes the requested local signals file:

```sh
# List inventory package names (one per line), the input for advisory queries.
node --experimental-strip-types scripts/advisory-early-warning-scan.mts \
  --list-packages

# Correlate fetched advisory records with the inventory.
node --experimental-strip-types scripts/advisory-early-warning-scan.mts \
  --advisories advisories.json --output signals.json
```

Advisory records come from the GitHub `/advisories` API — all three types,
paginated, filtered by `affects=` batches of the inventory package names.

## Scheduled operation

`.github/workflows/advisory-early-warning.yaml` runs every six hours (and on
manual dispatch): it fetches reviewed, unreviewed, and malware advisories
naming inventory packages (paginated, batched by package), runs
`scripts/advisory-early-warning-scan.mts`, and routes signals into one rolling
GitHub issue labeled `security`, deduplicated by advisory id plus package. Only
an OPEN issue authored by the Actions bot that carries the workflow's embedded
marker is reused; otherwise a fresh issue is created. Closing the rolling issue
while its signals still apply therefore makes the next run open a fresh issue
re-listing them (the dedupe state lives in the open issue body), so close it
only once the listed advisories are resolved for the inventory. The workflow is
non-blocking by design and never fails a build.

Signals that carry a CVE id are reconciled against NVD in the same run
(supplementary only — see the NVD reconciliation section above):

- The workflow queries at most 20 CVE ids per run, spaced 7 seconds apart, to
  respect the unauthenticated NVD rate limit of roughly five requests per 30
  seconds; when the cap truncates the list it says so in the run log rather
  than skipping silently. An NVD outage or rate-limit degrades gracefully to
  an `NVD: unavailable` annotation — deliberately unlike the GitHub advisory
  fetch, which fails loudly because signals cannot be computed without it.
- NVD annotations extend the rolling issue's line text only. The dedupe key
  (advisory id plus package) is unchanged, so a line appended before its NVD
  annotation was available is not re-appended later.

## Proposed policy defaults (pending maintainer confirmation)

The following defaults answer #7338's open policy questions. They are
proposals only and take effect when product/security owners confirm them.

- Scope: the reviewed graphs committed in `ci/reviewed-npm-audit.json`
  (archive packages and locked graphs). Historical immutable image digests are
  out of scope until owners define a supported-image list.
- Rescan ownership: repository maintainers, driven by the rolling
  `security`-labeled early-warning issue; the six-hour schedule is the default
  rescan trigger for advisory-database changes.
- Alert destination: the rolling GitHub issue created by the early-warning
  workflow (one issue, deduplicated by advisory id plus package).
- Response expectation for `action: "investigate"` signals: acknowledge
  Critical within 1 business day and resolve or escalate within 3; acknowledge
  High within 2 business days and resolve or escalate within 5. While a
  reviewed mapping is unavailable, unresolved High/Critical signals escalate to
  a maintainer decision rather than automatically blocking a release.

## Provenance recorded per audit

Each reviewed npm audit report now has a `*.provenance.json` sidecar
(`coverage/reviewed-npm-audit/` artifacts, and `npm-audit.provenance.json` for
the WeChat locked runtime graph audit) recording:

- scanner identity: `npm audit`, npm version, Node.js version;
- the configured registry, with URL credentials removed, plus the derived bulk
  advisory endpoint npm posts the dependency graph to (npm >= 7 has no
  quick-audit fallback: on request failure npm reports no advisory data, and
  the note records this);
- run start and finish timestamps (ISO 8601);
- the audited graph label and committed package specs;
- the raw machine-readable report path (`rawReportPath`, by convention
  relative to the directory containing the sidecar);
- the GHSA advisory ids extracted from the report; and
- a `failure` marker when the audit attempt itself failed, so the sidecar
  still records the attempt.

Comparing the `advisoryIds` of consecutive retained runs identifies the last
comparable non-detection and the first detection of a newly surfaced advisory,
even when an unrelated finding failed the earlier run.
