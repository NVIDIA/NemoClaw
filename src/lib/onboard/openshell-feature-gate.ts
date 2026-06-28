// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { OPENSHELL_MCP_POLICY_CAPABILITY_MARKER } from "../adapters/openshell/runtime-capabilities";

export const REQUIRED_OPENSHELL_MCP_FEATURES = [
  "request-body-credential-rewrite",
  "websocket-credential-rewrite",
  OPENSHELL_MCP_POLICY_CAPABILITY_MARKER,
] as const;

export const REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE = OPENSHELL_MCP_POLICY_CAPABILITY_MARKER;

// OpenShell current main has no structured installed-feature response. Scan the
// installed artifacts before onboarding; the running supervisor is validated
// later by applying the actual generated MCP policy with `policy set --wait`.
// Version alone is insufficient for mixed-component installations.

export function hasRequiredOpenshellMessagingFeatures(options: {
  openshellBin: string | null;
  gatewayBin: string | null;
  sandboxBin: string | null;
}): boolean {
  if (!options.openshellBin) return false;
  const candidates = [
    options.openshellBin,
    path.join(path.dirname(options.openshellBin), "openshell-gateway"),
    path.join(path.dirname(options.openshellBin), "openshell-sandbox"),
    path.join(path.dirname(options.openshellBin), "openshell-driver-vm"),
    options.gatewayBin,
    options.sandboxBin,
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
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
      continue;
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
  const sandboxCandidates = [
    options.sandboxBin,
    path.join(path.dirname(options.openshellBin), "openshell-sandbox"),
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  const sandboxMarker = Buffer.from(REQUIRED_OPENSHELL_SANDBOX_MCP_FEATURE);
  let foundRuntimeArtifact = false;
  for (const candidate of new Set(sandboxCandidates)) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(candidate, "r");
      if (!fs.fstatSync(fd).isFile()) continue;
      foundRuntimeArtifact = true;
      const content = fs.readFileSync(fd);
      if (content.includes(sandboxMarker)) return true;
    } catch {
      // Try the next exact sandbox-runtime candidate.
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
  // VM drivers embed a compressed supervisor, so scanning their host binary is
  // neither sufficient nor reliable. Some VM/Docker installations expose no
  // supervisor host file at all.
  // The MCP command performs the in-sandbox runtime probe before any provider
  // or policy mutation.
  return !foundRuntimeArtifact;
}
