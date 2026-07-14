// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { GatewayManagementDeclaration } from "./gateway-management";
import {
  assertGatewayEffectAllowed,
  describeGatewayOwner,
  evaluateGatewayAttachment,
  type GatewayAttachmentProbe,
  type GatewayLifecycleEffect,
  GatewayOwnershipError,
  resolveGatewayOwner,
} from "./gateway-ownership";

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
  requiredCapabilities: ["sandbox.create"],
};

const externalOwner = resolveGatewayOwner({
  declaration: externalDeclaration,
  hasPackagedService: false,
});

function probe(overrides: Partial<GatewayAttachmentProbe> = {}): GatewayAttachmentProbe {
  return {
    httpReady: true,
    portOccupied: true,
    listenerPids: [4242],
    listenerScanComplete: true,
    supervisorActive: true,
    listenerExecPath: "/usr/local/bin/openshell-gateway",
    ...overrides,
  };
}

describe("gateway owner resolution", () => {
  it("treats a declaration as the lifecycle authority (#6576)", () => {
    expect(externalOwner).toEqual({
      mode: "externally-supervised",
      source: "declared",
      endpoint: "http://127.0.0.1:8080",
      stateDir: "/var/lib/openshell/gateway",
      supervisor: externalDeclaration.supervisor,
      requiredCapabilities: ["sandbox.create"],
    });
  });

  it("owns the packaged service when nothing is declared and it is installed (#6576)", () => {
    expect(resolveGatewayOwner({ declaration: null, hasPackagedService: true })).toMatchObject({
      mode: "nemoclaw-managed",
      source: "packaged-service",
    });
  });

  it("falls back to standalone self-management only when nothing is declared (#6576)", () => {
    expect(resolveGatewayOwner({ declaration: null, hasPackagedService: false })).toMatchObject({
      mode: "nemoclaw-managed",
      source: "standalone",
    });
  });
});

describe("gateway lifecycle effect enforcement", () => {
  const effects: GatewayLifecycleEffect[] = [
    "start",
    "stop",
    "restart",
    "destroy",
    "replace",
    "standalone-fallback",
  ];

  it.each(effects)("refuses to %s an externally supervised gateway (#6576)", (effect) => {
    expect(() => assertGatewayEffectAllowed(externalOwner, effect)).toThrow(GatewayOwnershipError);
    try {
      assertGatewayEffectAllowed(externalOwner, effect);
    } catch (error) {
      expect((error as GatewayOwnershipError).code).toBe("external_supervision_forbids_effect");
      expect((error as GatewayOwnershipError).message).toContain("openshell-gateway.service");
    }
  });

  it.each(effects)("permits %s when NemoClaw owns the lifecycle (#6576)", (effect) => {
    const owner = resolveGatewayOwner({ declaration: null, hasPackagedService: true });

    expect(() => assertGatewayEffectAllowed(owner, effect)).not.toThrow();
  });
});

describe("externally supervised gateway attachment", () => {
  it("attaches to a healthy gateway held by the declared supervisor (#6576)", () => {
    expect(evaluateGatewayAttachment(externalOwner, probe())).toEqual({
      ok: true,
      owner: externalOwner,
    });
  });

  it("fails when a competing listener also holds the port (#6576)", () => {
    const result = evaluateGatewayAttachment(externalOwner, probe({ listenerPids: [4242, 4243] }));

    expect(result).toMatchObject({ ok: false, code: "multiple_owners" });
  });

  it("fails when the declared supervisor is inactive rather than starting the gateway (#6576)", () => {
    const result = evaluateGatewayAttachment(externalOwner, probe({ supervisorActive: false }));

    expect(result).toMatchObject({ ok: false, code: "supervisor_inactive" });
    expect(result.ok === false && result.message).toMatch(
      /does not start an externally supervised/,
    );
  });

  it("fails instead of launching a gateway when nothing holds the port (#6576)", () => {
    const result = evaluateGatewayAttachment(
      externalOwner,
      probe({ portOccupied: false, listenerPids: [], httpReady: false }),
    );

    expect(result).toMatchObject({ ok: false, code: "gateway_unreachable" });
    expect(result.ok === false && result.message).toMatch(/will not start a competing gateway/);
  });

  it("fails when an unrecognized process holds the gateway port (#6576)", () => {
    const result = evaluateGatewayAttachment(
      externalOwner,
      probe({ listenerPids: [], listenerExecPath: null }),
    );

    expect(result).toMatchObject({ ok: false, code: "unknown_listener" });
  });

  it("fails when the listener set cannot be fully enumerated (#6576)", () => {
    const result = evaluateGatewayAttachment(externalOwner, probe({ listenerScanComplete: false }));

    expect(result).toMatchObject({ ok: false, code: "unknown_listener" });
  });

  it("fails when the running gateway is not the declared executable (#6576)", () => {
    const result = evaluateGatewayAttachment(
      externalOwner,
      probe({ listenerExecPath: "/opt/brev/bin/openshell-gateway" }),
    );

    expect(result).toMatchObject({ ok: false, code: "identity_mismatch" });
  });

  it("fails when the listener identity cannot be verified against the declaration (#6576)", () => {
    const result = evaluateGatewayAttachment(externalOwner, probe({ listenerExecPath: null }));

    expect(result).toMatchObject({ ok: false, code: "unknown_listener" });
  });

  it("fails when the supervised gateway does not answer a health check (#6576)", () => {
    const result = evaluateGatewayAttachment(externalOwner, probe({ httpReady: false }));

    expect(result).toMatchObject({ ok: false, code: "gateway_unreachable" });
    expect(result.ok === false && result.message).toMatch(/will not replace it/);
  });

  it("does not gate a NemoClaw-managed gateway on attachment checks (#6576)", () => {
    const owner = resolveGatewayOwner({ declaration: null, hasPackagedService: true });

    expect(
      evaluateGatewayAttachment(owner, probe({ portOccupied: false, listenerPids: [] })),
    ).toMatchObject({ ok: true });
  });
});

describe("gateway owner diagnostics", () => {
  it("reports the owner identity without exposing credentials (#6576)", () => {
    expect(describeGatewayOwner(externalOwner)).toEqual({
      mode: "externally-supervised",
      source: "declared",
      endpoint: "http://127.0.0.1:8080/",
      supervisor: {
        kind: "systemd-system",
        serviceName: "openshell-gateway.service",
        execPath: "/usr/local/bin/openshell-gateway",
      },
      requiredCapabilities: ["sandbox.create"],
    });
  });

  it("omits an endpoint that was never declared (#6576)", () => {
    const owner = resolveGatewayOwner({ declaration: null, hasPackagedService: false });

    expect(describeGatewayOwner(owner)).toMatchObject({
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      supervisor: null,
    });
  });
});
