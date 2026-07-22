<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Advisory Early Warning and Audit Provenance

Status: implemented mechanism, proposed policy (issue #7338; evidence from #7276)

Public upstream GitHub Security Advisories are often published weeks before the
global reviewed ecosystem record that `npm audit` enforces. For
`fast-uri` (GHSA-4c8g-83qw-93j6) the upstream repository advisory appeared on
June 29 while the reviewed record propagated on July 21, so the same vulnerable
version audited clean at 18:46 UTC and reported High at 20:09 UTC. This page
documents the early-warning path that narrows that gap and the provenance every
audit now records so such timelines are provable from retained artifacts.

The scheduled scan draws on all three types of the global advisory database, which
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

## How the early-warning path works

- `scripts/lib/advisory-early-warning.mts` correlates GitHub Security Advisory
  JSON (repository-level and global records share the shape) with the reviewed
  npm inventory and emits structured signals:
  `{advisoryId, cveId?, package, vulnerableRange, matchedVersions, source, confidence, action}`
  (`cveId` is present only when the advisory record carries a well-formed
  `cve_id`, and exists solely for the supplementary NVD reconciliation below).
- The inventory is derived from `ci/reviewed-npm-audit.json`: every committed
  archive package spec plus the installed packages of each locked graph's
  `package-lock.json`. The scan CLI's `--inventory <file>` flag substitutes an
  explicit `{name, version}` inventory for hermetic offline runs; the
  workflow always uses the repo-derived default.
- Confidence is encoded, never guessed: only an exact npm ecosystem +
  package-name + parseable semver-range match yields `confidence: "exact"` and
  `action: "investigate"`. Name collisions from non-npm (CPE-derived) records
  and unparseable ranges yield `confidence: "ambiguous"` and
  `action: "informational"`. Ambiguous matches never block or mutate a release.
- `.github/workflows/advisory-early-warning.yaml` runs every six hours (and on
  manual dispatch): it fetches reviewed, unreviewed, and malware advisories
  naming inventory packages (paginated, batched by package), runs
  `scripts/advisory-early-warning-scan.mts`, and routes signals into one
  rolling GitHub issue labeled `security`, deduplicated by advisory id plus
  package. Only an OPEN issue authored by the Actions bot that carries the
  workflow's embedded marker is reused; otherwise a fresh issue is created.
  Closing the rolling issue while its signals still apply therefore makes the
  next run open a fresh issue re-listing them (the dedupe state lives in the
  open issue body), so close it only once the listed advisories are resolved
  for the inventory. The workflow is non-blocking by design and never fails a
  build.
- The reviewed npm audit gate (`scripts/audit-reviewed-npm-graph.mts`, enforced
  in CI) remains enabled and authoritative for exact npm package/version-range
  decisions. The early-warning path only triggers investigation and rescanning.

## NVD supplementary reconciliation

Signals that carry a CVE id are additionally reconciled against the National
Vulnerability Database (`services.nvd.nist.gov/rest/json/cves/2.0`). NVD is a
supplementary source only — #7338 explicitly forbids treating ambiguous
NVD/CPE matches as authoritative npm mappings — so a reconciliation is a
purely informational annotation that never changes a signal's `action` or
`confidence`:

- `scripts/lib/nvd-reconciliation.mts` parses NVD 2.0 API responses (CVE id,
  `vulnStatus`, published/last-modified dates, and the CPE criteria flagged
  vulnerable) and annotates each signal with one of three agreement states:
  `corroborated` (NVD lists the same CVE id and has not rejected it),
  `nvd-missing` (no NVD record — typical while a CVE is reserved or awaiting
  NVD processing; the earlier upstream signal stands on its own), or
  `nvd-divergent` (NVD rejected the CVE id, or the record answers a different
  one). CPE criteria surface only as a count in the note, never as package
  matches.
- The workflow queries at most 20 CVE ids per run, spaced 7 seconds apart,
  to respect the unauthenticated NVD rate limit of roughly five requests per
  30 seconds; when the cap truncates the list it says so in the run log
  rather than skipping silently. An NVD outage or rate-limit degrades
  gracefully to an `NVD: unavailable` annotation — deliberately unlike the
  GitHub advisory fetch, which fails loudly because signals cannot be
  computed without it.
- `scripts/advisory-early-warning-scan.mts --nvd-records <file>` attaches
  reconciliations from a file of previously fetched NVD responses; the CLI
  itself never performs network requests.
- NVD annotations extend the rolling issue's line text only. The dedupe key
  (advisory id plus package) is unchanged, so a line appended before its NVD
  annotation was available is not re-appended later.

## Provenance recorded per audit

Each reviewed npm audit report now has a `*.provenance.json` sidecar
(`coverage/reviewed-npm-audit/` artifacts, and `npm-audit.provenance.json` for
the WeChat locked runtime graph audit) recording:

- scanner identity: `npm audit`, npm version, Node.js version;
- the configured registry plus the derived bulk advisory endpoint npm posts
  the dependency graph to (npm >= 7 has no quick-audit fallback: on request
  failure npm reports no advisory data, and the note records this);
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

## #7276 post-mortem: detection triggers

Issue #7338 asks two questions of the #7276 evidence. The answers below rest
strictly on that retained evidence and inherit its limits: the evidence does
not support one universal feed-delay root cause, and a finding the evidence
cannot prove is classified unproven rather than attributed.

### Q1 — what trigger caused `npm audit` to begin detecting when it did

Per #7338's acceptance criteria, each finding is classified as
reviewed-mapping delay, audit/rescan coverage, or unproven due to missing
evidence.

- `fast-uri` (CVE-2026-13676, GHSA-4c8g-83qw-93j6) — **reviewed-mapping
  delay, directly demonstrated.** The upstream repository advisory existed
  from June 29, yet the 18:46 UTC `npm audit` on July 21 did not report
  `fast-uri@3.1.2`. The global reviewed ecosystem record propagated at
  19:03 UTC, and the 20:09 UTC audit of the same vulnerable version returned
  GHSA-4c8g-83qw-93j6 as High: strong before/after evidence that
  reviewed package-mapping propagation triggered detection.
- `@opentelemetry/core` (CVE-2026-54285, GHSA-8988-4f7v-96qf) —
  **audit/rescan coverage gap.** Its reviewed record had existed since
  June 15, more than a month before detection, so delayed reviewed-feed
  publication cannot explain it. It first surfaced when the July 21 build
  reached the plugin audit — an audit-coverage/execution-order gap.
- Jaeger propagator (CVE-2026-59892, GHSA-45rx-2jwx-cxfr) — **consistent
  with reviewed-mapping delay, but unproven.** The reviewed record appeared
  at 19:07 UTC on July 21 and the first plugin audit that reached this graph
  reported the finding at 20:26 UTC — consistent with reviewed mapping
  propagation, but earlier builds stopped before this plugin audit, so there
  is no controlled pre-review comparison.
- `tar` (CVE-2026-59873, GHSA-23hp-3jrh-7fpw) — **unproven due to missing
  evidence.** The June 27 upstream disclosure-to-detection gap is real (a
  July 21 Trivy scan reported vulnerable `tar@7.5.11` and `7.5.15`; the
  reviewed record dates to July 20), but no comparable pre-review scan was
  retained, so the exact trigger is unproven.

### Q2 — the ideal trigger, and what covers each gap now

The ideal trigger is the earliest public upstream disclosure, evaluated
against the exact dependency inventory on a schedule that does not depend on
how far any one build progressed. Mapping each demonstrated gap to a
mechanism:

- Reviewed-mapping delay (`fast-uri`; plausibly the Jaeger propagator):
  shipped — the six-hourly scan fetches unreviewed (NVD-sourced,
  pre-curation) advisory records alongside reviewed and malware ones, so a
  disclosure naming an inventory package raises a signal before the reviewed
  mapping exists, with NVD reconciliation as supplementary corroboration.
  Not yet shipped — polling upstream *repository* advisories directly (the
  earliest public signal) needs a package-to-repository map and remains the
  planned extension.
- Audit/rescan coverage gap (`@opentelemetry/core`; what limited the Jaeger
  conclusion): shipped — the scheduled scan correlates every advisory type
  against the full reviewed inventory every six hours, independent of build
  execution order. Not yet shipped — rescanning maintained immutable image
  digests (an image-scan pipeline) waits on the supported-image scope that
  product/security owners must define (see the policy defaults below).
- Unproven trigger (`tar`): no trigger design recovers missing evidence.
  Shipped — every reviewed npm audit now writes a provenance sidecar
  (endpoints, timestamps, advisory ids), so consecutive retained runs
  establish the last comparable non-detection and first detection for any
  future finding.

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
