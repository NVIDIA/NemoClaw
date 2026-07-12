// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBuiltInChannelManifestRegistry } from "../src/lib/messaging";
import { reviewedOpenClawPluginIntegrityByPackageSpec } from "../src/lib/messaging/applier/build/messaging-build-applier.mts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
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
  "docs",
  "security",
  "openclaw-2026.6.10-dependency-review.md",
);
const PRODUCTION_BUILD_ARG_GUARD = path.join(
  REPO_ROOT,
  "scripts",
  "check-production-build-args.sh",
);
const UNPINNED_OPENCLAW_VERSION = "2026.6.11";
const PINNED_OPENCLAW_VERSION = "2026.6.10";
const PINNED_OPENCLAW_INTEGRITY =
  "sha512-LcooND2tBQw8A+kc1Ujltu3lg30bJ0w7XaeRy7eYzobb8BBdcW6DOGbwJL4vpj1vl9+gjRceOtlh5nh9OARcug==";
const PINNED_OPENCLAW_TARBALL = "https://registry.npmjs.org/openclaw/-/openclaw-2026.6.10.tgz";
const PINNED_CODEX_ACP_VERSION = "0.11.1";
const PINNED_CODEX_ACP_TARBALL =
  "https://registry.npmjs.org/@zed-industries/codex-acp/-/codex-acp-0.11.1.tgz";
const PINNED_CODEX_ACP_INTEGRITY =
  "sha512-My2VSlBtvJipJhImHjFDej2ut/p00QqOISRnZgLgLrSIzjgvdcQvAhaZviWj7XPhk4UIdIb0OoA+Lrls824uiQ==";
const PINNED_MCPORTER_VERSION = "0.7.3";
const PINNED_MCPORTER_INTEGRITY =
  "sha512-egoPVYqTnWb3NjRIxo+xc8OrAI0dlPrJm9pAiZx0pImuNIV5rKhGtTnIfH/Y1ldGPVu74ibj3KR5c9U/QSdQFA==";
const MCPORTER_LOCKFILE = path.join(
  REPO_ROOT,
  "agents",
  "openclaw",
  "mcporter-runtime",
  "package-lock.json",
);
const PINNED_MCPORTER_LOCK_SHA256 = createHash("sha256")
  .update(fs.readFileSync(MCPORTER_LOCKFILE))
  .digest("hex");
const PINNED_OPENCLAW_DIAGNOSTICS_OTEL_INTEGRITY =
  "sha512-EJt0fjk4bcR3N/9u00f1pL0BJYG5yfC09DV3l6rWDmytpE2vUeBZWpx4pOmFDreGV+7DKxhCbQDgDAmvZGjLag==";
const PINNED_OPENCLAW_DIAGNOSTICS_OTEL_TARBALL =
  "https://registry.npmjs.org/@openclaw/diagnostics-otel/-/diagnostics-otel-2026.6.10.tgz";
const PINNED_OPENCLAW_BRAVE_PLUGIN_INTEGRITY =
  "sha512-DDRnb4reL99O8kbISNbRFyk/xoUPYHsXG3UGikKAsVs+zIldYYA0hY0d3Z2aWoE+0vfda27mJUByCo7Xr15qdw==";
const PINNED_OPENCLAW_BRAVE_PLUGIN_TARBALL =
  "https://registry.npmjs.org/@openclaw/brave-plugin/-/brave-plugin-2026.6.10.tgz";
const PINNED_OPENCLAW_DISCORD_INTEGRITY =
  "sha512-NKp/j00l+rk5PC0Lv/0fOIiiQJ1c/OpG9471zqXUDKQie6pQ1Fi9KUZUouyoTMmfLh/n4S0CkEMqrON40eBKXA==";
const PINNED_OPENCLAW_SLACK_INTEGRITY =
  "sha512-OOsMLjPcbWhQRM5XDwfdrACjJmKqavFtpuIlhHAXWrLrd/p7SyIVE9AoKS0yxOx6bqGDIMJ9+knzdViHMLgBdA==";
const PINNED_OPENCLAW_WHATSAPP_INTEGRITY =
  "sha512-k/XrRdZY77SHrdaRwJOEB7/JRbjp4yVgGD/ZNyakjTMqo32XRVtwPBUnj7726rW8Kl5yyOMQQLKFiD9MDfhmPQ==";
const PINNED_OPENCLAW_MSTEAMS_INTEGRITY =
  "sha512-GjHnCPvjbnI0C7mEFcdT2uKDH4/WwOe2dZBfQiWxBtkE76m6TNG0J9dJjD4mc8/pk8rXSO0cWw+KV9jzWtF9VA==";
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
): string {
  return [
    "schema=2",
    `package=openclaw@${version}`,
    `integrity=${integrity}`,
    `tarball=${tarball}`,
    "recipe=ignore-scripts+reviewed-lifecycle-v1",
    `mcporter-package=mcporter@${PINNED_MCPORTER_VERSION}`,
    `mcporter-integrity=${PINNED_MCPORTER_INTEGRITY}`,
    `mcporter-lock-sha256=${PINNED_MCPORTER_LOCK_SHA256}`,
    "mcporter-recipe=locked-ci+audit-signatures-v1",
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
    .replace(/^RUN\s+--mount=[^\n]+\\\n\s*/, "")
    .replace(/^RUN\s+/, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ")
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
    installedMcporterVersion?: string;
    baseImage?: string;
    baseProvenance?: string | null;
    baseProvenanceMetadata?: string;
    baseProvenanceSymlink?: boolean;
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
    installedMcporterVersion = PINNED_MCPORTER_VERSION,
    baseImage = "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    baseProvenance = null,
    baseProvenanceMetadata = "0:0:444",
    baseProvenanceSymlink = false,
  } = options;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-integrity-"));
  const blueprint = path.join(tmp, "blueprint.yaml");
  const log = path.join(tmp, "calls.log");
  const provenancePath = path.join(tmp, "openclaw-base-provenance-v1");
  const mcporterRuntime = path.join(tmp, "mcporter-runtime");
  const mcporterBin = path.join(tmp, "bin", "mcporter");
  fs.mkdirSync(path.dirname(mcporterBin), { recursive: true });
  fs.mkdirSync(mcporterRuntime, { recursive: true });
  fs.copyFileSync(MCPORTER_LOCKFILE, path.join(mcporterRuntime, "package-lock.json"));
  fs.writeFileSync(blueprint, fs.readFileSync(BLUEPRINT, "utf-8"));
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
    `OPENCLAW_2026_6_10_INTEGRITY=${JSON.stringify(committedIntegrity)}`,
    `OPENCLAW_2026_6_10_TARBALL=${JSON.stringify(PINNED_OPENCLAW_TARBALL)}`,
    `NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=${allowLegacyFixture ? "1" : "0"}`,
    `OPENCLAW_2026_3_11_INTEGRITY=${JSON.stringify(LEGACY_REBUILD_OPENCLAW_INTEGRITY)}`,
    `OPENCLAW_2026_3_11_TARBALL=${JSON.stringify(LEGACY_REBUILD_OPENCLAW_TARBALL)}`,
    `OPENCLAW_2026_4_24_INTEGRITY=${JSON.stringify(LEGACY_GATEWAY_UPGRADE_OPENCLAW_INTEGRITY)}`,
    `OPENCLAW_2026_4_24_TARBALL=${JSON.stringify(LEGACY_GATEWAY_UPGRADE_OPENCLAW_TARBALL)}`,
    `CODEX_ACP_0_11_1_INTEGRITY=${JSON.stringify(codexAcpCommittedIntegrity)}`,
    `MCPORTER_VERSION=${JSON.stringify(PINNED_MCPORTER_VERSION)}`,
    `MCPORTER_0_7_3_INTEGRITY=${JSON.stringify(PINNED_MCPORTER_INTEGRITY)}`,
    `installed_openclaw_version=${JSON.stringify(installedOpenClawVersion)}`,
    `installed_mcporter_version=${JSON.stringify(installedMcporterVersion)}`,
    "node() {",
    '  if [ "${1:-}" = "/usr/local/lib/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs" ]; then printf "node %s\\n" "$*" >> "$call_log"; return 0; fi',
    '  "$real_node" "$@"',
    "}",
    `openclaw() { if [ "\${1:-}" = "--version" ]; then printf 'openclaw %s\\n' "$installed_openclaw_version"; else return 127; fi; }`,
    'mcporter() { if [ "${1:-}" = "--version" ]; then printf "%s\\n" "$installed_mcporter_version"; else return 127; fi; }',
    "codex-acp() { :; }",
    "stat() {",
    '  if [ "${1:-}" = "-c" ] && [ "${3:-}" = "$openclaw_provenance_path" ]; then printf "%s\\n" "$openclaw_provenance_metadata"; return 0; fi',
    '  command stat "$@"',
    "}",
    "npm() {",
    '  printf "npm %s\\n" "$*" >> "$call_log";',
    '  [ "${1:-}" != "--prefix" ] || [ "${3:-}" != "ci" ] || installed_mcporter_version="$MCPORTER_VERSION"',
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
      .replaceAll("/usr/local/lib/nemoclaw/mcporter-runtime", mcporterRuntime)
      .replaceAll("/usr/local/bin/mcporter", mcporterBin),
  ].join("\n");
  const scriptPath = path.join(tmp, "run.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 10000 });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "";
  const provenanceExists = fs.existsSync(provenancePath);
  const provenanceContent = provenanceExists ? fs.readFileSync(provenancePath, "utf-8") : null;
  const provenanceMode = provenanceExists ? fs.statSync(provenancePath).mode & 0o777 : null;
  fs.rmSync(tmp, { recursive: true, force: true });
  return { result, calls, provenanceExists, provenanceContent, provenanceMode };
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
    'RUN OPENCLAW_VERSION="${OPENCLAW_VERSION}" node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts',
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-plugin-integrity-"));
  const log = path.join(tmp, "calls.log");
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(log)}`,
    `OPENCLAW_VERSION=${JSON.stringify(openclawVersion)}`,
    `OPENCLAW_DIAGNOSTICS_OTEL_2026_6_10_INTEGRITY=${JSON.stringify(PINNED_OPENCLAW_DIAGNOSTICS_OTEL_INTEGRITY)}`,
    `OPENCLAW_BRAVE_PLUGIN_2026_6_10_INTEGRITY=${JSON.stringify(PINNED_OPENCLAW_BRAVE_PLUGIN_INTEGRITY)}`,
    `NEMOCLAW_OPENCLAW_OTEL=${otel ? "1" : "0"}`,
    `NEMOCLAW_WEB_SEARCH_ENABLED=${webSearch ? "1" : "0"}`,
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
    command,
  ].join("\n");
  const scriptPath = path.join(tmp, "run.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 10000 });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "";
  fs.rmSync(tmp, { recursive: true, force: true });
  return { result, calls };
}

describe("OpenClaw npm integrity pins", () => {
  it("keeps the advisory review note aligned with the committed OpenClaw pin", () => {
    const reviewNote = fs.readFileSync(DEPENDENCY_REVIEW_NOTE, "utf-8");

    expect(reviewNote).toContain(`openclaw@${PINNED_OPENCLAW_VERSION}`);
    expect(reviewNote).toContain(PINNED_OPENCLAW_INTEGRITY);
    expect(reviewNote).toContain(PINNED_OPENCLAW_TARBALL);
    expect(reviewNote).toContain(`@zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION}`);
    expect(reviewNote).toContain(PINNED_CODEX_ACP_TARBALL);
    expect(reviewNote).toContain(PINNED_CODEX_ACP_INTEGRITY);
    expect(reviewNote).toContain("@openclaw/diagnostics-otel@2026.6.10");
    expect(reviewNote).toContain(PINNED_OPENCLAW_DIAGNOSTICS_OTEL_INTEGRITY);
    expect(reviewNote).toContain("@openclaw/brave-plugin@2026.6.10");
    expect(reviewNote).toContain(PINNED_OPENCLAW_BRAVE_PLUGIN_INTEGRITY);
    expect(reviewNote).toContain("@openclaw/discord@2026.6.10");
    expect(reviewNote).toContain(PINNED_OPENCLAW_DISCORD_INTEGRITY);
    expect(reviewNote).toContain("@openclaw/slack@2026.6.10");
    expect(reviewNote).toContain(PINNED_OPENCLAW_SLACK_INTEGRITY);
    expect(reviewNote).toContain("@openclaw/whatsapp@2026.6.10");
    expect(reviewNote).toContain(PINNED_OPENCLAW_WHATSAPP_INTEGRITY);
    expect(reviewNote).toContain("@openclaw/msteams@2026.6.10");
    expect(reviewNote).toContain(PINNED_OPENCLAW_MSTEAMS_INTEGRITY);
    expect(reviewNote).toContain("@tencent-weixin/openclaw-weixin@2.4.3");
    expect(reviewNote).toContain(PINNED_WECHAT_PLUGIN_INTEGRITY);
    expect(reviewNote).toContain("downloaded tarball integrity");
    expect(reviewNote).toContain("bind reviewed npm installs to verified local archives");
    expect(reviewNote).toContain("npm pack --json");
    expect(reviewNote).toContain("reject reported archive filenames");
    expect(reviewNote).toContain("unsafe reported archive filenames");
    expect(reviewNote).toContain("each reviewed npm plugin registry integrity");
    expect(reviewNote).toContain("install the verified archive path");
    expect(reviewNote).toContain("OpenClaw Compiled-Dist Patch Runtime Boundary");
    expect(reviewNote).toContain(
      "The long-term source of truth for these behaviors remains upstream OpenClaw",
    );
    expect(reviewNote).toContain("test/openclaw-real-patched-dist-harness.test.ts");
    expect(reviewNote).toContain("NEMOCLAW_REAL_OPENCLAW_DIST_HARNESS=1");
    expect(reviewNote).toContain("not a substitute for focused nightly E2E proof");
    expect(reviewNote).toContain("OpenClaw Diagnostics OTEL Host Gateway Boundary");
    expect(reviewNote).toContain("openclaw-diagnostics-otel-local");
    expect(reviewNote).toContain("imports `OTLPTraceExporter`");
    expect(reviewNote).toContain("contains no `web_fetch`, `fetchWithSsrFGuard`");
    expect(reviewNote).toContain("@openclaw/diagnostics-otel@2026.6.10");
    expect(reviewNote).toContain("@openclaw/brave-plugin@2026.6.10");
    expect(reviewNote).toContain("@tencent-weixin/openclaw-weixin@2.4.3");
    expect(reviewNote).toContain("`0` high");
    expect(reviewNote).toContain("`0` critical");
    expect(reviewNote).toContain("`763` total dependencies");
    expect(reviewNote).toContain(
      "`dist/pipeline.runtime-*.js`, which exports `prepareSlackMessage`",
    );
    expect(reviewNote).toContain("imports the hashed pipeline runtime for `prepareSlackMessage`");
    expect(reviewNote).toContain("only reports `openclaw-pipeline-runtime` after allowed prepare");
    expect(reviewNote).toContain("`dist/extensions/telegram/runtime-api.js`");
    expect(reviewNote).toContain("which exports `sendMessageTelegram`");
    expect(reviewNote).toContain("fails closed if the installed runtime file is missing");
    expect(reviewNote).toContain("NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1");
    expect(reviewNote).toContain("scripts/check-production-build-args.sh");
    expect(reviewNote).toContain("production build args");
    expect(reviewNote).toContain("claiming `openclaw-pipeline-runtime` inbound proof");
    expect(reviewNote).toContain("imports `dist/extensions/telegram/test-api.js`");
    expect(reviewNote).toContain("gateway/upstream reporting layer");
    expect(reviewNote).toContain("scripts/patch-openclaw-issue-4434-diagnostics.ts");
    expect(reviewNote).toContain("scripts/patch-openclaw-device-self-approval.ts");
    expect(reviewNote).toContain("approveDevicePairing");
    expect(reviewNote).toContain(
      "Recovery hint: check sandbox egress and provider reachability, then retry.",
    );
    expect(reviewNote).toContain("default 180-second timeout");
  });

  it("keeps the Teams OpenClaw plugin manifest pinned to the reviewed 2026.6.10 integrity", () => {
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
            agentPackage.integrity ?? agentPackage.integrityByVersion?.[PINNED_OPENCLAW_VERSION];

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

  it.each([
    "latest",
    "^2026.6.10",
  ])("rejects a trusted OpenClaw plugin manifest with non-exact version %s", (version) => {
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
      reviewedOpenClawPluginIntegrityByPackageSpec({ OPENCLAW_VERSION: PINNED_OPENCLAW_VERSION }, [
        nonExactManifest,
      ]),
    ).toThrow(`must use an exact-version OpenClaw plugin package: npm:@openclaw/slack@${version}`);
  });

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
      "npm pack https://registry.npmjs.org/@openclaw/diagnostics-otel/-/diagnostics-otel-2026.6.10.tgz --pack-destination",
    );
    expect(calls).toMatch(
      /openclaw plugins install npm-pack:\S*\/diagnostics-otel-2026\.6\.10\.tgz\n/,
    );
    expect(calls).toContain(
      `npm view @openclaw/brave-plugin@${PINNED_OPENCLAW_VERSION} dist.integrity`,
    );
    expect(calls).toContain(
      `npm view @openclaw/brave-plugin@${PINNED_OPENCLAW_VERSION} dist.tarball`,
    );
    expect(calls).toContain(
      "npm pack https://registry.npmjs.org/@openclaw/brave-plugin/-/brave-plugin-2026.6.10.tgz --pack-destination",
    );
    expect(calls).toMatch(/openclaw plugins install npm-pack:\S*\/brave-plugin-2026\.6\.10\.tgz\n/);
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
      "https://registry.npmjs.org/@openclaw/brave-plugin/-/brave-plugin-2026.6.11.tgz";
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

  it("installs the reviewed pin when registry integrity matches the committed pin", () => {
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
    const codexAcp = runInstallBlock(
      extractRunBlock(
        DOCKERFILE,
        "# Pre-install the codex-acp package",
        "# Upgrade OpenClaw if the base image is stale.",
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
    expect(codexAcp.result.status).toBe(0);
    expect(base.result.status).toBe(0);
    expect(production.calls).toContain(
      `npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.integrity`,
    );
    expect(production.calls).toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.tarball`);
    expect(production.calls).toContain(`npm pack ${PINNED_OPENCLAW_TARBALL} --pack-destination`);
    expect(codexAcp.calls).toContain(
      `npm view @zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION} dist.integrity`,
    );
    expect(codexAcp.calls).toContain(
      `npm view @zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION} dist.tarball`,
    );
    expect(codexAcp.calls).toContain(`npm pack ${PINNED_CODEX_ACP_TARBALL} --pack-destination`);
    expect(production.calls).toContain(
      "npm install -g --no-audit --no-fund --no-progress --ignore-scripts ",
    );
    expect(production.calls).toContain(
      "node /usr/local/lib/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs",
    );
    expect(production.calls).toContain(`openclaw-${PINNED_OPENCLAW_VERSION}.tgz`);
    expect(codexAcp.calls).toContain(
      "npm install -g --no-audit --no-fund --no-progress --ignore-scripts ",
    );
    expect(codexAcp.calls).toContain(`codex-acp-${PINNED_CODEX_ACP_VERSION}.tgz`);
    expect(base.calls).toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} version`);
    expect(base.calls).toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.integrity`);
    expect(base.calls).toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.tarball`);
    expect(base.calls).toContain(`npm pack ${PINNED_OPENCLAW_TARBALL} --pack-destination`);
    expect(base.calls).toContain("npm install -g --ignore-scripts ");
    expect(base.calls).toContain(
      "node /usr/local/lib/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs",
    );
    expect(base.calls).toContain(`openclaw-${PINNED_OPENCLAW_VERSION}.tgz`);
    expect(base.provenanceContent).toBe(openClawBaseProvenance());
    expect(base.provenanceMode).toBe(0o444);
  });

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
        committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
        registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
        baseProvenance: openClawBaseProvenance(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `Reusing reviewed base OpenClaw ${PINNED_OPENCLAW_VERSION} with exact provenance`,
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
      `Reusing reviewed base mcporter ${PINNED_MCPORTER_VERSION} with exact lock provenance`,
    );
    expect(calls).not.toContain(`npm view mcporter@${PINNED_MCPORTER_VERSION} dist.integrity`);
    expect(calls).not.toContain("npm --prefix ");
    expect(provenanceExists).toBe(false);
  });

  it.each([
    ["missing marker", { baseProvenance: null }],
    ["wrong schema", { baseProvenance: openClawBaseProvenance().replace("schema=2", "schema=1") }],
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
          "recipe=ignore-scripts+reviewed-lifecycle-v1",
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
          "mcporter-recipe=locked-ci+audit-signatures-v1",
          "mcporter-recipe=locked-ci-only-v1",
        ),
      },
    ],
    [
      "writable marker",
      { baseProvenance: openClawBaseProvenance(), baseProvenanceMetadata: "0:0:644" },
    ],
    ["symlink marker", { baseProvenance: openClawBaseProvenance(), baseProvenanceSymlink: true }],
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
    expect(result.stdout).toContain("lacks exact reviewed provenance");
    expect(calls).toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.integrity`);
    expect(calls).toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.tarball`);
    expect(calls).toContain(`npm pack ${PINNED_OPENCLAW_TARBALL} --pack-destination`);
    expect(calls).toContain("npm install -g --no-audit --no-fund --no-progress --ignore-scripts ");
    expect(calls).toContain(
      "node /usr/local/lib/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs",
    );
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
        installedOpenClawVersion: "2026.6.11",
        committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
        registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
        baseProvenance: openClawBaseProvenance(),
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `Base image has OpenClaw 2026.6.11, which is newer than reviewed target ${PINNED_OPENCLAW_VERSION}`,
    );
    expect(calls).not.toContain(`npm view openclaw@${PINNED_OPENCLAW_VERSION} dist.integrity`);
    expect(calls).not.toContain(`npm pack ${PINNED_OPENCLAW_TARBALL} --pack-destination`);
    expect(provenanceExists).toBe(false);
  });

  it("rejects npm pack filenames outside the fresh pack directories", () => {
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
        packFilename: "../openclaw-2026.6.10.tgz",
      },
    );
    const codexAcp = runInstallBlock(
      extractRunBlock(
        DOCKERFILE,
        "# Pre-install the codex-acp package",
        "# Upgrade OpenClaw if the base image is stale.",
      ),
      {
        openclawVersion: PINNED_OPENCLAW_VERSION,
        committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
        registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
        packFilename: "../codex-acp-0.11.1.tgz",
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
        packFilename: "../openclaw-2026.6.10.tgz",
      },
    );
    const optionalPlugin = runOptionalOpenClawPluginBlock({
      pluginPackFilename: "../diagnostics-otel-2026.6.10.tgz",
    });

    for (const item of [
      {
        label: "production Dockerfile",
        outcome: production,
        unsafeFilename: "../openclaw-2026.6.10.tgz",
        blockedCommand: "npm install -g",
      },
      {
        label: "codex-acp Dockerfile",
        outcome: codexAcp,
        unsafeFilename: "../codex-acp-0.11.1.tgz",
        blockedCommand: "npm install -g",
      },
      {
        label: "base Dockerfile",
        outcome: base,
        unsafeFilename: "../openclaw-2026.6.10.tgz",
        blockedCommand: "npm install -g",
      },
      {
        label: "optional OpenClaw plugin Dockerfile",
        outcome: optionalPlugin,
        unsafeFilename: "../diagnostics-otel-2026.6.10.tgz",
        blockedCommand: "openclaw plugins install",
      },
    ]) {
      expect(item.outcome.result.status, item.label).not.toBe(0);
      expect(`${item.outcome.result.stdout}${item.outcome.result.stderr}`, item.label).toContain(
        `npm pack reported unsafe archive filename: ${item.unsafeFilename}`,
      );
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
        openclawVersion: PINNED_OPENCLAW_VERSION,
        committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
        registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
        packFilename: null,
      },
    );
    const diagnostic = `OpenClaw ${PINNED_OPENCLAW_VERSION} npm pack did not report filename and integrity`;

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(diagnostic);
    expect(result.stdout).not.toContain(diagnostic);
    expect(calls).toContain(`npm pack ${PINNED_OPENCLAW_TARBALL} --pack-destination`);
    expect(calls).not.toContain("npm install -g");
  });

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
    expect(fixtureBase.calls).not.toContain("postinstall-bundled-plugins.mjs");
    expect(gatewayFixtureBase.result.status).toBe(0);
    expect(gatewayFixtureBase.calls).toContain("npm install -g --ignore-scripts ");
    expect(gatewayFixtureBase.calls).toContain(
      "node /usr/local/lib/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs",
    );
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
      expect(result.stderr).toContain("only allowed in explicit stale-upgrade E2E fixture builds");
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
      "HERMES_NPM_INTEGRITY",
      "MCPORTER_0_7_3_INTEGRITY",
      "OPENCLAW_2026_3_11_INTEGRITY",
      "OPENCLAW_2026_3_11_TARBALL",
      "OPENCLAW_2026_4_24_INTEGRITY",
      "OPENCLAW_2026_4_24_TARBALL",
      "OPENCLAW_2026_6_10_INTEGRITY",
      "OPENCLAW_2026_6_10_TARBALL",
      "OPENCLAW_BRAVE_PLUGIN_2026_6_10_INTEGRITY",
      "OPENCLAW_DIAGNOSTICS_OTEL_2026_6_10_INTEGRITY",
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

  it("fails closed before npm install when the downloaded OpenClaw tarball integrity drifts", () => {
    const { result, calls } = runInstallBlock(
      extractRunBlock(
        DOCKERFILE,
        "# OPENCLAW_VERSION is the NemoClaw runtime build target",
        "# Patch OpenClaw media fetch",
      ),
      {
        openclawVersion: PINNED_OPENCLAW_VERSION,
        committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
        registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
        packIntegrity: "sha512-downloaded-drift",
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain(
      `OpenClaw ${PINNED_OPENCLAW_VERSION} downloaded tarball integrity mismatch`,
    );
    expect(output).toContain(`Expected: ${PINNED_OPENCLAW_INTEGRITY}`);
    expect(output).toContain("Actual:   sha512-downloaded-drift");
    expect(calls).toContain(`npm pack ${PINNED_OPENCLAW_TARBALL} --pack-destination`);
    expect(calls).not.toContain("npm install -g");
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

  it("fails closed before installing codex-acp when its registry integrity drifts", () => {
    const { result, calls } = runInstallBlock(
      extractRunBlock(
        DOCKERFILE,
        "# Pre-install the codex-acp package",
        "# Upgrade OpenClaw if the base image is stale.",
      ),
      {
        openclawVersion: PINNED_OPENCLAW_VERSION,
        committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
        registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
        codexAcpCommittedIntegrity: PINNED_CODEX_ACP_INTEGRITY,
        codexAcpRegistryIntegrity: "sha512-codex-acp-drift",
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `@zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION} npm integrity mismatch`,
    );
    expect(`${result.stdout}${result.stderr}`).toContain(`Expected: ${PINNED_CODEX_ACP_INTEGRITY}`);
    expect(`${result.stdout}${result.stderr}`).toContain("Actual:   sha512-codex-acp-drift");
    expect(calls).toContain(
      `npm view @zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION} dist.integrity`,
    );
    expect(calls).not.toContain(
      `npm install -g --no-audit --no-fund --no-progress ${PINNED_CODEX_ACP_TARBALL}`,
    );
  });

  it("fails closed before installing codex-acp when its registry tarball URL drifts", () => {
    const { result, calls } = runInstallBlock(
      extractRunBlock(
        DOCKERFILE,
        "# Pre-install the codex-acp package",
        "# Upgrade OpenClaw if the base image is stale.",
      ),
      {
        openclawVersion: PINNED_OPENCLAW_VERSION,
        committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
        registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
        codexAcpCommittedIntegrity: PINNED_CODEX_ACP_INTEGRITY,
        codexAcpRegistryIntegrity: PINNED_CODEX_ACP_INTEGRITY,
        codexAcpRegistryTarball:
          "https://registry.npmjs.org/@zed-industries/codex-acp/-/codex-acp-0.11.2.tgz",
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `@zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION} npm tarball URL mismatch`,
    );
    expect(`${result.stdout}${result.stderr}`).toContain(`Expected: ${PINNED_CODEX_ACP_TARBALL}`);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Actual:   https://registry.npmjs.org/@zed-industries/codex-acp/-/codex-acp-0.11.2.tgz",
    );
    expect(calls).toContain(
      `npm view @zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION} dist.tarball`,
    );
    expect(calls).not.toContain(
      `npm install -g --no-audit --no-fund --no-progress ${PINNED_CODEX_ACP_TARBALL}`,
    );
  });

  it("fails closed before installing codex-acp when its downloaded tarball integrity drifts", () => {
    const { result, calls } = runInstallBlock(
      extractRunBlock(
        DOCKERFILE,
        "# Pre-install the codex-acp package",
        "# Upgrade OpenClaw if the base image is stale.",
      ),
      {
        openclawVersion: PINNED_OPENCLAW_VERSION,
        committedIntegrity: PINNED_OPENCLAW_INTEGRITY,
        registryIntegrity: PINNED_OPENCLAW_INTEGRITY,
        codexAcpCommittedIntegrity: PINNED_CODEX_ACP_INTEGRITY,
        codexAcpRegistryIntegrity: PINNED_CODEX_ACP_INTEGRITY,
        codexAcpPackIntegrity: "sha512-codex-downloaded-drift",
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      `@zed-industries/codex-acp@${PINNED_CODEX_ACP_VERSION} downloaded tarball integrity mismatch`,
    );
    expect(`${result.stdout}${result.stderr}`).toContain(`Expected: ${PINNED_CODEX_ACP_INTEGRITY}`);
    expect(`${result.stdout}${result.stderr}`).toContain("Actual:   sha512-codex-downloaded-drift");
    expect(calls).toContain(`npm pack ${PINNED_CODEX_ACP_TARBALL} --pack-destination`);
    expect(calls).not.toContain("npm install -g");
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
});
