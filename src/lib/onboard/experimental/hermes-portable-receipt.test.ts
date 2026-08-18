// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import type { PodmanSocketAuthority } from "../../adapters/podman";
import {
  HERMES_PORTABLE_RECEIPT_SCHEMA_VERSION,
  captureHermesPortablePolicySource,
  hermesPortablePolicySourcePath,
  hermesPortableReceiptDirectory,
  hermesPortableReceiptInternals,
  inspectPortableAgentReceiptAuthority,
  publishHermesPortableDurablePolicySource,
  publishHermesPortableLifecycleReceipt,
  readHermesPortableLifecycleReceipt,
  type HermesPortableConfiguredReceipt,
  type HermesPortablePendingReceipt,
  type HermesPortablePolicyAuthority,
  type HermesPortableStartupContract,
} from "./hermes-portable-receipt";
import { portableDemoReceiptPath } from "./portable-runtime-receipt-readiness";

const SANDBOX = "alpha";
const GATEWAY = "nemoclaw";
const GENERATION = "generation-1";
const CONTAINER_ID = "a".repeat(64);
const SANDBOX_ID = "sandbox-id-1";
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const SHA = "c".repeat(64);

let stateDir: string;
let homeDir: string;
let policyPath: string;

function uid(): number {
  return typeof process.getuid === "function"
    ? process.getuid()
    : (() => {
        throw new Error("test requires current-user identity");
      })();
}

function directoryChain(directory: string): string[] {
  const parent = path.dirname(directory);
  return parent === directory ? [directory] : [directory, ...directoryChain(parent)];
}

function requireConfiguringReceipt(
  receipt: ReturnType<typeof publishHermesPortableLifecycleReceipt>["receipt"],
): HermesPortableConfiguredReceipt {
  return receipt.phase === "configuring"
    ? receipt
    : (() => {
        throw new Error("fixture requires configuring");
      })();
}

function failShortWrite(): never {
  throw new Error("simulated short-write exit");
}

function runtimeAuthority(): CheckpointPortableRuntimeAuthority {
  const currentUid = uid();
  return {
    schemaVersion: 1,
    kind: "podman",
    ownership: "current-user",
    uid: currentUid,
    homeDir,
    configHome: path.join(homeDir, ".config"),
    runtimeDir: `/run/user/${String(currentUid)}`,
    socketPath: `/run/user/${String(currentUid)}/podman/podman.sock`,
  };
}

function socketAuthority(): PodmanSocketAuthority {
  const runtime = runtimeAuthority();
  const directories = directoryChain(path.dirname(runtime.socketPath));
  return {
    device: "1",
    inode: "2",
    mode: String(0o140600),
    ownerUid: String(uid()),
    socketPath: runtime.socketPath,
    directoryChain: directories.map((directory, index) => ({
      device: "1",
      inode: String(index + 3),
      mode: String(index === 0 ? 0o40700 : 0o40755),
      ownerUid: String(index === 0 ? uid() : 0),
      path: directory,
    })),
  };
}

function startup(): HermesPortableStartupContract {
  return {
    manifestSha256: SHA,
    startupDescriptorSha256: "d".repeat(64),
    argv: [
      "env",
      "NEMOCLAW_SANDBOX_NAME=alpha",
      "NEMOCLAW_HERMES_API_PORT=8642",
      "/usr/local/bin/nemoclaw-start",
    ],
    gatewayCommand: "hermes gateway run",
    interactiveCommand: "hermes",
    health: {
      url: "http://localhost:8642/health",
      port: 8642,
      method: "GET",
      auth: "bearer_token",
      credentialEnv: "API_SERVER_KEY",
      successStatus: 200,
    },
    devicePairing: false,
    configDir: "/sandbox/.hermes",
    stateIdentitySha256: "e".repeat(64),
  };
}

function policy(transactionId: string): HermesPortablePolicyAuthority {
  return publishHermesPortableDurablePolicySource({
    sandboxName: SANDBOX,
    transactionId,
    stateDir,
    intendedSemanticSha256: "f".repeat(64),
    source: captureHermesPortablePolicySource(policyPath),
    hooks: { assertLifecycleLock: () => {} },
  });
}

function pending(
  overrides: Partial<HermesPortablePendingReceipt> = {},
): HermesPortablePendingReceipt {
  const transactionId = overrides.transactionId ?? randomUUID();
  return {
    schemaVersion: HERMES_PORTABLE_RECEIPT_SCHEMA_VERSION,
    agent: "hermes",
    phase: "pending",
    transactionId,
    sandboxName: SANDBOX,
    gatewayName: GATEWAY,
    lifecycleGeneration: GENERATION,
    runtimeAuthority: runtimeAuthority(),
    socketAuthority: socketAuthority(),
    startup: startup(),
    policy: overrides.policy ?? policy(transactionId),
    ...overrides,
  };
}

function configuring(
  parent: ReturnType<typeof publishHermesPortableLifecycleReceipt>,
  overrides: Partial<HermesPortableConfiguredReceipt> = {},
): HermesPortableConfiguredReceipt {
  const base = parent.receipt;
  return {
    ...base,
    phase: "configuring",
    previousPhaseSha256: parent.sha256,
    verifiedLivePolicySemanticSha256: base.policy.intendedSemanticSha256,
    container: {
      containerId: CONTAINER_ID,
      sandboxId: SANDBOX_ID,
      imageId: IMAGE_ID,
      labelsSha256: "9".repeat(64),
      name: `openshell-default--${SANDBOX}-${SANDBOX_ID}`,
      running: true,
      restartPolicy: "no",
    },
    ...overrides,
  };
}

function active(
  parent: ReturnType<typeof publishHermesPortableLifecycleReceipt>,
  overrides: Partial<HermesPortableConfiguredReceipt> = {},
): HermesPortableConfiguredReceipt {
  const receipt = requireConfiguringReceipt(parent.receipt);
  return {
    ...receipt,
    phase: "active",
    previousPhaseSha256: parent.sha256,
    container: { ...receipt.container, restartPolicy: "unless-stopped" },
    ...overrides,
  };
}

function writeLegacyReceipt(bytes: Buffer): string {
  const target = portableDemoReceiptPath(SANDBOX, stateDir);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  return target;
}

function publish(
  receipt: Parameters<typeof publishHermesPortableLifecycleReceipt>[0],
  hooks: Parameters<typeof publishHermesPortableLifecycleReceipt>[2] = {},
) {
  return publishHermesPortableLifecycleReceipt(receipt, stateDir, {
    assertLifecycleLock: () => {},
    ...hooks,
  });
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-receipt-"));
  homeDir = path.join(stateDir, "home");
  policyPath = path.join(stateDir, "policy.yaml");
  fs.mkdirSync(path.join(homeDir, ".config"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(policyPath, "version: 1\nnetwork_policies: {}\n", { mode: 0o600 });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("Hermes portable receipt authority", () => {
  it("requires the shared sandbox lifecycle lock before any receipt publication (#9203)", () => {
    expect(() => publishHermesPortableLifecycleReceipt(pending(), stateDir)).toThrow(
      "requires the sandbox lifecycle lock",
    );
    expect(() => readHermesPortableLifecycleReceipt(SANDBOX, stateDir)).toThrow(
      "incomplete or unknown publication evidence",
    );
  });

  it("publishes one strict pending receipt without changing legacy receipt behavior (#9203)", () => {
    const receipt = pending();
    const published = publish(receipt);

    expect(published.receipt).toEqual(receipt);
    expect(published.bytes.toString("utf8")).toBe(`${JSON.stringify(published.receipt)}\n`);
    expect(readHermesPortableLifecycleReceipt(SANDBOX, stateDir)).toEqual(published);
    expect(inspectPortableAgentReceiptAuthority(SANDBOX, stateDir)).toEqual({
      kind: "hermes",
      snapshot: published,
    });
  });

  it("keeps a schema-4 OpenClaw receipt byte-for-byte and does not reinterpret it (#9203)", () => {
    const legacyBytes = Buffer.from(
      `${JSON.stringify({
        schemaVersion: 4,
        sandboxName: SANDBOX,
        sandboxId: SANDBOX_ID,
        containerId: CONTAINER_ID,
        dashboardPort: 18789,
        registryGeneration: GENERATION,
        runtimeAuthority: runtimeAuthority(),
      })}\n`,
    );
    const target = writeLegacyReceipt(legacyBytes);

    expect(inspectPortableAgentReceiptAuthority(SANDBOX, stateDir)).toEqual({
      kind: "openclaw",
      path: target,
    });
    expect(fs.readFileSync(target)).toEqual(legacyBytes);
    expect(() => pending()).toThrow("will not reserve policy over OpenClaw authority");
    expect(inspectPortableAgentReceiptAuthority(SANDBOX, stateDir)).toEqual({
      kind: "openclaw",
      path: target,
    });
    expect(fs.readFileSync(target)).toEqual(legacyBytes);
  });

  it("rejects a conflicting pending transaction without replacing its bytes (#9203)", () => {
    const first = publish(pending());
    const conflicting = { ...first.receipt, lifecycleGeneration: "generation-2" };

    expect(() => publish(conflicting)).toThrow("pending phase already has other authority");
    expect(readHermesPortableLifecycleReceipt(SANDBOX, stateDir)?.bytes).toEqual(first.bytes);
  });

  it("rejects malformed UTF-8 and preserves the exact malformed bytes (#9203)", () => {
    const directory = hermesPortableReceiptDirectory(SANDBOX, stateDir);
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
    fs.mkdirSync(directory, { mode: 0o700 });
    const target = hermesPortableReceiptInternals.phasePath(directory, "pending");
    const malformed = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]);
    fs.writeFileSync(target, malformed, { mode: 0o600 });

    expect(() => readHermesPortableLifecycleReceipt(SANDBOX, stateDir)).toThrow("strict UTF-8");
    expect(fs.readFileSync(target)).toEqual(malformed);
  });

  it("advances only through a digest-bound pending, configuring, and active chain (#9203)", () => {
    const first = publish(pending());
    const second = publish(configuring(first));
    const third = publish(active(second));

    expect(readHermesPortableLifecycleReceipt(SANDBOX, stateDir)).toEqual(third);
    expect(third.receipt).toMatchObject({
      phase: "active",
      container: { containerId: CONTAINER_ID, restartPolicy: "unless-stopped", running: true },
    });
  });

  it("rejects a phase whose previous digest does not match the durable prior bytes (#9203)", () => {
    const first = publish(pending());
    const next = configuring(first, { previousPhaseSha256: "0".repeat(64) });

    expect(() => publish(next)).toThrow("does not match its prior phase");
    expect(readHermesPortableLifecycleReceipt(SANDBOX, stateDir)?.receipt.phase).toBe("pending");
  });

  it("resumes the same phase after interruption at the hard-link publication boundary (#9203)", () => {
    const receipt = pending();
    expect(() =>
      publish(receipt, {
        afterCanonicalLink: () => {
          throw new Error("simulated process exit");
        },
      }),
    ).toThrow("simulated process exit");

    const directory = hermesPortableReceiptDirectory(SANDBOX, stateDir);
    const target = hermesPortableReceiptInternals.phasePath(directory, "pending");
    const staged = hermesPortableReceiptInternals.stagePath(
      directory,
      "pending",
      receipt.transactionId,
    );
    expect(fs.statSync(target).ino).toBe(fs.statSync(staged).ino);
    expect(fs.statSync(target).nlink).toBe(2);
    expect(() => readHermesPortableLifecycleReceipt(SANDBOX, stateDir)).toThrow(
      "incomplete or unknown publication evidence",
    );

    const resumed = publish(receipt);
    expect(resumed.receipt).toEqual(receipt);
    expect(fs.statSync(target).nlink).toBe(1);
    expect(fs.existsSync(staged)).toBe(false);
  });

  it("retires an exact empty phase stage left before the first write (#9203)", () => {
    const receipt = pending();
    expect(() =>
      publish(receipt, {
        afterStageCreate: () => {
          throw new Error("simulated exit before phase write");
        },
      }),
    ).toThrow("simulated exit before phase write");

    const staged = hermesPortableReceiptInternals.stagePath(
      hermesPortableReceiptDirectory(SANDBOX, stateDir),
      "pending",
      receipt.transactionId,
    );
    expect(fs.statSync(staged).size).toBe(0);

    expect(publish(receipt).receipt).toEqual(receipt);
    expect(fs.existsSync(staged)).toBe(false);
  });

  it.each([
    ["cleanup link", "afterCleanupLink"],
    ["stage detach", "afterStageDetach"],
  ] as const)(
    "resumes the same phase after interruption at the %s boundary (#9203)",
    (_label, hook) => {
      const receipt = pending();
      expect(() =>
        publish(receipt, {
          [hook]: () => {
            throw new Error("simulated cleanup interruption");
          },
        }),
      ).toThrow("simulated cleanup interruption");

      const directory = hermesPortableReceiptDirectory(SANDBOX, stateDir);
      expect(() => readHermesPortableLifecycleReceipt(SANDBOX, stateDir)).toThrow(
        "incomplete or unknown publication evidence",
      );
      expect(publish(receipt).receipt).toEqual(receipt);
      expect(fs.readdirSync(directory).sort()).toEqual([
        "pending.json",
        `policy.${receipt.transactionId}.yaml`,
      ]);
    },
  );

  it("retires a short private stage and resumes only the identical publication (#9203)", () => {
    const receipt = pending();
    const originalWrite = fs.writeSync;
    const writeSpy = vi.spyOn(fs, "writeSync") as unknown as {
      mockImplementationOnce(
        implementation: (
          descriptor: number,
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number | null,
        ) => number,
      ): void;
    };
    writeSpy.mockImplementationOnce((descriptor, buffer, offset, length, position) =>
      originalWrite(descriptor, buffer, offset, Math.max(1, Math.floor(length / 2)), position),
    );
    expect(() =>
      publish(receipt, {
        afterStageWrite: (written, total) => {
          return written < total ? failShortWrite() : undefined;
        },
      }),
    ).toThrow("simulated short-write exit");
    vi.restoreAllMocks();

    expect(() => readHermesPortableLifecycleReceipt(SANDBOX, stateDir)).toThrow(
      "incomplete or unknown publication evidence",
    );
    expect(publish(receipt).receipt).toEqual(receipt);
  });

  it("does not unlink a replacement injected at the final cleanup boundary (#9203)", () => {
    const receipt = pending();
    const replacement = Buffer.from("replacement evidence\n");
    let replacedPath = "";

    expect(() =>
      publish(receipt, {
        beforeCleanupUnlink: () => {
          const directory = hermesPortableReceiptDirectory(SANDBOX, stateDir);
          const staged = hermesPortableReceiptInternals.stagePath(
            directory,
            "pending",
            receipt.transactionId,
          );
          replacedPath = `${staged}.cleanup`;
          fs.unlinkSync(replacedPath);
          fs.writeFileSync(replacedPath, replacement, { mode: 0o600 });
        },
      }),
    ).toThrow("artifact changed before exact detach");

    expect(fs.readFileSync(replacedPath)).toEqual(replacement);
    expect(() => readHermesPortableLifecycleReceipt(SANDBOX, stateDir)).toThrow(
      "incomplete or unknown publication evidence",
    );
  });

  it("preserves a fully written pre-link stage and resumes only the same transaction (#9203)", () => {
    const receipt = pending();
    expect(() =>
      publish(receipt, {
        afterStageFsync: () => {
          throw new Error("simulated pre-link exit");
        },
      }),
    ).toThrow("simulated pre-link exit");

    expect(() => readHermesPortableLifecycleReceipt(SANDBOX, stateDir)).toThrow(
      "incomplete or unknown publication evidence",
    );
    expect(() =>
      publish({ ...receipt, transactionId: randomUUID(), lifecycleGeneration: "generation-2" }),
    ).toThrow("directory contains other publication evidence");
    expect(publish(receipt).receipt).toEqual(receipt);
  });

  it("rejects an unsafe receipt directory without mutating its mode (#9203)", () => {
    const directory = hermesPortableReceiptDirectory(SANDBOX, stateDir);
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
    fs.mkdirSync(directory, { mode: 0o755 });

    expect(() => publish(pending())).toThrow("directory is unsafe");
    expect(fs.statSync(directory).mode & 0o777).toBe(0o755);
  });

  it("keeps the exact private policy source after temporary materialization disappears (#9203)", () => {
    const transactionId = randomUUID();
    const authority = policy(transactionId);
    const expected = fs.readFileSync(policyPath);
    fs.unlinkSync(policyPath);

    const receipt = pending({ transactionId, policy: authority });
    const published = publish(receipt);

    expect(fs.readFileSync(authority.sourcePath)).toEqual(expected);
    expect(fs.statSync(authority.sourcePath).mode & 0o777).toBe(0o600);
    expect(readHermesPortableLifecycleReceipt(SANDBOX, stateDir)).toEqual(published);
  });

  it("rejects source replacement immediately before durable publication without creating authority (#9203)", () => {
    const transactionId = randomUUID();
    const source = captureHermesPortablePolicySource(policyPath);
    const replacement = Buffer.from("version: 1\nnetwork_policies:\n  replacement: {}\n");

    expect(() =>
      publishHermesPortableDurablePolicySource({
        sandboxName: SANDBOX,
        transactionId,
        stateDir,
        intendedSemanticSha256: "f".repeat(64),
        source,
        hooks: {
          assertLifecycleLock: () => {},
          afterStageFsync: () => fs.writeFileSync(policyPath, replacement, { mode: 0o600 }),
        },
      }),
    ).toThrow("policy source changed while in custody");

    expect(fs.readFileSync(policyPath)).toEqual(replacement);
    expect(fs.existsSync(hermesPortablePolicySourcePath(SANDBOX, transactionId, stateDir))).toBe(
      false,
    );
    expect(() => inspectPortableAgentReceiptAuthority(SANDBOX, stateDir)).toThrow(
      "incomplete or unknown publication evidence",
    );
  });

  it("resumes durable policy publication after the canonical hard-link crash boundary (#9203)", () => {
    const transactionId = randomUUID();
    const source = captureHermesPortablePolicySource(policyPath);
    const input = {
      sandboxName: SANDBOX,
      transactionId,
      stateDir,
      intendedSemanticSha256: "f".repeat(64),
      source,
    } as const;

    expect(() =>
      publishHermesPortableDurablePolicySource({
        ...input,
        hooks: {
          assertLifecycleLock: () => {},
          afterCanonicalLink: () => {
            throw new Error("simulated policy publication exit");
          },
        },
      }),
    ).toThrow("simulated policy publication exit");
    expect(() => inspectPortableAgentReceiptAuthority(SANDBOX, stateDir)).toThrow(
      "incomplete or unknown publication evidence",
    );

    const authority = publishHermesPortableDurablePolicySource({
      ...input,
      hooks: { assertLifecycleLock: () => {} },
    });
    expect(fs.readFileSync(authority.sourcePath)).toEqual(source.bytes);
    expect(fs.statSync(authority.sourcePath).nlink).toBe(1);
  });

  it("retires an exact empty durable-policy stage left before the first write (#9203)", () => {
    const transactionId = randomUUID();
    const source = captureHermesPortablePolicySource(policyPath);
    const input = {
      sandboxName: SANDBOX,
      transactionId,
      stateDir,
      intendedSemanticSha256: "f".repeat(64),
      source,
    } as const;

    expect(() =>
      publishHermesPortableDurablePolicySource({
        ...input,
        hooks: {
          assertLifecycleLock: () => {},
          afterStageCreate: () => {
            throw new Error("simulated exit before policy write");
          },
        },
      }),
    ).toThrow("simulated exit before policy write");

    const authority = publishHermesPortableDurablePolicySource({
      ...input,
      hooks: { assertLifecycleLock: () => {} },
    });
    expect(fs.readFileSync(authority.sourcePath)).toEqual(source.bytes);
    expect(fs.statSync(authority.sourcePath).nlink).toBe(1);
  });

  it("rejects malformed UTF-8 policy bytes without modifying the source (#9203)", () => {
    const malformed = Buffer.from([0x76, 0x65, 0x72, 0xff]);
    fs.writeFileSync(policyPath, malformed, { mode: 0o600 });

    expect(() => captureHermesPortablePolicySource(policyPath)).toThrow(
      "policy source is not strict UTF-8",
    );
    expect(fs.readFileSync(policyPath)).toEqual(malformed);
  });
});
