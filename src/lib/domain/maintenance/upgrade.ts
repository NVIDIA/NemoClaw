// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { UpgradeSandboxesOptions } from "../lifecycle/options";

export type SandboxVersionCheck = {
  isStale: boolean;
  sandboxVersion?: string | null;
  expectedVersion?: string | null;
  detectionMethod?: string | null;
  /**
   * True whenever staleness could not be confirmed — probe failure, no
   * expected version, opt-out probing, or a scheme mismatch between the
   * runtime and manifest versions. `classifyUpgradeableSandboxes` treats
   * these as `unknown` candidates so the operator can decide whether to
   * rebuild rather than silently letting them fall through as "current".
   */
  verificationFailed?: boolean;
};

/**
 * Why a sandbox is classified as needing an upgrade. A sandbox can be stale
 * because its agent version is behind (`agent-version`), because the NemoClaw
 * build that produced its image differs from the running NemoClaw
 * (`image-drift`), or both (#5026).
 */
export type UpgradeStaleReason = "agent-version" | "image-drift";

export type UpgradeSandboxCandidate = {
  name: string;
  current?: string | null;
  expected?: string | null;
  running: boolean;
  // Present on stale candidates: the reasons the sandbox needs a rebuild.
  reasons?: UpgradeStaleReason[];
  // NemoClaw build fingerprint comparison, set only for `image-drift`.
  // `imageCurrent` is the build recorded on the sandbox (null when it predates
  // fingerprinting); `imageExpected` is the running NemoClaw build.
  imageCurrent?: string | null;
  imageExpected?: string | null;
};

export type UpgradeClassification = {
  stale: UpgradeSandboxCandidate[];
  unknown: UpgradeSandboxCandidate[];
};

export interface ClassifyUpgradeOptions {
  /**
   * Running NemoClaw build fingerprint, used to detect image drift (#5026).
   * When null/undefined, image-drift detection is disabled and only the agent
   * version is considered (legacy behavior).
   */
  currentNemoclawVersion?: string | null;
}

export function shouldSkipUpgradeConfirmation(options: UpgradeSandboxesOptions): boolean {
  return options.auto === true || options.yes === true;
}

/**
 * Whether the NemoClaw build recorded on a sandbox differs from the running
 * build. Drift requires POSITIVE evidence: a recorded fingerprint that differs
 * from the running build. Only NemoClaw-managed images carry a fingerprint, so
 * this never flags a custom-image (`--from`) sandbox — which `upgrade-sandboxes`
 * could otherwise rebuild onto the default image, losing the custom image. A
 * missing fingerprint is therefore treated as "not drifted": it is ambiguous
 * (a legacy managed image OR a legacy custom image, indistinguishable on disk),
 * so the sandbox opts into drift detection once it is rebuilt and gains a
 * fingerprint. Detection is also disabled when the running build is unknown.
 * (#5026)
 */
export function isNemoclawImageStale(
  recorded: string | null | undefined,
  current: string | null | undefined,
): boolean {
  if (!current) return false;
  if (!recorded) return false;
  return recorded !== current;
}

export function classifyUpgradeableSandboxes(
  sandboxes: Array<{ name: string; nemoclawVersion?: string | null }>,
  liveNames: ReadonlySet<string>,
  checkVersion: (name: string) => SandboxVersionCheck,
  options: ClassifyUpgradeOptions = {},
): UpgradeClassification {
  const currentNemoclawVersion = options.currentNemoclawVersion ?? null;
  const stale: UpgradeSandboxCandidate[] = [];
  const unknown: UpgradeSandboxCandidate[] = [];
  for (const sandbox of sandboxes) {
    const versionCheck = checkVersion(sandbox.name);
    const reasons: UpgradeStaleReason[] = [];
    if (versionCheck.isStale) reasons.push("agent-version");
    const imageStale = isNemoclawImageStale(sandbox.nemoclawVersion, currentNemoclawVersion);
    if (imageStale) reasons.push("image-drift");

    if (reasons.length > 0) {
      stale.push({
        name: sandbox.name,
        current: versionCheck.sandboxVersion,
        expected: versionCheck.expectedVersion,
        running: liveNames.has(sandbox.name),
        reasons,
        ...(imageStale
          ? {
              imageCurrent: sandbox.nemoclawVersion ?? null,
              imageExpected: currentNemoclawVersion,
            }
          : {}),
      });
    } else if (
      versionCheck.detectionMethod === "unavailable" ||
      versionCheck.detectionMethod === "unknown" ||
      versionCheck.verificationFailed
    ) {
      unknown.push({
        name: sandbox.name,
        expected: versionCheck.expectedVersion,
        running: liveNames.has(sandbox.name),
      });
    }
  }
  return { stale, unknown };
}

export function splitRebuildableSandboxes(stale: UpgradeSandboxCandidate[]): {
  rebuildable: UpgradeSandboxCandidate[];
  stopped: UpgradeSandboxCandidate[];
} {
  const rebuildable: UpgradeSandboxCandidate[] = [];
  const stopped: UpgradeSandboxCandidate[] = [];
  for (const sandbox of stale) {
    if (sandbox.running) {
      rebuildable.push(sandbox);
    } else {
      stopped.push(sandbox);
    }
  }
  return { rebuildable, stopped };
}

/**
 * Compare two dotted version strings numerically, segment by segment.
 * Canonical home of the comparison used by gateway compatibility checks and
 * upgrade display; `onboard/docker-driver-gateway-compat` re-exports it for
 * its existing consumers.
 */
export function compareDottedVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

// #6520: a requested version below the recorded one is a downgrade (e.g.
// reinstalling with an older NEMOCLAW_INSTALL_TAG than the build that created
// the sandbox); call it out instead of framing it as a routine upgrade step.
function downgradeSuffix(current?: string | null, expected?: string | null): string {
  if (!current || !expected) return "";
  return compareDottedVersions(expected, current) < 0 ? " (downgrade)" : "";
}

/**
 * Build a human-readable description of why a sandbox needs rebuilding,
 * covering an outdated agent version, NemoClaw image/build drift, or both
 * (#5026), and labeling version regressions explicitly (#6520).
 */
export function describeStaleUpgrade(s: UpgradeSandboxCandidate): string {
  const reasons = s.reasons ?? [];
  const parts: string[] = [];
  if (reasons.includes("agent-version")) {
    parts.push(`v${s.current || "?"} → v${s.expected}${downgradeSuffix(s.current, s.expected)}`);
  } else if (reasons.includes("image-drift") && s.current) {
    // Agent version is current; make clear it is the NemoClaw image that drifted.
    parts.push(`v${s.current} unchanged`);
  }
  if (reasons.includes("image-drift")) {
    const from = s.imageCurrent ? `v${s.imageCurrent}` : "unknown build";
    parts.push(
      `NemoClaw image ${from} → v${s.imageExpected}${downgradeSuffix(s.imageCurrent, s.imageExpected)}`,
    );
  }
  return parts.join("; ");
}
