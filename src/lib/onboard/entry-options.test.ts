// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type OnboardEntryOptionsDeps,
  resolveOnboardEntryOptions,
  resolveOnboardRunOptions,
  withNonInteractiveEnvironment,
} from "./entry-options";

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

describe("resolveOnboardRunOptions", () => {
  it.each([
    [false, true],
    [false, false],
  ])(
    "treats auto-yes resume as non-interactive when stdin=%s and stdout=%s",
    (stdinIsTty, stdoutIsTty) => {
      expect(
        resolveOnboardRunOptions({ autoYes: true, resume: true }, {}, null, () => false, {
          stdinIsTty,
          stdoutIsTty,
        }).nonInteractive,
      ).toBe(true);
    },
  );

  it.each([
    [true, true],
    [true, false],
  ])("keeps auto-yes resume interactive when stdin=%s and stdout=%s", (stdinIsTty, stdoutIsTty) => {
    expect(
      resolveOnboardRunOptions({ autoYes: true, resume: true }, {}, null, () => false, {
        stdinIsTty,
        stdoutIsTty,
      }).nonInteractive,
    ).toBe(false);
  });

  it("keeps fresh no-TTY auto-yes interactive", () => {
    expect(
      resolveOnboardRunOptions({ autoYes: true }, {}, null, () => false, {
        stdinIsTty: false,
        stdoutIsTty: false,
      }).nonInteractive,
    ).toBe(false);
  });
});

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

  it("auto-detects resume from a persisted in_progress session without --resume (#5470)", () => {
    const deps = createDeps();

    const result = resolveOnboardEntryOptions(
      {
        opts: {},
        env: {},
        stdinIsTty: true,
        stdoutIsTty: true,
        persistedSessionStatus: "in_progress",
      },
      deps,
    );

    expect(result.resume).toBe(true);
    expect(deps.error).not.toHaveBeenCalled();
  });

  it("does not auto-resume a rejected non-resumable session", () => {
    const deps = createDeps();

    const result = resolveOnboardEntryOptions(
      {
        opts: {},
        env: {},
        stdinIsTty: true,
        stdoutIsTty: true,
        persistedSessionStatus: "failed",
      },
      deps,
    );

    expect(result.resume).toBe(false);
  });

  it.each([
    ["automatic", {}],
    ["explicit", { resume: true }],
  ])("rejects %s recovery-only continuation before onboarding effects", (_label, opts) => {
    const deps = createDeps();

    expect(() =>
      resolveOnboardEntryOptions(
        {
          opts,
          env: {},
          stdinIsTty: true,
          stdoutIsTty: true,
          persistedSessionStatus: "recovery_required",
          persistedRecoverySandboxName: "retained-sb",
          persistedSessionSandboxName: "retained-sb",
          retainedRecoverySandboxNames: ["retained-sb"],
        },
        deps,
      ),
    ).toThrow(ExitError);
    expect(deps.error).toHaveBeenCalledWith(
      expect.stringContaining("cannot use retained sandbox 'retained-sb'"),
    );
    expect(deps.error).toHaveBeenCalledWith(
      expect.stringContaining("resume, reuse, recreation, and same-name fresh onboarding"),
    );
  });

  it.each([
    ["a missing name", null],
    ["the retained name", "retained-sb"],
  ])("rejects recovery-only --fresh with %s", (_label, sandboxName) => {
    const deps = createDeps();

    expect(() =>
      resolveOnboardEntryOptions(
        {
          opts: { fresh: true, sandboxName },
          env: {},
          stdinIsTty: true,
          stdoutIsTty: true,
          persistedSessionStatus: "recovery_required",
          persistedRecoverySandboxName: "retained-sb",
        },
        deps,
      ),
    ).toThrow(ExitError);
    expect(deps.error).toHaveBeenCalledWith(
      expect.stringContaining("--fresh with an explicit sandbox name different"),
    );
  });

  it("allows recovery-only --fresh with a different explicit name", () => {
    const deps = createDeps();

    const result = resolveOnboardEntryOptions(
      {
        opts: { fresh: true, sandboxName: "replacement-sb" },
        env: {},
        stdinIsTty: true,
        stdoutIsTty: true,
        persistedSessionStatus: "recovery_required",
        persistedRecoverySandboxName: "retained-sb",
        retainedRecoverySandboxNames: ["retained-sb"],
      },
      deps,
    );

    expect(result).toMatchObject({
      fresh: true,
      resume: false,
      requestedSandboxName: "replacement-sb",
    });
    expect(deps.error).not.toHaveBeenCalled();
  });

  it("treats an explicit different name as fresh while recovery remains isolated (#10547)", () => {
    const deps = createDeps();

    const result = resolveOnboardEntryOptions(
      {
        opts: { sandboxName: "replacement-sb" },
        env: {},
        stdinIsTty: true,
        stdoutIsTty: true,
        persistedSessionStatus: "recovery_required",
        persistedRecoverySandboxName: "retained-sb",
        retainedRecoverySandboxNames: ["retained-sb"],
      },
      deps,
    );

    expect(result).toMatchObject({
      fresh: true,
      resume: false,
      requestedSandboxName: "replacement-sb",
    });
    expect(deps.error).not.toHaveBeenCalled();
  });

  it("rejects a different fresh name when recovery has no independent durable record", () => {
    const deps = createDeps();

    expect(() =>
      resolveOnboardEntryOptions(
        {
          opts: { fresh: true, sandboxName: "replacement-sb" },
          env: {},
          stdinIsTty: true,
          stdoutIsTty: true,
          persistedSessionStatus: "recovery_required",
          persistedRecoverySandboxName: "retained-sb",
          retainedRecoverySandboxNames: [],
        },
        deps,
      ),
    ).toThrow(ExitError);
    expect(deps.error).toHaveBeenCalledWith(
      expect.stringContaining("independent retained sandbox recovery record"),
    );
  });

  it("blocks a retained name after a different fresh session replaced the active session", () => {
    const deps = createDeps();

    expect(() =>
      resolveOnboardEntryOptions(
        {
          opts: { fresh: true, sandboxName: "retained-sb" },
          env: {},
          stdinIsTty: true,
          stdoutIsTty: true,
          persistedSessionStatus: "in_progress",
          persistedRecoverySandboxName: null,
          retainedRecoverySandboxNames: ["retained-sb"],
        },
        deps,
      ),
    ).toThrow(ExitError);
    expect(deps.error).toHaveBeenCalledWith(
      expect.stringContaining("retained sandbox 'retained-sb'"),
    );
  });

  it("allows a different fresh name without clearing an independent recovery record", () => {
    const deps = createDeps();

    const result = resolveOnboardEntryOptions(
      {
        opts: { fresh: true, sandboxName: "replacement-sb" },
        env: {},
        stdinIsTty: true,
        stdoutIsTty: true,
        persistedSessionStatus: "recovery_required",
        persistedRecoverySandboxName: "retained-sb",
        retainedRecoverySandboxNames: ["retained-sb"],
      },
      deps,
    );

    expect(result.requestedSandboxName).toBe("replacement-sb");
    expect(deps.error).not.toHaveBeenCalled();
  });

  it("does not auto-resume when --fresh is set even with an in_progress session (#5470)", () => {
    const deps = createDeps();

    const result = resolveOnboardEntryOptions(
      {
        opts: { fresh: true },
        env: {},
        stdinIsTty: true,
        stdoutIsTty: true,
        persistedSessionStatus: "in_progress",
      },
      deps,
    );

    // --fresh wins; an auto-detected resume must NOT trip the mutual-exclusion
    // error (that guard is for explicit --resume + --fresh only).
    expect(result.resume).toBe(false);
    expect(result.fresh).toBe(true);
    expect(deps.error).not.toHaveBeenCalled();
  });

  it.each(
    Array.from(["complete", "failed", "pending", "", null, undefined] as const, (value) => [value]),
  )("does not auto-resume from persisted session state %s (#5470)", (status) => {
    const deps = createDeps();

    const result = resolveOnboardEntryOptions(
      { opts: {}, env: {}, stdinIsTty: true, stdoutIsTty: true, persistedSessionStatus: status },
      deps,
    );
    expect(result.resume).toBe(false);
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

describe("withNonInteractiveEnvironment", () => {
  it.each([
    { label: "an unset value", env: {} as NodeJS.ProcessEnv, restored: undefined },
    {
      label: "an existing value",
      env: { NEMOCLAW_NON_INTERACTIVE: "existing" } as NodeJS.ProcessEnv,
      restored: "existing",
    },
  ])("sets the compatibility flag and restores $label", async ({ env, restored }) => {
    const run = vi.fn(async () => {
      expect(env.NEMOCLAW_NON_INTERACTIVE).toBe("1");
    });

    await withNonInteractiveEnvironment(run, env)({ nonInteractive: true });

    expect(run).toHaveBeenCalledOnce();
    expect(env.NEMOCLAW_NON_INTERACTIVE).toBe(restored);
  });

  it("restores the compatibility flag when onboarding rejects", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const run = vi.fn(async () => {
      throw new Error("onboarding failed");
    });

    await expect(withNonInteractiveEnvironment(run, env)({ nonInteractive: true })).rejects.toThrow(
      "onboarding failed",
    );
    expect(env.NEMOCLAW_NON_INTERACTIVE).toBeUndefined();
  });

  it("passes options through without changing the environment when the flag is absent", async () => {
    const env = { NEMOCLAW_NON_INTERACTIVE: "existing" } as NodeJS.ProcessEnv;
    const options = { nonInteractive: false, marker: "unchanged" };
    const run = vi.fn(async () => {});

    await withNonInteractiveEnvironment(run, env)(options);

    expect(run).toHaveBeenCalledWith(options);
    expect(env.NEMOCLAW_NON_INTERACTIVE).toBe("existing");
  });
});
