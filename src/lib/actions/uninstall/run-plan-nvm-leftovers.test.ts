// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { type RunResult, runUninstallPlan } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function runNvmSweep(tmpHome: string, existing: readonly string[], removed: string[]) {
  return runUninstallPlan(
    { assumeYes: true, deleteModels: false, keepOpenShell: false },
    {
      commandExists: (command) => command !== "docker" && command !== "lsof" && command !== "pgrep",
      env: { HOME: tmpHome } as NodeJS.ProcessEnv,
      existsSync: (target) => existing.includes(String(target)),
      hasPortableRuntimeCleanup: () => false,
      isTty: false,
      log: () => {},
      resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
        gatewayName,
        gatewayPort,
        mode: "nemoclaw-managed",
        source: "packaged-service",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
      rmSync: vi.fn((target: fs.PathLike, options?: fs.RmOptions) => {
        removed.push(String(target));
        fs.rmSync(target, options);
      }),
      run: vi.fn((command, args) =>
        command === "openshell" && args[0] === "gateway" && args[1] === "list"
          ? ok(JSON.stringify([{ name: "nemoclaw" }]))
          : ok(),
      ),
      runDocker: () => ok(),
    },
  );
}

describe("uninstall NVM leftovers", () => {
  it("removes package-owned CLI bins and preserves foreign same-named entries (#9500)", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-nvm-bins-"));
    const nodeVersionsDir = path.join(tmpHome, ".nvm", "versions", "node");
    const ownedVersion = path.join(nodeVersionsDir, "v22.19.0");
    const foreignVersion = path.join(nodeVersionsDir, "v20.20.0");
    const packageDir = path.join(ownedVersion, "lib", "node_modules", "nemoclaw");
    const nestedForeignBin = path.join(ownedVersion, "lib", "node_modules", "unrelated", "bin");
    const cliNames = ["nemoclaw", "nemohermes", "nemo-deepagents"] as const;
    const declaredBins = {
      nemoclaw: "bin/nemoclaw.js",
      nemohermes: "bin/nemohermes.js",
      "nemo-deepagents": "bin/nemoclaw.js",
    } as const;
    const shims = cliNames.slice(1).map((name) => path.join(tmpHome, ".local", "bin", name));
    const ownedBins = cliNames.map((name) => path.join(ownedVersion, "bin", name));
    const foreignBins = cliNames.map((name) => path.join(foreignVersion, "bin", name));
    const kept = [
      path.join(ownedVersion, "bin", "tsc"),
      ...cliNames.map((name) => path.join(nestedForeignBin, name)),
      ...foreignBins,
    ];
    const links = [...shims, ...ownedBins, ...kept];
    links.forEach((entry) => fs.mkdirSync(path.dirname(entry), { recursive: true }));
    const packageTargets = new Set(Object.values(declaredBins));
    packageTargets.delete(declaredBins.nemohermes);
    packageTargets.forEach((relative) => {
      const target = path.join(packageDir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "#!/usr/bin/env node\n");
    });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ bin: declaredBins }));
    shims.forEach((entry) => fs.symlinkSync("/tmp/prefix/bin/cli", entry));
    const packageTarget = (entry: string) =>
      path.join(packageDir, declaredBins[path.basename(entry) as keyof typeof declaredBins]);
    ownedBins.slice(0, 2).forEach((entry) => {
      const target = packageTarget(entry);
      fs.symlinkSync(path.relative(path.dirname(entry), target), entry);
    });
    fs.linkSync(packageTarget(ownedBins[2]), ownedBins[2]);
    kept.forEach((entry) => fs.symlinkSync("/tmp/foreign-package/bin/cli", entry));
    expect(fs.lstatSync(ownedBins[1]).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(ownedBins[1])).toBe(false);

    const removed: string[] = [];
    try {
      const result = runNvmSweep(tmpHome, [...shims, nodeVersionsDir], removed);
      expect(result.exitCode).toBe(0);
      expect(links.filter((entry) => removed.includes(entry))).toEqual([...shims, ...ownedBins]);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("preserves a linked package while removing its package-owned CLI bins", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-nvm-link-"));
    const versionDir = path.join(tmpHome, ".nvm", "versions", "node", "v22.19.0");
    const packageLink = path.join(versionDir, "lib", "node_modules", "nemoclaw");
    const linkedPackage = path.join(tmpHome, "linked-nemoclaw");
    const declaredBins = {
      nemoclaw: "bin/nemoclaw.js",
      nemohermes: "bin/nemohermes.js",
      "nemo-deepagents": "bin/nemo-deepagents.js",
    } as const;
    fs.mkdirSync(path.join(linkedPackage, "bin"), { recursive: true });
    fs.mkdirSync(path.dirname(packageLink), { recursive: true });
    fs.writeFileSync(
      path.join(linkedPackage, "package.json"),
      JSON.stringify({ bin: declaredBins }),
    );
    fs.symlinkSync(linkedPackage, packageLink);
    const bins = Object.entries(declaredBins).map(([name, relativeTarget]) => {
      const packageTarget = path.join(linkedPackage, relativeTarget);
      fs.writeFileSync(packageTarget, "#!/usr/bin/env node\n");
      const bin = path.join(versionDir, "bin", name);
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(bin), path.join(packageLink, relativeTarget)), bin);
      return bin;
    });

    const removed: string[] = [];
    try {
      const nodeVersionsDir = path.join(tmpHome, ".nvm", "versions", "node");
      expect(runNvmSweep(tmpHome, [nodeVersionsDir], removed).exitCode).toBe(0);
      expect(new Set(removed)).toEqual(new Set(bins));
      bins.forEach((bin) => expect(fs.existsSync(bin)).toBe(false));
      expect(fs.readlinkSync(packageLink)).toBe(linkedPackage);
      expect(fs.existsSync(linkedPackage)).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it.each(["versions", "modules", "bin"] as const)(
    "skips an unreadable NVM %s directory without deleting its bin",
    (blockedDirectory) => {
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-nvm-unreadable-"));
      const nodeVersionsDir = path.join(tmpHome, ".nvm", "versions", "node");
      const versionDir = path.join(nodeVersionsDir, "v22.19.0");
      const modulesDir = path.join(versionDir, "lib", "node_modules");
      const packageDir = path.join(modulesDir, "nemoclaw");
      const binDir = path.join(versionDir, "bin");
      const bin = path.join(binDir, "nemoclaw");
      fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "bin", "nemoclaw.js"), "#!/usr/bin/env node\n");
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ bin: { nemoclaw: "bin/nemoclaw.js" } }),
      );
      fs.symlinkSync(path.relative(binDir, path.join(packageDir, "bin", "nemoclaw.js")), bin);
      const blocked = { versions: nodeVersionsDir, modules: modulesDir, bin: binDir }[
        blockedDirectory
      ];
      const readDirectory = fs.readdirSync.bind(fs);
      const failRead = new Map([
        [
          blocked,
          () => {
            throw Object.assign(new Error("unreadable"), { code: "EACCES" });
          },
        ],
      ]);
      const spy = vi.spyOn(fs, "readdirSync").mockImplementation(((target, options?: any) => {
        failRead.get(String(target))?.();
        return readDirectory(target, options);
      }) as typeof fs.readdirSync);
      try {
        const removed: string[] = [];
        expect(runNvmSweep(tmpHome, [nodeVersionsDir], removed).exitCode).toBe(0);
        expect(removed).not.toContain(bin);
      } finally {
        spy.mockRestore();
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    },
  );
});
