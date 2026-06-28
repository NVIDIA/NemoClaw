// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  OPENSHELL_LIFECYCLE_EXEC_CAPABILITY_MARKER,
  OPENSHELL_HERMES_MCP_LIFECYCLE_OPERATION,
  OPENSHELL_MCP_TRANSPORT_CAPABILITY_MARKER,
} from "../adapters/openshell/runtime-capabilities";

export const REQUIRED_OPENSHELL_MCP_FEATURES = [
  "request-body-credential-rewrite",
  "websocket-credential-rewrite",
  "allow_all_known_mcp_methods",
  OPENSHELL_LIFECYCLE_EXEC_CAPABILITY_MARKER,
  OPENSHELL_HERMES_MCP_LIFECYCLE_OPERATION,
] as const;

export const REQUIRED_OPENSHELL_SANDBOX_MCP_TRANSPORT_FEATURE =
  OPENSHELL_MCP_TRANSPORT_CAPABILITY_MARKER;
export const REQUIRED_OPENSHELL_SANDBOX_LIFECYCLE_FEATURE =
  OPENSHELL_LIFECYCLE_EXEC_CAPABILITY_MARKER;

// This scan is the fail-closed preflight available before an installed gateway
// can answer the structured `provider status --output json` capability query.
// Runtime MCP mutations additionally require that query and the exact Hermes
// lifecycle probe. Keep MCP E2E defaults on the checksummed current-main `dev`
// channel until the first stable OpenShell release advertises every capability
// in OPENSHELL_REQUIRED_MCP_GATEWAY_CAPABILITIES and passes the in-sandbox
// lifecycle probe. At that point switch workflow defaults to `stable`; retain
// the artifact scan, structured query, and runtime probe as downgrade guards.
// A version check alone is not sufficient for moving or mixed-component builds.

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

  // This marker is meaningful only in the sandbox supervisor that performs
  // TLS enforcement, Host binding, and credential replacement. Do not accept
  // a matching string from the CLI, gateway, or a union of unrelated binaries.
  const sandboxCandidates = [
    options.sandboxBin,
    path.join(path.dirname(options.openshellBin), "openshell-sandbox"),
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  const sandboxMarkers = [
    REQUIRED_OPENSHELL_SANDBOX_MCP_TRANSPORT_FEATURE,
    REQUIRED_OPENSHELL_SANDBOX_LIFECYCLE_FEATURE,
    OPENSHELL_HERMES_MCP_LIFECYCLE_OPERATION,
  ].map((marker) => Buffer.from(marker));
  let foundRuntimeArtifact = false;
  for (const candidate of new Set(sandboxCandidates)) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(candidate, "r");
      if (!fs.fstatSync(fd).isFile()) continue;
      foundRuntimeArtifact = true;
      const content = fs.readFileSync(fd);
      if (sandboxMarkers.every((marker) => content.includes(marker))) return true;
    } catch {
      // Try the next exact sandbox-runtime candidate.
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
  // VM drivers embed a compressed supervisor, so scanning their host binary is
  // neither sufficient nor reliable. Some VM/Docker installations expose no
  // supervisor host file at all.
  // The MCP lifecycle performs the authoritative in-sandbox runtime probe
  // before any provider or policy mutation.
  return !foundRuntimeArtifact;
}
