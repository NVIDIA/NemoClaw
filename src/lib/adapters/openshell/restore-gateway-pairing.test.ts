// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type RestoreGatewayPairingVerifierDeps,
  verifyRestoredSandboxGatewayPairing,
} from "./restore-gateway-pairing";

const SESSION_ID_PREFIX = "nemoclaw-onboard-warmup-";

function verifierDeps(
  result: ReturnType<RestoreGatewayPairingVerifierDeps["spawnSync"]>,
): RestoreGatewayPairingVerifierDeps {
  return {
    resolveOpenshell: vi.fn(() => "/usr/bin/openshell"),
    spawnSync: vi.fn(() => result),
  };
}

describe("verifyRestoredSandboxGatewayPairing", () => {
  it("accepts an authenticated gateway verification run that exits successfully (#7431)", () => {
    const deps = verifierDeps({ status: 0, stdout: '{"result":"pong"}', stderr: "" });

    expect(verifyRestoredSandboxGatewayPairing("beta", SESSION_ID_PREFIX, deps)).toBe(true);
    expect(deps.spawnSync).toHaveBeenCalledWith(
      "/usr/bin/openshell",
      expect.arrayContaining(["sandbox", "exec", "--name", "beta"]),
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it("rejects an authenticated gateway verification run that exits unsuccessfully (#7431)", () => {
    expect(
      verifyRestoredSandboxGatewayPairing("beta", SESSION_ID_PREFIX, verifierDeps({ status: 1 })),
    ).toBe(false);
  });

  it.each([
    "EMBEDDED FALLBACK: gateway unavailable",
    '{"fallbackFrom":"gateway"}',
    '{"transport":"embedded"}',
    "gateway connect failed: device pairing required",
    "scope upgrade pending approval",
  ])("rejects a zero-exit verification run with fallback or pairing output (#7431)", (output) => {
    expect(
      verifyRestoredSandboxGatewayPairing(
        "beta",
        SESSION_ID_PREFIX,
        verifierDeps({ status: 0, stdout: output }),
      ),
    ).toBe(false);
  });

  it("accepts changed output when the gateway run exits successfully without a failure signal (#7431)", () => {
    expect(
      verifyRestoredSandboxGatewayPairing(
        "beta",
        SESSION_ID_PREFIX,
        verifierDeps({ status: 0, stdout: '{"futureResult":"ok"}' }),
      ),
    ).toBe(true);
  });

  it("rejects an authenticated gateway verification run that times out (#7431)", () => {
    const error = new Error("timed out") as NodeJS.ErrnoException;
    error.code = "ETIMEDOUT";

    expect(
      verifyRestoredSandboxGatewayPairing(
        "beta",
        SESSION_ID_PREFIX,
        verifierDeps({ status: null, error }),
      ),
    ).toBe(false);
  });

  it("rejects verification when the OpenShell executable cannot be resolved (#7431)", () => {
    const spawn = vi.fn(() => ({ status: 0 }));

    expect(
      verifyRestoredSandboxGatewayPairing("beta", SESSION_ID_PREFIX, {
        resolveOpenshell: () => null,
        spawnSync: spawn,
      }),
    ).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects verification when OpenShell cannot be started (#7431)", () => {
    expect(
      verifyRestoredSandboxGatewayPairing("beta", SESSION_ID_PREFIX, {
        resolveOpenshell: () => "/usr/bin/openshell",
        spawnSync: () => {
          throw new Error("spawn failed");
        },
      }),
    ).toBe(false);
  });
});
