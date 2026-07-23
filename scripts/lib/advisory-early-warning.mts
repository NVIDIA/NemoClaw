// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Early-warning correlation between public upstream GitHub Security Advisories
// and the reviewed npm package inventory (#7338). Upstream repository advisories
// are often published weeks before the global reviewed ecosystem record that
// `npm audit` enforces, so this module turns the earlier signal into a traceable,
// NON-blocking investigation prompt. It never replaces the reviewed npm audit
// gate: only exact npm package-name plus semver-range matches are marked
// "investigate", and ambiguous CPE-to-npm matches stay "informational".

export type AdvisoryConfidence = "exact" | "ambiguous";
export type AdvisoryAction = "investigate" | "informational";

export type AdvisorySignal = Readonly<{
  advisoryId: string;
  package: string;
  vulnerableRange: string;
  matchedVersions: readonly string[];
  source: "upstream-ghsa";
  confidence: AdvisoryConfidence;
  action: AdvisoryAction;
}>;

export type InventoryEntry = Readonly<{
  name: string;
  version: string;
  origin: string;
}>;

export type ParsedAdvisoryVulnerability = Readonly<{
  ecosystem: string;
  packageName: string;
  vulnerableRange: string;
}>;

export type ParsedAdvisory = Readonly<{
  advisoryId: string;
  vulnerabilities: readonly ParsedAdvisoryVulnerability[];
}>;

const GHSA_ID_PATTERN = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/i;
const RELEASE_VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
const RANGE_COMPARATOR_PATTERN = /^(<=|>=|<|>|=)?\s*(\S+)$/;

type ParsedVersion = Readonly<{
  release: readonly [number, number, number];
  prerelease: readonly string[];
}>;

function parseVersion(version: string): ParsedVersion | null {
  const match = RELEASE_VERSION_PATTERN.exec(version.trim());
  if (!match) return null;
  const release = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (release.some((part) => !Number.isSafeInteger(part))) return null;
  return { release, prerelease: match[4] ? match[4].split(".") : [] };
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareParsedVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = Math.sign(left.release[index] - right.release[index]);
    if (difference !== 0) return difference;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = comparePrereleaseIdentifiers(
      left.prerelease[index],
      right.prerelease[index],
    );
    if (difference !== 0) return difference;
  }
  return Math.sign(left.prerelease.length - right.prerelease.length);
}

/** Compare two versions; null when either is not an exact semver version. */
export function compareSemver(left: string, right: string): number | null {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) return null;
  return compareParsedVersions(parsedLeft, parsedRight);
}

/**
 * Evaluate the comma-separated comparator subset GitHub Security Advisories use
 * for `vulnerable_version_range` (e.g. ">= 3.0.0, < 3.1.3"). Comparators are
 * AND-ed: any parseable comparator that evaluates false proves the version is
 * outside the range even when a sibling comparator is unparseable. Returns null
 * only when the version does not parse or no parseable comparator can decide;
 * callers must treat null as ambiguous, never as a confirmed match.
 */
export function satisfiesVulnerableRange(version: string, range: string): boolean | null {
  const parsedVersion = parseVersion(version);
  if (!parsedVersion) return null;
  const comparators = range
    .split(",")
    .map((comparator) => comparator.trim())
    .filter((comparator) => comparator.length > 0);
  if (comparators.length === 0) return null;
  let anyUnparseable = false;
  for (const comparator of comparators) {
    const match = RANGE_COMPARATOR_PATTERN.exec(comparator);
    const bound = match ? parseVersion(match[2]) : null;
    if (!match || !bound) {
      anyUnparseable = true;
      continue;
    }
    const difference = compareParsedVersions(parsedVersion, bound);
    const operator = match[1] ?? "=";
    const comparatorSatisfied =
      (operator === "<" && difference < 0) ||
      (operator === "<=" && difference <= 0) ||
      (operator === ">" && difference > 0) ||
      (operator === ">=" && difference >= 0) ||
      (operator === "=" && difference === 0);
    if (!comparatorSatisfied) return false;
  }
  return anyUnparseable ? null : true;
}

/**
 * Extract the correlation-relevant fields from one GitHub Security Advisory
 * object (repository-level `/repos/{owner}/{repo}/security-advisories` and
 * global `/advisories` records share this shape). Malformed input yields null
 * instead of throwing so one bad upstream record cannot break a scan.
 */
export function parseAdvisory(input: unknown): ParsedAdvisory | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const advisoryId = record.ghsa_id;
  if (typeof advisoryId !== "string" || !GHSA_ID_PATTERN.test(advisoryId)) return null;
  const rawVulnerabilities = Array.isArray(record.vulnerabilities) ? record.vulnerabilities : [];
  const vulnerabilities: ParsedAdvisoryVulnerability[] = [];
  for (const entry of rawVulnerabilities) {
    if (typeof entry !== "object" || entry === null) continue;
    const vulnerability = entry as Record<string, unknown>;
    const affected = vulnerability.package;
    if (typeof affected !== "object" || affected === null) continue;
    const packageName = (affected as Record<string, unknown>).name;
    if (typeof packageName !== "string" || packageName.length === 0) continue;
    const ecosystem = (affected as Record<string, unknown>).ecosystem;
    const vulnerableRange = vulnerability.vulnerable_version_range;
    vulnerabilities.push({
      ecosystem: typeof ecosystem === "string" ? ecosystem : "",
      packageName,
      vulnerableRange: typeof vulnerableRange === "string" ? vulnerableRange : "",
    });
  }
  return { advisoryId, vulnerabilities };
}

/**
 * Build the reviewed package inventory from ci/reviewed-npm-audit.json:
 * every committed archive package and locked graph package spec.
 */
export function parseInventoryFromAuditConfig(config: unknown, origin: string): InventoryEntry[] {
  if (typeof config !== "object" || config === null) return [];
  const record = config as Record<string, unknown>;
  const inventory: InventoryEntry[] = [];
  for (const key of ["archivePackages", "lockedGraphs"]) {
    const entries = record[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const packageSpec = (entry as Record<string, unknown>).packageSpec;
      if (typeof packageSpec !== "string") continue;
      const separator = packageSpec.lastIndexOf("@");
      if (separator <= 0) continue;
      const name = packageSpec.slice(0, separator);
      const version = packageSpec.slice(separator + 1);
      if (!parseVersion(version)) continue;
      inventory.push({ name, version, origin });
    }
  }
  return inventory;
}

/**
 * Build an installed-package inventory from a lockfile-version-3 package-lock
 * subset: every `node_modules/...` entry that records an installed version.
 */
export function parseInventoryFromPackageLock(lock: unknown, origin: string): InventoryEntry[] {
  if (typeof lock !== "object" || lock === null) return [];
  const packages = (lock as Record<string, unknown>).packages;
  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) return [];
  const inventory: InventoryEntry[] = [];
  for (const [location, entry] of Object.entries(packages)) {
    const marker = location.lastIndexOf("node_modules/");
    if (marker < 0) continue;
    const pathName = location.slice(marker + "node_modules/".length);
    if (pathName.length === 0) continue;
    if (typeof entry !== "object" || entry === null) continue;
    const version = (entry as Record<string, unknown>).version;
    if (typeof version !== "string" || version.length === 0) continue;
    // Aliased installs (`npm install alias@npm:real-name`) live under the alias
    // path but record the real package name in `name`; advisories name the
    // real package, so prefer it when present.
    const recordedName = (entry as Record<string, unknown>).name;
    const name =
      typeof recordedName === "string" && recordedName.length > 0 ? recordedName : pathName;
    inventory.push({ name, version, origin });
  }
  return inventory;
}

type SignalEvidence = {
  ranges: string[];
  versions: Set<string>;
};

type SignalDraft = {
  advisoryId: string;
  package: string;
  exact: SignalEvidence;
  ambiguous: SignalEvidence;
};

function addEvidence(evidence: SignalEvidence, range: string, versions: Iterable<string>): void {
  if (!evidence.ranges.includes(range)) evidence.ranges.push(range);
  for (const version of versions) evidence.versions.add(version);
}

/**
 * Correlate upstream advisories with the reviewed inventory.
 *
 * - exact npm ecosystem + package-name + parseable-range matches emit
 *   confidence "exact" / action "investigate";
 * - name collisions from non-npm ecosystems (CPE-style records) and
 *   unparseable ranges emit confidence "ambiguous" / action "informational";
 * - packages absent from the inventory, versions proven outside the range,
 *   and malformed advisory objects emit nothing.
 *
 * Exact and ambiguous evidence for the same advisory and package are tracked
 * separately: an exact signal carries only the proving range(s) and verified
 * matched versions, and ambiguous evidence never upgrades into it.
 *
 * No output of this function may block or mutate a release; the reviewed
 * npm audit gate remains the authoritative package-level enforcement source.
 */
export function correlateAdvisories(
  advisories: readonly unknown[],
  inventory: readonly InventoryEntry[],
): AdvisorySignal[] {
  const versionsByName = new Map<string, Set<string>>();
  for (const entry of inventory) {
    const versions = versionsByName.get(entry.name) ?? new Set<string>();
    versions.add(entry.version);
    versionsByName.set(entry.name, versions);
  }
  const drafts = new Map<string, SignalDraft>();
  for (const input of advisories) {
    const advisory = parseAdvisory(input);
    if (!advisory) continue;
    for (const vulnerability of advisory.vulnerabilities) {
      const versions = versionsByName.get(vulnerability.packageName);
      if (!versions || versions.size === 0) continue;
      let confidence: AdvisoryConfidence | null = null;
      const matchedVersions = new Set<string>();
      if (vulnerability.ecosystem.toLowerCase() === "npm") {
        const unverifiable = new Set<string>();
        for (const version of versions) {
          const satisfied = satisfiesVulnerableRange(version, vulnerability.vulnerableRange);
          if (satisfied === true) matchedVersions.add(version);
          if (satisfied === null) unverifiable.add(version);
        }
        if (matchedVersions.size > 0) {
          confidence = "exact";
        } else if (unverifiable.size > 0) {
          confidence = "ambiguous";
          for (const version of unverifiable) matchedVersions.add(version);
        }
      } else {
        // A non-npm (for example CPE-derived) record naming an npm package is
        // never a verified npm mapping; surface it for awareness only.
        confidence = "ambiguous";
        for (const version of versions) matchedVersions.add(version);
      }
      if (confidence === null) continue;
      const key = `${advisory.advisoryId} ${vulnerability.packageName}`;
      const draft = drafts.get(key) ?? {
        advisoryId: advisory.advisoryId,
        package: vulnerability.packageName,
        exact: { ranges: [], versions: new Set<string>() },
        ambiguous: { ranges: [], versions: new Set<string>() },
      };
      addEvidence(
        confidence === "exact" ? draft.exact : draft.ambiguous,
        vulnerability.vulnerableRange,
        matchedVersions,
      );
      drafts.set(key, draft);
    }
  }
  return [...drafts.values()]
    .map((draft) => {
      const confidence: AdvisoryConfidence = draft.exact.versions.size > 0 ? "exact" : "ambiguous";
      const evidence = confidence === "exact" ? draft.exact : draft.ambiguous;
      return {
        advisoryId: draft.advisoryId,
        package: draft.package,
        vulnerableRange: evidence.ranges.join("; "),
        matchedVersions: [...evidence.versions].sort(),
        source: "upstream-ghsa" as const,
        confidence,
        action: confidence === "exact" ? ("investigate" as const) : ("informational" as const),
      };
    })
    .sort((left, right) =>
      left.advisoryId === right.advisoryId
        ? left.package.localeCompare(right.package)
        : left.advisoryId.localeCompare(right.advisoryId),
    );
}
