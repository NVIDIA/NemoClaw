// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  detectInstallType,
  getLatestNemoClawVersionFromGitLatestTag,
  NEMOCLAW_UPDATE_COMMAND,
  runUpdateAction,
} from "./update";

describe("runUpdateAction", () => {
  it("--check reports update availability without running the installer", async () => {
    const spawnSyncImpl = vi.fn();
    const log = vi.fn();

    const result = await runUpdateAction(
      { check: true },
      {
        currentVersion: () => "0.1.0",
        getLatestVersion: () => "0.2.0",
        isSourceCheckout: () => false,
        log,
        spawnSyncImpl,
      },
    );

    expect(result).toEqual(
      expect.objectContaining({
        ranInstaller: false,
        status: 0,
        updateAvailable: true,
      }),
    );
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Current NemoClaw version: 0.1.0"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Latest maintained version: 0.2.0"));
  });

  it("--check renders NemoHermes branding and installer guidance when the Hermes alias is active", async () => {
    const log = vi.fn();

    const result = await runUpdateAction(
      { check: true },
      {
        currentVersion: () => "0.1.0",
        env: { ...process.env, NEMOCLAW_AGENT: "hermes" },
        getLatestVersion: () => "0.2.0",
        isSourceCheckout: () => false,
        log,
        spawnSyncImpl: vi.fn(),
      },
    );

    expect(result.status).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Current NemoHermes version: 0.1.0"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_AGENT=hermes bash"),
    );
  });

  it("does not run the installer for developer source checkouts", async () => {
    const error = vi.fn();
    const spawnSyncImpl = vi.fn();

    const result = await runUpdateAction(
      { yes: true },
      {
        currentVersion: () => "0.1.0",
        error,
        getLatestVersion: () => "0.2.0",
        isSourceCheckout: () => true,
        log: vi.fn(),
        spawnSyncImpl,
      },
    );

    expect(result.status).toBe(1);
    expect(result.ranInstaller).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("source checkout"));
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });

  it("allows the installer-managed clone under ~/.nemoclaw/source", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-update-home-"));
    try {
      const rootDir = path.join(home, ".nemoclaw", "source");
      fs.mkdirSync(path.join(rootDir, ".git"), { recursive: true });
      const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: "", stderr: "", signal: null } as never));

      const result = await runUpdateAction(
        { yes: true },
        {
          currentVersion: () => "0.1.0",
          env: { ...process.env, HOME: home },
          getLatestVersion: () => "0.2.0",
          log: vi.fn(),
          rootDir,
          spawnSyncImpl,
        },
      );

      expect(result.installType).toBe("installer");
      expect(result.status).toBe(0);
      expect(result.ranInstaller).toBe(true);
    } finally {
      fs.rmSync(home, { force: true, recursive: true });
    }
  });

  it("prompts before running the maintained installer", async () => {
    const prompt = vi.fn(async () => "yes");
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: "", stderr: "", signal: null } as never));

    const result = await runUpdateAction(
      {},
      {
        currentVersion: () => "0.1.0",
        getLatestVersion: () => "0.2.0",
        isSourceCheckout: () => false,
        log: vi.fn(),
        prompt,
        spawnSyncImpl,
      },
    );

    expect(result.status).toBe(0);
    expect(result.ranInstaller).toBe(true);
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("Run the maintained NemoClaw installer"));
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "bash",
      ["-o", "pipefail", "-lc", NEMOCLAW_UPDATE_COMMAND],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("--yes runs the maintained installer without prompting", async () => {
    const prompt = vi.fn(async () => "no");
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: "", stderr: "", signal: null } as never));

    const result = await runUpdateAction(
      { yes: true },
      {
        currentVersion: () => "0.1.0",
        getLatestVersion: () => "0.2.0",
        isSourceCheckout: () => false,
        log: vi.fn(),
        prompt,
        spawnSyncImpl,
      },
    );

    expect(result.status).toBe(0);
    expect(result.ranInstaller).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("refuses to prompt in non-interactive mode without --yes", async () => {
    const prompt = vi.fn(async () => "yes");
    const spawnSyncImpl = vi.fn();

    const result = await runUpdateAction(
      {},
      {
        currentVersion: () => "0.1.0",
        env: { ...process.env, NEMOCLAW_NON_INTERACTIVE: "1" },
        error: vi.fn(),
        getLatestVersion: () => "0.2.0",
        isSourceCheckout: () => false,
        log: vi.fn(),
        prompt,
        spawnSyncImpl,
      },
    );

    expect(result.status).toBe(1);
    expect(prompt).not.toHaveBeenCalled();
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });

  it("does not pass shell startup or release override env into the installer shell", async () => {
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: "", stderr: "", signal: null } as never));

    await runUpdateAction(
      { yes: true },
      {
        currentVersion: () => "0.1.0",
        env: {
          ...process.env,
          BASH_ENV: "/tmp/review-bash-env",
          ENV: "/tmp/review-env",
          NEMOCLAW_INSTALL_REF: "refs/heads/not-maintained",
          NEMOCLAW_INSTALL_TAG: "not-maintained",
        },
        getLatestVersion: () => "0.2.0",
        isSourceCheckout: () => false,
        log: vi.fn(),
        spawnSyncImpl,
      },
    );

    const calls = spawnSyncImpl.mock.calls as unknown as Array<
      [string, readonly string[], { env?: NodeJS.ProcessEnv }]
    >;
    const options = calls[0]?.[2];
    expect(options?.env?.BASH_ENV).toBeUndefined();
    expect(options?.env?.ENV).toBeUndefined();
    expect(options?.env?.NEMOCLAW_INSTALL_REF).toBeUndefined();
    expect(options?.env?.NEMOCLAW_INSTALL_TAG).toBeUndefined();
  });

  it("preserves the Hermes agent selection while sanitizing installer env", async () => {
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: "", stderr: "", signal: null } as never));
    const log = vi.fn();

    await runUpdateAction(
      { yes: true },
      {
        currentVersion: () => "0.1.0",
        env: {
          ...process.env,
          BASH_ENV: "/tmp/review-bash-env",
          NEMOCLAW_AGENT: "hermes",
          NEMOCLAW_INSTALL_REF: "refs/heads/not-maintained",
        },
        getLatestVersion: () => "0.2.0",
        isSourceCheckout: () => false,
        log,
        spawnSyncImpl,
      },
    );

    const calls = spawnSyncImpl.mock.calls as unknown as Array<
      [string, readonly string[], { env?: NodeJS.ProcessEnv }]
    >;
    const options = calls[0]?.[2];
    expect(options?.env?.NEMOCLAW_AGENT).toBe("hermes");
    expect(options?.env?.BASH_ENV).toBeUndefined();
    expect(options?.env?.NEMOCLAW_INSTALL_REF).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Running maintained NemoHermes installer"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Installer completed. Run `nemohermes upgrade-sandboxes --check`"),
    );
  });

  it("skips installer when package install is already current", async () => {
    const spawnSyncImpl = vi.fn();

    const result = await runUpdateAction(
      { yes: true },
      {
        currentVersion: () => "0.2.0",
        getLatestVersion: () => "0.2.0",
        isSourceCheckout: () => false,
        log: vi.fn(),
        spawnSyncImpl,
      },
    );

    expect(result.status).toBe(0);
    expect(result.ranInstaller).toBe(false);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });
});

describe("detectInstallType", () => {
  it("classifies arbitrary git roots as source and installer roots as managed installs", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-update-detect-"));
    try {
      const managedRoot = path.join(home, ".nemoclaw", "source");
      const sourceRoot = path.join(home, "dev", "NemoClaw");
      const packageRoot = path.join(home, "package");
      fs.mkdirSync(path.join(managedRoot, ".git"), { recursive: true });
      fs.mkdirSync(path.join(sourceRoot, ".git"), { recursive: true });
      fs.mkdirSync(packageRoot, { recursive: true });

      expect(detectInstallType(managedRoot, { ...process.env, HOME: home })).toBe("installer");
      expect(detectInstallType(sourceRoot, { ...process.env, HOME: home })).toBe("source");
      expect(detectInstallType(packageRoot, { ...process.env, HOME: home })).toBe("package");
    } finally {
      fs.rmSync(home, { force: true, recursive: true });
    }
  });
});

describe("getLatestNemoClawVersionFromGitLatestTag", () => {
  it("resolves the version tag that points at the maintained latest tag", () => {
    const spawnSyncImpl = vi.fn(() => ({
      status: 0,
      stdout: [
        "abc123\trefs/tags/latest",
        "older\trefs/tags/v0.0.36",
        "abc123\trefs/tags/v0.0.37",
        "future\trefs/tags/v0.1.0",
      ].join("\n"),
      stderr: "",
      signal: null,
    }) as never);

    expect(getLatestNemoClawVersionFromGitLatestTag({ spawnSyncImpl })).toBe("0.0.37");
  });
});
