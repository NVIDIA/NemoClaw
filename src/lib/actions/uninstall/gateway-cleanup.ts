// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptions } from "node:child_process";
import { createCliOpenShellGatewayReuseObserver } from "../../adapters/openshell/gateway-reuse-cli";
import { createCliOpenShellGatewayLifecycleFromRunner } from "../../adapters/openshell/gateway-lifecycle-cli";
import {
  removeGatewayRegistrationThroughAdapter,
  resolveGatewayTeardownAuthority,
  type GatewayTeardownAuthorityResolver,
} from "../../onboard/gateway-teardown-authority";

export { resolveGatewayTeardownAuthority };

/** Gateway-specific dependencies needed by uninstall's cleanup transaction. */
export interface GatewayCleanupRuntime {
  commandExists(command: string): boolean;
  env: NodeJS.ProcessEnv;
  run(
    command: string,
    args: string[],
    options?: SpawnSyncOptions,
  ): { status: number | null; stdout: string; stderr: string };
  resolveGatewayTeardownAuthority: GatewayTeardownAuthorityResolver;
  log(message: string): void;
  warn(message: string): void;
}

export async function portableGatewayIsReachable(
  runtime: GatewayCleanupRuntime,
  gatewayName: string,
): Promise<boolean> {
  const observer = createCliOpenShellGatewayReuseObserver((args, options) => {
    const result = runtime.run("openshell", args, { ...options, env: runtime.env });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  });
  const observed = await observer.observeGatewayReuse({ target: { kind: "named", gatewayName } });
  return !observed.error && observed.healthy && observed.namedMetadata;
}

export async function removeGatewayRegistration(
  runtime: GatewayCleanupRuntime,
  gatewayLabel: string,
  allowLegacyDestroy: boolean,
  gatewayPort: number,
): Promise<boolean> {
  const lifecycle = createCliOpenShellGatewayLifecycleFromRunner((args, options) =>
    runtime.run("openshell", args, { ...options, env: runtime.env }),
  );
  const outcome = await removeGatewayRegistrationThroughAdapter({
    gatewayName: gatewayLabel,
    allowLegacyDestroy,
    lifecycle,
    revalidateAuthority: () =>
      runtime.resolveGatewayTeardownAuthority(
        {
          gatewayName: gatewayLabel,
          gatewayPort,
        },
        { allowMissingPackagedServiceTeardown: true, env: runtime.env },
      ),
  });
  if (!outcome.ok) {
    runtime.warn(
      `Could not remove gateway registration '${gatewayLabel}': ${outcome.error.message}`,
    );
    return false;
  }
  if (outcome.state === "absent") runtime.warn(`Gateway '${gatewayLabel}' is already absent`);
  else runtime.log(`Removed gateway registration '${gatewayLabel}'`);
  return true;
}

/**
 * Names of the gateways OpenShell currently knows about, or `null` when that
 * cannot be determined (OpenShell missing, the query failed, or its output was
 * unparseable). `null` always means "stay conservative": callers must not treat
 * an absence they cannot prove as evidence that a gateway is gone. (#7315)
 */
export async function collectLiveOpenShellGatewayNames(
  runtime: GatewayCleanupRuntime,
  gatewayName: string,
): Promise<Set<string> | null> {
  if (!runtime.commandExists("openshell")) return null;
  const lifecycle = createCliOpenShellGatewayLifecycleFromRunner((args, options) =>
    runtime.run("openshell", args, { ...options, env: runtime.env }),
  );
  const result = await lifecycle.listGateways({
    target: { kind: "named", gatewayName },
  });
  return result.ok ? new Set(result.names) : null;
}
