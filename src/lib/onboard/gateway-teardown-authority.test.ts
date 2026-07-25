// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createSession } from "../state/onboard-session";
import { bindGatewayAuthorityToCheckpoint } from "./gateway-authority-checkpoint";
import type { GatewayManagementDeclaration } from "./gateway-management";
import { type GatewayOwner, resolveGatewayOwner } from "./gateway-ownership";
import {
  resolveGatewayCredentialMutationAuthority,
  resolveGatewayTeardownAuthority,
} from "./gateway-teardown-authority";

const target = { gatewayName: "nemoclaw", gatewayPort: 8080 };

function declaration(
  kind: "systemd-system" | "systemd-user" = "systemd-system",
): GatewayManagementDeclaration {
  return {
    version: 1,
    mode: "externally-supervised",
    endpoint: "http://127.0.0.1:8080",
    stateDir: "/var/lib/openshell/gateway",
    supervisor: {
      kind,
      serviceName: "openshell-gateway.service",
      execPath: "/usr/local/bin/openshell-gateway",
    },
    requiredCapabilities: ["gateway.health"],
  };
}

function owner(currentDeclaration: GatewayManagementDeclaration | null): GatewayOwner {
  return resolveGatewayOwner({
    ...target,
    declaration: currentDeclaration,
    hasPackagedService: false,
  });
}

function checkpointSession(recordedOwner: GatewayOwner) {
  const session = createSession();
  bindGatewayAuthorityToCheckpoint(session, recordedOwner);
  return session;
}

describe("resolveGatewayTeardownAuthority", () => {
  it.each([
    "systemd-system",
    "systemd-user",
  ] as const)("returns the exact recorded %s authority when the declaration still matches (#6576)", (kind) => {
    const currentDeclaration = declaration(kind);
    const recordedOwner = owner(currentDeclaration);

    expect(
      resolveGatewayTeardownAuthority(target, {
        hasPackagedService: () => false,
        loadDeclaration: () => ({
          ok: true,
          declaration: currentDeclaration,
          source: "profile",
        }),
        loadSession: () => checkpointSession(recordedOwner),
      }),
    ).toEqual(recordedOwner);
  });

  it("uses the current external declaration when no checkpoint exists (#6576)", () => {
    const currentDeclaration = declaration();

    expect(
      resolveGatewayTeardownAuthority(target, {
        hasPackagedService: () => false,
        loadDeclaration: () => ({
          ok: true,
          declaration: currentDeclaration,
          source: "profile",
        }),
        loadSession: () => null,
      }).mode,
    ).toBe("externally-supervised");
  });

  it("fails closed when a recorded external authority is removed (#6576)", () => {
    const recordedOwner = owner(declaration());

    expect(() =>
      resolveGatewayTeardownAuthority(target, {
        hasPackagedService: () => false,
        loadDeclaration: () => ({ ok: true, declaration: null, source: null }),
        loadSession: () => checkpointSession(recordedOwner),
      }),
    ).toThrow(/authority changed since onboarding.*teardown will not perform gateway effects/);
  });

  it("fails closed before credential mutation when authority changed since onboarding (#6576)", () => {
    const recordedOwner = owner(declaration());

    expect(() =>
      resolveGatewayCredentialMutationAuthority(target, {
        hasPackagedService: () => false,
        loadDeclaration: () => ({ ok: true, declaration: null, source: null }),
        loadSession: () => checkpointSession(recordedOwner),
      }),
    ).toThrow(
      /authority changed since onboarding.*provider credential mutation will not perform gateway effects/,
    );
  });

  it("fails closed when the recorded authority targets another gateway (#6576)", () => {
    const recordedOwner = resolveGatewayOwner({
      gatewayName: "nemoclaw-8081",
      gatewayPort: 8081,
      declaration: null,
      hasPackagedService: false,
    });

    expect(() =>
      resolveGatewayTeardownAuthority(target, {
        hasPackagedService: () => false,
        loadDeclaration: () => ({ ok: true, declaration: null, source: null }),
        loadSession: () => checkpointSession(recordedOwner),
      }),
    ).toThrow(/recorded authority targets 'nemoclaw-8081@8081'/);
  });

  it("rejects a noncanonical gateway target before loading authority (#6576)", () => {
    let loaded = false;

    expect(() =>
      resolveGatewayTeardownAuthority(
        { gatewayName: "other", gatewayPort: 8080 },
        {
          loadDeclaration: () => {
            loaded = true;
            return { ok: true, declaration: null, source: null };
          },
        },
      ),
    ).toThrow(/noncanonical target/);
    expect(loaded).toBe(false);
  });
});
