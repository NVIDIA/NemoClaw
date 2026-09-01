// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createSession } from "../state/onboard-session";
import { nemoclawStateRoot } from "../state/state-root";
import { bindGatewayAuthorityToCheckpoint } from "./gateway-authority-checkpoint";
import type { GatewayManagementDeclaration } from "./gateway-management";
import { type GatewayOwner, resolveGatewayOwner } from "./gateway-ownership";
import {
  GatewayAuthorityError,
  resolveGatewayCredentialMutationAuthority,
  resolveGatewayRebuildAuthority,
  resolveGatewayTeardownAuthority,
} from "./gateway-teardown-authority";

const target = { gatewayName: "nemoclaw", gatewayPort: 8080 };

function targetSessionFile(homeDir: string): string {
  const stateDir = nemoclawStateRoot(homeDir, target.gatewayPort);
  return path.join(stateDir, "onboard-session.json");
}

function writeTargetSession(homeDir: string, content: string): void {
  const sessionFile = targetSessionFile(homeDir);
  const stateDir = path.dirname(sessionFile);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(sessionFile, content, { mode: 0o600 });
}

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

function managedOwner(hasPackagedService: boolean): GatewayOwner {
  return resolveGatewayOwner({
    ...target,
    declaration: null,
    hasPackagedService,
  });
}

function checkpointSession(recordedOwner: GatewayOwner) {
  const session = createSession();
  bindGatewayAuthorityToCheckpoint(session, recordedOwner);
  return session;
}

describe("resolveGatewayTeardownAuthority", () => {
  it.each(["systemd-system", "systemd-user"] as const)(
    "returns the exact recorded %s authority when the declaration still matches (#6576)",
    (kind) => {
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
    },
  );

  it("uses the current external declaration when no checkpoint exists (#6576)", () => {
    const currentDeclaration = declaration();

    expect(
      resolveGatewayTeardownAuthority(target, {
        hasPackagedService: () => {
          throw new Error("packaged service must not be inspected");
        },
        loadDeclaration: () => ({
          ok: true,
          declaration: currentDeclaration,
          source: "profile",
        }),
        loadSession: () => null,
      }).mode,
    ).toBe("externally-supervised");
  });

  it("uses persisted gateway authority even when the unrelated sandbox identity is malformed (#9833)", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-teardown-authority-"));
    const currentDeclaration = declaration();
    const recordedOwner = owner(currentDeclaration);
    const session = {
      ...checkpointSession(recordedOwner),
    };
    writeTargetSession(homeDir, JSON.stringify(session));

    try {
      expect(
        resolveGatewayTeardownAuthority(target, {
          env: { HOME: homeDir },
          hasPackagedService: () => false,
          loadDeclaration: () => ({
            ok: true,
            declaration: currentDeclaration,
            source: "profile",
          }),
        }),
      ).toEqual(recordedOwner);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not adopt a different current owner when sandbox identity is malformed (#9833)", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-teardown-authority-"));
    const recordedOwner = owner(declaration("systemd-system"));
    const session = {
      ...checkpointSession(recordedOwner),
    };
    writeTargetSession(homeDir, JSON.stringify(session));

    try {
      expect(() =>
        resolveGatewayTeardownAuthority(target, {
          env: { HOME: homeDir },
          hasPackagedService: () => false,
          loadDeclaration: () => ({
            ok: true,
            declaration: declaration("systemd-user"),
            source: "profile",
          }),
        }),
      ).toThrow(/authority changed since onboarding.*teardown will not perform gateway effects/);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("fails closed without disclosing the state path when persisted authority is malformed (#9833)", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-teardown-authority-"));
    writeTargetSession(homeDir, "{");

    try {
      let refusal: unknown;
      try {
        resolveGatewayTeardownAuthority(target, {
          env: { HOME: homeDir },
          hasPackagedService: () => false,
          loadDeclaration: () => ({
            ok: true,
            declaration: declaration("systemd-user"),
            source: "profile",
          }),
        });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(GatewayAuthorityError);
      expect((refusal as Error).message).toMatch(/unreadable or is not valid JSON/);
      expect((refusal as Error).message).toContain("fresh onboarding run");
      expect((refusal as Error).message).not.toContain(homeDir);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not inspect the default packaged service for a custom gateway port (#6903)", () => {
    const customTarget = { gatewayName: "nemoclaw-9123", gatewayPort: 9123 };

    expect(
      resolveGatewayTeardownAuthority(customTarget, {
        hasPackagedService: () => {
          throw new Error("default service must not be inspected");
        },
        loadDeclaration: () => ({ ok: true, declaration: null, source: null }),
        loadSession: () => null,
      }),
    ).toMatchObject({
      gatewayName: "nemoclaw-9123",
      gatewayPort: 9123,
      mode: "nemoclaw-managed",
      source: "standalone",
    });
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

  it("allows opted-in uninstall teardown after the packaged service was already removed (#8215)", () => {
    const recordedOwner = managedOwner(true);

    expect(
      resolveGatewayTeardownAuthority(target, {
        allowMissingPackagedServiceTeardown: true,
        hasPackagedService: () => false,
        loadDeclaration: () => ({ ok: true, declaration: null, source: null }),
        loadSession: () => checkpointSession(recordedOwner),
      }),
    ).toMatchObject({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "nemoclaw-managed",
      source: "standalone",
    });
  });

  it("still rejects credential mutation after the recorded packaged service is removed (#8215)", () => {
    const recordedOwner = managedOwner(true);

    expect(() =>
      resolveGatewayCredentialMutationAuthority(target, {
        hasPackagedService: () => false,
        loadDeclaration: () => ({ ok: true, declaration: null, source: null }),
        loadSession: () => checkpointSession(recordedOwner),
      }),
    ).toThrow(
      /packaged-service -> nemoclaw@8080:nemoclaw-managed:standalone.*provider credential mutation will not perform gateway effects/,
    );
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

describe("resolveGatewayRebuildAuthority", () => {
  const packagedOwner = resolveGatewayOwner({
    ...target,
    declaration: null,
    hasPackagedService: true,
  });

  const standaloneDeps = {
    hasPackagedService: () => false,
    loadDeclaration: () => ({ ok: true as const, declaration: null, source: null }),
    loadSession: () => checkpointSession(packagedOwner),
  };

  it("adopts the managed packaged-service to standalone migration before rebuild (#8103)", () => {
    expect(resolveGatewayRebuildAuthority(target, standaloneDeps)).toMatchObject({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "nemoclaw-managed",
      source: "standalone",
    });
  });

  it("keeps ordinary teardown fail-closed across the managed service migration (#8103)", () => {
    expect(() => resolveGatewayTeardownAuthority(target, standaloneDeps)).toThrow(
      /authority changed since onboarding.*gateway teardown will not perform gateway effects/,
    );
  });

  it("keeps credential mutation fail-closed across the managed service migration (#8103)", () => {
    expect(() => resolveGatewayCredentialMutationAuthority(target, standaloneDeps)).toThrow(
      /authority changed since onboarding.*provider credential mutation will not perform gateway effects/,
    );
  });

  it("rejects the reverse standalone to packaged-service transition (#8103)", () => {
    const standaloneOwner = resolveGatewayOwner({
      ...target,
      declaration: null,
      hasPackagedService: false,
    });

    expect(() =>
      resolveGatewayRebuildAuthority(target, {
        hasPackagedService: () => true,
        loadDeclaration: () => ({ ok: true, declaration: null, source: null }),
        loadSession: () => checkpointSession(standaloneOwner),
      }),
    ).toThrow(
      /authority changed since onboarding.*sandbox rebuild will not perform gateway effects/,
    );
  });

  it("rejects a declaration change during rebuild (#8103)", () => {
    const recordedOwner = owner(declaration());

    expect(() =>
      resolveGatewayRebuildAuthority(target, {
        hasPackagedService: () => false,
        loadDeclaration: () => ({ ok: true, declaration: null, source: null }),
        loadSession: () => checkpointSession(recordedOwner),
      }),
    ).toThrow(
      /authority changed since onboarding.*sandbox rebuild will not perform gateway effects/,
    );
  });
});
