// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DOCKERFILE = path.join(import.meta.dirname, "..", "Dockerfile");

function dockerRunCommandBetween(startMarker: string, endMarker: string): string {
  const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
  const start = dockerfile.indexOf(startMarker);
  const end = dockerfile.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Expected Dockerfile block between ${startMarker} and ${endMarker}`);
  }
  const runIndex = dockerfile.indexOf("RUN ", start);
  if (runIndex === -1 || runIndex > end) {
    throw new Error(`Expected RUN instruction after ${startMarker}`);
  }
  const command = dockerfile
    .slice(runIndex, end)
    .trim()
    .replace(/^RUN\s+/, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ")
    .replace(/\\\s*$/, "");
  return command;
}

function runOpenClawUpgradeBlock(currentVersion: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-upgrade-"));
  const blueprint = path.join(tmp, "blueprint.yaml");
  const log = path.join(tmp, "calls.log");
  fs.writeFileSync(blueprint, 'min_openclaw_version: "2026.4.2"\n');
  const command = dockerRunCommandBetween(
    "# The minimum required version comes from nemoclaw-blueprint/blueprint.yaml",
    "# Patch OpenClaw media fetch",
  ).replaceAll("/opt/nemoclaw-blueprint/blueprint.yaml", blueprint);
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(log)}`,
    `openclaw() { if [ "\${1:-}" = "--version" ]; then printf 'openclaw ${currentVersion}\\n'; else return 127; fi; }`,
    'npm() { printf "npm %s\\n" "$*" >> "$call_log"; }',
    'command() { if [ "${1:-}" = "-v" ] && [ "${2:-}" = "codex-acp" ]; then return 0; fi; builtin command "$@"; }',
    command,
  ].join("\n");
  const scriptPath = path.join(tmp, "run.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "";
  fs.rmSync(tmp, { recursive: true, force: true });
  return { result, calls };
}

describe("fetch-guard patch regression guard", () => {
  it("upgrades stale OpenClaw from the blueprint minimum and leaves current installs alone", () => {
    const stale = runOpenClawUpgradeBlock("2026.3.11");
    expect(stale.result.status).toBe(0);
    expect(stale.result.stdout).toContain("upgrading to 2026.4.2");
    expect(stale.calls).toContain(
      "npm install -g --no-audit --no-fund --no-progress openclaw@2026.4.2",
    );

    const current = runOpenClawUpgradeBlock("2026.4.2");
    expect(current.result.status).toBe(0);
    expect(current.result.stdout).toContain("is current (>= 2026.4.2)");
    expect(current.calls).not.toContain("openclaw@2026.4.2");
  });

  it("rewrites strict media fetch exports and makes proxy validation sandbox-aware", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fetch-guard-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}\n');
    const modulePath = path.join(dist, "fetch-guard-test.js");
    fs.writeFileSync(
      modulePath,
      [
        "const withStrictGuardedFetchMode = Symbol('strict');",
        "const withTrustedEnvProxyGuardedFetchMode = Symbol('trusted');",
        "globalThis.proxyChecks = [];",
        "async function assertExplicitProxyAllowed(proxyUrl) { globalThis.proxyChecks.push(proxyUrl); throw new Error('proxy rejected'); }",
        "globalThis.assertExplicitProxyAllowed = assertExplicitProxyAllowed;",
        "export { withStrictGuardedFetchMode as a, withTrustedEnvProxyGuardedFetchMode as b };",
        "",
      ].join("\n"),
    );
    const command = dockerRunCommandBetween(
      "# Patch OpenClaw media fetch for proxy-only sandbox",
      "# --- Patch 3: follow symlinks in plugin-install path checks (#2203)",
    ).replace("/usr/local/lib/node_modules/openclaw/dist", dist);
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    const sedWrapper = path.join(fakeBin, "sed");
    fs.writeFileSync(
      sedWrapper,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [ "${1:-}" = "-i" ] && [ "${2:-}" = "-E" ]; then',
        "  expr=$3",
        "  shift 3",
        '  for file in "$@"; do perl -0pi -e "$expr" "$file"; done',
        "  exit 0",
        "fi",
        'exec /usr/bin/sed "$@"',
      ].join("\n"),
      { mode: 0o755 },
    );
    const scriptPath = path.join(tmp, "patch.sh");
    fs.writeFileSync(scriptPath, ["#!/usr/bin/env bash", command].join("\n"), { mode: 0o700 });

    try {
      const patch = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH || ""}` },
        timeout: 5000,
      });
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      const verify = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const exports = await import(${JSON.stringify(modulePath)});
if (exports.a !== exports.b) throw new Error('strict export was not redirected to trusted env proxy mode');
await globalThis.assertExplicitProxyAllowed('http://10.200.0.1:3128');
if (globalThis.proxyChecks.length !== 0) throw new Error('sandbox proxy validation did not bypass target-policy checks');`,
        ],
        { encoding: "utf-8", env: { ...process.env, OPENSHELL_SANDBOX: "1" }, timeout: 5000 },
      );
      expect(verify.status).toBe(0);
      expect(verify.stderr).toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
