// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PodmanExecutableAuthority, PodmanSocketAuthority } from "../../adapters/podman";
import type { HermesPortableOpenShellExecutableAuthority } from "../../adapters/openshell/resolve-shared";
import type { HermesPortablePodmanExecutableAuthority } from "./hermes-portable-podman-authority";
import {
  createHermesPortableSuccessorReceipt,
  type HermesPortableConfiguredReceipt,
  type HermesPortableReceiptSnapshot,
} from "./hermes-portable-receipt";
import { qualifyHermesPortableOperatingAuthority } from "./hermes-portable-operating-authority";

const SHA = "a".repeat(64);
let root: string;
let policyPath: string;

function uid(): number {
  return process.getuid!();
}

function executable(executablePath: string, sha256: string): PodmanExecutableAuthority {
  return {
    executablePath,
    device: "1",
    inode: "2",
    mode: String(0o100755),
    ownerUid: "0",
    size: "1024",
    modifiedTimeNanoseconds: "3",
    changedTimeNanoseconds: "4",
    sha256,
    directoryChain: [path.dirname(executablePath), "/usr", "/"].map((directory, index) => ({
      device: "1",
      inode: String(index + 5),
      mode: String(0o40755),
      ownerUid: "0",
      path: directory,
    })),
  };
}

function socket(inode = "11", parentMode = 0o40700): PodmanSocketAuthority {
  const currentUid = String(uid());
  return {
    device: "1",
    inode,
    mode: String(0o140600),
    ownerUid: currentUid,
    socketPath: `/run/user/${currentUid}/podman/podman.sock`,
    directoryChain: [
      `/run/user/${currentUid}/podman`,
      `/run/user/${currentUid}`,
      "/run/user",
      "/run",
      "/",
    ].map((directory, index) => ({
      device: "1",
      inode: String(index + 20),
      mode: String(index === 0 ? parentMode : 0o40755),
      ownerUid: String(index === 0 ? uid() : 0),
      path: directory,
    })),
  };
}

function environment(): NodeJS.ProcessEnv {
  return {
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, ".config"),
    XDG_RUNTIME_DIR: `/run/user/${String(uid())}`,
  };
}

function snapshot(withSuccessor = true): HermesPortableReceiptSnapshot & {
  readonly receipt: HermesPortableConfiguredReceipt;
} {
  const bytes = fs.readFileSync(policyPath);
  const stat = fs.statSync(policyPath, { bigint: true });
  const openshellExecutableAuthority: HermesPortableOpenShellExecutableAuthority = {
    version: "0.0.106",
    executable: executable("/usr/bin/openshell", "b".repeat(64)),
  };
  const podmanExecutableAuthority: HermesPortablePodmanExecutableAuthority = {
    version: "5.7.0",
    executable: executable("/usr/bin/podman", "c".repeat(64)),
  };
  const receipt: HermesPortableConfiguredReceipt = {
    schemaVersion: 5,
    phase: "active",
    agent: "hermes",
    transactionId: randomUUID(),
    createIntentSha256: SHA,
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-1",
    runtimeAuthority: {
      schemaVersion: 1,
      kind: "podman",
      ownership: "current-user",
      uid: uid(),
      homeDir: root,
      configHome: path.join(root, ".config"),
      runtimeDir: `/run/user/${String(uid())}`,
      socketPath: socket().socketPath,
    },
    openshellExecutableAuthority,
    podmanExecutableAuthority,
    socketAuthority: socket("10"),
    startup: {
      manifestSha256: SHA,
      startupDescriptorSha256: "d".repeat(64),
      argv: ["/usr/local/bin/nemoclaw-start"],
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
    },
    policy: {
      sourcePath: policyPath,
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      intendedSemanticSha256: "f".repeat(64),
      sourceIdentity: {
        dev: String(stat.dev),
        ino: String(stat.ino),
        size: String(stat.size),
        mode: 0o600,
        uid: uid(),
        mtimeNs: String(stat.mtimeNs),
        ctimeNs: String(stat.ctimeNs),
      },
    },
    previousPhaseSha256: SHA,
    verifiedLivePolicySemanticSha256: "f".repeat(64),
    container: {
      containerId: "1".repeat(64),
      sandboxId: "sandbox-id",
      imageId: `sha256:${"2".repeat(64)}`,
      labelsSha256: "3".repeat(64),
      name: "openshell-default--alpha-sandbox-id",
      running: true,
      restartPolicy: "unless-stopped",
    },
  };
  const historical = {
    receipt,
    bytes: Buffer.from("historical"),
    sha256: "4".repeat(64),
    path: path.join(root, "active.json"),
    identity: { dev: 1n, ino: 2n },
  };
  return withSuccessor
    ? {
        ...historical,
        successor: {
          receipt: createHermesPortableSuccessorReceipt(historical),
          bytes: Buffer.from("successor"),
          sha256: "5".repeat(64),
          path: path.join(root, "authority.json"),
          identity: { dev: 1n, ino: 3n },
        },
      }
    : historical;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-operation-authority-"));
  policyPath = path.join(root, "policy.yaml");
  fs.writeFileSync(policyPath, "version: 1\nnetwork_policies: {}\n", { mode: 0o600 });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("Hermes Portable schema-6 operation authority", () => {
  it("keeps schema-5 authority durable unless requalification is explicit (#10423)", () => {
    const durable = snapshot(false);
    const captureSocketAuthority = vi.fn(() => socket("99"));
    const captureOpenShellExecutableAuthority = vi.fn();
    const capturePodmanExecutableAuthority = vi.fn();

    const authority = qualifyHermesPortableOperatingAuthority(durable, {
      env: environment(),
      captureSocketAuthority,
      captureOpenShellExecutableAuthority,
      capturePodmanExecutableAuthority,
    });

    expect(authority.receipt).toBe(durable.receipt);
    expect(authority.assertCurrent).not.toThrow();
    expect(captureSocketAuthority).not.toHaveBeenCalled();
    expect(captureOpenShellExecutableAuthority).not.toHaveBeenCalled();
    expect(capturePodmanExecutableAuthority).not.toHaveBeenCalled();
  });

  it("captures operation-local authority for an explicitly admitted schema-5 receipt (#10423)", () => {
    const captureSocketAuthority = vi.fn(() => socket("99"));
    const captureOpenShellExecutableAuthority = vi.fn(() => ({
      version: "0.0.106" as const,
      executable: executable("/usr/bin/openshell", "b".repeat(64)),
    }));
    const capturePodmanExecutableAuthority = vi.fn(() => ({
      version: "5.7.0" as const,
      executable: executable("/usr/bin/podman", "c".repeat(64)),
    }));

    const authority = qualifyHermesPortableOperatingAuthority(
      snapshot(false),
      {
        env: environment(),
        captureSocketAuthority,
        captureOpenShellExecutableAuthority,
        capturePodmanExecutableAuthority,
      },
      { permitSchema5Requalification: true },
    );

    expect(authority.receipt.socketAuthority.inode).toBe("99");
    expect(captureSocketAuthority).toHaveBeenCalledOnce();
    expect(captureOpenShellExecutableAuthority).toHaveBeenCalledOnce();
    expect(capturePodmanExecutableAuthority).toHaveBeenCalledOnce();
  });

  it("admits new filesystem-instance identities while stable semantics agree (#10423)", () => {
    const authority = qualifyHermesPortableOperatingAuthority(snapshot(), {
      env: environment(),
      captureSocketAuthority: () => socket("99"),
      captureOpenShellExecutableAuthority: () => ({
        version: "0.0.106",
        executable: executable("/usr/bin/openshell", "b".repeat(64)),
      }),
      capturePodmanExecutableAuthority: () => ({
        version: "5.7.0",
        executable: executable("/usr/bin/podman", "c".repeat(64)),
      }),
    });

    expect(authority.receipt.socketAuthority.inode).toBe("99");
    expect(authority.assertCurrent).not.toThrow();
  });

  it("admits a safe recreated socket-directory mode for a new user session (#10423)", () => {
    const authority = qualifyHermesPortableOperatingAuthority(snapshot(), {
      env: environment(),
      captureSocketAuthority: () => socket("99", 0o40710),
      captureOpenShellExecutableAuthority: () => ({
        version: "0.0.106",
        executable: executable("/usr/bin/openshell", "b".repeat(64)),
      }),
      capturePodmanExecutableAuthority: () => ({
        version: "5.7.0",
        executable: executable("/usr/bin/podman", "c".repeat(64)),
      }),
    });

    expect(authority.receipt.socketAuthority.directoryChain[0]?.mode).toBe(String(0o40710));
    expect(authority.assertCurrent).not.toThrow();
  });

  it.each([
    ["writable socket directory", () => socket("99", 0o40720)],
    [
      "foreign socket-directory owner",
      () => ({
        ...socket("99"),
        directoryChain: socket("99").directoryChain.map((component, index) =>
          index === 0 ? { ...component, ownerUid: "2000" } : component,
        ),
      }),
    ],
    [
      "alternate socket directory",
      () => ({
        ...socket("99"),
        directoryChain: socket("99").directoryChain.map((component, index) =>
          index === 0 ? { ...component, path: "/run/user/1000/alternate" } : component,
        ),
      }),
    ],
    ["changed socket mode", () => ({ ...socket("99"), mode: String(0o140660) })],
  ] as const)("rejects %s semantics after a user-session transition (#10423)", (_case, capture) => {
    expect(() =>
      qualifyHermesPortableOperatingAuthority(snapshot(), {
        env: environment(),
        captureSocketAuthority: capture,
        captureOpenShellExecutableAuthority: () => ({
          version: "0.0.106",
          executable: executable("/usr/bin/openshell", "b".repeat(64)),
        }),
        capturePodmanExecutableAuthority: () => ({
          version: "5.7.0",
          executable: executable("/usr/bin/podman", "c".repeat(64)),
        }),
      }),
    ).toThrow("current filesystem or runtime semantics disagree");
  });

  it("rejects operation-local socket replacement before completion (#10423)", () => {
    let captures = 0;
    const authority = qualifyHermesPortableOperatingAuthority(snapshot(), {
      env: environment(),
      captureSocketAuthority: () => socket(String(100 + captures++)),
      captureOpenShellExecutableAuthority: () => ({
        version: "0.0.106",
        executable: executable("/usr/bin/openshell", "b".repeat(64)),
      }),
      capturePodmanExecutableAuthority: () => ({
        version: "5.7.0",
        executable: executable("/usr/bin/podman", "c".repeat(64)),
      }),
    });

    expect(authority.assertCurrent).toThrow(
      "operation-local filesystem or runtime identity changed",
    );
  });

  it("rejects operation-local policy replacement before completion (#10423)", () => {
    const authority = qualifyHermesPortableOperatingAuthority(snapshot(), {
      env: environment(),
      captureSocketAuthority: () => socket("99"),
      captureOpenShellExecutableAuthority: () => ({
        version: "0.0.106",
        executable: executable("/usr/bin/openshell", "b".repeat(64)),
      }),
      capturePodmanExecutableAuthority: () => ({
        version: "5.7.0",
        executable: executable("/usr/bin/podman", "c".repeat(64)),
      }),
    });
    const replacement = `${policyPath}.replacement`;
    fs.writeFileSync(replacement, fs.readFileSync(policyPath), { mode: 0o600 });
    fs.renameSync(replacement, policyPath);

    expect(authority.assertCurrent).toThrow(
      "operation-local filesystem or runtime identity changed",
    );
  });

  it.each(["openshell", "podman"] as const)(
    "rejects %s executable semantic drift before an operation begins (#10423)",
    (owner) => {
      expect(() =>
        qualifyHermesPortableOperatingAuthority(snapshot(), {
          env: environment(),
          captureSocketAuthority: () => socket("99"),
          captureOpenShellExecutableAuthority: () => ({
            version: "0.0.106",
            executable: executable(
              "/usr/bin/openshell",
              (owner === "openshell" ? "0" : "b").repeat(64),
            ),
          }),
          capturePodmanExecutableAuthority: () => ({
            version: "5.7.0",
            executable: executable("/usr/bin/podman", (owner === "podman" ? "0" : "c").repeat(64)),
          }),
        }),
      ).toThrow("current filesystem or runtime semantics disagree");
    },
  );
});
