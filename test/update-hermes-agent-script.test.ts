// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "update-hermes-agent.sh");
const TARGET_TAG = "v2026.6.19";

const CURRENT_INSTALLED_BASE = [
  "# Calver tag v2026.6.5 = Hermes Agent v0.16.0.",
  "ARG HERMES_VERSION=v2026.6.5",
  "ARG HERMES_SEMVER=0.16.0",
  "ARG HERMES_TARBALL_SHA256=oldsha",
  "ARG HERMES_NPM_INTEGRITY=sha512-old",
  "",
].join("\n");

const CURRENT_INSTALLED_DOCKERFILE = [
  "COPY agents/hermes/validate-env-secret-boundary.py /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py",
  "COPY agents/hermes/seed-dashboard-config.py /usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py",
  "RUN HERMES_HOME=/sandbox/.hermes /usr/local/bin/hermes doctor --fix \\",
  "    && node --experimental-strip-types /opt/nemoclaw-hermes-config/generate-config.ts",
  "RUN mkdir -p /sandbox/.hermes/dashboard-home",
  "",
].join("\n");

function writeInstalledHermesCopy(baseDockerfile: string, baseText = CURRENT_INSTALLED_BASE) {
  fs.mkdirSync(path.dirname(baseDockerfile), { recursive: true });
  fs.writeFileSync(baseDockerfile, baseText);
  fs.writeFileSync(
    path.join(path.dirname(baseDockerfile), "Dockerfile"),
    CURRENT_INSTALLED_DOCKERFILE,
  );
}

describe("scripts/update-hermes-agent.sh", () => {
  it("keeps installed-copy scanning opt-in unless rebuild needs it", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-home-"));
    const installedDockerfile = path.join(
      tmpHome,
      ".nemoclaw",
      "source",
      "agents",
      "hermes",
      "Dockerfile.base",
    );
    writeInstalledHermesCopy(installedDockerfile);

    const run = (...args: string[]) =>
      spawnSync("bash", [SCRIPT, "--tag", TARGET_TAG, "--check", ...args], {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpHome,
          NEMOCLAW_SOURCE_ROOT: undefined,
        },
        timeout: 5000,
      });

    try {
      const defaultCheck = run();
      expect(defaultCheck.status).toBe(0);
      expect(defaultCheck.stdout).toContain("Installed-copy scan skipped");

      const explicitScan = run("--update-installed-copies");
      expect(explicitScan.status).toBe(1);
      expect(explicitScan.stdout).toContain("STALE: installed copy");
      expect(explicitScan.stdout).toContain(installedDockerfile);

      const rebuildCheck = run("--rebuild");
      expect(rebuildCheck.status).toBe(1);
      expect(rebuildCheck.stdout).toContain("STALE: installed copy");
      expect(rebuildCheck.stdout).toContain(installedDockerfile);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("refuses unsafe installed-copy rewrite candidates", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-unsafe-"));
    const sourceRoot = path.join(tmpHome, "source-root");
    const symlinkRoot = path.join(tmpHome, "symlink-root");
    const symlinkTarget = path.join(tmpHome, "target-root");
    const hardlinkedDockerfile = path.join(sourceRoot, "agents", "hermes", "Dockerfile.base");
    const symlinkDockerfile = path.join(sourceRoot, "aliased", "Dockerfile.base");
    fs.mkdirSync(path.dirname(hardlinkedDockerfile), { recursive: true });
    fs.mkdirSync(path.dirname(symlinkDockerfile), { recursive: true });
    fs.mkdirSync(symlinkTarget, { recursive: true });
    fs.writeFileSync(hardlinkedDockerfile, "ARG HERMES_VERSION=v2026.6.5\n");
    fs.linkSync(hardlinkedDockerfile, path.join(sourceRoot, "Dockerfile.hardlink"));
    fs.symlinkSync(hardlinkedDockerfile, symlinkDockerfile);
    fs.symlinkSync(symlinkTarget, symlinkRoot);

    const run = (root: string) =>
      spawnSync("bash", [SCRIPT, "--tag", TARGET_TAG, "--check", "--update-installed-copies"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpHome,
          NEMOCLAW_SOURCE_ROOT: root,
        },
        timeout: 5000,
      });

    try {
      const unsafeCandidates = run(sourceRoot);
      expect(unsafeCandidates.status).toBe(0);
      expect(unsafeCandidates.stdout).not.toContain("STALE: installed copy");
      expect(unsafeCandidates.stderr).toContain("SKIP unsafe installed copy");
      expect(fs.readFileSync(hardlinkedDockerfile, "utf-8")).toContain("v2026.6.5");

      const unsafeRoot = run(symlinkRoot);
      expect(unsafeRoot.status).toBe(0);
      expect(unsafeRoot.stderr).toContain("SKIP unsafe installed-copy root");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("refuses legacy installed copies missing HERMES_SEMVER/HERMES_NPM_INTEGRITY and current integration markers without mutating them", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-update-legacy-"));
    const installedDockerfile = path.join(
      tmpHome,
      ".nemoclaw",
      "source",
      "agents",
      "hermes",
      "Dockerfile.base",
    );
    const legacyBase = "ARG HERMES_VERSION=v2026.6.5\nARG HERMES_TARBALL_SHA256=oldsha\n";
    const legacyDockerfile = "# legacy Hermes Dockerfile without v0.17 integration markers\n";
    fs.mkdirSync(path.dirname(installedDockerfile), { recursive: true });
    fs.writeFileSync(installedDockerfile, legacyBase);
    fs.writeFileSync(path.join(path.dirname(installedDockerfile), "Dockerfile"), legacyDockerfile);

    const run = spawnSync(
      "bash",
      [SCRIPT, "--tag", TARGET_TAG, "--check", "--update-installed-copies"],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpHome,
          NEMOCLAW_SOURCE_ROOT: undefined,
        },
        timeout: 5000,
      },
    );

    try {
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("INVALID: installed copy");
      expect(run.stdout).toContain("legacy Hermes source schema");
      expect(run.stdout).toContain("refresh or reinstall");
      expect(fs.readFileSync(installedDockerfile, "utf-8")).toBe(legacyBase);
      expect(
        fs.readFileSync(path.join(path.dirname(installedDockerfile), "Dockerfile"), "utf-8"),
      ).toBe(legacyDockerfile);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
