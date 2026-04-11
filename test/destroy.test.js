// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxDestroy } from "../bin/nemoclaw.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sandbox destroy safeguards", () => {
  it("removes a stale registry entry only after confirmation", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const removeSandbox = vi.fn();
    const runMock = vi.fn();
    const stopNim = vi.fn();

    const result = await sandboxDestroy("the-crucible", {
      isAvailable: false,
      prompt: vi.fn().mockResolvedValue("y"),
      removeSandbox,
      run: runMock,
      stopNim,
    });

    expect(result).toBe(true);
    expect(removeSandbox).toHaveBeenCalledWith("the-crucible");
    expect(runMock).not.toHaveBeenCalled();
    expect(stopNim).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain("OpenShell cannot load it");
    expect(printed).toContain("Removed stale sandbox entry 'the-crucible'");
  });

  it("cancels live sandbox deletion unless the user types DESTROY", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const removeSandbox = vi.fn();
    const runMock = vi.fn();
    const stopNim = vi.fn();

    const result = await sandboxDestroy("the-crucible", {
      isAvailable: true,
      prompt: vi.fn().mockResolvedValue("nope"),
      removeSandbox,
      run: runMock,
      stopNim,
    });

    expect(result).toBe(false);
    expect(removeSandbox).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
    expect(stopNim).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain("permanently deletes workspace files");
    expect(printed).toContain("IDENTITY.md");
    expect(printed).toContain("nemoclaw the-crucible backup");
    expect(printed).toContain("Cancelled.");
  });

  it("destroys a live sandbox after explicit confirmation", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const removeSandbox = vi.fn();
    const runMock = vi.fn();
    const stopNim = vi.fn();

    const result = await sandboxDestroy("the-crucible", {
      isAvailable: true,
      prompt: vi.fn().mockResolvedValue("DESTROY"),
      removeSandbox,
      run: runMock,
      stopNim,
    });

    expect(result).toBe(true);
    expect(stopNim).toHaveBeenCalledWith("the-crucible");
    expect(runMock).toHaveBeenCalledWith(
      'openshell sandbox delete "the-crucible" 2>/dev/null || true',
      { ignoreError: true },
    );
    expect(removeSandbox).toHaveBeenCalledWith("the-crucible");
    const printed = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain("Stopping NIM for 'the-crucible'");
    expect(printed).toContain("Sandbox 'the-crucible' destroyed");
  });
});
