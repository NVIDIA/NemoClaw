// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { runUseCommand, type UseCommandDeps } from "./use-command-deps";

function makeDeps(
  overrides: Partial<{
    sandboxes: ReadonlyArray<string>;
    defaultSandbox: string | null;
    setDefault: (name: string) => boolean;
  }> = {},
): UseCommandDeps & {
  setDefault: ReturnType<typeof vi.fn>;
  listSandboxes: ReturnType<typeof vi.fn>;
} {
  const sandboxes = (overrides.sandboxes ?? []).map((name) => ({ name }));
  const defaultSandbox = overrides.defaultSandbox ?? null;
  const setDefault = vi.fn(overrides.setDefault ?? ((_name: string) => true));
  const listSandboxes = vi.fn(() => ({ sandboxes, defaultSandbox }));
  return { listSandboxes, setDefault };
}

describe("runUseCommand", () => {
  it("reports unknown sandbox with the known list and skips the registry write", () => {
    const deps = makeDeps({ sandboxes: ["alpha", "beta"], defaultSandbox: "alpha" });

    const result = runUseCommand("gamma", deps);

    expect(result).toEqual({
      outcome: "not-found",
      sandboxName: "gamma",
      knownSandboxes: ["alpha", "beta"],
    });
    expect(deps.setDefault).not.toHaveBeenCalled();
  });

  it("returns already-default and skips the registry write when the chosen sandbox is the default", () => {
    const deps = makeDeps({ sandboxes: ["alpha", "beta"], defaultSandbox: "alpha" });

    const result = runUseCommand("alpha", deps);

    expect(result).toEqual({ outcome: "already-default", sandboxName: "alpha" });
    expect(deps.setDefault).not.toHaveBeenCalled();
  });

  it("promotes the chosen sandbox and reports the previous default", () => {
    const deps = makeDeps({ sandboxes: ["alpha", "beta"], defaultSandbox: "alpha" });

    const result = runUseCommand("beta", deps);

    expect(result).toEqual({
      outcome: "set",
      sandboxName: "beta",
      previousDefault: "alpha",
    });
    expect(deps.setDefault).toHaveBeenCalledTimes(1);
    expect(deps.setDefault).toHaveBeenCalledWith("beta");
  });

  it("reports the first default when the registry currently has none", () => {
    const deps = makeDeps({ sandboxes: ["alpha"], defaultSandbox: null });

    const result = runUseCommand("alpha", deps);

    expect(result).toEqual({
      outcome: "set",
      sandboxName: "alpha",
      previousDefault: null,
    });
    expect(deps.setDefault).toHaveBeenCalledWith("alpha");
  });

  it("downgrades to not-found when the registry refuses the write due to a concurrent removal", () => {
    const deps = makeDeps({
      sandboxes: ["alpha", "beta"],
      defaultSandbox: "alpha",
      setDefault: () => false,
    });

    const result = runUseCommand("beta", deps);

    expect(result).toEqual({
      outcome: "not-found",
      sandboxName: "beta",
      knownSandboxes: ["alpha", "beta"],
    });
    expect(deps.setDefault).toHaveBeenCalledWith("beta");
  });

  it("refreshes the known sandbox list after a failed setDefault so the diagnostic excludes the concurrently removed sandbox", () => {
    const listSandboxes = vi
      .fn()
      .mockReturnValueOnce({
        sandboxes: [{ name: "alpha" }, { name: "beta" }],
        defaultSandbox: "alpha",
      })
      .mockReturnValueOnce({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" });
    const setDefault = vi.fn(() => false);
    const deps: UseCommandDeps = { listSandboxes, setDefault };

    const result = runUseCommand("beta", deps);

    expect(result).toEqual({
      outcome: "not-found",
      sandboxName: "beta",
      knownSandboxes: ["alpha"],
    });
    expect(listSandboxes).toHaveBeenCalledTimes(2);
    expect(setDefault).toHaveBeenCalledWith("beta");
  });
});
