// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

type OpenShellPins = Readonly<{
  maxVersion: string;
  minVersion: string;
}>;

type OpenClawPins = Readonly<{
  npmIntegrity: string;
  tarball: string;
  version: string;
}>;

type HermesPins = Readonly<{
  expectedVersion: string;
}>;

type DependencyPins = Readonly<{
  hermes: HermesPins;
  openclaw: OpenClawPins;
  openshell: OpenShellPins;
}>;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OPENCLAW_VERSION_ARG_SUFFIX_RE = /[.-]/g;
const NUMERIC_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const OPENSHELL_RELEASE_MANIFESTS = [
  "openshell-checksums-sha256.txt",
  "openshell-gateway-checksums-sha256.txt",
  "openshell-sandbox-checksums-sha256.txt",
] as const;
const EXACT_MAIN_PROOF = {
  manifestName: "openshell-child-visible-credentials.bb72d0123c.json",
  sourceSha: "bb72d0123c748ed7e209880f7bab593e10aae221",
  version: "0.0.82-dev.11+gbb72d012",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(rootDir: string, relativePath: string, failures: string[]): string {
  try {
    return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
  } catch (error) {
    failures.push(`${relativePath}: failed to read (${(error as Error).message})`);
    return "";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSingle(source: string, pattern: RegExp, label: string, failures: string[]): string {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    failures.push(`${label}: expected exactly one match`);
    return "";
  }
  return matches[0][1];
}

function extractArg(source: string, argName: string, label: string, failures: string[]): string {
  return extractSingle(
    source,
    new RegExp(`^ARG\\s+${escapeRegExp(argName)}=([^\\s]+)\\s*$`, "gm"),
    label,
    failures,
  );
}

function parseMapping(
  source: string,
  label: string,
  format: "JSON" | "YAML",
  failures: string[],
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = format === "JSON" ? JSON.parse(source) : parseYaml(source);
  } catch (error) {
    failures.push(`${label}: failed to parse ${format} (${(error as Error).message})`);
    return null;
  }
  if (!isRecord(parsed)) {
    failures.push(`${label}: ${format} document must be a mapping`);
    return null;
  }
  return parsed;
}

function extractMappingString(
  document: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  failures: string[],
): string {
  let value: unknown = document;
  for (const key of keys) {
    if (!isRecord(value)) {
      failures.push(`${label}: expected scalar value at ${keys.join(".")}`);
      return "";
    }
    value = value[key];
  }
  if (typeof value !== "string") {
    failures.push(`${label}: expected scalar value at ${keys.join(".")}`);
    return "";
  }
  if (!value) failures.push(`${label}: expected non-empty value at ${keys.join(".")}`);
  return value;
}

function openclawArgSuffix(version: string): string {
  return version.replace(OPENCLAW_VERSION_ARG_SUFFIX_RE, "_");
}

function verifyOpenClawSelector(
  source: string,
  label: string,
  pins: OpenClawPins,
  failures: string[],
): void {
  const openclawArg = `OPENCLAW_${openclawArgSuffix(pins.version)}`;
  const expected =
    `if [ "$OPENCLAW_VERSION" = "${pins.version}" ]; then ` +
    `EXPECTED_INTEGRITY="$${openclawArg}_INTEGRITY"; ` +
    `EXPECTED_TARBALL="$${openclawArg}_TARBALL"; fi;`;
  if (!source.includes(expected)) {
    failures.push(
      `${label} reviewed OpenClaw selector must bind ${pins.version} to ` +
        `${openclawArg}_INTEGRITY and ${openclawArg}_TARBALL`,
    );
  }
}

/**
 * Read the current dependency inventory from the files that installers and
 * image builds actually consume.
 */
function deriveDependencyPins(rootDir: string = REPO_ROOT): {
  failures: string[];
  pins: DependencyPins | null;
} {
  const failures: string[] = [];
  const blueprintSource = readText(rootDir, "nemoclaw-blueprint/blueprint.yaml", failures);
  const dockerfileBase = readText(rootDir, "Dockerfile.base", failures);
  const hermesDockerfileBase = readText(rootDir, "agents/hermes/Dockerfile.base", failures);
  if (failures.length > 0) return { failures, pins: null };

  const blueprint = parseMapping(
    blueprintSource,
    "nemoclaw-blueprint/blueprint.yaml",
    "YAML",
    failures,
  );
  if (!blueprint) return { failures, pins: null };

  const openclawVersion = extractArg(
    dockerfileBase,
    "OPENCLAW_VERSION",
    "Dockerfile.base OPENCLAW_VERSION",
    failures,
  );
  const openclawArg = `OPENCLAW_${openclawArgSuffix(openclawVersion)}`;
  const openclawNpmIntegrity = NUMERIC_VERSION_RE.test(openclawVersion)
    ? extractArg(
        dockerfileBase,
        `${openclawArg}_INTEGRITY`,
        `Dockerfile.base ${openclawArg}_INTEGRITY`,
        failures,
      )
    : "";
  const openclawTarball = NUMERIC_VERSION_RE.test(openclawVersion)
    ? extractArg(
        dockerfileBase,
        `${openclawArg}_TARBALL`,
        `Dockerfile.base ${openclawArg}_TARBALL`,
        failures,
      )
    : "";

  const pins: DependencyPins = {
    openshell: {
      minVersion: extractMappingString(
        blueprint,
        ["min_openshell_version"],
        "nemoclaw-blueprint/blueprint.yaml min_openshell_version",
        failures,
      ),
      maxVersion: extractMappingString(
        blueprint,
        ["max_openshell_version"],
        "nemoclaw-blueprint/blueprint.yaml max_openshell_version",
        failures,
      ),
    },
    openclaw: {
      version: openclawVersion,
      npmIntegrity: openclawNpmIntegrity,
      tarball: openclawTarball,
    },
    hermes: {
      expectedVersion: extractArg(
        hermesDockerfileBase,
        "HERMES_SEMVER",
        "agents/hermes/Dockerfile.base HERMES_SEMVER",
        failures,
      ),
    },
  };

  if (pins.openshell.maxVersion && !NUMERIC_VERSION_RE.test(pins.openshell.maxVersion)) {
    failures.push("nemoclaw-blueprint/blueprint.yaml max_openshell_version must match X.Y.Z");
  }
  if (pins.openclaw.version && !NUMERIC_VERSION_RE.test(pins.openclaw.version)) {
    failures.push("Dockerfile.base OPENCLAW_VERSION must match X.Y.Z");
  }
  if (NUMERIC_VERSION_RE.test(pins.openclaw.version)) {
    verifyOpenClawSelector(dockerfileBase, "Dockerfile.base", pins.openclaw, failures);
  }
  return { failures, pins: failures.length === 0 ? pins : null };
}

function compare(actual: string, expected: string, label: string, failures: string[]): void {
  if (actual && expected && actual !== expected) {
    failures.push(`${label}: expected ${expected}, found ${actual}`);
  }
}

function compareCredentialBoundaryManifestReferences(
  source: string,
  label: string,
  expectedVersion: string,
  failures: string[],
): void {
  const versions = new Set(
    [...source.matchAll(/openshell-child-visible-credentials\.v([0-9]+\.[0-9]+\.[0-9]+)\.json/g)]
      .map((match) => match[1])
      .filter((version): version is string => version !== undefined),
  );
  if (versions.size === 0) {
    failures.push(`${label} credential-boundary manifest version: expected at least one match`);
    return;
  }
  for (const version of [...versions].sort()) {
    compare(version, expectedVersion, `${label} credential-boundary manifest version`, failures);
  }
}

function requireVersionReference(
  source: string,
  pattern: RegExp,
  expectedVersion: string,
  label: string,
  failures: string[],
): void {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const versions = [...source.matchAll(new RegExp(pattern.source, flags))]
    .map((match) => match[1])
    .filter((version): version is string => version !== undefined);
  if (!versions.includes(expectedVersion)) {
    failures.push(`${label}: expected a reference to ${expectedVersion}`);
  }
}

function requireOpenShellReleaseManifestAllowlist(
  source: string,
  expectedVersion: string,
  failures: string[],
): void {
  const entries = [
    ...source.matchAll(/^\s*"([0-9]+\.[0-9]+\.[0-9]+)\|([^|"\s]+)\|([a-f0-9]{64})"\s*$/gm),
  ]
    .filter((match) => match[1] === expectedVersion)
    .map((match) => match[2])
    .filter((manifest): manifest is string => manifest !== undefined);
  const complete =
    entries.length === OPENSHELL_RELEASE_MANIFESTS.length &&
    OPENSHELL_RELEASE_MANIFESTS.every(
      (manifest) => entries.filter((entry) => entry === manifest).length === 1,
    );
  if (!complete) {
    failures.push(
      `OpenShell release-manifest allowlist: expected one complete entry for ${expectedVersion}`,
    );
  }
}

function verifyOpenShellPins(
  pins: OpenShellPins,
  sources: {
    brevLaunchable: string;
    credentialBoundary: Record<string, unknown>;
    e2eWorkflow: Record<string, unknown>;
    hermesDockerfile: string;
    hermesMcpConfigTransaction: string;
    installer: string;
    installerHashCheck: string;
    mcpBridgeValidation: string;
    openshellFeatureGate: string;
    openshellInstall: string;
    openshellVersion: string;
    supervisorManifestDigests: string;
    updateHermesAgent: string;
  },
  exactMainProof: boolean,
  failures: string[],
): void {
  for (const [argName, expectedVersion] of [
    ["MIN_VERSION", pins.minVersion],
    ["MAX_VERSION", pins.maxVersion],
  ] as const) {
    compare(
      extractSingle(
        sources.installer,
        new RegExp(`^${argName}="([^"]+)"\\s*$`, "gm"),
        `OpenShell installer ${argName}`,
        failures,
      ),
      expectedVersion,
      `OpenShell installer ${argName}`,
      failures,
    );
  }
  compare(
    extractSingle(
      sources.installer,
      /^PIN_VERSION="([^"]+)"\s*$/gm,
      "OpenShell installer PIN_VERSION",
      failures,
    ),
    "$MAX_VERSION",
    "OpenShell installer PIN_VERSION",
    failures,
  );
  requireOpenShellReleaseManifestAllowlist(sources.installerHashCheck, pins.maxVersion, failures);
  compare(
    extractSingle(
      sources.openshellVersion,
      /^export const SUPPORTED_OPENSHELL_FALLBACK_VERSION = "([^"]+)";\s*$/gm,
      "OpenShell supported fallback version",
      failures,
    ),
    pins.maxVersion,
    "OpenShell supported fallback version",
    failures,
  );
  compare(
    extractSingle(
      sources.openshellInstall,
      /getBlueprintMinOpenshellVersion\(\) \?\? "([0-9]+\.[0-9]+\.[0-9]+)"/,
      "OpenShell minimum fallback version",
      failures,
    ),
    pins.minVersion,
    "OpenShell minimum fallback version",
    failures,
  );
  requireVersionReference(
    sources.supervisorManifestDigests,
    /^\s*"([0-9]+\.[0-9]+\.[0-9]+)":\s*"sha256:[0-9a-f]{64}",?\s*$/gm,
    pins.maxVersion,
    "OpenShell supervisor manifest digest map",
    failures,
  );
  requireVersionReference(
    sources.openshellFeatureGate,
    /^\s*\["[0-9a-f]{64}",\s*"([0-9]+\.[0-9]+\.[0-9]+)"\],?\s*$/gm,
    pins.maxVersion,
    "OpenShell sandbox build version map",
    failures,
  );
  compare(
    extractSingle(
      sources.brevLaunchable,
      /^\s*stable \| auto\) OPENSHELL_VERSION="v([^"]+)" ;;\s*$/gm,
      "Brev launchable stable OpenShell default",
      failures,
    ),
    pins.maxVersion,
    "Brev launchable stable OpenShell default",
    failures,
  );
  compare(
    extractMappingString(
      sources.e2eWorkflow,
      ["jobs", "openshell-gateway-auth-contract", "env", "NEMOCLAW_OPENSHELL_PIN_VERSION"],
      ".github/workflows/e2e.yaml gateway auth OpenShell version",
      failures,
    ),
    pins.maxVersion,
    ".github/workflows/e2e.yaml gateway auth OpenShell version",
    failures,
  );
  if (exactMainProof) {
    compare(
      extractMappingString(
        sources.credentialBoundary,
        ["openshellVersion"],
        "OpenShell exact-main credential-boundary manifest version",
        failures,
      ),
      EXACT_MAIN_PROOF.version,
      "OpenShell exact-main credential-boundary manifest version",
      failures,
    );
    compare(
      extractMappingString(
        sources.credentialBoundary,
        ["openshellCommit"],
        "OpenShell exact-main credential-boundary manifest commit",
        failures,
      ),
      EXACT_MAIN_PROOF.sourceSha,
      "OpenShell exact-main credential-boundary manifest commit",
      failures,
    );
    for (const [source, label] of [
      [sources.mcpBridgeValidation, "OpenShell credential-boundary import"],
      [sources.hermesDockerfile, "Hermes Dockerfile credential-boundary manifest"],
      [sources.hermesMcpConfigTransaction, "Hermes MCP transaction credential-boundary manifest"],
    ] as const) {
      if (!source.includes(EXACT_MAIN_PROOF.manifestName)) {
        failures.push(`${label}: expected a reference to ${EXACT_MAIN_PROOF.manifestName}`);
      }
    }
    compare(
      extractSingle(
        sources.hermesMcpConfigTransaction,
        /manifest\.get\("openshellVersion"\)\s*!=\s*"([^"]+)"/,
        "Hermes MCP transaction expected exact-main OpenShell version",
        failures,
      ),
      EXACT_MAIN_PROOF.version,
      "Hermes MCP transaction expected exact-main OpenShell version",
      failures,
    );
  } else {
    compare(
      extractMappingString(
        sources.credentialBoundary,
        ["openshellVersion"],
        "OpenShell credential-boundary manifest version",
        failures,
      ),
      pins.maxVersion,
      "OpenShell credential-boundary manifest version",
      failures,
    );
    compare(
      extractSingle(
        sources.mcpBridgeValidation,
        /openshell-child-visible-credentials\.v([0-9]+\.[0-9]+\.[0-9]+)\.json/,
        "OpenShell credential-boundary import",
        failures,
      ),
      pins.maxVersion,
      "OpenShell credential-boundary import",
      failures,
    );
    compareCredentialBoundaryManifestReferences(
      sources.hermesDockerfile,
      "Hermes Dockerfile",
      pins.maxVersion,
      failures,
    );
    compareCredentialBoundaryManifestReferences(
      sources.hermesMcpConfigTransaction,
      "Hermes MCP transaction",
      pins.maxVersion,
      failures,
    );
    compare(
      extractSingle(
        sources.hermesMcpConfigTransaction,
        /manifest\.get\("openshellVersion"\)\s*!=\s*"([0-9]+\.[0-9]+\.[0-9]+)"/,
        "Hermes MCP transaction expected OpenShell version",
        failures,
      ),
      pins.maxVersion,
      "Hermes MCP transaction expected OpenShell version",
      failures,
    );
  }
  compareCredentialBoundaryManifestReferences(
    sources.updateHermesAgent,
    "Hermes update script",
    pins.maxVersion,
    failures,
  );
}

function verifyOpenClawPins(
  pins: OpenClawPins,
  sources: {
    dockerfile: string;
    manifest: Record<string, unknown>;
    packageJson: Record<string, unknown>;
  },
  failures: string[],
): void {
  const openclawArg = `OPENCLAW_${openclawArgSuffix(pins.version)}`;
  verifyOpenClawSelector(sources.dockerfile, "Dockerfile", pins, failures);
  compare(
    extractArg(sources.dockerfile, "OPENCLAW_VERSION", "Dockerfile OPENCLAW_VERSION", failures),
    pins.version,
    "Dockerfile OPENCLAW_VERSION",
    failures,
  );
  compare(
    extractArg(
      sources.dockerfile,
      `${openclawArg}_INTEGRITY`,
      `Dockerfile ${openclawArg}_INTEGRITY`,
      failures,
    ),
    pins.npmIntegrity,
    `Dockerfile ${openclawArg}_INTEGRITY`,
    failures,
  );
  compare(
    extractArg(
      sources.dockerfile,
      `${openclawArg}_TARBALL`,
      `Dockerfile ${openclawArg}_TARBALL`,
      failures,
    ),
    pins.tarball,
    `Dockerfile ${openclawArg}_TARBALL`,
    failures,
  );
  compare(
    extractMappingString(
      sources.manifest,
      ["expected_version"],
      "OpenClaw manifest expected_version",
      failures,
    ),
    pins.version,
    "OpenClaw manifest expected_version",
    failures,
  );
  compare(
    extractMappingString(
      sources.packageJson,
      ["openclaw", "build", "openclawVersion"],
      "nemoclaw package OpenClaw build version",
      failures,
    ),
    pins.version,
    "nemoclaw package OpenClaw build version",
    failures,
  );
}

function verifyHermesPins(
  pins: HermesPins,
  manifest: Record<string, unknown>,
  failures: string[],
): void {
  compare(
    extractMappingString(
      manifest,
      ["expected_version"],
      "Hermes manifest expected_version",
      failures,
    ),
    pins.expectedVersion,
    "Hermes manifest expected_version",
    failures,
  );
}

export function verifyDependencyPins(rootDir: string = REPO_ROOT): string[] {
  const { failures, pins } = deriveDependencyPins(rootDir);
  if (!pins) return failures;

  const brevLaunchable = readText(rootDir, "scripts/brev-launchable-ci-cpu.sh", failures);
  const installer = readText(rootDir, "scripts/install-openshell.sh", failures);
  const installerHashCheck = readText(rootDir, "scripts/check-installer-hash.sh", failures);
  const e2eWorkflowSource = readText(rootDir, ".github/workflows/e2e.yaml", failures);
  const openclawManifestSource = readText(rootDir, "agents/openclaw/manifest.yaml", failures);
  const hermesManifestSource = readText(rootDir, "agents/hermes/manifest.yaml", failures);
  const dockerfile = readText(rootDir, "Dockerfile", failures);
  const hermesDockerfile = readText(rootDir, "agents/hermes/Dockerfile", failures);
  const hermesMcpConfigTransaction = readText(
    rootDir,
    "agents/hermes/mcp-config-transaction.py",
    failures,
  );
  const updateHermesAgent = readText(rootDir, "scripts/update-hermes-agent.sh", failures);
  const exactMainProof = /NEMOCLAW_OPENSHELL_EXACT_MAIN_PROOF:\s*["']?1["']?/.test(
    e2eWorkflowSource,
  );
  if (exactMainProof && !e2eWorkflowSource.includes(EXACT_MAIN_PROOF.sourceSha)) {
    failures.push(
      `OpenShell exact-main workflow: expected a reference to ${EXACT_MAIN_PROOF.sourceSha}`,
    );
  }
  const credentialBoundarySource = readText(
    rootDir,
    exactMainProof
      ? `src/lib/actions/sandbox/${EXACT_MAIN_PROOF.manifestName}`
      : `src/lib/actions/sandbox/openshell-child-visible-credentials.v${pins.openshell.maxVersion}.json`,
    failures,
  );
  const mcpBridgeValidation = readText(
    rootDir,
    "src/lib/actions/sandbox/mcp-bridge-validation.ts",
    failures,
  );
  const packageJsonSource = readText(rootDir, "nemoclaw/package.json", failures);
  const openshellVersion = readText(rootDir, "src/lib/onboard/openshell-version.ts", failures);
  const openshellInstall = readText(rootDir, "src/lib/onboard/openshell-install.ts", failures);
  const supervisorManifestDigests = readText(
    rootDir,
    "src/lib/onboard/docker-driver-gateway-runtime.ts",
    failures,
  );
  const openshellFeatureGate = readText(
    rootDir,
    "src/lib/onboard/openshell-feature-gate.ts",
    failures,
  );
  if (failures.length > 0) return failures;

  const openclawManifest = parseMapping(
    openclawManifestSource,
    "agents/openclaw/manifest.yaml",
    "YAML",
    failures,
  );
  const hermesManifest = parseMapping(
    hermesManifestSource,
    "agents/hermes/manifest.yaml",
    "YAML",
    failures,
  );
  const credentialBoundary = parseMapping(
    credentialBoundarySource,
    "OpenShell credential-boundary manifest",
    "JSON",
    failures,
  );
  const e2eWorkflow = parseMapping(
    e2eWorkflowSource,
    ".github/workflows/e2e.yaml",
    "YAML",
    failures,
  );
  const packageJson = parseMapping(packageJsonSource, "nemoclaw/package.json", "JSON", failures);
  if (!openclawManifest || !hermesManifest || !credentialBoundary || !e2eWorkflow || !packageJson)
    return failures;

  verifyOpenShellPins(
    pins.openshell,
    {
      brevLaunchable,
      credentialBoundary,
      e2eWorkflow,
      hermesDockerfile,
      hermesMcpConfigTransaction,
      installer,
      installerHashCheck,
      mcpBridgeValidation,
      openshellFeatureGate,
      openshellInstall,
      openshellVersion,
      supervisorManifestDigests,
      updateHermesAgent,
    },
    exactMainProof,
    failures,
  );
  verifyOpenClawPins(
    pins.openclaw,
    { dockerfile, manifest: openclawManifest, packageJson },
    failures,
  );
  verifyHermesPins(pins.hermes, hermesManifest, failures);

  return failures;
}

function main(): void {
  const failures = verifyDependencyPins();
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("Dependency pins match their consumers.");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) main();
