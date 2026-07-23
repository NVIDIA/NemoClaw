<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Advisory Early Warning and Audit Provenance

Status: correlation module, scan CLI, and audit provenance implemented.
Scheduled operation and the response policy are a separate follow-up, gated on
product/security-owner sign-off recorded on issue #7338 (evidence from #7276).

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

Running this correlation on a schedule and routing signals to an alert
destination is deliberately not wired up yet: #7338 requires product/security
owners to define the supported historical-image scope, rescan ownership, alert
destination, and response expectations first. A follow-up adds the scheduled
workflow once that sign-off is recorded on the issue.

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
