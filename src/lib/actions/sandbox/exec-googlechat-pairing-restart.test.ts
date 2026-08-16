// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  execSandbox,
  isGoogleChatPairingApproval,
  type ExecSandboxDeps,
  type SandboxExecCleanupDeps,
} from "./exec";

const CLEANUP_SKIPPED: SandboxExecCleanupDeps = {
  getSandbox: () => null,
  inspectMutableConfigPerms: () => {
    throw new Error("cleanup should be skipped for an unregistered sandbox");
  },
  repairMutableConfigPerms: () => {
    throw new Error("cleanup should be skipped for an unregistered sandbox");
  },
};

function depsFor(status: number, restartGateway = vi.fn(() => ({ ok: true }))): ExecSandboxDeps {
  return {
    resolveBinary: () => "openshell",
    selectGateway: () => ({ outcome: "unregistered", gatewayName: null }),
    run: () => ({ status }),
    cleanupDeps: CLEANUP_SKIPPED,
    restartGateway,
    policyHint: {
      now: () => 1_000,
      probeLogs: () => "",
      enableAudit: () => {},
      sleep: async () => {},
      attempts: 1,
      writeStderr: () => {},
    },
  };
}

async function runAndCaptureExit(
  command: readonly string[],
  deps: ExecSandboxDeps,
): Promise<number> {
  let exitCode = Number.NaN;
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__exec_exit__");
  }) as never);

  await execSandbox("alpha", command, {}, deps).catch((error: unknown) => {
    expect(error).toEqual(new Error("__exec_exit__"));
  });
  return exitCode;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Google Chat pairing approval gateway activation (#8553)", () => {
  it("recognizes only a direct Google Chat pairing approval with a code", () => {
    expect(
      isGoogleChatPairingApproval(["openclaw", "pairing", "approve", "googlechat", "ABCD1234"]),
    ).toBe(true);
    expect(
      isGoogleChatPairingApproval([
        "openclaw",
        "pairing",
        "approve",
        "googlechat",
        "ABCD1234",
        "--json",
      ]),
    ).toBe(true);
    expect(
      isGoogleChatPairingApproval(["openclaw", "pairing", "approve", "telegram", "ABCD1234"]),
    ).toBe(false);
    expect(
      isGoogleChatPairingApproval(["sh", "-lc", "openclaw pairing approve googlechat ABCD1234"]),
    ).toBe(false);
    expect(
      isGoogleChatPairingApproval(["openclaw", "pairing", "approve", "googlechat", "--help"]),
    ).toBe(false);
  });

  it("restarts the managed gateway after the exact approval succeeds", async () => {
    const restartGateway = vi.fn(() => ({ ok: true }));
    const exitCode = await runAndCaptureExit(
      ["openclaw", "pairing", "approve", "googlechat", "ABCD1234"],
      depsFor(0, restartGateway),
    );

    expect(restartGateway).toHaveBeenCalledOnce();
    expect(restartGateway).toHaveBeenCalledWith("alpha");
    expect(exitCode).toBe(0);
  });

  it("restarts only after the mutable OpenClaw config contract is verified", async () => {
    const order: string[] = [];
    const restartGateway = vi.fn(() => {
      order.push("restart");
      return { ok: true };
    });
    const deps = depsFor(0, restartGateway);
    deps.run = () => {
      order.push("command");
      return { status: 0 };
    };
    deps.cleanupDeps = {
      getSandbox: () => ({ agent: "openclaw" }),
      inspectMutableConfigPerms: () => {
        order.push("cleanup");
        return {
          applies: true,
          ok: true,
          dirMode: "2770",
          dirOwner: "sandbox:sandbox",
          fileMode: "660",
          fileOwner: "sandbox:sandbox",
          configDir: "/sandbox/.openclaw",
          configFile: "openclaw.json",
          issues: [],
        };
      },
      repairMutableConfigPerms: () => {
        throw new Error("healthy config should not need repair");
      },
    };

    const exitCode = await runAndCaptureExit(
      ["openclaw", "pairing", "approve", "googlechat", "ABCD1234"],
      deps,
    );

    expect(order).toEqual(["command", "cleanup", "restart"]);
    expect(exitCode).toBe(0);
  });

  it("does not restart when post-command config cleanup fails", async () => {
    const restartGateway = vi.fn(() => ({ ok: true }));
    const deps = depsFor(0, restartGateway);
    deps.cleanupDeps = {
      getSandbox: () => {
        throw new Error("invalid registry JSON");
      },
      inspectMutableConfigPerms: CLEANUP_SKIPPED.inspectMutableConfigPerms,
      repairMutableConfigPerms: CLEANUP_SKIPPED.repairMutableConfigPerms,
    };

    const exitCode = await runAndCaptureExit(
      ["openclaw", "pairing", "approve", "googlechat", "ABCD1234"],
      deps,
    );

    expect(restartGateway).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
  });

  it("fails the public command when activation restart fails", async () => {
    const restartGateway = vi.fn(() => ({ ok: false }));
    const exitCode = await runAndCaptureExit(
      ["openclaw", "pairing", "approve", "googlechat", "ABCD1234"],
      depsFor(0, restartGateway),
    );

    expect(restartGateway).toHaveBeenCalledOnce();
    expect(exitCode).toBe(1);
  });

  it("does not restart after a failed approval", async () => {
    const restartGateway = vi.fn(() => ({ ok: true }));
    const exitCode = await runAndCaptureExit(
      ["openclaw", "pairing", "approve", "googlechat", "BADCODE"],
      depsFor(17, restartGateway),
    );

    expect(restartGateway).not.toHaveBeenCalled();
    expect(exitCode).toBe(17);
  });

  it("leaves unrelated successful exec commands unchanged", async () => {
    const restartGateway = vi.fn(() => ({ ok: true }));
    const exitCode = await runAndCaptureExit(
      ["openclaw", "pairing", "approve", "telegram", "ABCD1234"],
      depsFor(0, restartGateway),
    );

    expect(restartGateway).not.toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });
});
