// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session, type SessionRecoveryReceipt } from "../state/onboard-session";
import type { ResumeConfigConflict } from "./resume-config";
import { type OnboardSessionBootstrapDeps, prepareOnboardSession } from "./session-bootstrap";

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function completeSandboxStep(): Session["steps"][string] {
  return {
    status: "complete",
    startedAt: "2026-06-10T00:00:00.000Z",
    completedAt: "2026-06-10T00:01:00.000Z",
    error: null,
  };
}

function createDeps(
  initialSession: Session | null = null,
  overrides: Partial<OnboardSessionBootstrapDeps> = {},
): { deps: OnboardSessionBootstrapDeps; getSession: () => Session | null } {
  let session = initialSession;
  const deps: OnboardSessionBootstrapDeps = {
    loadSession: vi.fn(() => session),
    clearSession: vi.fn(() => {
      session = null;
    }),
    createSession: vi.fn((sessionOverrides?: Partial<Session>) => createSession(sessionOverrides)),
    saveSession: vi.fn((next: Session) => {
      session = next;
      return next;
    }),
    updateSession: vi.fn((mutator: (session: Session) => Session | void) => {
      const current = session ?? createSession();
      const next = mutator(current) ?? current;
      session = next;
      return next;
    }),
    applySessionRecovery: vi.fn(),
    setOnboardBrandingAgent: vi.fn(),
    getResumeConfigConflicts: vi.fn(() => []),
    recordResumeConflict: vi.fn(async () => undefined),
    resolvePath: vi.fn((value: string) => `/abs/${value}`),
    cliName: vi.fn(() => "nemoclaw"),
    error: vi.fn(),
    exitProcess: vi.fn((code: number) => {
      throw new ExitError(code);
    }) as (code: number) => never,
    ...overrides,
  };
  return { deps, getSession: () => session };
}

describe("prepareOnboardSession", () => {
  it("creates a fresh session and records the resolved Dockerfile", async () => {
    const existing = createSession({ sessionId: "old-session" });
    const { deps, getSession } = createDeps(existing);

    const result = await prepareOnboardSession(
      {
        resume: false,
        fresh: true,
        requestedFromDockerfile: "Dockerfile.custom",
        requestedSandboxName: null,
        cannotPrompt: false,
        nonInteractive: true,
        requestedToolDisclosure: "direct",
        requestedObservabilityEnabled: true,
      },
      deps,
    );

    expect(deps.clearSession).toHaveBeenCalledTimes(1);
    expect(result.fromDockerfile).toBe("/abs/Dockerfile.custom");
    expect(result.session?.mode).toBe("non-interactive");
    expect(result.session?.metadata.fromDockerfile).toBe("/abs/Dockerfile.custom");
    expect(result.session?.toolDisclosure).toBe("direct");
    expect(result.session?.observabilityEnabled).toBe(true);
    expect(result.session?.observabilityRequestedExplicitly).toBe(true);
    expect(getSession()?.sessionId).not.toBe("old-session");
  });

  it("defaults a fresh session to progressive disclosure", async () => {
    const { deps } = createDeps();
    const result = await prepareOnboardSession(
      {
        resume: false,
        fresh: false,
        requestedFromDockerfile: null,
        requestedSandboxName: null,
        cannotPrompt: false,
        nonInteractive: false,
      },
      deps,
    );
    expect(result.session?.toolDisclosure).toBe("progressive");
    expect(result.session?.observabilityEnabled).toBe(false);
    expect(result.session?.observabilityRequestedExplicitly).toBe(false);
  });

  it("resumes an existing session and falls back to the recorded Dockerfile", async () => {
    const initial = createSession({
      agent: "hermes",
      failure: {
        step: "inference",
        message: "failed",
        recordedAt: "2026-06-10T00:00:00.000Z",
      },
      metadata: { gatewayName: "nemoclaw", fromDockerfile: "Dockerfile.recorded" },
      sandboxName: "demo",
      status: "failed",
      observabilityEnabled: true,
      observabilityRequestedExplicitly: true,
      steps: {
        ...createSession().steps,
        sandbox: completeSandboxStep(),
      },
    });
    const { deps } = createDeps(initial);

    const result = await prepareOnboardSession(
      {
        resume: true,
        fresh: false,
        requestedFromDockerfile: null,
        requestedSandboxName: null,
        cannotPrompt: true,
        nonInteractive: true,
        envAgent: "openclaw",
      },
      deps,
    );

    expect(result.fromDockerfile).toBe("/abs/Dockerfile.recorded");
    expect(result.session?.mode).toBe("non-interactive");
    expect(result.session?.failure).toBeNull();
    expect(result.session?.status).toBe("in_progress");
    expect(deps.applySessionRecovery).toHaveBeenCalledWith(initial);
    expect(result.session?.observabilityEnabled).toBe(true);
    expect(result.session?.observabilityRequestedExplicitly).toBe(true);
    expect(deps.setOnboardBrandingAgent).toHaveBeenCalledWith("hermes");
  });

  it("persists a recovered terminal snapshot receipt (#6227)", async () => {
    const initial = createSession({ sandboxName: "demo", status: "failed" });
    const receipt: SessionRecoveryReceipt = {
      id: "a".repeat(64),
      reason: "failed_terminal_snapshot",
      entry: "gateway",
      appliedAt: "2026-06-10T00:01:00.000Z",
      revision: initial.machine.revision + 1,
    };
    const applySessionRecovery = vi.fn((current: Session) => {
      current.machine = {
        version: current.machine.version,
        state: receipt.entry,
        stateEnteredAt: receipt.appliedAt,
        revision: receipt.revision,
        recoveryReceipt: receipt,
      };
    });
    const { deps } = createDeps(initial, { applySessionRecovery });

    const result = await prepareOnboardSession(
      {
        resume: true,
        fresh: false,
        requestedFromDockerfile: null,
        requestedSandboxName: null,
        cannotPrompt: false,
        nonInteractive: false,
      },
      deps,
    );

    expect(result.session?.machine.recoveryReceipt).toEqual(receipt);
  });

  it.each([
    { recorded: true, requested: false },
    { recorded: false, requested: true },
  ])("records an explicit observability request while resuming", async ({
    recorded,
    requested,
  }) => {
    const { deps } = createDeps(
      createSession({
        sandboxName: "demo",
        observabilityEnabled: recorded,
        status: "failed",
      }),
    );

    const result = await prepareOnboardSession(
      {
        resume: true,
        fresh: false,
        requestedFromDockerfile: null,
        requestedSandboxName: null,
        cannotPrompt: false,
        nonInteractive: false,
        requestedObservabilityEnabled: requested,
      },
      deps,
    );

    expect(result.session?.observabilityEnabled).toBe(requested);
    expect(result.session?.observabilityRequestedExplicitly).toBe(true);
  });

  it("records and reports resume conflicts before exiting", async () => {
    const conflict: ResumeConfigConflict = {
      field: "fromDockerfile",
      requested: "/abs/Dockerfile.new",
      recorded: "/abs/Dockerfile.old",
    };
    const { deps } = createDeps(createSession(), {
      getResumeConfigConflicts: vi.fn(() => [conflict]),
    });

    await expect(
      prepareOnboardSession(
        {
          resume: true,
          fresh: false,
          requestedFromDockerfile: "Dockerfile.new",
          requestedSandboxName: null,
          cannotPrompt: false,
          nonInteractive: false,
        },
        deps,
      ),
    ).rejects.toThrow(ExitError);

    expect(deps.recordResumeConflict).toHaveBeenCalledWith(conflict);
    expect(deps.error).toHaveBeenCalledWith(
      "  Session was started with --from '/abs/Dockerfile.old', not '/abs/Dockerfile.new'.",
    );
    expect(deps.error).toHaveBeenCalledWith(
      "  Run: nemoclaw onboard              # start a fresh onboarding session",
    );
    expect(deps.exitProcess).toHaveBeenCalledWith(1);
  });

  it("still exits on resume conflicts when diagnostic recording fails", async () => {
    const conflict: ResumeConfigConflict = {
      field: "sandbox",
      requested: "new-box",
      recorded: "old-box",
    };
    const { deps } = createDeps(createSession(), {
      getResumeConfigConflicts: vi.fn(() => [conflict]),
      recordResumeConflict: vi.fn(async () => {
        throw new Error("diagnostic write failed");
      }),
    });

    await expect(
      prepareOnboardSession(
        {
          resume: true,
          fresh: false,
          requestedFromDockerfile: null,
          requestedSandboxName: "new-box",
          cannotPrompt: false,
          nonInteractive: false,
        },
        deps,
      ),
    ).rejects.toThrow(ExitError);

    expect(deps.recordResumeConflict).toHaveBeenCalledWith(conflict);
    expect(deps.error).toHaveBeenCalledWith(
      "  Resumable state belongs to sandbox 'old-box', not 'new-box'.",
    );
    expect(deps.exitProcess).toHaveBeenCalledWith(1);
    expect(deps.updateSession).not.toHaveBeenCalled();
  });

  it("rejects non-interactive resume when no sandbox name can be recovered", async () => {
    const { deps } = createDeps(createSession({ sandboxName: null }));

    await expect(
      prepareOnboardSession(
        {
          resume: true,
          fresh: false,
          requestedFromDockerfile: null,
          requestedSandboxName: null,
          cannotPrompt: true,
          nonInteractive: true,
        },
        deps,
      ),
    ).rejects.toThrow(ExitError);

    expect(deps.error).toHaveBeenCalledWith(
      "  Cannot resume non-interactive onboard: the previous run was interrupted before sandbox creation completed,",
    );
    expect(deps.error).toHaveBeenCalledWith(
      "  so no sandbox name was recorded. Re-run with --name <sandbox> (or set NEMOCLAW_SANDBOX_NAME).",
    );
    expect(deps.exitProcess).toHaveBeenCalledTimes(1);
  });

  it("allows interactive resume to prompt when no sandbox name was recorded", async () => {
    const { deps } = createDeps(createSession({ sandboxName: null }));

    const result = await prepareOnboardSession(
      {
        resume: true,
        fresh: false,
        requestedFromDockerfile: null,
        requestedSandboxName: null,
        cannotPrompt: false,
        nonInteractive: false,
      },
      deps,
    );

    expect(result.session?.sandboxName).toBeNull();
    expect(result.session?.status).toBe("in_progress");
    expect(deps.error).not.toHaveBeenCalled();
    expect(deps.exitProcess).not.toHaveBeenCalled();
  });
});
