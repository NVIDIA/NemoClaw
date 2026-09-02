// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildSubprocessEnv: vi.fn(),
  runOpenshell: vi.fn(),
}));

vi.mock("../../subprocess-env", () => ({
  buildSubprocessEnv: mocks.buildSubprocessEnv,
}));

vi.mock("./runtime", () => ({
  runOpenshell: mocks.runOpenshell,
}));

import {
  parseCliOpenShellProviderNames,
  runOpenshellProviderCommand,
  setProviderCommandRuntimeHooksForTest,
} from "./provider-command";

describe("OpenShell provider command runtime", () => {
  beforeEach(() => {
    mocks.buildSubprocessEnv.mockReset().mockReturnValue({ PATH: "/usr/bin", TOKEN: "secret" });
    mocks.runOpenshell.mockReset().mockReturnValue({ status: 0 });
    setProviderCommandRuntimeHooksForTest({});
  });

  it("replaces the child environment with defined provider values", () => {
    const runOpenshell = vi.fn().mockReturnValue({ status: 0 });
    setProviderCommandRuntimeHooksForTest({ runOpenshell });

    const result = runOpenshellProviderCommand(["provider", "list"], {
      env: { TOKEN: "secret", OMITTED: undefined },
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 100,
    });

    expect(mocks.buildSubprocessEnv).toHaveBeenCalledWith({ TOKEN: "secret" });
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "list"],
      expect.objectContaining({
        env: { PATH: "/usr/bin", TOKEN: "secret" },
        ignoreError: true,
        replaceEnv: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 100,
      }),
    );
    expect(result).toEqual({ status: 0 });
  });

  it("uses the default OpenShell runtime without an injected hook", () => {
    const result = runOpenshellProviderCommand(["provider", "list"]);

    expect(mocks.buildSubprocessEnv).toHaveBeenCalledWith({});
    expect(mocks.runOpenshell).toHaveBeenCalledWith(
      ["provider", "list"],
      expect.objectContaining({
        env: { PATH: "/usr/bin", TOKEN: "secret" },
        replaceEnv: true,
      }),
    );
    expect(result).toEqual({ status: 0 });
  });

  it("parses valid provider names without blank lines (#9806)", () => {
    expect(parseCliOpenShellProviderNames("  alpha  \r\n\r\nbeta\n")).toEqual(["alpha", "beta"]);
  });

  it("returns no provider names for empty CLI output (#9806)", () => {
    expect(parseCliOpenShellProviderNames("")).toEqual([]);
  });

  it.each([
    ["OSC control", "alpha\n\u001b]52;c;YXR0YWNr\u0007"],
    ["embedded escape", "alpha\u001b[31m"],
    ["invalid name", "alpha\nbad/name"],
  ])("rejects the entire provider inventory for an unsafe %s (#9806)", (_case, output) => {
    expect(parseCliOpenShellProviderNames(output)).toBeNull();
  });
});
