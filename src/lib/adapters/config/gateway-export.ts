// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import { isValidNemoClawPort } from "../../config/model";
import { resolveGatewayName } from "../../onboard/gateway-binding/identity";
import {
  managedGatewayStateRootOwnershipFailure,
  resolveGatewayStateDirForPort,
} from "../../onboard/gateway/state-dir";
import type { SandboxEntry } from "../../state/registry/types";

/** Resolve the gateway state that belongs to this persisted sandbox binding. */
export function observeGatewayBinding(entry: Readonly<SandboxEntry>) {
  const port = entry.gatewayPort;
  if (!isValidNemoClawPort(port)) {
    throw new Error("The persisted gateway port is incomplete or invalid.");
  }
  const name = resolveGatewayName(port);
  if (entry.gatewayName !== name) {
    throw new Error("The persisted gateway name and port disagree.");
  }
  const configuredStateDir = process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR?.trim();
  const stateDir = resolveGatewayStateDirForPort({
    configured: configuredStateDir,
    home: os.homedir(),
    port,
  });
  const stateRootOwned =
    managedGatewayStateRootOwnershipFailure(
      { gatewayName: name, gatewayPort: port, stateDir },
      { allowLegacyManagedState: !configuredStateDir },
    ) === null;
  return { name, port, stateDir, stateRootOwned };
}
