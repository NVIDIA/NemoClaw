#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * Temporary compatibility patch for OpenClaw 2026.7.1 gateway daemon
 * self-dialback.
 *
 * NemoClaw exports OPENCLAW_GATEWAY_URL so agent processes can reach the
 * gateway through its OpenShell-allowed private interface. The gateway daemon
 * inherits that URL, but its own backend RPC calls must remain on loopback or
 * OpenClaw treats the proxy-reoriginated connection as a remote device and
 * requires pairing. OpenClaw marks only the daemon process with the
 * "openclaw-gateway" title, so ignore the inherited URL only in that process
 * and only when OPENSHELL_SANDBOX is exactly "1". Explicit URL overrides and
 * configured remote URLs remain unchanged.
 *
 * Remove this patch when upstream distinguishes gateway daemon self-dialback
 * from descendant agent routing without changing the daemon environment.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const AUDIT_FLAG = "--audit";
const EXIT_USAGE = 2;
const EXIT_AUDIT_FAILURE = 3;

export const CALL_CONTEXT_MARKER =
  "/* nemoclaw: keep gateway-daemon backend RPC on loopback (#7215) */";
export const CONNECTION_DETAILS_MARKER =
  "/* nemoclaw: keep gateway-daemon connection resolution on loopback (#7215) */";
export const TOOL_TARGET_MARKER =
  "/* nemoclaw: classify gateway-daemon tool RPC as local (#7215) */";

interface PatchSpec {
  readonly label: string;
  readonly marker: string;
  readonly upstream: string;
  readonly patched: string;
}

interface PatchTextResult {
  readonly status: "already-patched" | "patched";
  readonly text: string;
}

export interface PatchDistResult {
  readonly files: readonly string[];
  readonly status: "already-patched" | "patched";
}

const CALL_CONTEXT_SPEC: PatchSpec = {
  label: "gateway call context",
  marker: CALL_CONTEXT_MARKER,
  upstream:
    "const envUrlOverride = cliUrlOverride || opts.localPortOverride !== void 0 ? void 0 : trimToUndefined(process.env.OPENCLAW_GATEWAY_URL);",
  patched: [
    `const nemoclawGatewaySelfDialback = process.title === "openclaw-gateway" && process.env.OPENSHELL_SANDBOX === "1"; ${CALL_CONTEXT_MARKER}`,
    "const envUrlOverride = cliUrlOverride || opts.localPortOverride !== void 0 || nemoclawGatewaySelfDialback ? void 0 : trimToUndefined(process.env.OPENCLAW_GATEWAY_URL);",
  ].join("\n\t"),
};

const CONNECTION_DETAILS_SPEC: PatchSpec = {
  label: "gateway connection details",
  marker: CONNECTION_DETAILS_MARKER,
  upstream:
    "const envUrlOverride = cliUrlOverride || options.ignoreEnvUrlOverride || options.localPortOverride !== void 0 ? void 0 : normalizeOptionalString(process.env.OPENCLAW_GATEWAY_URL);",
  patched: [
    `const nemoclawGatewaySelfDialback = process.title === "openclaw-gateway" && process.env.OPENSHELL_SANDBOX === "1"; ${CONNECTION_DETAILS_MARKER}`,
    "const envUrlOverride = cliUrlOverride || options.ignoreEnvUrlOverride || options.localPortOverride !== void 0 || nemoclawGatewaySelfDialback ? void 0 : normalizeOptionalString(process.env.OPENCLAW_GATEWAY_URL);",
  ].join("\n\t"),
};

const TOOL_TARGET_SPEC: PatchSpec = {
  label: "agent-tool gateway",
  marker: TOOL_TARGET_MARKER,
  upstream: 'if (params.envGatewayUrl) return "remote";',
  patched: [
    `const nemoclawGatewaySelfDialback = process.title === "openclaw-gateway" && process.env.OPENSHELL_SANDBOX === "1"; ${TOOL_TARGET_MARKER}`,
    'if (params.envGatewayUrl && !nemoclawGatewaySelfDialback) return "remote";',
  ].join("\n\t"),
};

const PATCH_SPECS = [CALL_CONTEXT_SPEC, CONNECTION_DETAILS_SPEC, TOOL_TARGET_SPEC] as const;

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function patchText(source: string, file: string, spec: PatchSpec): PatchTextResult {
  const markerCount = countOccurrences(source, spec.marker);
  const patchedCount = countOccurrences(source, spec.patched);
  const upstreamCount = countOccurrences(source, spec.upstream);
  if (markerCount === 1 && patchedCount === 1 && upstreamCount === 0) {
    return { status: "already-patched", text: source };
  }
  if (markerCount !== 0 || patchedCount !== 0 || upstreamCount !== 1) {
    throw new Error(
      `${file}: expected one unpatched or one patched ${spec.label} shape; found ${upstreamCount} upstream, ${patchedCount} patched, and ${markerCount} marker occurrences`,
    );
  }
  const text = source.replace(spec.upstream, spec.patched);
  if (
    countOccurrences(text, spec.marker) !== 1 ||
    countOccurrences(text, spec.patched) !== 1 ||
    countOccurrences(text, spec.upstream) !== 0
  ) {
    throw new Error(`${file}: failed to verify patched ${spec.label} shape`);
  }
  return { status: "patched", text };
}

export function patchGatewayCallContextText(
  source: string,
  file = "<gateway-call>",
): PatchTextResult {
  return patchText(source, file, CALL_CONTEXT_SPEC);
}

export function patchGatewayConnectionDetailsText(
  source: string,
  file = "<gateway-connection-details>",
): PatchTextResult {
  return patchText(source, file, CONNECTION_DETAILS_SPEC);
}

export function patchGatewayToolTargetText(
  source: string,
  file = "<gateway-tool-target>",
): PatchTextResult {
  return patchText(source, file, TOOL_TARGET_SPEC);
}

function listJavaScriptFiles(distDir: string): string[] {
  return fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(distDir, entry.name));
}

function findTarget(
  entries: ReadonlyArray<{ file: string; source: string }>,
  spec: PatchSpec,
): { file: string; source: string } {
  const matches = entries.filter(
    ({ source }) => source.includes(spec.upstream) || source.includes(spec.marker),
  );
  if (matches.length !== 1) {
    throw new Error(
      `OpenClaw dist: expected exactly one ${spec.label} target, found ${matches.length}`,
    );
  }
  return matches[0] as { file: string; source: string };
}

export function patchOpenClawGatewayDaemonDialback(
  distDir: string,
  options: { audit?: boolean } = {},
): PatchDistResult {
  const entries = listJavaScriptFiles(distDir).map((file) => ({
    file,
    source: fs.readFileSync(file, "utf8"),
  }));
  const changedFiles = new Set<string>();
  const files: string[] = [];

  for (const spec of PATCH_SPECS) {
    const target = findTarget(entries, spec);
    const result = patchText(target.source, target.file, spec);
    if (options.audit && result.status !== "already-patched") {
      throw new Error(`${target.file}: ${spec.label} patch is not applied`);
    }
    files.push(target.file);
    if (result.status === "patched") {
      changedFiles.add(target.file);
      target.source = result.text;
    }
  }

  if (!options.audit) {
    for (const { file, source } of entries) {
      if (changedFiles.has(file)) fs.writeFileSync(file, source);
    }
  }

  return {
    files,
    status: changedFiles.size === 0 ? "already-patched" : "patched",
  };
}

function usage(): string {
  return "Usage: patch-gateway-daemon-dialback.mts [--audit] <openclaw-dist-dir>";
}

function main(): void {
  const args = process.argv.slice(2);
  const audit = args.includes(AUDIT_FLAG);
  const positional = args.filter((arg) => arg !== AUDIT_FLAG);
  if (positional.length !== 1) {
    console.error(usage());
    process.exit(EXIT_USAGE);
  }
  try {
    const result = patchOpenClawGatewayDaemonDialback(path.resolve(positional[0] as string), {
      audit,
    });
    console.log(
      `${audit ? "audited" : result.status === "patched" ? "patched" : "already patched"} OpenClaw gateway daemon self-dialback (${result.files.length} files)`,
    );
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(audit ? EXIT_AUDIT_FAILURE : 1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) main();
