// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const runSandboxBrew = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../lib/actions/sandbox/brew", () => ({
  runSandboxBrew,
}));

import BrewCommand from "./brew";
import BrewInitCommand from "./brew/init";
import BrewDeinitCommand from "./brew/deinit";
import BrewInstallCommand from "./brew/install";
import BrewUninstallCommand from "./brew/uninstall";

const rootDir = process.cwd();

describe("brew oclif commands", () => {
  beforeEach(() => {
    runSandboxBrew.mockClear();
  });

  it("parent surfaces help through the action", async () => {
    await BrewCommand.run(["alpha"], rootDir);
    expect(runSandboxBrew).toHaveBeenCalledWith("alpha", { kind: "help" });
  });

  it("rejects unknown parent args before dispatch", async () => {
    await expect(BrewCommand.run(["alpha", "bogus"], rootDir)).rejects.toThrow(/bogus/);
    expect(runSandboxBrew).not.toHaveBeenCalled();
  });

  it("init dispatches with kind=init", async () => {
    await BrewInitCommand.run(["alpha"], rootDir);
    expect(runSandboxBrew).toHaveBeenCalledWith("alpha", { kind: "init" });
  });

  it("deinit dispatches with kind=deinit", async () => {
    await BrewDeinitCommand.run(["alpha"], rootDir);
    expect(runSandboxBrew).toHaveBeenCalledWith("alpha", { kind: "deinit" });
  });

  it("install threads variadic packages into the action", async () => {
    await BrewInstallCommand.run(["alpha", "hello", "jq"], rootDir);
    expect(runSandboxBrew).toHaveBeenCalledWith("alpha", {
      kind: "install",
      packages: ["hello", "jq"],
    });
  });

  it("uninstall threads variadic packages into the action", async () => {
    await BrewUninstallCommand.run(["alpha", "hello"], rootDir);
    expect(runSandboxBrew).toHaveBeenCalledWith("alpha", {
      kind: "uninstall",
      packages: ["hello"],
    });
  });

  it("install refuses when no packages supplied", async () => {
    await BrewInstallCommand.run(["alpha"], rootDir);
    expect(runSandboxBrew).not.toHaveBeenCalled();
  });

  it("uninstall refuses when no packages supplied", async () => {
    await BrewUninstallCommand.run(["alpha"], rootDir);
    expect(runSandboxBrew).not.toHaveBeenCalled();
  });
});
