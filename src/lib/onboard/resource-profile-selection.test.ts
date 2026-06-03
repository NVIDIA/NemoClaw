// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { selectResourceProfileForSandbox } from "../../../dist/lib/onboard/resource-profile-selection.js";
import type { ResourceProfileSelectionDeps } from "./resource-profile-selection";

function makeDeps(overrides: Partial<ResourceProfileSelectionDeps> = {}): ResourceProfileSelectionDeps {
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

    expect(deps.note).toHaveBeenCalledWith("  Resource profile (env): default (OpenShell defaults)");
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

    expect(errorSpy).toHaveBeenCalledWith("  Invalid resource profile selection '99'. Choose a number from 1 to 6.");
  });

  it("collects a custom profile and validates CPU and RAM", async () => {
    const deps = makeDeps({
      promptOrDefault: vi.fn().mockResolvedValue("5"),
      prompt: vi
        .fn()
        .mockResolvedValueOnce("25%")
        .mockResolvedValueOnce("25%"),
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
      prompt: vi
        .fn()
        .mockResolvedValueOnce("101%")
        .mockResolvedValueOnce("25%"),
    });

    await expect(selectResourceProfileForSandbox(deps)).rejects.toThrow("process.exit(1)");

    expect(errorSpy).toHaveBeenCalledWith("  Invalid percentage '101%': must be an integer between 1% and 100%");
  });
});
