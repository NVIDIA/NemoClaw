// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceProfileSelectionDeps } from "./resource-profile-selection";
import {
  appendResourceFlagsForProfile,
  selectResourceProfileForSandbox,
} from "./resource-profile-selection.js";

function makeDeps(
  overrides: Partial<ResourceProfileSelectionDeps> = {},
): ResourceProfileSelectionDeps {
  return {
    isNonInteractive: vi.fn(() => false),
    note: vi.fn(),
    prompt: vi.fn(),
    promptOrDefault: vi.fn(),
    env: {},
    ...overrides,
  };
}

describe("selectResourceProfileForSandbox", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("selects a named resource profile from the environment", async () => {
    const deps = makeDeps({ env: { NEMOCLAW_RESOURCE_PROFILE: "developer" } as NodeJS.ProcessEnv });

    await expect(selectResourceProfileForSandbox(deps)).resolves.toEqual({
      cpu: "75%",
      memory: "75%",
    });

    expect(deps.note).toHaveBeenCalledWith("  Resource profile (env): developer");
    expect(deps.promptOrDefault).not.toHaveBeenCalled();
  });

  it("treats the default environment profile as no resource preference", async () => {
    const deps = makeDeps({ env: { NEMOCLAW_RESOURCE_PROFILE: "default" } as NodeJS.ProcessEnv });

    await expect(selectResourceProfileForSandbox(deps)).resolves.toBeNull();

    expect(deps.note).toHaveBeenCalledWith(
      "  Resource profile (env): default (OpenShell defaults)",
    );
    expect(deps.promptOrDefault).not.toHaveBeenCalled();
  });

  it("rejects unknown environment-selected profiles", async () => {
    const deps = makeDeps({ env: { NEMOCLAW_RESOURCE_PROFILE: "missing" } as NodeJS.ProcessEnv });

    await expect(selectResourceProfileForSandbox(deps)).rejects.toThrow("process.exit(1)");

    expect(errorSpy).toHaveBeenCalledWith("  Unknown resource profile: 'missing'");
  });

  it("applies CPU and RAM env overrides without prompting", async () => {
    const deps = makeDeps({
      env: {
        NEMOCLAW_CPU: "4",
        NEMOCLAW_RAM: "8Gi",
      } as NodeJS.ProcessEnv,
      isNonInteractive: vi.fn(() => true),
    });

    await expect(selectResourceProfileForSandbox(deps)).resolves.toEqual({
      cpu: "4",
      memory: "8Gi",
    });

    expect(deps.note).toHaveBeenCalledWith("  Resource overrides (env): cpu=4, ram=8Gi");
    expect(deps.promptOrDefault).not.toHaveBeenCalled();
  });

  it("accepts whole-number percentage overrides from 1% to 100%", async () => {
    const deps = makeDeps({
      env: { NEMOCLAW_CPU: "100%", NEMOCLAW_RAM: "1%" } as NodeJS.ProcessEnv,
      isNonInteractive: vi.fn(() => true),
    });

    await expect(selectResourceProfileForSandbox(deps)).resolves.toEqual({
      cpu: "100%",
      memory: "1%",
    });
  });

  it.each([
    ["NEMOCLAW_CPU is above the maximum", { NEMOCLAW_CPU: "150%" }, "150%"],
    [
      "NEMOCLAW_RAM is zero beside a valid NEMOCLAW_CPU",
      { NEMOCLAW_CPU: "2", NEMOCLAW_RAM: "0%" },
      "0%",
    ],
    ["NEMOCLAW_RAM has a fractional part", { NEMOCLAW_RAM: "12.5%" }, "12.5%"],
    ["NEMOCLAW_CPU has text after the percent sign", { NEMOCLAW_CPU: "101%cpu" }, "101%cpu"],
    [
      "NEMOCLAW_CPU is above the maximum and overrides a named profile",
      { NEMOCLAW_RESOURCE_PROFILE: "developer", NEMOCLAW_CPU: "200%" },
      "200%",
    ],
  ])("exits with the percentage error when %s", async (_case, env, value) => {
    const deps = makeDeps({
      env: env as NodeJS.ProcessEnv,
      isNonInteractive: vi.fn(() => true),
    });

    await expect(selectResourceProfileForSandbox(deps)).rejects.toThrow("process.exit(1)");

    expect(errorSpy).toHaveBeenCalledWith(
      `  Invalid percentage '${value}': must be an integer between 1% and 100%`,
    );
  });

  it("returns a menu-selected profile", async () => {
    const deps = makeDeps({ promptOrDefault: vi.fn().mockResolvedValue("2") });

    await expect(selectResourceProfileForSandbox(deps)).resolves.toEqual({
      cpu: "25%",
      memory: "25%",
    });

    expect(deps.promptOrDefault).toHaveBeenCalledWith("  Choose [6]: ", null, "6");
  });

  it("fails fast for non-numeric or out-of-range menu choices", async () => {
    const deps = makeDeps({ promptOrDefault: vi.fn().mockResolvedValue("99") });

    await expect(selectResourceProfileForSandbox(deps)).rejects.toThrow("process.exit(1)");

    expect(errorSpy).toHaveBeenCalledWith(
      "  Invalid resource profile selection '99'. Choose a number from 1 to 6.",
    );
  });

  it("collects a custom profile and validates CPU and RAM", async () => {
    const deps = makeDeps({
      promptOrDefault: vi.fn().mockResolvedValue("5"),
      prompt: vi.fn().mockResolvedValueOnce("25%").mockResolvedValueOnce("25%"),
    });

    await expect(selectResourceProfileForSandbox(deps)).resolves.toEqual({
      cpu: "25%",
      memory: "25%",
    });

    expect(deps.prompt).toHaveBeenCalledTimes(2);
  });

  it("exits when custom profile validation fails", async () => {
    const deps = makeDeps({
      promptOrDefault: vi.fn().mockResolvedValue("5"),
      prompt: vi.fn().mockResolvedValueOnce("101%").mockResolvedValueOnce("25%"),
    });

    await expect(selectResourceProfileForSandbox(deps)).rejects.toThrow("process.exit(1)");

    expect(errorSpy).toHaveBeenCalledWith(
      "  Invalid percentage '101%': must be an integer between 1% and 100%",
    );
  });
});

describe("appendResourceFlagsForProfile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-resource-flags-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeOpenShell(help: string): string {
    const openshell = path.join(tempDir, "openshell");
    fs.writeFileSync(openshell, `#!/usr/bin/env sh\necho '${help}'\n`, { mode: 0o755 });
    return openshell;
  }

  it("prints the unsupported-flags note when OpenShell lacks resource flags", () => {
    const deps = makeDeps();
    const args = ["sandbox", "create"];

    appendResourceFlagsForProfile(
      args,
      { cpu: "25%", memory: "25%" },
      writeOpenShell("usage: openshell sandbox create"),
      deps,
    );

    expect(args).toEqual(["sandbox", "create"]);
    expect(deps.note).toHaveBeenCalledWith(
      "  OpenShell does not support resource flags — sandbox will use default limits.",
    );
  });

  it.each([
    [
      "CPU is invalid and OpenShell has resource flags",
      "--cpu --memory",
      { cpu: "150%", memory: "25%" },
      "150%",
    ],
    [
      "RAM is invalid and OpenShell lacks resource flags",
      "usage: openshell sandbox create",
      { cpu: "25%", memory: "0%" },
      "0%",
    ],
  ])(
    "throws the percentage error without the unsupported-flags note when %s",
    (_case, help, profile, value) => {
      const deps = makeDeps();
      const args = ["sandbox", "create"];

      expect(() =>
        appendResourceFlagsForProfile(args, profile, writeOpenShell(help), deps),
      ).toThrow(`Invalid percentage '${value}': must be an integer between 1% and 100%`);

      expect(args).toEqual(["sandbox", "create"]);
      expect(deps.note).not.toHaveBeenCalled();
    },
  );
});
