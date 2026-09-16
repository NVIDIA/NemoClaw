// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INSTALLER_PAYLOAD } from "../helpers/installer-sourced-env";

const repository = path.resolve(import.meta.dirname, "../..");
const roots: string[] = [];
const sdkName = "@nvidia/openshell-sdk";
const transportNames = ["@bufbuild/protobuf", "@connectrpc/connect", "@connectrpc/connect-node"];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-install-"));
  roots.push(root);
  const checkedIn = JSON.parse(fs.readFileSync(path.join(repository, "package-lock.json"), "utf8"));
  const names = [...transportNames, sdkName];
  const manifest = {
    name: "sdk-install-fixture",
    version: "1.0.0",
    optionalDependencies: Object.fromEntries(
      names.map((name) => [name, checkedIn.packages[`node_modules/${name}`].version]),
    ),
  };
  const lockfile = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": manifest,
      ...Object.fromEntries(
        names.map((name) => [`node_modules/${name}`, checkedIn.packages[`node_modules/${name}`]]),
      ),
    },
  });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, "package-lock.json"), lockfile);
  const archive = `scripts/vendor/openshell-sdk/nvidia-openshell-sdk-${manifest.optionalDependencies[sdkName]}.tgz`;
  for (const entry of [
    "scripts/lib/install-openshell-sdk.mts",
    "scripts/lib/reviewed-npm-archive.mts",
    archive,
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, entry)), { recursive: true });
    fs.copyFileSync(path.join(repository, entry), path.join(root, entry));
  }
  // Public transport dependencies are already installed by the preceding npm step.
  // The SDK is deliberately absent, and the repair has no network or cache access.
  for (const name of transportNames) {
    fs.cpSync(path.join(repository, "node_modules", name), path.join(root, "node_modules", name), {
      recursive: true,
      dereference: true,
    });
  }
  return { root, archive: path.join(root, archive), lockfile };
}

function finishInstall(root: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `
set -euo pipefail
source "$INSTALLER_PAYLOAD" >/dev/null
NEMOCLAW_SOURCE_ROOT="$SDK_FIXTURE_ROOT"
_NEMOCLAW_CLI_INSTALL_MODE=source
NEMOCLAW_DEFER_OPENSHELL_INSTALL=1
refresh_path() { :; }
ensure_nemoclaw_shim() { :; }
finish_nemoclaw_install
printf 'INSTALL_COMPLETE\\n'
`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
        HOME: root,
        TMPDIR: root,
        INSTALLER_PAYLOAD,
        SDK_FIXTURE_ROOT: root,
        NPM_CONFIG_USERCONFIG: "/dev/null",
        NPM_CONFIG_CACHE: path.join(root, "empty-cache"),
        NPM_CONFIG_OFFLINE: "true",
        NPM_CONFIG_OMIT: "optional",
        ...extraEnv,
      },
    },
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("installer OpenShell SDK repair", () => {
  it("installs the pinned SDK without registry credentials and preserves the lockfile", () => {
    const { root, lockfile } = fixture();
    const result = finishInstall(root);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("INSTALL_COMPLETE");
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
const sdk = await import("@nvidia/openshell-sdk");
const raw = await import("@nvidia/openshell-sdk/raw");
if (typeof sdk.OpenShellClient.connect !== "function" || !raw.SandboxPolicySchema) process.exit(1);
`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(probe.status, probe.stderr).toBe(0);
    expect(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")).toBe(lockfile);

    // A healthy reused installation must not invoke npm again.
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
    const reused = finishInstall(root, {
      PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
    });
    expect(reused.status, reused.stdout + reused.stderr).toBe(0);
  });

  it.each([
    { kind: "missing", change: (archive: string) => fs.unlinkSync(archive) },
    { kind: "changed", change: (archive: string) => fs.appendFileSync(archive, "changed") },
    {
      kind: "symlink",
      change: (archive: string) => {
        fs.renameSync(archive, `${archive}.original`);
        fs.symlinkSync(`${archive}.original`, archive);
      },
    },
  ])("stops setup when the SDK archive is $kind", ({ change }) => {
    const { root, archive, lockfile } = fixture();
    change(archive);
    const result = finishInstall(root);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("INSTALL_COMPLETE");
    expect(fs.existsSync(path.join(root, "node_modules", sdkName))).toBe(false);
    expect(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")).toBe(lockfile);
  });

  it("stops setup when npm reports failure and removes the staged archive", () => {
    const { root } = fixture();
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
    const result = finishInstall(root, {
      PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("INSTALL_COMPLETE");
    expect(
      fs.readdirSync(root).filter((name) => name.startsWith("nemoclaw-openshell-sdk-")),
    ).toEqual([]);
  });

  it("stops setup when npm reports success without installing the SDK", () => {
    const { root } = fixture();
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = finishInstall(root, {
      PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("INSTALL_COMPLETE");
    expect(result.stdout + result.stderr).toContain(
      "OpenShell SDK imports failed after installation",
    );
  });
});
