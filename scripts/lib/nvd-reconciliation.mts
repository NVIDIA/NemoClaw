// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Supplementary NVD reconciliation for advisory early-warning signals (#7338).
// NVD is never an authoritative npm mapping: a reconciliation only records
// whether NVD independently corroborates a signal's CVE id, and CPE
// applicability criteria are surfaced for awareness, never turned into npm
// package matches. Reconciliations are purely informational annotations — they
// never change a signal's action or confidence, and enforcement stays with the
// reviewed npm audit gate.

import type { AdvisorySignal } from "./advisory-early-warning.mts";

export type NvdAgreement = "corroborated" | "nvd-missing" | "nvd-divergent";

export type NvdRecord = Readonly<{
  cveId: string;
  vulnStatus: string;
  published: string;
  lastModified: string;
  cpeCriteria: readonly string[];
}>;

export type NvdReconciliation = Readonly<{
  cveId: string;
  nvdStatus: string | null;
  nvdPublished: string | null;
  agreement: NvdAgreement;
  note: string;
}>;

export type NvdAnnotatedSignal = AdvisorySignal & Readonly<{ nvd?: NvdReconciliation }>;

const CVE_ID_PATTERN = /^CVE-\d{4}-\d{4,}$/;

/**
 * Derive the CVE id to reconcile from a GHSA advisory record: both the global
 * `/advisories` and repository-level security-advisory responses carry a
 * `cve_id` field (null until a CVE is assigned). Anything that is not a
 * well-formed CVE id yields null, so only pattern-validated ids ever reach an
 * NVD query.
 */
export function deriveCveId(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const cveId = (input as Record<string, unknown>).cve_id;
  if (typeof cveId !== "string" || !CVE_ID_PATTERN.test(cveId)) return null;
  return cveId;
}

function collectVulnerableCpeCriteria(cve: Record<string, unknown>): string[] {
  const criteria: string[] = [];
  const configurations = Array.isArray(cve.configurations) ? cve.configurations : [];
  for (const configuration of configurations) {
    if (typeof configuration !== "object" || configuration === null) continue;
    const nodes = (configuration as Record<string, unknown>).nodes;
    if (!Array.isArray(nodes)) continue;
    const pendingNodes = [...nodes];
    const seenNodes = new Set<object>();
    for (let index = 0; index < pendingNodes.length; index += 1) {
      const node = pendingNodes[index];
      if (typeof node !== "object" || node === null) continue;
      if (seenNodes.has(node)) continue;
      seenNodes.add(node);
      const nodeRecord = node as Record<string, unknown>;
      const childNodes = nodeRecord.nodes;
      if (Array.isArray(childNodes)) pendingNodes.push(...childNodes);
      const matches = nodeRecord.cpeMatch;
      if (Array.isArray(matches)) {
        for (const match of matches) {
          if (typeof match !== "object" || match === null) continue;
          const entry = match as Record<string, unknown>;
          // Only cpeMatch entries flagged vulnerable name the vulnerable
          // product; the rest are platform context ("running on/with").
          if (entry.vulnerable !== true) continue;
          const criterion = entry.criteria;
          if (typeof criterion !== "string" || criterion.length === 0) continue;
          if (!criteria.includes(criterion)) criteria.push(criterion);
        }
      }
    }
  }
  return criteria;
}

/**
 * Extract the reconciliation-relevant fields from one NVD 2.0 API response
 * (GET services.nvd.nist.gov/rest/json/cves/2.0?cveId=...). A cveId query
 * answers with at most one vulnerability; the first entry with a well-formed
 * CVE id is used. The well-formed empty response NVD serves for reserved or
 * unknown CVE ids — and any malformed input — yields null instead of throwing,
 * so one bad record cannot break a scan.
 */
export function parseNvdRecord(input: unknown): NvdRecord | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const vulnerabilities = (input as Record<string, unknown>).vulnerabilities;
  if (!Array.isArray(vulnerabilities)) return null;
  for (const entry of vulnerabilities) {
    if (typeof entry !== "object" || entry === null) continue;
    const cve = (entry as Record<string, unknown>).cve;
    if (typeof cve !== "object" || cve === null || Array.isArray(cve)) continue;
    const record = cve as Record<string, unknown>;
    const cveId = record.id;
    if (typeof cveId !== "string" || !CVE_ID_PATTERN.test(cveId)) continue;
    return {
      cveId,
      vulnStatus: typeof record.vulnStatus === "string" ? record.vulnStatus : "",
      published: typeof record.published === "string" ? record.published : "",
      lastModified: typeof record.lastModified === "string" ? record.lastModified : "",
      cpeCriteria: collectVulnerableCpeCriteria(record),
    };
  }
  return null;
}

/**
 * Reconcile one signal with the NVD record fetched for its CVE id. The result
 * is a purely informational annotation:
 *
 * - "corroborated": NVD lists the same CVE id and has not rejected it;
 * - "nvd-missing": no NVD record (typical while a CVE is reserved at MITRE or
 *   awaiting NVD processing — the earlier upstream signal stands on its own);
 * - "nvd-divergent": NVD rejected the CVE id, or the record answers a
 *   different one.
 *
 * A reconciliation never changes the signal's action or confidence, and a
 * signal without a CVE id has nothing to reconcile (null).
 */
export function reconcileSignalWithNvd(
  signal: AdvisorySignal,
  nvdRecord: NvdRecord | null,
): NvdReconciliation | null {
  const cveId = signal.cveId;
  if (cveId === undefined) return null;
  if (nvdRecord === null) {
    return {
      cveId,
      nvdStatus: null,
      nvdPublished: null,
      agreement: "nvd-missing",
      note: `NVD has no record for ${cveId} — typical while a CVE is reserved or awaiting NVD processing; the upstream advisory signal stands on its own.`,
    };
  }
  const nvdStatus = nvdRecord.vulnStatus.length > 0 ? nvdRecord.vulnStatus : null;
  const nvdPublished = nvdRecord.published.length > 0 ? nvdRecord.published : null;
  if (nvdRecord.cveId !== cveId) {
    return {
      cveId,
      nvdStatus,
      nvdPublished,
      agreement: "nvd-divergent",
      note: `NVD record ${nvdRecord.cveId} does not answer the advisory's ${cveId}; treat the NVD data as unrelated and keep the signal as-is.`,
    };
  }
  if (nvdRecord.vulnStatus.toLowerCase() === "rejected") {
    return {
      cveId,
      nvdStatus,
      nvdPublished,
      agreement: "nvd-divergent",
      note: `NVD rejected ${cveId} while the GHSA advisory is still published; investigate the divergence instead of dropping the signal.`,
    };
  }
  return {
    cveId,
    nvdStatus,
    nvdPublished,
    agreement: "corroborated",
    note: `NVD independently lists ${cveId} (status ${nvdStatus ?? "unknown"}); ${nvdRecord.cpeCriteria.length} vulnerable CPE criteria on file — a CPE match is never an authoritative npm mapping.`,
  };
}

/**
 * Attach NVD reconciliations to correlated signals. Purely additive: base
 * signal fields are copied unchanged, signals without a CVE id pass through
 * unannotated, and a CVE id no fetched response answers reconciles as
 * "nvd-missing" (which also covers the empty response NVD serves for reserved
 * ids, since that response parses to null and registers no record). When
 * responses duplicate a CVE id the first parseable one wins.
 */
export function attachNvdReconciliations(
  signals: readonly AdvisorySignal[],
  nvdResponses: readonly unknown[],
): NvdAnnotatedSignal[] {
  const recordsByCveId = new Map<string, NvdRecord>();
  for (const response of nvdResponses) {
    const record = parseNvdRecord(response);
    if (record === null) continue;
    if (!recordsByCveId.has(record.cveId)) recordsByCveId.set(record.cveId, record);
  }
  return signals.map((signal) => {
    const record = signal.cveId === undefined ? null : (recordsByCveId.get(signal.cveId) ?? null);
    const reconciliation = reconcileSignalWithNvd(signal, record);
    return reconciliation === null ? { ...signal } : { ...signal, nvd: reconciliation };
  });
}
