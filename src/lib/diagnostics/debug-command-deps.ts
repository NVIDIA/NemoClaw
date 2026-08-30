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

function resolveDebugGatewayName(
  sandbox: Parameters<typeof resolveSandboxGatewayName>[0],
): string | null {
  try {
    return resolveSandboxGatewayName(sandbox);
  } catch {
    return null;
  }
}

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
  ): Promise<ReadonlySet<string> | "denied" | undefined> => {
    const result = await sandboxObserver.listSandboxes({ target });
    if (!result.ok) {
      const denied =
        result.error.kind === "authentication" ||
        (result.error.kind === "transport" && result.error.reason === "identity_mismatch");
      return denied ? "denied" : undefined;
    }
    return new Set(result.value.sandboxes.map((sandbox) => sandbox.name));
  };

  const getSandboxAvailability: RunDebugCommandDeps["getSandboxAvailability"] = async (name) => {
    const { sandboxes } = registry.listSandboxes();
    const registered = sandboxes.find((sandbox) => sandbox.name === name);
    if (!registered) return { state: "unregistered" };
    const gatewayName = resolveDebugGatewayName(registered);
    if (!gatewayName) return { state: "invalid_gateway" };
    const liveNames = await liveSandboxNames(namedOpenShellGateway(gatewayName));
    if (liveNames === "denied") return { state: "observation_denied" };
    return !liveNames || liveNames.has(name)
      ? { state: "available", gatewayName }
      : { state: "missing" };
  };

  const getDefaultSandbox: RunDebugCommandDeps["getDefaultSandbox"] = async () => {
    const { defaultSandbox, sandboxes } = registry.listSandboxes();
    const selectedName = defaultSandbox ?? sandboxes.find((sandbox) => sandbox.name)?.name;
    if (!selectedName) {
      const liveNames = await liveSandboxNames(selectedOpenShellGateway());
      if (liveNames === "denied") {
        console.error(`${RD}Warning:${R} OpenShell rejected the sandbox observation.`);
        console.error("  Verify OpenShell authentication and gateway identity, then retry.\n");
        return null;
      }
      return { name: liveNames?.values().next().value ?? "default" };
    }

    const availability = await getSandboxAvailability(selectedName);
    if (availability.state === "available") {
      return { name: selectedName, gatewayName: availability.gatewayName };
    }

    const label = defaultSandbox ? "default sandbox" : "sandbox";
    if (availability.state === "unregistered") {
      console.error(`${RD}Warning:${R} ${label} '${selectedName}' is no longer in the registry.`);
      console.error(
        `  Use ${B}--sandbox NAME${R} to target a specific sandbox, or run ${B}${CLI_NAME} onboard${R} again.\n`,
      );
    } else if (availability.state === "invalid_gateway") {
      console.error(
        `${RD}Warning:${R} ${label} '${selectedName}' has an invalid registered gateway binding.`,
      );
      console.error(
        "  Restore gatewayName and gatewayPort from a trusted backup. Otherwise, back up and remove the sandbox before onboarding it again. Do not copy a gateway binding from another sandbox.\n",
      );
    } else if (availability.state === "observation_denied") {
      console.error(
        `${RD}Warning:${R} OpenShell rejected observation of sandbox '${selectedName}'.`,
      );
      console.error("  Verify OpenShell authentication and gateway identity, then retry.\n");
    } else {
      console.error(
        `${RD}Warning:${R} ${label} '${selectedName}' exists in the local registry but not in OpenShell.`,
      );
      console.error(
        `  Use ${B}--sandbox NAME${R} to target a specific sandbox, or run ${B}${CLI_NAME} onboard${R} again.\n`,
      );
    }
    return null;
  };

  return {
    getDefaultSandbox,
    getSandboxAvailability,
    runDebug,
  };
}
