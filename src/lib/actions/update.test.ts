// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  detectInstallType,
  getMaintainedNemoClawTargetFromGitTag,
  getMaintainedNemoClawVersionFromGitTag,
  NEMOCLAW_UPDATE_COMMAND,
  runUpdateAction,
} from "./update";

const MAINTAINED_REVISION = "a".repeat(40);
const maintainedTarget = (version: string | null) => ({
  revision: MAINTAINED_REVISION,
  version,
});

describe("runUpdateAction", () => {
  it("reports update availability without running the installer for --check", async () => {
    const spawnSyncImpl = vi.fn();
    const log = vi.fn();

    const result = await runUpdateAction(
      { check: true },
      {
        currentVersion: () => "0.1.0",
        getMaintainedTarget: () => maintainedTarget("0.2.0"),
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
    expect(log).toHaveBeenCalledWith(expect.stringContaining(NEMOCLAW_UPDATE_COMMAND));
  });

  it("renders NemoHermes branding and installer guidance for --check when the Hermes alias is active", async () => {
    const log = vi.fn();

    const result = await runUpdateAction(
      { check: true },
      {
        currentVersion: () => "0.1.0",
        env: { ...process.env, NEMOCLAW_AGENT: "hermes" },
        getMaintainedTarget: () => maintainedTarget("0.2.0"),
        isSourceCheckout: () => false,
        log,
        spawnSyncImpl: vi.fn(),
      },
    );

    expect(result.status).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Current NemoHermes version: 0.1.0"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "curl -fsSL --proto '=https' --proto-redir '=https' https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_AGENT=hermes bash",
      ),
    );
  });

  it("renders NemoDeepAgents branding and installer guidance for --check when the Deep Agents alias is active", async () => {
    const log = vi.fn();

    const result = await runUpdateAction(
      { check: true },
      {
        currentVersion: () => "0.1.0",
        env: { ...process.env, NEMOCLAW_AGENT: "dcode" },
        getMaintainedTarget: () => maintainedTarget("0.2.0"),
        isSourceCheckout: () => false,
        log,
        spawnSyncImpl: vi.fn(),
      },
    );

    expect(result.status).toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Current NemoDeepAgents version: 0.1.0"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "curl -fsSL --proto '=https' --proto-redir '=https' https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_AGENT=langchain-deepagents-code bash",
      ),
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
        getMaintainedTarget: () => maintainedTarget("0.2.0"),
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
      const spawnSyncImpl = vi.fn(
        () => ({ status: 0, stdout: "", stderr: "", signal: null }) as never,
      );

      const result = await runUpdateAction(
        { yes: true },
        {
          currentVersion: () => "0.1.0",
          env: { ...process.env, HOME: home },
          getMaintainedTarget: () => maintainedTarget("0.2.0"),
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

  it("does not run the installer when already up to date without --fresh", async () => {
    const spawnSyncImpl = vi.fn();
    const log = vi.fn();

    const result = await runUpdateAction(
      { yes: true },
      {
        currentVersion: () => "0.2.0",
        getMaintainedTarget: () => maintainedTarget("0.2.0"),
        isSourceCheckout: () => false,
        log,
        spawnSyncImpl,
      },
    );

    expect(result.updateAvailable).toBe(false);
    expect(result.ranInstaller).toBe(false);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("already up to date"));
  });

  it("reinstalls even when already up to date with --fresh (#5960)", async () => {
    const spawnSyncImpl = vi.fn(
      () => ({ status: 0, stdout: "", stderr: "", signal: null }) as never,
    );
    const log = vi.fn();

    const result = await runUpdateAction(
      { fresh: true, yes: true },
      {
        currentVersion: () => "0.2.0",
        getMaintainedTarget: () => maintainedTarget("0.2.0"),
        isSourceCheckout: () => false,
        log,
        spawnSyncImpl,
      },
    );

    expect(result.updateAvailable).toBe(false);
    expect(result.ranInstaller).toBe(true);
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "bash",
      ["-o", "pipefail", "-lc", NEMOCLAW_UPDATE_COMMAND],
      expect.objectContaining({
        env: expect.objectContaining({ NEMOCLAW_REINSTALL_CLI: "1" }),
        stdio: "inherit",
      }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("reinstalling anyway (--fresh)"));
  });

  it("restricts the maintained installer fetch and redirects to HTTPS", async () => {
    const spawnSyncImpl = vi.fn(
      () => ({ status: 0, stdout: "", stderr: "", signal: null }) as never,
    );

    const result = await runUpdateAction(
      { yes: true },
      {
        currentVersion: () => "0.1.0",
        getMaintainedTarget: () => maintainedTarget("0.2.0"),
        isSourceCheckout: () => false,
        log: vi.fn(),
        spawnSyncImpl,
      },
    );

    expect(result.ranInstaller).toBe(true);
    const [command, args] = spawnSyncImpl.mock.calls[0] as unknown as [string, readonly string[]];
    expect(command).toBe("bash");
    expect(args.at(-1)).toContain("--proto '=https'");
    expect(args.at(-1)).toContain("--proto-redir '=https'");
  });

  it("refuses --fresh when the maintained tag is older than the install, even with --yes (#8306)", async () => {
    const spawnSyncImpl = vi.fn();
    const error = vi.fn();
    const log = vi.fn();

    const result = await runUpdateAction(
      { fresh: true, yes: true },
      {
        currentVersion: () => "0.0.102",
        error,
        getMaintainedTarget: () => maintainedTarget("0.0.97"),
        isSourceCheckout: () => false,
        log,
        spawnSyncImpl,
      },
    );

    expect(result.ranInstaller).toBe(false);
    expect(result.status).toBe(1);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("downgrade"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("--allow-downgrade"));
    // The old wording claimed the install was current while replacing it.
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("already up to date"));
  });

  it("preserves hyphens within prerelease identifiers when guarding downgrades (#8306)", async () => {
    const spawnSyncImpl = vi.fn();
    const error = vi.fn();

    const result = await runUpdateAction(
      { fresh: true, yes: true },
      {
        currentVersion: () => "1.0.0-rc-1",
        error,
        getMaintainedTarget: () => maintainedTarget("1.0.0-rc.1"),
        isSourceCheckout: () => false,
        log: vi.fn(),
        spawnSyncImpl,
      },
    );

    expect(result.ranInstaller).toBe(false);
    expect(result.status).toBe(1);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("downgrade"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("--allow-downgrade"));
  });

  it("reinstalls an older maintained tag once --allow-downgrade is passed (#8306)", async () => {
    const spawnSyncImpl = vi.fn(
      () => ({ status: 0, stdout: "", stderr: "", signal: null }) as never,
    );
    const log = vi.fn();

    const result = await runUpdateAction(
      { allowDowngrade: true, fresh: true, yes: true },
      {
        currentVersion: () => "0.0.102",
        getMaintainedTarget: () => maintainedTarget("0.0.97"),
        isSourceCheckout: () => false,
        log,
        spawnSyncImpl,
      },
    );

    expect(result.ranInstaller).toBe(true);
    expect(result.status).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("may be a downgrade"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("--allow-downgrade"));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("already up to date"));
  });

  it.each([
    ["0.0.102-44-g1234abc", "git describe output"],
    ["0.0.103-rc.1", "pre-release metadata"],
    ["0.0.102+build5", "build metadata"],
    ["0.0.97-3-gabc1234", "same release core, commits after the tag"],
  ])("refuses --fresh for %s (%s) (#8306)", async (currentVersion) => {
    const spawnSyncImpl = vi.fn();
    const error = vi.fn();

    const result = await runUpdateAction(
      { fresh: true, yes: true },
      {
        currentVersion: () => currentVersion,
        error,
        getMaintainedTarget: () => maintainedTarget("0.0.97"),
        isSourceCheckout: () => false,
        log: vi.fn(),
        spawnSyncImpl,
      },
    );

    expect(result.ranInstaller).toBe(false);
    expect(result.status).toBe(1);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("--allow-downgrade"));
  });

  it("does not order a git-described prerelease against the stable release (#8306)", async () => {
    const spawnSyncImpl = vi.fn();
    const error = vi.fn();

    const result = await runUpdateAction(
      { fresh: true, yes: true },
      {
        currentVersion: () => "1.0.0-rc.1-3-gabcdef0",
        error,
        getMaintainedTarget: () => maintainedTarget("1.0.0"),
        isSourceCheckout: () => false,
        log: vi.fn(),
        spawnSyncImpl,
      },
    );

    expect(result.ranInstaller).toBe(false);
    expect(result.status).toBe(1);
    expect(result.updateAvailable).toBeNull();
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Cannot order"));
  });

  it("fails closed on --fresh when the versions cannot be ordered (#8306)", async () => {
    const spawnSyncImpl = vi.fn();
    const error = vi.fn();

    const result = await runUpdateAction(
      { fresh: true, yes: true },
      {
        currentVersion: () => "dev",
        error,
        getMaintainedTarget: () => maintainedTarget("0.0.97"),
        isSourceCheckout: () => false,
        log: vi.fn(),
        spawnSyncImpl,
      },
    );

    expect(result.ranInstaller).toBe(false);
    expect(result.status).toBe(1);
    expect(result.updateAvailable).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Cannot order"));
  });

  it.each([
    ["01.0.0", "1.0.0", "installed release component"],
    ["1.0.0", "01.0.0", "maintained release component"],
    ["1.0.0-01", "1.0.0-1", "installed prerelease identifier"],
    ["1.0.0-1", "1.0.0-01", "maintained prerelease identifier"],
  ])(
    "fails closed on --fresh for a leading zero in the %s (%s; %s) (#8306)",
    async (currentVersion, latestVersion) => {
      const spawnSyncImpl = vi.fn();
      const error = vi.fn();

      const result = await runUpdateAction(
        { fresh: true, yes: true },
        {
          currentVersion: () => currentVersion,
          error,
          getMaintainedTarget: () => maintainedTarget(latestVersion),
          isSourceCheckout: () => false,
          log: vi.fn(),
          spawnSyncImpl,
        },
      );

      expect(result.ranInstaller).toBe(false);
      expect(result.status).toBe(1);
      expect(result.updateAvailable).toBeNull();
      expect(spawnSyncImpl).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining("Cannot order"));
      expect(error).toHaveBeenCalledWith(expect.stringContaining("--allow-downgrade"));
    },
  );

  it("fails closed on --fresh when the maintained tag cannot be resolved (#8306)", async () => {
    const spawnSyncImpl = vi.fn();
    const error = vi.fn();

    const result = await runUpdateAction(
      { fresh: true, yes: true },
      {
        currentVersion: () => "0.0.102",
        error,
        getMaintainedTarget: () => maintainedTarget(null),
        isSourceCheckout: () => false,
        log: vi.fn(),
        spawnSyncImpl,
      },
    );

    expect(result.ranInstaller).toBe(false);
    expect(result.status).toBe(1);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Could not resolve"));
  });

  it("still upgrades when the maintained tag is unresolved and --fresh is absent (#8306)", async () => {
    const spawnSyncImpl = vi.fn(
      () => ({ status: 0, stdout: "", stderr: "", signal: null }) as never,
    );

    const result = await runUpdateAction(
      { yes: true },
      {
        currentVersion: () => "0.0.102",
        getMaintainedTarget: () => maintainedTarget(null),
        isSourceCheckout: () => false,
        log: vi.fn(),
        spawnSyncImpl,
      },
    );

    expect(result.updateAvailable).toBeNull();
    expect(result.ranInstaller).toBe(true);
  });

  it("still upgrades a pre-release that is behind the maintained tag (#8306)", async () => {
    const spawnSyncImpl = vi.fn(
      () => ({ status: 0, stdout: "", stderr: "", signal: null }) as never,
    );

    const result = await runUpdateAction(
      { fresh: true, yes: true },
      {
        currentVersion: () => "0.0.90-2-gdeadbee",
        getMaintainedTarget: () => maintainedTarget("0.0.97"),
        isSourceCheckout: () => false,
        log: vi.fn(),
        spawnSyncImpl,
      },
    );

    expect(result.updateAvailable).toBe(true);
    expect(result.ranInstaller).toBe(true);
  });

  it("upgrades a pre-release to the stable maintained version with the same release core (#8306)", async () => {
    const spawnSyncImpl = vi.fn(
      () => ({ status: 0, stdout: "", stderr: "", signal: null }) as never,
    );
    const log = vi.fn();

    const result = await runUpdateAction(
      { yes: true },
      {
        currentVersion: () => "0.0.97-rc.1",
        getMaintainedTarget: () => maintainedTarget("0.0.97"),
        isSourceCheckout: () => false,
        log,
        spawnSyncImpl,
      },
    );

    expect(result.updateAvailable).toBe(true);
    expect(result.ranInstaller).toBe(true);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("already up to date"));
  });

  it("fails closed when a numeric version prefix has an invalid suffix (#8306)", async () => {
    const spawnSyncImpl = vi.fn();
    const error = vi.fn();

    const result = await runUpdateAction(
      { fresh: true, yes: true },
      {
        currentVersion: () => "0.0.102invalid",
        error,
        getMaintainedTarget: () => maintainedTarget("0.0.97"),
        isSourceCheckout: () => false,
        log: vi.fn(),
        spawnSyncImpl,
      },
    );

    expect(result.updateAvailable).toBeNull();
    expect(result.ranInstaller).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Cannot order"));
  });

  it("keeps the plain up-to-date exit when the install is newer and --fresh is absent (#8306)", async () => {
    const spawnSyncImpl = vi.fn();
    const error = vi.fn();
    const log = vi.fn();

    const result = await runUpdateAction(
      { yes: true },
      {
        currentVersion: () => "0.0.102",
        error,
        getMaintainedTarget: () => maintainedTarget("0.0.97"),
        isSourceCheckout: () => false,
        log,
        spawnSyncImpl,
      },
    );

    expect(result.ranInstaller).toBe(false);
    expect(result.status).toBe(0);
    expect(result.updateAvailable).toBe(false);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("already up to date"));
  });

  it("does not announce a --fresh reinstall when the user declines the prompt (#5960)", async () => {
    const spawnSyncImpl = vi.fn();
    const log = vi.fn();
    const prompt = vi.fn(async () => "n");

    const result = await runUpdateAction(
      { fresh: true },
      {
        currentVersion: () => "0.2.0",
        getMaintainedTarget: () => maintainedTarget("0.2.0"),
        isSourceCheckout: () => false,
        log,
        prompt,
        spawnSyncImpl,
      },
    );

    expect(result.ranInstaller).toBe(false);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    // The reinstall claim must not print before/without confirmation.
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("reinstalling anyway"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Update cancelled"));
  });

  it("still refuses --fresh from a developer source checkout (no reinstall)", async () => {
    const spawnSyncImpl = vi.fn();

    const result = await runUpdateAction(
      { fresh: true, yes: true },
      {
        currentVersion: () => "0.2.0",
        error: vi.fn(),
        getMaintainedTarget: () => maintainedTarget("0.2.0"),
        isSourceCheckout: () => true,
        log: vi.fn(),
        spawnSyncImpl,
      },
    );

    expect(result.ranInstaller).toBe(false);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });

  it("prompts before running the maintained installer", async () => {
    const prompt = vi.fn(async () => "yes");
    const spawnSyncImpl = vi.fn(
      () => ({ status: 0, stdout: "", stderr: "", signal: null }) as never,
    );

    const result = await runUpdateAction(
      {},
      {
        currentVersion: () => "0.1.0",
        getMaintainedTarget: () => maintainedTarget("0.2.0"),
        isSourceCheckout: () => false,
        log: vi.fn(),
        prompt,
        spawnSyncImpl,
      },
    );

    expect(result.status).toBe(0);
    expect(result.ranInstaller).toBe(true);
    expect(prompt).toHaveBeenCalledWith(
      expect.stringContaining("Run the maintained NemoClaw installer"),
    );
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "bash",
      ["-o", "pipefail", "-lc", NEMOCLAW_UPDATE_COMMAND],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("runs the maintained installer without prompting for --yes", async () => {
    const prompt = vi.fn(async () => "no");
    const spawnSyncImpl = vi.fn(
      () => ({ status: 0, stdout: "", stderr: "", signal: null }) as never,
    );

    const result = await runUpdateAction(
      { yes: true },
      {
        currentVersion: () => "0.1.0",
        getMaintainedTarget: () => maintainedTarget("0.2.0"),
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

  it("keeps the maintained revision that passed the fresh downgrade guard (#8306)", async () => {
    const reviewedRevision = "a".repeat(40);
    let maintainedTagRevision = reviewedRevision;
    const spawnSyncImpl = vi.fn((_command, _args, options) => {
      maintainedTagRevision = "b".repeat(40);
      expect(options.env?.NEMOCLAW_INSTALL_REF).toBe(reviewedRevision);
      expect(options.env?.NEMOCLAW_INSTALL_REF).not.toBe(maintainedTagRevision);
      expect(options.env?.NEMOCLAW_INSTALL_TAG).toBeUndefined();
      return { status: 0, stdout: "", stderr: "", signal: null } as never;
    });

    const result = await runUpdateAction(
      { fresh: true, yes: true },
      {
        currentVersion: () => "0.2.0",
        env: {
          ...process.env,
          NEMOCLAW_INSTALL_REF: "refs/heads/not-maintained",
          NEMOCLAW_INSTALL_TAG: "not-maintained",
        },
        getMaintainedTarget: () => ({ revision: maintainedTagRevision, version: "0.2.0" }),
        isSourceCheckout: () => false,
        log: vi.fn(),
        spawnSyncImpl,
      },
    );

    expect(result.status).toBe(0);
    expect(result.ranInstaller).toBe(true);
    expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
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
        getMaintainedTarget: () => maintainedTarget("0.2.0"),
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
    const spawnSyncImpl = vi.fn(
      () => ({ status: 0, stdout: "", stderr: "", signal: null }) as never,
    );

    await runUpdateAction(
      { yes: true },
      {
        currentVersion: () => "0.1.0",
        env: {
          ...process.env,
          BASH_ENV: "/tmp/review-bash-env",
          ENV: "/tmp/review-env",
          NEMOCLAW_FRESH: "1",
          NEMOCLAW_INSTALL_REF: "refs/heads/not-maintained",
          NEMOCLAW_INSTALL_TAG: "not-maintained",
        },
        getMaintainedTarget: () => maintainedTarget("0.2.0"),
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
    expect(options?.env?.NEMOCLAW_FRESH).toBeUndefined();
    expect(options?.env?.NEMOCLAW_INSTALL_REF).toBe(MAINTAINED_REVISION);
    expect(options?.env?.NEMOCLAW_INSTALL_TAG).toBeUndefined();
  });

  it("preserves the canonical Deep Agents agent selection while sanitizing installer env", async () => {
    const spawnSyncImpl = vi.fn(
      () => ({ status: 0, stdout: "", stderr: "", signal: null }) as never,
    );
    const log = vi.fn();

    await runUpdateAction(
      { yes: true },
      {
        currentVersion: () => "0.1.0",
        env: {
          ...process.env,
          BASH_ENV: "/tmp/review-bash-env",
          NEMOCLAW_AGENT: "langchain-deepagents-code",
          NEMOCLAW_INSTALL_REF: "refs/heads/not-maintained",
        },
        getMaintainedTarget: () => maintainedTarget("0.2.0"),
        isSourceCheckout: () => false,
        log,
        spawnSyncImpl,
      },
    );

    const calls = spawnSyncImpl.mock.calls as unknown as Array<
      [string, readonly string[], { env?: NodeJS.ProcessEnv }]
    >;
    const options = calls[0]?.[2];
    expect(options?.env?.NEMOCLAW_AGENT).toBe("langchain-deepagents-code");
    expect(options?.env?.BASH_ENV).toBeUndefined();
    expect(options?.env?.NEMOCLAW_INSTALL_REF).toBe(MAINTAINED_REVISION);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Running maintained NemoDeepAgents installer"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Installer completed. Run `nemo-deepagents upgrade-sandboxes --check`",
      ),
    );
  });

  it("preserves the Hermes agent selection while sanitizing installer env", async () => {
    const spawnSyncImpl = vi.fn(
      () => ({ status: 0, stdout: "", stderr: "", signal: null }) as never,
    );
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
        getMaintainedTarget: () => maintainedTarget("0.2.0"),
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
    expect(options?.env?.NEMOCLAW_INSTALL_REF).toBe(MAINTAINED_REVISION);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Running maintained NemoHermes installer"),
    );
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
        getMaintainedTarget: () => maintainedTarget("0.2.0"),
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

describe("getMaintainedNemoClawVersionFromGitTag", () => {
  it("resolves the version tag that points at the maintained lkg tag", () => {
    const maintainedRevision = "a".repeat(40);
    const spawnSyncImpl = vi.fn(
      () =>
        ({
          status: 0,
          stdout: [
            `${maintainedRevision}\trefs/tags/lkg`,
            `${"b".repeat(40)}\trefs/tags/v0.0.36`,
            `${maintainedRevision}\trefs/tags/v0.0.37`,
            `${"c".repeat(40)}\trefs/tags/v0.1.0`,
          ].join("\n"),
          stderr: "",
          signal: null,
        }) as never,
    );

    expect(getMaintainedNemoClawVersionFromGitTag({ spawnSyncImpl })).toBe("0.0.37");
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["refs/tags/lkg", "refs/tags/lkg^{}"]),
      expect.any(Object),
    );
  });

  it("returns the maintained revision with its version", () => {
    const revision = "a".repeat(40);
    const spawnSyncImpl = vi.fn(
      () =>
        ({
          status: 0,
          stdout: [`${revision}\trefs/tags/lkg`, `${revision}\trefs/tags/v0.0.37`].join("\n"),
          stderr: "",
          signal: null,
        }) as never,
    );

    expect(getMaintainedNemoClawTargetFromGitTag({ spawnSyncImpl })).toEqual({
      revision,
      version: "0.0.37",
    });
  });

  it("rejects a maintained tag result that is not a Git object ID", () => {
    const spawnSyncImpl = vi.fn(
      () =>
        ({
          status: 0,
          stdout: ["refs/heads/main\trefs/tags/lkg", "refs/heads/main\trefs/tags/v0.0.37"].join(
            "\n",
          ),
          stderr: "",
          signal: null,
        }) as never,
    );

    expect(getMaintainedNemoClawTargetFromGitTag({ spawnSyncImpl })).toBeNull();
  });
});
