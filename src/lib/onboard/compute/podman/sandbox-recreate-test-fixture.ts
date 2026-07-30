// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parsePodmanManagedSandboxInspect } from "./sandbox-recreate-spec";

export const OLD_ID = "a".repeat(64);
export const NEW_ID = "b".repeat(64);
export const BACKUP_ID = "6".repeat(64);
export const RESTORED_ID = "7".repeat(64);
export const ROOT_IMAGE_ID = "c".repeat(64);
export const SUPERVISOR_IMAGE_ID = "d".repeat(64);
export const SECRET_ID = "e".repeat(64);
export const NETWORK_ID = "f".repeat(64);
export const SOCKET_PATH = "/run/user/1000/podman/podman.sock";
export const SOCKET_AUTHORITY = {
  directoryChain: [
    {
      device: "8",
      inode: "7000",
      mode: "448",
      ownerUid: "1000",
      path: "/run/user/1000/podman",
    },
  ],
  device: "8",
  inode: "9001",
  ownerUid: "1000",
  socketPath: SOCKET_PATH,
} as const;
export const SANDBOX_NAME = "alpha";
export const CONTAINER_NAME = "openshell-sandbox-alpha";
export const SUPERVISOR_IMAGE = "ghcr.io/nvidia/openshell/supervisor:0.0.85";

export function validInspect(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const value: Record<string, unknown> = {
    Id: OLD_ID,
    Image: ROOT_IMAGE_ID,
    Name: CONTAINER_NAME,
    State: { Running: true },
    Pod: "",
    Dependencies: [],
    IsInfra: false,
    IsService: false,
    Config: {
      Hostname: "sandbox-alpha",
      User: "0:0",
      Tty: false,
      OpenStdin: false,
      Env: [
        "OPENSHELL_SANDBOX=alpha",
        "OPENSHELL_SANDBOX_COMMAND=sleep infinity",
        "OPENSHELL_SANDBOX_TOKEN_FILE=/etc/openshell/auth/sandbox.jwt",
        "OPENSHELL_TLS_CA=/etc/openshell/tls/client/ca.crt",
        "OPENSHELL_TLS_CERT=/etc/openshell/tls/client/tls.crt",
        "OPENSHELL_TLS_KEY=/etc/openshell/tls/client/tls.key",
        "USER_VALUE=preserved",
      ],
      Cmd: ["--operator-mode"],
      Image: "sandbox-image:mutable",
      WorkingDir: "/sandbox",
      Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
      Labels: {
        "custom.label": "preserved",
        "openshell.managed": "true",
        "openshell.sandbox-id": "sandbox-id",
        "openshell.sandbox-name": SANDBOX_NAME,
        "openshell.sandbox-namespace": "",
      },
      StopSignal: "SIGTERM",
      StartupHealthCheck: null,
      Healthcheck: {
        Test: ["CMD", "/opt/openshell/bin/openshell-sandbox", "__healthcheck"],
        Interval: 5_000_000_000,
        Timeout: 2_000_000_000,
        Retries: 10,
        StartPeriod: 5_000_000_000,
      },
      HealthcheckOnFailureAction: "none",
      HealthLogDestination: "local",
      HealthcheckMaxLogCount: 5,
      HealthcheckMaxLogSize: 500,
      Secrets: [
        {
          Name: "openshell-token-sandbox-id",
          ID: SECRET_ID,
          UID: 0,
          GID: 0,
          Mode: 0o400,
        },
      ],
      StopTimeout: 10,
      Umask: "0022",
      ChrootDirs: [],
    },
    HostConfig: {
      Binds: [],
      NetworkMode: "bridge",
      PortBindings: {
        "22/tcp": [{ HostIp: "", HostPort: "0" }],
      },
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      AutoRemove: false,
      AutoRemoveImage: false,
      PublishAllPorts: false,
      VolumesFrom: [],
      CapAdd: ["CAP_SYS_ADMIN", "CAP_NET_ADMIN"],
      CapDrop: ["CAP_KILL", "CAP_NET_RAW"],
      Dns: ["10.0.0.2"],
      DnsOptions: ["ndots:1"],
      DnsSearch: ["example.test"],
      ExtraHosts: ["host.containers.internal:host-gateway", "host.openshell.internal:host-gateway"],
      GroupAdd: ["44"],
      IpcMode: "shareable",
      CgroupMode: "private",
      Cgroups: "default",
      OomScoreAdj: 0,
      PidMode: "private",
      Privileged: false,
      ReadonlyRootfs: false,
      SecurityOpt: ["no-new-privileges", "seccomp=unconfined"],
      Tmpfs: { "/run/netns": "rw,nosuid,nodev" },
      UTSMode: "private",
      UsernsMode: "host",
      ShmSize: 67_108_864,
      CpuShares: 0,
      Memory: 4_294_967_296,
      NanoCpus: 2_000_000_000,
      CpuPeriod: 100_000,
      CpuQuota: 200_000,
      CpuRealtimePeriod: 0,
      CpuRealtimeRuntime: 0,
      CpusetCpus: "",
      CpusetMems: "",
      Devices: [],
      KernelMemory: 0,
      MemoryReservation: 0,
      MemorySwap: 0,
      MemorySwappiness: 0,
      OomKillDisable: false,
      Init: false,
      PidsLimit: 256,
      Ulimits: [{ Name: "RLIMIT_NOFILE", Soft: 1024, Hard: 4096 }],
      CgroupConf: {},
      BlkioWeight: 0,
      BlkioWeightDevice: [],
      BlkioDeviceReadBps: [],
      BlkioDeviceWriteBps: [],
      BlkioDeviceReadIOps: [],
      BlkioDeviceWriteIOps: [],
    },
    Mounts: [
      {
        Type: "volume",
        Name: "openshell-sandbox-sandbox-id-workspace",
        Source: "/home/user/.local/share/containers/storage/volumes/workspace/_data",
        Destination: "/sandbox",
        Driver: "local",
        Mode: "",
        Options: [],
        RW: true,
        Propagation: "",
      },
      {
        Type: "image",
        Source: SUPERVISOR_IMAGE,
        Destination: "/opt/openshell/bin",
        Driver: "",
        Mode: "",
        Options: [],
        RW: false,
        Propagation: "",
      },
      ...[
        ["ca.crt", "/etc/openshell/tls/client/ca.crt"],
        ["tls.crt", "/etc/openshell/tls/client/tls.crt"],
        ["tls.key", "/etc/openshell/tls/client/tls.key"],
      ].map(([file, destination]) => ({
        Type: "bind",
        Name: "",
        Source: `/run/openshell/tls/${file}`,
        Destination: destination,
        Driver: "",
        Mode: "",
        Options: ["rbind"],
        RW: false,
        Propagation: "rprivate",
      })),
    ],
    NetworkSettings: {
      Ports: {
        "22/tcp": [{ HostIp: "127.0.0.1", HostPort: "41022" }],
      },
      Networks: {
        openshell: {
          Aliases: [OLD_ID, OLD_ID.slice(0, 12), CONTAINER_NAME],
          DriverOpts: {},
          IPAMConfig: {},
          Links: [],
          NetworkID: NETWORK_ID,
          IPAddress: "10.89.0.5",
          MacAddress: "02:42:ac:11:00:02",
        },
      },
    },
  };
  return { ...value, ...overrides };
}

export function parsedInspect(raw = validInspect()) {
  return parsePodmanManagedSandboxInspect(JSON.stringify([raw]), {
    containerId: String(raw.Id),
    name: String(raw.Name),
    requireRunning: true,
    sandboxName: SANDBOX_NAME,
  });
}
