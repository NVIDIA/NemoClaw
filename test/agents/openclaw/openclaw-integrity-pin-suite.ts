// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAuditExceptionRegistry } from "../../../scripts/lib/reviewed-npm-audit.mts";
import { createBuiltInChannelManifestRegistry } from "../../../src/lib/messaging";
import { reviewedOpenClawPluginIntegrityByPackageSpec } from "../../../src/lib/messaging/applier/build/messaging-build-applier.mts";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const DOCKERFILE = path.join(REPO_ROOT, "Dockerfile");
const DOCKERFILE_BASE = path.join(REPO_ROOT, "Dockerfile.base");
const PRODUCTION_DOCKERFILES = [
  DOCKERFILE,
  DOCKERFILE_BASE,
  path.join(REPO_ROOT, "agents", "hermes", "Dockerfile"),
  path.join(REPO_ROOT, "agents", "hermes", "Dockerfile.base"),
  path.join(REPO_ROOT, "agents", "langchain-deepagents-code", "Dockerfile"),
  path.join(REPO_ROOT, "agents", "langchain-deepagents-code", "Dockerfile.base"),
];
const BLUEPRINT = path.join(REPO_ROOT, "nemoclaw-blueprint", "blueprint.yaml");
const DEPENDENCY_REVIEW_NOTE = path.join(
  REPO_ROOT,
  "internal",
  "security-reviews",
  "openclaw-2026.7.1-dependency-review.md",
);
const PRODUCTION_BUILD_ARG_GUARD = path.join(
  REPO_ROOT,
  "scripts",
  "check-production-build-args.sh",
);
const REVIEWED_NPM_ARCHIVE_HELPER = path.join(
  REPO_ROOT,
  "scripts",
  "lib",
  "reviewed-npm-archive.mts",
);
const OPENCLAW_VERSION_EXTRACTOR = path.join(REPO_ROOT, "scripts", "extract-semver.sh");
const REVIEWED_NPM_AUDIT_HELPER = path.join(REPO_ROOT, "scripts", "lib", "reviewed-npm-audit.mts");
const UNPINNED_OPENCLAW_VERSION = "2026.7.2";
const PINNED_OPENCLAW_VERSION = "2026.7.1";
const PINNED_OPENCLAW_INTEGRITY =
  "sha512-ge/Xss99CHAjPL/ikmH/UFoiOrjcxDB4sW3y9mhyCD+dYW3wzV7TKbAVdkrXFgAG2d2BjpJofP97zUZ+umxo8g==";
const PINNED_OPENCLAW_TARBALL = "https://registry.npmjs.org/openclaw/-/openclaw-2026.7.1.tgz";
const OPENCLAW_RUNTIME_LOCKFILE = path.join(
  REPO_ROOT,
  "agents",
  "openclaw",
  "openclaw-runtime",
  "package-lock.json",
);
const NEMOCLAW_PLUGIN_LOCKFILE = path.join(REPO_ROOT, "nemoclaw", "package-lock.json");
const NEMOCLAW_NPM_CACHE_SEED_MANIFEST = path.join(
  REPO_ROOT,
  "tools",
  "mcp-tool-discovery-runtime",
  "npm-cache-seed",
  "manifest.json",
);
const PINNED_OPENCLAW_LOCK_SHA256 = createHash("sha256")
  .update(fs.readFileSync(OPENCLAW_RUNTIME_LOCKFILE))
  .digest("hex");
const PINNED_NEMOCLAW_TAR_VERSION = "7.5.21";
const PINNED_NEMOCLAW_TAR_INTEGRITY =
  "sha512-XdhtCvlMywwxpCW8YEq3lOXBJpUPTR2OHHcwLPO3HwsJqOHa2Ok/oJ7ruGzp+JrKoRPVCzJwAdEjqLW/vNRPHA==";
const PINNED_NEMOCLAW_TAR_TARBALL = "https://registry.npmjs.org/tar/-/tar-7.5.21.tgz";
const PINNED_NEMOCLAW_TAR_COMMIT = "0cd9cc3c5814446d3c0cbea6a31d6c00c2c8a9d9";
const PINNED_CODEX_ACP_VERSION = "0.11.1";
const PINNED_CODEX_ACP_TARBALL =
  "https://registry.npmjs.org/@zed-industries/codex-acp/-/codex-acp-0.11.1.tgz";
const PINNED_CODEX_ACP_INTEGRITY =
  "sha512-My2VSlBtvJipJhImHjFDej2ut/p00QqOISRnZgLgLrSIzjgvdcQvAhaZviWj7XPhk4UIdIb0OoA+Lrls824uiQ==";
const PINNED_MCPORTER_VERSION = "0.7.3";
const PINNED_MCPORTER_INTEGRITY =
  "sha512-egoPVYqTnWb3NjRIxo+xc8OrAI0dlPrJm9pAiZx0pImuNIV5rKhGtTnIfH/Y1ldGPVu74ibj3KR5c9U/QSdQFA==";
const PINNED_MCPORTER_TARBALL = "https://registry.npmjs.org/mcporter/-/mcporter-0.7.3.tgz";
const MCPORTER_LOCKFILE = path.join(
  REPO_ROOT,
  "agents",
  "openclaw",
  "mcporter-runtime",
  "package-lock.json",
);
const NPM_AUDIT_EXCEPTION_FILE = path.join(REPO_ROOT, "ci", "npm-audit-exceptions.json");
const NPM_AUDIT_EXCEPTION_POLICY = fs.readFileSync(NPM_AUDIT_EXCEPTION_FILE, "utf-8");
const PINNED_MCPORTER_LOCK_SHA256 = createHash("sha256")
  .update(fs.readFileSync(MCPORTER_LOCKFILE))
  .digest("hex");
const NPM_AUDIT_EXCEPTION_POLICY_SHA256 = createHash("sha256")
  .update(NPM_AUDIT_EXCEPTION_POLICY)
  .digest("hex");
const MCPORTER_AUDIT_EXCEPTIONS = parseAuditExceptionRegistry(NPM_AUDIT_EXCEPTION_POLICY)
  .exceptions.filter((entry) => entry.graph === "mcporter-runtime")
  .map((entry) => entry.advisory)
  .sort();
const MCPORTER_AUDIT_EXCEPTION_LIST = MCPORTER_AUDIT_EXCEPTIONS.join(",") || "none";
const MCPORTER_AUDIT_STATUS =
  MCPORTER_AUDIT_EXCEPTIONS.length > 0 ? "accepted-exceptions" : "clean";
const PINNED_OPENCLAW_DIAGNOSTICS_OTEL_INTEGRITY =
  "sha512-XXhMifYWTgoR6yFN4T3JkHxdPvQCe8k1cNZjVIgXNmk1svCdBWuALfQQicmpemlmWwauIQuHYgBURY6k63e+rw==";
const PINNED_OPENCLAW_DIAGNOSTICS_OTEL_TARBALL =
  "https://registry.npmjs.org/@openclaw/diagnostics-otel/-/diagnostics-otel-2026.7.1.tgz";
const PINNED_OPENCLAW_BRAVE_PLUGIN_INTEGRITY =
  "sha512-7Z+GZ/6K6a8LlkTsWVnAZ1hv8EarORzHQvFHD7ekcg033FGJOXYPEZSbvvE3qR9vM+vnoZplNjMZ7vFMRcvQgw==";
const PINNED_OPENCLAW_BRAVE_PLUGIN_TARBALL =
  "https://registry.npmjs.org/@openclaw/brave-plugin/-/brave-plugin-2026.7.1.tgz";
const PINNED_OPENCLAW_DISCORD_INTEGRITY =
  "sha512-tZfdC1YA8oVLvc2BK1w0F6rUljS5ugCOp2uWe0vPsbG1fbzVVIO4V32RoqZznGHe5u2R9u4n1aV5Z/qa1m2oFg==";
const PINNED_OPENCLAW_SLACK_INTEGRITY =
  "sha512-dwVGEVCmoTQrOIeZaSCIOPg8pT7hB883QQEXdp9EZUDzTGuvSc+KxH2iERSOV/59hROQctYdcobGn/vdB1H4XA==";
const PINNED_OPENCLAW_WHATSAPP_INTEGRITY =
  "sha512-wLY/Omc5fleRpl2lKGN8sxt/8hYfHGwLRezmWsk8oCbea5pRKUPE6ZX+wJO1O52NOJkAGCuiXvS7x0qIeKxXbQ==";
const PINNED_OPENCLAW_MSTEAMS_INTEGRITY =
  "sha512-gG/Yk6HZAguHwrmKjsqdONbFz5WNy126PEAXQWNW/TulO1kIifQ6tktM16BQPNLnkmWqLbj+TrrO55Cjas1aFg==";
const PINNED_WECHAT_PLUGIN_INTEGRITY =
  "sha512-dPQbidUNWigC6V10vGW4i+GLH09x+6zUhafZRjuxkJ9GDu8o62WBsnUTojp4KqUH756hz+t2v9khiCRSi0dBDw==";
const LEGACY_REBUILD_OPENCLAW_VERSION = "2026.3.11";
const LEGACY_REBUILD_OPENCLAW_INTEGRITY =
  "sha512-bxwiBmHPakwfpY5tqC9lrV5TCu5PKf0c1bHNc3nhrb+pqKcPEWV4zOjDVFLQUHr98ihgWA+3pacy4b3LQ8wduQ==";
const LEGACY_REBUILD_OPENCLAW_TARBALL =
  "https://registry.npmjs.org/openclaw/-/openclaw-2026.3.11.tgz";
const LEGACY_GATEWAY_UPGRADE_OPENCLAW_VERSION = "2026.4.24";
const LEGACY_GATEWAY_UPGRADE_OPENCLAW_INTEGRITY =
  "sha512-W6u4XeIIP4+uG4DYV9G3JeS6QNuKwfhQIej1GIoL4BdcnUFgrnB8kHYNXL3MxiHRKuhZB9OYwUMGs8jKFZR/Vg==";
const LEGACY_GATEWAY_UPGRADE_OPENCLAW_TARBALL =
  "https://registry.npmjs.org/openclaw/-/openclaw-2026.4.24.tgz";
const OPENCLAW_BASE_PROVENANCE_PATH = "/usr/local/share/nemoclaw/openclaw-base-provenance-v1";

function openClawBaseProvenance(
  version = PINNED_OPENCLAW_VERSION,
  integrity = PINNED_OPENCLAW_INTEGRITY,
  tarball = PINNED_OPENCLAW_TARBALL,
  auditPolicy: Readonly<{
    exceptions: string;
    sha256: string;
    status: "accepted-exceptions" | "clean";
  }> = {
    exceptions: MCPORTER_AUDIT_EXCEPTION_LIST,
    sha256: NPM_AUDIT_EXCEPTION_POLICY_SHA256,
    status: MCPORTER_AUDIT_STATUS,
  },
): string {
  const lockSha256 =
    version === PINNED_OPENCLAW_VERSION ? PINNED_OPENCLAW_LOCK_SHA256 : "none-legacy-fixture";
  const recipe =
    version === PINNED_OPENCLAW_VERSION
      ? "locked-ci+reviewed-lifecycle-v2"
      : version === LEGACY_REBUILD_OPENCLAW_VERSION
        ? "ignore-scripts+reviewed-lifecycle+transitive-remediation-v1"
        : "ignore-scripts+reviewed-lifecycle-v1";
  return [
    "schema=4",
    `package=openclaw@${version}`,
    `integrity=${integrity}`,
    `tarball=${tarball}`,
    `lock-sha256=${lockSha256}`,
    `recipe=${recipe}`,
    `mcporter-package=mcporter@${PINNED_MCPORTER_VERSION}`,
    `mcporter-integrity=${PINNED_MCPORTER_INTEGRITY}`,
    `mcporter-tarball=${PINNED_MCPORTER_TARBALL}`,
    `mcporter-lock-sha256=${PINNED_MCPORTER_LOCK_SHA256}`,
    `mcporter-audit-policy-sha256=${auditPolicy.sha256}`,
    `mcporter-audit-status=${auditPolicy.status}`,
    `mcporter-audit-exceptions=${auditPolicy.exceptions}`,
    "mcporter-recipe=locked-ci+reviewed-audit-v3",
    "",
  ].join("\n");
}

function extractRunBlock(file: string, startMarker: string, endMarker: string): string {
  const source = fs.readFileSync(file, "utf-8");
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `Expected start marker in ${file}: ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(end, `Expected end marker in ${file}: ${endMarker}`).toBeGreaterThan(start);
  const runIndex = source.indexOf("RUN ", start);
  expect(runIndex, `Expected RUN instruction after ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(runIndex, `Expected RUN instruction before ${endMarker}`).toBeLessThanOrEqual(end);
  return source
    .slice(runIndex, end)
    .trim()
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n\s*/g, " ")
    .replace(/^RUN\s+/, "")
    .replace(/^(?:--[a-z-]+=[^\s]+\s+)+/u, "")
    .replace(/\\\s*$/, "");
}

function runInstallBlock(
  command: string,
  options: {
    openclawVersion?: string;
    committedIntegrity?: string;
    registryIntegrity?: string;
    registryTarball?: string;
    packIntegrity?: string;
    codexAcpCommittedIntegrity?: string;
    codexAcpRegistryIntegrity?: string;
    codexAcpRegistryTarball?: string;
    codexAcpPackIntegrity?: string;
    packFilename?: string | null;
    allowLegacyFixture?: boolean;
    installedOpenClawVersion?: string;
    installedOpenClawVersionPrefix?: string;
    installedOpenClawVersionSuffix?: string;
    includeInstalledOpenClawVersion?: boolean;
    openclawVersionCommandStatus?: number;
    installedMcporterVersion?: string;
    baseImage?: string;
    baseProvenance?: string | null;
    baseProvenanceMetadata?: string;
    baseProvenanceSymlink?: boolean;
    auditExceptionPolicy?: string;
    failOpenClawNpmCi?: boolean;
    failOpenClawVerifyInstalledLock?: boolean;
  } = {},
) {
  const {
    openclawVersion = UNPINNED_OPENCLAW_VERSION,
    committedIntegrity = "sha512-reviewed-pin",
    registryIntegrity = committedIntegrity,
    registryTarball = PINNED_OPENCLAW_TARBALL,
    packIntegrity = committedIntegrity,
    codexAcpCommittedIntegrity = PINNED_CODEX_ACP_INTEGRITY,
    codexAcpRegistryIntegrity = codexAcpCommittedIntegrity,
    codexAcpRegistryTarball = PINNED_CODEX_ACP_TARBALL,
    codexAcpPackIntegrity = codexAcpCommittedIntegrity,
    packFilename,
    allowLegacyFixture = false,
    installedOpenClawVersion = LEGACY_REBUILD_OPENCLAW_VERSION,
    installedOpenClawVersionPrefix = "openclaw ",
    installedOpenClawVersionSuffix = "",
    includeInstalledOpenClawVersion = true,
    openclawVersionCommandStatus = 0,
    installedMcporterVersion = PINNED_MCPORTER_VERSION,
    baseImage = "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    baseProvenance = null,
    baseProvenanceMetadata = "0:0:444",
    baseProvenanceSymlink = false,
    auditExceptionPolicy = fs.readFileSync(NPM_AUDIT_EXCEPTION_FILE, "utf-8"),
    failOpenClawNpmCi = false,
    failOpenClawVerifyInstalledLock = false,
  } = options;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-integrity-"));
  const blueprint = path.join(tmp, "blueprint.yaml");
  const log = path.join(tmp, "calls.log");
  const provenancePath = path.join(tmp, "openclaw-base-provenance-v1");
  const openclawRuntime = path.join(tmp, "openclaw-runtime");
  const openclawGlobal = path.join(tmp, "global", "openclaw");
  const openclawBin = path.join(tmp, "bin", "openclaw");
  const mcporterRuntime = path.join(tmp, "mcporter-runtime");
  const mcporterBin = path.join(tmp, "bin", "mcporter");
  const reviewedNpmExecutable = path.join(tmp, "bin", "reviewed-npm-fixture");
  const openclawVersionExtractor = path.join(tmp, "bin", "extract-semver");
  const remediationHelper = path.join(tmp, "openclaw-npm-remediation.cjs");
  const auditHelper = path.join(tmp, "reviewed-npm-audit.cjs");
  const auditExceptionFile = path.join(tmp, "npm-audit-exceptions.json");
  const auditExceptionPolicySha256 = createHash("sha256")
    .update(auditExceptionPolicy)
    .digest("hex");
  const auditExceptionsByGraph: Record<string, string[]> = {};
  for (const entry of (
    JSON.parse(auditExceptionPolicy) as {
      exceptions?: Array<{ advisory?: string; graph?: string }>;
    }
  ).exceptions ?? []) {
    if (!entry.advisory || !entry.graph) continue;
    (auditExceptionsByGraph[entry.graph] ??= []).push(entry.advisory);
  }
  for (const advisories of Object.values(auditExceptionsByGraph)) advisories.sort();
  fs.mkdirSync(path.dirname(mcporterBin), { recursive: true });
  fs.mkdirSync(openclawRuntime, { recursive: true });
  fs.mkdirSync(mcporterRuntime, { recursive: true });
  fs.copyFileSync(OPENCLAW_RUNTIME_LOCKFILE, path.join(openclawRuntime, "package-lock.json"));
  fs.copyFileSync(OPENCLAW_VERSION_EXTRACTOR, openclawVersionExtractor);
  fs.chmodSync(openclawVersionExtractor, 0o755);
  fs.copyFileSync(MCPORTER_LOCKFILE, path.join(mcporterRuntime, "package-lock.json"));
  fs.writeFileSync(blueprint, fs.readFileSync(BLUEPRINT, "utf-8"));
  fs.writeFileSync(auditExceptionFile, auditExceptionPolicy);
  fs.writeFileSync(
    reviewedNpmExecutable,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf 'npm %s\\n' "$*" >> ${JSON.stringify(log)}`,
      'if [ "${1:-}" = "view" ]; then',
      `  if [ "\${2:-}" = "@zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION}" ]; then`,
      `    if [ "\${3:-}" = "dist.integrity" ]; then printf '%s\\n' ${JSON.stringify(codexAcpRegistryIntegrity)}; else printf '%s\\n' ${JSON.stringify(codexAcpRegistryTarball)}; fi`,
      `  elif [ "\${2:-}" = "mcporter@${PINNED_MCPORTER_VERSION}" ]; then`,
      `    if [ "\${3:-}" = "dist.integrity" ]; then printf '%s\\n' ${JSON.stringify(PINNED_MCPORTER_INTEGRITY)}; else printf '%s\\n' ${JSON.stringify(PINNED_MCPORTER_TARBALL)}; fi`,
      "  else",
      `    if [ "\${3:-}" = "dist.integrity" ]; then printf '%s\\n' ${JSON.stringify(registryIntegrity)}; else printf '%s\\n' ${JSON.stringify(registryTarball)}; fi`,
      "  fi",
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "pack" ]; then',
      '  pack_spec="${2:-}"; pack_dir=""',
      '  while [ "$#" -gt 0 ]; do if [ "${1:-}" = "--pack-destination" ]; then pack_dir="${2:-}"; shift 2; continue; fi; shift; done',
      '  pack_file="$(basename "$pack_spec")"',
      `  reported_pack_file=${JSON.stringify(packFilename ?? "")}`,
      ...(packFilename === null
        ? []
        : ['  reported_pack_file="${reported_pack_file:-$pack_file}"']),
      '  printf "fake tarball" > "$pack_dir/$pack_file"',
      `  case "$pack_spec" in *"codex-acp"*) pack_integrity=${JSON.stringify(codexAcpPackIntegrity)} ;; *) pack_integrity=${JSON.stringify(packIntegrity)} ;; esac`,
      '  printf \'[{"filename":"%s","integrity":"%s"}]\\n\' "$reported_pack_file" "$pack_integrity"',
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    remediationHelper,
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const args = process.argv.slice(2);",
      "const value = (name) => args[args.indexOf(name) + 1];",
      'const output = path.join(value("--working-directory"), "openclaw-remediated.tgz");',
      'fs.copyFileSync(value("--archive"), output);',
      "console.log(JSON.stringify({ archivePath: output, remediated: true }));",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    auditHelper,
    [
      'const fs = require("node:fs");',
      `exports.parseAuditExceptionRegistry = require(${JSON.stringify(REVIEWED_NPM_AUDIT_HELPER)}).parseAuditExceptionRegistry;`,
      "if (require.main === module) {",
      "const args = process.argv.slice(2);",
      "const value = (name) => args[args.indexOf(name) + 1];",
      "const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };",
      "const report = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: counts } };",
      `const acceptedByGraph = ${JSON.stringify(auditExceptionsByGraph)};`,
      'const graph = value("--graph");',
      "const acceptedAdvisories = acceptedByGraph[graph] ?? [];",
      `const policy = { schemaVersion: 1, graph, blockingThreshold: value("--threshold"), exceptionPolicySha256: ${JSON.stringify(auditExceptionPolicySha256)}, reported: counts, status: acceptedAdvisories.length > 0 ? "accepted-exceptions" : "clean", acceptedAdvisories, unacceptedBlockingAdvisories: [] };`,
      'if (args.includes("--report")) fs.writeFileSync(value("--report"), `${JSON.stringify(report)}\\n`);',
      'if (args.includes("--result")) fs.writeFileSync(value("--result"), `${JSON.stringify(policy)}\\n`);',
      "console.log(`npm audit policy ${policy.graph}: clean`);",
      "}",
      "",
    ].join("\n"),
  );
  const writeProvenanceFile = () => {
    fs.writeFileSync(provenancePath, baseProvenance as string, { mode: 0o444 });
  };
  const writeProvenanceSymlink = () => {
    const target = path.join(tmp, "openclaw-base-provenance-target");
    fs.writeFileSync(target, baseProvenance as string);
    fs.symlinkSync(target, provenancePath);
  };
  const writePresentProvenance = baseProvenanceSymlink
    ? writeProvenanceSymlink
    : writeProvenanceFile;
  const setupProvenance = baseProvenance === null ? () => undefined : writePresentProvenance;
  setupProvenance();
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(log)}`,
    `real_node=${JSON.stringify(process.execPath)}`,
    `OPENCLAW_VERSION=${JSON.stringify(openclawVersion)}`,
    `BASE_IMAGE=${JSON.stringify(baseImage)}`,
    `openclaw_provenance_path=${JSON.stringify(provenancePath)}`,
    `openclaw_provenance_metadata=${JSON.stringify(baseProvenanceMetadata)}`,
    `OPENCLAW_2026_7_1_INTEGRITY=${JSON.stringify(committedIntegrity)}`,
    `OPENCLAW_2026_7_1_TARBALL=${JSON.stringify(PINNED_OPENCLAW_TARBALL)}`,
    `NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=${allowLegacyFixture ? "1" : "0"}`,
    `OPENCLAW_2026_3_11_INTEGRITY=${JSON.stringify(LEGACY_REBUILD_OPENCLAW_INTEGRITY)}`,
    `OPENCLAW_2026_3_11_TARBALL=${JSON.stringify(LEGACY_REBUILD_OPENCLAW_TARBALL)}`,
    `OPENCLAW_2026_4_24_INTEGRITY=${JSON.stringify(LEGACY_GATEWAY_UPGRADE_OPENCLAW_INTEGRITY)}`,
    `OPENCLAW_2026_4_24_TARBALL=${JSON.stringify(LEGACY_GATEWAY_UPGRADE_OPENCLAW_TARBALL)}`,
    `CODEX_ACP_0_11_1_INTEGRITY=${JSON.stringify(codexAcpCommittedIntegrity)}`,
    `MCPORTER_VERSION=${JSON.stringify(PINNED_MCPORTER_VERSION)}`,
    `MCPORTER_0_7_3_INTEGRITY=${JSON.stringify(PINNED_MCPORTER_INTEGRITY)}`,
    `MCPORTER_0_7_3_TARBALL=${JSON.stringify(PINNED_MCPORTER_TARBALL)}`,
    `export NEMOCLAW_REVIEWED_NPM_EXECUTABLE=${JSON.stringify(reviewedNpmExecutable)}`,
    "export NODE_OPTIONS=",
    `installed_openclaw_version_prefix=${JSON.stringify(installedOpenClawVersionPrefix)}`,
    `installed_openclaw_version_suffix=${JSON.stringify(installedOpenClawVersionSuffix)}`,
    `include_installed_openclaw_version=${includeInstalledOpenClawVersion ? "1" : "0"}`,
    `openclaw_version_command_status=${openclawVersionCommandStatus}`,
    `installed_openclaw_version=${JSON.stringify(installedOpenClawVersion)}`,
    `installed_mcporter_version=${JSON.stringify(installedMcporterVersion)}`,
    `fail_openclaw_npm_ci=${failOpenClawNpmCi ? "1" : "0"}`,
    `fail_openclaw_verify_installed_lock=${failOpenClawVerifyInstalledLock ? "1" : "0"}`,
    "node() {",
    '  if printf "%s\\n" "$*" | grep -q -- "--verify-installed-lock"; then printf "node %s\\n" "$*" >> "$call_log"; [ "$fail_openclaw_verify_installed_lock" = "0" ] || return 44; return 0; fi',
    `  if [ "\${1:-}" = ${JSON.stringify(path.join(openclawRuntime, "node_modules", "openclaw", "scripts", "postinstall-bundled-plugins.mjs"))} ] || [ "\${1:-}" = ${JSON.stringify(path.join(openclawGlobal, "scripts", "postinstall-bundled-plugins.mjs"))} ]; then printf "node %s\\n" "$*" >> "$call_log"; return 0; fi`,
    '  if [ "${1:-}" = "--input-type=module" ] && [ "${2:-}" = "-e" ] && printf "%s\\n" "${3:-}" | grep -q "StreamableHTTPServerTransport"; then printf "node %s\\n" "$*" >> "$call_log"; return 0; fi',
    '  "$real_node" "$@"',
    "}",
    "openclaw() {",
    '  if [ "${1:-}" != "--version" ]; then return 127; fi',
    '  if [ "$include_installed_openclaw_version" = "1" ]; then printf "%s%s%s\\n" "$installed_openclaw_version_prefix" "$installed_openclaw_version" "$installed_openclaw_version_suffix"; else printf "%s%s\\n" "$installed_openclaw_version_prefix" "$installed_openclaw_version_suffix"; fi',
    '  return "$openclaw_version_command_status"',
    "}",
    'mcporter() { if [ "${1:-}" = "--version" ]; then printf "%s\\n" "$installed_mcporter_version"; else return 127; fi; }',
    "codex-acp() { :; }",
    "stat() {",
    '  if [ "${1:-}" = "-c" ] && [ "${3:-}" = "$openclaw_provenance_path" ]; then printf "%s\\n" "$openclaw_provenance_metadata"; return 0; fi',
    '  command stat "$@"',
    "}",
    "sha256sum() {",
    `  if [ "\${1:-}" = ${JSON.stringify(path.join(openclawRuntime, "package-lock.json"))} ]; then printf '%s  %s\\n' ${JSON.stringify(PINNED_OPENCLAW_LOCK_SHA256)} "$1"; return 0; fi`,
    `  if [ "\${1:-}" = ${JSON.stringify(path.join(mcporterRuntime, "package-lock.json"))} ]; then printf '%s  %s\\n' ${JSON.stringify(PINNED_MCPORTER_LOCK_SHA256)} "$1"; return 0; fi`,
    `  if [ "\${1:-}" = ${JSON.stringify(auditExceptionFile)} ]; then printf '%s  %s\\n' ${JSON.stringify(auditExceptionPolicySha256)} "$1"; return 0; fi`,
    '  printf "unexpected sha256sum input: %s\\n" "${1:-}" >&2; return 1',
    "}",
    "npm() {",
    '  printf "npm %s\\n" "$*" >> "$call_log";',
    `  if [ "\${1:-}" = "--prefix" ] && [ "\${2:-}" = ${JSON.stringify(openclawRuntime)} ] && [ "\${3:-}" = "ci" ]; then [ "$fail_openclaw_npm_ci" = "0" ] || return 42; installed_openclaw_version="$OPENCLAW_VERSION"; return 0; fi`,
    `  if [ "\${1:-}" = "--prefix" ] && [ "\${2:-}" = ${JSON.stringify(mcporterRuntime)} ] && [ "\${3:-}" = "ci" ]; then installed_mcporter_version="$MCPORTER_VERSION"; return 0; fi`,
    '  if [ "${1:-}" = "view" ] && [ "${3:-}" = "version" ]; then printf "%s\\n" "$OPENCLAW_VERSION"; return 0; fi',
    `  if [ "\${1:-}" = "view" ] && [ "\${2:-}" = "@zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION}" ] && [ "\${3:-}" = "dist.integrity" ]; then printf "%s\\n" ${JSON.stringify(codexAcpRegistryIntegrity)}; return 0; fi`,
    `  if [ "\${1:-}" = "view" ] && [ "\${2:-}" = "@zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION}" ] && [ "\${3:-}" = "dist.tarball" ]; then printf "%s\\n" ${JSON.stringify(codexAcpRegistryTarball)}; return 0; fi`,
    `  if [ "\${1:-}" = "view" ] && [ "\${2:-}" = "mcporter@${PINNED_MCPORTER_VERSION}" ] && [ "\${3:-}" = "dist.integrity" ]; then printf "%s\\n" ${JSON.stringify(PINNED_MCPORTER_INTEGRITY)}; return 0; fi`,
    `  if [ "\${1:-}" = "view" ] && [ "\${3:-}" = "dist.integrity" ]; then printf "%s\\n" ${JSON.stringify(registryIntegrity)}; return 0; fi`,
    `  if [ "\${1:-}" = "view" ] && [ "\${3:-}" = "dist.tarball" ]; then printf "%s\\n" ${JSON.stringify(registryTarball)}; return 0; fi`,
    '  if [ "${1:-}" = "pack" ]; then',
    '    pack_spec="${2:-}"; pack_dir="";',
    '    while [ "$#" -gt 0 ]; do',
    '      if [ "${1:-}" = "--pack-destination" ]; then pack_dir="${2:-}"; shift 2; continue; fi',
    "      shift",
    "    done",
    '    test -n "$pack_dir";',
    '    pack_file="$(basename "$pack_spec")";',
    '    case "$pack_file" in *.tgz) ;; *) pack_file="${pack_file}.tgz" ;; esac',
    `    reported_pack_file=${JSON.stringify(packFilename ?? "")}`,
    ...(packFilename === null
      ? []
      : ['    reported_pack_file="${reported_pack_file:-$pack_file}"']),
    '    printf "fake tarball" > "$pack_dir/$pack_file";',
    `    case "$pack_spec" in *"codex-acp"*) pack_integrity=${JSON.stringify(codexAcpPackIntegrity)} ;; *) pack_integrity=${JSON.stringify(packIntegrity)} ;; esac`,
    '    printf \'[{"filename":"%s","integrity":"%s"}]\\n\' "$reported_pack_file" "$pack_integrity";',
    "    return 0",
    "  fi",
    '  if [ "${1:-}" = "install" ] && printf "%s\\n" "$*" | grep -q "openclaw-"; then installed_openclaw_version="$OPENCLAW_VERSION"; fi',
    "}",
    "pip3() { return 0; }",
    command
      .replaceAll("/opt/nemoclaw-blueprint/blueprint.yaml", blueprint)
      .replaceAll("/tmp/blueprint.yaml", blueprint)
      .replaceAll(OPENCLAW_BASE_PROVENANCE_PATH, provenancePath)
      .replaceAll("/usr/local/lib/nemoclaw/openclaw-runtime", openclawRuntime)
      .replaceAll("/usr/local/lib/node_modules/openclaw", openclawGlobal)
      .replaceAll("/usr/local/lib/node_modules", path.dirname(openclawGlobal))
      .replaceAll("/usr/local/bin/openclaw", openclawBin)
      .replaceAll("/usr/local/lib/nemoclaw/mcporter-runtime", mcporterRuntime)
      .replaceAll("/usr/local/bin/mcporter", mcporterBin)
      .replaceAll("/usr/local/lib/nemoclaw/extract-semver", openclawVersionExtractor)
      .replaceAll("/usr/local/lib", path.join(tmp, "usr-local-lib"))
      .replaceAll("/usr/local/bin", path.join(tmp, "usr-local-bin"))
      .replaceAll("/scripts/lib/reviewed-npm-archive.mts", REVIEWED_NPM_ARCHIVE_HELPER)
      .replaceAll("/scripts/lib/openclaw-npm-remediation.mts", remediationHelper)
      .replaceAll("/scripts/lib/reviewed-npm-audit.mts", auditHelper)
      .replaceAll("/scripts/npm-audit-exceptions.json", auditExceptionFile),
  ].join("\n");
  const scriptPath = path.join(tmp, "run.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 10000 });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "";
  const provenanceExists = fs.existsSync(provenancePath);
  const provenanceContent = provenanceExists ? fs.readFileSync(provenancePath, "utf-8") : null;
  const provenanceMode = provenanceExists ? fs.statSync(provenancePath).mode & 0o777 : null;
  const runtimeExposed = [openclawGlobal, openclawBin].some((candidate) => {
    try {
      fs.lstatSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  return {
    result,
    calls,
    provenanceExists,
    provenanceContent,
    provenanceMode,
    runtimeExposed,
  };
}

function runProductionBuildArgGuard(
  args: string[],
  env: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [PRODUCTION_BUILD_ARG_GUARD, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

function declaredProductionPinArgNames(): string[] {
  const names = PRODUCTION_DOCKERFILES.flatMap((dockerfile) =>
    fs
      .readFileSync(dockerfile, "utf-8")
      .split("\n")
      .flatMap((line) => {
        const match = /^ARG ([A-Z_][A-Z0-9_]*(?:_INTEGRITY|_TARBALL))(?:=|$)/.exec(line);
        return match?.[1] ? [match[1]] : [];
      }),
  );
  return [...new Set(names)].sort();
}

function runOptionalOpenClawPluginBlock(
  options: {
    openclawVersion?: string;
    otel?: boolean;
    webSearch?: boolean;
    diagnosticsRegistryIntegrity?: string;
    diagnosticsRegistryTarball?: string;
    braveRegistryIntegrity?: string;
    braveRegistryTarball?: string;
    pluginPackFilename?: string;
  } = {},
) {
  const {
    openclawVersion = PINNED_OPENCLAW_VERSION,
    otel = true,
    webSearch = true,
    diagnosticsRegistryIntegrity = PINNED_OPENCLAW_DIAGNOSTICS_OTEL_INTEGRITY,
    diagnosticsRegistryTarball = PINNED_OPENCLAW_DIAGNOSTICS_OTEL_TARBALL,
    braveRegistryIntegrity = PINNED_OPENCLAW_BRAVE_PLUGIN_INTEGRITY,
    braveRegistryTarball = PINNED_OPENCLAW_BRAVE_PLUGIN_TARBALL,
    pluginPackFilename = "",
  } = options;
  const command = extractRunBlock(
    DOCKERFILE,
    "# Install non-messaging OpenClaw plugins that need to match the runtime.",
    "# The reviewed cache stays root-owned and immutable to the sandbox user.",
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-plugin-integrity-"));
  const log = path.join(tmp, "calls.log");
  const reviewedNpmExecutable = path.join(tmp, "reviewed-npm-fixture");
  const remediationFixture = path.join(tmp, "remediation-fixture.cjs");
  fs.writeFileSync(
    reviewedNpmExecutable,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf 'npm %s\\n' "$*" >> ${JSON.stringify(log)}`,
      'if [ "${1:-}" = "pack" ]; then',
      '  pack_spec="${2:-}"; pack_dir=""',
      '  while [ "$#" -gt 0 ]; do if [ "${1:-}" = "--pack-destination" ]; then pack_dir="${2:-}"; shift 2; continue; fi; shift; done',
      '  pack_file="$(basename "$pack_spec")"',
      `  reported_pack_file=${JSON.stringify(pluginPackFilename)}`,
      '  reported_pack_file="${reported_pack_file:-$pack_file}"',
      '  printf "fake plugin tarball" > "$pack_dir/$pack_file"',
      '  case "$pack_spec" in',
      `    *"diagnostics-otel"*) printf '[{"filename":"%s","integrity":"%s"}]\\n' "$reported_pack_file" ${JSON.stringify(diagnosticsRegistryIntegrity)} ;;`,
      `    *"brave-plugin"*) printf '[{"filename":"%s","integrity":"%s"}]\\n' "$reported_pack_file" ${JSON.stringify(braveRegistryIntegrity)} ;;`,
      "    *) exit 1 ;;",
      "  esac",
      "  exit 0",
      "fi",
      'if [ "${1:-}" != "view" ]; then exit 1; fi',
      'case "${2:-}" in',
      `  "@openclaw/diagnostics-otel@${PINNED_OPENCLAW_VERSION}") if [ "\${3:-}" = "dist.integrity" ]; then printf '%s\\n' ${JSON.stringify(diagnosticsRegistryIntegrity)}; else printf '%s\\n' ${JSON.stringify(diagnosticsRegistryTarball)}; fi ;;`,
      `  "@openclaw/brave-plugin@${PINNED_OPENCLAW_VERSION}") if [ "\${3:-}" = "dist.integrity" ]; then printf '%s\\n' ${JSON.stringify(braveRegistryIntegrity)}; else printf '%s\\n' ${JSON.stringify(braveRegistryTarball)}; fi ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    remediationFixture,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const log = ${JSON.stringify(log)};`,
      "const args = process.argv.slice(2);",
      "const value = (name) => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) process.exit(1); return args[index + 1]; };",
      "const archive = value('--archive');",
      "const workingDirectory = value('--working-directory');",
      "const outputDirectory = path.join(workingDirectory, 'remediated');",
      "fs.mkdirSync(outputDirectory, { recursive: true });",
      "const archivePath = path.join(outputDirectory, path.basename(archive));",
      "fs.copyFileSync(archive, archivePath);",
      "fs.appendFileSync(log, `remediate ${args.join(' ')}\\n`);",
      "process.stdout.write(JSON.stringify({ archivePath, integrity: 'sha512-remediated', remediated: true }));",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(log)}`,
    `OPENCLAW_VERSION=${JSON.stringify(openclawVersion)}`,
    `OPENCLAW_DIAGNOSTICS_OTEL_2026_7_1_INTEGRITY=${JSON.stringify(PINNED_OPENCLAW_DIAGNOSTICS_OTEL_INTEGRITY)}`,
    `OPENCLAW_BRAVE_PLUGIN_2026_7_1_INTEGRITY=${JSON.stringify(PINNED_OPENCLAW_BRAVE_PLUGIN_INTEGRITY)}`,
    `NEMOCLAW_OPENCLAW_OTEL=${otel ? "1" : "0"}`,
    `NEMOCLAW_WEB_SEARCH_ENABLED=${webSearch ? "1" : "0"}`,
    `export NEMOCLAW_REVIEWED_NPM_EXECUTABLE=${JSON.stringify(reviewedNpmExecutable)}`,
    "export NODE_OPTIONS=",
    'openclaw() { printf \'openclaw %s\\nopenclaw-env %s %s\\n\' "$*" "${NPM_CONFIG_IGNORE_SCRIPTS:-}" "${npm_config_ignore_scripts:-}" >> "$call_log"; }',
    "npm() {",
    '  printf "npm %s\\n" "$*" >> "$call_log";',
    '  if [ "${1:-}" = "pack" ]; then',
    '    pack_spec="${2:-}"; pack_dir="";',
    '    while [ "$#" -gt 0 ]; do',
    '      if [ "${1:-}" = "--pack-destination" ]; then pack_dir="${2:-}"; shift 2; continue; fi',
    "      shift",
    "    done",
    '    test -n "$pack_dir"; pack_file="$(basename "$pack_spec")";',
    `    reported_pack_file=${JSON.stringify(pluginPackFilename)}`,
    '    reported_pack_file="${reported_pack_file:-$pack_file}"',
    '    printf "fake plugin tarball" > "$pack_dir/$pack_file";',
    '    case "$pack_spec" in',
    `      *"diagnostics-otel"*) printf '[{"filename":"%s","integrity":"%s"}]\\n' "$reported_pack_file" ${JSON.stringify(diagnosticsRegistryIntegrity)}; return 0 ;;`,
    `      *"brave-plugin"*) printf '[{"filename":"%s","integrity":"%s"}]\\n' "$reported_pack_file" ${JSON.stringify(braveRegistryIntegrity)}; return 0 ;;`,
    "    esac",
    "    return 1",
    "  fi",
    '  if [ "${1:-}" != "view" ]; then exit 1; fi',
    '  case "${2:-}" in',
    `    "@openclaw/diagnostics-otel@${PINNED_OPENCLAW_VERSION}") if [ "\${3:-}" = "dist.integrity" ]; then printf "%s\\n" ${JSON.stringify(diagnosticsRegistryIntegrity)}; return 0; fi; if [ "\${3:-}" = "dist.tarball" ]; then printf "%s\\n" ${JSON.stringify(diagnosticsRegistryTarball)}; return 0; fi ;;`,
    `    "@openclaw/brave-plugin@${PINNED_OPENCLAW_VERSION}") if [ "\${3:-}" = "dist.integrity" ]; then printf "%s\\n" ${JSON.stringify(braveRegistryIntegrity)}; return 0; fi; if [ "\${3:-}" = "dist.tarball" ]; then printf "%s\\n" ${JSON.stringify(braveRegistryTarball)}; return 0; fi ;;`,
    "  esac",
    "  return 1",
    "}",
    command
      .replace(
        "export NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR=/opt/nemoclaw-reviewed-npm-archives;",
        "unset NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR;",
      )
      .replaceAll("/scripts/lib/reviewed-npm-archive.mts", REVIEWED_NPM_ARCHIVE_HELPER)
      .replaceAll("/scripts/lib/openclaw-npm-remediation.mts", remediationFixture),
  ].join("\n");
  const scriptPath = path.join(tmp, "run.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 10000 });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "";
  fs.rmSync(tmp, { recursive: true, force: true });
  return { result, calls };
}

export type OpenClawIntegrityPinTestGroup = "base" | "contract" | "plugin-install";

export function registerOpenClawIntegrityPinTests(group: OpenClawIntegrityPinTestGroup): void {
  describe("OpenClaw npm integrity pins", () => {
    if (group === "contract") {
      it("keeps the advisory review note aligned with the committed OpenClaw pin", () => {
        const reviewNote = fs.readFileSync(DEPENDENCY_REVIEW_NOTE, "utf-8").replace(/\s+/g, " ");

        expect(reviewNote).toContain(`openclaw@${PINNED_OPENCLAW_VERSION}`);
        expect(reviewNote).toContain(PINNED_OPENCLAW_INTEGRITY);
        expect(reviewNote).toContain(PINNED_OPENCLAW_TARBALL);
        expect(reviewNote).toContain(`tar@${PINNED_NEMOCLAW_TAR_VERSION}`);
        expect(reviewNote).toContain(PINNED_NEMOCLAW_TAR_INTEGRITY);
        expect(reviewNote).toContain(PINNED_NEMOCLAW_TAR_TARBALL);
        expect(reviewNote).toContain(PINNED_NEMOCLAW_TAR_COMMIT);
        expect(reviewNote).toContain(`@zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION}`);
        expect(reviewNote).toContain(PINNED_CODEX_ACP_TARBALL);
        expect(reviewNote).toContain(PINNED_CODEX_ACP_INTEGRITY);
        expect(reviewNote).toContain("@openclaw/diagnostics-otel@2026.7.1");
        expect(reviewNote).toContain(PINNED_OPENCLAW_DIAGNOSTICS_OTEL_INTEGRITY);
        expect(reviewNote).toContain("@openclaw/brave-plugin@2026.7.1");
        expect(reviewNote).toContain(PINNED_OPENCLAW_BRAVE_PLUGIN_INTEGRITY);
        expect(reviewNote).toContain("@openclaw/discord@2026.7.1");
        expect(reviewNote).toContain(PINNED_OPENCLAW_DISCORD_INTEGRITY);
        expect(reviewNote).toContain("@openclaw/slack@2026.7.1");
        expect(reviewNote).toContain(PINNED_OPENCLAW_SLACK_INTEGRITY);
        expect(reviewNote).toContain("@openclaw/whatsapp@2026.7.1");
        expect(reviewNote).toContain(PINNED_OPENCLAW_WHATSAPP_INTEGRITY);
        expect(reviewNote).toContain("@openclaw/msteams@2026.7.1");
        expect(reviewNote).toContain(PINNED_OPENCLAW_MSTEAMS_INTEGRITY);
        expect(reviewNote).toContain("@tencent-weixin/openclaw-weixin@2.4.3");
        expect(reviewNote).toContain(PINNED_WECHAT_PLUGIN_INTEGRITY);
        expect(reviewNote).toContain("downloaded tarball integrity");
        expect(reviewNote).toContain("bind reviewed npm installs to verified local archives");
        expect(reviewNote).toContain("npm pack --json");
        expect(reviewNote).toContain("rejects reported archive filenames");
        expect(reviewNote).toContain("unsafe archive paths");
        expect(reviewNote).toContain("each reviewed npm plugin registry integrity");
        expect(reviewNote).toContain("returns only the verified local `.tgz` path");
        expect(reviewNote).toContain("OpenClaw Compiled-Dist Patch Runtime Boundary");
        expect(reviewNote).toContain(
          "The long-term source of truth for these behaviors remains upstream OpenClaw",
        );
        expect(reviewNote).toContain("test/agents/openclaw/openclaw-real-patched-dist-harness.test.ts");
        expect(reviewNote).toContain("NEMOCLAW_REAL_OPENCLAW_DIST_HARNESS=1");
        expect(reviewNote).toContain("not a substitute for focused nightly E2E proof");
        expect(reviewNote).toContain("OpenClaw Diagnostics OTEL Host Gateway Boundary");
        expect(reviewNote).toContain("openclaw-diagnostics-otel-local");
        expect(reviewNote).toContain("imports `OTLPTraceExporter`");
        expect(reviewNote).toContain("contains no `web_fetch`, `fetchWithSsrFGuard`");
        expect(reviewNote).toContain("@openclaw/diagnostics-otel@2026.7.1");
        expect(reviewNote).toContain("@openclaw/brave-plugin@2026.7.1");
        expect(reviewNote).toContain("@tencent-weixin/openclaw-weixin@2.4.3");
        expect(reviewNote).toContain("three production-compatible boundaries");
        expect(reviewNote).toContain("Lower-severity findings remain visible");
        expect(reviewNote).toContain("`0` high");
        expect(reviewNote).toContain("`0` critical");
        expect(reviewNote).toContain(
          "`dist/pipeline.runtime-*.js`, which exports `prepareSlackMessage`",
        );
        expect(reviewNote).toContain(
          "imports the hashed pipeline runtime for `prepareSlackMessage`",
        );
        expect(reviewNote).toContain(
          "only reports `openclaw-pipeline-runtime` after allowed prepare",
        );
        expect(reviewNote).toContain("`dist/extensions/telegram/runtime-api.js`");
        expect(reviewNote).toContain("which exports `sendMessageTelegram`");
        expect(reviewNote).toContain("fails closed if the installed runtime file is missing");
        expect(reviewNote).toContain("NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1");
        expect(reviewNote).toContain("scripts/check-production-build-args.sh");
        expect(reviewNote).toContain("production build args");
        expect(reviewNote).toContain("claiming `openclaw-pipeline-runtime` inbound proof");
        expect(reviewNote).toContain("imports `dist/extensions/telegram/test-api.js`");
        expect(reviewNote).toContain("gateway/upstream reporting layer");
        expect(reviewNote).toContain("scripts/patch-openclaw-issue-4434-diagnostics.mts");
        expect(reviewNote).toContain("scripts/patch-openclaw-device-self-approval.mts");
        expect(reviewNote).toContain("scripts/patch-openclaw-shared-state-permissions.mts");
        expect(reviewNote).toContain("Gateway Startup Migration Compatibility");
        expect(reviewNote).toContain("HOME=/sandbox");
        expect(reviewNote).toContain("approveDevicePairing");
        expect(reviewNote).toContain(
          "Recovery hint: check sandbox egress and provider reachability, then retry.",
        );
        expect(reviewNote).toContain("default 180-second timeout");
      });

      it("keeps NemoClaw's direct tar dependency above the reviewed advisory floor", () => {
        const packageJson = JSON.parse(
          fs.readFileSync(path.join(REPO_ROOT, "nemoclaw", "package.json"), "utf-8"),
        ) as { dependencies?: Record<string, string> };
        const packageLockSource = fs.readFileSync(NEMOCLAW_PLUGIN_LOCKFILE);
        const packageLock = JSON.parse(packageLockSource.toString("utf-8")) as {
          packages?: Record<string, { integrity?: string; resolved?: string; version?: string }>;
        };
        const cacheSeed = JSON.parse(
          fs.readFileSync(NEMOCLAW_NPM_CACHE_SEED_MANIFEST, "utf-8"),
        ) as {
          archives?: Array<{ archive?: string; integrity?: string; resolved?: string }>;
          lockSha256?: string;
        };
        const lockedTar = packageLock.packages?.["node_modules/tar"];

        expect(packageJson.dependencies?.tar).toBe(PINNED_NEMOCLAW_TAR_VERSION);
        expect(lockedTar).toEqual(
          expect.objectContaining({
            integrity: PINNED_NEMOCLAW_TAR_INTEGRITY,
            resolved: PINNED_NEMOCLAW_TAR_TARBALL,
            version: PINNED_NEMOCLAW_TAR_VERSION,
          }),
        );
        expect(cacheSeed.lockSha256).toBe(
          createHash("sha256").update(packageLockSource).digest("hex"),
        );
        expect(cacheSeed.archives).toContainEqual(
          expect.objectContaining({
            archive: `tar-${PINNED_NEMOCLAW_TAR_VERSION}.tgz`,
            integrity: PINNED_NEMOCLAW_TAR_INTEGRITY,
            resolved: PINNED_NEMOCLAW_TAR_TARBALL,
          }),
        );
      });

      it("keeps the Teams OpenClaw plugin manifest pinned to the reviewed 2026.7.1 integrity", () => {
        const teamsManifest = createBuiltInChannelManifestRegistry().get("teams");
        const teamsPackage = teamsManifest?.agentPackages?.find(
          (agentPackage) =>
            agentPackage.agent === "openclaw" &&
            agentPackage.manager === "openclaw-plugin" &&
            agentPackage.id === "openclawPluginPackage",
        );

        expect(teamsPackage).toMatchObject({
          spec: "npm:@openclaw/msteams@{{openclaw.version}}",
          pin: true,
          integrityByVersion: {
            [PINNED_OPENCLAW_VERSION]: PINNED_OPENCLAW_MSTEAMS_INTEGRITY,
          },
        });
      });

      it("keeps reviewed OpenClaw messaging plugin integrity pins aligned with built-in manifests", () => {
        const registry = createBuiltInChannelManifestRegistry();
        const expectedEntries: [string, string][] = registry.list().flatMap((manifest) =>
          (manifest.agentPackages ?? [])
            .filter(
              (agentPackage) =>
                agentPackage.agent === "openclaw" && agentPackage.manager === "openclaw-plugin",
            )
            .map((agentPackage) => {
              const packageSpec = agentPackage.spec
                .replace(/^npm:/, "")
                .replaceAll("{{openclaw.version}}", PINNED_OPENCLAW_VERSION);
              const integrity =
                agentPackage.integrity ??
                agentPackage.integrityByVersion?.[PINNED_OPENCLAW_VERSION];

              expect(agentPackage.pin, `${manifest.id}:${agentPackage.id}`).toBe(true);
              expect(integrity, `${manifest.id}:${packageSpec}`).toBeDefined();
              return [packageSpec, integrity as string] as [string, string];
            }),
        );

        const sortedEntries = (entries: [string, string][]) =>
          Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));

        expect(
          sortedEntries(
            Object.entries(
              reviewedOpenClawPluginIntegrityByPackageSpec({
                OPENCLAW_VERSION: PINNED_OPENCLAW_VERSION,
              }),
            ),
          ),
        ).toEqual(sortedEntries(expectedEntries));
      });

      it.each(["latest", "^2026.7.1"])(
        "rejects a trusted OpenClaw plugin manifest with non-exact version %s",
        (version) => {
          const slackManifest = createBuiltInChannelManifestRegistry().get("slack");
          expect(slackManifest).toBeDefined();
          const nonExactManifest = {
            ...slackManifest!,
            agentPackages: slackManifest!.agentPackages?.map((agentPackage) =>
              agentPackage.agent === "openclaw" && agentPackage.manager === "openclaw-plugin"
                ? {
                    ...agentPackage,
                    spec: `npm:@openclaw/slack@${version}`,
                    integrity: PINNED_OPENCLAW_SLACK_INTEGRITY,
                    integrityByVersion: undefined,
                  }
                : agentPackage,
            ),
          };

          expect(() =>
            reviewedOpenClawPluginIntegrityByPackageSpec(
              { OPENCLAW_VERSION: PINNED_OPENCLAW_VERSION },
              [nonExactManifest],
            ),
          ).toThrow(
            `must use an exact-version OpenClaw plugin package: npm:@openclaw/slack@${version}`,
          );
        },
      );
    }

    if (group === "plugin-install") {
      it("verifies optional non-messaging OpenClaw plugin integrity before install", () => {
        const { result, calls } = runOptionalOpenClawPluginBlock();

        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        expect(calls).toContain(
          `npm view @openclaw/diagnostics-otel@${PINNED_OPENCLAW_VERSION} dist.integrity`,
        );
        expect(calls).toContain(
          `npm view @openclaw/diagnostics-otel@${PINNED_OPENCLAW_VERSION} dist.tarball`,
        );
        expect(calls).toContain(
          "npm pack https://registry.npmjs.org/@openclaw/diagnostics-otel/-/diagnostics-otel-2026.7.1.tgz --pack-destination",
        );
        expect(calls).toMatch(
          /openclaw plugins install npm-pack:\S*\/diagnostics-otel-2026\.7\.1\.tgz\n/,
        );
        expect(calls).toContain(`remediate --archive`);
        expect(calls).toContain(
          `--package-spec @openclaw/diagnostics-otel@${PINNED_OPENCLAW_VERSION}`,
        );
        expect(calls).toContain(
          `npm view @openclaw/brave-plugin@${PINNED_OPENCLAW_VERSION} dist.integrity`,
        );
        expect(calls).toContain(
          `npm view @openclaw/brave-plugin@${PINNED_OPENCLAW_VERSION} dist.tarball`,
        );
        expect(calls).toContain(
          "npm pack https://registry.npmjs.org/@openclaw/brave-plugin/-/brave-plugin-2026.7.1.tgz --pack-destination",
        );
        expect(calls).toMatch(
          /openclaw plugins install npm-pack:\S*\/brave-plugin-2026\.7\.1\.tgz\n/,
        );
        expect(calls).toContain("openclaw-env true true");
      });

      it("fails closed before optional OpenClaw plugin install when registry integrity drifts", () => {
        const { result, calls } = runOptionalOpenClawPluginBlock({
          otel: false,
          braveRegistryIntegrity: "sha512-brave-drift",
        });

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
          `OpenClaw plugin @openclaw/brave-plugin@${PINNED_OPENCLAW_VERSION} npm integrity mismatch`,
        );
        expect(`${result.stdout}${result.stderr}`).toContain(
          `Expected: ${PINNED_OPENCLAW_BRAVE_PLUGIN_INTEGRITY}`,
        );
        expect(`${result.stdout}${result.stderr}`).toContain("Actual:   sha512-brave-drift");
        expect(calls).toContain(
          `npm view @openclaw/brave-plugin@${PINNED_OPENCLAW_VERSION} dist.integrity`,
        );
        expect(calls).not.toContain("openclaw plugins install");
      });

      it("fails closed before optional OpenClaw plugin install when the registry tarball URL drifts", () => {
        const driftedTarball =
          "https://registry.npmjs.org/@openclaw/brave-plugin/-/brave-plugin-2026.7.2.tgz";
        const { result, calls } = runOptionalOpenClawPluginBlock({
          otel: false,
          braveRegistryTarball: driftedTarball,
        });

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
          `OpenClaw plugin @openclaw/brave-plugin@${PINNED_OPENCLAW_VERSION} npm tarball URL mismatch`,
        );
        expect(`${result.stdout}${result.stderr}`).toContain(
          `Expected: ${PINNED_OPENCLAW_BRAVE_PLUGIN_TARBALL}`,
        );
        expect(`${result.stdout}${result.stderr}`).toContain(`Actual:   ${driftedTarball}`);
        expect(calls).toContain(
          `npm view @openclaw/brave-plugin@${PINNED_OPENCLAW_VERSION} dist.tarball`,
        );
        expect(calls).not.toContain("npm pack");
        expect(calls).not.toContain("openclaw plugins install");
      });

      it("fails closed for optional OpenClaw plugin version overrides without committed pins", () => {
        const { result, calls } = runOptionalOpenClawPluginBlock({
          openclawVersion: UNPINNED_OPENCLAW_VERSION,
          webSearch: false,
        });

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
          `OpenClaw plugin @openclaw/diagnostics-otel@${UNPINNED_OPENCLAW_VERSION} has no committed npm integrity pin`,
        );
        expect(calls).not.toContain("openclaw plugins install");
      });

      it("installs the reviewed OpenClaw pin when registry integrity matches", () => {
        const production = runInstallBlock(
          extractRunBlock(
            DOCKERFILE,
            "# OPENCLAW_VERSION is the NemoClaw runtime build target",
            "# Patch OpenClaw media fetch",
          ),
          {
            openclawVersion: PINNED_OPENCLAW_VERSION,
            committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
            registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
          },
        );
        const base = runInstallBlock(
          extractRunBlock(
            DOCKERFILE_BASE,
            "# Install OpenClaw CLI + PyYAML.",
            "# Baseline health check.",
          ),
          {
            openclawVersion: PINNED_OPENCLAW_VERSION,
            committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
            registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
          },
        );

        expect(production.result.status).toBe(0);
        expect(base.result.status, `${base.result.stdout}${base.result.stderr}`).toBe(0);
        expect(production.calls).toContain(
          `npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.integrity`,
        );
        expect(production.calls).toContain(
          `npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.tarball`,
        );
        expect(production.calls).not.toContain(
          `npm pack ${PINNED_OPENCLAW_TARBALL} --pack-destination`,
        );
        expect(production.calls).toMatch(/npm --prefix \S+\/openclaw-runtime ci /u);
        expect(production.calls).toContain("--verify-installed-lock");
        expect(production.calls).toContain("postinstall-bundled-plugins.mjs");
        expect(base.calls).toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} version`);
        expect(base.calls).toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.integrity`);
        expect(base.calls).toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.tarball`);
        expect(base.calls).not.toContain(`npm pack ${PINNED_OPENCLAW_TARBALL} --pack-destination`);
        expect(base.calls).toMatch(/npm --prefix \S+\/openclaw-runtime ci /u);
        expect(base.calls).toContain("--verify-installed-lock");
        expect(base.calls).toContain("postinstall-bundled-plugins.mjs");
        expect(base.provenanceContent).toBe(openClawBaseProvenance());
        expect(base.provenanceMode).toBe(0o444);
      });
    }

    if (group === "base") {
      it("reuses exact protected OpenClaw and mcporter base provenance without registry work", () => {
        const { result, calls, provenanceExists } = runInstallBlock(
          extractRunBlock(
            DOCKERFILE,
            "# OPENCLAW_VERSION is the NemoClaw runtime build target",
            "# Patch OpenClaw media fetch",
          ),
          {
            openclawVersion: PINNED_OPENCLAW_VERSION,
            installedOpenClawVersion: PINNED_OPENCLAW_VERSION,
            installedOpenClawVersionPrefix: "OpenClaw v",
            installedOpenClawVersionSuffix: " (abcdef)",
            committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
            registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
            baseProvenance: openClawBaseProvenance(),
          },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
          `Reusing reviewed base OpenClaw ${PINNED_OPENCLAW_VERSION} with matching reviewed provenance`,
        );
        expect(calls).not.toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.integrity`);
        expect(calls).not.toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.tarball`);
        expect(calls).not.toContain(`npm pack ${PINNED_OPENCLAW_TARBALL} --pack-destination`);
        expect(calls).not.toContain(
          "npm install -g --no-audit --no-fund --no-progress --ignore-scripts ",
        );
        expect(calls).not.toContain(
          "node /usr/local/lib/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs",
        );
        expect(result.stdout).toContain(
          `Reusing reviewed base mcporter ${PINNED_MCPORTER_VERSION} with matching lock provenance`,
        );
        expect(calls).not.toContain(`npm view mcporter@${PINNED_MCPORTER_VERSION} dist.integrity`);
        expect(calls).not.toContain("npm --prefix ");
        expect(provenanceExists).toBe(false);
      });

      it("rejects matching trusted-base provenance when its audit exception has expired", () => {
        const advisory = "GHSA-aaaa-bbbb-cccc";
        const auditExceptionPolicy = `${JSON.stringify({
          schemaVersion: 1,
          exceptions: [
            {
              advisory,
              package: "fast-uri",
              installedVersion: "3.1.3",
              graph: "mcporter-runtime",
              severity: "high",
              decision: "temporary-risk-acceptance",
              expires: "2000-01-01",
              owner: "security-maintainers",
              trackingIssue: "https://github.com/NVIDIA/NemoClaw/issues/1234",
              rationale: "Regression fixture for trusted-base expiry.",
              compensatingControls: ["The child build revalidates exception expiry."],
            },
          ],
        })}\n`;
        const auditPolicy = {
          exceptions: advisory,
          sha256: createHash("sha256").update(auditExceptionPolicy).digest("hex"),
          status: "accepted-exceptions" as const,
        };
        const { result, calls, provenanceExists } = runInstallBlock(
          extractRunBlock(
            DOCKERFILE,
            "# OPENCLAW_VERSION is the NemoClaw runtime build target",
            "# Patch OpenClaw media fetch",
          ),
          {
            openclawVersion: PINNED_OPENCLAW_VERSION,
            installedOpenClawVersion: PINNED_OPENCLAW_VERSION,
            committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
            registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
            auditExceptionPolicy,
            baseProvenance: openClawBaseProvenance(
              PINNED_OPENCLAW_VERSION,
              PINNED_OPENCLAW_INTEGRITY,
              PINNED_OPENCLAW_TARBALL,
              auditPolicy,
            ),
          },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("expired on 2000-01-01");
        expect(result.stdout).not.toContain("Reusing reviewed base OpenClaw");
        expect(result.stdout).not.toContain("Reusing reviewed base mcporter");
        expect(calls).toBe("");
        expect(provenanceExists).toBe(true);
      });

      it.each([
        ["missing marker", { baseProvenance: null }],
        [
          "wrong schema",
          { baseProvenance: openClawBaseProvenance().replace("schema=4", "schema=3") },
        ],
        [
          "wrong version",
          {
            baseProvenance: openClawBaseProvenance().replace(
              `package=openclaw@${PINNED_OPENCLAW_VERSION}`,
              "package=openclaw@2026.6.9",
            ),
          },
        ],
        [
          "wrong integrity",
          {
            baseProvenance: openClawBaseProvenance().replace(
              `integrity=${PINNED_OPENCLAW_INTEGRITY}`,
              "integrity=sha512-drift",
            ),
          },
        ],
        [
          "wrong tarball",
          {
            baseProvenance: openClawBaseProvenance().replace(
              `tarball=${PINNED_OPENCLAW_TARBALL}`,
              "tarball=https://registry.npmjs.org/openclaw/-/openclaw-drift.tgz",
            ),
          },
        ],
        [
          "wrong lifecycle recipe",
          {
            baseProvenance: openClawBaseProvenance().replace(
              "recipe=locked-ci+reviewed-lifecycle-v2",
              "recipe=ignore-scripts-only-v1",
            ),
          },
        ],
        [
          "wrong mcporter package",
          {
            baseProvenance: openClawBaseProvenance().replace(
              `mcporter-package=mcporter@${PINNED_MCPORTER_VERSION}`,
              "mcporter-package=mcporter@0.7.2",
            ),
          },
        ],
        [
          "wrong mcporter integrity",
          {
            baseProvenance: openClawBaseProvenance().replace(
              `mcporter-integrity=${PINNED_MCPORTER_INTEGRITY}`,
              "mcporter-integrity=sha512-drift",
            ),
          },
        ],
        [
          "wrong mcporter tarball",
          {
            baseProvenance: openClawBaseProvenance().replace(
              `mcporter-tarball=${PINNED_MCPORTER_TARBALL}`,
              "mcporter-tarball=https://registry.npmjs.org/mcporter/-/mcporter-0.7.2.tgz",
            ),
          },
        ],
        [
          "wrong mcporter lock",
          {
            baseProvenance: openClawBaseProvenance().replace(
              `mcporter-lock-sha256=${PINNED_MCPORTER_LOCK_SHA256}`,
              `mcporter-lock-sha256=${"0".repeat(64)}`,
            ),
          },
        ],
        [
          "wrong mcporter recipe",
          {
            baseProvenance: openClawBaseProvenance().replace(
              "mcporter-recipe=locked-ci+reviewed-audit-v3",
              "mcporter-recipe=locked-ci-only-v1",
            ),
          },
        ],
        [
          "wrong mcporter audit policy",
          {
            baseProvenance: openClawBaseProvenance().replace(
              `mcporter-audit-policy-sha256=${NPM_AUDIT_EXCEPTION_POLICY_SHA256}`,
              `mcporter-audit-policy-sha256=${"0".repeat(64)}`,
            ),
          },
        ],
        [
          "wrong mcporter audit status",
          {
            baseProvenance: openClawBaseProvenance().replace(
              `mcporter-audit-status=${MCPORTER_AUDIT_STATUS}`,
              `mcporter-audit-status=${
                MCPORTER_AUDIT_STATUS === "clean" ? "accepted-exceptions" : "clean"
              }`,
            ),
          },
        ],
        [
          "wrong mcporter audit exceptions",
          {
            baseProvenance: openClawBaseProvenance().replace(
              `mcporter-audit-exceptions=${MCPORTER_AUDIT_EXCEPTION_LIST}`,
              "mcporter-audit-exceptions=GHSA-aaaa-bbbb-cccc",
            ),
          },
        ],
        [
          "writable marker",
          { baseProvenance: openClawBaseProvenance(), baseProvenanceMetadata: "0:0:644" },
        ],
        [
          "symlink marker",
          { baseProvenance: openClawBaseProvenance(), baseProvenanceSymlink: true },
        ],
        [
          "wrong installed version",
          {
            baseProvenance: openClawBaseProvenance(),
            installedOpenClawVersion: LEGACY_REBUILD_OPENCLAW_VERSION,
          },
        ],
        [
          "wrong installed mcporter version",
          {
            baseProvenance: openClawBaseProvenance(),
            installedOpenClawVersion: PINNED_OPENCLAW_VERSION,
            installedMcporterVersion: "0.7.2",
          },
        ],
        [
          "custom base reference",
          { baseProvenance: openClawBaseProvenance(), baseImage: "registry.example/base:custom" },
        ],
        [
          "local base without independent CI attestation",
          {
            baseProvenance: openClawBaseProvenance(),
            baseImage: "nemoclaw-sandbox-base-local:current",
          },
        ],
        [
          "bare local base without independent CI attestation",
          {
            baseProvenance: openClawBaseProvenance(),
            baseImage: "nemoclaw-sandbox-base-local",
          },
        ],
        [
          "mutable official base tag without immutable publication identity",
          {
            baseProvenance: openClawBaseProvenance(),
            baseImage: "ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
          },
        ],
      ])("falls back to the reviewed archive for %s", (_label, overrides) => {
        const { result, calls, provenanceExists } = runInstallBlock(
          extractRunBlock(
            DOCKERFILE,
            "# OPENCLAW_VERSION is the NemoClaw runtime build target",
            "# Patch OpenClaw media fetch",
          ),
          {
            openclawVersion: PINNED_OPENCLAW_VERSION,
            installedOpenClawVersion: PINNED_OPENCLAW_VERSION,
            committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
            registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
            ...overrides,
          },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("lacks matching reviewed provenance");
        expect(calls).toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.integrity`);
        expect(calls).toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.tarball`);
        expect(calls).not.toContain(`npm pack ${PINNED_OPENCLAW_TARBALL} --pack-destination`);
        expect(calls).toMatch(/npm --prefix \S+\/openclaw-runtime ci /u);
        expect(calls).toContain("--verify-installed-lock");
        expect(calls).toContain("postinstall-bundled-plugins.mjs");
        expect(result.stdout).not.toContain("Reusing reviewed base");
        expect(result.stdout).toContain(
          `Installing locked mcporter ${PINNED_MCPORTER_VERSION} dependency graph`,
        );
        expect(calls).toMatch(/npm --prefix \S+\/mcporter-runtime ci /u);
        expect(provenanceExists).toBe(false);
      });

      it("keeps a newer unreviewed base fail-closed even when its marker claims the target", () => {
        const { result, calls, provenanceExists } = runInstallBlock(
          extractRunBlock(
            DOCKERFILE,
            "# OPENCLAW_VERSION is the NemoClaw runtime build target",
            "# Patch OpenClaw media fetch",
          ),
          {
            openclawVersion: PINNED_OPENCLAW_VERSION,
            installedOpenClawVersion: UNPINNED_OPENCLAW_VERSION,
            committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
            registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
            baseProvenance: openClawBaseProvenance(),
          },
        );

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
          `Base image has OpenClaw ${UNPINNED_OPENCLAW_VERSION}, which is newer than reviewed target ${PINNED_OPENCLAW_VERSION}`,
        );
        expect(calls).not.toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.integrity`);
        expect(calls).not.toContain(`npm pack ${PINNED_OPENCLAW_TARBALL} --pack-destination`);
        expect(provenanceExists).toBe(false);
      });

      it("rejects malformed OpenClaw version output before archive work", () => {
        const { result, calls } = runInstallBlock(
          extractRunBlock(
            DOCKERFILE,
            "# OPENCLAW_VERSION is the NemoClaw runtime build target",
            "# Patch OpenClaw media fetch",
          ),
          {
            openclawVersion: PINNED_OPENCLAW_VERSION,
            installedOpenClawVersion: PINNED_OPENCLAW_VERSION,
            installedOpenClawVersionPrefix: "OpenClaw development build",
            includeInstalledOpenClawVersion: false,
            committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
            registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
            baseProvenance: openClawBaseProvenance(),
          },
        );

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
          "Could not parse OpenClaw version output",
        );
        expect(calls).not.toContain("npm pack");
        expect(calls).not.toContain("npm install");
      });

      it("rejects a failed OpenClaw version command before archive work", () => {
        const { result, calls } = runInstallBlock(
          extractRunBlock(
            DOCKERFILE,
            "# OPENCLAW_VERSION is the NemoClaw runtime build target",
            "# Patch OpenClaw media fetch",
          ),
          {
            openclawVersion: PINNED_OPENCLAW_VERSION,
            installedOpenClawVersion: PINNED_OPENCLAW_VERSION,
            openclawVersionCommandStatus: 1,
            committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
            registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
            baseProvenance: openClawBaseProvenance(),
          },
        );

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
          "Could not execute openclaw --version",
        );
        expect(calls).not.toContain("npm pack");
        expect(calls).not.toContain("npm install");
      });

      it("rejects npm pack filenames outside the fresh pack directories", () => {
        const base = runInstallBlock(
          extractRunBlock(
            DOCKERFILE_BASE,
            "# Install OpenClaw CLI + PyYAML.",
            "# Baseline health check.",
          ),
          {
            openclawVersion: LEGACY_GATEWAY_UPGRADE_OPENCLAW_VERSION,
            committedIntegrity: LEGACY_GATEWAY_UPGRADE_OPENCLAW_INTEGRITY,
            registryIntegrity: LEGACY_GATEWAY_UPGRADE_OPENCLAW_INTEGRITY,
            registryTarball: LEGACY_GATEWAY_UPGRADE_OPENCLAW_TARBALL,
            packIntegrity: LEGACY_GATEWAY_UPGRADE_OPENCLAW_INTEGRITY,
            allowLegacyFixture: true,
            packFilename: "../openclaw-2026.4.24.tgz",
          },
        );
        const optionalPlugin = runOptionalOpenClawPluginBlock({
          pluginPackFilename: "../diagnostics-otel-2026.7.1.tgz",
        });

        for (const item of [
          {
            label: "base Dockerfile",
            outcome: base,
            unsafeFilename: "../openclaw-2026.4.24.tgz",
            blockedCommand: "npm install -g",
          },
          {
            label: "optional OpenClaw plugin Dockerfile",
            outcome: optionalPlugin,
            unsafeFilename: "../diagnostics-otel-2026.7.1.tgz",
            blockedCommand: "openclaw plugins install",
          },
        ]) {
          expect(item.outcome.result.status, item.label).not.toBe(0);
          expect(
            `${item.outcome.result.stdout}${item.outcome.result.stderr}`,
            item.label,
          ).toContain(`reported unsafe archive filename: ${item.unsafeFilename}`);
          expect(item.outcome.calls, item.label).toContain("npm pack");
          expect(item.outcome.calls, item.label).not.toContain(item.blockedCommand);
        }
      });

      it("reports missing base-image npm pack filenames on stderr", () => {
        const { result, calls } = runInstallBlock(
          extractRunBlock(
            DOCKERFILE_BASE,
            "# Install OpenClaw CLI + PyYAML.",
            "# Baseline health check.",
          ),
          {
            openclawVersion: LEGACY_GATEWAY_UPGRADE_OPENCLAW_VERSION,
            committedIntegrity: LEGACY_GATEWAY_UPGRADE_OPENCLAW_INTEGRITY,
            registryIntegrity: LEGACY_GATEWAY_UPGRADE_OPENCLAW_INTEGRITY,
            registryTarball: LEGACY_GATEWAY_UPGRADE_OPENCLAW_TARBALL,
            packIntegrity: LEGACY_GATEWAY_UPGRADE_OPENCLAW_INTEGRITY,
            allowLegacyFixture: true,
            packFilename: null,
          },
        );
        const diagnostic = `npm pack openclaw@${LEGACY_GATEWAY_UPGRADE_OPENCLAW_VERSION} did not report filename and integrity`;

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(diagnostic);
        expect(result.stdout).not.toContain(diagnostic);
        expect(calls).toContain(
          `npm pack ${LEGACY_GATEWAY_UPGRADE_OPENCLAW_TARBALL} --pack-destination`,
        );
        expect(calls).not.toContain("npm install -g");
      });
    }

    if (group === "contract") {
      it("rejects legacy fixture pins unless stale-upgrade fixture mode is explicit", () => {
        const production = runInstallBlock(
          extractRunBlock(
            DOCKERFILE,
            "# OPENCLAW_VERSION is the NemoClaw runtime build target",
            "# Patch OpenClaw media fetch",
          ),
          {
            openclawVersion: LEGACY_REBUILD_OPENCLAW_VERSION,
            registryIntegrity: LEGACY_REBUILD_OPENCLAW_INTEGRITY,
            registryTarball: LEGACY_REBUILD_OPENCLAW_TARBALL,
            packIntegrity: LEGACY_REBUILD_OPENCLAW_INTEGRITY,
          },
        );
        const base = runInstallBlock(
          extractRunBlock(
            DOCKERFILE_BASE,
            "# Install OpenClaw CLI + PyYAML.",
            "# Baseline health check.",
          ),
          {
            openclawVersion: LEGACY_REBUILD_OPENCLAW_VERSION,
            registryIntegrity: LEGACY_REBUILD_OPENCLAW_INTEGRITY,
            registryTarball: LEGACY_REBUILD_OPENCLAW_TARBALL,
            packIntegrity: LEGACY_REBUILD_OPENCLAW_INTEGRITY,
          },
        );
        const fixtureBase = runInstallBlock(
          extractRunBlock(
            DOCKERFILE_BASE,
            "# Install OpenClaw CLI + PyYAML.",
            "# Baseline health check.",
          ),
          {
            openclawVersion: LEGACY_REBUILD_OPENCLAW_VERSION,
            registryIntegrity: LEGACY_REBUILD_OPENCLAW_INTEGRITY,
            registryTarball: LEGACY_REBUILD_OPENCLAW_TARBALL,
            packIntegrity: LEGACY_REBUILD_OPENCLAW_INTEGRITY,
            allowLegacyFixture: true,
          },
        );
        const gatewayFixtureBase = runInstallBlock(
          extractRunBlock(
            DOCKERFILE_BASE,
            "# Install OpenClaw CLI + PyYAML.",
            "# Baseline health check.",
          ),
          {
            openclawVersion: LEGACY_GATEWAY_UPGRADE_OPENCLAW_VERSION,
            registryIntegrity: LEGACY_GATEWAY_UPGRADE_OPENCLAW_INTEGRITY,
            registryTarball: LEGACY_GATEWAY_UPGRADE_OPENCLAW_TARBALL,
            packIntegrity: LEGACY_GATEWAY_UPGRADE_OPENCLAW_INTEGRITY,
            allowLegacyFixture: true,
          },
        );

        for (const rejected of [production, base]) {
          expect(rejected.result.status).not.toBe(0);
          expect(`${rejected.result.stdout}${rejected.result.stderr}`).toContain(
            `OpenClaw ${LEGACY_REBUILD_OPENCLAW_VERSION} is a legacy E2E fixture pin`,
          );
          expect(rejected.calls).not.toContain("npm install -g");
        }
        expect(fixtureBase.result.status).toBe(0);
        expect(fixtureBase.calls).toContain(
          `npm view openclaw@${LEGACY_REBUILD_OPENCLAW_VERSION} version`,
        );
        expect(fixtureBase.calls).toContain(
          `npm view openclaw@${LEGACY_REBUILD_OPENCLAW_VERSION} dist.integrity`,
        );
        expect(fixtureBase.calls).toContain(
          `npm view openclaw@${LEGACY_REBUILD_OPENCLAW_VERSION} dist.tarball`,
        );
        expect(fixtureBase.calls).toContain(
          `npm pack ${LEGACY_REBUILD_OPENCLAW_TARBALL} --pack-destination`,
        );
        expect(fixtureBase.calls).toContain(`openclaw-${LEGACY_REBUILD_OPENCLAW_VERSION}.tgz`);
        expect(fixtureBase.calls).toContain("npm install -g --ignore-scripts ");
        expect(fixtureBase.calls).toContain("openclaw-remediated.tgz");
        expect(fixtureBase.calls).not.toContain('"archivePath"');
        expect(fixtureBase.calls).toMatch(
          /npm install -g --ignore-scripts \S+\/openclaw-remediated\.tgz/u,
        );
        expect(fixtureBase.calls).not.toContain("postinstall-bundled-plugins.mjs");
        expect(gatewayFixtureBase.result.status).toBe(0);
        expect(gatewayFixtureBase.calls).toContain("npm install -g --ignore-scripts ");
        expect(gatewayFixtureBase.calls).toContain("postinstall-bundled-plugins.mjs");
      });

      it("guards production Docker build args from legacy OpenClaw fixture inputs", () => {
        expect(runProductionBuildArgGuard(["--build-arg", "BASE_IMAGE=base"]).status).toBe(0);
        expect(
          runProductionBuildArgGuard(["--build-arg=NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=0"]).status,
        ).toBe(0);
        expect(
          runProductionBuildArgGuard(["--build-arg", `OPENCLAW_VERSION=${PINNED_OPENCLAW_VERSION}`])
            .status,
        ).toBe(0);

        for (const args of [
          ["--build-arg", "NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1"],
          ["--build-arg=NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1"],
          ["NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1"],
        ]) {
          const result = runProductionBuildArgGuard(args);
          expect(result.status, args.join(" ")).toBe(1);
          expect(result.stderr).toContain(
            "only allowed in explicit stale-upgrade E2E fixture builds",
          );
        }

        const envResult = runProductionBuildArgGuard([], {
          NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW: "1",
        });
        expect(envResult.status).toBe(1);
        expect(envResult.stderr).toContain("production Docker image build args");

        for (const args of [
          ["--build-arg", `OPENCLAW_VERSION=${LEGACY_REBUILD_OPENCLAW_VERSION}`],
          ["--build-arg=OPENCLAW_VERSION=2026.4.24"],
          ["OPENCLAW_2026_3_11_INTEGRITY=sha512-fixture"],
          ["--build-arg=OPENCLAW_2026_4_24_TARBALL=https://fixture.invalid/package.tgz"],
        ]) {
          const result = runProductionBuildArgGuard(args);
          expect(result.status, args.join(" ")).toBe(1);
          expect(result.stderr).toContain("not allowed in production image builds");
        }

        const legacyEnvCases: ReadonlyArray<Record<string, string>> = [
          { OPENCLAW_VERSION: LEGACY_REBUILD_OPENCLAW_VERSION },
          { OPENCLAW_VERSION: "2026.4.24" },
          { OPENCLAW_2026_3_11_TARBALL: LEGACY_REBUILD_OPENCLAW_TARBALL },
          { OPENCLAW_2026_4_24_INTEGRITY: LEGACY_GATEWAY_UPGRADE_OPENCLAW_INTEGRITY },
        ];
        for (const env of legacyEnvCases) {
          const result = runProductionBuildArgGuard([], env);
          expect(result.status, JSON.stringify(env)).toBe(1);
          expect(result.stderr).toContain("not allowed in production image builds");
        }

        for (const args of [
          [
            "--build-arg",
            `OPENCLAW_VERSION=${PINNED_OPENCLAW_VERSION}\nNEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1\nOPENCLAW_VERSION=2026.4.24`,
          ],
          [`--build-arg=OPENCLAW_VERSION=${PINNED_OPENCLAW_VERSION}\r`],
          ["BASE_IMAGE=base\nINJECTED=value"],
          ["--build-arg\r"],
        ]) {
          const result = runProductionBuildArgGuard(args);
          expect(result.status, JSON.stringify(args)).toBe(1);
          expect(result.stderr).toContain("must not contain CR or LF characters");
        }
      });

      it("production build arg guard rejects current reviewed pin overrides", () => {
        const currentPinArgNames = declaredProductionPinArgNames();
        expect(currentPinArgNames).toEqual([
          "CODEX_ACP_0_11_1_INTEGRITY",
          "CODEX_ACP_LINUX_AMD64_0_11_1_INTEGRITY",
          "CODEX_ACP_LINUX_ARM64_0_11_1_INTEGRITY",
          "HERMES_NPM_INTEGRITY",
          "MCPORTER_0_7_3_INTEGRITY",
          "MCPORTER_0_7_3_TARBALL",
          "OPENCLAW_2026_3_11_INTEGRITY",
          "OPENCLAW_2026_3_11_TARBALL",
          "OPENCLAW_2026_4_24_INTEGRITY",
          "OPENCLAW_2026_4_24_TARBALL",
          "OPENCLAW_2026_7_1_INTEGRITY",
          "OPENCLAW_2026_7_1_TARBALL",
          "OPENCLAW_BRAVE_PLUGIN_2026_7_1_INTEGRITY",
          "OPENCLAW_DIAGNOSTICS_OTEL_2026_7_1_INTEGRITY",
        ]);

        const futurePinArgNames = [
          "OPENCLAW_FUTURE_PLUGIN_2099_1_1_INTEGRITY",
          "FUTURE_DEPENDENCY_2099_1_1_TARBALL",
        ];
        for (const pinArgName of [...currentPinArgNames, ...futurePinArgNames]) {
          for (const args of [
            [`${pinArgName}=attacker-controlled`],
            [`--build-arg=${pinArgName}=attacker-controlled`],
            ["--build-arg", `${pinArgName}=attacker-controlled`],
            ["--build-arg", pinArgName],
          ]) {
            const result = runProductionBuildArgGuard(args);
            expect(result.status, args.join(" ")).toBe(1);
            expect(result.stderr).toContain("pin overrides are not allowed");
          }
        }

        for (const pinArgName of currentPinArgNames) {
          const envResult = runProductionBuildArgGuard([], { [pinArgName]: "attacker-controlled" });
          expect(envResult.status, pinArgName).toBe(1);
          expect(envResult.stderr).toContain("pin overrides are not allowed");
        }

        expect(runProductionBuildArgGuard([], { RELEASE_INTEGRITY: "verified" }).status).toBe(0);
        expect(runProductionBuildArgGuard([], { SOURCE_TARBALL: "source.tgz" }).status).toBe(0);
      });
    }

    if (group === "plugin-install") {
      it("fails closed before npm install when the registry integrity drifts", () => {
        const installBlocks = [
          {
            label: "production Dockerfile",
            file: DOCKERFILE,
            startMarker: "# OPENCLAW_VERSION is the NemoClaw runtime build target",
            endMarker: "# Patch OpenClaw media fetch",
          },
          {
            label: "base Dockerfile",
            file: DOCKERFILE_BASE,
            startMarker: "# Install OpenClaw CLI + PyYAML.",
            endMarker: "# Baseline health check.",
          },
        ];

        for (const block of installBlocks) {
          const { result, calls } = runInstallBlock(
            extractRunBlock(block.file, block.startMarker, block.endMarker),
            {
              openclawVersion: PINNED_OPENCLAW_VERSION,
              committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
              registryIntegrity: "sha512-registry-drift",
            },
          );
          const output = `${result.stdout}${result.stderr}`;

          expect(result.status, block.label).not.toBe(0);
          expect(output, block.label).toContain(
            `OpenClaw ${PINNED_OPENCLAW_VERSION} npm integrity mismatch`,
          );
          expect(output, block.label).toContain(`Expected: ${PINNED_OPENCLAW_INTEGRITY}`);
          expect(output, block.label).toContain("Actual:   sha512-registry-drift");
          expect(calls, block.label).toContain(
            `npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.integrity`,
          );
          expect(calls, block.label).not.toContain("npm install -g");
        }
      });

      it("leaves no runtime exposure when npm ci rejects downloaded OpenClaw bytes", () => {
        const outcome = runInstallBlock(
          extractRunBlock(
            DOCKERFILE,
            "# OPENCLAW_VERSION is the NemoClaw runtime build target",
            "# Patch OpenClaw media fetch",
          ),
          {
            openclawVersion: PINNED_OPENCLAW_VERSION,
            committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
            registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
            failOpenClawNpmCi: true,
          },
        );

        expect(outcome.result.status).not.toBe(0);
        expect(outcome.calls).toMatch(/npm --prefix \S+\/openclaw-runtime ci /u);
        expect(outcome.calls).not.toContain("postinstall-bundled-plugins.mjs");
        expect(outcome.runtimeExposed).toBe(false);
        expect(outcome.provenanceExists).toBe(false);
      });

      it("leaves no runtime exposure when installed-lock verification fails", () => {
        const installBlocks = [
          {
            label: "production Dockerfile",
            file: DOCKERFILE,
            startMarker: "# OPENCLAW_VERSION is the NemoClaw runtime build target",
            endMarker: "# Patch OpenClaw media fetch",
          },
          {
            label: "base Dockerfile",
            file: DOCKERFILE_BASE,
            startMarker: "# Install OpenClaw CLI + PyYAML.",
            endMarker: "# Baseline health check.",
          },
        ];

        for (const block of installBlocks) {
          const outcome = runInstallBlock(
            extractRunBlock(block.file, block.startMarker, block.endMarker),
            {
              openclawVersion: PINNED_OPENCLAW_VERSION,
              committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
              registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
              failOpenClawVerifyInstalledLock: true,
            },
          );

          expect(outcome.result.status, block.label).not.toBe(0);
          expect(outcome.calls, block.label).toContain("--verify-installed-lock");
          expect(outcome.calls, block.label).not.toContain("postinstall-bundled-plugins.mjs");
          expect(outcome.runtimeExposed, block.label).toBe(false);
          expect(outcome.provenanceExists, block.label).toBe(false);
        }
      });

      it("fails closed before npm install for unpinned production Dockerfile overrides", () => {
        const { result, calls } = runInstallBlock(
          extractRunBlock(
            DOCKERFILE,
            "# OPENCLAW_VERSION is the NemoClaw runtime build target",
            "# Patch OpenClaw media fetch",
          ),
        );

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
          `OpenClaw ${UNPINNED_OPENCLAW_VERSION} has no committed npm integrity pin`,
        );
        expect(calls).not.toContain("npm install -g");
      });

      it("keeps codex-acp checksum-sourced, SRI-verified, multiarch, and offline", () => {
        const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
        const block = dockerfile.slice(
          dockerfile.indexOf("FROM scratch AS codex-acp-common-archive"),
          dockerfile.indexOf("FROM node:22-trixie-slim", dockerfile.indexOf("AS wechat-npm-cache")),
        );

        expect(block).toContain(
          `ADD --checksum=sha256:b287fe7bce0dc0b3d0c69400ab7d47567680439628ad22a89f0557cc736d64b8 ${PINNED_CODEX_ACP_TARBALL} /codex-acp.tgz`,
        );
        expect(block).toContain("AS codex-acp-amd64-archive");
        expect(block).toContain("AS codex-acp-arm64-archive");
        expect(block).toContain(
          "FROM codex-acp-${TARGETARCH}-archive AS codex-acp-platform-archive",
        );
        expect(dockerfile).toContain(
          `ARG CODEX_ACP_0_11_1_INTEGRITY=${PINNED_CODEX_ACP_INTEGRITY}`,
        );
        expect(dockerfile).toContain("ARG CODEX_ACP_LINUX_AMD64_0_11_1_INTEGRITY=sha512-");
        expect(dockerfile).toContain("ARG CODEX_ACP_LINUX_ARM64_0_11_1_INTEGRITY=sha512-");
        expect(block).toContain("actual!==process.argv[2]");
        expect(block).toContain("RUN --network=none");
        expect(block).toContain(
          "npm install -g --offline --no-audit --no-fund --no-progress --ignore-scripts",
        );
        expect(block).not.toContain("npm view");
        expect(block).not.toContain("npm pack");
      });

      it("keeps optional OpenClaw plugins checksum-sourced, SRI-verified, and offline", () => {
        const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
        const archiveBlock = dockerfile.slice(
          dockerfile.indexOf("FROM scratch AS openclaw-optional-plugin-archives"),
          dockerfile.indexOf("FROM codex-acp-${TARGETARCH}-archive"),
        );
        const installBlock = extractRunBlock(
          DOCKERFILE,
          "# Install non-messaging OpenClaw plugins that need to match the runtime.",
          "# The reviewed cache stays root-owned and immutable to the sandbox user.",
        );
        const installSource = dockerfile.slice(
          dockerfile.indexOf(
            "# Install non-messaging OpenClaw plugins that need to match the runtime.",
          ),
          dockerfile.indexOf(
            "# The reviewed cache stays root-owned and immutable to the sandbox user.",
          ),
        );
        const remediation = fs.readFileSync(
          path.join(REPO_ROOT, "scripts", "lib", "openclaw-npm-remediation.mts"),
          "utf-8",
        );

        expect(archiveBlock).toContain(
          "ADD --chmod=0444 --checksum=sha256:a447a223cf4764865570e71e92fb5173bf79a3d8307dd99382eb56ea6aff93f6",
        );
        expect(archiveBlock).toContain(
          "ADD --chmod=0444 --checksum=sha256:f5198ea18ea0adebc376c669b8e5e1100781f07ec2d9e24e86c90cb82acb039c",
        );
        expect(archiveBlock).toContain(
          "ADD --chmod=0444 --checksum=sha256:2ed6796c07bb15b8d98ff7ae178b94327d570dcbc9a99a81f3e12ecf938ded61",
        );
        expect(archiveBlock).toContain(
          "ADD --chmod=0444 --checksum=sha256:b1b01eb1522aea8f652cc7b692d1c417195713deb12b348955e3ac8d608fc9ab",
        );
        expect(installSource).toContain("RUN --network=none");
        expect(installSource).toContain("--mount=from=openclaw-optional-plugin-archives");
        expect(installBlock).toContain(
          "export NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR=/opt/nemoclaw-reviewed-npm-archives",
        );
        expect(installBlock).toContain('actual="sha512-"+crypto.createHash("sha512")');
        expect(installBlock).toContain(
          'plugin_work_root="$(mktemp -d /tmp/nemoclaw-openclaw-plugin.XXXXXX)"',
        );
        expect(installBlock).toContain('--working-directory "$plugin_work_root"');
        expect(installBlock).toContain('rm -rf "$plugin_work_root"');
        expect(installBlock).not.toContain('--working-directory "$plugin_source_root"');
        expect(remediation).toContain("NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR");
        expect(remediation).toContain("constants.O_RDONLY | constants.O_NOFOLLOW");
        expect(remediation).toContain("actualIntegrity !== expectedIntegrity");
      });

      it("fails closed before npm install for unpinned base Dockerfile overrides", () => {
        const { result, calls } = runInstallBlock(
          extractRunBlock(
            DOCKERFILE_BASE,
            "# Install OpenClaw CLI + PyYAML.",
            "# Baseline health check.",
          ),
        );

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain(
          `OpenClaw ${UNPINNED_OPENCLAW_VERSION} has no committed npm integrity pin`,
        );
        expect(calls).not.toContain("npm install -g");
      });
    }
  });
}
