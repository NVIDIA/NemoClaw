// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { assertSandboxPathExistsOrExit } from "../dist/lib/share-command.js";
import type { ShareCommandDeps } from "../dist/lib/share-command-deps.js";

class ProcessExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

function makeDeps(overrides: Partial<ShareCommandDeps> = {}): ShareCommandDeps {
  return {
    getSshConfig: () => ({ status: 0, output: "" }),
    ensureLive: async () => undefined,
    checkSandboxPathExists: () => true,
    colorGreen: "",
    colorReset: "",
    cliName: "nemoclaw",
    ...overrides,
  };
}

describe("assertSandboxPathExistsOrExit (#3414)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns without writing to stderr when the remote path exists", () => {
    const deps = makeDeps({ checkSandboxPathExists: () => true });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("should not exit");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    assertSandboxPathExistsOrExit(deps, "my-assistant", "/sandbox");

    expect(exitSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("exits 1 with a structured error when the remote path does not exist", () => {
    let pathChecked: { sandboxName?: string; remotePath?: string } = {};
    const deps = makeDeps({
      checkSandboxPathExists: (sandboxName, remotePath) => {
        pathChecked = { sandboxName, remotePath };
        return false;
      },
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new ProcessExitError(typeof code === "number" ? code : 1);
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => assertSandboxPathExistsOrExit(deps, "my-assistant", "/sandbox/typo")).toThrow(
      ProcessExitError,
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(pathChecked).toEqual({ sandboxName: "my-assistant", remotePath: "/sandbox/typo" });

    const errorOutput = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    // The headline is phrased as a verification failure rather than a
    // definitive missing-path claim because the dep returns false for both
    // missing paths and probe failures (CR feedback on #3415).
    expect(errorOutput).toContain(
      "Could not verify sandbox path '/sandbox/typo' in sandbox 'my-assistant'",
    );
    expect(errorOutput).toContain("missing path or probe failure");
    expect(errorOutput).toContain("Verify the path with: nemoclaw my-assistant connect");
    expect(errorOutput).toContain("ls /sandbox/typo");
    expect(errorOutput).toContain("check for typos");
  });

  it("uses the configured cliName in the verify-with hint (supports nemohermes alias)", () => {
    const deps = makeDeps({
      cliName: "nemohermes",
      checkSandboxPathExists: () => false,
    });
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new ProcessExitError(1);
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => assertSandboxPathExistsOrExit(deps, "hermes", "/sandbox/missing")).toThrow(
      ProcessExitError,
    );

    const errorOutput = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errorOutput).toContain("nemohermes hermes connect");
    expect(errorOutput).not.toContain("nemoclaw hermes connect");
  });
});
