// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { ROOT } from "../../state/paths";
import { resolvePodmanRuntimeSocket } from "./runtime/podman-socket";

export { resolvePodmanRuntimeSocket };

export type CommandCapture = {
  status: number;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type DoctorHostRuntimeCheck = {
  group: "Host";
  label: string;
  status: "ok" | "warn" | "fail" | "info";
  detail: string;
  hint?: string;
};

export interface DoctorHostRuntimeAdapterInput {
  readonly driverName: string;
  readonly managedGatewayStateDirectory: string | null;
}

export interface DoctorHostRuntimeAdapterDeps {
  readonly captureHostCommand: typeof captureHostCommand;
}

export interface DoctorHostRuntimeAdapter {
  readonly driverName: string;
  inspect(
    input: DoctorHostRuntimeAdapterInput,
    deps: DoctorHostRuntimeAdapterDeps,
  ): DoctorHostRuntimeCheck;
}

export type DoctorHostRuntimeAdapterRegistry = Readonly<Record<string, DoctorHostRuntimeAdapter>>;

export function captureHostCommand(
  command: string,
  args: string[],
  timeout = 5000,
): CommandCapture {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  return {
    status: result.status ?? (result.error || result.signal ? 1 : 0),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error,
  };
}

function oneLine(value = ""): string {
  return String(value).replace(/\s+/g, " ").trim();
}

const DOCKER_DOCTOR_ADAPTER: DoctorHostRuntimeAdapter = {
  driverName: "docker",
  inspect(_input, deps) {
    const dockerInfo = deps.captureHostCommand(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      8000,
    );
    return {
      group: "Host",
      label: "Docker daemon",
      status: dockerInfo.status === 0 ? "ok" : "fail",
      detail:
        dockerInfo.status === 0
          ? `server ${dockerInfo.stdout.trim() || "unknown"}`
          : oneLine(dockerInfo.stderr || dockerInfo.error?.message || "docker info failed"),
      hint:
        dockerInfo.status === 0
          ? undefined
          : "start Docker and verify your user can access the daemon",
    };
  },
};

const PODMAN_DOCTOR_ADAPTER: DoctorHostRuntimeAdapter = {
  driverName: "podman",
  inspect(input, deps) {
    let socketPath: string;
    try {
      socketPath = resolvePodmanRuntimeSocket(input.managedGatewayStateDirectory);
    } catch (error) {
      return {
        group: "Host",
        label: "Podman service",
        status: "fail",
        detail: oneLine(error instanceof Error ? error.message : String(error)),
        hint: "restore the managed runtime binding or set an absolute OPENSHELL_PODMAN_SOCKET",
      };
    }

    const podmanInfo = deps.captureHostCommand(
      "podman",
      ["--url", `unix://${socketPath}`, "info", "--format", "json"],
      8000,
    );
    return {
      group: "Host",
      label: "Podman service",
      status: podmanInfo.status === 0 ? "ok" : "fail",
      detail:
        podmanInfo.status === 0
          ? `connected via ${socketPath}`
          : oneLine(podmanInfo.stderr || podmanInfo.error?.message || "podman info failed"),
      hint:
        podmanInfo.status === 0
          ? undefined
          : "start the rootless Podman API service and verify OPENSHELL_PODMAN_SOCKET",
    };
  },
};

export const CURRENT_DOCTOR_HOST_RUNTIME_ADAPTERS = {
  docker: DOCKER_DOCTOR_ADAPTER,
  podman: PODMAN_DOCTOR_ADAPTER,
} as const satisfies DoctorHostRuntimeAdapterRegistry;

/**
 * Resolve a doctor adapter by persisted compute-driver identity. Empty legacy
 * entries retain the historical Docker probe, while every named future driver
 * must register its own adapter and cannot inherit Docker or Podman behavior.
 */
export function resolveDoctorHostRuntimeAdapter(
  driverName: string | null | undefined,
  adapters: DoctorHostRuntimeAdapterRegistry = CURRENT_DOCTOR_HOST_RUNTIME_ADAPTERS,
): DoctorHostRuntimeAdapter | null {
  const normalized = driverName?.trim().toLowerCase() || "docker";
  const adapter = Object.hasOwn(adapters, normalized) ? adapters[normalized] : undefined;
  if (!adapter) return null;
  if (adapter.driverName !== normalized) {
    throw new Error(
      `Doctor host runtime adapter '${normalized}' does not match its registered driver identity.`,
    );
  }
  return adapter;
}

export function collectDoctorHostRuntimeCheck(
  input: {
    readonly driverName: string | null | undefined;
    readonly managedGatewayStateDirectory: string | null;
  },
  adapters: DoctorHostRuntimeAdapterRegistry = CURRENT_DOCTOR_HOST_RUNTIME_ADAPTERS,
  deps: Partial<DoctorHostRuntimeAdapterDeps> = {},
): DoctorHostRuntimeCheck | null {
  const adapter = resolveDoctorHostRuntimeAdapter(input.driverName, adapters);
  if (!adapter) return null;
  return adapter.inspect(
    {
      driverName: adapter.driverName,
      managedGatewayStateDirectory: input.managedGatewayStateDirectory,
    },
    {
      captureHostCommand: deps.captureHostCommand ?? captureHostCommand,
    },
  );
}
