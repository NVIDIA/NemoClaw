<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Advisory Early Warning and Audit Provenance

Status: correlation module, scan CLI, and audit provenance implemented.
Scheduled operation and the response policy are a separate follow-up.
Product and security owner sign-off on issue #7338 gates that work, based on evidence from #7276.

Public upstream GitHub Security Advisories are often published weeks before the global reviewed ecosystem record that `npm audit` enforces.
For `fast-uri` (GHSA-4c8g-83qw-93j6), the upstream repository advisory appeared on June 29, while the reviewed record propagated on July 21.
The same vulnerable version audited clean at 18:46 UTC and reported High at 20:09 UTC.

This page documents the early-warning correlation that narrows that gap.
It also documents the provenance that each audit records so retained artifacts can prove these timelines.

The correlation draws on all three types of the global advisory database:

- Reviewed records are the corpus that `npm audit` enforces.
  A match means package-level enforcement is imminent or active, and the signal confirms that the reviewed gate detects it.
- Unreviewed records come from NVD and often appear before curation reaches the reviewed feed.
  They usually lack a verified npm mapping, so they follow the ambiguous, informational path and provide earlier notice.
- Malware records name npm packages published as malware.
  A match against the reviewed inventory correlates like any other record and remains non-blocking.

Polling upstream repository advisories directly requires a package-to-repository map.
These advisories can provide the earliest public signal, such as the advisory from `fastify/fast-uri`.
This polling is the planned extension, and the correlation module already accepts that record shape unchanged.

## How the Early-Warning Correlation Works

- `scripts/lib/advisory-early-warning.mts` correlates GitHub Security Advisory JSON with the reviewed npm inventory.
  Repository-level and global records share the same shape.
  The module emits structured signals:
  `{advisoryId, package, vulnerableRange, matchedVersions, source, confidence, action}`.
- The inventory comes from `ci/reviewed-npm-audit.json`.
  It contains each committed archive package spec and the installed packages from each locked graph's `package-lock.json`.
- Confidence is encoded instead of inferred.
  Only an exact npm ecosystem, package name, and parseable semantic-version range match yields `confidence: "exact"` and `action: "investigate"`.
  Name collisions from non-npm, CPE-derived records and unparseable ranges yield `confidence: "ambiguous"` and `action: "informational"`.
  Ambiguous matches never block or mutate a release.
- The reviewed npm audit gate in `scripts/audit-reviewed-npm-graph.mts` remains enabled in CI.
  It is authoritative for exact npm package and version-range decisions.
  The early-warning path triggers only investigation and rescanning.

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

Advisory records come from the GitHub `/advisories` API.
The request includes all three types, uses pagination, and filters `affects=` by batches of inventory package names.

Running this correlation on a schedule and routing signals to an alert destination is not implemented.
Issue #7338 requires product and security owners to define the supported historical-image scope, rescan ownership, alert destination, and response expectations.
A follow-up adds the scheduled workflow after the issue records that sign-off.

## Provenance Recorded for Each Audit

Each reviewed npm audit report has a `*.provenance.json` sidecar.
The sidecars include `coverage/reviewed-npm-audit/` artifacts and `npm-audit.provenance.json` for the WeChat locked runtime graph audit.
Each sidecar records:

- Scanner identity, including `npm audit`, npm version, and Node.js version.
- The configured registry with URL credentials removed.
  The sidecar also records the derived bulk advisory endpoint where npm posts the dependency graph.
  npm 7 and newer have no quick-audit fallback.
  When the request fails, npm reports no advisory data, and the note records this condition.
- Run start and finish timestamps in ISO 8601 format.
- The audited graph label and committed package specs.
- The raw machine-readable report path in `rawReportPath`.
  By convention, the path is relative to the directory that contains the sidecar.
- The GHSA advisory IDs extracted from the report.
- A `failure` marker when the audit attempt fails, so the sidecar still records the attempt.

Comparing the `advisoryIds` of consecutive retained runs identifies the last comparable non-detection and the first detection of a newly surfaced advisory.
This comparison remains possible when an unrelated finding failed the earlier run.
