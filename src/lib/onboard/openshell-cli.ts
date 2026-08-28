// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { processTreeBoundedOpenshellInvocation } from "../adapters/openshell/process-tree-timeout";
import { resolveOpenshell } from "../adapters/openshell/resolve";
import { ROOT, run, runCapture, shellQuote } from "../runner";
import {
  type CaptureOpenshellOptions,
  type CaptureOpenshellResult,
  captureSandboxRecreateOpenshellCommand,
} from "./sandbox-recreate-probe";

// Keep OpenShell binary resolution behind the established onboarding adapter.
// Readiness and runtime callers reuse this export instead of creating parallel
// dependencies on the low-level resolver.
export { resolveOpenshell };

export interface OpenshellCliDeps {
  getCachedBinary(): string | null;
  setCachedBinary(binary: string): void;
  getGatewayPort(): number;
  getDockerDriverGatewayEndpoint(): string;
  runCommand?: typeof run;
  runCaptureCommand?: typeof runCapture;
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
  const runCommand = deps.runCommand ?? run;
  const runCaptureCommand = deps.runCaptureCommand ?? runCapture;

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

  function processTreeBoundedInvocation(args: string[], opts: any) {
    const [binary, ...commandArgs] = openshellArgv(args, opts);
    const { killProcessTreeOnTimeout, ...runnerOptions } = opts;
    const bounded = processTreeBoundedOpenshellInvocation(binary, commandArgs, {
      killProcessTreeOnTimeout,
      killSignal: runnerOptions.killSignal,
      timeout: runnerOptions.timeout,
    });
    return {
      argv: [bounded.binary, ...bounded.args],
      runnerOptions: { ...runnerOptions, killSignal: bounded.killSignal },
    };
  }

  function runOpenshell(args: string[], opts: any = {}) {
    const invocation = processTreeBoundedInvocation(args, opts);
    return runCommand(invocation.argv, invocation.runnerOptions);
  }

  function runCaptureOpenshell(args: string[], opts: any = {}) {
    const invocation = processTreeBoundedInvocation(args, opts);
    return runCaptureCommand(invocation.argv, invocation.runnerOptions);
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
