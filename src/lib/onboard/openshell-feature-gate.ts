// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { OPENSHELL_MCP_POLICY_CAPABILITY_MARKER } from "../adapters/openshell/runtime-capabilities";

/**
 * Installation-integrity preflight shared by onboarding and install repair.
 *
 * This stays separate from either caller because it validates the selected
 * host-visible OpenShell component set, rejects mixed or stale installations,
 * and is also the single migration point for a future native capability
 * command. Supervisor artifacts that are not host-visible remain subject to
 * authoritative runtime policy verification. This gate does not authorize MCP
 * mutations.
 */

export const REQUIRED_OPENSHELL_MCP_FEATURES = [
  "request-body-credential-rewrite",
  "websocket-credential-rewrite",
  OPENSHELL_MCP_POLICY_CAPABILITY_MARKER,
] as const;

export const REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE = OPENSHELL_MCP_POLICY_CAPABILITY_MARKER;

function canonicalExecutableFile(candidate: string): string | null {
  try {
    const canonical = fs.realpathSync(candidate);
    if (!fs.statSync(canonical).isFile()) return null;
    fs.accessSync(canonical, fs.constants.R_OK | fs.constants.X_OK);
    return canonical;
  } catch {
    return null;
  }
}

function pathEntryExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

const PINNED_SANDBOX_BUILD_VERSIONS = new Map<string, string>([
  // OpenShell v0.0.72 standalone sandbox binaries. The Docker driver only
  // bind-mounts these into the supervisor container, so the host may be too
  // old to execute `--version` (the release requires GLIBC_2.39).
  ["f9f991a24d10772ad5d24ae27a8ea6baad8cac671695bd90fcd0355e0e0ad198", "0.0.72"],
  ["32ca44fe7d9e6d332f2a753c6b8a1a6117b7388281dad9b5274d23ffc67e216f", "0.0.72"],
]);

export function pinnedOpenShellSandboxBuildVersion(sha256: string): string | null {
  return PINNED_SANDBOX_BUILD_VERSIONS.get(sha256.toLowerCase()) ?? null;
}

function executableSha256(candidate: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(candidate)).digest("hex");
  } catch {
    return null;
  }
}

export function resolveOpenShellComponentBuildVersion(
  candidate: string,
  componentRole: "cli" | "gateway" | "sandbox",
  digestFile: (path: string) => string | null = executableSha256,
): string | null {
  const result = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status === 0 && !result.error) {
    const version = `${result.stdout}${result.stderr}`.match(/\d+\.\d+\.\d+\S*/)?.[0];
    if (version) return version;
  }

  // Never synthesize coherence from arbitrary version-like strings embedded
  // in a binary. The fallback is sandbox-only and exact-digest pinned.
  if (componentRole !== "sandbox") return null;
  const digest = digestFile(candidate);
  return digest ? pinnedOpenShellSandboxBuildVersion(digest) : null;
}

function componentBuildVersionsMatch(left: string, right: string): boolean {
  if (left === right) return true;
  const leftGit = left.match(/^(.*\+g)([0-9a-f]{7,})$/i);
  const rightGit = right.match(/^(.*\+g)([0-9a-f]{7,})$/i);
  return Boolean(
    leftGit &&
      rightGit &&
      leftGit[1] === rightGit[1] &&
      (leftGit[2].startsWith(rightGit[2]) || rightGit[2].startsWith(leftGit[2])),
  );
}

// invalidState: a mixed or stale OpenShell installation appears feature-ready
// from version text alone. sourceBoundary: OpenShell owns component identity
// and the future native capability response; this scanner is an artifact and
// install-repair preflight only and never authorizes an MCP mutation.
// whyNotSourceFix: v0.0.72 has no structured installed-feature response.
// regressionTest: openshell-feature-gate.test.ts covers mixed roots, symlink
// farms, stale components, unreadable binaries, and the pinned sandbox digest.
// removalCondition: replace this scan when OpenShell exposes a versioned native
// capability command. Until then the running supervisor remains authoritative:
// MCP applies and exact-matches the generated policy with `policy set --wait`
// before provider credentials are created or updated.

export function hasRequiredOpenshellMessagingFeatures(options: {
  openshellBin: string | null;
  gatewayBin: string | null;
  sandboxBin: string | null;
  allowExternalGatewayBin?: boolean;
  allowExternalSandboxBin?: boolean;
  requireSandboxBin?: boolean;
}): boolean {
  if (!options.openshellBin) return false;
  const selectedOpenshellBin = path.resolve(options.openshellBin);
  const openshellBin = canonicalExecutableFile(selectedOpenshellBin);
  if (!openshellBin) return false;
  const openshellDir = path.dirname(openshellBin);
  const selectedGatewayBin = options.gatewayBin
    ? path.resolve(options.gatewayBin)
    : path.join(path.dirname(selectedOpenshellBin), "openshell-gateway");
  const requireSandboxBin = options.requireSandboxBin ?? true;
  const selectedSandboxBin = requireSandboxBin
    ? options.sandboxBin
      ? path.resolve(options.sandboxBin)
      : path.join(path.dirname(selectedOpenshellBin), "openshell-sandbox")
    : null;
  const gatewayBin = canonicalExecutableFile(selectedGatewayBin);
  const sandboxBin = selectedSandboxBin ? canonicalExecutableFile(selectedSandboxBin) : null;
  if ((options.gatewayBin || pathEntryExists(selectedGatewayBin)) && !gatewayBin) return false;
  if (
    selectedSandboxBin &&
    (options.sandboxBin || pathEntryExists(selectedSandboxBin)) &&
    !sandboxBin
  ) {
    return false;
  }
  if (gatewayBin && path.dirname(gatewayBin) !== openshellDir && !options.allowExternalGatewayBin) {
    return false;
  }
  if (sandboxBin && path.dirname(sandboxBin) !== openshellDir && !options.allowExternalSandboxBin) {
    return false;
  }
  const openshellVersion = resolveOpenShellComponentBuildVersion(openshellBin, "cli");
  if (!openshellVersion) return false;
  for (const [componentBin, componentRole] of [
    [gatewayBin, "gateway"],
    [sandboxBin, "sandbox"],
  ] as const) {
    if (!componentBin) continue;
    const componentVersion = resolveOpenShellComponentBuildVersion(componentBin, componentRole);
    if (!componentVersion || !componentBuildVersionsMatch(openshellVersion, componentVersion)) {
      return false;
    }
  }

  // Scan one selected component set. Do not union arbitrary PATH fallbacks or
  // let an explicit external component be rescued by a different sibling.
  const candidates = [openshellBin, gatewayBin, sandboxBin].filter(
    (candidate): candidate is string => candidate !== null,
  );

  const requiredMarkers = REQUIRED_OPENSHELL_MCP_FEATURES.map((marker) => Buffer.from(marker));
  const foundMarkers = new Set<string>();
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    let content: Buffer;
    let fd: number | null = null;
    try {
      fd = fs.openSync(candidate, "r");
      if (!fs.fstatSync(fd).isFile()) continue;
      content = fs.readFileSync(fd);
    } catch {
      return false;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
    for (let index = 0; index < requiredMarkers.length; index += 1) {
      if (content.includes(requiredMarkers[index])) {
        foundMarkers.add(REQUIRED_OPENSHELL_MCP_FEATURES[index]);
      }
    }
    if (REQUIRED_OPENSHELL_MCP_FEATURES.every((marker) => foundMarkers.has(marker))) break;
  }
  if (!REQUIRED_OPENSHELL_MCP_FEATURES.every((marker) => foundMarkers.has(marker))) return false;

  // MCP policy enforcement and credential replacement execute in the sandbox
  // supervisor. When that exact host artifact is available, require its native
  // MCP marker rather than accepting a union of unrelated binaries.
  const sandboxMarker = Buffer.from(REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE);
  if (sandboxBin) {
    try {
      return fs.readFileSync(sandboxBin).includes(sandboxMarker);
    } catch {
      return false;
    }
  }
  // VM drivers embed a compressed supervisor, so scanning their host binary is
  // neither sufficient nor reliable. Some VM/Docker installations expose no
  // supervisor host file at all.
  // Returning true here means only that no install repair can be justified
  // from host artifacts. The MCP command's authoritative runtime check loads
  // the exact generated protocol:mcp policy with --wait and exact-matches the
  // effective state before any credential or provider side effect.
  return true;
}
