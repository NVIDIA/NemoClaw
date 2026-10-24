// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  OpenShellForwardAdapter,
  OpenShellForwardIdentity,
  OpenShellForwardObservation,
} from "../../../adapters/openshell/forward";
import {
  HermesPortableForwardRecoveryError,
  prepareHermesPortableLaunchForwards,
  recoverHermesPortableLaunchForwards,
  verifyHermesPortableLaunchForwards,
  type HermesPortableForwardRecoveryInput,
} from "./hermes-portable-forward-adapter-recovery";

const AUTHORITY_ERROR = {
  kind: "authority",
  message: "NemoClaw could not prove current OpenShell forward authority.",
} as const;

function forward(port: number): OpenShellForwardIdentity {
  return {
    gatewayEndpoint: "https://127.0.0.1:8080",
    gatewayName: "nemoclaw",
    workspace: "default",
    sandboxName: "hermes-box",
    localHost: "127.0.0.1",
    port,
  };
}

function fixture(initial: ReadonlyMap<number, OpenShellForwardObservation["state"]>) {
  const states = new Map(initial);
  const startForward = vi.fn<OpenShellForwardAdapter["startForward"]>(
    async ({ forward: target }) => {
      const state = states.get(target.port) ?? "absent";
      switch (state) {
        case "owned":
          return { state: "reused", forward: target };
        case "stale":
        case "foreign":
        case "indeterminate":
          return {
            state: "refused",
            observation:
              state === "indeterminate"
                ? { state, forward: target, error: AUTHORITY_ERROR }
                : { state, forward: target },
          };
        case "absent":
          break;
      }
      states.set(target.port, "owned");
      return {
        state: "started",
        forward: target,
        cleanup: async () => {
          states.set(target.port, "absent");
          return { state: "released" };
        },
      };
    },
  );
  const retireLegacyForward = vi.fn<OpenShellForwardAdapter["retireLegacyForward"]>(
    async ({ forward: target, authorize }) => {
      await authorize(target);
      switch (states.get(target.port)) {
        case "stale":
          states.set(target.port, "absent");
          return { state: "retired", forward: target };
        default:
          return { state: "not_needed", observation: { state: "absent", forward: target } };
      }
    },
  );
  const adapter: OpenShellForwardAdapter = {
    observeForwards: vi.fn(async ({ forwards }) =>
      forwards.map((target: OpenShellForwardIdentity) => {
        const state = states.get(target.port) ?? "absent";
        return state === "indeterminate"
          ? { state, forward: target, error: AUTHORITY_ERROR }
          : { state, forward: target };
      }),
    ),
    startForward,
    retireLegacyForward,
    verifyForwardRelease: vi.fn(async ({ forwards }) => {
      const bound = forwards.filter(
        (target: OpenShellForwardIdentity) => states.get(target.port) === "owned",
      );
      return bound.length === 0
        ? ({ state: "released" } as const)
        : ({ state: "bound", forwards: bound } as const);
    }),
  };
  const forwards = [forward(18_789), forward(8_642)];
  const input: HermesPortableForwardRecoveryInput = {
    intent: "connect-probe-only",
    sandboxName: "hermes-box",
    gatewayName: "nemoclaw",
    operationTimeoutMs: 30_000,
    probeTimeoutMs: 5_000,
    ports: forwards.map((target) => target.port),
    forwards,
    deps: {
      adapter,
      assertCurrent: vi.fn(),
      assertRollbackCurrent: vi.fn(),
    },
  };
  return { input, states, startForward, retireLegacyForward };
}

function wildcardApiFixture(apiPort = 8_642) {
  const test = fixture(
    new Map([
      [18_789, "owned"],
      [apiPort, "foreign"],
    ]),
  );
  const sandbox = { agent: "hermes", hermesApiPort: apiPort };
  let wildcard = true;
  vi.mocked(test.input.deps.adapter.observeForwards).mockImplementation(async (request) => {
    await request.assertCurrent?.();
    return request.forwards.map((target) => {
      const state =
        target.port === apiPort && wildcard
          ? target.localHost === "127.0.0.1"
            ? ("foreign" as const)
            : ("owned" as const)
          : (test.states.get(target.port) ?? "absent");
      return state === "indeterminate"
        ? { state, forward: target, error: AUTHORITY_ERROR }
        : { state, forward: target };
    });
  });
  test.retireLegacyForward.mockImplementation(async (request) => {
    await request.assertCurrent?.();
    await request.authorize(request.forward);
    wildcard = false;
    test.states.set(apiPort, "absent");
    return { state: "retired", forward: request.forward };
  });
  const input = {
    ...test.input,
    ports: [18_789, apiPort],
    forwards: [forward(18_789), forward(apiPort)],
    deps: { ...test.input.deps, readSandbox: () => sandbox },
  };
  return { ...test, input, sandbox };
}

describe("Hermes Portable typed forward recovery", () => {
  afterEach(() => vi.restoreAllMocks());
  it("verifies an already-owned forward set without a mutation", async () => {
    const test = fixture(
      new Map([
        [18_789, "owned"],
        [8_642, "owned"],
      ]),
    );

    await expect(recoverHermesPortableLaunchForwards(test.input)).resolves.toEqual({
      kind: "verified",
      restoredPorts: [],
    });
    expect(test.startForward).not.toHaveBeenCalled();
    expect(test.retireLegacyForward).not.toHaveBeenCalled();
  });

  it.each([8_642, 8_643])(
    "migrates an owned wildcard registered API on port %i and rolls back the replacement",
    async (apiPort) => {
      const test = wildcardApiFixture(apiPort);
      const onComplete = vi.fn();
      const prepared = await prepareHermesPortableLaunchForwards({
        ...test.input,
        timing: { onComplete },
      });
      expect(onComplete).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          listCount: 3,
          stopCount: 1,
          startCount: 1,
          settleCount: 1,
          result: "proved",
        }),
      );
      expect(prepared.result).toEqual({ kind: "restored", restoredPorts: [apiPort] });
      expect(test.retireLegacyForward).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          forward: expect.objectContaining({ port: apiPort, localHost: "0.0.0.0" }),
          migrateToLoopback: true,
          timeoutMs: expect.any(Number),
        }),
      );
      expect(test.startForward).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          forward: expect.objectContaining({ port: apiPort, localHost: "127.0.0.1" }),
          timeoutMs: expect.any(Number),
        }),
      );
      await prepared.rollback();
      expect(test.states.get(apiPort)).toBe("absent");
      expect(test.states.get(18_789)).toBe("owned");
    },
  );

  it("reconciles an absent API after its first loopback start fails", async () => {
    const test = wildcardApiFixture();
    test.startForward.mockResolvedValueOnce({
      state: "failed",
      effect: "none",
      forward: forward(8_642),
      error: { kind: "command", message: "The OpenShell forward command failed." },
      failure: { stage: "startup", reason: "child_exited", exitStatus: 17 },
    });
    const prepared = await prepareHermesPortableLaunchForwards(test.input);
    expect(prepared.result).toEqual({ kind: "restored", restoredPorts: [8_642] });
    expect(test.startForward).toHaveBeenCalledTimes(2);
    expect(test.startForward.mock.calls.map(([request]) => request.forward.localHost)).toEqual([
      "127.0.0.1",
      "127.0.0.1",
    ]);
    expect(test.states.get(8_642)).toBe("owned");
    await prepared.rollback();
    expect(test.states.get(8_642)).toBe("absent");
  });

  it.each([undefined, 23])(
    "preserves startup diagnostics when the retry exit status is %s",
    async (retryExitStatus) => {
      const test = wildcardApiFixture();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      test.startForward.mockResolvedValueOnce({
        state: "failed",
        effect: "none",
        forward: forward(8_642),
        error: { kind: "command", message: "The OpenShell forward command failed." },
        failure: { stage: "startup", reason: "child_exited", exitStatus: 17 },
      });
      test.startForward.mockResolvedValueOnce({
        state: "failed",
        effect: "none",
        forward: forward(8_642),
        error: { kind: "command", message: "The OpenShell forward command failed." },
        ...(retryExitStatus === undefined
          ? {}
          : {
              failure: {
                stage: "startup",
                reason: "child_exited",
                exitStatus: retryExitStatus,
              } as const,
            }),
      });
      await expect(prepareHermesPortableLaunchForwards(test.input)).rejects.toMatchObject({
        failure: "recovery-failed",
        context: { startupFailure: { exitStatus: retryExitStatus ?? 17 } },
      });
      expect(test.startForward).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("forward-start startup/child_exited status=17"),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("loopback reconciliation could not prove restoration"),
      );
      expect(test.states.get(8_642)).toBe("absent");
    },
  );

  it("does not retry a replacement whose cleanup is uncertain", async () => {
    const test = wildcardApiFixture();
    test.startForward.mockResolvedValueOnce({
      state: "cleanup_uncertain",
      effect: "possible",
      forward: forward(8_642),
      error: { kind: "cleanup", message: "NemoClaw could not prove OpenShell forward cleanup." },
    });
    await expect(prepareHermesPortableLaunchForwards(test.input)).rejects.toMatchObject({
      failure: "restoration-unproved",
    });
    expect(test.startForward).toHaveBeenCalledOnce();
  });

  it("does not retry when a foreign listener appears after retirement", async () => {
    const test = wildcardApiFixture();
    test.startForward.mockImplementationOnce(async () => {
      test.states.set(8_642, "foreign");
      return {
        state: "failed",
        effect: "none",
        forward: forward(8_642),
        error: { kind: "command", message: "The OpenShell forward command failed." },
      };
    });
    await expect(prepareHermesPortableLaunchForwards(test.input)).rejects.toMatchObject({
      failure: "recovery-failed",
    });
    expect(test.startForward).toHaveBeenCalledOnce();
    expect(test.states.get(8_642)).toBe("foreign");
  });

  it("refuses reconciliation after the registered API identity changes", async () => {
    const test = wildcardApiFixture();
    test.startForward.mockImplementationOnce(async () => {
      test.sandbox.hermesApiPort = 8_643;
      return {
        state: "failed",
        effect: "none",
        forward: forward(8_642),
        error: { kind: "command", message: "The OpenShell forward command failed." },
      };
    });
    await expect(prepareHermesPortableLaunchForwards(test.input)).rejects.toMatchObject({
      failure: "recovery-failed",
    });
    expect(test.startForward).toHaveBeenCalledOnce();
    expect(test.states.get(8_642)).toBe("absent");
  });

  it.each([
    { agent: "openclaw", hermesApiPort: 8_642 },
    { agent: "hermes", hermesApiPort: 8_643 },
  ])("preserves a wildcard listener outside the registered Hermes API: %j", async (sandbox) => {
    const test = wildcardApiFixture();
    Object.assign(test.sandbox, sandbox);
    await expect(recoverHermesPortableLaunchForwards(test.input)).rejects.toMatchObject({
      failure: "forward-occupied",
    });
    expect(test.retireLegacyForward).not.toHaveBeenCalled();
    expect(test.startForward).not.toHaveBeenCalled();
  });

  it("preserves a foreign API when wildcard ownership cannot be proved", async () => {
    const test = wildcardApiFixture();
    vi.mocked(test.input.deps.adapter.observeForwards).mockImplementation(async ({ forwards }) =>
      forwards.map((target) => ({
        state: target.port === 8_642 ? ("foreign" as const) : ("owned" as const),
        forward: target,
      })),
    );
    await expect(recoverHermesPortableLaunchForwards(test.input)).rejects.toMatchObject({
      failure: "forward-occupied",
    });
    expect(test.retireLegacyForward).not.toHaveBeenCalled();
    expect(test.startForward).not.toHaveBeenCalled();
  });

  it("does not replace an API listener when retirement cannot prove release", async () => {
    const test = wildcardApiFixture();
    test.retireLegacyForward.mockResolvedValueOnce({
      state: "release_unproved",
      effect: "possible",
      forward: { ...forward(8_642), localHost: "0.0.0.0" },
      error: { kind: "cleanup", message: "NemoClaw could not prove OpenShell forward cleanup." },
    });
    await expect(recoverHermesPortableLaunchForwards(test.input)).rejects.toMatchObject({
      failure: "recovery-failed",
    });
    expect(test.startForward).not.toHaveBeenCalled();
  });

  it("refuses API migration when the registered identity changes before retirement", async () => {
    const test = wildcardApiFixture();
    test.retireLegacyForward.mockImplementationOnce(async (request) => {
      test.sandbox.hermesApiPort = 8_643;
      await request.authorize(request.forward);
      throw new Error("Retirement must stop at the authority fence");
    });
    await expect(recoverHermesPortableLaunchForwards(test.input)).rejects.toMatchObject({
      failure: "recovery-failed",
    });
    expect(test.startForward).not.toHaveBeenCalled();
    expect(test.states.get(8_642)).toBe("foreign");
  });

  it("preserves a wildcard API without a registered sandbox", async () => {
    const test = wildcardApiFixture();
    const input = { ...test.input, deps: { ...test.input.deps, readSandbox: () => null } };
    await expect(recoverHermesPortableLaunchForwards(input)).rejects.toMatchObject({
      failure: "forward-occupied",
    });
    expect(test.retireLegacyForward).not.toHaveBeenCalled();
    expect(test.startForward).not.toHaveBeenCalled();
  });

  it("stops migration when wildcard inspection exhausts the shared deadline", async () => {
    const test = wildcardApiFixture();
    let elapsed = 0;
    const observe = vi.mocked(test.input.deps.adapter.observeForwards).getMockImplementation()!;
    vi.mocked(test.input.deps.adapter.observeForwards).mockImplementation(async (request) => {
      const observations = await observe(request);
      elapsed = request.forwards.length === 1 ? 30_001 : 0;
      return observations;
    });
    const input = { ...test.input, deps: { ...test.input.deps, now: () => elapsed } };
    await expect(recoverHermesPortableLaunchForwards(input)).rejects.toMatchObject({
      failure: "recovery-failed",
    });
    expect(test.retireLegacyForward).not.toHaveBeenCalled();
    expect(test.startForward).not.toHaveBeenCalled();
  });

  it("keeps wildcard API verification read-only", async () => {
    const test = wildcardApiFixture();
    await expect(verifyHermesPortableLaunchForwards(test.input)).rejects.toMatchObject({
      failure: "forward-occupied",
    });
    expect(test.retireLegacyForward).not.toHaveBeenCalled();
    expect(test.startForward).not.toHaveBeenCalled();
  });

  it("starts only absent ports and can roll back its exact children", async () => {
    const test = fixture(new Map());

    const prepared = await prepareHermesPortableLaunchForwards(test.input);
    expect(prepared.result).toEqual({ kind: "restored", restoredPorts: [18_789, 8_642] });
    await prepared.rollback();
    expect(test.states.get(18_789)).toBe("absent");
    expect(test.states.get(8_642)).toBe("absent");
  });

  it("retires an exact stale legacy row before one direct start", async () => {
    const test = fixture(
      new Map([
        [18_789, "stale"],
        [8_642, "owned"],
      ]),
    );

    await expect(recoverHermesPortableLaunchForwards(test.input)).resolves.toEqual({
      kind: "restored",
      restoredPorts: [18_789],
    });
    expect(test.retireLegacyForward).toHaveBeenCalledOnce();
    expect(test.startForward).toHaveBeenCalledOnce();
  });

  it.each(["foreign", "indeterminate"] as const)(
    "does not mutate a %s observation",
    async (state) => {
      const test = fixture(
        new Map([
          [18_789, state],
          [8_642, "absent"],
        ]),
      );

      await expect(recoverHermesPortableLaunchForwards(test.input)).rejects.toBeInstanceOf(
        HermesPortableForwardRecoveryError,
      );
      expect(test.startForward).not.toHaveBeenCalled();
      expect(test.retireLegacyForward).not.toHaveBeenCalled();
    },
  );

  it("uses the same typed observations for verification", async () => {
    const healthy = fixture(
      new Map([
        [18_789, "owned"],
        [8_642, "owned"],
      ]),
    );
    const unhealthy = fixture(
      new Map([
        [18_789, "owned"],
        [8_642, "absent"],
      ]),
    );

    await expect(verifyHermesPortableLaunchForwards(healthy.input)).resolves.toEqual({
      kind: "healthy",
    });
    await expect(verifyHermesPortableLaunchForwards(unhealthy.input)).resolves.toEqual({
      kind: "unhealthy",
    });
  });

  it("preserves the initiating failure when rollback release is unproved", async () => {
    const test = fixture(new Map());
    test.startForward
      .mockImplementationOnce(async ({ forward: target }) => ({
        state: "started",
        forward: target,
        cleanup: async () => ({ state: "bound", forwards: [target] }),
      }))
      .mockImplementationOnce(async ({ forward: target }) => ({
        state: "failed",
        forward: target,
        effect: "none",
        error: {
          kind: "command",
          message: "The OpenShell forward command failed.",
        },
      }));

    await expect(prepareHermesPortableLaunchForwards(test.input)).rejects.toMatchObject({
      failure: "restoration-unproved",
      context: {
        cause: "forward-mutation-failed",
        operation: "start",
        port: 8_642,
      },
    });
  });

  it("preserves a safe forward startup failure classification", async () => {
    const test = fixture(new Map());
    test.startForward.mockImplementationOnce(async ({ forward: target }) => ({
      state: "failed",
      forward: target,
      effect: "none",
      error: {
        kind: "command",
        message: "The OpenShell forward command failed.",
      },
      failure: { stage: "startup", reason: "child_exited", exitStatus: 17 },
    }));

    await expect(prepareHermesPortableLaunchForwards(test.input)).rejects.toMatchObject({
      failure: "recovery-failed",
      context: {
        cause: "forward-mutation-failed",
        operation: "start",
        port: 18_789,
        startupFailure: { stage: "startup", reason: "child_exited", exitStatus: 17 },
      },
    });
  });

  it("preserves startup failure context when cleanup is unproved", async () => {
    const test = fixture(new Map());
    test.startForward.mockImplementationOnce(async ({ forward: target }) => ({
      state: "cleanup_uncertain",
      forward: target,
      effect: "possible",
      error: {
        kind: "cleanup",
        message: "NemoClaw could not prove OpenShell forward cleanup.",
      },
      failure: { stage: "startup", reason: "child_signaled", signal: "SIGTERM" },
    }));

    await expect(prepareHermesPortableLaunchForwards(test.input)).rejects.toMatchObject({
      failure: "restoration-unproved",
      context: {
        cause: "forward-mutation-failed",
        operation: "start",
        port: 18_789,
        startupFailure: { stage: "startup", reason: "child_signaled", signal: "SIGTERM" },
      },
    });
  });
});
