// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../cli/branding";
import { runDebug } from "./debug";
import type { RunDebugCommandDeps } from "./debug-command";
import { captureOpenshellCommand } from "../adapters/openshell/client";
import { resolveOpenshell } from "../adapters/openshell/resolve";
import { createCliOpenShellSandboxObserver } from "../adapters/openshell/sandbox-observer-cli";
import {
  namedOpenShellGateway,
  selectedOpenShellGateway,
  type OpenShellGatewayTarget,
} from "../adapters/openshell/sandbox-observer";
import { resolveSandboxGatewayName } from "../onboard/gateway-binding";
import * as registry from "../state/registry";

const useColor = !process.env.NO_COLOR && !!process.stderr.isTTY;
const B = useColor ? "\x1b[1m" : "";
const R = useColor ? "\x1b[0m" : "";
const RD = useColor ? "\x1b[1;31m" : "";

export function buildDebugCommandDeps(rootDir: string): RunDebugCommandDeps {
  const sandboxObserver = createCliOpenShellSandboxObserver({
    capture: (args, options) => {
      const openshell = resolveOpenshell();
      if (!openshell) return { status: 1, output: "" };
      return captureOpenshellCommand(openshell, args, { cwd: rootDir, ...options });
    },
  });

  const liveSandboxNames = async (
    target: OpenShellGatewayTarget,
  ): Promise<ReadonlySet<string> | undefined> => {
    const result = await sandboxObserver.listSandboxes({ target });
    if (!result.ok) return undefined;
    return new Set(result.value.sandboxes.map((sandbox) => sandbox.name));
  };

  const getDefaultSandbox: RunDebugCommandDeps["getDefaultSandbox"] = async () => {
    const { defaultSandbox, sandboxes } = registry.listSandboxes();
    if (!defaultSandbox) {
      const registered = sandboxes.find((sandbox) => sandbox.name);
      const gatewayName = registered ? resolveSandboxGatewayName(registered) : undefined;
      const liveNames = await liveSandboxNames(
        gatewayName ? namedOpenShellGateway(gatewayName) : selectedOpenShellGateway(),
      );
      if (registered && liveNames && !liveNames.has(registered.name)) {
        console.error(
          `${RD}Warning:${R} sandbox '${registered.name}' exists in the local registry but not in OpenShell.`,
        );
        console.error(
          `  Use ${B}--sandbox NAME${R} to target a specific sandbox, or run ${B}${CLI_NAME} onboard${R} again.\n`,
        );
        return null;
      }
      if (registered && gatewayName) return { name: registered.name, gatewayName };
      return { name: liveNames?.values().next().value ?? "default" };
    }
    const registered = sandboxes.find((sandbox) => sandbox.name === defaultSandbox);
    if (!registered) {
      console.error(
        `${RD}Warning:${R} default sandbox '${defaultSandbox}' is no longer in the registry.`,
      );
      console.error(
        `  Use ${B}--sandbox NAME${R} to target a specific sandbox, or run ${B}${CLI_NAME} onboard${R} again.\n`,
      );
      return null;
    }
    const gatewayName = resolveSandboxGatewayName(registered);
    const liveNames = await liveSandboxNames(namedOpenShellGateway(gatewayName));
    if (liveNames && !liveNames.has(defaultSandbox)) {
      console.error(
        `${RD}Warning:${R} default sandbox '${defaultSandbox}' exists in the local registry but not in OpenShell.`,
      );
      console.error(
        `  Use ${B}--sandbox NAME${R} to target a specific sandbox, or run ${B}${CLI_NAME} onboard${R} again.\n`,
      );
      return null;
    }
    return { name: defaultSandbox, gatewayName };
  };

  const getSandboxAvailability: RunDebugCommandDeps["getSandboxAvailability"] = async (name) => {
    const { sandboxes } = registry.listSandboxes();
    const registered = sandboxes.find((sandbox) => sandbox.name === name);
    if (!registered) return { state: "unregistered" };
    const gatewayName = resolveSandboxGatewayName(registered);
    const liveNames = await liveSandboxNames(namedOpenShellGateway(gatewayName));
    return !liveNames || liveNames.has(name)
      ? { state: "available", gatewayName }
      : { state: "missing" };
  };

  return {
    getDefaultSandbox,
    getSandboxAvailability,
    runDebug,
  };
}
