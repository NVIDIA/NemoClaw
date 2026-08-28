// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../cli/branding";
import { runDebug } from "./debug";
import type { RunDebugCommandDeps } from "./debug-command";
import { captureOpenshellCommand } from "../adapters/openshell/client";
import { resolveOpenshell } from "../adapters/openshell/resolve";
import { createCliOpenShellSandboxObserver } from "../adapters/openshell/sandbox-observer-cli";
import { selectedOpenShellGateway } from "../adapters/openshell/sandbox-observer";
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

  const liveSandboxNames = async (): Promise<ReadonlySet<string> | undefined> => {
    const result = await sandboxObserver.listSandboxes({ target: selectedOpenShellGateway() });
    if (!result.ok) return undefined;
    return new Set(result.value.sandboxes.map((sandbox) => sandbox.name));
  };

  const getDefaultSandbox = async (): Promise<string | null | undefined> => {
    const { defaultSandbox, sandboxes } = registry.listSandboxes();
    if (!defaultSandbox) return undefined;
    if (!sandboxes.find((sandbox) => sandbox.name === defaultSandbox)) {
      console.error(
        `${RD}Warning:${R} default sandbox '${defaultSandbox}' is no longer in the registry.`,
      );
      console.error(
        `  Use ${B}--sandbox NAME${R} to target a specific sandbox, or run ${B}${CLI_NAME} onboard${R} again.\n`,
      );
      return null;
    }
    const liveNames = await liveSandboxNames();
    if (liveNames && !liveNames.has(defaultSandbox)) {
      console.error(
        `${RD}Warning:${R} default sandbox '${defaultSandbox}' exists in the local registry but not in OpenShell.`,
      );
      console.error(
        `  Use ${B}--sandbox NAME${R} to target a specific sandbox, or run ${B}${CLI_NAME} onboard${R} again.\n`,
      );
      return null;
    }
    return defaultSandbox;
  };

  const isSandboxKnown = async (name: string): Promise<boolean> => {
    const { sandboxes } = registry.listSandboxes();
    if (!sandboxes.find((sandbox) => sandbox.name === name)) return false;
    const liveNames = await liveSandboxNames();
    return !liveNames || liveNames.has(name);
  };

  return {
    getDefaultSandbox,
    isSandboxKnown,
    runDebug,
  };
}
