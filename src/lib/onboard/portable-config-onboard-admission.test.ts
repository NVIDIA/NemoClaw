// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readPortableAuthorityDirectory } from "../state/portable-uninstall-retirement";
import {
  type PortableOnboardRetirementBoundary,
  type PortableRetirementAuthorityDeps,
  supersedePortableRetirementAfterCompletedOnboard,
  withPortableOnboardRetirementBoundary,
} from "./portable-retirement-authority";

let homeDir: string;

const deps: PortableRetirementAuthorityDeps = {
  loadRegistry: () => ({ defaultSandbox: null, sandboxes: {} }),
  withLifecycleLock: async (_name, operation) => await operation(),
};

function boundary(stateDir = path.join(homeDir, ".nemoclaw")): PortableOnboardRetirementBoundary {
  return {
    homeDir,
    registryFile: path.join(stateDir, "registry.json"),
    sessionFile: path.join(stateDir, "onboard-session.json"),
    stateDir,
  };
}

function writeLifecycleReceipt(): void {
  const receipts = path.join(homeDir, ".nemoclaw/portable-demo-lifecycle");
  fs.mkdirSync(receipts, { recursive: true, mode: 0o700 });
  fs.chmodSync(receipts, 0o700);
  fs.writeFileSync(path.join(receipts, "sandbox.json"), "{}\n", { mode: 0o600 });
}

function makePortableConfigDir(mode: number): string {
  const directory = path.join(homeDir, ".config/nemoclaw/portable");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(homeDir, ".config"), 0o700);
  fs.chmodSync(path.join(homeDir, ".config/nemoclaw"), 0o700);
  fs.chmodSync(directory, mode);
  return directory;
}

function statWith(
  stat: fs.BigIntStats,
  overrides: Readonly<Record<PropertyKey, unknown>>,
): fs.BigIntStats {
  return new Proxy(stat, {
    get(target, property) {
      const value =
        property in overrides ? overrides[property] : Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-config-admission-"));
  fs.mkdirSync(path.join(homeDir, ".nemoclaw"), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(homeDir, ".nemoclaw"), 0o700);
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("ordinary onboarding against an abandoned portable configuration (#10740)", () => {
  // `mkdir -p` yields 0755 under umask 022 and 0775 under umask 002. The
  // manual test material instructs operators to run exactly that, so every
  // mode here is one a real host reaches without doing anything unusual.
  it.each([0o755, 0o775, 0o750, 0o711])(
    "admits an ordinary onboarding when the empty portable config directory is mode %s",
    async (mode) => {
      makePortableConfigDir(mode);
      const operation = vi.fn(() => "onboarded");

      await expect(
        withPortableOnboardRetirementBoundary(boundary(), operation, deps),
      ).resolves.toBe("onboarded");
      expect(operation).toHaveBeenCalledTimes(1);
    },
  );

  it("admits the post-onboard supersession pass for the same directory", async () => {
    makePortableConfigDir(0o755);

    await expect(
      supersedePortableRetirementAfterCompletedOnboard(boundary(), "default", deps),
    ).resolves.toBeUndefined();
  });

  it("leaves the abandoned directory untouched", async () => {
    const directory = makePortableConfigDir(0o755);

    await withPortableOnboardRetirementBoundary(boundary(), () => "onboarded", deps);

    expect(fs.existsSync(directory)).toBe(true);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o755);
  });

  it("still refuses the directory when the host owns a portable lifecycle receipt", async () => {
    makePortableConfigDir(0o755);
    writeLifecycleReceipt();
    const operation = vi.fn(() => "onboarded");

    await expect(
      withPortableOnboardRetirementBoundary(boundary(), operation, deps),
    ).rejects.toThrow(/Unsafe portable authority directory/);
    expect(operation).not.toHaveBeenCalled();
  });

  it("admits gateway-scoped onboarding when the host has no lifecycle receipt", async () => {
    makePortableConfigDir(0o755);
    const gatewayStateDir = path.join(homeDir, ".nemoclaw/gateways/18000");
    fs.mkdirSync(gatewayStateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(gatewayStateDir, 0o700);
    const operation = vi.fn(() => "onboarded");

    await expect(
      withPortableOnboardRetirementBoundary(boundary(gatewayStateDir), operation, deps),
    ).resolves.toBe("onboarded");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("refuses gateway-scoped onboarding when the host owns a lifecycle receipt", async () => {
    makePortableConfigDir(0o755);
    writeLifecycleReceipt();
    const gatewayStateDir = path.join(homeDir, ".nemoclaw/gateways/18000");
    const operation = vi.fn(() => "onboarded");

    await expect(
      withPortableOnboardRetirementBoundary(boundary(gatewayStateDir), operation, deps),
    ).rejects.toThrow(/Unsafe portable authority directory/);
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    { name: "state", relativePath: ".nemoclaw" },
    { name: "lifecycle receipt", relativePath: ".nemoclaw/portable-demo-lifecycle" },
  ])(
    "keeps the host $name directory owner-private during gateway-scoped onboarding",
    async ({ relativePath }) => {
      const gatewayStateDir = path.join(homeDir, ".nemoclaw/gateways/18000");
      fs.mkdirSync(gatewayStateDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(gatewayStateDir, 0o700);
      const directory = path.join(homeDir, relativePath);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o755);
      const operation = vi.fn(() => "onboarded");

      await expect(
        withPortableOnboardRetirementBoundary(boundary(gatewayStateDir), operation, deps),
      ).rejects.toThrow(`Unsafe portable authority directory: ${directory}.`);
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it("names the failed property and its remedy when the refusal stands", async () => {
    const directory = makePortableConfigDir(0o755);
    writeLifecycleReceipt();

    await expect(
      withPortableOnboardRetirementBoundary(boundary(), () => "onboarded", deps),
    ).rejects.toThrow(
      `Unsafe portable authority directory: ${directory}. The directory must be owner-private (mode 0700) but is 0755. Run \`chmod 700 '${directory}'\`.`,
    );
  });

  it("keeps the remedy runnable when the home path contains whitespace", async () => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    const spaced = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw portable admission "));
    homeDir = spaced;
    fs.mkdirSync(path.join(homeDir, ".nemoclaw"), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(homeDir, ".nemoclaw"), 0o700);
    const directory = makePortableConfigDir(0o755);
    writeLifecycleReceipt();

    await expect(
      withPortableOnboardRetirementBoundary(boundary(), () => "onboarded", deps),
    ).rejects.toThrow(`chmod 700 '${directory}'`);
    expect(directory).toContain(" ");
  });

  it.each([
    { name: "state", relativePath: ".nemoclaw" },
    { name: "lifecycle receipt", relativePath: ".nemoclaw/portable-demo-lifecycle" },
  ])("does not recommend deleting the $name authority directory (#10740)", ({ relativePath }) => {
    const directory = path.join(homeDir, relativePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o755);
    let caught: unknown;

    try {
      readPortableAuthorityDirectory(directory, false);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("chmod 700");
    expect((caught as Error).message).not.toContain("remove");
  });

  it.each([
    {
      name: "missing user identity",
      expected: "Run NemoClaw in a process that reports a current user id.",
      before: (stat: fs.BigIntStats) => stat,
      named: (stat: fs.BigIntStats) => stat,
      uid: undefined,
    },
    {
      name: "non-directory path",
      expected: "Use a current-user directory at this path with mode 0700.",
      before: (stat: fs.BigIntStats) => statWith(stat, { isDirectory: () => false }),
      named: (stat: fs.BigIntStats) => stat,
      uid: process.getuid?.(),
    },
    {
      name: "symbolic link",
      expected:
        "Use a current-user directory at this path with mode 0700; symbolic links are not accepted.",
      before: (stat: fs.BigIntStats) => stat,
      named: (stat: fs.BigIntStats) => statWith(stat, { isSymbolicLink: () => true }),
      uid: process.getuid?.(),
    },
    {
      name: "concurrent path change",
      expected: "Retry after other processes stop changing this path.",
      before: (stat: fs.BigIntStats) => stat,
      named: (stat: fs.BigIntStats) => statWith(stat, { ctimeNs: stat.ctimeNs + 1n }),
      uid: process.getuid?.(),
    },
    {
      name: "different owner",
      expected:
        "Run NemoClaw as the directory owner, or correct the directory owner before retrying.",
      before: (stat: fs.BigIntStats) => statWith(stat, { uid: stat.uid + 1n }),
      named: (stat: fs.BigIntStats) => statWith(stat, { uid: stat.uid + 1n }),
      uid: process.getuid?.(),
    },
    {
      name: "unlinked directory",
      expected: "Restore a current-user directory with mode 0700, then retry.",
      before: (stat: fs.BigIntStats) => statWith(stat, { nlink: 0n }),
      named: (stat: fs.BigIntStats) => statWith(stat, { nlink: 0n }),
      uid: process.getuid?.(),
    },
  ])("gives a safe next step for a $name authority failure", ({ expected, before, named, uid }) => {
    const directory = path.join(homeDir, ".nemoclaw");
    const stat = fs.statSync(directory, { bigint: true });
    vi.spyOn(process, "getuid").mockReturnValue(uid as never);
    vi.spyOn(fs, "fstatSync").mockReturnValue(before(stat));
    vi.spyOn(fs, "lstatSync").mockReturnValue(named(stat));

    expect(() => readPortableAuthorityDirectory(directory, true)).toThrow(expected);
  });

  it("inspects the directory after a completed run that owns a lifecycle receipt", async () => {
    makePortableConfigDir(0o755);
    writeLifecycleReceipt();

    await expect(
      supersedePortableRetirementAfterCompletedOnboard(boundary(), "default", deps),
    ).rejects.toThrow(/Unsafe portable authority directory/);
  });

  it("admits completed gateway-scoped onboarding when the host has no lifecycle receipt", async () => {
    makePortableConfigDir(0o755);
    const gatewayStateDir = path.join(homeDir, ".nemoclaw/gateways/18000");

    await expect(
      supersedePortableRetirementAfterCompletedOnboard(boundary(gatewayStateDir), "default", deps),
    ).resolves.toBeUndefined();
  });

  it("refuses completed gateway-scoped onboarding when the host owns a lifecycle receipt", async () => {
    makePortableConfigDir(0o755);
    writeLifecycleReceipt();
    const gatewayStateDir = path.join(homeDir, ".nemoclaw/gateways/18000");

    await expect(
      supersedePortableRetirementAfterCompletedOnboard(boundary(gatewayStateDir), "default", deps),
    ).rejects.toThrow(/Unsafe portable authority directory/);
  });

  it("still rejects a staged portable-uninstall artifact on a portable host", async () => {
    const directory = makePortableConfigDir(0o700);
    fs.writeFileSync(path.join(directory, ".containers.conf.portable-uninstall-a1.cleanup"), "", {
      mode: 0o600,
    });
    writeLifecycleReceipt();
    const operation = vi.fn(() => "onboarded");

    await expect(
      withPortableOnboardRetirementBoundary(boundary(), operation, deps),
    ).rejects.toThrow(/unknown portable uninstall artifact/);
    expect(operation).not.toHaveBeenCalled();
  });
});
