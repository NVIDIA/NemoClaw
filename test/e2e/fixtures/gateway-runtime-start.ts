// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertExitZero } from "./clients/command.ts";
import type { HostCliClient } from "./clients/host.ts";
import { REPO_ROOT } from "./paths.ts";
import type { ShellProbeRunOptions } from "./shell-probe.ts";

/** Initialize an isolated qualification job's gateway before strict resource cleanup. */
export async function initializeGatewayForCleanup(
  host: Pick<HostCliClient, "command">,
  gatewayName: string,
  options: ShellProbeRunOptions,
): Promise<void> {
  if (!gatewayName.trim() || options.env?.OPENSHELL_GATEWAY !== gatewayName) {
    throw new Error("Gateway setup requires the same explicit gateway name and environment.");
  }
  const result = await host.command(
    process.execPath,
    [
      "-e",
      [
        'const { startGatewayForRecovery } = require("./dist/lib/onboard");',
        "Promise.resolve()",
        "  .then(() => startGatewayForRecovery({ gatewayName: process.argv[1] }))",
        "  .catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });",
      ].join("\n"),
      gatewayName,
    ],
    { ...options, cwd: REPO_ROOT },
  );
  assertExitZero(result, `initialize cleanup gateway ${gatewayName}`);
}

/** Start the gateway that the fixture stopped through the candidate CLI's startup owner. */
export function buildGatewayRuntimeStartScript(): string {
  return [
    '"use strict";',
    'const { getSandbox } = require("./dist/lib/state/registry");',
    'const { resolveSandboxGatewayName } = require("./dist/lib/onboard/gateway-binding");',
    "const sandbox = getSandbox(process.argv[1]);",
    'if (!sandbox) throw new Error("Gateway restart requires a registered sandbox.");',
    "const gatewayName = resolveSandboxGatewayName(sandbox);",
    'const { startGatewayForRecovery } = require("./dist/lib/onboard");',
    "Promise.resolve()",
    "  .then(() => startGatewayForRecovery({ gatewayName }))",
    "  .catch((error) => {",
    "    console.error(error instanceof Error ? error.message : String(error));",
    "    process.exitCode = 1;",
    "  });",
  ].join("\n");
}

/** Observe native startup after an external OpenShell start without restarting the sandbox. */
export function buildOpenClawGatewayWaitScript(): string {
  return [
    '"use strict";',
    'const { waitForStartedNativeGatewayProcess } = require("./dist/lib/actions/sandbox/process-recovery");',
    "const [sandboxName, gatewayName, budget] = process.argv.slice(1);",
    "const budgetMs = Number(budget);",
    'if (!sandboxName || !gatewayName || !Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error("Native startup requires an explicit target and remaining time budget.");',
    "Promise.resolve()",
    '  .then(() => waitForStartedNativeGatewayProcess(sandboxName, "openclaw", gatewayName, {',
    "    environment: {}, defaultTimeoutSeconds: budgetMs / 1000, log: console.log,",
    "  }))",
    '  .then((ready) => { if (ready !== true) throw new Error("OpenClaw did not become ready within the remaining dashboard deadline."); })',
    "  .catch((error) => {",
    "    console.error(error instanceof Error ? error.message : String(error));",
    "    process.exitCode = 1;",
    "  });",
  ].join("\n");
}
