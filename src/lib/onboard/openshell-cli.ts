// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveOpenshell } from "../adapters/openshell/resolve";
import { ROOT, run, runCapture, shellQuote } from "../runner";
import {
  type CaptureOpenshellOptions,
  type CaptureOpenshellResult,
  captureSandboxRecreateOpenshellCommand,
} from "./sandbox-recreate-probe";

export interface OpenshellCliDeps {
  getCachedBinary(): string | null;
  setCachedBinary(binary: string): void;
  getGatewayPort(): number;
  getDockerDriverGatewayEndpoint(): string;
}

export interface OpenshellCliHelpers {
  getOpenshellBinary(): string;
  openshellShellCommand(args: string[], options?: { openshellBinary?: string }): string;
  openshellArgv(args: string[], options?: { openshellBinary?: string }): string[];
  runOpenshell(args: string[], opts?: any): ReturnType<typeof run>;
  runCaptureOpenshell(args: string[], opts?: any): string;
  captureOpenshell(args: string[], opts?: CaptureOpenshellOptions): CaptureOpenshellResult;
  safeOpenShellArgument(value: string, label: string): string;
  getGatewayPortArg(): string;
  getDockerDriverGatewayEndpointArg(): string;
}

export function createOpenshellCliHelpers(deps: OpenshellCliDeps): OpenshellCliHelpers {
  function getOpenshellBinary(): string {
    const cached = deps.getCachedBinary();
    if (cached) return cached;
    const resolved = resolveOpenshell();
    if (typeof resolved !== "string" || resolved.length === 0) {
      console.error("  openshell CLI not found.");
      console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
      process.exit(1);
    }
    deps.setCachedBinary(resolved);
    return resolved;
  }

  function openshellShellCommand(
    args: string[],
    options: { openshellBinary?: string } = {},
  ): string {
    const openshellBinary = options.openshellBinary || getOpenshellBinary();
    return [shellQuote(openshellBinary), ...args.map((arg) => shellQuote(arg))].join(" ");
  }

  function openshellArgv(args: string[], options: { openshellBinary?: string } = {}): string[] {
    const openshellBinary = options.openshellBinary || getOpenshellBinary();
    return [openshellBinary, ...args];
  }

  function runOpenshell(args: string[], opts: any = {}) {
    return run(openshellArgv(args, opts), opts);
  }

  function runCaptureOpenshell(args: string[], opts: any = {}) {
    return runCapture(openshellArgv(args, opts), opts);
  }

  function captureOpenshell(args: string[], opts: CaptureOpenshellOptions = {}) {
    return captureSandboxRecreateOpenshellCommand(getOpenshellBinary(), args, {
      ...opts,
      cwd: ROOT,
      errorLine: console.error,
      exit: (code: number) => process.exit(code),
    });
  }

  function safeOpenShellArgument(value: string, label: string): string {
    if (!/^[A-Za-z0-9._~:/-]+$/.test(value)) {
      throw new Error(`Invalid ${label}: contains characters unsafe for OpenShell CLI args`);
    }
    return value;
  }

  function getGatewayPortArg(): string {
    return safeOpenShellArgument(String(deps.getGatewayPort()), "gateway port");
  }

  function getDockerDriverGatewayEndpointArg(): string {
    return safeOpenShellArgument(deps.getDockerDriverGatewayEndpoint(), "gateway endpoint");
  }

  return {
    getOpenshellBinary,
    openshellShellCommand,
    openshellArgv,
    runOpenshell,
    runCaptureOpenshell,
    captureOpenshell,
    safeOpenShellArgument,
    getGatewayPortArg,
    getDockerDriverGatewayEndpointArg,
  };
}
