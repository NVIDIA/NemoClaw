// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { dockerRunCommandBetween, runLoggedDockerShell } from "../../helpers/dockerfile-run-shell";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const HERMES_DOCKERFILE = path.join(ROOT, "agents", "hermes", "Dockerfile");

function dashboardBuildCommand(hermesRoot: string, rootCache: string): string {
  const dockerfile = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
  return dockerRunCommandBetween(
    dockerfile,
    "# Published base images can lag Dockerfile.base",
    "# Harden: remove unnecessary build tools",
  )
    .replaceAll("/opt/hermes", hermesRoot)
    .replaceAll("/root/.npm", path.join(rootCache, "npm"))
    .replaceAll("/root/.cache/electron", path.join(rootCache, "electron"))
    .replaceAll("/root/.cache/node-gyp", path.join(rootCache, "node-gyp"))
    .replaceAll("/root/.cache/uv", path.join(rootCache, "uv"));
}

describe("Hermes dashboard provisioning", () => {
  it("prebuilds the dashboard bundle from a root workspace lockfile in stale bases", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-workspace-"));
    const hermesRoot = path.join(tmp, "hermes");
    const hermesWebDir = path.join(hermesRoot, "web");
    const hermesWebDist = path.join(hermesRoot, "hermes_cli", "web_dist");
    const rootCache = path.join(tmp, "root-cache");
    fs.mkdirSync(hermesWebDir, { recursive: true });
    fs.writeFileSync(path.join(hermesRoot, "package-lock.json"), '{"packages":{"web":{}}}\n');
    fs.writeFileSync(path.join(hermesWebDir, "package.json"), "{}\n");
    ["npm", "electron", "node-gyp", "uv"].forEach((cache) => {
      const cachePath = path.join(rootCache, cache);
      fs.mkdirSync(cachePath, { recursive: true });
      fs.writeFileSync(path.join(cachePath, "build-only-cache"), "unused after image assembly\n");
    });

    try {
      const { result, calls } = runLoggedDockerShell(
        dashboardBuildCommand(hermesRoot, rootCache),
        tmp,
        [
          'npm() { printf "npm %s\\n" "$*" >> "$call_log"; if [ -n "${hermes_web_dist:-}" ] && [ "${1:-}" = "run" ] && [ "${2:-}" = "build" ]; then mkdir -p "$hermes_web_dist"; fi; }',
        ],
      );

      expect(result.status, result.stderr).toBe(0);
      expect(calls).toContain(`npm ci --prefix ${hermesRoot}`);
      expect(calls).toContain(`npm run build --prefix ${hermesRoot} --workspace web`);
      expect(calls).toContain(`npm ci --omit=dev --workspaces=false --prefix ${hermesRoot}`);
      expect(fs.existsSync(hermesWebDist)).toBe(true);
      ["npm", "electron", "node-gyp", "uv"].forEach((cache) => {
        expect(() => fs.lstatSync(path.join(rootCache, cache))).toThrow();
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects stale dashboard sources that are missing pinned lockfile coverage", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-dashboard-unpinned-"));
    const hermesRoot = path.join(tmp, "hermes");
    const hermesWebDir = path.join(hermesRoot, "web");
    const rootCache = path.join(tmp, "root-cache");
    fs.mkdirSync(hermesWebDir, { recursive: true });
    fs.writeFileSync(path.join(hermesRoot, "package-lock.json"), "{}\n");
    fs.writeFileSync(path.join(hermesWebDir, "package.json"), "{}\n");

    try {
      const { result, calls } = runLoggedDockerShell(
        dashboardBuildCommand(hermesRoot, rootCache),
        tmp,
        ['npm() { printf "npm %s\\n" "$*" >> "$call_log"; }'],
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not covered by a pinned lockfile");
      expect(calls).toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
