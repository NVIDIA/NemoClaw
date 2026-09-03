// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDualStationLifecycleHarness,
  dualStationDockerValues as dockerValues,
  type LifecycleFakeContainer as FakeContainer,
  type LifecycleHarnessOptions as HarnessOptions,
  requireLegacyMigration,
} from "../../../test/support/vllm-station-cluster-lifecycle-test-support";
import { DUAL_STATION_VLLM_RUNTIME, type DualStationVllmPlan } from "./vllm-station-cluster";
import {
  areDualStationManagedVllmContainersRunning,
  buildDualStationGpuSmokeRunArgs,
  buildDualStationVllmRunArgs,
  cleanupDualStationManagedVllm,
  commitDualStationLegacyMigration,
  DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL,
  DUAL_STATION_VLLM_CLUSTER_LABEL,
  DUAL_STATION_VLLM_ENDPOINT_LABEL,
  DUAL_STATION_VLLM_GPU_LABEL,
  DUAL_STATION_VLLM_GPU_SMOKE_LABEL,
  DUAL_STATION_VLLM_HEAD_CONTAINER_NAME,
  DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL,
  DUAL_STATION_VLLM_LAUNCH_SCHEMA,
  DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL,
  DUAL_STATION_VLLM_MANAGED_LABEL,
  DUAL_STATION_VLLM_ROLE_LABEL,
  DUAL_STATION_VLLM_TRANSACTION_LABEL,
  DUAL_STATION_VLLM_WORKER_CONTAINER_NAME,
  PREVIOUS_DUAL_STATION_VLLM_LAUNCH_SCHEMA,
  type DualStationVllmLifecycleDeps,
  dualStationVllmApiKeyFingerprint,
  dualStationVllmClusterId,
  dualStationVllmLaunchContract,
  getDualStationManagedVllmBaseUrl,
  previousDualStationVllmLaunchContract,
  preflightDualStationGpuRuntime,
  preflightDualStationManagedVllm,
  rollbackDualStationLegacyMigration,
  startDualStationManagedVllm,
  withDualStationManagedVllmLifecycle,
} from "./vllm-station-cluster-lifecycle";
import { withDualStationVllmLifecycleLock } from "./vllm-station-lifecycle-lock";
import {
  createDualStationSshBindingFixture,
  type DualStationSshBindingFixture,
} from "./vllm-station-ssh-binding.test-support";

const WORKER_ID = "a".repeat(64);
const HEAD_ID = "b".repeat(64);
const LEGACY_HEAD_ID = "9".repeat(64);
const WORKER_SMOKE_ID = "c".repeat(64);
const HEAD_SMOKE_ID = "d".repeat(64);
const API_KEY = "e".repeat(64);
const START_CONFIG = { apiKey: API_KEY };
const API_KEY_FINGERPRINT = dualStationVllmApiKeyFingerprint(API_KEY);
const TRANSACTION_ID = "1".repeat(32);
let sshFixture: DualStationSshBindingFixture;

beforeEach(() => {
  sshFixture = createDualStationSshBindingFixture();
});

afterEach(() => {
  sshFixture.cleanup();
});

function fixturePlan(): DualStationVllmPlan {
  return {
    peerSshBinding: sshFixture.binding,
    runtime: DUAL_STATION_VLLM_RUNTIME,
    local: {
      hostname: "station-a",
      home: "/home/local",
      uid: 1000,
      gid: 1000,
      gpu: {
        index: 0,
        name: "NVIDIA GB300",
        uuid: "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        totalMemoryMiB: 100_000,
        freeMemoryMiB: 95_000,
      },
    },
    peer: {
      hostname: "station-b",
      home: "/home/nvidia",
      uid: 1001,
      gid: 1001,
      gpu: {
        index: 1,
        name: "NVIDIA GB300 Grace Blackwell Superchip",
        uuid: "GPU-99999999-8888-7777-6666-555555555555",
        totalMemoryMiB: 100_000,
        freeMemoryMiB: 95_000,
      },
    },
    rails: [
      {
        index: 0,
        subnet: "192.168.240.0/30",
        local: {
          rdmaDevice: "mlx5_0",
          netdev: "cx8a0",
          macAddress: "02:00:00:00:00:01",
          uverbsDevice: "/dev/infiniband/uverbs0",
          pciAddress: "0001:03:00.0",
          address: "192.168.240.1",
        },
        peer: {
          rdmaDevice: "mlx5_0",
          netdev: "cx8b0",
          macAddress: "02:00:00:00:00:02",
          uverbsDevice: "/dev/infiniband/uverbs0",
          pciAddress: "0002:03:00.0",
          address: "192.168.240.2",
        },
      },
      {
        index: 1,
        subnet: "192.168.240.4/30",
        local: {
          rdmaDevice: "mlx5_1",
          netdev: "cx8a1",
          macAddress: "02:00:00:00:00:05",
          uverbsDevice: "/dev/infiniband/uverbs1",
          pciAddress: "0001:03:00.1",
          address: "192.168.240.5",
        },
        peer: {
          rdmaDevice: "mlx5_1",
          netdev: "cx8b1",
          macAddress: "02:00:00:00:00:06",
          uverbsDevice: "/dev/infiniband/uverbs1",
          pciAddress: "0002:03:00.1",
          address: "192.168.240.6",
        },
      },
    ],
    masterAddress: "192.168.240.1",
    roceGidIndex: 3,
  };
}

function fakeContainer(
  role: "head" | "worker",
  overrides: Partial<FakeContainer> = {},
): FakeContainer {
  return {
    id: role === "head" ? HEAD_ID : WORKER_ID,
    name:
      role === "head"
        ? DUAL_STATION_VLLM_HEAD_CONTAINER_NAME
        : DUAL_STATION_VLLM_WORKER_CONTAINER_NAME,
    state: "running",
    image: DUAL_STATION_VLLM_RUNTIME.image,
    labels: {
      [DUAL_STATION_VLLM_MANAGED_LABEL]: "true",
      [DUAL_STATION_VLLM_ROLE_LABEL]: role,
      [DUAL_STATION_VLLM_ENDPOINT_LABEL]:
        role === "head" ? "http://192.168.240.1:8000" : "headless",
      [DUAL_STATION_VLLM_CLUSTER_LABEL]: dualStationVllmClusterId(fixturePlan()),
      [DUAL_STATION_VLLM_GPU_LABEL]:
        role === "head" ? fixturePlan().local.gpu.uuid : fixturePlan().peer.gpu.uuid,
      [DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL]: DUAL_STATION_VLLM_LAUNCH_SCHEMA,
      [DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL]: dualStationVllmLaunchContract(fixturePlan(), role),
      [DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL]: API_KEY_FINGERPRINT,
      [DUAL_STATION_VLLM_TRANSACTION_LABEL]: TRANSACTION_ID,
    },
    ...overrides,
  };
}

function harness(options: HarnessOptions = {}) {
  return createDualStationLifecycleHarness(
    {
      apiKey: API_KEY,
      fakeContainer,
      headSmokeId: HEAD_SMOKE_ID,
      legacyHeadId: LEGACY_HEAD_ID,
      plan: fixturePlan,
      workerSmokeId: WORKER_SMOKE_ID,
    },
    options,
  );
}

type LifecycleHarness = ReturnType<typeof harness>;

function seedLegacyHead(fake: LifecycleHarness): void {
  fake.seed(
    "local",
    fakeContainer("head", {
      id: LEGACY_HEAD_ID,
      image:
        "vllm/vllm-openai@sha256:0fec7ec5f3e6bc168e54899935fb0557da908a4832a1dbc88e2debcf2f889416",
      labels: { [DUAL_STATION_VLLM_MANAGED_LABEL]: "true" },
    }),
  );
}

function previousSchemaContainer(role: "head" | "worker"): FakeContainer {
  const container = fakeContainer(role);
  container.labels[DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL] =
    PREVIOUS_DUAL_STATION_VLLM_LAUNCH_SCHEMA;
  container.labels[DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL] =
    previousDualStationVllmLaunchContract(fixturePlan(), role);
  return container;
}

function expectRestoredLegacyHead(fake: LifecycleHarness): void {
  expect(fake.containers.get(`local:${DUAL_STATION_VLLM_HEAD_CONTAINER_NAME}`)).toEqual([
    expect.objectContaining({
      id: LEGACY_HEAD_ID,
      name: DUAL_STATION_VLLM_HEAD_CONTAINER_NAME,
      state: "running",
    }),
  ]);
  expect(fake.containers.get(`peer:${DUAL_STATION_VLLM_WORKER_CONTAINER_NAME}`) ?? []).toEqual([]);
}

describe("dual-Station managed vLLM run argv", () => {
  it("derives stable, distinct service-key fingerprints", () => {
    expect(API_KEY_FINGERPRINT).toMatch(/^[a-f0-9]{64}$/u);
    expect(dualStationVllmApiKeyFingerprint(API_KEY)).toBe(API_KEY_FINGERPRINT);
    expect(dualStationVllmApiKeyFingerprint("f".repeat(64))).not.toBe(API_KEY_FINGERPRINT);
  });

  it("rejects a long slash-heavy runtime image", () => {
    const plan = {
      ...fixturePlan(),
      runtime: {
        ...DUAL_STATION_VLLM_RUNTIME,
        image: `${"!/".repeat(10_000)}image@sha256:${"a".repeat(64)}`,
      },
    } as unknown as DualStationVllmPlan;

    expect(() =>
      buildDualStationVllmRunArgs(plan, "head", TRANSACTION_ID, API_KEY_FINGERPRINT),
    ).toThrow("exact pinned runtime contract");
  });

  it.each(["head", "worker"] as const)("builds the exact %s launch contract", (role) => {
    const plan = fixturePlan();
    const args = buildDualStationVllmRunArgs(plan, role, TRANSACTION_ID, API_KEY_FINGERPRINT);
    const env = dockerValues(args, "--env");
    const expectedNode = role === "head" ? plan.local : plan.peer;
    const expectedNetdev = role === "head" ? "cx8a0" : "cx8b0";

    expect(args).toEqual(
      expect.arrayContaining(["--network", "host", "--shm-size", "16g", "--read-only"]),
    );
    expect(
      args.some(
        (arg) =>
          arg.startsWith("-p") ||
          arg.startsWith("-P") ||
          arg === "--publish" ||
          arg === "--publish-all" ||
          arg.startsWith("--publish=") ||
          arg.startsWith("--publish-all="),
      ),
    ).toBe(false);
    expect(dockerValues(args, "--workdir")).toEqual(["/home/vllm"]);
    expect(dockerValues(args, "--tmpfs")).toEqual([
      "/tmp:rw,nosuid,nodev,size=17179869184",
      `/usr/local/lib/python3.12/dist-packages/flashinfer_cubin/cubins/flashinfer:rw,nosuid,nodev,noexec,uid=${String(expectedNode.uid)},gid=${String(expectedNode.gid)},mode=0700,size=16777216`,
      `/home/vllm:rw,nosuid,nodev,exec,uid=${String(expectedNode.uid)},gid=${String(expectedNode.gid)},mode=0700,size=68719476736`,
    ]);
    expect(dockerValues(args, "--user")).toEqual([
      `${String(expectedNode.uid)}:${String(expectedNode.gid)}`,
    ]);
    expect(dockerValues(args, "--security-opt")).toEqual(["no-new-privileges:true"]);
    expect(dockerValues(args, "--cap-drop")).toEqual(["ALL"]);
    expect(dockerValues(args, "--cap-add")).toEqual([]);
    expect(args).not.toContain("DAC_READ_SEARCH");
    expect(args).not.toContain("IPC_LOCK");
    expect(dockerValues(args, "--ulimit")).toEqual([
      "memlock=-1",
      "stack=67108864",
      "nofile=1048576:1048576",
    ]);
    expect(dockerValues(args, "--gpus")).toEqual([`device=${expectedNode.gpu.uuid}`]);
    expect(args.filter((arg) => arg.startsWith("--device="))).toEqual([
      "--device=/dev/infiniband/uverbs0",
      "--device=/dev/infiniband/uverbs1",
    ]);
    expect(dockerValues(args, "--volume")).toEqual([
      `${expectedNode.home}/.cache/huggingface/hub:/model-cache:ro`,
    ]);
    expect(dockerValues(args, "--volume").join("\n")).not.toContain("/huggingface/token");
    expect(env).toEqual(
      expect.arrayContaining([
        "NCCL_IB_HCA=mlx5_0,mlx5_1",
        "NCCL_IB_DISABLE=0",
        "NCCL_IB_GID_INDEX=3",
        `NCCL_SOCKET_IFNAME=${expectedNetdev}`,
        `GLOO_SOCKET_IFNAME=${expectedNetdev}`,
        `TP_SOCKET_IFNAME=${expectedNetdev}`,
        `OMPI_MCA_btl_tcp_if_include=${expectedNetdev}`,
        `MN_IF_NAME=${expectedNetdev}`,
        "NCCL_IGNORE_CPU_AFFINITY=1",
        "UCX_NET_DEVICES=mlx5_0:1,mlx5_1:1",
        "UCX_IB_GID_INDEX=3",
        "HF_HUB_OFFLINE=1",
        "TRANSFORMERS_OFFLINE=1",
        "HF_HOME=/home/vllm/.cache/huggingface",
        "HF_HUB_CACHE=/model-cache",
        "HUGGINGFACE_HUB_CACHE=/model-cache",
        "HOME=/home/vllm",
        "USER=vllm",
        "LOGNAME=vllm",
      ]),
    );
    expect(args).toContain(plan.runtime.image);
    expect(dockerValues(args, "--label")).toEqual(
      expect.arrayContaining([
        `${DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL}=${DUAL_STATION_VLLM_LAUNCH_SCHEMA}`,
        `${DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL}=${dualStationVllmLaunchContract(plan, role)}`,
        `${DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL}=${API_KEY_FINGERPRINT}`,
        `${DUAL_STATION_VLLM_TRANSACTION_LABEL}=${TRANSACTION_ID}`,
      ]),
    );
    expect(args).not.toContain("--privileged");
    expect(args.join("\n")).not.toContain("--device=/dev/infiniband:");
    expect(dockerValues(args, "--env").filter((name) => name === "VLLM_API_KEY")).toEqual(
      role === "head" ? ["VLLM_API_KEY"] : [],
    );
    expect(args).not.toContain(API_KEY);
    expect(args.join("\n")).not.toMatch(/HF_TOKEN|HUGGING_FACE_HUB_TOKEN|docker run/u);
    const command = args.at(-1) ?? "";
    const imageIndex = args.indexOf(plan.runtime.image);
    expect(args.slice(imageIndex - 2, imageIndex + 2)).toEqual([
      "--entrypoint",
      "/bin/bash",
      plan.runtime.image,
      "-lc",
    ]);
    expect(args.filter((arg) => arg === "-lc")).toHaveLength(1);
    expect(imageIndex).toBe(args.length - 3);
    expect(command).toContain('python3 -m pip install --user --no-cache-dir "ray==2.56.0"');
    expect(command).toContain(
      role === "head"
        ? "ray start --head --node-ip-address=192.168.240.1 --port=6379 --num-gpus=1"
        : "ray start --address=192.168.240.1:6379 --node-ip-address=192.168.240.2 --num-gpus=1 --block",
    );
    expect(command.includes("vllm serve")).toBe(role === "head");
  });

  it.each(["head", "worker"] as const)("builds a bounded, no-pull %s GPU smoke command", (role) => {
    const nonce = "1".repeat(32);
    const { args, containerName } = buildDualStationGpuSmokeRunArgs(fixturePlan(), role, nonce);

    expect(containerName).toBe(`nemoclaw-vllm-gpu-smoke-${role}-${nonce}`);
    expect(dockerValues(args, "--gpus")).toEqual([
      `device=${role === "head" ? fixturePlan().local.gpu.uuid : fixturePlan().peer.gpu.uuid}`,
    ]);
    expect(dockerValues(args, "--network")).toEqual(["none"]);
    const expectedNode = role === "head" ? fixturePlan().local : fixturePlan().peer;
    const expectedDevices = fixturePlan().rails.map((rail) =>
      role === "head" ? rail.local.uverbsDevice : rail.peer.uverbsDevice,
    );
    expect(args).toContain("--read-only");
    expect(dockerValues(args, "--workdir")).toEqual(["/home/vllm"]);
    expect(dockerValues(args, "--user")).toEqual([
      `${String(expectedNode.uid)}:${String(expectedNode.gid)}`,
    ]);
    expect(dockerValues(args, "--security-opt")).toEqual(["no-new-privileges:true"]);
    expect(dockerValues(args, "--cap-drop")).toEqual(["ALL"]);
    expect(dockerValues(args, "--cap-add")).toEqual([]);
    expect(dockerValues(args, "--ulimit")).toEqual(["memlock=-1"]);
    expect(dockerValues(args, "--device")).toEqual(expectedDevices);
    expect(dockerValues(args, "--tmpfs")).toEqual([
      "/tmp:rw,nosuid,nodev,size=17179869184",
      `/home/vllm:rw,nosuid,nodev,noexec,uid=${String(expectedNode.uid)},gid=${String(expectedNode.gid)},mode=0700,size=68719476736`,
    ]);
    expect(dockerValues(args, "--env")).toEqual(
      expect.arrayContaining([
        "HF_HOME=/home/vllm/.cache/huggingface",
        "HOME=/home/vllm",
        "USER=vllm",
        "LOGNAME=vllm",
      ]),
    );
    expect(dockerValues(args, "--label")).toEqual(
      expect.arrayContaining([
        `${DUAL_STATION_VLLM_GPU_SMOKE_LABEL}=${nonce}`,
        `${DUAL_STATION_VLLM_ROLE_LABEL}=${role}`,
      ]),
    );
    expect(args).toContain("--pull=never");
    expect(args).toContain(DUAL_STATION_VLLM_RUNTIME.image);
    expect(args).toEqual(expect.arrayContaining(["--entrypoint", "/bin/bash"]));
    expect(args.slice(-3, -1)).toEqual([DUAL_STATION_VLLM_RUNTIME.image, "-c"]);
    const command = args.at(-1) ?? "";
    expect(command).toContain("NoNewPrivs");
    expect(command).toContain("Cap(Inh|Prm|Eff|Bnd|Amb)");
    expect(command).toContain('test "$(ulimit -l)" = "unlimited"');
    expect(command).toContain(
      `for device in ${expectedDevices.join(" ")}; do test -c "$device"; test -r "$device"; test -w "$device"; exec 3<>"$device"; exec 3>&-; done`,
    );
    expect(command).toContain("$HOME/.cache/torch/.nemoclaw-write-probe");
    expect(command).toContain("$HF_HOME/.nemoclaw-write-probe");
    expect(command).toContain("exec nvidia-smi --query-gpu=uuid --format=csv,noheader");
    expect(dockerValues(args, "--volume")).toEqual([]);
    expect(args).not.toContain("--rm");
    expect(args.join("\n")).not.toContain("VLLM_API_KEY");
  });

  it("binds the managed launch contract to both runtime owner IDs", () => {
    const baseline = fixturePlan();
    const changedUid = fixturePlan();
    const changedGid = fixturePlan();
    changedUid.local.uid += 1;
    changedGid.local.gid += 1;

    expect(dualStationVllmLaunchContract(changedUid, "head")).not.toBe(
      dualStationVllmLaunchContract(baseline, "head"),
    );
    expect(dualStationVllmLaunchContract(changedGid, "head")).not.toBe(
      dualStationVllmLaunchContract(baseline, "head"),
    );
  });

  it.each([
    ["root uid", (plan: DualStationVllmPlan) => (plan.local.uid = 0)],
    ["root gid", (plan: DualStationVllmPlan) => (plan.peer.gid = 0)],
  ])("rejects an unsafe %s runtime identity", (_label, mutate) => {
    const plan = fixturePlan();
    mutate(plan);

    expect(() =>
      buildDualStationVllmRunArgs(plan, "head", TRANSACTION_ID, API_KEY_FINGERPRINT),
    ).toThrow("runtime identity must use non-root UID and GID values");
  });

  it.each(["/dev/infiniband/rdma_cm", "/dev/infiniband/uverbs0"])(
    "rejects an unsafe or duplicate verbs character device: %s",
    (uverbsDevice) => {
      const plan = fixturePlan();
      plan.rails[1].local.uverbsDevice = uverbsDevice;

      expect(() =>
        buildDualStationVllmRunArgs(plan, "head", TRANSACTION_ID, API_KEY_FINGERPRINT),
      ).toThrow(/rails must use two distinct devices|rail endpoint is invalid/u);
    },
  );
});

describe("dual-Station managed vLLM lifecycle", () => {
  it("rejects an effective account that differs from the prepared controller", () => {
    const fake = harness();

    expect(
      preflightDualStationManagedVllm(fixturePlan(), {
        ...fake.deps,
        effectiveControllerUid: () => fixturePlan().local.uid + 1,
      }),
    ).toEqual({
      ok: false,
      reason:
        "Dual-Station lifecycle effective UID 1001 does not match prepared controller UID 1000",
    });
    expect(fake.operations).toEqual([]);
  });

  it("rejects a prepared controller account that does not own the probed local Station plan", () => {
    const fake = harness();

    expect(
      preflightDualStationManagedVllm(fixturePlan(), {
        ...fake.deps,
        effectiveControllerUid: () => fixturePlan().local.uid + 1,
        readControllerUid: () => fixturePlan().local.uid + 1,
      }),
    ).toEqual({
      ok: false,
      reason: "Dual-Station lifecycle controller UID must match probed local UID 1000",
    });
    expect(fake.operations).toEqual([]);
  });

  it("provides a read-only ownership preflight before download work", () => {
    const fake = harness();

    expect(preflightDualStationManagedVllm(fixturePlan(), fake.deps)).toEqual({ ok: true });
    expect(fake.operations.filter((operation) => operation.kind === "capture")).toHaveLength(2);
    expect(fake.operations.some((operation) => operation.kind === "run")).toBe(false);
    expect(fake.operations.some((operation) => operation.kind === "rm")).toBe(false);
  });

  it("rejects a changed host-key pin before reading or mutating either Docker daemon", () => {
    const fake = harness();
    fs.appendFileSync(sshFixture.binding.knownHostsFile, "changed\n");

    expect(preflightDualStationManagedVllm(fixturePlan(), fake.deps)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("known-hosts binding changed"),
    });
    expect(fake.operations).toEqual([]);
    expect(fake.buildRemoteDockerEnv).not.toHaveBeenCalled();
  });

  it("proves exact-image GPU execution on both daemons and removes both exact probe IDs", async () => {
    const fake = harness();

    expect(await preflightDualStationGpuRuntime(fixturePlan(), fake.deps)).toEqual({ ok: true });
    expect(fake.operations.filter((operation) => operation.kind === "run")).toHaveLength(2);
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toEqual([
      { kind: "rm", target: "peer", value: WORKER_SMOKE_ID },
      { kind: "rm", target: "local", value: HEAD_SMOKE_ID },
    ]);
    expect(
      fake.operations.filter(
        (operation) => operation.kind === "capture" && operation.value.startsWith("image:"),
      ),
    ).toHaveLength(2);
    fake.runCalls.forEach((call) => {
      expect(call.args).toContain("--pull=never");
      expect(call.args).toContain(DUAL_STATION_VLLM_RUNTIME.image);
      expect(call.options?.env?.VLLM_API_KEY).toBeUndefined();
    });
    expect([...fake.captureOptions, ...fake.rmOptions].every((options) => options?.env?.VLLM_API_KEY === undefined)).toBe(true);
  });

  it("does not mutate either daemon unless both exact pinned images are present", async () => {
    const fake = harness({ missingImageTarget: "local" });

    expect(await preflightDualStationGpuRuntime(fixturePlan(), fake.deps)).toEqual({
      ok: false,
      reason: "head pinned vLLM image is not present or could not be inspected",
    });
    expect(fake.operations.some((operation) => operation.kind === "run")).toBe(false);
    expect(fake.operations.some((operation) => operation.kind === "rm")).toBe(false);
  });

  it("removes an exact failed GPU probe and never starts the managed containers", async () => {
    const fake = harness({ smokeGpuOutput: { peer: "GPU-not-the-discovered-device" } });

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toEqual({
      ok: false,
      reason: "worker GPU smoke did not expose exactly the discovered GPU",
      rollbackErrors: [],
    });
    expect(fake.operations.filter((operation) => operation.kind === "run")).toHaveLength(1);
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toEqual([
      { kind: "rm", target: "peer", value: WORKER_SMOKE_ID },
    ]);
  });

  it.each(["short", "A".repeat(64)])(
    "rejects an unsafe API key before probing: %s",
    async (apiKey) => {
      const fake = harness();

      expect(await startDualStationManagedVllm(fixturePlan(), { apiKey }, fake.deps)).toMatchObject(
        {
          ok: false,
          reason: expect.stringContaining("64 lowercase hexadecimal"),
        },
      );
      expect(fake.operations).toEqual([]);
    },
  );

  it("starts the worker before the head and returns validated exact IDs", async () => {
    const fake = harness();

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toEqual({
      ok: true,
      baseUrl: "http://192.168.240.1:8000",
      headContainerId: HEAD_ID,
      workerContainerId: WORKER_ID,
      reusedExisting: false,
    });
    expect(fake.operations.filter((operation) => operation.kind === "run")).toEqual([
      {
        kind: "run",
        target: "peer",
        value: `nemoclaw-vllm-gpu-smoke-worker-${"1".padStart(32, "0")}`,
      },
      {
        kind: "run",
        target: "local",
        value: `nemoclaw-vllm-gpu-smoke-head-${"2".padStart(32, "0")}`,
      },
      { kind: "run", target: "peer", value: DUAL_STATION_VLLM_WORKER_CONTAINER_NAME },
      { kind: "run", target: "local", value: DUAL_STATION_VLLM_HEAD_CONTAINER_NAME },
    ]);
    const headRun = fake.runCalls.find(
      ({ args }) => dockerValues(args, "--name")[0] === DUAL_STATION_VLLM_HEAD_CONTAINER_NAME,
    );
    expect(headRun?.options?.env?.VLLM_API_KEY).toBe(API_KEY);
    expect(headRun?.args).toContain("VLLM_API_KEY");
    expect(headRun?.args).not.toContain(API_KEY);
    fake.runCalls.filter((call) => call !== headRun).forEach((call) => {
      expect(call.options?.env?.VLLM_API_KEY).toBeUndefined();
      expect(call.args).not.toContain(API_KEY);
    });
    expect([...fake.captureOptions, ...fake.rmOptions].every((options) => options?.env?.VLLM_API_KEY === undefined)).toBe(true);
    expect(fake.buildRemoteDockerEnv).toHaveBeenCalledWith(sshFixture.binding);
  });

  it("reuses an already-running exact pair without tearing down the working service", async () => {
    const fake = harness();
    fake.seed("local", fakeContainer("head"));
    fake.seed("peer", fakeContainer("worker"));

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toEqual({
      ok: true,
      baseUrl: "http://192.168.240.1:8000",
      headContainerId: HEAD_ID,
      workerContainerId: WORKER_ID,
      reusedExisting: true,
    });
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toEqual([
      { kind: "rm", target: "peer", value: WORKER_SMOKE_ID },
      { kind: "rm", target: "local", value: HEAD_SMOKE_ID },
    ]);
  });

  it("authenticates and replaces an exact schema-2 pair instead of treating it as foreign", async () => {
    const fake = harness();
    fake.seed("local", previousSchemaContainer("head"));
    fake.seed("peer", previousSchemaContainer("worker"));

    expect(preflightDualStationManagedVllm(fixturePlan(), fake.deps)).toEqual({ ok: true });
    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toMatchObject({
      ok: true,
      reusedExisting: false,
    });
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toEqual(
      expect.arrayContaining([
        { kind: "rm", target: "local", value: HEAD_ID },
        { kind: "rm", target: "peer", value: WORKER_ID },
      ]),
    );
    expect(
      fake.containers.get(`local:${DUAL_STATION_VLLM_HEAD_CONTAINER_NAME}`)?.[0]?.labels[
        DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL
      ],
    ).toBe(DUAL_STATION_VLLM_LAUNCH_SCHEMA);
    expect(
      fake.containers.get(`peer:${DUAL_STATION_VLLM_WORKER_CONTAINER_NAME}`)?.[0]?.labels[
        DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL
      ],
    ).toBe(DUAL_STATION_VLLM_LAUNCH_SCHEMA);
  });

  it("refuses a schema-2 pair whose historical launch contract does not match", () => {
    const fake = harness();
    const head = previousSchemaContainer("head");
    head.labels[DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL] = "f".repeat(64);
    fake.seed("local", head);
    fake.seed("peer", previousSchemaContainer("worker"));

    expect(preflightDualStationManagedVllm(fixturePlan(), fake.deps)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("foreign"),
    });
    expect(fake.operations.some((operation) => operation.kind === "rm")).toBe(false);
  });

  it.each([
    [DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL, "f".repeat(64)],
    [DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL, "d".repeat(64)],
  ])("recreates an owned pair whose %s no longer matches", async (label, value) => {
    const fake = harness();
    const head = fakeContainer("head");
    const worker = fakeContainer("worker");
    head.labels[label] = value;
    worker.labels[label] = value;
    fake.seed("local", head);
    fake.seed("peer", worker);

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toMatchObject(
      {
        ok: true,
        reusedExisting: false,
      },
    );
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toEqual(
      expect.arrayContaining([
        { kind: "rm", target: "local", value: HEAD_ID },
        { kind: "rm", target: "peer", value: WORKER_ID },
      ]),
    );
  });

  it("recreates a mixed pair from different lifecycle transactions", async () => {
    const fake = harness();
    const worker = fakeContainer("worker");
    worker.labels[DUAL_STATION_VLLM_TRANSACTION_LABEL] = "f".repeat(32);
    fake.seed("local", fakeContainer("head"));
    fake.seed("peer", worker);

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toMatchObject(
      {
        ok: true,
        reusedExisting: false,
      },
    );
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toEqual(
      expect.arrayContaining([
        { kind: "rm", target: "local", value: HEAD_ID },
        { kind: "rm", target: "peer", value: WORKER_ID },
      ]),
    );
  });

  it("serializes concurrent same-plan starts so only one worker is created", async () => {
    const fake = harness();

    const results = await Promise.all([
      startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps),
      startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ ok: true, reusedExisting: false }),
      expect.objectContaining({ ok: true, reusedExisting: true }),
    ]);
    expect(
      fake.operations.filter(
        (operation) =>
          operation.kind === "run" && operation.value === DUAL_STATION_VLLM_WORKER_CONTAINER_NAME,
      ),
    ).toHaveLength(1);
    expect(fake.getMaxLifecycleLockActive()).toBe(1);
  });

  it("holds the lifecycle lease after start until validation commits", async () => {
    const fake = harness();
    let releaseValidation: () => void = () => undefined;
    let reportStarted: () => void = () => undefined;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const first = withDualStationManagedVllmLifecycle(async () => {
      const result = await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps);
      reportStarted();
      await validationGate;
      return result;
    }, fake.deps);
    await started;

    const second = startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps);
    await Promise.resolve();
    expect(
      fake.operations.filter(
        (operation) =>
          operation.kind === "run" && operation.value === DUAL_STATION_VLLM_WORKER_CONTAINER_NAME,
      ),
    ).toHaveLength(1);

    releaseValidation();
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ ok: true, reusedExisting: false }),
      expect.objectContaining({ ok: true, reusedExisting: true }),
    ]);
    expect(fake.getMaxLifecycleLockActive()).toBe(1);
  });

  it("reconciles a late worker create and rolls back only its transaction", async () => {
    const fake = harness({ lateCreateRole: "worker" });

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toEqual({
      ok: false,
      reason: "worker container failed to start",
      rollbackErrors: [],
    });
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toContainEqual({
      kind: "rm",
      target: "peer",
      value: WORKER_ID,
    });
  });

  it("never rolls back an ambiguous worker labeled by another transaction", async () => {
    const fake = harness({ failedRoleForeignTransaction: "worker" });

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toEqual({
      ok: false,
      reason: "worker container failed to start",
      rollbackErrors: [],
    });
    expect(fake.operations.filter((operation) => operation.kind === "rm")).not.toContainEqual({
      kind: "rm",
      target: "peer",
      value: WORKER_ID,
    });
    expect(fake.containers.get(`peer:${DUAL_STATION_VLLM_WORKER_CONTAINER_NAME}`)).toHaveLength(1);
  });

  it("migrates only the exact running legacy single-Station head from the rollback window", async () => {
    const fake = harness();
    seedLegacyHead(fake);
    const started = await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps);
    expect(started).toMatchObject({
      ok: true,
      reusedExisting: false,
      legacyMigration: expect.objectContaining({ legacyContainerId: LEGACY_HEAD_ID }),
    });
    const legacyMigration = requireLegacyMigration(started);
    expect(
      fake.operations.some(({ kind, value }) => kind === "rm" && value === LEGACY_HEAD_ID),
    ).toBe(false);
    await expect(
      commitDualStationLegacyMigration(fixturePlan(), legacyMigration, fake.deps),
    ).resolves.toEqual({ ok: true, cleanupWarnings: [] });
    const cutoverOrder = fake.operations
      .filter(
        ({ kind, value }) =>
          (kind === "run" &&
            (value === DUAL_STATION_VLLM_WORKER_CONTAINER_NAME ||
              value === DUAL_STATION_VLLM_HEAD_CONTAINER_NAME)) ||
          kind === "rename" ||
          ((kind === "stop" || kind === "rm") && value === LEGACY_HEAD_ID),
      )
      .map(({ kind, value }) => `${kind}:${value}`);
    expect(cutoverOrder).toEqual([
      `run:${DUAL_STATION_VLLM_WORKER_CONTAINER_NAME}`,
      expect.stringMatching(`^rename:${LEGACY_HEAD_ID}:nemoclaw-vllm-legacy-`),
      `stop:${LEGACY_HEAD_ID}`,
      `run:${DUAL_STATION_VLLM_HEAD_CONTAINER_NAME}`,
      `rm:${LEGACY_HEAD_ID}`,
    ]);
  });

  it("restores the preserved legacy head when external validation rolls back", async () => {
    const fake = harness();
    seedLegacyHead(fake);
    const started = await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps);
    const legacyMigration = requireLegacyMigration(started);

    await expect(
      rollbackDualStationLegacyMigration(fixturePlan(), legacyMigration, fake.deps),
    ).resolves.toEqual({ ok: true });
    expectRestoredLegacyHead(fake);
  });

  it("keeps the running legacy head untouched when the peer worker cannot start", async () => {
    const fake = harness({ failRole: "worker" });
    seedLegacyHead(fake);
    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toEqual({
      ok: false,
      reason: "worker container failed to start",
      rollbackErrors: [],
    });
    expectRestoredLegacyHead(fake);
    expect(fake.operations.some(({ kind }) => ["rename", "start", "stop"].includes(kind))).toBe(
      false,
    );
    expect(
      fake.operations.some(({ kind, value }) => kind === "rm" && value === LEGACY_HEAD_ID),
    ).toBe(false);
  });

  it.each([
    ["new head launch", { failRole: "head" }, "head container failed to start", false],
    [
      "final pair verification",
      { failFinalInspectionRole: "head" },
      "dual-Station containers did not remain running",
      true,
    ],
  ] as const)(
    "restores the exact legacy head after %s failure",
    async (_case, options, reason, ranHead) => {
      const fake = harness(options);
      seedLegacyHead(fake);
      expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toEqual({
        ok: false,
        reason,
        rollbackErrors: [],
      });
      expectRestoredLegacyHead(fake);
      expect(fake.operations).toEqual(
        expect.arrayContaining([
          { kind: "rm", target: "peer", value: WORKER_ID },
          { kind: "start", target: "local", value: LEGACY_HEAD_ID },
        ]),
      );
      expect(fake.operations.some(({ kind, value }) => kind === "rm" && value === HEAD_ID)).toBe(
        ranHead,
      );
      expect(
        fake.operations.some(({ kind, value }) => kind === "rm" && value === LEGACY_HEAD_ID),
      ).toBe(false);
    },
  );

  it("keeps the validated new pair when legacy backup removal is ambiguous", async () => {
    const fake = harness({ failLegacyBackupRemoval: true });
    seedLegacyHead(fake);
    const started = await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps);
    const legacyMigration = requireLegacyMigration(started);
    await expect(
      commitDualStationLegacyMigration(fixturePlan(), legacyMigration, fake.deps),
    ).resolves.toMatchObject({
      ok: true,
      cleanupWarnings: [expect.stringContaining("legacy backup")],
    });
    expect(fake.containers.get(`local:${DUAL_STATION_VLLM_HEAD_CONTAINER_NAME}`)).toEqual([
      expect.objectContaining({ id: HEAD_ID, state: "running" }),
    ]);
    expect(fake.containers.get(`peer:${DUAL_STATION_VLLM_WORKER_CONTAINER_NAME}`)).toEqual([
      expect.objectContaining({ id: WORKER_ID, state: "running" }),
    ]);
    const preservedBackup = [...fake.containers.entries()].flatMap(([containerKey, entries]) =>
      containerKey.startsWith(`local:${DUAL_STATION_VLLM_HEAD_CONTAINER_NAME}-legacy-`)
        ? entries
        : [],
    );
    expect(preservedBackup).toEqual([
      expect.objectContaining({ id: LEGACY_HEAD_ID, state: "exited" }),
    ]);
  });

  it.each([
    ["stopped", { state: "exited" }],
    [
      "outside the frozen image window",
      {
        image:
          "vllm/vllm-openai@sha256:2222222222222222222222222222222222222222222222222222222222222222",
      },
    ],
  ])("refuses a schema-less managed head that is %s", async (_case, override) => {
    const fake = harness();
    const plan = fixturePlan();
    fake.seed(
      "local",
      fakeContainer("head", {
        ...override,
        labels: { [DUAL_STATION_VLLM_MANAGED_LABEL]: "true" },
      }),
    );

    expect(await startDualStationManagedVllm(plan, START_CONFIG, fake.deps)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("foreign"),
    });
    expect(fake.operations.some((operation) => operation.kind === "rm")).toBe(false);
    expect(fake.operations.some((operation) => operation.kind === "run")).toBe(false);
  });

  it("refuses a same-image worker that belongs to another physical cluster plan", () => {
    const fake = harness();
    const unrelatedWorker = fakeContainer("worker");
    unrelatedWorker.labels[DUAL_STATION_VLLM_CLUSTER_LABEL] = "f".repeat(64);
    fake.seed("peer", unrelatedWorker);

    expect(preflightDualStationManagedVllm(fixturePlan(), fake.deps)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("foreign"),
    });
    expect(fake.operations.some((operation) => operation.kind === "rm")).toBe(false);
  });

  it("fails before mutation when an exact name has foreign ownership", async () => {
    const fake = harness();
    fake.seed(
      "local",
      fakeContainer("head", {
        labels: {
          [DUAL_STATION_VLLM_MANAGED_LABEL]: "false",
          [DUAL_STATION_VLLM_ROLE_LABEL]: "head",
          [DUAL_STATION_VLLM_ENDPOINT_LABEL]: "http://192.168.240.1:8000",
        },
      }),
    );

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toMatchObject(
      {
        ok: false,
        reason: expect.stringContaining("foreign"),
      },
    );
    expect(fake.operations.some((operation) => operation.kind === "run")).toBe(false);
    expect(fake.operations.some((operation) => operation.kind === "rm")).toBe(false);
  });

  it("rolls back the exact worker ID when the head fails", async () => {
    const fake = harness({ failRole: "head" });

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toEqual({
      ok: false,
      reason: "head container failed to start",
      rollbackErrors: [],
    });
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toEqual([
      { kind: "rm", target: "peer", value: WORKER_SMOKE_ID },
      { kind: "rm", target: "local", value: HEAD_SMOKE_ID },
      { kind: "rm", target: "peer", value: WORKER_ID },
    ]);
  });

  it("uses the real reentrant lease across an outer lifecycle and start rollback", async () => {
    const fake = harness({ failRole: "head" });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-real-lock-"));
    const withRealLock: DualStationVllmLifecycleDeps["withLifecycleLock"] = (operation) =>
      withDualStationVllmLifecycleLock(
        operation,
        {
          stateDir,
          pollIntervalMs: 5,
          timeoutMs: 250,
          corruptLockGraceMs: 5,
        },
        {
          readControllerUid: () => fixturePlan().local.uid,
          effectiveControllerUid: () => fixturePlan().local.uid,
        },
      );
    const deps = { ...fake.deps, withLifecycleLock: withRealLock };
    try {
      expect(
        await withDualStationManagedVllmLifecycle(
          () => startDualStationManagedVllm(fixturePlan(), START_CONFIG, deps),
          deps,
        ),
      ).toEqual({
        ok: false,
        reason: "head container failed to start",
        rollbackErrors: [],
      });
      expect(fake.operations.filter((operation) => operation.kind === "rm")).toContainEqual({
        kind: "rm",
        target: "peer",
        value: WORKER_ID,
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }, 2_000);

  it("rejects an invalid docker-run ID and recovers only its exact owned ID", async () => {
    const fake = harness({ invalidIdRole: "worker" });

    expect(await startDualStationManagedVllm(fixturePlan(), START_CONFIG, fake.deps)).toEqual({
      ok: false,
      reason: "worker container failed to start",
      rollbackErrors: [],
    });
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toEqual([
      { kind: "rm", target: "peer", value: WORKER_SMOKE_ID },
      { kind: "rm", target: "local", value: HEAD_SMOKE_ID },
      { kind: "rm", target: "peer", value: WORKER_ID },
    ]);
  });

  it("cleans up exact owned IDs head-first and reports both-running state", async () => {
    const fake = harness();
    fake.seed("local", fakeContainer("head"));
    fake.seed("peer", fakeContainer("worker"));

    expect(areDualStationManagedVllmContainersRunning(fixturePlan(), fake.deps)).toBe(true);
    expect(await cleanupDualStationManagedVllm(fixturePlan(), fake.deps)).toEqual({
      ok: true,
      removedContainerIds: [HEAD_ID, WORKER_ID],
    });
    expect(fake.operations.filter((operation) => operation.kind === "rm")).toEqual([
      { kind: "rm", target: "local", value: HEAD_ID },
      { kind: "rm", target: "peer", value: WORKER_ID },
    ]);
    expect(areDualStationManagedVllmContainersRunning(fixturePlan(), fake.deps)).toBe(false);
  });

  it("refuses all cleanup when either exact name is ambiguous", async () => {
    const fake = harness();
    fake.seed("local", fakeContainer("head"));
    fake.seed("local", fakeContainer("head", { id: "c".repeat(64) }));
    fake.seed("peer", fakeContainer("worker"));

    expect(await cleanupDualStationManagedVllm(fixturePlan(), fake.deps)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("ambiguous"),
    });
    expect(fake.operations.some((operation) => operation.kind === "rm")).toBe(false);
  });
});

describe("managed dual-Station base URL recovery", () => {
  it("returns only a running, owned RFC1918 head endpoint with a bounded inspect", () => {
    const fake = harness();
    fake.seed("local", fakeContainer("head"));

    expect(getDualStationManagedVllmBaseUrl(fake.deps)).toBe("http://192.168.240.1:8000");
    expect(
      fake.operations.some(
        (operation) =>
          operation.kind === "capture" &&
          operation.target === "local" &&
          operation.value === DUAL_STATION_VLLM_HEAD_CONTAINER_NAME,
      ),
    ).toBe(true);
    expect(fake.captureOptions.at(-1)).toMatchObject({ timeout: 10_000 });
    expect(fake.captureOptions.at(-1)?.env?.VLLM_API_KEY).toBeUndefined();
  });

  it("recovers the endpoint from an owned launch-schema-2 head", () => {
    const fake = harness();
    const head = fakeContainer("head");
    head.labels[DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL] = "2";
    fake.seed("local", head);

    expect(getDualStationManagedVllmBaseUrl(fake.deps)).toBe("http://192.168.240.1:8000");
  });

  it("reports a structurally managed running head before API-key fingerprint validation", () => {
    const fake = harness();
    const head = fakeContainer("head");
    head.labels[DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL] = "invalid";
    fake.seed("local", head);
    const onManagedHeadObserved = vi.fn();
    const loadApiKey = vi.fn(() => API_KEY);

    expect(
      getDualStationManagedVllmBaseUrl({
        ...fake.deps,
        onManagedHeadObserved,
        loadApiKey,
      }),
    ).toBeNull();
    expect(onManagedHeadObserved).toHaveBeenCalledOnce();
    expect(loadApiKey).not.toHaveBeenCalled();
  });

  it.each([
    ["missing persisted key", { loadApiKey: () => null }],
    ["mismatched persisted key", { loadApiKey: () => "a".repeat(64) }],
    ["endpoint absent from local interfaces", { localInterfaceAddresses: () => [] }],
  ])("rejects day-2 recovery with %s", (_case, overrides) => {
    const fake = harness();
    fake.seed("local", fakeContainer("head"));

    expect(getDualStationManagedVllmBaseUrl({ ...fake.deps, ...overrides })).toBeNull();
  });

  it.each(["http://8.8.8.8:8000", "http://0.0.0.0:8000", "http://192.168.240.1:8000/"])(
    "rejects unsafe or non-canonical endpoint label %s",
    (endpoint) => {
      const fake = harness();
      fake.seed(
        "local",
        fakeContainer("head", {
          labels: {
            [DUAL_STATION_VLLM_MANAGED_LABEL]: "true",
            [DUAL_STATION_VLLM_ROLE_LABEL]: "head",
            [DUAL_STATION_VLLM_ENDPOINT_LABEL]: endpoint,
          },
        }),
      );

      expect(getDualStationManagedVllmBaseUrl(fake.deps)).toBeNull();
    },
  );

  it("rejects an owned-looking head that does not use the pinned runtime image", () => {
    const fake = harness();
    const onManagedHeadObserved = vi.fn();
    fake.seed(
      "local",
      fakeContainer("head", {
        image:
          "nvcr.io/nvidia/vllm:forged@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    );

    expect(getDualStationManagedVllmBaseUrl({ ...fake.deps, onManagedHeadObserved })).toBeNull();
    expect(onManagedHeadObserved).not.toHaveBeenCalled();
  });
});
