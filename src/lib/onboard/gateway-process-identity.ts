// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import {
  dockerCompatGatewayMatchesTarget,
  gatewayTargetMatches,
  type OpenShellGatewayProcessTarget,
  openShellGatewayMatchesTarget,
  ownedHostGatewayTarget,
} from "./gateway-process-target-identity";

export {
  buildOwnedHostGatewayArgv0,
  type OpenShellGatewayProcessTarget,
} from "./gateway-process-target-identity";

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

export function cleanGatewayProcessToken(token: string): string {
  return token.replace(/^['"]|['"]$/g, "").replace(/ \(deleted\)$/, "");
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
    if (base === "openclaw-gateway") {
      return openShellGatewayMatchesTarget(tokens, opts.expectedOpenShellGateway, {
        requireExpectedFlags: true,
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
