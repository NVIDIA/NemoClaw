// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function writeFakeOpenshell(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o755,
  });
}

function runNodeScript(script, extraEnv = {}) {
  const repoRoot = path.join(import.meta.dirname, "..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-bind-"));
  const fakeBin = path.join(tmpDir, "bin");
  const scriptPath = path.join(tmpDir, "script.js");
  writeFakeOpenshell(fakeBin);
  fs.writeFileSync(scriptPath, script);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      ...extraEnv,
    },
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

describe("gateway loopback binding hardening", () => {
  it("rebinds a localhost gateway container to 127.0.0.1 during recovery", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const inspectPayload = JSON.stringify({
      Name: "/openshell-cluster-nemoclaw",
      Config: {
        Image: "ghcr.io/nvidia/openshell/cluster:0.0.23",
        Hostname: "openshell-nemoclaw",
        Env: [
          "OPENSHELL_NODE_NAME=openshell-nemoclaw",
          "IMAGE_TAG=0.0.23",
          "REGISTRY_MODE=external",
        ],
        Cmd: ["server", "--disable=traefik", "--tls-san=127.0.0.1"],
        Entrypoint: ["/usr/local/bin/cluster-entrypoint.sh"],
      },
      HostConfig: {
        NetworkMode: "openshell-cluster-nemoclaw",
        PortBindings: {
          "30051/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }],
        },
        RestartPolicy: { Name: "unless-stopped" },
        Privileged: true,
        SecurityOpt: ["label=disable"],
        ExtraHosts: ["host.docker.internal:host-gateway"],
        Binds: ["openshell-cluster-nemoclaw:/var/lib/rancher/k3s"],
      },
    });

    const script = String.raw`
const runner = require(${runnerPath});
const commands = [];

runner.runCapture = (command) => {
  if (command.includes("'status'")) {
    return "Server Status\n\n  Gateway: nemoclaw\n  Server: https://127.0.0.1:8080\n  Status: Connected";
  }
  if (command.includes("'gateway' 'info' '-g' 'nemoclaw'")) {
    return "Gateway Info\n\n  Gateway: nemoclaw\n  Gateway endpoint: https://127.0.0.1:8080";
  }
  if (command.includes("'gateway' 'info'")) {
    return "Gateway Info\n\n  Gateway: nemoclaw\n  Gateway endpoint: https://127.0.0.1:8080";
  }
  if (command.includes("docker inspect") && command.includes("{{json .}}")) {
    return ${inspectPayload};
  }
  if (command.includes("docker inspect") && command.includes("State.Health")) {
    return "healthy";
  }
  return "";
};
runner.run = (command) => {
  commands.push(command);
  return { status: 0 };
};

const { startGatewayForRecovery } = require(${onboardPath});

(async () => {
  await startGatewayForRecovery();
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

    const result = runNodeScript(script);
    expect(result.status).toBe(0);
    const commands = JSON.parse(result.stdout.trim().split("\n").pop());
    expect(
      commands.some((entry) => entry.includes("'docker' 'stop' 'openshell-cluster-nemoclaw'")),
    ).toBe(true);
    expect(
      commands.some((entry) => entry.includes("'docker' 'rm' 'openshell-cluster-nemoclaw'")),
    ).toBe(true);
    expect(
      commands.some(
        (entry) =>
          entry.includes("'docker' 'run'") &&
          entry.includes("'-p' '127.0.0.1:8080:30051/tcp'") &&
          entry.includes("'ghcr.io/nvidia/openshell/cluster:0.0.23'"),
      ),
    ).toBe(true);
  });

  it("skips the rebind when the gateway endpoint is not loopback", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const inspectPayload = JSON.stringify({
      Name: "/openshell-cluster-nemoclaw",
      Config: {
        Image: "ghcr.io/nvidia/openshell/cluster:0.0.23",
      },
      HostConfig: {
        PortBindings: {
          "30051/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }],
        },
      },
    });

    const script = String.raw`
const runner = require(${runnerPath});
const commands = [];

runner.runCapture = (command) => {
  if (command.includes("docker inspect") && command.includes("{{json .}}")) {
    return ${inspectPayload};
  }
  return "";
};
runner.run = (command) => {
  commands.push(command);
  return { status: 0 };
};

const { enforceLoopbackGatewayBinding } = require(${onboardPath});
const repaired = enforceLoopbackGatewayBinding(
  "nemoclaw",
  "Gateway Info\n\n  Gateway: nemoclaw\n  Gateway endpoint: https://host.docker.internal:8080",
);

console.log(JSON.stringify({ repaired, commands }));
`;

    const result = runNodeScript(script);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop());
    expect(payload.repaired).toBe(false);
    expect(payload.commands).toEqual([]);
  });
});
