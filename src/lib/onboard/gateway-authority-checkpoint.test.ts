// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isDecisionSelected } from "../state/onboard-checkpoint-decision";
import { createSession, normalizeSession } from "../state/onboard-session";
import {
  bindGatewayAuthorityToCheckpoint,
  checkpointGatewayAuthority,
} from "./gateway-authority-checkpoint";
import type { GatewayManagementDeclaration } from "./gateway-management";
import { resolveGatewayOwner } from "./gateway-ownership";

const externalDeclaration: GatewayManagementDeclaration = {
  version: 1,
  mode: "externally-supervised",
  endpoint: "http://127.0.0.1:8080",
  stateDir: "/var/lib/openshell/gateway",
  supervisor: {
    kind: "systemd-system",
    serviceName: "openshell-gateway.service",
    execPath: "/usr/local/bin/openshell-gateway",
  },
  requiredCapabilities: ["gateway.health", "sandbox.create"],
};

function externalOwner() {
  return resolveGatewayOwner({
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    declaration: externalDeclaration,
    hasPackagedService: false,
  });
}

function managedOwner() {
  return resolveGatewayOwner({
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    declaration: null,
    hasPackagedService: false,
  });
}

describe("durable gateway lifecycle authority", () => {
  it("records the resolved authority before gateway effects (#6576)", () => {
    const session = createSession({ sessionId: "authority-session" });
    const owner = externalOwner();

    expect(bindGatewayAuthorityToCheckpoint(session, owner)).toEqual(owner);
    const authority = session.checkpoint?.gatewayAuthority;
    expect(authority).toEqual({ kind: "selected", value: checkpointGatewayAuthority(owner) });
    expect(isDecisionSelected(authority!)).toBe(true);
  });

  it("accepts the same authority after a process resume round-trip (#6576)", () => {
    const firstProcess = createSession({ sessionId: "authority-session" });
    const owner = externalOwner();
    bindGatewayAuthorityToCheckpoint(firstProcess, owner);
    const checkpointUpdatedAt = firstProcess.checkpoint?.updatedAt;
    const resumed = normalizeSession(JSON.parse(JSON.stringify(firstProcess)) as never);

    expect(resumed).not.toBeNull();
    expect(bindGatewayAuthorityToCheckpoint(resumed!, owner)).toEqual(owner);
    expect(resumed!.checkpoint?.updatedAt).toBe(checkpointUpdatedAt);
  });

  it("rejects external-to-managed drift after a process resume before effects (#6576)", () => {
    const firstProcess = createSession({ sessionId: "authority-session" });
    bindGatewayAuthorityToCheckpoint(firstProcess, externalOwner());
    const resumed = normalizeSession(JSON.parse(JSON.stringify(firstProcess)) as never);

    expect(() => bindGatewayAuthorityToCheckpoint(resumed!, managedOwner())).toThrow(
      /changed since this onboarding attempt was checkpointed.*fresh onboarding run/s,
    );
  });

  it("rejects a different per-port gateway binding after resume (#6576)", () => {
    const firstProcess = createSession({ sessionId: "authority-session" });
    bindGatewayAuthorityToCheckpoint(firstProcess, managedOwner());
    const resumed = normalizeSession(JSON.parse(JSON.stringify(firstProcess)) as never);
    const otherPort = resolveGatewayOwner({
      gatewayName: "nemoclaw-9443",
      gatewayPort: 9443,
      declaration: null,
      hasPackagedService: false,
    });

    expect(() => bindGatewayAuthorityToCheckpoint(resumed!, otherPort)).toThrow(
      /authority changed since this onboarding attempt was checkpointed/,
    );
  });
});
