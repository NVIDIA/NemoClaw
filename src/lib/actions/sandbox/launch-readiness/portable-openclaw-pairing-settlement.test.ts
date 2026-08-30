// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../../agent/defs";
import type { CheckpointPortableRuntimeAuthority } from "../../../state/onboard-checkpoint-types";
import type { SandboxEntry } from "../../../state/registry";
import {
  buildPortableOpenClawPairingApprovalScript,
  parsePortableOpenClawPairingApprovalReceipt,
  type PortableOpenClawPairingApprovalReceipt,
  readAutoPairApprovalPolicyModule,
  runPortableOpenClawPairingApproval,
  runPortableOpenClawPairingRequestProducer,
} from "../auto-pair-approval";
import { settlePortableOpenClawPairing } from "../launch-readiness";
import { buildTrustedProxyEnvSourceShell } from "../trusted-proxy-env";
import {
  OpenClawPairingObservationRetryableError,
  type OpenClawPairingRepairObservation,
  type OpenClawPairingSettlementObservation,
} from "./openclaw-pairing-qualification";

const AUTHORITY: CheckpointPortableRuntimeAuthority = {
  schemaVersion: 1,
  kind: "podman",
  ownership: "current-user",
  uid: 1001,
  homeDir: "/home/operator",
  configHome: "/home/operator/.config",
  runtimeDir: "/run/user/1001",
  socketPath: "/run/user/1001/podman/podman.sock",
};

const ENTRY = {
  name: "alpha",
  agent: "openclaw",
  agentVersion: "2026.7.1",
  lifecycleGeneration: "generation-1",
  lifecycleLiveIdentityFingerprint: "fingerprint-1",
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
} as SandboxEntry;

const AGENT = {
  name: "openclaw",
  expected_version: "2026.7.1",
  config: { dir: "/sandbox/.openclaw" },
  runtime: { interactive_command: "openclaw tui" },
} as unknown as AgentDefinition;

function currentReceipt() {
  return {
    kind: "current" as const,
    registryGeneration: "generation-1",
    runtimeAuthority: AUTHORITY,
  };
}

function settlementDeps(overrides: Parameters<typeof settlePortableOpenClawPairing>[2] = {}) {
  const calls: string[] = [];
  const observePairing = vi.fn((): OpenClawPairingRepairObservation => ({
    state: "settled" as const,
    deviceIdentitySha256: "a".repeat(64),
  }));
  const observeFinalPairing = vi.fn((): OpenClawPairingSettlementObservation => ({
    state: "settled" as const,
    deviceIdentitySha256: "a".repeat(64),
  }));
  const runProducer = vi.fn();
  const runApproval = vi.fn((): PortableOpenClawPairingApprovalReceipt => "approved");
  let now = 0;
  const sleep = vi.fn(async (milliseconds: number) => {
    now += milliseconds;
  });
  return {
    calls,
    observePairing,
    observeFinalPairing,
    runProducer,
    runApproval,
    sleep,
    deps: {
      classifyPortableLifecycleReceipt: vi.fn(() => currentReceipt()),
      getSandbox: vi.fn(() => ENTRY),
      listAgents: vi.fn(() => ["openclaw"]),
      loadAgent: vi.fn(() => AGENT),
      observeOpenClawPairingRepairSettlement: observePairing,
      observeOpenClawPairingSettlement: observeFinalPairing,
      runPortablePairingProducer: runProducer,
      runPortablePairingApproval: runApproval,
      now: () => now,
      sleep,
      withSandboxLock: vi.fn(async (_name, operation) => {
        calls.push("sandbox-lock");
        return operation();
      }),
      withGatewayLock: vi.fn(async (_name, operation) => {
        calls.push("gateway-lock");
        return operation();
      }),
      ...overrides,
    },
  };
}

function expectApprovalScriptRejectsRequests(
  rejectedRequests: readonly unknown[],
  root: string,
  approvalLog: string,
  script: string,
): void {
  for (const rejected of rejectedRequests) {
    fs.rmSync(approvalLog, { force: true });
    const rejectedResult = spawnSync("sh", ["-s"], {
      encoding: "utf8",
      input: script,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        APPROVAL_LOG: approvalLog,
        PENDING_JSON: JSON.stringify(rejected),
      },
    });
    expect(rejectedResult.status).toBe(0);
    expect(parsePortableOpenClawPairingApprovalReceipt(rejectedResult.stdout)).toBe("rejected");
    expect(fs.existsSync(approvalLog)).toBe(false);
  }
}

function createPortableApprovalFixture(temporaryDirectories: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-pairing-"));
  temporaryDirectories.push(root);
  const approvalLog = path.join(root, "approvals.log");
  const publicKey = Buffer.alloc(32, 9).toString("base64url");
  const deviceId = createHash("sha256").update(Buffer.alloc(32, 9)).digest("hex");
  const identityDigest = createHash("sha256")
    .update(JSON.stringify({ deviceId, publicKey }))
    .digest("hex");
  fs.writeFileSync(
    path.join(root, "openclaw"),
    `#!${process.execPath}\nconst fs=require("fs");\nconst args=process.argv.slice(2);\nif(args[1]==="list"){process.stdout.write(JSON.stringify({pending:JSON.parse(process.env.PENDING_JSON || "[]")})+"\\n");process.exit(0);}\nif(args[1]==="approve"){fs.appendFileSync(process.env.APPROVAL_LOG,args[2]+"\\n");process.stdout.write("{}\\n");process.exit(0);}\nprocess.exit(2);\n`,
    { mode: 0o755 },
  );
  return {
    root,
    approvalLog,
    identityDigest,
    request: {
      requestId: "request-1",
      deviceId,
      publicKey,
      clientId: "cli",
      clientMode: "cli",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.pairing", "operator.write"],
      isRepair: true,
    },
  };
}

describe("Portable OpenClaw pairing settlement", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("leaves an absent receipt on the ordinary path and fails closed when Portable was selected (#9207)", async () => {
    const scope = settlementDeps({
      classifyPortableLifecycleReceipt: vi.fn(() => ({ kind: "absent" as const })),
    });

    await expect(settlePortableOpenClawPairing("alpha", {}, scope.deps)).resolves.toEqual({
      kind: "not-portable",
    });
    await expect(
      settlePortableOpenClawPairing("alpha", { portableRequired: true }, scope.deps),
    ).resolves.toEqual({ kind: "incomplete", reason: "portable-receipt-missing" });
    expect(scope.observePairing).not.toHaveBeenCalled();
    expect(scope.runProducer).not.toHaveBeenCalled();
    expect(scope.runApproval).not.toHaveBeenCalled();
  });

  it("leaves a current Portable receipt on the ordinary non-OpenClaw path (#9207)", async () => {
    const scope = settlementDeps({
      getSandbox: vi.fn(() => ({ ...ENTRY, agent: "hermes" })),
    });

    await expect(settlePortableOpenClawPairing("alpha", {}, scope.deps)).resolves.toEqual({
      kind: "not-portable",
    });
    expect(scope.calls).toEqual(["sandbox-lock"]);
    expect(scope.observePairing).not.toHaveBeenCalled();
    expect(scope.runProducer).not.toHaveBeenCalled();
    expect(scope.runApproval).not.toHaveBeenCalled();
  });

  it("makes the Portable discriminator decision only inside the lifecycle lock (#9207)", async () => {
    let lockHeld = false;
    const scope = settlementDeps({
      classifyPortableLifecycleReceipt: vi.fn(() => {
        expect(lockHeld).toBe(true);
        return currentReceipt();
      }),
      withSandboxLock: vi.fn(async (_name, operation) => {
        lockHeld = true;
        try {
          return await operation();
        } finally {
          lockHeld = false;
        }
      }),
    });

    await expect(settlePortableOpenClawPairing("alpha", {}, scope.deps)).resolves.toEqual({
      kind: "settled",
    });
    expect(scope.observePairing).toHaveBeenCalledOnce();
  });

  it("fails closed when a Portable receipt has no explicit registry agent (#9207)", async () => {
    const scope = settlementDeps({
      getSandbox: vi.fn(() => ({ ...ENTRY, agent: undefined })),
    });

    await expect(settlePortableOpenClawPairing("alpha", {}, scope.deps)).resolves.toEqual({
      kind: "incomplete",
      reason: "portable-runtime-identity-invalid",
    });
    expect(scope.observePairing).not.toHaveBeenCalled();
    expect(scope.runProducer).not.toHaveBeenCalled();
    expect(scope.runApproval).not.toHaveBeenCalled();
  });

  it("repairs an authority-matched legacy OpenClaw row only for onboarding finalization (#9207)", async () => {
    let entry: SandboxEntry = { ...ENTRY, agent: null };
    const updateSandbox = vi.fn((_name: string, updates: Partial<SandboxEntry>) => {
      entry = { ...entry, ...updates };
      return true;
    });
    const scope = settlementDeps({
      getSandbox: vi.fn(() => entry),
      updateSandbox,
    });

    await expect(
      settlePortableOpenClawPairing("alpha", { portableRequired: true }, scope.deps),
    ).resolves.toEqual({ kind: "settled" });
    expect(updateSandbox).toHaveBeenCalledExactlyOnceWith("alpha", { agent: "openclaw" });
    expect(scope.observePairing).toHaveBeenCalledOnce();
    expect(scope.runProducer).not.toHaveBeenCalled();
    expect(scope.runApproval).not.toHaveBeenCalled();
  });

  it("does not repair a legacy registry row when authority changes while acquiring the lifecycle lock (#9833)", async () => {
    let revalidateSandboxIdentity = () => undefined;
    const updateSandbox = vi.fn(() => true);
    const scope = settlementDeps({
      getSandbox: vi.fn(() => ({ ...ENTRY, agent: null })),
      updateSandbox,
      withSandboxLock: vi.fn(async (_name, operation) => {
        revalidateSandboxIdentity = () => {
          throw new Error("sandbox identity changed");
        };
        return operation();
      }),
    });

    await expect(
      settlePortableOpenClawPairing(
        "alpha",
        {
          portableRequired: true,
          revalidateSandboxIdentity: () => revalidateSandboxIdentity(),
        },
        scope.deps,
      ),
    ).rejects.toThrow("sandbox identity changed");

    expect(updateSandbox).not.toHaveBeenCalled();
    expect(scope.observePairing).not.toHaveBeenCalled();
    expect(scope.runProducer).not.toHaveBeenCalled();
    expect(scope.runApproval).not.toHaveBeenCalled();
  });

  it.each<[string, boolean]>([
    ["registry update fails", false],
    ["registry readback remains unchanged", true],
  ])("fails closed when legacy OpenClaw repair %s (#9207)", async (_label, updateResult) => {
    const updateSandbox = vi.fn(() => updateResult);
    const scope = settlementDeps({
      getSandbox: vi.fn(() => ({ ...ENTRY, agent: null })),
      updateSandbox,
    });

    await expect(
      settlePortableOpenClawPairing("alpha", { portableRequired: true }, scope.deps),
    ).resolves.toEqual({
      kind: "incomplete",
      reason: "portable-runtime-identity-invalid",
    });
    expect(updateSandbox).toHaveBeenCalledExactlyOnceWith("alpha", { agent: "openclaw" });
    expect(scope.calls).toEqual(["sandbox-lock"]);
    expect(scope.observePairing).not.toHaveBeenCalled();
    expect(scope.runProducer).not.toHaveBeenCalled();
    expect(scope.runApproval).not.toHaveBeenCalled();
  });

  it("does not repair a legacy OpenClaw row without exact receipt and sandbox identity (#9207)", async () => {
    const updateSandbox = vi.fn(() => true);
    const scope = settlementDeps({
      getSandbox: vi.fn(() => ({
        ...ENTRY,
        agent: null,
        lifecycleGeneration: "generation-2",
      })),
      updateSandbox,
    });

    await expect(
      settlePortableOpenClawPairing("alpha", { portableRequired: true }, scope.deps),
    ).resolves.toEqual({
      kind: "incomplete",
      reason: "portable-runtime-identity-invalid",
    });
    expect(updateSandbox).not.toHaveBeenCalled();
    expect(scope.observePairing).not.toHaveBeenCalled();
    expect(scope.runProducer).not.toHaveBeenCalled();
    expect(scope.runApproval).not.toHaveBeenCalled();
  });

  it("never rewrites Portable Hermes when OpenClaw finalization is requested (#9207)", async () => {
    const updateSandbox = vi.fn(() => true);
    const scope = settlementDeps({
      getSandbox: vi.fn(() => ({ ...ENTRY, agent: "hermes" })),
      updateSandbox,
    });

    await expect(
      settlePortableOpenClawPairing("alpha", { portableRequired: true }, scope.deps),
    ).resolves.toEqual({ kind: "not-portable" });
    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it("rejects a receipt from another registry generation before observing or writing (#9207)", async () => {
    const scope = settlementDeps({
      getSandbox: vi.fn(() => ({ ...ENTRY, lifecycleGeneration: "generation-2" })),
    });

    await expect(settlePortableOpenClawPairing("alpha", {}, scope.deps)).resolves.toEqual({
      kind: "incomplete",
      reason: "portable-runtime-identity-invalid",
    });
    expect(scope.observePairing).not.toHaveBeenCalled();
    expect(scope.runProducer).not.toHaveBeenCalled();
    expect(scope.runApproval).not.toHaveBeenCalled();
  });

  it("accepts settled state without a producer or approval write (#9207)", async () => {
    const scope = settlementDeps();

    await expect(settlePortableOpenClawPairing("alpha", {}, scope.deps)).resolves.toEqual({
      kind: "settled",
    });
    expect(scope.calls).toEqual(["sandbox-lock", "gateway-lock"]);
    expect(scope.observePairing).toHaveBeenCalledOnce();
    expect(scope.runProducer).not.toHaveBeenCalled();
    expect(scope.runApproval).not.toHaveBeenCalled();
  });

  it("repairs pairing-only state with one producer, one approval, and one final observation (#9207)", async () => {
    const scope = settlementDeps();
    scope.observePairing
      .mockReturnValueOnce({
        state: "pairing-only",
        deviceIdentitySha256: "b".repeat(64),
      })
      .mockReturnValueOnce({
        state: "settled",
        deviceIdentitySha256: "b".repeat(64),
      });
    scope.observeFinalPairing.mockReturnValueOnce({
      state: "settled",
      deviceIdentitySha256: "b".repeat(64),
    });

    await expect(settlePortableOpenClawPairing("alpha", {}, scope.deps)).resolves.toEqual({
      kind: "settled",
    });
    expect(scope.runProducer).toHaveBeenCalledOnce();
    expect(scope.runApproval).toHaveBeenCalledExactlyOnceWith("alpha", "nemoclaw", "b".repeat(64));
    expect(scope.observePairing).toHaveBeenCalledTimes(2);
    expect(scope.observeFinalPairing).toHaveBeenCalledOnce();
  });

  it("waits for the canonical Portable device to appear before producing one repair (#9817)", async () => {
    const scope = settlementDeps();
    scope.observePairing
      .mockImplementationOnce(() => {
        throw new OpenClawPairingObservationRetryableError();
      })
      .mockReturnValueOnce({
        state: "pairing-only",
        deviceIdentitySha256: "b".repeat(64),
      })
      .mockReturnValue({
        state: "settled",
        deviceIdentitySha256: "b".repeat(64),
      });
    scope.observeFinalPairing.mockReturnValueOnce({
      state: "settled",
      deviceIdentitySha256: "b".repeat(64),
    });

    await expect(settlePortableOpenClawPairing("alpha", {}, scope.deps)).resolves.toEqual({
      kind: "settled",
    });
    expect(scope.observePairing).toHaveBeenCalledTimes(3);
    expect(scope.sleep).toHaveBeenCalledOnce();
    expect(scope.runProducer).toHaveBeenCalledOnce();
    expect(scope.runApproval).toHaveBeenCalledOnce();
  });

  it("waits for the approved Portable scopes to persist before strict settlement (#9817)", async () => {
    const scope = settlementDeps();
    scope.observePairing
      .mockReturnValueOnce({
        state: "pairing-pending",
        deviceIdentitySha256: "b".repeat(64),
      })
      .mockReturnValue({
        state: "settled",
        deviceIdentitySha256: "b".repeat(64),
      });
    scope.observeFinalPairing
      .mockReturnValueOnce({
        state: "pairing-only",
        deviceIdentitySha256: "b".repeat(64),
      })
      .mockReturnValueOnce({
        state: "settled",
        deviceIdentitySha256: "b".repeat(64),
      });

    await expect(settlePortableOpenClawPairing("alpha", {}, scope.deps)).resolves.toEqual({
      kind: "settled",
    });
    expect(scope.runProducer).not.toHaveBeenCalled();
    expect(scope.runApproval).toHaveBeenCalledOnce();
    expect(scope.observePairing).toHaveBeenCalledTimes(3);
    expect(scope.observeFinalPairing).toHaveBeenCalledTimes(2);
    expect(scope.sleep).toHaveBeenCalledOnce();
  });

  it("approves one canonical pending transition without producing a second request (#9817)", async () => {
    const scope = settlementDeps();
    scope.observePairing
      .mockReturnValueOnce({
        state: "pairing-pending",
        deviceIdentitySha256: "b".repeat(64),
      })
      .mockReturnValueOnce({
        state: "settled",
        deviceIdentitySha256: "b".repeat(64),
      });
    scope.observeFinalPairing.mockReturnValueOnce({
      state: "settled",
      deviceIdentitySha256: "b".repeat(64),
    });

    await expect(settlePortableOpenClawPairing("alpha", {}, scope.deps)).resolves.toEqual({
      kind: "settled",
    });
    expect(scope.runProducer).not.toHaveBeenCalled();
    expect(scope.runApproval).toHaveBeenCalledExactlyOnceWith("alpha", "nemoclaw", "b".repeat(64));
    expect(scope.observePairing).toHaveBeenCalledTimes(2);
    expect(scope.observeFinalPairing).toHaveBeenCalledOnce();
  });

  it("settles a write-only pending repair through the production approval wrapper (#9817)", async () => {
    const fixture = createPortableApprovalFixture(temporaryDirectories);
    const writeOnlyRequest = { ...fixture.request, scopes: ["operator.write"] };
    const runApproval = vi.fn(
      (sandboxName: string, gatewayName: string, expectedDeviceIdentitySha256: string) =>
        runPortableOpenClawPairingApproval(sandboxName, gatewayName, expectedDeviceIdentitySha256, {
          getOpenshellBinary: () => "openshell",
          spawnSync: ((_command: string, _args: readonly string[], options: { input?: unknown }) =>
            spawnSync("sh", ["-s"], {
              encoding: "utf8",
              input: String(options.input ?? ""),
              env: {
                ...process.env,
                PATH: `${fixture.root}:${process.env.PATH}`,
                APPROVAL_LOG: fixture.approvalLog,
                PENDING_JSON: JSON.stringify([writeOnlyRequest]),
              },
            })) as never,
        }),
    );
    const scope = settlementDeps({ runPortablePairingApproval: runApproval });
    scope.observePairing
      .mockReturnValueOnce({
        state: "pairing-pending",
        deviceIdentitySha256: fixture.identityDigest,
      })
      .mockReturnValueOnce({
        state: "settled",
        deviceIdentitySha256: fixture.identityDigest,
      });
    scope.observeFinalPairing.mockReturnValueOnce({
      state: "settled",
      deviceIdentitySha256: fixture.identityDigest,
    });

    await expect(settlePortableOpenClawPairing("alpha", {}, scope.deps)).resolves.toEqual({
      kind: "settled",
    });
    expect(scope.runProducer).not.toHaveBeenCalled();
    expect(runApproval).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      "nemoclaw",
      fixture.identityDigest,
    );
    expect(fs.readFileSync(fixture.approvalLog, "utf8")).toBe("request-1\n");
  });

  it("performs no pairing writes when repair observation rejects pending state (#9817)", async () => {
    const scope = settlementDeps();
    scope.observePairing.mockImplementationOnce(() => {
      throw new Error("pending state is not canonical");
    });

    await expect(settlePortableOpenClawPairing("alpha", {}, scope.deps)).resolves.toEqual({
      kind: "incomplete",
      reason: "portable-pairing-incomplete",
    });
    expect(scope.runProducer).not.toHaveBeenCalled();
    expect(scope.runApproval).not.toHaveBeenCalled();
    expect(scope.observeFinalPairing).not.toHaveBeenCalled();
  });

  it("rejects a settled replacement identity after canonical approval (#9817)", async () => {
    const scope = settlementDeps();
    scope.observePairing
      .mockReturnValueOnce({
        state: "pairing-pending",
        deviceIdentitySha256: "b".repeat(64),
      })
      .mockReturnValueOnce({
        state: "settled",
        deviceIdentitySha256: "b".repeat(64),
      });
    scope.observeFinalPairing.mockReturnValueOnce({
      state: "settled",
      deviceIdentitySha256: "d".repeat(64),
    });

    await expect(settlePortableOpenClawPairing("alpha", {}, scope.deps)).resolves.toEqual({
      kind: "incomplete",
      reason: "portable-pairing-incomplete",
    });
    expect(scope.runProducer).not.toHaveBeenCalled();
    expect(scope.runApproval).toHaveBeenCalledOnce();
    expect(scope.observeFinalPairing).toHaveBeenCalledOnce();
  });

  it("does not produce or approve a request when authority changes during initial observation (#9833)", async () => {
    let revalidateSandboxIdentity = () => undefined;
    const scope = settlementDeps();
    scope.observePairing.mockImplementationOnce(() => {
      revalidateSandboxIdentity = () => {
        throw new Error("sandbox identity changed");
      };
      return {
        state: "pairing-only",
        deviceIdentitySha256: "b".repeat(64),
      };
    });

    await expect(
      settlePortableOpenClawPairing(
        "alpha",
        {
          revalidateSandboxIdentity: () => revalidateSandboxIdentity(),
        },
        scope.deps,
      ),
    ).rejects.toThrow("sandbox identity changed");

    expect(scope.runProducer).not.toHaveBeenCalled();
    expect(scope.runApproval).not.toHaveBeenCalled();
    expect(scope.observePairing).toHaveBeenCalledOnce();
  });

  it("does not approve a request when authority changes during request production (#9833)", async () => {
    let revalidateSandboxIdentity = () => undefined;
    const scope = settlementDeps({
      runPortablePairingProducer: vi.fn(() => {
        revalidateSandboxIdentity = () => {
          throw new Error("sandbox identity changed");
        };
      }),
    });
    scope.observePairing.mockReturnValueOnce({
      state: "pairing-only",
      deviceIdentitySha256: "b".repeat(64),
    });

    await expect(
      settlePortableOpenClawPairing(
        "alpha",
        {
          revalidateSandboxIdentity: () => revalidateSandboxIdentity(),
        },
        scope.deps,
      ),
    ).rejects.toThrow("sandbox identity changed");

    expect(scope.deps.runPortablePairingProducer).toHaveBeenCalledOnce();
    expect(scope.runApproval).not.toHaveBeenCalled();
    expect(scope.observePairing).toHaveBeenCalledOnce();
  });

  it("does not publish settled pairing when authority changes during initial observation (#9833)", async () => {
    let revalidateSandboxIdentity = () => undefined;
    const scope = settlementDeps();
    scope.observePairing.mockImplementationOnce(() => {
      revalidateSandboxIdentity = () => {
        throw new Error("sandbox identity changed");
      };
      return {
        state: "settled",
        deviceIdentitySha256: "b".repeat(64),
      };
    });

    await expect(
      settlePortableOpenClawPairing(
        "alpha",
        {
          revalidateSandboxIdentity: () => revalidateSandboxIdentity(),
        },
        scope.deps,
      ),
    ).rejects.toThrow("sandbox identity changed");

    expect(scope.runProducer).not.toHaveBeenCalled();
    expect(scope.runApproval).not.toHaveBeenCalled();
    expect(scope.observePairing).toHaveBeenCalledOnce();
  });

  it("does not publish settled pairing when authority changes during final observation (#9833)", async () => {
    let revalidateSandboxIdentity = () => undefined;
    const scope = settlementDeps();
    scope.observeFinalPairing.mockReturnValueOnce({
      state: "settled",
      deviceIdentitySha256: "b".repeat(64),
    });
    scope.observePairing
      .mockReturnValueOnce({
        state: "pairing-only",
        deviceIdentitySha256: "b".repeat(64),
      })
      .mockImplementationOnce(() => {
        revalidateSandboxIdentity = () => {
          throw new Error("sandbox identity changed");
        };
        return {
          state: "settled",
          deviceIdentitySha256: "b".repeat(64),
        };
      });

    await expect(
      settlePortableOpenClawPairing(
        "alpha",
        {
          revalidateSandboxIdentity: () => revalidateSandboxIdentity(),
        },
        scope.deps,
      ),
    ).rejects.toThrow("sandbox identity changed");

    expect(scope.runProducer).toHaveBeenCalledOnce();
    expect(scope.runApproval).toHaveBeenCalledOnce();
    expect(scope.observePairing).toHaveBeenCalledTimes(2);
  });

  it.each(["ambiguous", "no-request", "rejected", "unavailable"] as const)(
    "does not retry a %s approval and reports incomplete after one re-observation (#9207)",
    async (receipt) => {
      const scope = settlementDeps();
      scope.observePairing
        .mockReturnValueOnce({
          state: "pairing-only",
          deviceIdentitySha256: "c".repeat(64),
        })
        .mockReturnValue({
          state: "settled",
          deviceIdentitySha256: "c".repeat(64),
        });
      scope.observeFinalPairing.mockReturnValue({
        state: "pairing-only",
        deviceIdentitySha256: "c".repeat(64),
      });
      scope.runApproval.mockReturnValue(receipt);

      await expect(settlePortableOpenClawPairing("alpha", {}, scope.deps)).resolves.toEqual({
        kind: "incomplete",
        reason: "portable-pairing-incomplete",
      });
      expect(scope.runApproval).toHaveBeenCalledOnce();
      expect(scope.observePairing).toHaveBeenCalledTimes(31);
      expect(scope.observeFinalPairing).toHaveBeenCalledTimes(30);
    },
  );

  it("rejects a changed receipt after taking the gateway lock without observing or writing (#9207)", async () => {
    const classifyReceipt = vi
      .fn()
      .mockReturnValueOnce(currentReceipt())
      .mockReturnValueOnce({
        kind: "current",
        registryGeneration: "generation-1",
        runtimeAuthority: { ...AUTHORITY, socketPath: "/run/user/1001/podman/changed.sock" },
      });
    const scope = settlementDeps({ classifyPortableLifecycleReceipt: classifyReceipt });

    await expect(settlePortableOpenClawPairing("alpha", {}, scope.deps)).resolves.toEqual({
      kind: "incomplete",
      reason: "portable-receipt-invalid",
    });
    expect(scope.observePairing).not.toHaveBeenCalled();
    expect(scope.runProducer).not.toHaveBeenCalled();
    expect(scope.runApproval).not.toHaveBeenCalled();
  });

  it("approves only the exact bounded request and emits only a fixed receipt (#9207)", () => {
    const approvalPolicy = readAutoPairApprovalPolicyModule();
    expect(approvalPolicy).toBeTruthy();
    const { root, approvalLog, identityDigest, request } =
      createPortableApprovalFixture(temporaryDirectories);
    const { role: _role, roles: _roles, ...requestWithoutRoleFields } = request;
    const { isRepair: _isRepair, ...requestWithoutRepair } = request;
    const script = buildPortableOpenClawPairingApprovalScript(
      Buffer.from(approvalPolicy as string, "utf8").toString("base64"),
      identityDigest,
    );

    const result = spawnSync("sh", ["-s"], {
      encoding: "utf8",
      input: script,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        APPROVAL_LOG: approvalLog,
        PENDING_JSON: JSON.stringify([request]),
      },
    });

    expect(result.status).toBe(0);
    expect(parsePortableOpenClawPairingApprovalReceipt(result.stdout)).toBe("approved");
    expect(result.stdout).not.toContain("request-1");
    expect(fs.readFileSync(approvalLog, "utf8")).toBe("request-1\n");
    expect(script.match(/\[OPENCLAW, 'devices', 'approve'/gu)).toHaveLength(1);
    expect(script).toContain(buildTrustedProxyEnvSourceShell());
    expect(script).not.toContain('[ -r "$PROXY_ENV" ] && . "$PROXY_ENV"');

    expectApprovalScriptRejectsRequests(
      [
        [{ ...request, scopes: ["operator.pairing"] }],
        [{ ...request, scopes: [...request.scopes, "operator.admin"] }],
        [{ ...request, scopes: [...request.scopes, "operator.write"] }],
        [{ ...request, requestedScopes: request.scopes }],
        [{ ...request, clientId: "unknown-client" }],
        [{ ...request, clientMode: "webchat" }],
        [{ ...request, roles: ["operator", "operator"] }],
        [{ ...request, role: "admin" }],
        [{ ...requestWithoutRoleFields, roles: ["operator"] }],
        [{ ...requestWithoutRoleFields, role: "operator" }],
        [{ ...request, deviceId: "different-device" }],
        [{ ...request, publicKey: "different-public-key" }],
        [{ ...request, publicKeyPem: "conflicting-public-key" }],
        [{ ...request, publicKeyPem: null }],
        [{ ...request, isRepair: false }],
        [requestWithoutRepair],
        [{ ...request, isRepair: "true" }],
        [{ ...request }, { ...request, requestId: "request-2" }],
      ],
      root,
      approvalLog,
      script,
    );
  });

  it("pins the canonical request producer to the owning gateway and discards output (#9207)", () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: "secret", stderr: "secret" }));

    runPortableOpenClawPairingRequestProducer("alpha", "nemoclaw-19000", {
      getOpenshellBinary: () => "openshell",
      spawnSync: spawn as never,
    });

    const call = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(call[1]).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "-g",
      "nemoclaw-19000",
      "--",
      "sh",
      "-s",
    ]);
    expect(call[2]).toMatchObject({ stdio: ["pipe", "ignore", "ignore"] });
    expect(call[2].input).toEqual(expect.stringContaining(buildTrustedProxyEnvSourceShell()));
    expect(call[2].input).not.toEqual(
      expect.stringContaining('[ -r "$PROXY_ENV" ] && . "$PROXY_ENV"'),
    );
  });
});
