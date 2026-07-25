// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { bindGatewayAuthorityToCheckpoint } from "../../src/lib/onboard/gateway-authority-checkpoint";
import type { GatewayManagementDeclaration } from "../../src/lib/onboard/gateway-management";
import { resolveGatewayOwner } from "../../src/lib/onboard/gateway-ownership";
import { createSession } from "../../src/lib/state/onboard-session";

const EXTERNAL_GATEWAY_DECLARATION: GatewayManagementDeclaration = {
  version: 1,
  mode: "externally-supervised",
  endpoint: "http://127.0.0.1:8080",
  stateDir: "/var/lib/openshell/private-gateway-state",
  supervisor: {
    kind: "systemd-system",
    serviceName: "openshell-gateway.service",
    execPath: "/usr/local/bin/openshell-gateway",
  },
  requiredCapabilities: ["gateway.health", "sandbox.create"],
};

export function writeExternalGatewayAuthoritySession(home: string): void {
  const session = createSession({
    sessionId: "external-gateway-authority-session",
    sandboxName: "alpha",
  });
  bindGatewayAuthorityToCheckpoint(
    session,
    resolveGatewayOwner({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      declaration: EXTERNAL_GATEWAY_DECLARATION,
      hasPackagedService: false,
    }),
  );
  const stateDir = path.join(home, ".nemoclaw");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "onboard-session.json"), JSON.stringify(session), {
    mode: 0o600,
  });
}
