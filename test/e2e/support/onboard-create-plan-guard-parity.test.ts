// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type OnboardEntryOptionsDeps,
  resolveOnboardEntryOptions,
} from "../../../src/lib/onboard/entry-options";

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function createDeps(overrides: Partial<OnboardEntryOptionsDeps> = {}): OnboardEntryOptionsDeps {
  return {
    isNonInteractive: vi.fn(() => false),
    validateName: vi.fn((name: string) => name.trim().toLowerCase()),
    reservedSandboxNames: new Set(),
    cliDisplayName: vi.fn(() => "NemoClaw"),
    getNameValidationGuidance: vi.fn(() => ["Use lowercase letters, numbers, and hyphens."]),
    error: vi.fn(),
    exitProcess: vi.fn((code: number) => {
      throw new ExitError(code);
    }) as (code: number) => never,
    ...overrides,
  };
}

function expectExitOne(run: () => unknown): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ExitError);
  expect(thrown).toMatchObject({ code: 1 });
}

describe("Package D onboard create-plan guard parity", () => {
  it("preserves the legacy --from missing-name guard when prompts are unavailable", () => {
    const deps = createDeps();

    expectExitOne(() =>
      resolveOnboardEntryOptions(
        {
          opts: { fromDockerfile: "Dockerfile.custom" },
          env: {},
          stdinIsTty: false,
          stdoutIsTty: true,
        },
        deps,
      ),
    );
    expect(deps.error).toHaveBeenCalledWith(
      "  --from <Dockerfile> requires --name <sandbox> (or NEMOCLAW_SANDBOX_NAME) when running without a TTY or with --non-interactive.",
    );
    expect(deps.error).toHaveBeenCalledWith(
      "  A sandbox name cannot be prompted for in this context.",
    );
  });

  it("preserves the legacy --from + NEMOCLAW_SANDBOX_NAME validation path", () => {
    const deps = createDeps({
      validateName: vi.fn(() => {
        throw new Error("Invalid sandbox name");
      }),
    });

    expectExitOne(() =>
      resolveOnboardEntryOptions(
        {
          opts: { fromDockerfile: "Dockerfile.custom" },
          env: { NEMOCLAW_SANDBOX_NAME: "bad name" },
          stdinIsTty: false,
          stdoutIsTty: true,
        },
        deps,
      ),
    );
    expect(deps.validateName).toHaveBeenCalledWith("bad name", "sandbox name");
    expect(deps.error).toHaveBeenCalledWith("  Invalid sandbox name");
    expect(deps.error).not.toHaveBeenCalledWith(
      "  --from <Dockerfile> requires --name <sandbox> (or NEMOCLAW_SANDBOX_NAME) when running without a TTY or with --non-interactive.",
    );
  });
});
