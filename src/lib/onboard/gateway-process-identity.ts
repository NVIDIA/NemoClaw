// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import {
  resolveGatewayCompatContainerName,
  resolveGatewayName,
  resolveGatewayPortFromName,
} from "./gateway-binding";

export const HOST_GATEWAY_PROCESS_NAMES = new Set(["openshell-gateway", "openclaw-gateway"]);
export const OPENSHELL_GATEWAY_PROCESS_NAMES = new Set(["openshell-gateway"]);

// Container runtimes that can host the compatibility gateway. Limited to the
// ones `docker-driver-gateway-launch` actually invokes so a random user
// command is never mistaken for the parent process of a compat-mode gateway.
export const DOCKER_DRIVER_GATEWAY_CONTAINER_RUNTIME_NAMES = new Set(["docker"]);

// Mount path used by docker-driver-gateway-launch when glibc compat forces the
// gateway to run inside a Docker compatibility container. The parent PID we
// record is the host-side `docker run` process whose argv0 is `docker`, so we
// also accept cmdlines whose argv0 is a known container runtime AND that
// include this mount path as a distinct argv token.
export const DOCKER_DRIVER_GATEWAY_COMPAT_MOUNT_PATH = "/opt/nemoclaw/openshell-gateway";

type ResolveExecutablePath = (value: string) => string | null;

export interface OpenShellGatewayProcessTarget {
  name?: string | null;
  port?: number | string | null;
}

const OWNED_HOST_GATEWAY_ARGV0_RE =
  /^openshell-gateway\[nemoclaw=(nemoclaw(?:-\d+)?);port=(\d+)\]$/;

export function buildOwnedHostGatewayArgv0(gatewayName: string | null | undefined): string | null {
  if (!gatewayName) return null;
  const port = resolveGatewayPortFromName(gatewayName);
  if (port === null) return null;
  return `openshell-gateway[nemoclaw=${gatewayName};port=${port}]`;
}

function ownedHostGatewayTarget(argv0: string): { name: string; port: number } | null {
  const match = OWNED_HOST_GATEWAY_ARGV0_RE.exec(argv0);
  if (!match) return null;
  const name = match[1];
  const port = Number(match[2]);
  if (resolveGatewayPortFromName(name) !== port || resolveGatewayName(port) !== name) return null;
  return { name, port };
}

function gatewayTargetMatches(
  actual: { name: string; port: number },
  expected: OpenShellGatewayProcessTarget | undefined,
): boolean {
  if (!expected || (!expected.name && (expected.port === undefined || expected.port === null))) {
    return true;
  }
  if (expected.name && expected.name !== actual.name) return false;
  if (expected.port !== undefined && expected.port !== null) {
    return String(expected.port) === String(actual.port);
  }
  return true;
}

export function cleanGatewayProcessToken(token: string): string {
  return token.replace(/^['"]|['"]$/g, "").replace(/ \(deleted\)$/, "");
}

function cliFlagValue(tokens: string[], names: string[]): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    for (const name of names) {
      if (token === name) {
        return tokens[index + 1] ?? null;
      }
      if (token.startsWith(`${name}=`)) {
        return token.slice(name.length + 1);
      }
    }
  }
  return null;
}

function openShellGatewayMatchesTarget(
  tokens: string[],
  target: OpenShellGatewayProcessTarget | undefined,
  opts: { requireExpectedFlags: boolean },
): boolean {
  if (!target || (!target.name && (target.port === undefined || target.port === null))) {
    return true;
  }

  let matchedComparableFlag = false;

  if (target.name) {
    const actualName = cliFlagValue(tokens, ["--name"]);
    if (actualName === null) {
      if (opts.requireExpectedFlags) return false;
    } else {
      if (actualName !== target.name) return false;
      matchedComparableFlag = true;
    }
  }

  if (target.port !== undefined && target.port !== null) {
    const actualPort = cliFlagValue(tokens, ["--port"]);
    if (actualPort === null) {
      if (opts.requireExpectedFlags) return false;
    } else {
      if (actualPort !== String(target.port)) return false;
      matchedComparableFlag = true;
    }
  }

  return matchedComparableFlag;
}

function dockerCompatGatewayMatchesTarget(
  tokens: string[],
  target: OpenShellGatewayProcessTarget | undefined,
): boolean {
  if (!target || (!target.name && (target.port === undefined || target.port === null))) {
    return true;
  }
  if (target.port === undefined || target.port === null) return false;

  const port = Number(target.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (target.name && target.name !== resolveGatewayName(port)) return false;

  return cliFlagValue(tokens, ["--name"]) === resolveGatewayCompatContainerName(port);
}

export function gatewayProcessCmdlineMatches(
  cmdline: string,
  gatewayBin: string | null | undefined,
  opts: {
    expectedOpenShellGateway?: OpenShellGatewayProcessTarget;
    processNames?: ReadonlySet<string>;
    resolveExecutablePath?: ResolveExecutablePath;
  } = {},
): boolean {
  const tokens = cmdline.trim().split(/\s+/).filter(Boolean).map(cleanGatewayProcessToken);
  const argv0 = tokens[0] ?? "";
  if (!argv0) return false;

  const processNames = opts.processNames ?? HOST_GATEWAY_PROCESS_NAMES;
  const base = path.basename(argv0);
  const ownedTarget = ownedHostGatewayTarget(base);
  if (ownedTarget && processNames.has("openshell-gateway")) {
    return gatewayTargetMatches(ownedTarget, opts.expectedOpenShellGateway);
  }
  if (processNames.has(base)) {
    if (processNames.has("openshell-gateway") && base === "openshell-gateway") {
      return openShellGatewayMatchesTarget(tokens, opts.expectedOpenShellGateway, {
        requireExpectedFlags: false,
      });
    }
    return true;
  }
  if (
    processNames.has("openshell-gateway") &&
    base === "openshell" &&
    tokens[1] === "gateway" &&
    tokens[2] === "start"
  ) {
    return openShellGatewayMatchesTarget(tokens, opts.expectedOpenShellGateway, {
      requireExpectedFlags: true,
    });
  }

  if (typeof gatewayBin === "string" && gatewayBin.length > 0) {
    const normalize = opts.resolveExecutablePath ?? ((value: string) => path.resolve(value));
    const actual = normalize(argv0);
    const expected = normalize(gatewayBin);
    if (actual && expected && actual === expected) {
      return openShellGatewayMatchesTarget(tokens, opts.expectedOpenShellGateway, {
        requireExpectedFlags: false,
      });
    }
  }

  // Docker compatibility mode: argv0 basename must be a known container
  // runtime AND the mount path appears as a separate argv token. Substring
  // matching inside random tokens would over-match, so require both.
  if (
    DOCKER_DRIVER_GATEWAY_CONTAINER_RUNTIME_NAMES.has(base) &&
    tokens.slice(1).includes(DOCKER_DRIVER_GATEWAY_COMPAT_MOUNT_PATH)
  ) {
    return dockerCompatGatewayMatchesTarget(tokens, opts.expectedOpenShellGateway);
  }

  return false;
}

export function hostGatewayCmdlineMatches(
  cmdline: string,
  gatewayBin: string | null | undefined,
  expectedOpenShellGateway?: OpenShellGatewayProcessTarget,
): boolean {
  return gatewayProcessCmdlineMatches(cmdline, gatewayBin, {
    expectedOpenShellGateway,
  });
}
