// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export const COMPETING_OPENSHELL_GATEWAY_SERVICE_PROPERTIES = [
  "ExecStart",
  "ActiveState",
  "UnitFileState",
] as const;

type CompetingServiceProperty = (typeof COMPETING_OPENSHELL_GATEWAY_SERVICE_PROPERTIES)[number];

export type OpenShellGatewayServiceMetadataVerdict =
  | "unrelated"
  | "different-port"
  | "block-invalid-selected-port"
  | "block-malformed-metadata"
  | "block-ambiguous-executable"
  | "block-untrusted-executable"
  | "block-ambiguous-port"
  | "block-selected-port";

export interface OpenShellGatewayServiceMetadataInput {
  enabledByActivationPath: boolean;
  gatewayPort: number;
  metadata: string;
  trustedExecutablePaths: readonly string[];
}

const SYSTEMD_ACTIVE_STATES = new Set([
  "active",
  "activating",
  "deactivating",
  "failed",
  "inactive",
  "maintenance",
  "refreshing",
  "reloading",
]);

const SYSTEMD_UNIT_FILE_STATES = new Set([
  "alias",
  "bad",
  "disabled",
  "enabled",
  "enabled-runtime",
  "generated",
  "indirect",
  "linked",
  "linked-runtime",
  "masked",
  "masked-runtime",
  "not-found",
  "static",
  "transient",
]);

function parseSystemctlShowMetadata(
  metadata: string,
): Record<CompetingServiceProperty, string> | null {
  const expected = new Set<string>(COMPETING_OPENSHELL_GATEWAY_SERVICE_PROPERTIES);
  const properties: Partial<Record<CompetingServiceProperty, string>> = {};
  for (const line of metadata.split(/\r?\n/u)) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    const property = separator > 0 ? line.slice(0, separator) : "";
    if (!expected.has(property) || Object.hasOwn(properties, property)) return null;
    properties[property as CompetingServiceProperty] = line.slice(separator + 1).trim();
  }
  if (
    !COMPETING_OPENSHELL_GATEWAY_SERVICE_PROPERTIES.every((property) =>
      Object.hasOwn(properties, property),
    )
  ) {
    return null;
  }
  return properties as Record<CompetingServiceProperty, string>;
}

function extractExecStartPaths(execStart: string): string[] {
  return Array.from(
    execStart.matchAll(/(?:^|[\s;{])path=([^\s;}]+)/gu),
    (match) => match[1]?.trim() ?? "",
  );
}

function stripMatchingQuotes(value: string): string {
  const first = value.at(0);
  return value.length >= 2 && (first === '"' || first === "'") && value.at(-1) === first
    ? value.slice(1, -1)
    : value;
}

function parseExecStartPort(execStart: string): number | null {
  const argvMatches = Array.from(
    execStart.matchAll(/(?:^|[\s;{])argv\[\]=([^;}]*)(?=[;}])/gu),
    (match) => match[1]?.trim() ?? "",
  );
  if (argvMatches.length !== 1) return null;

  const argv = argvMatches[0].split(/\s+/u).filter(Boolean);
  const rawPorts: string[] = [];
  let occurrenceCount = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = stripMatchingQuotes(argv[index]);
    if (argument === "--port") {
      occurrenceCount += 1;
      const value = argv[index + 1];
      if (value !== undefined) {
        rawPorts.push(stripMatchingQuotes(value));
        index += 1;
      }
      continue;
    }
    if (argument.startsWith("--port=")) {
      occurrenceCount += 1;
      rawPorts.push(argument.slice("--port=".length));
    }
  }
  if (occurrenceCount !== 1 || rawPorts.length !== 1 || !/^\d+$/u.test(rawPorts[0])) return null;
  const port = Number(rawPorts[0]);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

/** Classify read-only systemd metadata without reading service environment values. */
export function classifyOpenShellGatewayServiceMetadata({
  enabledByActivationPath,
  gatewayPort,
  metadata,
  trustedExecutablePaths,
}: OpenShellGatewayServiceMetadataInput): OpenShellGatewayServiceMetadataVerdict {
  if (!Number.isSafeInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65_535) {
    return "block-invalid-selected-port";
  }
  const properties = parseSystemctlShowMetadata(metadata);
  if (!properties) return "block-malformed-metadata";
  if (
    !SYSTEMD_ACTIVE_STATES.has(properties.ActiveState) ||
    !SYSTEMD_UNIT_FILE_STATES.has(properties.UnitFileState)
  ) {
    return "block-malformed-metadata";
  }

  const active = ["active", "activating", "reloading", "deactivating"].includes(
    properties.ActiveState,
  );
  const enabled =
    enabledByActivationPath ||
    properties.UnitFileState === "enabled" ||
    properties.UnitFileState === "enabled-runtime";
  if (!active && !enabled) return "unrelated";
  if (
    enabledByActivationPath &&
    (properties.ExecStart === "" || properties.UnitFileState === "not-found")
  ) {
    return "block-ambiguous-executable";
  }

  const executablePaths = extractExecStartPaths(properties.ExecStart);
  if (executablePaths.length === 0) {
    return properties.ExecStart === "" ? "unrelated" : "block-ambiguous-executable";
  }
  const gatewayPaths = executablePaths.filter(
    (candidate) => path.basename(candidate) === "openshell-gateway",
  );
  if (gatewayPaths.length === 0) {
    return properties.ExecStart.includes("openshell-gateway")
      ? "block-ambiguous-executable"
      : "unrelated";
  }
  if (
    executablePaths.length !== 1 ||
    gatewayPaths.length !== 1 ||
    !path.isAbsolute(gatewayPaths[0])
  ) {
    return "block-ambiguous-executable";
  }

  const executablePath = path.normalize(gatewayPaths[0]);
  const trustedPaths = new Set(
    trustedExecutablePaths.filter(path.isAbsolute).map((candidate) => path.normalize(candidate)),
  );
  if (!trustedPaths.has(executablePath)) return "block-untrusted-executable";

  const port = parseExecStartPort(properties.ExecStart);
  if (port === null) return "block-ambiguous-port";
  return port === gatewayPort ? "block-selected-port" : "different-port";
}
