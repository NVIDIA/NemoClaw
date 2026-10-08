// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeConfigFile } from "../../state/config-io";
import { resolveGatewayStateDirForPort } from "./state-dir";

const MAX_BINDING_BYTES = 256 * 1024;
const NETWORK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

export type DockerDriverGatewayBinding = {
  stateDir: string;
  dockerNetworkName: string;
};

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function bindingsPath(home: string, port: number): string {
  return path.join(home, ".local", "state", "nemoclaw", "gateway-runtime-bindings", `${port}.json`);
}

function validBinding(value: unknown): value is DockerDriverGatewayBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Partial<DockerDriverGatewayBinding>;
  return (
    typeof binding.stateDir === "string" &&
    path.isAbsolute(binding.stateDir) &&
    !/[\0\r\n]/u.test(binding.stateDir) &&
    typeof binding.dockerNetworkName === "string" &&
    NETWORK_NAME_PATTERN.test(binding.dockerNetworkName)
  );
}

/** Read the same private file that was validated, without following a receipt symlink. */
export function readDockerDriverGatewayBinding(
  home: string = os.homedir(),
  gatewayPort: number,
): DockerDriverGatewayBinding | null {
  if (!validPort(gatewayPort) || typeof fs.constants.O_NOFOLLOW !== "number") return null;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      bindingsPath(home, gatewayPort),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      typeof process.getuid !== "function" ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > MAX_BINDING_BYTES
    )
      return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (!validBinding(parsed)) return null;
    const stateDir = resolveGatewayStateDirForPort({
      configured: parsed.stateDir,
      home,
      port: gatewayPort,
    });
    return { stateDir, dockerNetworkName: parsed.dockerNetworkName };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** Use one receipt per port so another gateway cannot overwrite this binding. */
export function writeDockerDriverGatewayBinding(
  home: string = os.homedir(),
  gatewayPort: number,
  binding: DockerDriverGatewayBinding,
): void {
  if (!validPort(gatewayPort) || !validBinding(binding)) {
    throw new Error("Invalid Docker-driver gateway binding");
  }
  writeConfigFile(bindingsPath(home, gatewayPort), {
    stateDir: path.resolve(binding.stateDir),
    dockerNetworkName: binding.dockerNetworkName,
  });
}

/** Resolve recovery inputs without turning restored values into process-wide overrides. */
export function resolveDockerDriverGatewayBinding(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  gatewayPort: number,
): Partial<DockerDriverGatewayBinding> {
  const saved = readDockerDriverGatewayBinding(home, gatewayPort);
  return {
    stateDir: env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR || saved?.stateDir,
    dockerNetworkName: env.OPENSHELL_DOCKER_NETWORK_NAME || saved?.dockerNetworkName,
  };
}
