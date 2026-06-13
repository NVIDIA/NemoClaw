// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const HERMES_DOCKERFILE_BASE = path.join(ROOT, "agents", "hermes", "Dockerfile.base");

function extractAptInstallCommand(dockerfile: string): string {
  const match = dockerfile.match(
    /RUN\s+apt-get update\s*&&\s*apt-get install -y --no-install-recommends[\s\S]*?&&\s*rm -rf \/var\/lib\/apt\/lists\/\*/m,
  );
  expect(match).not.toBeNull();
  return match![0].replace(/^RUN\s+/, "").replace(/\\\n/g, " ");
}

function extractHermesInstallCommand(dockerfile: string): string {
  const match = dockerfile.match(
    /RUN\s+set -eu;[\s\S]*?ln -sf \/opt\/hermes\/\.venv\/bin\/hermes-acp \/usr\/local\/bin\/hermes-acp/m,
  );
  expect(match).not.toBeNull();
  return match![0].replace(/^RUN\s+/, "").replace(/\\\n/g, " ");
}

function runLoggedShell(command: string, tmp: string) {
  const logPath = path.join(tmp, "calls.log");
  const scriptPath = path.join(tmp, "run-hermes-apt-layer.sh");
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(logPath)}`,
    'apt-get() { printf "apt-get %s\\n" "$*" >> "$call_log"; }',
    command,
  ].join("\n");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
  const calls = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
  return { result, calls };
}

function runHermesInstallLayer(
  command: string,
  tmp: string,
  opts: { whatsappBridge?: "lockfile" | "package-json" } = {},
) {
  const fixture = path.join(tmp, "hermes");
  const logPath = path.join(tmp, "calls.log");
  const scriptPath = path.join(tmp, "run-hermes-install-layer.sh");
  fs.mkdirSync(path.join(fixture, "web"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(fixture, "web", "package-lock.json"), "{}\n");
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
    'export HERMES_UV_EXTRAS="messaging"',
    command,
  ].join("\n");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
  const calls = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
  return { result, calls };
}

describe("Hermes share mount package parity (#2947)", () => {
  it("requests gnupg, procps, e2fsprogs, and openssh-sftp-server from the Hermes base apt layer", () => {
    const dockerfile = fs.readFileSync(HERMES_DOCKERFILE_BASE, "utf-8");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-share-apt-"));
    const lists = path.join(tmp, "apt-lists");
    fs.mkdirSync(lists);

    try {
      const command = extractAptInstallCommand(dockerfile).replaceAll("/var/lib/apt/lists", lists);
      const { result, calls } = runLoggedShell(command, tmp);

      expect(result.status).toBe(0);
      expect(calls).toContain("apt-get update");
      expect(calls).toContain("gnupg=2.4.7-21+deb13u1");
      expect(calls).toContain("procps=2:4.0.4-9");
      expect(calls).toContain("e2fsprogs=1.47.2-3+b11");
      expect(calls).toContain("openssh-sftp-server=1:10.0p1-7+deb13u4");
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
