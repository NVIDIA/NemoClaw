// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createSession } from "../state/onboard-session";
import { bindGatewayAuthorityToCheckpoint } from "./gateway-authority-checkpoint";
import {
  type GatewayManagementDeclaration,
  GatewayManagementDeclarationError,
} from "./gateway-management";
import { type GatewayOwner, resolveGatewayOwner } from "./gateway-ownership";
import {
  GatewayAuthorityError,
  gatewayAuthorityFailureLines,
  resolveGatewayCredentialMutationAuthority,
  resolveGatewayTeardownAuthority,
} from "./gateway-teardown-authority";

const target = { gatewayName: "nemoclaw", gatewayPort: 8080 };

function declaration(): GatewayManagementDeclaration {
  return {
    version: 1,
    mode: "externally-supervised",
    endpoint: "http://127.0.0.1:8080",
    stateDir: "/var/lib/openshell/gateway",
    supervisor: {
      kind: "systemd-system",
      serviceName: "openshell-gateway.service",
      execPath: "/usr/local/bin/openshell-gateway",
    },
    requiredCapabilities: ["gateway.health"],
  };
}

function owner(currentDeclaration: GatewayManagementDeclaration | null, packaged = false) {
  return resolveGatewayOwner({
    ...target,
    declaration: currentDeclaration,
    hasPackagedService: packaged,
  });
}

function checkpointSession(recordedOwner: GatewayOwner) {
  const session = createSession();
  bindGatewayAuthorityToCheckpoint(session, recordedOwner);
  return session;
}

/** Recorded `packaged-service`, live `standalone` — the #8103 migration. */
function migratedDeps() {
  return {
    hasPackagedService: () => false,
    loadDeclaration: () => ({ ok: true as const, declaration: null, source: null }),
    loadSession: () => checkpointSession(owner(null, true)),
  };
}

describe("gateway authority migration is a typed refusal (#8103)", () => {
  it("throws GatewayAuthorityError when the recorded authority no longer matches", () => {
    expect(() => resolveGatewayTeardownAuthority(target, migratedDeps())).toThrow(
      GatewayAuthorityError,
    );
  });

  it("names both sides of the migration so the operator can see the drift", () => {
    expect(() => resolveGatewayTeardownAuthority(target, migratedDeps())).toThrow(
      /packaged-service -> .*standalone/,
    );
  });

  it("uses the same typed refusal on the credential-mutation path", () => {
    expect(() => resolveGatewayCredentialMutationAuthority(target, migratedDeps())).toThrow(
      GatewayAuthorityError,
    );
  });

  it("throws GatewayAuthorityError for a noncanonical target", () => {
    expect(() =>
      resolveGatewayTeardownAuthority(
        { gatewayName: "not-the-canonical-name", gatewayPort: 8080 },
        migratedDeps(),
      ),
    ).toThrow(GatewayAuthorityError);
  });

  it("throws GatewayAuthorityError when the checkpoint records a declined authority", () => {
    const session = createSession();
    const declined = {
      ...(session.checkpoint ?? {}),
      gatewayAuthority: { kind: "declined" as const },
    };
    session.checkpoint = declined as NonNullable<typeof session.checkpoint>;

    expect(() =>
      resolveGatewayTeardownAuthority(target, {
        hasPackagedService: () => false,
        loadDeclaration: () => ({ ok: true as const, declaration: null, source: null }),
        loadSession: () => session,
      }),
    ).toThrow(GatewayAuthorityError);
  });

  it("leaves an unmatched target refusal typed as well", () => {
    const recorded = resolveGatewayOwner({
      gatewayName: "nemoclaw-18080",
      gatewayPort: 18080,
      declaration: null,
      hasPackagedService: false,
    });

    expect(() =>
      resolveGatewayTeardownAuthority(target, {
        hasPackagedService: () => false,
        loadDeclaration: () => ({ ok: true as const, declaration: null, source: null }),
        loadSession: () => checkpointSession(recorded),
      }),
    ).toThrow(GatewayAuthorityError);
  });

  it("still returns the recorded authority when nothing migrated", () => {
    // The regression lock: an unchanged authority must keep succeeding, so the
    // typed refusal cannot become a blanket rejection.
    const current = declaration();
    const recorded = owner(current);

    expect(
      resolveGatewayTeardownAuthority(target, {
        hasPackagedService: () => false,
        loadDeclaration: () => ({
          ok: true as const,
          declaration: current,
          source: "file" as const,
        }),
        loadSession: () => checkpointSession(recorded),
      }),
    ).toMatchObject({ gatewayName: "nemoclaw", gatewayPort: 8080 });
  });

  it("does not type an invalid management declaration as an authority refusal", () => {
    // A malformed declaration is a different failure class; command boundaries
    // must keep propagating it rather than reporting a migration.
    let failure: unknown;
    try {
      resolveGatewayTeardownAuthority(target, {
        hasPackagedService: () => false,
        loadDeclaration: () => ({ ok: false as const, reason: "malformed json" }),
        loadSession: () => null,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(GatewayManagementDeclarationError);
    expect(failure).toHaveProperty(
      "message",
      "Invalid gateway management declaration: malformed json",
    );
  });
});

describe("gatewayAuthorityFailureLines (#8103)", () => {
  it("names the operation, echoes the detail, and points at the remedy", () => {
    const lines = gatewayAuthorityFailureLines(
      new GatewayAuthorityError("Gateway lifecycle authority changed since onboarding (a -> b)."),
      "sandbox rebuild",
    );

    expect(lines[0]).toContain("Refusing sandbox rebuild");
    expect(lines[1]).toContain("Gateway lifecycle authority changed since onboarding");
    expect(lines[2]).toContain("Re-run onboarding to bind the current gateway authority");
  });

  it("renders a non-Error rejection without losing the detail", () => {
    expect(
      gatewayAuthorityFailureLines("raw refusal", "shared gateway cleanup").join("\n"),
    ).toContain("raw refusal");
  });
});
