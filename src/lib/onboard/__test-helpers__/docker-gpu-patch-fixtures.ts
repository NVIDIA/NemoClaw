// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DockerContainerInspect } from "../docker-gpu-patch-types";

function openshellNetworkSettings(): NonNullable<DockerContainerInspect["NetworkSettings"]> {
  return {
    Networks: {
      "openshell-docker": {
        IPAddress: "172.18.0.2",
        Gateway: "172.18.0.1",
        Aliases: ["openshell-alpha"],
      },
    },
  };
}

export function createDockerGpuInspectFixture(): DockerContainerInspect {
  return {
    Id: "old-container-id",
    Image: `sha256:${"c".repeat(64)}`,
    Name: "/openshell-alpha",
    Config: {
      Image: "openshell/sandbox:abc",
      Env: [
        "A=1",
        "OPENSHELL_ENDPOINT=http://host.openshell.internal:8080/",
        "OPENSHELL_TEST=1",
        "OPENSHELL_SANDBOX_COMMAND=sleep infinity",
        "NVIDIA_VISIBLE_DEVICES=void",
      ],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
        "openshell.ai/sandbox-id": "sandbox-id",
      },
      Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
      Cmd: [],
      User: "0",
      WorkingDir: "/workspace",
      Hostname: "alpha-host",
      Tty: true,
    },
    HostConfig: {
      Binds: ["/host:/container:rw"],
      Mounts: [
        {
          Type: "tmpfs",
          Target: "/tmp/nemoclaw-exact-main-driver-config",
          ReadOnly: false,
          TmpfsOptions: {
            Options: [["noexec"]],
            SizeBytes: 16_777_216,
            Mode: 0o1777,
          },
        },
      ],
      NetworkMode: "openshell-docker",
      RestartPolicy: { Name: "unless-stopped" },
      CapAdd: ["SYS_ADMIN", "NET_ADMIN"],
      SecurityOpt: ["apparmor=unconfined"],
      ExtraHosts: ["host.openshell.internal:172.17.0.1"],
      Memory: 8 * 1024 * 1024 * 1024,
      NanoCpus: 2_500_000_000,
    },
    NetworkSettings: openshellNetworkSettings(),
  };
}

export function createDockerGpuDnsInspectFixture(): DockerContainerInspect {
  return {
    Id: "old-container-id",
    Name: "/openshell-alpha",
    Config: {
      Image: "openshell/sandbox:abc",
      Env: ["OPENSHELL_SANDBOX_COMMAND=sleep infinity"],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
      },
      Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
      Cmd: [],
    },
    HostConfig: {
      NetworkMode: "openshell-docker",
      RestartPolicy: { Name: "unless-stopped" },
      ExtraHosts: ["host.openshell.internal:172.17.0.1"],
    },
    NetworkSettings: openshellNetworkSettings(),
  };
}

export function createDockerGpuJetsonInspectFixture(): DockerContainerInspect {
  return {
    Id: "old-container-id",
    Name: "/openshell-alpha",
    Config: {
      Image: "openshell/sandbox:abc",
      Env: ["OPENSHELL_ENDPOINT=http://host.openshell.internal:8080/"],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
      },
      Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
      Cmd: [],
    },
    HostConfig: { NetworkMode: "openshell-docker" },
  };
}

export function createDockerGpuDiagnosticsInspectFixture(): DockerContainerInspect {
  return {
    Id: "old-container-id",
    Name: "/openshell-alpha",
    Config: {
      Image: "openshell/sandbox:abc",
      Env: ["A=1", "OPENSHELL_ENDPOINT=http://host.openshell.internal:8080/", "OPENSHELL_TEST=1"],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
      },
    },
    HostConfig: {
      NetworkMode: "openshell-docker",
      ExtraHosts: ["host.openshell.internal:172.17.0.1"],
    },
    NetworkSettings: openshellNetworkSettings(),
  };
}
