// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

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

describe("Hermes Portable typed forward recovery", () => {
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
