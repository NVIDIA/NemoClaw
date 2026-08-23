// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import type { ContainerEngine } from "../../adapters/container-engine";
import {
  buildLlamaCppRequestGuardCommandArgv,
  LLAMA_CPP_HOST_LOCAL_REQUEST_GUARD_PATH,
} from "../../inference/llama-cpp/host-local-runtime";
import {
  contract,
  IMAGE,
  invariant,
  MODEL_FILENAME,
  NETWORK_ID,
  RUNTIME_ID,
  TRANSACTION_ID,
} from "./docker-llama-cpp-managed-lifecycle.test-support";
import type { HostLocalCreateJournalRecord } from "./host-local-create-journal";

export interface DockerFixture {
  readonly engine: ContainerEngine;
  readonly capture: ReturnType<typeof vi.fn>;
  readonly setNetworkId: (value: string) => void;
  readonly setNetworkTransactionId: (value: string) => void;
  readonly removeNetwork: () => void;
  readonly failNetworkCreateUncertain: (networkAppears: boolean) => void;
  readonly setCreateStdout: (value: string) => void;
  readonly failCreateUncertain: () => void;
  readonly failProbe: () => void;
  readonly failSandboxBridgeProbe: (result: {
    readonly status: number;
    readonly stderr?: string;
  }) => void;
  readonly setOpenShellBridgeSubnet: (value: string) => void;
  readonly driftHardening: () => void;
  readonly driftEntrypoint: () => void;
  readonly dropTmpfs: () => void;
  readonly driftGpuRequest: (driver: string | undefined, count: number) => void;
  readonly driftExtraDeviceAuthority: (kind: "cap-add" | "legacy-device") => void;
  readonly failInspectWithDaemonError: () => void;
  readonly setAbsentNetworkInspectError: (value: string) => void;
  readonly onAbsentInspect: (callback: () => void) => void;
  readonly onAbsentNetworkInspect: (callback: () => void) => void;
  readonly onNetworkCreate: (callback: () => void) => void;
  readonly onStart: (callback: () => void) => void;
  readonly onProbe: (callback: () => void) => void;
  readonly onCreate: (callback: () => void) => void;
  readonly setContainerState: (running: boolean, status: string) => void;
  readonly seedNetwork: (journal: HostLocalCreateJournalRecord) => void;
  readonly seed: (journal: HostLocalCreateJournalRecord, running: boolean) => void;
}

interface DockerFixturePaths {
  readonly apiKeyPath: string;
  readonly modelPath: string;
  readonly networkName: string;
}

export function createDockerFixture(
  paths: DockerFixturePaths,
  configuredHostPort = "",
  publishedHostPort?: string,
  publishedHostIp = "127.0.0.1",
  publishedBindingCount = 0,
): DockerFixture {
  const effectivePublishedHostPort = publishedHostPort ?? (configuredHostPort || "49152");
  let networkId = NETWORK_ID;
  let networkPresent = false;
  let networkTransactionId = TRANSACTION_ID;
  let networkCreateUncertain = false;
  let uncertainNetworkAppears = false;
  let createStdout = `${RUNTIME_ID}\n`;
  let createUncertain = false;
  let probeFails = false;
  let sandboxBridgeProbeFailure: {
    readonly status: number;
    readonly stderr?: string;
  } | null = null;
  let openShellBridgeSubnet = "172.29.0.0/16";
  let hardeningDrift = false;
  let tmpfs: Record<string, string> | null = {
    "/tmp": "rw,noexec,nosuid,nodev,size=1024,uid=1001,gid=1001,mode=1777",
  };
  let gpuDriver: string | undefined = "nvidia";
  let gpuCount = 1;
  let capAdd: null | string[] = null;
  let legacyDevices: null | object[] = null;
  let inspectDaemonError = false;
  let absentNetworkInspectError: string | null = null;
  let absentInspectHook: (() => void) | undefined;
  let absentNetworkInspectHook: (() => void) | undefined;
  let networkCreateHook: (() => void) | undefined;
  let startHook: (() => void) | undefined;
  let probeHook: (() => void) | undefined;
  let createHook: (() => void) | undefined;
  let startedOnce = false;
  let container:
    | {
        labels: Record<string, string>;
        running: boolean;
        status: string;
        transactionId: string;
        command: string[];
        entrypoint: string[];
      }
    | undefined;
  const inspection = () => [
    {
      Id: RUNTIME_ID,
      Name: "/nemoclaw-llama-cpp",
      Config: {
        Image: IMAGE,
        User: "1001:1001",
        Entrypoint: container?.entrypoint ?? [],
        Cmd: container?.command ?? [],
        Labels: container?.labels ?? {},
      },
      HostConfig: {
        NetworkMode: paths.networkName,
        RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
        PortBindings: configuredHostPort
          ? { "8081/tcp": [{ HostIp: "127.0.0.1", HostPort: configuredHostPort }] }
          : {},
        ReadonlyRootfs: !hardeningDrift,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: 51_539_607_552,
        MemorySwap: 51_539_607_552,
        PidsLimit: 256,
        DeviceRequests: [
          {
            ...(gpuDriver === undefined ? {} : { Driver: gpuDriver }),
            Count: gpuCount,
            DeviceIDs: null,
            Capabilities: [["gpu"]],
            Options: {},
          },
        ],
        CapAdd: capAdd,
        Devices: legacyDevices,
        Privileged: false,
        Tmpfs: tmpfs,
      },
      State: {
        Running: container?.running ?? false,
        Status: container?.status ?? "created",
      },
      NetworkSettings: {
        Networks: {
          [paths.networkName]: {
            NetworkID: startedOnce ? networkId : "",
            IPAddress: container?.running ? "172.30.0.2" : "",
          },
        },
        Ports: {
          "8081/tcp":
            startedOnce && publishedBindingCount > 0
              ? Array.from({ length: publishedBindingCount }, () => ({
                  HostIp: publishedHostIp,
                  HostPort: effectivePublishedHostPort,
                }))
              : null,
        },
      },
      Mounts: [
        {
          Type: "bind",
          Source: paths.modelPath,
          Destination: `/models/${MODEL_FILENAME}`,
          RW: false,
        },
        {
          Type: "bind",
          Source: paths.apiKeyPath,
          Destination: "/run/secrets/llama-cpp-api-key",
          RW: false,
        },
      ],
    },
  ];
  const capture = vi.fn((args: readonly string[]) => {
    const unexpected = `unexpected Docker command: ${args.join(" ")}`;
    switch (args[0]) {
      case "network":
        switch (args[1]) {
          case "inspect":
            switch (args[2]) {
              case "openshell-docker":
                return {
                  status: 0,
                  stdout: JSON.stringify([
                    {
                      Name: "openshell-docker",
                      Internal: false,
                      Driver: "bridge",
                      Scope: "local",
                      IPAM: {
                        Config: [{ Subnet: openShellBridgeSubnet, Gateway: "172.29.0.1" }],
                      },
                    },
                  ]),
                  stderr: "",
                };
            }
            switch (networkPresent) {
              case false:
                absentNetworkInspectHook?.();
            }
            return networkPresent
              ? {
                  status: 0,
                  stdout: JSON.stringify([
                    {
                      Id: networkId,
                      Name: args[2],
                      Internal: true,
                      Driver: "bridge",
                      Scope: "local",
                      Labels: {
                        "io.nvidia.nemoclaw.llama-cpp-owner": "gateway.primary",
                        "io.nvidia.nemoclaw.host-local-inference.network-transaction-sha256":
                          networkTransactionId,
                      },
                    },
                  ]),
                  stderr: "",
                }
              : {
                  status: 1,
                  stdout: "",
                  stderr:
                    absentNetworkInspectError ??
                    `Error response from daemon: No such network: ${String(args[2])}`,
                };
          case "create": {
            networkCreateHook?.();
            const labelIndex = args.lastIndexOf("--label");
            networkTransactionId = String(args[labelIndex + 1]).split("=")[1] ?? "";
            networkPresent = !networkCreateUncertain || uncertainNetworkAppears;
            switch (networkCreateUncertain) {
              case true:
                return {
                  status: 1,
                  stdout: "",
                  stderr: "",
                  error: new Error("Docker network create capture timed out"),
                };
            }
            return { status: 0, stdout: `${networkId}\n`, stderr: "" };
          }
          case "rm":
            invariant(args[2] === networkId, unexpected);
            networkPresent = false;
            return { status: 0, stdout: `${networkId}\n`, stderr: "" };
          default:
            throw new Error(unexpected);
        }
      case "container": {
        invariant(args[1] === "inspect", unexpected);
        switch (inspectDaemonError) {
          case true:
            return { status: 1, stdout: "", stderr: "daemon unavailable" };
        }
        const target = args[2];
        switch (Boolean(container && (target === RUNTIME_ID || target === "nemoclaw-llama-cpp"))) {
          case true:
            return { status: 0, stdout: JSON.stringify(inspection()), stderr: "" };
        }
        absentInspectHook?.();
        return {
          status: 1,
          stdout: "",
          stderr: `Error response from daemon: No such container: ${String(target)}`,
        };
      }
      case "create": {
        switch (createUncertain) {
          case true:
            return {
              status: 1,
              stdout: "",
              stderr: "",
              error: new Error("Docker create capture timed out"),
            };
        }
        const labels = Object.fromEntries(
          args
            .flatMap((argument, index) =>
              argument === "--label" ? [String(args[index + 1]).split("=")] : [],
            )
            .filter(([name, value]) => Boolean(name && value)),
        );
        container = {
          labels,
          running: false,
          status: "created",
          transactionId: labels["io.nvidia.nemoclaw.host-local-inference.transaction-sha256"] ?? "",
          command: args.slice(args.indexOf(IMAGE) + 1),
          entrypoint: [String(args[args.indexOf("--entrypoint") + 1] ?? "")],
        };
        createHook?.();
        return { status: 0, stdout: createStdout, stderr: "" };
      }
      case "start":
        startHook?.();
        switch (container) {
          case undefined:
            break;
          default:
            startedOnce = true;
            container.running = true;
            container.status = "running";
        }
        return { status: 0, stdout: `${RUNTIME_ID}\n`, stderr: "" };
      case "stop":
        switch (container) {
          case undefined:
            break;
          default:
            container.running = false;
            container.status = "exited";
        }
        return { status: 0, stdout: RUNTIME_ID, stderr: "" };
      case "rm":
        invariant(args[1] === "--force", unexpected);
        container = undefined;
        return { status: 0, stdout: RUNTIME_ID, stderr: "" };
      case "run":
        invariant(args[1] === "--rm", unexpected);
        probeHook?.();
        if (
          sandboxBridgeProbeFailure !== null &&
          args[args.indexOf("--network") + 1] === "openshell-docker"
        ) {
          return {
            ...sandboxBridgeProbeFailure,
            stdout: "",
            stderr: sandboxBridgeProbeFailure.stderr ?? "",
          };
        }
        return probeFails
          ? { status: 1, stdout: "", stderr: "not ready" }
          : { status: 0, stdout: "ok", stderr: "" };
      default:
        throw new Error(unexpected);
    }
  });
  return {
    engine: {
      operation: "host-local-inference",
      engineId: "docker",
      displayName: "Docker",
      authorityId: "docker:local",
      capture,
      captureHost: capture,
    },
    capture,
    setNetworkId: (value) => (networkId = value),
    setNetworkTransactionId: (value) => (networkTransactionId = value),
    removeNetwork: () => (networkPresent = false),
    failNetworkCreateUncertain: (networkAppears) => {
      networkCreateUncertain = true;
      uncertainNetworkAppears = networkAppears;
    },
    setCreateStdout: (value) => (createStdout = value),
    failCreateUncertain: () => (createUncertain = true),
    failProbe: () => (probeFails = true),
    failSandboxBridgeProbe: (result) => (sandboxBridgeProbeFailure = result),
    setOpenShellBridgeSubnet: (value) => (openShellBridgeSubnet = value),
    driftHardening: () => (hardeningDrift = true),
    driftEntrypoint: () => {
      invariant(container !== undefined, "cannot drift an absent fixture container");
      container.entrypoint = ["/usr/local/bin/llama-server"];
    },
    dropTmpfs: () => (tmpfs = null),
    driftGpuRequest: (driver, count) => {
      gpuDriver = driver;
      gpuCount = count;
    },
    driftExtraDeviceAuthority: (kind) => {
      kind === "cap-add"
        ? (capAdd = ["SYS_ADMIN"])
        : (legacyDevices = [{ PathOnHost: "/dev/nvidia0" }]);
    },
    failInspectWithDaemonError: () => (inspectDaemonError = true),
    setAbsentNetworkInspectError: (value) => (absentNetworkInspectError = value),
    onAbsentInspect: (callback) => (absentInspectHook = callback),
    onAbsentNetworkInspect: (callback) => (absentNetworkInspectHook = callback),
    onNetworkCreate: (callback) => (networkCreateHook = callback),
    onStart: (callback) => (startHook = callback),
    onProbe: (callback) => (probeHook = callback),
    onCreate: (callback) => (createHook = callback),
    setContainerState: (running, status) => {
      invariant(container !== undefined, "cannot change an absent fixture container");
      container.running = running;
      container.status = status;
    },
    seedNetwork: (journal) => {
      invariant(journal.networkId !== null, "seeded network identity is missing");
      networkId = journal.networkId;
      networkTransactionId = journal.transactionId;
      networkPresent = true;
    },
    seed: (journal, running) => {
      invariant(journal.networkId !== null, "seeded network identity is missing");
      networkId = journal.networkId;
      networkTransactionId = journal.transactionId;
      networkPresent = true;
      startedOnce = journal.phase !== "creating" && journal.phase !== "created";
      container = {
        labels: {
          "io.nvidia.nemoclaw.host-local-inference.managed": "true",
          "io.nvidia.nemoclaw.host-local-inference.provider": "docker",
          "io.nvidia.nemoclaw.host-local-inference.service": "llama-cpp",
          "io.nvidia.nemoclaw.host-local-inference.spec-sha256": journal.specSha256,
          "io.nvidia.nemoclaw.host-local-inference.transaction-sha256": journal.transactionId,
          "io.nvidia.nemoclaw.llama-cpp-owner": "gateway.primary",
        },
        running,
        status: running ? "running" : "created",
        transactionId: journal.transactionId,
        command: [...buildLlamaCppRequestGuardCommandArgv(contract())],
        entrypoint: [LLAMA_CPP_HOST_LOCAL_REQUEST_GUARD_PATH],
      };
    },
  };
}
