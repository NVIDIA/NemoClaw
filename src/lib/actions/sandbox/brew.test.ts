// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const isShieldsDown = vi.hoisted(() => vi.fn());
const privilegedSandboxExec = vi.hoisted(() => vi.fn());
const getSandbox = vi.hoisted(() => vi.fn());
const updateSandbox = vi.hoisted(() => vi.fn());

vi.mock("../../shields", () => ({
  isShieldsDown,
}));

vi.mock("../../adapters/sandbox/privileged-exec", () => ({
  privilegedSandboxExec,
}));

vi.mock("../../state/registry", () => ({
  getSandbox,
  updateSandbox,
}));

import { BrewCommandError, runSandboxBrew } from "./brew";

function fail(message: string): never {
  throw new Error(message);
}

describe("runSandboxBrew", () => {
  beforeEach(() => {
    isShieldsDown.mockReset();
    privilegedSandboxExec.mockReset();
    getSandbox.mockReset();
    updateSandbox.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("init", () => {
    it("refuses when sandbox is not registered", async () => {
      getSandbox.mockReturnValue(null);
      await expect(runSandboxBrew("nonexistent", { kind: "init" })).rejects.toBeInstanceOf(
        BrewCommandError,
      );
      expect(privilegedSandboxExec).not.toHaveBeenCalled();
    });

    it("refuses when shields are up", async () => {
      getSandbox.mockReturnValue({ name: "alpha" });
      isShieldsDown.mockReturnValue(false);
      await expect(runSandboxBrew("alpha", { kind: "init" })).rejects.toBeInstanceOf(
        BrewCommandError,
      );
      expect(privilegedSandboxExec).not.toHaveBeenCalled();
    });

    it("is idempotent when brew is already initialised", async () => {
      getSandbox.mockReturnValue({ name: "alpha", brewInitialised: true });
      isShieldsDown.mockReturnValue(true);
      await runSandboxBrew("alpha", { kind: "init" });
      expect(privilegedSandboxExec).not.toHaveBeenCalled();
      expect(updateSandbox).not.toHaveBeenCalled();
    });

    it("runs the bootstrap script as root and marks the sandbox initialised", async () => {
      getSandbox.mockReturnValue({ name: "alpha" });
      isShieldsDown.mockReturnValue(true);
      privilegedSandboxExec.mockReturnValue("");
      await runSandboxBrew("alpha", { kind: "init" });
      expect(privilegedSandboxExec).toHaveBeenCalledTimes(1);
      const [name, cmd, opts] = privilegedSandboxExec.mock.calls[0] ?? fail("missing call");
      expect(name).toBe("alpha");
      expect(cmd).toEqual(["bash", "-s"]);
      expect(opts?.input).toMatch(/useradd -m -s \/bin\/bash linuxbrew/);
      expect(opts?.input).toMatch(/raw.githubusercontent\.com\/Homebrew\/install/);
      expect(opts?.input).toMatch(/\/etc\/profile\.d\/nemoclaw-linuxbrew\.sh/);
      expect(updateSandbox).toHaveBeenCalledWith("alpha", { brewInitialised: true });
    });
  });

  describe("install", () => {
    it("refuses when brew is not initialised", async () => {
      getSandbox.mockReturnValue({ name: "alpha" });
      isShieldsDown.mockReturnValue(true);
      await expect(
        runSandboxBrew("alpha", { kind: "install", packages: ["jq"] }),
      ).rejects.toBeInstanceOf(BrewCommandError);
      expect(privilegedSandboxExec).not.toHaveBeenCalled();
    });

    it("refuses when shields are up", async () => {
      getSandbox.mockReturnValue({ name: "alpha", brewInitialised: true });
      isShieldsDown.mockReturnValue(false);
      await expect(
        runSandboxBrew("alpha", { kind: "install", packages: ["jq"] }),
      ).rejects.toBeInstanceOf(BrewCommandError);
      expect(privilegedSandboxExec).not.toHaveBeenCalled();
    });

    it("refuses when no packages are provided", async () => {
      getSandbox.mockReturnValue({ name: "alpha", brewInitialised: true });
      isShieldsDown.mockReturnValue(true);
      await expect(
        runSandboxBrew("alpha", { kind: "install", packages: [] }),
      ).rejects.toBeInstanceOf(BrewCommandError);
      expect(privilegedSandboxExec).not.toHaveBeenCalled();
    });

    it("refuses formulae that do not match the safe pattern", async () => {
      getSandbox.mockReturnValue({ name: "alpha", brewInitialised: true });
      isShieldsDown.mockReturnValue(true);
      await expect(
        runSandboxBrew("alpha", { kind: "install", packages: ["jq;rm -rf /"] }),
      ).rejects.toBeInstanceOf(BrewCommandError);
      expect(privilegedSandboxExec).not.toHaveBeenCalled();
    });

    it("invokes brew install as the linuxbrew user", async () => {
      getSandbox.mockReturnValue({ name: "alpha", brewInitialised: true });
      isShieldsDown.mockReturnValue(true);
      privilegedSandboxExec.mockReturnValue("");
      await runSandboxBrew("alpha", { kind: "install", packages: ["hello", "jq"] });
      expect(privilegedSandboxExec).toHaveBeenCalledTimes(1);
      const [, cmd, opts] = privilegedSandboxExec.mock.calls[0] ?? fail("missing call");
      expect(cmd).toEqual([
        "/home/linuxbrew/.linuxbrew/bin/brew",
        "install",
        "hello",
        "jq",
      ]);
      expect(opts?.user).toBe("linuxbrew");
    });
  });

  describe("uninstall", () => {
    it("invokes brew uninstall as the linuxbrew user", async () => {
      getSandbox.mockReturnValue({ name: "alpha", brewInitialised: true });
      isShieldsDown.mockReturnValue(true);
      privilegedSandboxExec.mockReturnValue("");
      await runSandboxBrew("alpha", { kind: "uninstall", packages: ["hello"] });
      const [, cmd, opts] = privilegedSandboxExec.mock.calls[0] ?? fail("missing call");
      expect(cmd).toEqual(["/home/linuxbrew/.linuxbrew/bin/brew", "uninstall", "hello"]);
      expect(opts?.user).toBe("linuxbrew");
    });

    it("refuses when brew is not initialised", async () => {
      getSandbox.mockReturnValue({ name: "alpha" });
      isShieldsDown.mockReturnValue(true);
      await expect(
        runSandboxBrew("alpha", { kind: "uninstall", packages: ["hello"] }),
      ).rejects.toBeInstanceOf(BrewCommandError);
      expect(privilegedSandboxExec).not.toHaveBeenCalled();
    });
  });

  describe("deinit", () => {
    it("is idempotent when brew was never initialised", async () => {
      getSandbox.mockReturnValue({ name: "alpha" });
      isShieldsDown.mockReturnValue(true);
      await runSandboxBrew("alpha", { kind: "deinit" });
      expect(privilegedSandboxExec).not.toHaveBeenCalled();
    });

    it("removes /home/linuxbrew, the profile.d hook, and clears the registry flag", async () => {
      getSandbox.mockReturnValue({ name: "alpha", brewInitialised: true });
      isShieldsDown.mockReturnValue(true);
      privilegedSandboxExec.mockReturnValue("");
      await runSandboxBrew("alpha", { kind: "deinit" });
      const [, cmd, opts] = privilegedSandboxExec.mock.calls[0] ?? fail("missing call");
      expect(cmd).toEqual(["bash", "-s"]);
      expect(opts?.input).toMatch(/rm -f \/etc\/profile\.d\/nemoclaw-linuxbrew\.sh/);
      expect(opts?.input).toMatch(/rm -rf \/home\/linuxbrew\/\.linuxbrew \/home\/linuxbrew/);
      expect(opts?.input).toMatch(/userdel linuxbrew/);
      expect(updateSandbox).toHaveBeenCalledWith("alpha", { brewInitialised: false });
    });
  });

  describe("help", () => {
    it("prints usage without privileged exec", async () => {
      const log = vi.spyOn(console, "log");
      await runSandboxBrew("alpha", { kind: "help" });
      expect(privilegedSandboxExec).not.toHaveBeenCalled();
      const out = log.mock.calls.map((args) => args[0]).join("\n");
      expect(out).toMatch(/brew init/);
      expect(out).toMatch(/brew install/);
    });
  });
});
