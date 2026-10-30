// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { allowlistedWindowsEnvironment, requiredFile } from "./native-command.mts";

/** Parse the exact installed gateway configuration without starting a gateway or sandbox. */
export function preflightNativeGatewayConfig(
  installation: string,
  configuration: string,
  privateRoot: string,
): void {
  const executable = requiredFile(
    path.join(installation, "bin", "openshell-gateway.exe"),
    "gateway configuration validator",
  );
  const result = spawnSync(
    executable,
    [
      "--compute-driver",
      "mxc",
      // Unlike daemon startup, preflight does not resolve local TLS defaults.
      // It validates these paths without loading or creating credential files.
      "--tls-cert",
      path.join(privateRoot, "tls", "server", "tls.crt"),
      "--tls-key",
      path.join(privateRoot, "tls", "server", "tls.key"),
      "--tls-client-ca",
      path.join(privateRoot, "tls", "ca.crt"),
      "config",
      "preflight",
      "--path",
      configuration,
    ],
    {
      env: allowlistedWindowsEnvironment(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0 || result.error || result.signal) {
    // Raw validator output and spawn errors may contain credentials or paths.
    // Never retry with settings removed or authentication disabled.
    throw new Error(
      "The installed OpenShell runtime could not validate the installer configuration. " +
        "No gateway or sandbox was started. Use a compatible installer/runtime build; " +
        "network, console, and authentication settings were not relaxed.",
    );
  }
}
