// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  resolveOnboardEntryOptions,
  type OnboardEntryOptionsDeps,
} from "../../../dist/lib/onboard/entry-options";

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function createDeps(overrides: Partial<OnboardEntryOptionsDeps> = {}): OnboardEntryOptionsDeps {
  return {
    isNonInteractive: vi.fn(() => false),
    validateName: vi.fn((name: string) => name.trim().toLowerCase()),
    reservedSandboxNames: new Set(["status"]),
    cliDisplayName: vi.fn(() => "NemoClaw"),
    getNameValidationGuidance: vi.fn(() => ["Use lowercase letters, numbers, and hyphens."]),
    error: vi.fn(),
    exitProcess: vi.fn((code: number) => {
      throw new ExitError(code);
    }) as (code: number) => never,
    ...overrides,
  };
}

describe("resolveOnboardEntryOptions", () => {
  it("rejects mutually exclusive resume and fresh flags", () => {
    const deps = createDeps();

    expect(() =>
      resolveOnboardEntryOptions(
        {
          opts: { resume: true, fresh: true },
          env: {},
          stdinIsTty: true,
          stdoutIsTty: true,
        },
        deps,
      ),
    ).toThrow(ExitError);
    expect(deps.error).toHaveBeenCalledWith("  --resume and --fresh cannot both be set.");
  });

  it("uses non-interactive env defaults for Dockerfile and sandbox name", () => {
    const deps = createDeps({
      isNonInteractive: vi.fn(() => true),
    });

    const result = resolveOnboardEntryOptions(
      {
        opts: {},
        env: {
          NEMOCLAW_FROM_DOCKERFILE: "Dockerfile.custom",
          NEMOCLAW_SANDBOX_NAME: "  Demo-Box  ",
        },
        stdinIsTty: false,
        stdoutIsTty: false,
      },
      deps,
    );

    expect(result).toMatchObject({
      resume: false,
      fresh: false,
      requestedFromDockerfile: "Dockerfile.custom",
      requestedSandboxName: "demo-box",
      cannotPrompt: true,
    });
    expect(deps.validateName).toHaveBeenCalledWith("Demo-Box", "sandbox name");
  });

  it("requires a sandbox name for --from when prompts are unavailable", () => {
    const deps = createDeps();

    expect(() =>
      resolveOnboardEntryOptions(
        {
          opts: { fromDockerfile: "Dockerfile.custom" },
          env: {},
          stdinIsTty: false,
          stdoutIsTty: true,
        },
        deps,
      ),
    ).toThrow(ExitError);
    expect(deps.error).toHaveBeenCalledWith(
      "  --from <Dockerfile> requires --name <sandbox> (or NEMOCLAW_SANDBOX_NAME) when running without a TTY or with --non-interactive.",
    );
    expect(deps.error).toHaveBeenCalledWith(
      "  A sandbox name cannot be prompted for in this context.",
    );
  });

  it("allows resume with --from and no recovered sandbox name so later resume guards can decide", () => {
    const deps = createDeps();

    const result = resolveOnboardEntryOptions(
      {
        opts: { resume: true, fromDockerfile: "Dockerfile.custom" },
        env: {},
        stdinIsTty: false,
        stdoutIsTty: true,
      },
      deps,
    );

    expect(result.resume).toBe(true);
    expect(result.requestedFromDockerfile).toBe("Dockerfile.custom");
    expect(result.requestedSandboxName).toBeNull();
  });

  it("rejects reserved sandbox command names with the original request source", () => {
    const deps = createDeps();

    expect(() =>
      resolveOnboardEntryOptions(
        {
          opts: { sandboxName: "Status" },
          env: {},
          stdinIsTty: true,
          stdoutIsTty: true,
        },
        deps,
      ),
    ).toThrow(ExitError);
    expect(deps.error).toHaveBeenCalledWith("  Reserved name: 'status' is a NemoClaw CLI command.");
    expect(deps.error).toHaveBeenCalledWith(
      "  Choose a different sandbox name (passed via --name) to avoid routing conflicts.",
    );
    expect(deps.error).not.toHaveBeenCalledWith("  Use lowercase letters, numbers, and hyphens.");
    expect(deps.getNameValidationGuidance).not.toHaveBeenCalled();
    expect(deps.exitProcess).toHaveBeenCalledTimes(1);
  });

  it("prints validation guidance for invalid sandbox names", () => {
    const deps = createDeps({
      validateName: vi.fn(() => {
        throw new Error("Invalid sandbox name");
      }),
    });

    expect(() =>
      resolveOnboardEntryOptions(
        {
          opts: { sandboxName: "bad name" },
          env: {},
          stdinIsTty: true,
          stdoutIsTty: true,
        },
        deps,
      ),
    ).toThrow(ExitError);
    expect(deps.error).toHaveBeenCalledWith("  Invalid sandbox name");
    expect(deps.error).toHaveBeenCalledWith("  Use lowercase letters, numbers, and hyphens.");
  });
});
