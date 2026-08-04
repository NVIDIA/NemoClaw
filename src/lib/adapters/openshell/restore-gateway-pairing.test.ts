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

    expect(verifyRestoredSandboxGatewayPairing("beta", SESSION_ID_PREFIX, deps)).toEqual({
      ok: true,
    });
    expect(deps.spawnSync).toHaveBeenCalledWith(
      "/usr/bin/openshell",
      expect.arrayContaining(["sandbox", "exec", "--name", "beta"]),
      expect.objectContaining({ timeout: 30_000 }),
    );
  });

  it("rejects an authenticated gateway verification run that exits unsuccessfully (#7431)", () => {
    expect(
      verifyRestoredSandboxGatewayPairing("beta", SESSION_ID_PREFIX, verifierDeps({ status: 1 })),
    ).toEqual({ ok: false, failureLayer: "command-failure" });
  });

  it.each([
    ["EMBEDDED FALLBACK: gateway unavailable", "embedded-fallback"],
    ['{"fallbackFrom":"gateway"}', "embedded-fallback"],
    ['{"transport":"embedded"}', "embedded-fallback"],
    ["gateway connect failed", "gateway-connect-failure"],
    ["gateway connect failed: device pairing required", "device-pairing-required"],
    ["scope upgrade pending approval", "scope-upgrade-pending"],
    [
      "gateway connect failed: pairing required: device is asking for more scopes",
      "scope-upgrade-pending",
    ],
  ] as const)("classifies a verification run with fallback or pairing output (#7431)", (output, failureLayer) => {
    expect(
      verifyRestoredSandboxGatewayPairing(
        "beta",
        SESSION_ID_PREFIX,
        verifierDeps({ status: 0, stdout: output }),
      ),
    ).toEqual({ ok: false, failureLayer });
  });

  it("accepts changed output when the gateway run exits successfully without a failure signal (#7431)", () => {
    expect(
      verifyRestoredSandboxGatewayPairing(
        "beta",
        SESSION_ID_PREFIX,
        verifierDeps({ status: 0, stdout: '{"futureResult":"ok"}' }),
      ),
    ).toEqual({ ok: true });
  });

  it("rejects an empty successful verification run (#7431)", () => {
    expect(
      verifyRestoredSandboxGatewayPairing(
        "beta",
        SESSION_ID_PREFIX,
        verifierDeps({ status: 0, stdout: "", stderr: "" }),
      ),
    ).toEqual({ ok: false, failureLayer: "empty-output" });
  });

  it("rejects a successful verification run with only a stderr warning (#7431)", () => {
    expect(
      verifyRestoredSandboxGatewayPairing(
        "beta",
        SESSION_ID_PREFIX,
        verifierDeps({ status: 0, stdout: "", stderr: "unrelated warning" }),
      ),
    ).toEqual({ ok: false, failureLayer: "empty-output" });
  });

  it("rejects an authenticated gateway verification run that times out (#7431)", () => {
    const error = new Error("timed out") as NodeJS.ErrnoException;
    error.code = "ETIMEDOUT";

    expect(
      verifyRestoredSandboxGatewayPairing(
        "beta",
        SESSION_ID_PREFIX,
        verifierDeps({ status: null, error, stdout: '{"result":"pong"}' }),
      ),
    ).toEqual({ ok: false, failureLayer: "execution-timeout" });
  });

  it("rejects verification when the OpenShell executable cannot be resolved (#7431)", () => {
    const spawn = vi.fn(() => ({ status: 0 }));

    expect(
      verifyRestoredSandboxGatewayPairing("beta", SESSION_ID_PREFIX, {
        resolveOpenshell: () => null,
        spawnSync: spawn,
      }),
    ).toEqual({ ok: false, failureLayer: "openshell-unavailable" });
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
    ).toEqual({ ok: false, failureLayer: "spawn-failure" });
  });

  it("rejects a returned process error before inspecting buffered output (#7431)", () => {
    const error = new Error("not found") as NodeJS.ErrnoException;
    error.code = "ENOENT";

    expect(
      verifyRestoredSandboxGatewayPairing(
        "beta",
        SESSION_ID_PREFIX,
        verifierDeps({
          status: 0,
          error,
          stdout: '{"result":"pong"}',
          stderr: "token=do-not-report",
        }),
      ),
    ).toEqual({ ok: false, failureLayer: "spawn-failure" });
  });

  it("does not expose verifier output in a classified failure (#7431)", () => {
    const secretOutput = "scope upgrade pending approval token=do-not-report";

    expect(
      verifyRestoredSandboxGatewayPairing(
        "beta",
        SESSION_ID_PREFIX,
        verifierDeps({ status: 0, stderr: secretOutput }),
      ),
    ).toEqual({ ok: false, failureLayer: "scope-upgrade-pending" });
  });
});
