// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_APT_SECURITY_FUNCTIONS } from "../../helpers/base-apt-security-functions";
import { stageFixedParser, useRealPatchedParser } from "../../helpers/python-parser-security-fixture";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const HERMES_DOCKERFILE_BASE = path.join(ROOT, "agents", "hermes", "Dockerfile.base");
const HERMES_ARCHIVE_HELPER = path.join(
  ROOT,
  "scripts",
  "checks",
  "download-hermes-source-archive.sh",
);
const PRIVATE_CURL_DIAGNOSTIC = "private curl diagnostic must stay redacted";

function extractAptInstallCommand(dockerfile: string): string {
  const runtimeStage = dockerfile.lastIndexOf(
    "FROM node:24-trixie-slim@sha256:05c08ce4291e9a58f59456a7985176defb12cdd42271f35ff81a3e167ea61d4c",
  );
  expect(runtimeStage).toBeGreaterThanOrEqual(0);
  const match = dockerfile
    .slice(runtimeStage)
    .match(
      /RUN\s+apt-get update\s*&&\s*apt-get install -y --no-install-recommends[\s\S]*?&&\s*rm -rf \/var\/lib\/apt\/lists\/\*/m,
    );
  expect(match).not.toBeNull();
  return match![0].replace(/^RUN\s+/, "").replace(/\\\n/g, " ");
}

function extractHermesInstallCommand(dockerfile: string): string {
  const installStart = dockerfile.indexOf("WORKDIR /opt/hermes");
  expect(installStart).toBeGreaterThanOrEqual(0);
  const match = dockerfile
    .slice(installStart)
    .match(
      /RUN\s+set -eu;[\s\S]*?ln -sf \/opt\/hermes\/\.venv\/bin\/hermes-acp \/usr\/local\/bin\/hermes-acp/m,
    );
  expect(match).not.toBeNull();
  return match![0].replace(/^RUN\s+/, "").replace(/\\\n/g, " ");
}

function extractHermesArchiveCommand(dockerfile: string): string {
  const archiveStart = dockerfile.indexOf("RUN mkdir -p /opt/hermes");
  const archiveEnd = dockerfile.indexOf("\n\n# Cross-check the pinned release", archiveStart);
  expect(archiveStart).toBeGreaterThanOrEqual(0);
  expect(archiveEnd).toBeGreaterThan(archiveStart);
  return dockerfile
    .slice(archiveStart, archiveEnd)
    .replace(/^RUN\s+/, "")
    .replace(/\\\n/g, " ");
}

function extractHermesIntegrityCommand(dockerfile: string): string {
  const integrityStart = dockerfile.indexOf("# Cross-check the pinned release");
  const installStart = dockerfile.indexOf("WORKDIR /opt/hermes", integrityStart);
  expect(integrityStart).toBeGreaterThanOrEqual(0);
  expect(installStart).toBeGreaterThan(integrityStart);
  const match = dockerfile.slice(integrityStart, installStart).match(/RUN\s+set -eu;[\s\S]*$/m);
  expect(match).not.toBeNull();
  return match![0].replace(/^RUN\s+/, "").replace(/\\\n/g, " ");
}

function extractHermesRuntimeGuard(dockerfile: string): string {
  const guardStart = dockerfile.indexOf("RUN /usr/local/bin/hermes --version");
  const nextRun = dockerfile.indexOf("\nRUN chmod -R", guardStart);
  expect(guardStart).toBeGreaterThanOrEqual(0);
  expect(nextRun).toBeGreaterThan(guardStart);
  return dockerfile
    .slice(guardStart, nextRun)
    .replace(/^RUN\s+/, "")
    .replace(/\\\n/g, " ");
}

function runLoggedShell(command: string, tmp: string, functionDefs: string[] = []) {
  const logPath = path.join(tmp, "calls.log");
  const scriptPath = path.join(tmp, "run-hermes-apt-layer.sh");
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(logPath)}`,
    "perl_base_installed=0",
    "perl_installed=0",
    'apt-get() { printf "apt-get %s\\n" "$*" >> "$call_log"; [[ "$*" != *"/perl-base.deb"* ]] || perl_base_installed=1; [[ "$*" != *"/perl.deb"* ]] || perl_installed=1; }',
    ...functionDefs,
    command,
  ].join("\n");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 15000 });
  const calls = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
  return { result, calls };
}

function runHermesArchiveLayer(
  responses: readonly string[],
  expectedChecksum?: string,
  archiveReplacement?: string,
  input: { version?: string; output?: string } = {},
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-archive-"));
  const sourceRoot = path.join(tmp, "source");
  const archiveRoot = path.join(sourceRoot, "hermes-agent-test");
  const sourceTarball = path.join(tmp, "source.tar.gz");
  const targetRoot = path.join(tmp, "target", "hermes");
  const downloadedTarball = input.output ?? path.join(tmp, "download", "hermes.tar.gz");
  const downloadedTarballPath = path.isAbsolute(downloadedTarball)
    ? downloadedTarball
    : path.join(tmp, downloadedTarball);
  const checksumFile = `${downloadedTarball}.sha256`;
  const securityPatch = path.join(tmp, "hermes-security-dependencies.patch");
  const runtimeBoundariesPatch = path.join(tmp, "hermes-runtime-boundaries.patch");
  const whatsappProxyPatch = path.join(tmp, "hermes-whatsapp-proxy.patch");
  const helperCopy = path.join(tmp, "download-hermes-source-archive.sh");
  const fakeBin = path.join(tmp, "bin");
  const responseFile = path.join(tmp, "responses");
  const stateFile = path.join(tmp, "attempt");
  const callLog = path.join(tmp, "calls.log");
  const urlLog = path.join(tmp, "urls.log");
  const scriptPath = path.join(tmp, "run-hermes-archive-layer.sh");

  fs.mkdirSync(path.join(archiveRoot, "tests"), { recursive: true });
  fs.mkdirSync(path.dirname(downloadedTarballPath), { recursive: true });
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(securityPatch, "test patch fixture\n");
  fs.writeFileSync(runtimeBoundariesPatch, "test runtime boundaries patch fixture\n");
  fs.writeFileSync(whatsappProxyPatch, "test patch fixture\n");
  fs.writeFileSync(path.join(archiveRoot, "pyproject.toml"), 'version = "test"\n');
  fs.writeFileSync(
    path.join(archiveRoot, "tests", "security-fixture.txt"),
    "intentionally hostile test-only URL\n",
  );
  const packed = spawnSync("tar", ["-czf", sourceTarball, "-C", sourceRoot, "hermes-agent-test"], {
    encoding: "utf-8",
  });
  expect(packed.status, packed.stderr).toBe(0);
  fs.writeFileSync(sourceTarball, archiveReplacement ?? fs.readFileSync(sourceTarball));
  const checksum = createHash("sha256").update(fs.readFileSync(sourceTarball)).digest("hex");
  const runtimeBoundariesPatchChecksum = createHash("sha256")
    .update(fs.readFileSync(runtimeBoundariesPatch))
    .digest("hex");
  fs.writeFileSync(responseFile, `${responses.join("\n")}\n`);
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "attempt=1",
      'if [ -f "$ARCHIVE_STATE" ]; then attempt=$(( $(cat "$ARCHIVE_STATE") + 1 )); fi',
      'printf "%s\\n" "$attempt" > "$ARCHIVE_STATE"',
      'response="$(sed -n "${attempt}p" "$ARCHIVE_RESPONSES")"',
      '[ -n "$response" ] || response="$(tail -n 1 "$ARCHIVE_RESPONSES")"',
      'printf "curl %s\\n" "$response" >> "$ARCHIVE_CALL_LOG"',
      '[ "${1:-}" = "--disable" ] || exit 67',
      'output=""',
      'url=""',
      "fail=0",
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -o|--output) shift; output="$1" ;;',
      '    --output=*) output="${1#--output=}" ;;',
      "    --retry|--retry=*|--retry-*) exit 66 ;;",
      "    --fail|--fail-with-body|-*f*) fail=1 ;;",
      '    https://*) url="$1" ;;',
      "  esac",
      "  shift",
      "done",
      '[ -n "$url" ]',
      'printf "%s\\n" "$url" >> "$ARCHIVE_URL_LOG"',
      'if [ "$attempt" -gt 1 ] && [ -e "$output" ]; then',
      '  printf "curl stale-output\\n" >> "$ARCHIVE_CALL_LOG"',
      "  exit 65",
      "fi",
      'case "$response" in',
      '  http:200) cp "$ARCHIVE_SOURCE" "$output"; printf 200 ;;',
      `  http:*) printf partial > "$output"; printf "%s" "\${response#http:}"; printf "%s\\n" ${JSON.stringify(PRIVATE_CURL_DIAGNOSTIC)} >&2; [ "$fail" -eq 0 ] || exit 22 ;;`,
      `  exit:*) printf partial > "$output"; printf 000; printf "%s\\n" ${JSON.stringify(PRIVATE_CURL_DIAGNOSTIC)} >&2; exit "\${response#exit:}" ;;`,
      "  *) exit 64 ;;",
      "esac",
    ].join("\n"),
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(fakeBin, "sleep"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "sleep %s\\n" "$*" >> "$ARCHIVE_CALL_LOG"',
    ].join("\n"),
    { mode: 0o700 },
  );

  fs.copyFileSync(HERMES_ARCHIVE_HELPER, helperCopy);
  const command = extractHermesArchiveCommand(fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8"))
    .replaceAll("/tmp/hermes-security-dependencies.patch", securityPatch)
    .replaceAll("/tmp/hermes-runtime-boundaries.patch", runtimeBoundariesPatch)
    .replaceAll("/tmp/hermes-whatsapp-proxy.patch", whatsappProxyPatch)
    .replaceAll("/tmp/hermes.tar.gz.sha256", checksumFile)
    .replaceAll("/tmp/hermes.tar.gz", downloadedTarball)
    .replaceAll("/opt/hermes", targetRoot)
    .replaceAll("/tmp/nemoclaw-download-hermes-source-archive.sh", helperCopy);
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `target_root=${JSON.stringify(targetRoot)}`,
      `security_patch=${JSON.stringify(securityPatch)}`,
      `runtime_boundaries_patch=${JSON.stringify(runtimeBoundariesPatch)}`,
      `whatsapp_proxy_patch=${JSON.stringify(whatsappProxyPatch)}`,
      "git() {",
      '  [ "$1" = "-C" ]',
      '  [ "$2" = "$target_root" ]',
      '  [ "$3" = "apply" ]',
      '  if [ "$4" = "--check" ]; then',
      '    [ "$5" = "$security_patch" ] || [ "$5" = "$runtime_boundaries_patch" ] || [ "$5" = "$whatsapp_proxy_patch" ]',
      "  else",
      '    [ "$4" = "$security_patch" ] || [ "$4" = "$runtime_boundaries_patch" ] || [ "$4" = "$whatsapp_proxy_patch" ]',
      '    if [ "$4" = "$runtime_boundaries_patch" ]; then',
      '      mkdir -p "$target_root/hermes_cli" "$target_root/tools" "$target_root/plugins/memory" "$target_root/plugins/cron_providers" "$target_root/providers"',
      '      printf "%s\\n" "def nemoclaw_managed_gateway_plugins_only():" > "$target_root/hermes_constants.py"',
      '      printf "%s\\n" "nemoclaw_protected_process_control" > "$target_root/hermes_cli/env_loader.py"',
      '      printf "%s\\n" "Managed gateway: user and project plugins disabled" > "$target_root/hermes_cli/plugins.py"',
      '      printf "%s\\n" "nemoclaw_sanitized_installer_env" > "$target_root/tools/lazy_deps.py"',
      '      printf "%s\\n" "nemoclaw_managed_gateway_plugins_only" > "$target_root/plugins/memory/__init__.py"',
      '      printf "%s\\n" "nemoclaw_managed_gateway_plugins_only" > "$target_root/plugins/cron_providers/__init__.py"',
      '      printf "%s\\n" "nemoclaw_managed_gateway_plugins_only" > "$target_root/providers/__init__.py"',
      "    fi",
      "  fi",
      "}",
      `export HERMES_VERSION=${JSON.stringify(input.version ?? "v2026.7.20")}`,
      `export HERMES_TARBALL_SHA256=${JSON.stringify(expectedChecksum ?? checksum)}`,
      `export NEMOCLAW_HERMES_RUNTIME_BOUNDARIES_PATCH_SHA256=${JSON.stringify(runtimeBoundariesPatchChecksum)}`,
      command,
    ].join("\n"),
    { mode: 0o700 },
  );
  const result = spawnSync("bash", [scriptPath], {
    cwd: tmp,
    encoding: "utf-8",
    env: {
      ARCHIVE_CALL_LOG: callLog,
      ARCHIVE_RESPONSES: responseFile,
      ARCHIVE_SOURCE: sourceTarball,
      ARCHIVE_STATE: stateFile,
      ARCHIVE_URL_LOG: urlLog,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
    timeout: 15_000,
  });
  const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf-8").trim().split("\n") : [];
  const urls = fs.existsSync(urlLog) ? fs.readFileSync(urlLog, "utf-8").trim().split("\n") : [];
  return { calls, downloadedTarball: downloadedTarballPath, result, targetRoot, tmp, urls };
}

function runHermesInstallLayer(
  command: string,
  tmp: string,
  opts: {
    uiTuiLockfile?: "directory" | "workspace" | "missing";
    webLockfile?: "directory" | "workspace" | "missing";
    whatsappBridge?: "lockfile" | "package-json";
  } = {},
) {
  const fixture = path.join(tmp, "hermes");
  const logPath = path.join(tmp, "calls.log");
  const npmCache = path.join(tmp, "root-cache", "npm");
  const electronCache = path.join(tmp, "root-cache", "electron");
  const nodeGypCache = path.join(tmp, "root-cache", "node-gyp");
  const scriptPath = path.join(tmp, "run-hermes-install-layer.sh");
  const uiTuiLockfile = opts.uiTuiLockfile ?? "missing";
  const webLockfile = opts.webLockfile ?? "directory";
  const rootLockPackages = {
    ...(uiTuiLockfile === "workspace" ? { "ui-tui": {} } : {}),
    ...(webLockfile === "workspace" ? { web: {} } : {}),
  };
  fs.mkdirSync(path.join(fixture, "web"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "pyproject.toml"), 'version = "0.16.0"\n');
  fs.writeFileSync(
    path.join(fixture, "package-lock.json"),
    `${JSON.stringify({
      packages: rootLockPackages,
    })}\n`,
  );
  fs.writeFileSync(path.join(fixture, "web", "package.json"), "{}\n");
  const writeUiTuiLockfile = {
    directory: () => {
      fs.mkdirSync(path.join(fixture, "ui-tui"), { recursive: true });
      fs.writeFileSync(path.join(fixture, "ui-tui", "package.json"), "{}\n");
      fs.writeFileSync(path.join(fixture, "ui-tui", "package-lock.json"), "{}\n");
    },
    missing: () => undefined,
    workspace: () => {
      fs.mkdirSync(path.join(fixture, "ui-tui"), { recursive: true });
      fs.writeFileSync(path.join(fixture, "ui-tui", "package.json"), "{}\n");
    },
  } satisfies Record<typeof uiTuiLockfile, () => void>;
  writeUiTuiLockfile[uiTuiLockfile]();
  const writeWebLockfile = {
    directory: () => fs.writeFileSync(path.join(fixture, "web", "package-lock.json"), "{}\n"),
    missing: () => undefined,
    workspace: () => undefined,
  } satisfies Record<typeof webLockfile, () => void>;
  writeWebLockfile[webLockfile]();
  const workspaceBuildTrees = [
    ...(uiTuiLockfile === "workspace" ? ["ui-tui"] : []),
    ...(webLockfile === "workspace" ? ["web"] : []),
  ];
  for (const uiDir of workspaceBuildTrees) {
    const nodeModules = path.join(fixture, uiDir, "node_modules");
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.writeFileSync(path.join(nodeModules, "build-only-dependency"), `${uiDir}\n`);
  }
  for (const cache of [npmCache, electronCache, nodeGypCache]) {
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "build-only-cache"), "unused after image assembly\n");
  }
  if (opts.whatsappBridge) {
    const bridgeDir = path.join(fixture, "scripts", "whatsapp-bridge");
    fs.mkdirSync(bridgeDir, { recursive: true });
    fs.writeFileSync(path.join(bridgeDir, "package.json"), "{}\n");
    if (opts.whatsappBridge === "lockfile") {
      fs.writeFileSync(path.join(bridgeDir, "package-lock.json"), "{}\n");
    }
  }

  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `cd ${JSON.stringify(fixture)}`,
    `call_log=${JSON.stringify(logPath)}`,
    "uv() {",
    '  printf "uv %s\\n" "$*" >> "$call_log"',
    '  if [ "${1:-}" = "sync" ]; then',
    "    mkdir -p .venv/bin",
    "    printf '#!/usr/bin/env sh\\nexit 0\\n' > .venv/bin/python",
    "    chmod 755 .venv/bin/python",
    "  fi",
    "}",
    "npm() {",
    '  if [ "${1:-}" = "view" ]; then',
    '    printf "%s\\n" "${HERMES_NPM_INTEGRITY}"',
    "    return 0",
    "  fi",
    '  printf "npm %s\\n" "$*" >> "$call_log"',
    '  if [ "${1:-}" = "ci" ]; then',
    "    shift",
    '    prefix="."',
    '    while [ "$#" -gt 0 ]; do',
    '      if [ "$1" = "--prefix" ]; then',
    "        shift",
    '        prefix="$1"',
    "      fi",
    "      shift || true",
    "    done",
    '    [ -f "${prefix}/package-lock.json" ] || {',
    '      echo "missing lockfile for ${prefix}" >&2',
    "      return 42",
    "    }",
    '    mkdir -p "${prefix}/node_modules"',
    "  fi",
    "}",
    "node() {",
    '  printf "node %s\\n" "$*" >> "$call_log"',
    '  [ "$*" = "--experimental-test-module-mocks --test scripts/whatsapp-bridge/proxy-agent.test.mjs" ]',
    "}",
    'rm() { printf "rm %s\\n" "$*" >> "$call_log"; command rm "$@"; }',
    'ln() { printf "ln %s\\n" "$*" >> "$call_log"; }',
    'export HERMES_SEMVER="0.16.0"',
    'export HERMES_NPM_INTEGRITY="sha512-test"',
    'export HERMES_UV_EXTRAS="messaging mcp"',
    command
      .replaceAll("/opt/hermes", fixture)
      .replaceAll("/root/.npm", npmCache)
      .replaceAll("/root/.cache/electron", electronCache)
      .replaceAll("/root/.cache/node-gyp", nodeGypCache),
  ].join("\n");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
  const calls = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
  return { cachePaths: [npmCache, electronCache, nodeGypCache], result, calls };
}

describe("Hermes share mount package parity (#2947)", () => {
  it.each([
    {
      input: { version: "2026.7.20" },
      name: "a malformed Hermes version",
      failure: "invalid-version",
    },
    {
      input: { output: "hermes.tar.gz" },
      name: "a relative archive output",
      failure: "invalid-output",
    },
  ])("rejects $name before download (#9815)", ({ failure, input }) => {
    const { calls, downloadedTarball, result, tmp, urls } = runHermesArchiveLayer(
      ["http:200"],
      undefined,
      undefined,
      input,
    );
    try {
      expect(result.status).toBe(2);
      expect(calls).toEqual([]);
      expect(urls).toEqual([]);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `Hermes archive download outcome=failed-no-retry attempt=0/3 failure=${failure}\n`,
      );
      expect(fs.existsSync(downloadedTarball)).toBe(false);
      expect(fs.existsSync(`${downloadedTarball}.partial`)).toBe(false);
      expect(fs.existsSync(`${downloadedTarball}.curl-error`)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("retries a throttled Hermes archive and removes upstream tests (#9815)", () => {
    const { calls, result, targetRoot, tmp, urls } = runHermesArchiveLayer([
      "http:429",
      "http:200",
    ]);
    try {
      expect(result.status, result.stderr).toBe(0);
      expect(calls).toEqual(["curl http:429", "sleep 1", "curl http:200"]);
      expect(urls).toEqual([
        "https://github.com/NousResearch/hermes-agent/archive/refs/tags/v2026.7.20.tar.gz",
        "https://github.com/NousResearch/hermes-agent/archive/refs/tags/v2026.7.20.tar.gz",
      ]);
      expect(result.stderr.split("\n").filter((line) => line.startsWith("Hermes archive"))).toEqual(
        [
          "Hermes archive download outcome=transient-external attempt=1/3 failure=http-429 retry-in=1s",
          "Hermes archive download outcome=passed-after-retry attempt=2/3",
        ],
      );
      expect(result.stderr).not.toContain(PRIVATE_CURL_DIAGNOSTIC);
      expect(fs.readFileSync(path.join(targetRoot, "pyproject.toml"), "utf-8")).toContain(
        'version = "test"',
      );
      expect(() => fs.lstatSync(path.join(targetRoot, "tests"))).toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stops after three throttled Hermes archive attempts (#9815)", () => {
    const { calls, downloadedTarball, result, tmp } = runHermesArchiveLayer([
      "http:429",
      "http:429",
      "http:429",
    ]);
    try {
      expect(result.status).not.toBe(0);
      expect(calls).toEqual([
        "curl http:429",
        "sleep 1",
        "curl http:429",
        "sleep 2",
        "curl http:429",
      ]);
      expect(result.stderr.split("\n").filter((line) => line.startsWith("Hermes archive"))).toEqual(
        [
          "Hermes archive download outcome=transient-external attempt=1/3 failure=http-429 retry-in=1s",
          "Hermes archive download outcome=transient-external attempt=2/3 failure=http-429 retry-in=2s",
          "Hermes archive download outcome=exhausted attempt=3/3 failure=http-429",
        ],
      );
      expect(result.stderr).not.toContain(PRIVATE_CURL_DIAGNOSTIC);
      expect(fs.existsSync(downloadedTarball)).toBe(false);
      expect(fs.existsSync(`${downloadedTarball}.partial`)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    { response: "http:404", failure: "http-404", name: "HTTP 404" },
    { response: "http:500", failure: "http-500", name: "HTTP 500" },
    { response: "exit:28", failure: "curl-exit-28", name: "transport failure" },
  ])("does not retry a terminal Hermes archive $name (#9815)", ({ failure, response }) => {
    const { calls, result, tmp } = runHermesArchiveLayer([response]);
    try {
      expect(result.status).not.toBe(0);
      expect(calls).toEqual([`curl ${response}`]);
      expect(result.stderr).toBe(
        `Hermes archive download outcome=failed-no-retry attempt=1/3 failure=${failure}\n`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("downloads the Hermes archive once when GitHub returns HTTP 200 (#9815)", () => {
    const { calls, result, targetRoot, tmp } = runHermesArchiveLayer(["http:200"]);
    try {
      expect(result.status, result.stderr).toBe(0);
      expect(calls).toEqual(["curl http:200"]);
      expect(result.stderr).toContain(
        "Hermes archive download outcome=passed-first-attempt attempt=1/3",
      );
      expect(fs.readFileSync(path.join(targetRoot, "pyproject.toml"), "utf-8")).toContain(
        'version = "test"',
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    { expectedChecksum: "0".repeat(64), name: "checksum mismatch" },
    { archiveReplacement: "checksum-valid malformed archive\n", name: "malformed archive" },
  ])("does not retry a Hermes archive $name (#9815)", ({ archiveReplacement, expectedChecksum }) => {
    const { calls, result, targetRoot, tmp } = runHermesArchiveLayer(
      ["http:200"],
      expectedChecksum,
      archiveReplacement,
    );
    try {
      expect(result.status).not.toBe(0);
      expect(calls).toEqual(["curl http:200"]);
      expect(result.stderr).toContain(
        "Hermes archive download outcome=passed-first-attempt attempt=1/3",
      );
      expect(fs.existsSync(path.join(targetRoot, "pyproject.toml"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("requests gnupg, procps, e2fsprogs, and openssh-sftp-server from the Hermes base apt layer", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-share-apt-"));
    const lists = path.join(tmp, "apt-lists");
    const debianSecurityDebs = path.join(tmp, "debian-security-debs");
    const nativeSecurityDebs = path.join(tmp, "native-security-debs");
    const inventoryDirectory = path.join(tmp, "security-inventory");
    const inventory = path.join(inventoryDirectory, "security-packages.txt");
    const { fixedParser, pythonShim } = stageFixedParser(tmp);
    fs.mkdirSync(lists);
    fs.mkdirSync(debianSecurityDebs);
    fs.mkdirSync(nativeSecurityDebs);
    fs.writeFileSync(path.join(nativeSecurityDebs, "libssh2-1t64.deb"), "fixed libssh2");
    fs.writeFileSync(
      path.join(nativeSecurityDebs, "nemoclaw-python3.13-htmlparser-fix.deb"),
      "fixed parser package",
    );

    try {
      const command = extractAptInstallCommand(dockerfile)
        .replaceAll("/var/lib/apt/lists", lists)
        .replaceAll("/tmp/nemoclaw-debian-security", debianSecurityDebs)
        .replaceAll("/tmp/nemoclaw-native-security", nativeSecurityDebs)
        .replaceAll("/usr/local/share/nemoclaw/security-packages.txt", inventory)
        .replaceAll("/usr/local/share/nemoclaw", inventoryDirectory)
        .replaceAll("/usr/lib/python3.13/html/parser.py", fixedParser);
      const { result, calls } = runLoggedShell(command, tmp, [
        'install() { [[ "$#" -eq 8 && "$1" == "-d" && "$2" == "-o" && "$3" == "root" && "$4" == "-g" && "$5" == "root" && "$6" == "-m" && "$7" == "0755" ]] || return 64; mkdir -p "$8"; }',
        'chown() { [[ "$#" -eq 2 && "$1" == "root:root" ]] || return 64; }',
        ...useRealPatchedParser(BASE_APT_SECURITY_FUNCTIONS, pythonShim),
      ]);

      expect(result.status).toBe(0);
      expect(calls).toContain("apt-get update");
      expect(calls).toContain("gnupg=2.4.7-21+deb13u1");
      expect(calls).toContain("procps=2:4.0.4-9");
      expect(calls).toContain("e2fsprogs=1.47.2-3+b11");
      expect(calls).toContain("openssh-sftp-server=1:10.0p1-7+deb13u4");
      expect(fs.existsSync(debianSecurityDebs)).toBe(false);
      expect(fs.existsSync(nativeSecurityDebs)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips optional Hermes UI packages when old rebuild fixtures do not ship them", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-ui-layer-"));

    try {
      const command = extractHermesInstallCommand(dockerfile);
      const { result, calls } = runHermesInstallLayer(command, tmp);

      expect(result.status, result.stderr).toBe(0);
      expect(calls).toContain("npm ci --prefer-offline --no-audit --no-fund");
      expect(calls).not.toContain("--prefix ui-tui");
      expect(calls).toContain("npm ci --prefix web --prefer-offline --no-audit --no-fund");
      expect(calls).toContain("npm run build --prefix web");
      expect(calls).toContain(
        "npm ci --omit=dev --workspaces=false --prefer-offline --no-audit --no-fund",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps only root runtime dependencies after building workspace UIs (#7144)", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-ui-workspace-"));
    const hermesRoot = path.join(tmp, "hermes");

    try {
      const command = extractHermesInstallCommand(dockerfile);
      const { result, calls } = runHermesInstallLayer(command, tmp, {
        uiTuiLockfile: "workspace",
        webLockfile: "workspace",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(calls).toContain("npm ci --prefer-offline --no-audit --no-fund");
      expect(calls).not.toContain("npm ci --prefix web");
      expect(calls).toContain("npm run build --workspace web");
      const cleanInstall = "rm -rf node_modules ui-tui/node_modules web/node_modules";
      const runtimeInstall =
        "npm ci --omit=dev --workspaces=false --prefer-offline --no-audit --no-fund";
      expect(calls).toContain(cleanInstall);
      expect(calls).toContain(runtimeInstall);
      expect(calls.indexOf(cleanInstall)).toBeLessThan(calls.indexOf(runtimeInstall));
      expect(calls).not.toContain("npm ci --omit=dev --prefer-offline --no-audit --no-fund");
      expect(calls).not.toContain("--workspace=ui-tui --include-workspace-root");
      expect(fs.existsSync(path.join(hermesRoot, "node_modules"))).toBe(true);
      expect(fs.existsSync(path.join(hermesRoot, "ui-tui", "node_modules"))).toBe(false);
      expect(fs.existsSync(path.join(hermesRoot, "web", "node_modules"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("removes a legacy TUI build tree after bundling from its own lockfile", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-ui-legacy-"));
    const uiTuiNodeModules = path.join(tmp, "hermes", "ui-tui", "node_modules");

    try {
      const command = extractHermesInstallCommand(dockerfile);
      const { result, calls } = runHermesInstallLayer(command, tmp, {
        uiTuiLockfile: "directory",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(calls).toContain("npm ci --prefix ui-tui --prefer-offline --no-audit --no-fund");
      expect(calls).toContain(
        "npm ci --omit=dev --workspaces=false --prefer-offline --no-audit --no-fund",
      );
      expect(fs.existsSync(uiTuiNodeModules)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("removes build-only caches in the Hermes dependency layer (#7144)", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-build-cache-"));

    try {
      const command = extractHermesInstallCommand(dockerfile);
      const { cachePaths, result } = runHermesInstallLayer(command, tmp);

      expect(result.status, result.stderr).toBe(0);
      cachePaths.forEach((cachePath) => {
        expect(() => fs.lstatSync(cachePath)).toThrow();
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("smokes the prebuilt Hermes TUI without runtime node_modules (#7144)", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-tui-runtime-"));
    const hermesRoot = path.join(tmp, "hermes");
    const fakeHermes = path.join(tmp, "hermes-cli");
    const agentBrowser = path.join(hermesRoot, "node_modules", ".bin", "agent-browser");
    const python = path.join(hermesRoot, ".venv", "bin", "python");
    const tuiEntry = path.join(hermesRoot, "ui-tui", "dist", "entry.js");
    const webIndex = path.join(hermesRoot, "hermes_cli", "web_dist", "index.html");
    const scriptPath = path.join(tmp, "run-hermes-runtime-guard.sh");
    const hermesCalls = path.join(tmp, "hermes-calls.log");

    try {
      for (const file of [agentBrowser, python, tuiEntry, webIndex]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      }

      fs.writeFileSync(
        fakeHermes,
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> ${JSON.stringify(hermesCalls)}`,
          'case "$#" in',
          '  1) [ "$1" = "--version" ] || exit 64 ;;',
          '  2) [ "$1" = "acp" ] && [ "$2" = "--check" ] || exit 64 ;;',
          '  *) exit 64 ;;',
          "esac",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      fs.writeFileSync(agentBrowser, "#!/bin/sh\nprintf 'agent-browser test\\n'\n", {
        mode: 0o700,
      });
      fs.writeFileSync(python, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      fs.writeFileSync(
        tuiEntry,
        [
          'const fs = require("node:fs");',
          'const path = require("node:path");',
          'const runtimeModules = path.resolve(__dirname, "../../node_modules");',
          "if (fs.readdirSync(runtimeModules).length !== 0) process.exit(41);",
          'console.error("hermes-tui: no TTY");',
        ].join("\n"),
      );
      fs.writeFileSync(webIndex, "<!doctype html>\n");

      const command = extractHermesRuntimeGuard(dockerfile)
        .replaceAll("/usr/local/bin/hermes", fakeHermes)
        .replaceAll("/opt/hermes", hermesRoot);
      fs.writeFileSync(
        scriptPath,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'timeout() { shift; "$@"; }',
          `export HERMES_TUI_DIR=${JSON.stringify(path.join(hermesRoot, "ui-tui"))}`,
          `export HERMES_WEB_DIST=${JSON.stringify(path.join(hermesRoot, "hermes_cli", "web_dist"))}`,
          command,
        ].join("\n"),
        { mode: 0o700 },
      );

      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("hermes-tui: no TTY");
      expect(fs.readFileSync(hermesCalls, "utf-8").trim().split("\n")).toEqual([
        "--version",
        "acp --check",
      ]);
      expect(fs.existsSync(agentBrowser)).toBe(true);
      expect(fs.existsSync(path.join(hermesRoot, ".node_modules.runtime"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses and removes a disposable cache for the Hermes npm integrity lookup (#7144)", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-integrity-cache-"));
    const hermesRoot = path.join(tmp, "hermes");
    const integrityCache = path.join(tmp, "integrity-cache");
    const scriptPath = path.join(tmp, "run-hermes-integrity-layer.sh");
    fs.mkdirSync(hermesRoot, { recursive: true });
    fs.writeFileSync(path.join(hermesRoot, "pyproject.toml"), 'version = "0.16.0"\n');

    try {
      const command = extractHermesIntegrityCommand(dockerfile)
        .replaceAll("/opt/hermes", hermesRoot)
        .replaceAll("/tmp/hermes-npm-integrity-cache", integrityCache);
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `expected_cache=${JSON.stringify(integrityCache)}`,
        'npm() { [ "${npm_config_cache:-}" = "$expected_cache" ] || return 41; mkdir -p "$npm_config_cache"; printf "lookup cache\\n" > "$npm_config_cache/entry"; printf "%s\\n" "$HERMES_NPM_INTEGRITY"; }',
        'export HERMES_VERSION="v0.16.0"',
        'export HERMES_SEMVER="0.16.0"',
        'export HERMES_NPM_INTEGRITY="sha512-test"',
        command,
      ].join("\n");
      fs.writeFileSync(scriptPath, script, { mode: 0o700 });

      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });

      expect(result.status, result.stderr).toBe(0);
      expect(() => fs.lstatSync(integrityCache)).toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("pre-installs the WhatsApp bridge and runs its proxy regression test (#4764, #8087)", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wa-bridge-"));
    const bridgeNodeModules = path.join(
      tmp,
      "hermes",
      "scripts",
      "whatsapp-bridge",
      "node_modules",
    );
    const webNodeModules = path.join(tmp, "hermes", "web", "node_modules");

    try {
      const command = extractHermesInstallCommand(dockerfile);
      const { result, calls } = runHermesInstallLayer(command, tmp, {
        whatsappBridge: "lockfile",
      });

      expect(result.status, result.stderr).toBe(0);
      // Baking the bridge deps at build time means the runtime `hermes whatsapp`
      // never needs to mkdir node_modules under read-only /opt/hermes.
      expect(calls).toContain(
        "npm ci --prefix scripts/whatsapp-bridge --prefer-offline --no-audit --no-fund",
      );
      expect(calls).toContain(
        "node --experimental-test-module-mocks --test scripts/whatsapp-bridge/proxy-agent.test.mjs",
      );
      expect(fs.existsSync(bridgeNodeModules)).toBe(true);
      expect(fs.existsSync(webNodeModules)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips the WhatsApp bridge install when package.json ships without a lockfile (#4764)", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wa-bridge-nolock-"));

    try {
      const command = extractHermesInstallCommand(dockerfile);
      const { result, calls } = runHermesInstallLayer(command, tmp, {
        whatsappBridge: "package-json",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(calls).not.toContain("--prefix scripts/whatsapp-bridge");
      expect(result.stdout).toContain(
        "Skipping optional Hermes bridge scripts/whatsapp-bridge: package-lock.json not found",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips the WhatsApp bridge install when the project is absent (#4764)", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wa-bridge-skip-"));

    try {
      const command = extractHermesInstallCommand(dockerfile);
      const { result, calls } = runHermesInstallLayer(command, tmp);

      expect(result.status, result.stderr).toBe(0);
      expect(calls).not.toContain("--prefix scripts/whatsapp-bridge");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
