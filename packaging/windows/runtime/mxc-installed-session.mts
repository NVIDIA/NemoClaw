// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type SpawnOptions } from "node:child_process";
import path from "node:path";
import type {
  InstalledRuntimeSession,
  InstalledRuntimeWorkload,
  InstalledRuntimeDiagnostics,
} from "../../../src/lib/onboard/runtime-provider/installed-session.ts";
import { NativeGatewaySession } from "./native-gateway-session.mts";
import {
  requestNativeUiSandboxDeletion,
  confirmNativeUiRegistryEmpty,
  waitForNativeMxcCompletion,
  watchNativeUiSandbox,
} from "./native-ui-lifecycle.mts";
import { allowlistedWindowsEnvironment, requiredFile, run } from "./native-command.mts";

export function installedMxcWorkloadArguments(workload: InstalledRuntimeWorkload): string[] {
  return [
    "sandbox",
    "create",
    "--name",
    workload.name,
    "--policy",
    workload.policy,
    "--driver-config-json",
    JSON.stringify({
      mxc: {
        command: workload.command,
        cwd: workload.directory,
        ...(workload.ports === undefined ? {} : { loopback_pipe_ports: workload.ports }),
      },
    }),
    workload.terminal ? "--tty" : "--no-tty",
    ...Object.entries(workload.environment).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]),
    "--detach",
    "--",
    ...workload.command,
  ];
}

/** Owns OpenShell commands and the existing private gateway job and credential lifecycle. */
export class InstalledMxcSession implements InstalledRuntimeSession {
  readonly providerId = "mxc";
  private readonly gateway: NativeGatewaySession;
  private readonly openshell: string;
  private readonly gatewayExecutable: string;

  constructor(installation: string, runRoot: string) {
    this.gateway = new NativeGatewaySession(installation, runRoot);
    this.openshell = requiredFile(path.join(installation, "bin", "openshell.exe"), "OpenShell CLI");
    this.gatewayExecutable = requiredFile(
      path.join(installation, "bin", "openshell-gateway.exe"),
      "OpenShell gateway",
    );
  }

  get root() {
    return this.gateway.root;
  }
  get environment() {
    return this.gateway.environment;
  }
  get gatewayProcessId() {
    return this.gateway.gatewayProcessId;
  }
  get ownCommandProcess() {
    return this.gateway.ownCommandProcess;
  }
  prepare() {
    return this.gateway.prepare();
  }
  configuration(template: string) {
    return this.gateway.configuration(template);
  }
  preflightConfiguration(file: string) {
    return this.gateway.preflightConfiguration(file);
  }
  stopGateway() {
    return this.gateway.stopGateway();
  }
  dispose() {
    return this.gateway.dispose();
  }

  gatewayEnvironment(configuration: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return allowlistedWindowsEnvironment({
      ...extra,
      OPENSHELL_DRIVERS: this.providerId,
      OPENSHELL_GATEWAY_CONFIG: configuration,
      ...this.environment,
    });
  }

  startGateway(input: Parameters<InstalledRuntimeSession["startGateway"]>[0]) {
    return this.gateway.spawnGateway(
      this.gatewayExecutable,
      [
        "--port",
        String(input.port),
        "--enable-mtls-auth",
        ...(input.explicitMtlsValue === false ? [] : ["true"]),
        "--db-url",
        "sqlite::memory:",
        "--log-level",
        input.logLevel ?? "info",
      ],
      {
        env: input.environment,
        stdio: input.stdio,
        windowsHide: input.windowsHide ?? true,
      },
    );
  }

  async registerGateway(
    port: number,
    name: string,
    environment: NodeJS.ProcessEnv,
    labels: readonly [string, string],
    diagnostics?: InstalledRuntimeDiagnostics,
  ) {
    await run(
      this.openshell,
      ["gateway", "add", `https://127.0.0.1:${port}`, "--local", "--name", name],
      environment,
      labels[0],
      undefined,
      diagnostics,
      this.ownCommandProcess,
    );
    await run(
      this.openshell,
      ["gateway", "select", name],
      environment,
      labels[1],
      undefined,
      diagnostics,
      this.ownCommandProcess,
    );
  }

  startWorkload(
    workload: InstalledRuntimeWorkload,
    environment: NodeJS.ProcessEnv,
    stdio: SpawnOptions["stdio"],
  ) {
    const child = spawn(this.openshell, installedMxcWorkloadArguments(workload), {
      env: environment,
      stdio,
      windowsHide: true,
    });
    this.ownCommandProcess(child);
    return child;
  }

  createWorkload(
    workload: InstalledRuntimeWorkload,
    environment: NodeJS.ProcessEnv,
    label: string,
    diagnostics?: InstalledRuntimeDiagnostics,
  ) {
    return run(
      this.openshell,
      installedMxcWorkloadArguments(workload),
      environment,
      label,
      undefined,
      diagnostics,
      this.ownCommandProcess,
    );
  }

  deleteWorkload(
    name: string,
    environment: NodeJS.ProcessEnv,
    label: string,
    timeout?: number,
    diagnostics?: InstalledRuntimeDiagnostics,
  ) {
    return run(
      this.openshell,
      ["sandbox", "delete", name],
      environment,
      label,
      timeout,
      diagnostics,
      this.ownCommandProcess,
    );
  }

  requestWorkloadDeletion(
    ...[environment, ownership]: Parameters<InstalledRuntimeSession["requestWorkloadDeletion"]>
  ) {
    return requestNativeUiSandboxDeletion(
      this.openshell,
      environment,
      ownership,
      this.ownCommandProcess,
    );
  }

  confirmRegistryEmpty(
    ...[environment, ownership]: Parameters<InstalledRuntimeSession["confirmRegistryEmpty"]>
  ) {
    return confirmNativeUiRegistryEmpty(
      this.openshell,
      environment,
      ownership,
      this.ownCommandProcess,
    );
  }

  waitForCompletion(
    ...[environment, name, gateway, state, timeout, signal]: Parameters<
      InstalledRuntimeSession["waitForCompletion"]
    >
  ) {
    return waitForNativeMxcCompletion(
      this.openshell,
      environment,
      name,
      gateway,
      state,
      timeout,
      this.ownCommandProcess,
      signal,
    );
  }

  watchWorkload(
    ...[environment, name, gateway, state, signal]: Parameters<
      InstalledRuntimeSession["watchWorkload"]
    >
  ) {
    return watchNativeUiSandbox(
      this.openshell,
      environment,
      name,
      gateway,
      state,
      signal,
      this.ownCommandProcess,
    );
  }
}
