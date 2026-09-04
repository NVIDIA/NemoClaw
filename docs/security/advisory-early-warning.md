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
  `{advisoryId, cveId?, package, vulnerableRange, matchedVersions, source, confidence, action}`.
  The optional `cveId` appears only when the advisory has a well-formed `cve_id`.
  It supports the supplementary NVD reconciliation described below.
- The inventory comes from `ci/reviewed-npm-audit.json`.
  It contains each committed archive package spec and the installed packages from each locked graph's `package-lock.json`.
  Pass `--inventory <file>` to use an explicit `{name, version}` inventory for hermetic offline runs.
  A malformed entry fails the run instead of silently reducing the inventory.
- Confidence is encoded instead of inferred.
  Only a match on the npm ecosystem, package name, and parseable semantic-version range yields `confidence: "exact"` and `action: "investigate"`.
  Name collisions from non-npm, CPE-derived records and unparseable ranges yield `confidence: "ambiguous"` and `action: "informational"`.
  Ambiguous matches never block or mutate a release.
- The reviewed npm audit gate in `scripts/audit-reviewed-npm-graph.mts` remains enabled in CI.
  It is authoritative for npm package and version-range decisions.
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

## NVD Supplementary Reconciliation

Signals with a CVE ID can be reconciled against the National Vulnerability Database at `services.nvd.nist.gov/rest/json/cves/2.0`.
NVD is a supplementary source.
Issue #7338 prohibits treating ambiguous NVD or CPE matches as authoritative npm mappings.
Reconciliation is informational and never changes a signal's `action` or `confidence`.

- `scripts/lib/nvd-reconciliation.mts` parses NVD 2.0 API responses.
  It records the CVE ID, `vulnStatus`, publication and modification dates, and the CPE criteria marked vulnerable.
  It annotates each signal with one of three agreement states:
  `corroborated`, `nvd-missing`, or `nvd-divergent`.
  `corroborated` means that NVD lists the same CVE ID and has not rejected it.
  `nvd-missing` means that NVD has no record, which is typical while a CVE is reserved or awaiting NVD processing.
  The earlier upstream signal remains valid.
  `nvd-divergent` means that NVD rejected the CVE ID or returned a different record.
  CPE criteria surface only as a count in the note, never as package matches.
- Pass `--nvd-records <file>` to `scripts/advisory-early-warning-scan.mts` to attach reconciliations from previously fetched NVD responses.
  The CLI never makes network requests.

Querying NVD on a schedule and annotating the alert destination belong to the scheduled workflow.
The same #7338 sign-off gate applies to this work.

## Provenance Recorded for Each Audit

Each reviewed npm audit report has a `*.provenance.json` sidecar.
The sidecars include `coverage/reviewed-npm-audit/` artifacts and `npm-audit.provenance.json` for the WeChat locked runtime graph audit.
A configured cache reuses a response only when the package and lock bytes, npm version, registry origin, command arguments, and parser identity match.
The sidecar records whether the response came from the cache or a live registry request, plus its creation time, age, input digest, and response digest.
Each sidecar also records:

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

## #7276 Post-Mortem Detection Triggers

Issue #7338 asks two questions of the #7276 evidence.
The answers rely only on the retained evidence and inherit its limits.
The evidence does not support one universal feed-delay root cause.
A finding that the evidence cannot prove is classified as unproven rather than attributed.

### Q1 Detection Trigger

The #7338 acceptance criteria classify each finding as a reviewed-mapping delay, an audit or rescan coverage gap, or unproven because evidence is missing.

- `fast-uri` (CVE-2026-13676, GHSA-4c8g-83qw-93j6): **Reviewed-mapping delay, directly demonstrated.**
  The upstream repository advisory existed from June 29, yet the 18:46 UTC `npm audit` on July 21 did not report `fast-uri@3.1.2`.
  The global reviewed ecosystem record propagated at 19:03 UTC.
  At 20:09 UTC, an audit of the same vulnerable version returned GHSA-4c8g-83qw-93j6 as High.
  This before-and-after evidence demonstrates that reviewed package-mapping propagation triggered detection.
- `@opentelemetry/core` (CVE-2026-54285, GHSA-8988-4f7v-96qf): **Audit or rescan coverage gap.**
  Its reviewed record had existed since June 15, more than a month before detection, so delayed reviewed-feed publication cannot explain it.
  It first surfaced when the July 21 build reached the plugin audit.
  This result shows a gap in audit coverage or execution order.
- Jaeger propagator (CVE-2026-59892, GHSA-45rx-2jwx-cxfr): **Consistent with reviewed-mapping delay, but unproven.**
  The reviewed record appeared at 19:07 UTC on July 21.
  The first plugin audit that reached this graph reported the finding at 20:26 UTC.
  This sequence is consistent with reviewed mapping propagation, but earlier builds stopped before the plugin audit.
  No controlled pre-review comparison exists.
- `tar` (CVE-2026-59873, GHSA-23hp-3jrh-7fpw): **Unproven because evidence is missing.**
  The June 27 upstream disclosure-to-detection gap is real.
  A July 21 Trivy scan reported vulnerable `tar@7.5.11` and `7.5.15`, and the reviewed record dates to July 20.
  No comparable pre-review scan was retained, so the trigger is unproven.

### Q2 Ideal Trigger and Current Coverage

The ideal trigger is the earliest public upstream disclosure, evaluated against the dependency inventory on a schedule that does not depend on how far any one build progressed.
Mapping each demonstrated gap to a mechanism:

- Reviewed-mapping delay (`fast-uri` and plausibly the Jaeger propagator): The correlation path reads unreviewed NVD-sourced records alongside reviewed and malware records from the supplied advisory file.
  It also reads previously fetched NVD responses supplied through `--nvd-records`; the CLI does not fetch them.
  The planned scheduled workflow will fetch those NVD records, pass them to the CLI, and run every six hours after the #7338 sign-off.
  A disclosure that names an inventory package raises a signal before the reviewed mapping exists.
  NVD reconciliation provides supplementary corroboration.
  Polling upstream repository advisories directly is not implemented.
  This earliest public signal requires a package-to-repository map and remains the planned extension.
- Audit or rescan coverage gap (`@opentelemetry/core` and the limit on the Jaeger conclusion): The scheduled scan correlates every advisory type against the full reviewed inventory every six hours, independent of build execution order.
  The same #7338 sign-off gate applies.
  Rescanning maintained immutable image digests is not implemented.
  The image-scan pipeline waits for product and security owners to define the supported-image scope required by #7338.
- Unproven trigger (`tar`): No trigger design can recover missing evidence.
  Each reviewed npm audit now writes a provenance sidecar with endpoints, timestamps, and advisory IDs.
  Consecutive retained runs can establish the last comparable non-detection and first detection for future findings.
