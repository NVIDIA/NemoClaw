// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { withMcpLifecycleLockSync } from "../../state/mcp-lifecycle-lock-acquisition";
import type { PodmanSocketAuthority } from "../../adapters/podman";
import type { HermesPortableOpenShellExecutableAuthority } from "../../adapters/openshell/resolve-shared";
import type { HermesPortablePodmanExecutableAuthority } from "./hermes-portable-podman-authority";
import {
  HERMES_PORTABLE_RECEIPT_SCHEMA_VERSION,
  HERMES_PORTABLE_SUCCESSOR_SCHEMA_VERSION,
  captureHermesPortablePolicySource,
  hermesPortablePolicySourcePath,
  hermesPortableReceiptDirectory,
  hermesPortableReceiptInternals,
  hermesPortableReceiptRoot,
  inspectPortableAgentReceiptAuthority,
  inspectPortableAgentReceiptAuthorityForPublicationRecovery,
  readHermesPortableLifecycleReceiptForClassification,
  publishHermesPortableDurablePolicySource,
  publishHermesPortableLifecycleReceipt,
  publishHermesPortableSuccessorReceipt,
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

function createExistingHermesReceiptDirectories(count: number): void {
  Array.from({ length: count }, (_value, index) => {
    fs.mkdirSync(hermesPortableReceiptDirectory(`existing-${index}`, stateDir), { mode: 0o700 });
  });
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

function createUnaccountedReceiptLinks(target: string, count: number): void {
  Array.from({ length: count }, (_value, index) => {
    fs.linkSync(target, path.join(stateDir, `unaccounted-${index}.json`));
  });
}

function installShortWrite(prefixLength: number): void {
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
    originalWrite(descriptor, buffer, offset, Math.min(prefixLength, length), position),
  );
}

function failReceiptShortWrite(written: number, total: number): void {
  written < total ? failShortWrite() : undefined;
}

function failPolicyShortWrite(written: number, total: number): void {
  written < total
    ? (() => {
        throw new Error("simulated policy short-write exit");
      })()
    : undefined;
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

function openshellExecutableAuthority(): HermesPortableOpenShellExecutableAuthority {
  return {
    version: "0.0.106",
    executable: {
      executablePath: "/usr/bin/openshell",
      device: "1",
      inode: "10",
      mode: String(0o100755),
      ownerUid: "0",
      size: "1024",
      modifiedTimeNanoseconds: "11",
      changedTimeNanoseconds: "12",
      sha256: "8".repeat(64),
      directoryChain: ["/usr/bin", "/usr", "/"].map((directory, index) => ({
        device: "1",
        inode: String(index + 20),
        mode: String(0o40755),
        ownerUid: "0",
        path: directory,
      })),
    },
  };
}

function podmanExecutableAuthority(): HermesPortablePodmanExecutableAuthority {
  return {
    version: "5.7.0",
    executable: {
      executablePath: "/usr/bin/podman",
      device: "1",
      inode: "30",
      mode: String(0o100755),
      ownerUid: "0",
      size: "2048",
      modifiedTimeNanoseconds: "31",
      changedTimeNanoseconds: "32",
      sha256: "9".repeat(64),
      directoryChain: ["/usr/bin", "/usr", "/"].map((directory, index) => ({
        device: "1",
        inode: String(index + 40),
        mode: String(0o40755),
        ownerUid: "0",
        path: directory,
      })),
    },
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
    createIntentSha256: "c".repeat(64),
    sandboxName: SANDBOX,
    gatewayName: GATEWAY,
    lifecycleGeneration: GENERATION,
    runtimeAuthority: runtimeAuthority(),
    openshellExecutableAuthority: openshellExecutableAuthority(),
    podmanExecutableAuthority: podmanExecutableAuthority(),
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

function publishActiveReceipt() {
  const reserved = publish(pending());
  const configured = publish(configuring(reserved));
  return publish(active(configured));
}

function publishSuccessor() {
  return withMcpLifecycleLockSync(
    SANDBOX,
    () => publishHermesPortableSuccessorReceipt(SANDBOX, stateDir),
    { stateDir: path.join(stateDir, "state") },
  );
}

function leaveInterruptedReceiptPrefix(receipt: HermesPortablePendingReceipt): string {
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
  return hermesPortableReceiptInternals.stagePath(
    hermesPortableReceiptDirectory(SANDBOX, stateDir),
    receipt,
  );
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

  it("rejects a schema-5 receipt without create intent before writing a stage (#9203)", () => {
    const receipt = pending();
    const missingIntent = { ...receipt } as Record<string, unknown>;
    delete missingIntent.createIntentSha256;
    const directory = hermesPortableReceiptDirectory(SANDBOX, stateDir);

    expect(() => publish(missingIntent as never)).toThrow("invalid identity fields");
    expect(fs.existsSync(path.join(directory, "pending.json"))).toBe(false);
    expect(fs.readdirSync(directory).sort()).toEqual([`policy.${receipt.transactionId}.yaml`]);
  });

  it("rejects a schema-5 receipt outside the exact Podman 5.7.0 authority (#9203)", () => {
    const receipt = pending();
    const wrongVersion = {
      ...receipt,
      podmanExecutableAuthority: {
        ...receipt.podmanExecutableAuthority,
        version: "5.8.0",
      },
    };
    const directory = hermesPortableReceiptDirectory(SANDBOX, stateDir);

    expect(() => publish(wrongVersion as never)).toThrow("invalid Podman executable authority");
    expect(fs.existsSync(path.join(directory, "pending.json"))).toBe(false);
  });

  it("rejects an OpenShell 0.0.101 receipt before writing a stage (#9211)", () => {
    const receipt = pending();
    const staleVersion = {
      ...receipt,
      openshellExecutableAuthority: {
        ...receipt.openshellExecutableAuthority,
        version: "0.0.101",
      },
    };
    const directory = hermesPortableReceiptDirectory(SANDBOX, stateDir);

    expect(() => publish(staleVersion as never)).toThrow("invalid OpenShell executable authority");
    expect(fs.existsSync(path.join(directory, "pending.json"))).toBe(false);
  });

  it("keeps the receipt root usable beyond eight independent Hermes sandboxes (#9203)", () => {
    const root = hermesPortableReceiptRoot(stateDir);
    fs.mkdirSync(root, { mode: 0o700 });
    createExistingHermesReceiptDirectories(9);

    const published = publish(pending());

    expect(readHermesPortableLifecycleReceipt(SANDBOX, stateDir)).toEqual(published);
    expect(fs.statSync(root).nlink).toBeGreaterThan(10);
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

    expect(() => publish(conflicting)).toThrow("publication artifacts disagree");
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

  it("publishes deterministic schema-6 authority without changing schema-5 history (#10423)", () => {
    const historical = publishActiveReceipt();

    const published = publishSuccessor();
    const repeated = publishSuccessor();

    expect(published.successor.receipt).toMatchObject({
      schemaVersion: HERMES_PORTABLE_SUCCESSOR_SCHEMA_VERSION,
      predecessorActiveSha256: historical.sha256,
      phase: "active",
    });
    expect(repeated.successor.bytes).toEqual(published.successor.bytes);
    expect(published.bytes).toEqual(historical.bytes);
    expect(published.identity).toEqual(historical.identity);
    expect(repeated.bytes).toEqual(historical.bytes);
    expect(repeated.identity).toEqual(historical.identity);
  });

  it("requalifies an identical same-path policy copy only through schema 6 (#10423)", () => {
    const historical = publishActiveReceipt();
    const policyTarget = historical.receipt.policy.sourcePath;
    const replacement = `${policyTarget}.replacement`;
    fs.writeFileSync(replacement, fs.readFileSync(policyTarget), { mode: 0o600 });
    fs.renameSync(replacement, policyTarget);

    expect(() => readHermesPortableLifecycleReceipt(SANDBOX, stateDir)).toThrow(
      "durable policy source disagrees with its receipt authority",
    );
    expect(
      readHermesPortableLifecycleReceiptForClassification(SANDBOX, stateDir)?.receipt.phase,
    ).toBe("active");

    const migrated = publishSuccessor();
    expect(migrated.successor.receipt.predecessorActiveSha256).toBe(historical.sha256);
    expect(readHermesPortableLifecycleReceipt(SANDBOX, stateDir)?.successor?.sha256).toBe(
      migrated.successor.sha256,
    );
  });

  it("rejects changed policy bytes before schema-6 publication (#10423)", () => {
    publishActiveReceipt();
    const policyTarget = readHermesPortableLifecycleReceipt(SANDBOX, stateDir)!.receipt.policy
      .sourcePath;
    fs.writeFileSync(policyTarget, "version: 1\nnetwork_policies:\n  changed: {}\n", {
      mode: 0o600,
    });

    expect(() => readHermesPortableLifecycleReceiptForClassification(SANDBOX, stateDir)).toThrow(
      "durable policy source disagrees with its semantic authority",
    );
    expect(() => publishSuccessor()).toThrow(
      "durable policy source disagrees with its semantic authority",
    );
  });

  it.each([
    [
      "symlink substitution",
      (target: string) => {
        const backing = path.join(stateDir, "policy-symlink-backing.yaml");
        fs.renameSync(target, backing);
        fs.symlinkSync(backing, target);
      },
      () => "ELOOP",
    ],
    [
      "hard-link substitution",
      (target: string) => fs.linkSync(target, path.join(stateDir, "policy-hardlink.yaml")),
      (target: string) => `file is unsafe: ${target}`,
    ],
    [
      "unsafe mode",
      (target: string) => fs.chmodSync(target, 0o644),
      (target: string) => `file is unsafe: ${target}`,
    ],
  ])("rejects %s during schema-6 requalification (#10423)", (_label, mutate, expected) => {
    publishActiveReceipt();
    const target = readHermesPortableLifecycleReceipt(SANDBOX, stateDir)!.receipt.policy.sourcePath;
    mutate(target);

    expect(() => readHermesPortableLifecycleReceiptForClassification(SANDBOX, stateDir)).toThrow(
      expected(target),
    );
    expect(() => publishSuccessor()).toThrow(expected(target));
  });

  it("reconciles an exact interrupted schema-6 publication (#10423)", () => {
    publishActiveReceipt();
    expect(() =>
      withMcpLifecycleLockSync(
        SANDBOX,
        () =>
          publishHermesPortableSuccessorReceipt(SANDBOX, stateDir, {
            afterCanonicalLink: () => {
              throw new Error("simulated schema-6 process exit");
            },
          }),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toThrow("simulated schema-6 process exit");
    expect(() => readHermesPortableLifecycleReceipt(SANDBOX, stateDir)).toThrow(
      "incomplete or unknown publication evidence",
    );
    expect(
      withMcpLifecycleLockSync(
        SANDBOX,
        () => inspectPortableAgentReceiptAuthorityForPublicationRecovery(SANDBOX, stateDir),
        { stateDir: path.join(stateDir, "state") },
      ),
    ).toMatchObject({
      kind: "hermes",
      snapshot: { receipt: { phase: "active" }, successor: { receipt: { schemaVersion: 6 } } },
    });

    const recovered = publishSuccessor();
    expect(recovered.successor.receipt.schemaVersion).toBe(
      HERMES_PORTABLE_SUCCESSOR_SCHEMA_VERSION,
    );
    expect(fs.statSync(recovered.successor.path).nlink).toBe(1);
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
    const staged = hermesPortableReceiptInternals.stagePath(directory, receipt);
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

  it.each([1, 2])(
    "rejects %i unaccounted hard link(s) during publication recovery (#9203)",
    (linkCount) => {
      const receipt = pending();
      const published = publish(receipt);
      createUnaccountedReceiptLinks(published.path, linkCount);

      expect(() =>
        withMcpLifecycleLockSync(
          SANDBOX,
          () => inspectPortableAgentReceiptAuthorityForPublicationRecovery(SANDBOX, stateDir),
          { stateDir: path.join(stateDir, "state") },
        ),
      ).toThrow("unaccounted or different generations");
      expect(fs.readFileSync(published.path)).toEqual(published.bytes);
    },
  );

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
      receipt,
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

  it.each([1, 8])(
    "retires an exact %i-byte authorized receipt prefix and resumes publication (#9203)",
    (prefixLength) => {
      const receipt = pending();
      installShortWrite(prefixLength);
      expect(() =>
        publish(receipt, {
          afterStageWrite: failReceiptShortWrite,
        }),
      ).toThrow("simulated short-write exit");
      vi.restoreAllMocks();

      expect(() => readHermesPortableLifecycleReceipt(SANDBOX, stateDir)).toThrow(
        "incomplete or unknown publication evidence",
      );
      const directory = hermesPortableReceiptDirectory(SANDBOX, stateDir);
      const staged = hermesPortableReceiptInternals.stagePath(directory, receipt);
      const prior = fs.readFileSync(staged);
      const priorIdentity = fs.statSync(staged).ino;
      expect(prior.length).toBeGreaterThan(0);
      expect(priorIdentity).toBeGreaterThan(0);
      expect(publish(receipt).receipt).toEqual(receipt);
      expect(fs.existsSync(staged)).toBe(false);
      expect(fs.existsSync(path.join(directory, "pending.json"))).toBe(true);
    },
  );

  it("preserves a non-prefix interrupted stage without publishing (#9203)", () => {
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
          written < total
            ? (() => {
                throw new Error("simulated short-write exit");
              })()
            : undefined;
        },
      }),
    ).toThrow("simulated short-write exit");
    vi.restoreAllMocks();

    const directory = hermesPortableReceiptDirectory(SANDBOX, stateDir);
    const staged = hermesPortableReceiptInternals.stagePath(directory, receipt);
    const changed = fs.readFileSync(staged);
    changed[changed.length - 1] ^= 1;
    fs.writeFileSync(staged, changed, { mode: 0o600 });
    const identity = fs.statSync(staged).ino;

    expect(() => publish(receipt)).toThrow("not the exact authorized receipt prefix");
    expect(fs.readFileSync(staged)).toEqual(changed);
    expect(fs.statSync(staged).ino).toBe(identity);
    expect(fs.existsSync(path.join(directory, "pending.json"))).toBe(false);
  });

  it("preserves an identity-rotated prefix stage at the retirement boundary (#9203)", () => {
    const receipt = pending();
    const staged = leaveInterruptedReceiptPrefix(receipt);
    const prior = fs.readFileSync(staged);
    const displaced = `${staged}.displaced`;

    expect(() =>
      publish(receipt, {
        beforeInterruptedStageRetirement: () => {
          fs.renameSync(staged, displaced);
          fs.writeFileSync(staged, prior, { mode: 0o600 });
        },
      }),
    ).toThrow("changed before exact retirement");
    expect(fs.readFileSync(staged)).toEqual(prior);
    expect(fs.readFileSync(displaced)).toEqual(prior);
    expect(fs.existsSync(path.join(path.dirname(staged), "pending.json"))).toBe(false);
  });

  it("preserves a contender that publishes canonical evidence before prefix retirement (#9203)", () => {
    const receipt = pending();
    const staged = leaveInterruptedReceiptPrefix(receipt);
    const target = path.join(path.dirname(staged), "pending.json");
    const contender = Buffer.from("contender evidence\n");

    expect(() =>
      publish(receipt, {
        beforeInterruptedStageRetirement: () => {
          fs.writeFileSync(target, contender, { flag: "wx", mode: 0o600 });
        },
      }),
    ).toThrow("conflicts with other publication evidence");
    expect(fs.readFileSync(target)).toEqual(contender);
    expect(fs.existsSync(staged)).toBe(true);
  });

  it("fails on prefix-retirement directory fsync and completes an identical retry (#9203)", () => {
    const receipt = pending();
    const staged = leaveInterruptedReceiptPrefix(receipt);
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw new Error("simulated prefix retirement fsync failure");
    });

    expect(() => publish(receipt)).toThrow("simulated prefix retirement fsync failure");
    vi.restoreAllMocks();
    expect(fs.existsSync(staged)).toBe(false);
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
          const staged = hermesPortableReceiptInternals.stagePath(directory, receipt);
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

  it("reconciles exact same-generation cleanup evidence before canonical success (#9203)", () => {
    const receipt = pending();
    const published = publish(receipt);
    const staged = hermesPortableReceiptInternals.stagePath(path.dirname(published.path), receipt);
    const cleanup = `${staged}.cleanup`;
    fs.linkSync(published.path, cleanup);

    expect(publish(receipt)).toEqual(published);
    expect(fs.existsSync(cleanup)).toBe(false);
    expect(fs.statSync(published.path).nlink).toBe(1);
  });

  it("preserves mismatched cleanup evidence instead of accepting canonical authority (#9203)", () => {
    const receipt = pending();
    const published = publish(receipt);
    const staged = hermesPortableReceiptInternals.stagePath(path.dirname(published.path), receipt);
    const cleanup = `${staged}.cleanup`;
    const mismatch = Buffer.from("mismatched cleanup generation\n");
    fs.writeFileSync(cleanup, mismatch, { mode: 0o600 });

    expect(() => publish(receipt)).toThrow("publication artifacts disagree");
    expect(fs.readFileSync(published.path)).toEqual(published.bytes);
    expect(fs.readFileSync(cleanup)).toEqual(mismatch);
  });

  it("rejects an oversized receipt before creating a private stage (#9203)", () => {
    const receipt = pending({
      startup: {
        ...startup(),
        argv: [
          "env",
          ...Array.from(
            { length: 20 },
            (_value, index) => `NEMOCLAW_TEST_${String(index)}=${"x".repeat(2000)}`,
          ),
          "/usr/local/bin/nemoclaw-start",
        ],
      },
    });
    const directory = hermesPortableReceiptDirectory(SANDBOX, stateDir);

    expect(() => publish(receipt)).toThrow("exceeds the bounded receipt size");
    expect(fs.existsSync(path.join(directory, "pending.json"))).toBe(false);
    expect(fs.existsSync(hermesPortableReceiptInternals.stagePath(directory, receipt))).toBe(false);
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

  it("preserves a staged receipt when the retry presents different authority (#9203)", () => {
    const receipt = pending();
    const directory = hermesPortableReceiptDirectory(SANDBOX, stateDir);
    const staged = hermesPortableReceiptInternals.stagePath(directory, receipt);
    expect(() =>
      publish(receipt, {
        afterStageFsync: () => {
          throw new Error("simulated pre-link exit");
        },
      }),
    ).toThrow("simulated pre-link exit");
    const prior = fs.readFileSync(staged);
    const priorIdentity = fs.statSync(staged).ino;

    expect(() => publish({ ...receipt, lifecycleGeneration: "generation-2" })).toThrow(
      "directory contains other publication evidence",
    );
    expect(fs.readFileSync(staged)).toEqual(prior);
    expect(fs.statSync(staged).ino).toBe(priorIdentity);
    expect(fs.existsSync(path.join(directory, "pending.json"))).toBe(false);
  });

  it("requires a successful phase-stage fsync and reopen before publication (#9203)", () => {
    const receipt = pending();
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw new Error("simulated phase stage fsync failure");
    });
    expect(() => publish(receipt)).toThrow("simulated phase stage fsync failure");
    vi.restoreAllMocks();

    expect(() =>
      publish(receipt, {
        beforeStageDurabilityReopen: () => {
          throw new Error("simulated phase stage reopen failure");
        },
      }),
    ).toThrow("simulated phase stage reopen failure");
    expect(() => readHermesPortableLifecycleReceipt(SANDBOX, stateDir)).toThrow(
      "incomplete or unknown publication evidence",
    );
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

  it("preserves durable policy publication when an unaccounted hard link appears (#9203)", () => {
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
    const target = hermesPortablePolicySourcePath(SANDBOX, transactionId, stateDir);
    const staged = hermesPortableReceiptInternals.policyStagePath(
      path.dirname(target),
      transactionId,
      source.sha256,
      input.intendedSemanticSha256,
    );
    const external = path.join(stateDir, "unaccounted-policy-link.yaml");
    fs.linkSync(target, external);
    const before = fs.readdirSync(path.dirname(target)).sort();

    expect(() =>
      publishHermesPortableDurablePolicySource({
        ...input,
        hooks: { assertLifecycleLock: () => {} },
      }),
    ).toThrow("publication artifacts have unaccounted links");
    expect(fs.readdirSync(path.dirname(target)).sort()).toEqual(before);
    expect(fs.readFileSync(target)).toEqual(source.bytes);
    expect(fs.statSync(target).ino).toBe(fs.statSync(staged).ino);
    expect(fs.statSync(target).nlink).toBe(3);
  });

  it.each([1, 4, 16])(
    "retires an exact %i-byte durable-policy prefix and resumes publication (#9203)",
    (prefixLength) => {
      const transactionId = randomUUID();
      const source = captureHermesPortablePolicySource(policyPath);
      const input = {
        sandboxName: SANDBOX,
        transactionId,
        stateDir,
        intendedSemanticSha256: "f".repeat(64),
        source,
      } as const;
      installShortWrite(prefixLength);
      expect(() =>
        publishHermesPortableDurablePolicySource({
          ...input,
          hooks: {
            assertLifecycleLock: () => {},
            afterStageWrite: failPolicyShortWrite,
          },
        }),
      ).toThrow("simulated policy short-write exit");
      vi.restoreAllMocks();

      const authority = publishHermesPortableDurablePolicySource({
        ...input,
        hooks: { assertLifecycleLock: () => {} },
      });
      expect(fs.readFileSync(authority.sourcePath)).toEqual(source.bytes);
    },
  );

  it("reconciles or preserves durable-policy cleanup evidence before canonical success (#9203)", () => {
    const transactionId = randomUUID();
    const source = captureHermesPortablePolicySource(policyPath);
    const input = {
      sandboxName: SANDBOX,
      transactionId,
      stateDir,
      intendedSemanticSha256: "f".repeat(64),
      source,
    } as const;
    const authority = publishHermesPortableDurablePolicySource({
      ...input,
      hooks: { assertLifecycleLock: () => {} },
    });
    const staged = hermesPortableReceiptInternals.policyStagePath(
      path.dirname(authority.sourcePath),
      transactionId,
      source.sha256,
      input.intendedSemanticSha256,
    );
    const cleanup = `${staged}.cleanup`;
    fs.linkSync(authority.sourcePath, cleanup);
    expect(
      publishHermesPortableDurablePolicySource({
        ...input,
        hooks: { assertLifecycleLock: () => {} },
      }).sourcePath,
    ).toBe(authority.sourcePath);
    expect(fs.existsSync(cleanup)).toBe(false);

    const mismatch = Buffer.from("mismatched policy cleanup\n");
    fs.writeFileSync(cleanup, mismatch, { mode: 0o600 });
    expect(() =>
      publishHermesPortableDurablePolicySource({
        ...input,
        hooks: { assertLifecycleLock: () => {} },
      }),
    ).toThrow("publication artifacts disagree");
    expect(fs.readFileSync(authority.sourcePath)).toEqual(source.bytes);
    expect(fs.readFileSync(cleanup)).toEqual(mismatch);
  });

  it("preserves a staged durable policy when retry bytes disagree (#9203)", () => {
    const transactionId = randomUUID();
    const source = captureHermesPortablePolicySource(policyPath);
    const directory = hermesPortableReceiptDirectory(SANDBOX, stateDir);
    const staged = hermesPortableReceiptInternals.policyStagePath(
      directory,
      transactionId,
      source.sha256,
      "f".repeat(64),
    );
    expect(() =>
      publishHermesPortableDurablePolicySource({
        sandboxName: SANDBOX,
        transactionId,
        stateDir,
        intendedSemanticSha256: "f".repeat(64),
        source,
        hooks: {
          assertLifecycleLock: () => {},
          afterStageFsync: () => {
            throw new Error("simulated policy pre-link exit");
          },
        },
      }),
    ).toThrow("simulated policy pre-link exit");
    const prior = fs.readFileSync(staged);
    const priorIdentity = fs.statSync(staged).ino;
    fs.writeFileSync(policyPath, "version: 1\nnetwork_policies:\n  changed: {}\n", {
      mode: 0o600,
    });

    expect(() =>
      publishHermesPortableDurablePolicySource({
        sandboxName: SANDBOX,
        transactionId,
        stateDir,
        intendedSemanticSha256: "f".repeat(64),
        source: captureHermesPortablePolicySource(policyPath),
        hooks: { assertLifecycleLock: () => {} },
      }),
    ).toThrow("directory contains other policy authority");
    expect(fs.readFileSync(staged)).toEqual(prior);
    expect(fs.statSync(staged).ino).toBe(priorIdentity);
    expect(fs.existsSync(hermesPortablePolicySourcePath(SANDBOX, transactionId, stateDir))).toBe(
      false,
    );
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

  it("requires a successful durable-policy stage fsync and reopen before publication (#9203)", () => {
    const transactionId = randomUUID();
    const source = captureHermesPortablePolicySource(policyPath);
    const input = {
      sandboxName: SANDBOX,
      transactionId,
      stateDir,
      intendedSemanticSha256: "f".repeat(64),
      source,
    } as const;
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw new Error("simulated policy stage fsync failure");
    });
    expect(() =>
      publishHermesPortableDurablePolicySource({
        ...input,
        hooks: { assertLifecycleLock: () => {} },
      }),
    ).toThrow("simulated policy stage fsync failure");
    vi.restoreAllMocks();

    expect(() =>
      publishHermesPortableDurablePolicySource({
        ...input,
        hooks: {
          assertLifecycleLock: () => {},
          beforeStageDurabilityReopen: () => {
            throw new Error("simulated policy stage reopen failure");
          },
        },
      }),
    ).toThrow("simulated policy stage reopen failure");
    expect(fs.existsSync(hermesPortablePolicySourcePath(SANDBOX, transactionId, stateDir))).toBe(
      false,
    );
    const authority = publishHermesPortableDurablePolicySource({
      ...input,
      hooks: { assertLifecycleLock: () => {} },
    });
    expect(fs.readFileSync(authority.sourcePath)).toEqual(source.bytes);
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
