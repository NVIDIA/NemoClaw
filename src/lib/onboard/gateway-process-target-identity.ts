// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  resolveGatewayCompatContainerName,
  resolveGatewayName,
  resolveGatewayPortFromName,
} from "./gateway-binding";

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

export function ownedHostGatewayTarget(argv0: string): { name: string; port: number } | null {
  const match = OWNED_HOST_GATEWAY_ARGV0_RE.exec(argv0);
  if (!match) return null;
  const name = match[1];
  const port = Number(match[2]);
  if (resolveGatewayPortFromName(name) !== port || resolveGatewayName(port) !== name) return null;
  return { name, port };
}

export function gatewayTargetMatches(
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

function cliFlagValue(tokens: string[], names: string[]): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    for (const name of names) {
      if (token === name) return tokens[index + 1] ?? null;
      if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
    }
  }
  return null;
}

export function openShellGatewayMatchesTarget(
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

export function dockerCompatGatewayMatchesTarget(
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
