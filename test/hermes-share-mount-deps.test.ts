// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_APT_SECURITY_FUNCTIONS } from "./helpers/base-apt-security-functions";
import { stageFixedParser, useRealPatchedParser } from "./helpers/python-parser-security-fixture";

const ROOT = path.resolve(import.meta.dirname, "..");
const HERMES_DOCKERFILE_BASE = path.join(ROOT, "agents", "hermes", "Dockerfile.base");

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
    'apt-get() { printf "apt-get %s\\n" "$*" >> "$call_log"; }',
    ...functionDefs,
    command,
  ].join("\n");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 15000 });
  const calls = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
  return { result, calls };
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
    'uv() { printf "uv %s\\n" "$*" >> "$call_log"; }',
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
      for (const cachePath of cachePaths) {
        expect(() => fs.lstatSync(cachePath)).toThrow();
      }
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

    try {
      for (const file of [agentBrowser, python, tuiEntry, webIndex]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      }
      fs.writeFileSync(fakeHermes, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
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

  it("pre-installs the WhatsApp bridge node_modules with npm ci when a lockfile ships (#4764)", () => {
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
