// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { decisionSelected, decisionUnset } from "../state/onboard-checkpoint-decision";
import { NEMOCLAW_VLLM_GPU_DEVICE_ENV } from "../inference/vllm-models";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointLoadResult,
  type OnboardCheckpoint,
} from "../state/onboard-checkpoint-types";
import { createSession, type Session, type SessionRecoveryReceipt } from "../state/onboard-session";
import type { ResumeConfigConflict } from "./resume-config";
import {
  checkpointSandboxName,
  type OnboardSessionBootstrapDeps,
  prepareOnboardSession,
} from "./session-bootstrap";

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

const SERVING_PROFILE_PROVENANCE = {
  schemaVersion: 1,
  catalogDigest: `sha256:${"1".repeat(64)}`,
  preset: {
    id: "vllm.dgx-spark-gb10.single.example",
    digest: `sha256:${"2".repeat(64)}`,
    displayName: "Example Spark profile",
    supportState: "experimental",
  },
  recipe: {
    id: "vllm.dgx-spark-gb10.single.example",
    digest: `sha256:${"3".repeat(64)}`,
    backend: "vllm",
  },
  model: { id: "example/model", revision: "revision-1" },
  runtimeImage: null,
  estimatedImageDownloadBytes: null,
  estimatedModelDownloadBytes: null,
} as const;

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
    requireHostMountRuntimeSupport: vi.fn(),
    resolveResumeCheckpoint: vi.fn((): CheckpointLoadResult => ({ status: "none" })),
    ...overrides,
  };
  return { deps, getSession: () => session };
}

describe("prepareOnboardSession", () => {
  it("stops resume before side effects when saved policy authority is invalid (#9833)", async () => {
    const loadSession = vi.fn((): Session | null => {
      throw new Error(
        "Refusing to load the onboarding session: the saved policy authority is invalid.",
      );
    });
    const { deps } = createDeps(null, { loadSession });

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
    ).rejects.toThrow(/saved policy authority is invalid/u);

    expect(loadSession).toHaveBeenCalledOnce();
    expect(deps.requireHostMountRuntimeSupport).not.toHaveBeenCalled();
    expect(deps.setOnboardBrandingAgent).not.toHaveBeenCalled();
    expect(deps.updateSession).not.toHaveBeenCalled();
    expect(deps.saveSession).not.toHaveBeenCalled();
    expect(deps.clearSession).not.toHaveBeenCalled();
  });

  it.each([
    ["requested", createSession(), true],
    ["recorded", createSession({ apfInterceptorRequested: true }), false],
  ])(
    "rejects %s APF selection before resumed-session effects (#9833)",
    async (_source, initial, requested) => {
      const { deps } = createDeps(initial);

      await expect(
        prepareOnboardSession(
          {
            resume: true,
            fresh: false,
            requestedFromDockerfile: null,
            requestedSandboxName: null,
            cannotPrompt: true,
            nonInteractive: true,
            apfInterceptorRequested: requested,
          },
          deps,
        ),
      ).rejects.toMatchObject({ code: 1 });

      expect(deps.requireHostMountRuntimeSupport).not.toHaveBeenCalled();
      expect(deps.setOnboardBrandingAgent).not.toHaveBeenCalled();
      expect(deps.updateSession).not.toHaveBeenCalled();
      expect(deps.saveSession).not.toHaveBeenCalled();
      expect(deps.clearSession).not.toHaveBeenCalled();
    },
  );

  it("rejects APF sandbox recreation before fresh-session mutation (#9833)", async () => {
    const { deps } = createDeps(createSession({ sessionId: "existing" }));

    await expect(
      prepareOnboardSession(
        {
          resume: false,
          fresh: true,
          recreateSandboxRequested: true,
          apfInterceptorRequested: true,
          requestedFromDockerfile: null,
          requestedSandboxName: "alpha",
          cannotPrompt: true,
          nonInteractive: true,
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 1 });

    expect(deps.requireHostMountRuntimeSupport).not.toHaveBeenCalled();
    expect(deps.clearSession).not.toHaveBeenCalled();
    expect(deps.createSession).not.toHaveBeenCalled();
    expect(deps.saveSession).not.toHaveBeenCalled();
  });

  it("rejects APF with the Portable profile before fresh-session mutation (#9833)", async () => {
    const { deps } = createDeps(createSession({ sessionId: "existing" }));

    await expect(
      prepareOnboardSession(
        {
          resume: false,
          fresh: true,
          apfInterceptorRequested: true,
          checkpointProfile: "portable",
          requestedFromDockerfile: null,
          requestedSandboxName: "alpha",
          cannotPrompt: true,
          nonInteractive: true,
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 1 });

    expect(deps.error).toHaveBeenCalledWith(
      "  APF interceptor selection cannot use the Portable experimental profile.",
    );
    expect(deps.requireHostMountRuntimeSupport).not.toHaveBeenCalled();
    expect(deps.clearSession).not.toHaveBeenCalled();
    expect(deps.createSession).not.toHaveBeenCalled();
    expect(deps.saveSession).not.toHaveBeenCalled();
  });

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
        apfInterceptorRequested: true,
        requestedHostMounts: [
          { source: "/srv/project", target: "/sandbox/project", readOnly: true },
        ],
      },
      deps,
    );

    expect(deps.clearSession).toHaveBeenCalledTimes(1);
    expect(result.fromDockerfile).toBe("/abs/Dockerfile.custom");
    expect(result.session?.mode).toBe("non-interactive");
    expect(result.session?.metadata.fromDockerfile).toBe("/abs/Dockerfile.custom");
    expect(result.session?.metadata.hostMounts).toEqual([
      { source: "/srv/project", target: "/sandbox/project", readOnly: true },
    ]);
    expect(result.session?.toolDisclosure).toBe("direct");
    expect(result.session?.observabilityEnabled).toBe(true);
    expect(result.session?.observabilityRequestedExplicitly).toBe(true);
    expect(result.session?.apfInterceptorRequested).toBe(true);
    expect(getSession()?.sessionId).not.toBe("old-session");
  });

  it("rejects unsupported fresh-session host mounts before changing session state", async () => {
    const existing = createSession({ sessionId: "old-session" });
    const requireHostMountRuntimeSupport = vi.fn(() => {
      throw new Error("unsupported runtime provider");
    });
    const { deps } = createDeps(existing, { requireHostMountRuntimeSupport });
    const mounts = [
      { source: "/srv/project", target: "/sandbox/project", readOnly: true as const },
    ];

    await expect(
      prepareOnboardSession(
        {
          resume: false,
          fresh: true,
          requestedFromDockerfile: null,
          requestedSandboxName: null,
          requestedHostMounts: mounts,
          cannotPrompt: true,
          nonInteractive: true,
        },
        deps,
      ),
    ).rejects.toThrow("unsupported runtime provider");

    expect(requireHostMountRuntimeSupport).toHaveBeenCalledWith(mounts, undefined);
    expect(deps.clearSession).not.toHaveBeenCalled();
    expect(deps.saveSession).not.toHaveBeenCalled();
  });

  it("publishes portable runtime intent in the first atomic session envelope", async () => {
    const { deps } = createDeps();
    const authority = {
      schemaVersion: 1 as const,
      kind: "podman" as const,
      ownership: "current-user" as const,
      uid: 1000,
      homeDir: "/home/alice",
      configHome: "/home/alice/.config",
      runtimeDir: "/run/user/1000",
      socketPath: "/run/user/1000/podman/podman.sock",
    };

    const result = await prepareOnboardSession(
      {
        resume: false,
        fresh: false,
        requestedFromDockerfile: null,
        requestedSandboxName: null,
        cannotPrompt: true,
        nonInteractive: true,
        checkpointProfile: "portable",
        portableRuntimeAuthority: authority,
      },
      deps,
    );

    expect(deps.createSession).toHaveBeenCalledTimes(1);
    expect(deps.saveSession).toHaveBeenCalledTimes(1);
    expect(deps.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: expect.objectContaining({
          schemaVersion: 4,
          profile: { kind: "selected", value: "portable" },
          runtimeAuthority: { kind: "selected", value: authority },
        }),
      }),
    );
    expect(result.session?.checkpoint?.runtimeAuthority).toEqual({
      kind: "selected",
      value: authority,
    });
  });

  it("checkpoints exact serving profile provenance before fresh onboarding effects (#8246)", async () => {
    const { deps } = createDeps();
    const result = await prepareOnboardSession(
      {
        resume: false,
        fresh: false,
        requestedFromDockerfile: null,
        requestedSandboxName: "profile-test",
        cannotPrompt: true,
        nonInteractive: true,
        servingProfileProvenance: SERVING_PROFILE_PROVENANCE,
      },
      deps,
    );

    expect(result.session?.servingProfileProvenance).toEqual(SERVING_PROFILE_PROVENANCE);
  });

  it("checkpoints the managed vLLM GPU device before fresh onboarding effects", async () => {
    vi.stubEnv(NEMOCLAW_VLLM_GPU_DEVICE_ENV, "GPU-69adb14e-820e-bfb4-0993-171e73f68504");
    const { deps } = createDeps();
    const result = await prepareOnboardSession(
      {
        resume: false,
        fresh: false,
        requestedFromDockerfile: null,
        requestedSandboxName: "gpu-test",
        cannotPrompt: true,
        nonInteractive: true,
      },
      deps,
    );

    expect(result.session?.vllmGpuDevice).toBe("GPU-69adb14e-820e-bfb4-0993-171e73f68504");
  });

  it("checkpoints Station Express choices before managed vLLM setup", async () => {
    const { deps } = createDeps();
    const stationExpress = {
      version: 1 as const,
      model: "nemotron-3-ultra-550b-a55b",
      sandboxName: "my-assistant",
    };

    const result = await prepareOnboardSession(
      {
        resume: false,
        fresh: false,
        requestedFromDockerfile: null,
        requestedSandboxName: "my-assistant",
        cannotPrompt: true,
        nonInteractive: true,
        stationExpressIntent: stationExpress,
      },
      deps,
    );

    expect(result.session?.stationExpressIntent).toEqual(stationExpress);
    expect(result.session?.provider).toBeNull();
    expect(result.session?.model).toBeNull();
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
      metadata: {
        gatewayName: "nemoclaw",
        fromDockerfile: "Dockerfile.recorded",
        hostMounts: [{ source: "/srv/project", target: "/sandbox/project", readOnly: true }],
      },
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
    expect(result.session?.metadata.hostMounts).toEqual([
      { source: "/srv/project", target: "/sandbox/project", readOnly: true },
    ]);
    expect(deps.setOnboardBrandingAgent).toHaveBeenCalledWith("hermes");
  });

  it("rejects unsupported persisted host mounts before changing a resumed session", async () => {
    const mounts = [
      { source: "/srv/project", target: "/sandbox/project", readOnly: true as const },
    ];
    const initial = createSession({
      metadata: { gatewayName: "nemoclaw", fromDockerfile: null, hostMounts: mounts },
    });
    const requireHostMountRuntimeSupport = vi.fn(() => {
      throw new Error("unsupported runtime provider");
    });
    const { deps } = createDeps(initial, { requireHostMountRuntimeSupport });

    await expect(
      prepareOnboardSession(
        {
          resume: true,
          fresh: false,
          requestedFromDockerfile: null,
          requestedSandboxName: null,
          cannotPrompt: true,
          nonInteractive: true,
          checkpointProfile: "portable",
        },
        deps,
      ),
    ).rejects.toThrow("unsupported runtime provider");

    expect(requireHostMountRuntimeSupport).toHaveBeenCalledWith(mounts, "portable");
    expect(deps.updateSession).not.toHaveBeenCalled();
    expect(deps.applySessionRecovery).not.toHaveBeenCalled();
  });

  it("preserves recorded serving profile provenance during resume (#8246)", async () => {
    const initial = createSession({
      sandboxName: "profile-test",
      servingProfileProvenance: SERVING_PROFILE_PROVENANCE,
    });
    const { deps } = createDeps(initial);
    const result = await prepareOnboardSession(
      {
        resume: true,
        fresh: false,
        requestedFromDockerfile: null,
        requestedSandboxName: "profile-test",
        cannotPrompt: true,
        nonInteractive: true,
        servingProfileProvenance: SERVING_PROFILE_PROVENANCE,
      },
      deps,
    );

    expect(result.session?.servingProfileProvenance).toEqual(SERVING_PROFILE_PROVENANCE);
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
  ])(
    "records an explicit observability request while resuming",
    async ({ recorded, requested }) => {
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
    },
  );

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

  it("checks requested host mounts for resume conflict without overwriting recorded state", async () => {
    const recordedMount = {
      source: "/srv/project",
      target: "/sandbox/project",
      readOnly: true as const,
    };
    const requestedMount = {
      source: "/srv/reference",
      target: "/sandbox/reference",
      readOnly: true as const,
    };
    const initial = createSession({
      metadata: { gatewayName: "nemoclaw", fromDockerfile: null, hostMounts: [recordedMount] },
    });
    const conflict: ResumeConfigConflict = {
      field: "host mounts",
      requested: JSON.stringify([requestedMount]),
      recorded: JSON.stringify([recordedMount]),
    };
    const getResumeConfigConflicts = vi.fn(() => [conflict]);
    const { deps } = createDeps(initial, { getResumeConfigConflicts });

    await expect(
      prepareOnboardSession(
        {
          resume: true,
          fresh: false,
          requestedFromDockerfile: null,
          requestedSandboxName: null,
          requestedHostMounts: [requestedMount],
          cannotPrompt: false,
          nonInteractive: false,
        },
        deps,
      ),
    ).rejects.toThrow(ExitError);

    expect(getResumeConfigConflicts).toHaveBeenCalledWith(
      initial,
      expect.objectContaining({ hostMounts: [requestedMount] }),
    );
    expect(deps.updateSession).not.toHaveBeenCalled();
    expect(initial.metadata.hostMounts).toEqual([recordedMount]);
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

  it("allows non-interactive resume with a checkpointed sandbox name", async () => {
    const session = createSession({
      sandboxName: "checkpointed-box",
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: false,
        messaging: false,
        resourceProfile: false,
      },
    });
    const { deps } = createDeps(session);

    const result = await prepareOnboardSession(
      {
        resume: true,
        fresh: false,
        requestedFromDockerfile: null,
        requestedSandboxName: null,
        cannotPrompt: true,
        nonInteractive: true,
      },
      deps,
    );

    expect(result.session?.sandboxName).toBe("checkpointed-box");
    expect(deps.exitProcess).not.toHaveBeenCalled();
  });

  it("allows no-TTY resume after review-stage identity persistence (#8687)", async () => {
    const session = createSession({
      provider: "ollama-local",
      model: "qwen3.5:9b",
      status: "failed",
    });
    await checkpointSandboxName("review-interrupted", { name: "openclaw" }, (mutator) => {
      return mutator(session) ?? session;
    });
    session.steps.provider_selection.status = "failed";
    const { deps } = createDeps(session);

    const result = await prepareOnboardSession(
      {
        resume: true,
        fresh: false,
        requestedFromDockerfile: null,
        requestedSandboxName: null,
        cannotPrompt: true,
        nonInteractive: true,
      },
      deps,
    );

    expect(result.session).toMatchObject({
      sandboxName: "review-interrupted",
      provider: "ollama-local",
      model: "qwen3.5:9b",
      checkpoint: {
        sandboxIdentity: decisionSelected({ name: "review-interrupted", agent: "openclaw" }),
      },
    });
    expect(deps.exitProcess).not.toHaveBeenCalled();
  });

  it("persists Hermes review identity for no-TTY resume (#8687)", async () => {
    const session = createSession({ agent: "hermes", status: "failed" });
    await checkpointSandboxName("hermes-review", { name: "hermes" }, (mutator) => {
      return mutator(session) ?? session;
    });
    session.steps.provider_selection.status = "failed";
    const { deps } = createDeps(session);

    const result = await prepareOnboardSession(
      {
        resume: true,
        fresh: false,
        requestedFromDockerfile: null,
        requestedSandboxName: null,
        cannotPrompt: true,
        nonInteractive: true,
      },
      deps,
    );

    expect(result.session).toMatchObject({
      sandboxName: "hermes-review",
      checkpoint: {
        sandboxIdentity: decisionSelected({ name: "hermes-review", agent: "hermes" }),
      },
    });
    expect(deps.exitProcess).not.toHaveBeenCalled();
  });

  it("waits for canonical sandbox identity persistence before returning (#8687)", async () => {
    const session = createSession();
    let release: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completed = false;
    const checkpoint = checkpointSandboxName(
      "review-race",
      { name: "openclaw" },
      async (mutator) => {
        await writeStarted;
        const next = mutator(session) ?? session;
        completed = true;
        return next;
      },
    );

    await Promise.resolve();
    expect(completed).toBe(false);
    expect(session.checkpoint).toBeNull();
    release?.();
    await checkpoint;

    expect(completed).toBe(true);
    expect(session).toMatchObject({
      sandboxName: "review-race",
      sandboxPromptProgress: { sandboxName: true },
      checkpoint: {
        sandboxIdentity: decisionSelected({ name: "review-race", agent: "openclaw" }),
      },
    });
  });

  it("recovers a non-OpenClaw checkpointed sandbox name after a crash before the legacy field was written (#7022)", async () => {
    const session = createSession({ agent: "hermes", sandboxName: null });
    const checkpoint: OnboardCheckpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      profile: { kind: "selected", value: "default" },
      runtimeAuthority: { kind: "unset" },
      sessionId: session.sessionId,
      machineState: "sandbox",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sandboxIdentity: decisionSelected({ name: "hermes-box", agent: "hermes" }),
      webSearch: decisionUnset(),
      messaging: decisionUnset(),
      resourceProfile: decisionUnset(),
      gatewayAuthority: decisionUnset(),
      effectGroups: {},
      bindings: { credentialEnvs: [], registeredProviders: [] },
      sandboxRecreate: null,
    };
    session.checkpoint = checkpoint;
    const { deps } = createDeps(session, {
      resolveResumeCheckpoint: vi.fn((): CheckpointLoadResult => ({
        status: "loaded",
        checkpoint,
      })),
    });

    const result = await prepareOnboardSession(
      {
        resume: true,
        fresh: false,
        requestedFromDockerfile: null,
        requestedSandboxName: null,
        cannotPrompt: true,
        nonInteractive: true,
      },
      deps,
    );

    expect(deps.error).not.toHaveBeenCalledWith(
      "  Cannot resume non-interactive onboard: the previous run was interrupted before sandbox creation completed,",
    );
    expect(deps.exitProcess).not.toHaveBeenCalled();
    expect(result.session?.checkpoint?.sandboxIdentity).toEqual(
      decisionSelected({ name: "hermes-box", agent: "hermes" }),
    );
  });

  it("does not let a stale legacy checkpointed-name marker override an unset checkpoint identity (#7022)", async () => {
    const session = createSession({
      sandboxName: "stale-box",
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: false,
        messaging: false,
        resourceProfile: false,
      },
    });
    session.checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      profile: { kind: "selected", value: "default" },
      runtimeAuthority: { kind: "unset" },
      sessionId: session.sessionId,
      machineState: "sandbox",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sandboxIdentity: decisionUnset(),
      webSearch: decisionUnset(),
      messaging: decisionUnset(),
      resourceProfile: decisionUnset(),
      gatewayAuthority: decisionUnset(),
      effectGroups: {},
      bindings: { credentialEnvs: [], registeredProviders: [] },
      sandboxRecreate: null,
    };
    const { deps } = createDeps(session);

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
      "  so no sandbox name was recorded. Re-run with --name <sandbox> (or set NEMOCLAW_SANDBOX_NAME).",
    );
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
