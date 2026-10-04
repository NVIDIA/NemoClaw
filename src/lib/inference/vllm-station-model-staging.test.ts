// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAtomicIdentityReplacementRunner,
  createBetweenAuditMutationRunner,
  createManifestPeerPythonRunner,
  createPeerIntegrityRunner,
  createPostAuditMutationRunner,
  createPythonOnlyRunner,
} from "../../../test/support/vllm-station-model-staging-test-support";
import { DUAL_STATION_VLLM_RUNTIME, type DualStationVllmPlan } from "./vllm-station-cluster";
import {
  type ModelStagingCommandResult,
  stageDualStationModelSnapshot,
} from "./vllm-station-model-staging";
import {
  createDualStationSshBindingFixture,
  type DualStationSshBindingFixture,
} from "./vllm-station-ssh-binding.test-support";

let sshFixture: DualStationSshBindingFixture;
let mockedLocalRoot: string;
let mockedLocalHome: string;
let mockedLocalModelRoot: string;

function modelRootForHome(home: string): string {
  return path.join(
    home,
    ".cache",
    "huggingface",
    "hub",
    `models--${DUAL_STATION_VLLM_RUNTIME.modelId.replace("/", "--")}`,
  );
}

function snapshotForHome(home: string): string {
  return path.join(modelRootForHome(home), "snapshots", DUAL_STATION_VLLM_RUNTIME.modelRevision);
}

beforeEach(() => {
  sshFixture = createDualStationSshBindingFixture();
  mockedLocalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-model-staging-test-"));
  mockedLocalHome = path.join(mockedLocalRoot, "home");
  mockedLocalModelRoot = modelRootForHome(mockedLocalHome);
  fs.mkdirSync(mockedLocalModelRoot, { mode: 0o700, recursive: true });
});

function plan(): DualStationVllmPlan {
  return {
    peerSshBinding: sshFixture.binding,
    runtime: DUAL_STATION_VLLM_RUNTIME,
    local: {
      hostname: "station-a",
      home: mockedLocalHome,
      uid: 1000,
      gid: 1000,
      gpu: {
        index: 0,
        name: "NVIDIA GB300",
        uuid: "GPU-a",
        totalMemoryMiB: 100_000,
        freeMemoryMiB: 95_000,
      },
    },
    peer: {
      hostname: "station-b",
      home: "/home/nvidia",
      uid: 1000,
      gid: 1000,
      gpu: {
        index: 0,
        name: "NVIDIA GB300",
        uuid: "GPU-b",
        totalMemoryMiB: 100_000,
        freeMemoryMiB: 95_000,
      },
    },
    rails: [
      {
        index: 0,
        subnet: "192.168.100.0/30",
        local: {
          rdmaDevice: "mlx5_0",
          netdev: "cx8a0",
          macAddress: "02:00:00:00:00:01",
          uverbsDevice: "/dev/infiniband/uverbs0",
          pciAddress: "0000:01:00.0",
          address: "192.168.100.1",
        },
        peer: {
          rdmaDevice: "mlx5_0",
          netdev: "cx8b0",
          macAddress: "02:00:00:00:00:02",
          uverbsDevice: "/dev/infiniband/uverbs0",
          pciAddress: "0000:01:00.0",
          address: "192.168.100.2",
        },
      },
      {
        index: 1,
        subnet: "192.168.200.0/30",
        local: {
          rdmaDevice: "mlx5_1",
          netdev: "cx8a1",
          macAddress: "02:00:00:00:01:01",
          uverbsDevice: "/dev/infiniband/uverbs1",
          pciAddress: "0000:01:00.1",
          address: "192.168.200.1",
        },
        peer: {
          rdmaDevice: "mlx5_1",
          netdev: "cx8b1",
          macAddress: "02:00:00:00:01:02",
          uverbsDevice: "/dev/infiniband/uverbs1",
          pciAddress: "0000:01:00.1",
          address: "192.168.200.2",
        },
      },
    ],
    masterAddress: "192.168.100.1",
    roceGidIndex: 3,
  };
}

function result(stdout = "", status = 0): ModelStagingCommandResult {
  return { status, stdout, stderr: "" };
}

function manifest(): string {
  return JSON.stringify({
    schemaVersion: 1,
    files: [
      {
        path: "config.json",
        size: 2,
        sha256: createHash("sha256").update("{}").digest("hex"),
      },
    ],
    directories: [],
    totalBytes: 2,
  });
}

function peerStagingForPlan(value: DualStationVllmPlan): string {
  const identity = [
    "nemoclaw-dual-station-model-staging-v1",
    DUAL_STATION_VLLM_RUNTIME.image,
    DUAL_STATION_VLLM_RUNTIME.modelId,
    DUAL_STATION_VLLM_RUNTIME.modelRevision,
    DUAL_STATION_VLLM_RUNTIME.servedModelId,
    String(DUAL_STATION_VLLM_RUNTIME.tensorParallelSize),
    String(DUAL_STATION_VLLM_RUNTIME.pipelineParallelSize),
    String(DUAL_STATION_VLLM_RUNTIME.nodeCount),
    value.local.gpu.uuid,
    value.peer.gpu.uuid,
  ].join("\0");
  const transaction = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32);
  return path.join(
    path.dirname(snapshotForHome(value.peer.home)),
    `.nemoclaw-staging-${transaction}`,
  );
}

function sufficientStatfs() {
  return vi.fn().mockResolvedValue({ bavail: 1024n * 1024n * 1024n, bsize: 4096n });
}

function createLocalSnapshotFixture(): { root: string; home: string; snapshot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-model-snapshot-"));
  const home = path.join(root, "home");
  const snapshot = snapshotForHome(home);
  fs.mkdirSync(snapshot, { mode: 0o700, recursive: true });
  const shards = Array.from(
    { length: 113 },
    (_, index) => `model-${String(index + 1).padStart(5, "0")}-of-00113.safetensors`,
  );
  for (const [index, shard] of shards.entries()) {
    fs.writeFileSync(path.join(snapshot, shard), `shard-${String(index)}`);
  }
  fs.writeFileSync(path.join(snapshot, "config.json"), "{}");
  fs.writeFileSync(path.join(snapshot, "tokenizer.json"), "{}");
  fs.writeFileSync(
    path.join(snapshot, "model.safetensors.index.json"),
    JSON.stringify({
      weight_map: Object.fromEntries(
        shards.map((shard, index) => [`model.layers.${String(index)}.weight`, shard]),
      ),
    }),
  );
  return { root, home, snapshot };
}

function successfulTransferRunner() {
  return vi
    .fn()
    .mockResolvedValueOnce(result(manifest()))
    .mockResolvedValueOnce(result('{"state":"transfer"}'))
    .mockResolvedValueOnce(result(manifest()))
    .mockResolvedValueOnce(result('{"state":"transfer"}'))
    .mockResolvedValueOnce(result())
    .mockResolvedValueOnce(result('{"state":"ready"}'));
}

function stagingSuffix(runCommand: ReturnType<typeof successfulTransferRunner>): string {
  const destination = String(runCommand.mock.calls[4][1].at(-1));
  return destination.match(/\.nemoclaw-staging-[a-f0-9]{32}/)?.[0] ?? "";
}

afterEach(() => {
  const stagingLeftovers = fs
    .readdirSync(mockedLocalModelRoot)
    .filter((entry) => entry.startsWith(".nemoclaw-vllm-model-staging-"));
  vi.unstubAllEnvs();
  sshFixture.cleanup();
  fs.rmSync(mockedLocalRoot, { force: true, recursive: true });
  expect(stagingLeftovers).toEqual([]);
});

describe("dual-Station pinned model staging", () => {
  it("copies only the audited snapshot through strict SSH and verifies it before install", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_AUTH_TOKEN", "must-not-cross-ssh");
    vi.stubEnv("HF_TOKEN", "must-not-cross-ssh");
    const runCommand = successfulTransferRunner();
    const statfs = sufficientStatfs();

    await expect(stageDualStationModelSnapshot(plan(), { runCommand, statfs })).resolves.toEqual({
      ok: true,
      transferred: true,
    });

    expect(runCommand).toHaveBeenCalledTimes(6);
    expect(runCommand.mock.calls.map((call) => call[0])).toEqual([
      "python3",
      "ssh",
      "python3",
      "ssh",
      "rsync",
      "ssh",
    ]);
    const auditArgs = runCommand.mock.calls[0][1] as string[];
    expect(auditArgs).toEqual(["-", snapshotForHome(mockedLocalHome), mockedLocalModelRoot]);
    const materializeArgs = runCommand.mock.calls[2][1] as string[];
    expect(materializeArgs.slice(0, 3)).toEqual(auditArgs);
    expect(materializeArgs[3]).toMatch(/nemoclaw-vllm-model-staging-[^/]+\/snapshot$/);
    expect(path.dirname(path.dirname(materializeArgs[3]))).toBe(mockedLocalModelRoot);
    expect(statfs).toHaveBeenCalledWith(mockedLocalModelRoot);

    const sshArgs = runCommand.mock.calls[1][1] as string[];
    expect(sshArgs).toEqual(
      expect.arrayContaining([
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "ClearAllForwardings=yes",
        "ControlMaster=no",
        `UserKnownHostsFile=${sshFixture.binding.knownHostsFile}`,
        "GlobalKnownHostsFile=/dev/null",
        `HostKeyAlias=${sshFixture.binding.lookupHost}`,
        `Hostname=${sshFixture.binding.resolvedHost}`,
        "User=nvidia",
        "Port=22",
        "--",
        "nvidia@station-b",
        "python3 -",
      ]),
    );
    const rsyncArgs = runCommand.mock.calls[4][1] as string[];
    expect(rsyncArgs).toEqual(
      expect.arrayContaining(["--checksum", "--partial", "--protect-args", "--"]),
    );
    expect(rsyncArgs).not.toContain("--copy-links");
    expect(rsyncArgs).not.toContain("--delete");
    expect(rsyncArgs.at(-2)).toBe(`${materializeArgs[3]}/`);
    expect(rsyncArgs.at(-1)).toMatch(
      new RegExp(
        `^nvidia@station-b:/home/nvidia/\\.cache/huggingface/hub/models--${DUAL_STATION_VLLM_RUNTIME.modelId.replace("/", "--")}/snapshots/\\.nemoclaw-staging-[a-f0-9]{32}/$`,
      ),
    );
    expect(rsyncArgs.join(" ")).toContain("StrictHostKeyChecking=yes");
    expect(runCommand.mock.calls[4][2]).toMatchObject({
      idleTimeoutMs: 30 * 60 * 1000,
      streamOutput: true,
    });
    expect(runCommand.mock.calls[4][2].env.OPENSHELL_GATEWAY_AUTH_TOKEN).toBeUndefined();
    expect(runCommand.mock.calls[4][2].env.HF_TOKEN).toBeUndefined();
  });

  it("transfers the materialized bytes if the source changes after the second audit", async () => {
    const fixture = createLocalSnapshotFixture();
    const fixturePlan = plan();
    fixturePlan.local.home = fixture.home;
    const { runCommand, state } = createPostAuditMutationRunner(fixture.snapshot);
    const statfs = sufficientStatfs();

    try {
      await expect(
        stageDualStationModelSnapshot(fixturePlan, { runCommand, statfs }),
      ).resolves.toEqual({ ok: true, transferred: true });
      expect(state.transferredConfig).toBe("{}");
      expect(state.snapshotMode).toBe(0o500);
      expect(state.configMode).toBe(0o400);
      expect(state.transferSource).not.toBe(fixture.snapshot);
      expect(path.dirname(path.dirname(state.transferSource))).toBe(modelRootForHome(fixture.home));
      expect(fs.existsSync(state.transferSource)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects source mutation between audits and cleans both staging roots", async () => {
    const fixture = createLocalSnapshotFixture();
    const fixturePlan = plan();
    fixturePlan.local.home = fixture.home;
    const { runCommand, state } = createBetweenAuditMutationRunner(fixture.snapshot);

    try {
      await expect(
        stageDualStationModelSnapshot(fixturePlan, {
          runCommand,
          statfs: sufficientStatfs(),
        }),
      ).resolves.toEqual({
        ok: false,
        reason: "local pinned snapshot changed between audit and materialization",
      });
      expect(runCommand.mock.calls.map((call) => call[0])).toEqual([
        "python3",
        "ssh",
        "python3",
        "ssh",
      ]);
      expect(fs.existsSync(state.materializedSnapshot)).toBe(false);
      expect(runCommand).not.toHaveBeenCalledWith("rsync", expect.anything(), expect.anything());
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects a snapshot symlink escape through the public staging boundary", async () => {
    const fixture = createLocalSnapshotFixture();
    const fixturePlan = plan();
    fixturePlan.local.home = fixture.home;
    const outside = path.join(fixture.root, "outside-tokenizer.json");
    const tokenizer = path.join(fixture.snapshot, "tokenizer.json");
    fs.writeFileSync(outside, "{}");
    fs.unlinkSync(tokenizer);
    fs.symlinkSync(outside, tokenizer);
    const runCommand = createPythonOnlyRunner();

    try {
      await expect(
        stageDualStationModelSnapshot(fixturePlan, { runCommand }),
      ).resolves.toMatchObject({
        ok: false,
        reason: expect.stringContaining("snapshot symlink escapes the pinned model cache"),
      });
      expect(runCommand).toHaveBeenCalledTimes(1);
      expect(runCommand.mock.calls[0][1] as string[]).toHaveLength(3);
      expect(
        fs
          .readdirSync(modelRootForHome(fixture.home))
          .some((entry) => entry.startsWith(".nemoclaw-vllm-model-staging-")),
      ).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("does no transfer when the peer already has the exact byte manifest", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(result(manifest()))
      .mockResolvedValueOnce(result('{"state":"ready"}'));
    const statfs = sufficientStatfs();

    await expect(stageDualStationModelSnapshot(plan(), { runCommand, statfs })).resolves.toEqual({
      ok: true,
      transferred: false,
    });
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(statfs).not.toHaveBeenCalled();
    expect(runCommand.mock.calls[0][1] as string[]).toHaveLength(3);
    expect(runCommand).not.toHaveBeenCalledWith("rsync", expect.anything(), expect.anything());
    expect(
      fs
        .readdirSync(mockedLocalModelRoot)
        .some((entry) => entry.startsWith(".nemoclaw-vllm-model-staging-")),
    ).toBe(false);
  });

  it("removes deterministic peer staging when the final snapshot is already exact", async () => {
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-model-peer-ready-"));
    const peerHome = path.join(remoteRoot, "peer-home");
    fs.mkdirSync(peerHome, { mode: 0o700 });
    const fixturePlan = plan();
    fixturePlan.peer.home = peerHome;
    const finalSnapshot = snapshotForHome(peerHome);
    const peerStaging = peerStagingForPlan(fixturePlan);
    fs.mkdirSync(finalSnapshot, { mode: 0o700, recursive: true });
    fs.writeFileSync(path.join(finalSnapshot, "config.json"), "{}");
    fs.mkdirSync(peerStaging, { mode: 0o700 });
    fs.writeFileSync(path.join(peerStaging, "config.json"), "{");
    const statfs = sufficientStatfs();
    const runCommand = createManifestPeerPythonRunner({
      localManifest: manifest(),
      peerHome,
    });

    try {
      await expect(
        stageDualStationModelSnapshot(fixturePlan, { runCommand, statfs }),
      ).resolves.toEqual({ ok: true, transferred: false });
      expect(runCommand.mock.calls.map((call) => call[0])).toEqual(["python3", "ssh"]);
      expect(statfs).not.toHaveBeenCalled();
      expect(fs.existsSync(finalSnapshot)).toBe(true);
      expect(fs.existsSync(peerStaging)).toBe(false);
      expect(runCommand).not.toHaveBeenCalledWith("rsync", expect.anything(), expect.anything());
    } finally {
      fs.rmSync(remoteRoot, { force: true, recursive: true });
    }
  });

  it("cleans peer staging without materializing when local capacity is insufficient", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(result(manifest()))
      .mockResolvedValueOnce(result('{"state":"transfer"}'))
      .mockResolvedValueOnce(result('{"state":"cleaned"}'));
    const statfs = vi.fn().mockResolvedValue({ bavail: 1n, bsize: 4096n });

    await expect(stageDualStationModelSnapshot(plan(), { runCommand, statfs })).resolves.toEqual({
      ok: false,
      reason: "local model cache does not have enough free space for the audited snapshot copy",
    });
    expect(statfs).toHaveBeenCalledWith(mockedLocalModelRoot);
    expect(runCommand.mock.calls.map((call) => call[0])).toEqual(["python3", "ssh", "ssh"]);
    expect(runCommand).not.toHaveBeenCalledWith("rsync", expect.anything(), expect.anything());
    expect(
      fs
        .readdirSync(mockedLocalModelRoot)
        .some((entry) => entry.startsWith(".nemoclaw-vllm-model-staging-")),
    ).toBe(false);
  });

  it("fails remote capacity preflight before creating either staging copy", async () => {
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-model-peer-capacity-"));
    const peerHome = path.join(remoteRoot, "peer-home");
    fs.mkdirSync(peerHome, { mode: 0o700 });
    const fixturePlan = plan();
    fixturePlan.peer.home = peerHome;
    const statfs = sufficientStatfs();
    const noCapacity = `import shutil
class _NemoClawDiskUsage:
    free = 0
shutil.disk_usage = lambda _path: _NemoClawDiskUsage()
`;
    const runCommand = createManifestPeerPythonRunner({
      localManifest: manifest(),
      peerHome,
      peerInputPrefix: noCapacity,
    });

    try {
      await expect(
        stageDualStationModelSnapshot(fixturePlan, { runCommand, statfs }),
      ).resolves.toEqual({
        ok: false,
        reason:
          "peer snapshot preflight failed: peer model cache does not have enough free space for the pinned snapshot",
      });
      expect(runCommand.mock.calls.map((call) => call[0])).toEqual(["python3", "ssh"]);
      expect(statfs).not.toHaveBeenCalled();
      expect(
        fs
          .readdirSync(path.dirname(snapshotForHome(peerHome)))
          .some((entry) => entry.startsWith(".nemoclaw-staging-")),
      ).toBe(false);
    } finally {
      fs.rmSync(remoteRoot, { force: true, recursive: true });
    }
  });

  it("does not credit a full-sized corrupt partial file toward remote capacity", async () => {
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-model-peer-corrupt-"));
    const peerHome = path.join(remoteRoot, "peer-home");
    fs.mkdirSync(peerHome, { mode: 0o700 });
    const fixturePlan = plan();
    fixturePlan.peer.home = peerHome;
    const peerStaging = peerStagingForPlan(fixturePlan);
    fs.mkdirSync(peerStaging, { mode: 0o700, recursive: true });
    const corruptSnapshotBytes = 64 * 1024 * 1024;
    const corruptPartial = path.join(peerStaging, "config.json");
    fs.writeFileSync(corruptPartial, "");
    fs.truncateSync(corruptPartial, corruptSnapshotBytes);
    const capacityManifest = JSON.stringify({
      schemaVersion: 1,
      files: [
        {
          path: "config.json",
          size: corruptSnapshotBytes,
          sha256: createHash("sha256").update("expected snapshot contents").digest("hex"),
        },
      ],
      directories: [],
      totalBytes: corruptSnapshotBytes,
    });
    const headroomOnly = `import shutil
class _NemoClawDiskUsage:
    free = 5 * 1024 * 1024 * 1024
shutil.disk_usage = lambda _path: _NemoClawDiskUsage()
`;
    const runCommand = createManifestPeerPythonRunner({
      localManifest: capacityManifest,
      peerHome,
      peerInputPrefix: headroomOnly,
    });

    try {
      await expect(
        stageDualStationModelSnapshot(fixturePlan, {
          runCommand,
          statfs: sufficientStatfs(),
        }),
      ).resolves.toEqual({
        ok: false,
        reason:
          "peer snapshot preflight failed: peer model cache does not have enough free space for the pinned snapshot",
      });
      expect(runCommand.mock.calls.map((call) => call[0])).toEqual(["python3", "ssh"]);
      expect(fs.statSync(corruptPartial).size).toBe(corruptSnapshotBytes);
    } finally {
      fs.rmSync(remoteRoot, { force: true, recursive: true });
    }
  });

  it("gives concurrent reversed and different local heads disjoint retry-safe staging paths", async () => {
    const original = plan();
    const reversed = plan();
    const reversedLocal = reversed.local;
    reversed.local = reversed.peer;
    reversed.peer = reversedLocal;
    reversed.local.home = mockedLocalHome;
    reversed.peer.home = "/home/nvidia";
    const reversedSshFixture = createDualStationSshBindingFixture("nvidia@station-a");
    reversed.peerSshBinding = reversedSshFixture.binding;
    const differentHead = plan();
    differentHead.local.gpu.uuid = "GPU-c";
    const originalRunner = successfulTransferRunner();
    const reversedRunner = successfulTransferRunner();
    const differentHeadRunner = successfulTransferRunner();

    try {
      await Promise.all([
        stageDualStationModelSnapshot(original, {
          runCommand: originalRunner,
          statfs: sufficientStatfs(),
        }),
        stageDualStationModelSnapshot(reversed, {
          runCommand: reversedRunner,
          statfs: sufficientStatfs(),
        }),
        stageDualStationModelSnapshot(differentHead, {
          runCommand: differentHeadRunner,
          statfs: sufficientStatfs(),
        }),
      ]);
    } finally {
      reversedSshFixture.cleanup();
    }

    const suffixes = [
      stagingSuffix(originalRunner),
      stagingSuffix(reversedRunner),
      stagingSuffix(differentHeadRunner),
    ];
    expect(suffixes.every((suffix) => /^\.nemoclaw-staging-[a-f0-9]{32}$/.test(suffix))).toBe(true);
    expect(new Set(suffixes).size).toBe(3);
  });

  it("reuses the same deterministic partial path for the same ordered pair", async () => {
    const firstRunner = successfulTransferRunner();
    const retryRunner = successfulTransferRunner();

    await stageDualStationModelSnapshot(plan(), {
      runCommand: firstRunner,
      statfs: sufficientStatfs(),
    });
    await stageDualStationModelSnapshot(plan(), {
      runCommand: retryRunner,
      statfs: sufficientStatfs(),
    });

    expect(stagingSuffix(firstRunner)).toBe(stagingSuffix(retryRunner));
  });

  it("cleans the private peer staging tree when rsync fails", async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(result(manifest()))
      .mockResolvedValueOnce(result('{"state":"transfer"}'))
      .mockResolvedValueOnce(result(manifest()))
      .mockResolvedValueOnce(result('{"state":"transfer"}'))
      .mockResolvedValueOnce({ status: 23, stdout: "", stderr: "partial transfer" })
      .mockResolvedValueOnce(result('{"state":"cleaned"}'));

    await expect(
      stageDualStationModelSnapshot(plan(), { runCommand, statfs: sufficientStatfs() }),
    ).resolves.toEqual({ ok: false, reason: "peer snapshot transfer failed: partial transfer" });
    expect(runCommand).toHaveBeenCalledTimes(6);
    expect(runCommand.mock.calls.map((call) => call[0])).toEqual([
      "python3",
      "ssh",
      "python3",
      "ssh",
      "rsync",
      "ssh",
    ]);
  });

  it("removes peer bytes that fail real manifest verification", async () => {
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-model-peer-"));
    const peerHome = path.join(remoteRoot, "peer-home");
    fs.mkdirSync(peerHome, { mode: 0o700 });
    const fixturePlan = plan();
    fixturePlan.peer.home = peerHome;
    const { runCommand, state } = createPeerIntegrityRunner({
      localManifest: manifest(),
      peerHome,
      peerInputPrefix: `import shutil
class _NemoClawDiskUsage:
    free = 1024 * 1024 * 1024 * 1024
shutil.disk_usage = lambda _path: _NemoClawDiskUsage()
`,
    });
    const statfs = sufficientStatfs();

    try {
      await expect(
        stageDualStationModelSnapshot(fixturePlan, { runCommand, statfs }),
      ).resolves.toEqual({
        ok: false,
        reason:
          "peer snapshot verification failed: peer staged snapshot failed byte-integrity verification",
      });
      expect(runCommand.mock.calls.map((call) => call[0])).toEqual([
        "python3",
        "ssh",
        "python3",
        "ssh",
        "rsync",
        "ssh",
        "ssh",
      ]);
      expect(fs.existsSync(state.stagingPath)).toBe(false);
    } finally {
      fs.rmSync(remoteRoot, { force: true, recursive: true });
    }
  });

  it("fails closed when atomic install resolves to a different directory identity", async () => {
    const fixture = createLocalSnapshotFixture();
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-model-peer-identity-"));
    const peerHome = path.join(remoteRoot, "peer-home");
    fs.mkdirSync(peerHome, { mode: 0o700 });
    const fixturePlan = plan();
    fixturePlan.local.home = fixture.home;
    fixturePlan.peer.home = peerHome;
    const { runCommand, state } = createAtomicIdentityReplacementRunner(peerHome);

    try {
      await expect(
        stageDualStationModelSnapshot(fixturePlan, {
          runCommand,
          statfs: sufficientStatfs(),
        }),
      ).resolves.toEqual({
        ok: false,
        reason:
          "peer snapshot verification failed: peer pinned snapshot identity changed during atomic install",
      });
      expect(runCommand.mock.calls.map((call) => call[0])).toEqual([
        "python3",
        "ssh",
        "python3",
        "ssh",
        "rsync",
        "ssh",
        "ssh",
      ]);
      expect(fs.existsSync(state.materializedSnapshot)).toBe(false);
      expect(fs.existsSync(snapshotForHome(peerHome))).toBe(true);
      expect(fs.existsSync(`${snapshotForHome(peerHome)}.nemoclaw-test-original`)).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
      fs.rmSync(remoteRoot, { force: true, recursive: true });
    }
  });

  it("rejects a peer home that cannot be represented without remote shell syntax", async () => {
    const unsafe = plan();
    unsafe.peer.home = "/home/nvidia;touch-pwned";
    const runCommand = vi.fn();

    await expect(stageDualStationModelSnapshot(unsafe, { runCommand })).resolves.toEqual({
      ok: false,
      reason: "peer home is unsafe for model staging",
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("fails before any command when the qualified host-key pin changes", async () => {
    fs.appendFileSync(sshFixture.binding.knownHostsFile, "changed\n");
    const runCommand = vi.fn();

    await expect(stageDualStationModelSnapshot(plan(), { runCommand })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("known-hosts binding changed"),
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("fails before SSH when the local manifest is malformed", async () => {
    const runCommand = vi.fn().mockResolvedValueOnce(result('{"schemaVersion":1}'));

    await expect(stageDualStationModelSnapshot(plan(), { runCommand })).resolves.toEqual({
      ok: false,
      reason: "local pinned snapshot audit returned an invalid manifest",
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});
