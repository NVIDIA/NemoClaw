// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
