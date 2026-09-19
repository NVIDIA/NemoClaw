// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BINDINGS_DIR_NAME = "nemoclaw";
const BINDINGS_FILE_NAME = "gateway-runtime-bindings.json";
const MAX_BINDINGS_BYTES = 256 * 1024;
const NETWORK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

export type DockerDriverGatewayBinding = {
  stateDir: string;
  dockerNetworkName: string;
};

type BindingDocument = Record<string, DockerDriverGatewayBinding>;

function bindingsPath(home: string): string {
  return path.join(home, ".local", "state", BINDINGS_DIR_NAME, BINDINGS_FILE_NAME);
}

function isTrustedPrivateFile(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.uid === (typeof process.getuid === "function" ? process.getuid() : stat.uid) &&
      (stat.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
}

function validBinding(value: unknown): value is DockerDriverGatewayBinding {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as DockerDriverGatewayBinding).stateDir === "string" &&
    path.isAbsolute((value as DockerDriverGatewayBinding).stateDir) &&
    typeof (value as DockerDriverGatewayBinding).dockerNetworkName === "string" &&
    NETWORK_NAME_PATTERN.test((value as DockerDriverGatewayBinding).dockerNetworkName)
  );
}

function readDocument(home: string): BindingDocument {
  const filePath = bindingsPath(home);
  if (!isTrustedPrivateFile(filePath)) return {};
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_BINDINGS_BYTES) return {};
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: BindingDocument = {};
    for (const [port, value] of Object.entries(parsed)) {
      if (/^\d{1,5}$/u.test(port) && validBinding(value)) result[port] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/** Read the last known Docker network/state binding without trusting malformed state. */
export function readDockerDriverGatewayBinding(
  home: string = os.homedir(),
  gatewayPort: number,
): DockerDriverGatewayBinding | null {
  const binding = readDocument(home)[String(gatewayPort)];
  return binding ? { ...binding } : null;
}

/** Persist only non-secret gateway identity needed to recreate a custom network after reboot. */
export function writeDockerDriverGatewayBinding(
  home: string = os.homedir(),
  gatewayPort: number,
  binding: DockerDriverGatewayBinding,
): void {
  if (
    !Number.isInteger(gatewayPort) ||
    gatewayPort < 1 ||
    gatewayPort > 65535 ||
    !validBinding(binding)
  ) {
    throw new Error("Invalid Docker-driver gateway binding");
  }
  const filePath = bindingsPath(home);
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const document = readDocument(home);
  document[String(gatewayPort)] = { ...binding, stateDir: path.resolve(binding.stateDir) };
  const temporary = `${filePath}.${process.pid}.tmp`;
  const payload = `${JSON.stringify(document, null, 2)}\n`;
  const fd = fs.openSync(
    temporary,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

/** Apply a persisted binding only when the operator did not provide an explicit override. */
export function restoreDockerDriverGatewayBinding(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  gatewayPort: number,
): DockerDriverGatewayBinding | null {
  const binding = readDockerDriverGatewayBinding(home, gatewayPort);
  if (!binding) return null;
  if (!env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR) {
    env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR = binding.stateDir;
  }
  if (!env.OPENSHELL_DOCKER_NETWORK_NAME) {
    env.OPENSHELL_DOCKER_NETWORK_NAME = binding.dockerNetworkName;
  }
  return binding;
}

export function isValidDockerNetworkName(value: string): boolean {
  return NETWORK_NAME_PATTERN.test(value);
}
