// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { dockerRunCommandBetween } from "./helpers/hermes-dockerfile-run";

const ROOT = path.resolve(import.meta.dirname, "..");
const HERMES_DOCKERFILE = path.join(ROOT, "agents", "hermes", "Dockerfile");

interface LoggedDockerShellResult {
  calls: string;
  result: SpawnSyncReturns<string>;
}

function runLoggedDockerShell(
  command: string,
  tmp: string,
  functionDefs: string[] = [],
): LoggedDockerShellResult {
  const logPath = path.join(tmp, "calls.log");
  fs.rmSync(logPath, { force: true });
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `call_log=${JSON.stringify(logPath)}`,
    ...functionDefs,
    command,
  ].join("\n");
  const scriptPath = path.join(tmp, "run-docker-block.sh");
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
  const calls = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
  return { result, calls };
}

function dashboardBuildCommand(hermesRoot: string): string {
  const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
  return dockerRunCommandBetween(
    dockerfile,
    "# Published base images can lag Dockerfile.base",
    "# Harden: remove unnecessary build tools",
  ).replaceAll("/opt/hermes", hermesRoot);
}

describe("Hermes dashboard provisioning", () => {
  it("prebuilds the dashboard bundle from a root workspace lockfile in stale bases", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-workspace-"));
    const hermesRoot = path.join(tmp, "hermes");
    const hermesWebDir = path.join(hermesRoot, "web");
    const hermesWebDist = path.join(hermesRoot, "hermes_cli", "web_dist");
    fs.mkdirSync(hermesWebDir, { recursive: true });
    fs.writeFileSync(path.join(hermesRoot, "package-lock.json"), '{"packages":{"web":{}}}\n');
    fs.writeFileSync(path.join(hermesWebDir, "package.json"), "{}\n");

    try {
      const { result, calls } = runLoggedDockerShell(dashboardBuildCommand(hermesRoot), tmp, [
        'npm() { printf "npm %s\\n" "$*" >> "$call_log"; if [ -n "${hermes_web_dist:-}" ] && [ "${1:-}" = "run" ] && [ "${2:-}" = "build" ]; then mkdir -p "$hermes_web_dist"; fi; }',
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(calls).toContain(`npm ci --prefix ${hermesRoot}`);
      expect(calls).toContain(`npm run build --prefix ${hermesRoot} --workspace web`);
      expect(calls).toContain(`npm ci --omit=dev --prefix ${hermesRoot}`);
      expect(fs.existsSync(hermesWebDist)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects stale dashboard sources that are missing pinned lockfile coverage", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-unpinned-"));
    const hermesRoot = path.join(tmp, "hermes");
    const hermesWebDir = path.join(hermesRoot, "web");
    fs.mkdirSync(hermesWebDir, { recursive: true });
    fs.writeFileSync(path.join(hermesRoot, "package-lock.json"), "{}\n");
    fs.writeFileSync(path.join(hermesWebDir, "package.json"), "{}\n");

    try {
      const { result, calls } = runLoggedDockerShell(dashboardBuildCommand(hermesRoot), tmp, [
        'npm() { printf "npm %s\\n" "$*" >> "$call_log"; }',
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not covered by a pinned lockfile");
      expect(calls).toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
