// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { buildPodmanDriverGatewayEnv } from "./compute/podman/gateway-env";
import {
  DOCKER_DRIVER_GATEWAY_CONFIG_NAME,
  MANAGED_GATEWAY_RUNTIME_BINDING_NAME,
  readManagedGatewayRuntimeBinding,
  writeManagedDriverGatewayConfig,
} from "./docker-driver-gateway-config";

const directories: string[] = [];

function createPodmanBinding() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-binding-"));
  directories.push(stateDir);
  buildPodmanDriverGatewayEnv({
    gatewayPort: 8080,
    stateDir,
    podmanSocketPath: "/run/user/1000/podman/podman.sock",
    supervisorImage: "ghcr.io/nvidia/openshell/supervisor@sha256:abc",
  });
  return stateDir;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("managed gateway runtime binding", () => {
  it("persists the exact driver-native values beside the matching gateway config", () => {
    const stateDir = createPodmanBinding();
    const binding = readManagedGatewayRuntimeBinding(stateDir);

    expect(binding).toMatchObject({
      version: 1,
      driverName: "podman",
      configSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      values: {
        socket_path: "/run/user/1000/podman/podman.sock",
        network_name: "openshell",
      },
    });
    expect(Object.keys(binding?.values ?? {}).sort()).toEqual([
      "network_name",
      "socket_path",
      "supervisor_image",
    ]);
    expect(
      fs.statSync(path.join(stateDir, MANAGED_GATEWAY_RUNTIME_BINDING_NAME)).mode & 0o777,
    ).toBe(0o600);
  });

  it("persists only an adapter-owned allowlist and never copies unrelated credentials", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-allowlist-"));
    directories.push(stateDir);
    const credential = "must-not-enter-runtime-binding";
    writeManagedDriverGatewayConfig(
      stateDir,
      { OPENSHELL_LOCAL_TLS_DIR: path.join(stateDir, "tls") },
      {
        driverName: "mxc",
        entries: [
          ["endpoint", "unix:///run/mxc.sock"],
          ["access_token", credential],
        ],
        persistedRuntimeKeys: ["endpoint"],
      },
    );

    const bindingPath = path.join(stateDir, MANAGED_GATEWAY_RUNTIME_BINDING_NAME);
    const bindingText = fs.readFileSync(bindingPath, "utf8");
    expect(bindingText).not.toContain(credential);
    expect(readManagedGatewayRuntimeBinding(stateDir)).toMatchObject({
      driverName: "mxc",
      values: { endpoint: "unix:///run/mxc.sock" },
    });
  });

  it("fails closed when the sidecar no longer matches the gateway config", () => {
    const stateDir = createPodmanBinding();
    fs.appendFileSync(
      path.join(stateDir, DOCKER_DRIVER_GATEWAY_CONFIG_NAME),
      "\n# unexpected drift\n",
    );

    expect(() => readManagedGatewayRuntimeBinding(stateDir)).toThrow(
      "does not match its gateway configuration",
    );
  });

  it("rejects a symlinked runtime sidecar", () => {
    const stateDir = createPodmanBinding();
    const bindingPath = path.join(stateDir, MANAGED_GATEWAY_RUNTIME_BINDING_NAME);
    const movedPath = path.join(stateDir, "moved-runtime.json");
    fs.renameSync(bindingPath, movedPath);
    fs.symlinkSync(movedPath, bindingPath);

    expect(() => readManagedGatewayRuntimeBinding(stateDir)).toThrow(
      "failed ownership or mode checks",
    );
  });
});
