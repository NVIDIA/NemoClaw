// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function boundary(): PortableOnboardRetirementBoundary {
  const stateDir = path.join(homeDir, ".nemoclaw");
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

    await expect(
      withPortableOnboardRetirementBoundary(boundary(), () => "onboarded", deps),
    ).rejects.toThrow(/Unsafe portable authority directory/);
  });

  it("names the failed property and its remedy when the refusal stands", async () => {
    const directory = makePortableConfigDir(0o755);
    writeLifecycleReceipt();

    await expect(
      withPortableOnboardRetirementBoundary(boundary(), () => "onboarded", deps),
    ).rejects.toThrow(
      `Unsafe portable authority directory: ${directory}. The directory must be owner-private (mode 0700) but is 0755. Run \`chmod 700 '${directory}'\`, or remove it if this host runs no portable install.`,
    );
  });

  it("keeps the remedy runnable when the home path contains whitespace", async () => {
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

  it("inspects the directory after a completed run that owns a lifecycle receipt", async () => {
    makePortableConfigDir(0o755);
    writeLifecycleReceipt();

    await expect(
      supersedePortableRetirementAfterCompletedOnboard(boundary(), "default", deps),
    ).rejects.toThrow(/Unsafe portable authority directory/);
  });

  it("still rejects a staged portable-uninstall artifact on a portable host", async () => {
    const directory = makePortableConfigDir(0o700);
    fs.writeFileSync(path.join(directory, ".containers.conf.portable-uninstall-a1.cleanup"), "", {
      mode: 0o600,
    });
    writeLifecycleReceipt();

    await expect(
      withPortableOnboardRetirementBoundary(boundary(), () => "onboarded", deps),
    ).rejects.toThrow(/unknown portable uninstall artifact/);
  });
});
