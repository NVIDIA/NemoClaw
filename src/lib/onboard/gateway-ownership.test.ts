// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { GatewayManagementDeclaration } from "./gateway-management";
import {
  assertGatewayEffectAllowed,
  cgroupBelongsToUnit,
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
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  declaration: externalDeclaration,
  hasPackagedService: false,
});

function probe(overrides: Partial<GatewayAttachmentProbe> = {}): GatewayAttachmentProbe {
  return {
    gatewayPort: 8080,
    httpReady: true,
    portOccupied: true,
    listenerPids: [4242],
    listenerScanComplete: true,
    listenerStartTime: "710024",
    supervisorActive: true,
    listenerExecPath: "/usr/local/bin/openshell-gateway",
    listenerSupervisorMatch: true,
    ...overrides,
  };
}

describe("gateway owner resolution", () => {
  it("treats a declaration as the lifecycle authority (#6576)", () => {
    expect(externalOwner).toEqual({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "externally-supervised",
      source: "declared",
      endpoint: "http://127.0.0.1:8080",
      stateDir: "/var/lib/openshell/gateway",
      supervisor: externalDeclaration.supervisor,
      requiredCapabilities: ["sandbox.create"],
    });
  });

  it("owns the packaged service when nothing is declared and it is installed (#6576)", () => {
    expect(
      resolveGatewayOwner({
        gatewayName: "nemoclaw",
        gatewayPort: 31818,
        declaration: null,
        hasPackagedService: true,
      }),
    ).toMatchObject({
      mode: "nemoclaw-managed",
      source: "packaged-service",
    });
  });

  it("falls back to standalone self-management only when nothing is declared (#6576)", () => {
    expect(
      resolveGatewayOwner({
        gatewayName: "nemoclaw",
        gatewayPort: 31818,
        declaration: null,
        hasPackagedService: false,
      }),
    ).toMatchObject({
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
    const owner = resolveGatewayOwner({
      gatewayName: "nemoclaw",
      gatewayPort: 31818,
      declaration: null,
      hasPackagedService: true,
    });

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

  it("rejects a declaration whose endpoint port is not the one this process operates (#6576)", () => {
    const result = evaluateGatewayAttachment(externalOwner, probe({ gatewayPort: 31818 }));

    expect(result).toMatchObject({ ok: false, code: "endpoint_port_mismatch" });
    expect(result.ok === false && result.message).toMatch(/port 8080.*port 31818/s);
  });

  it("rejects a required capability this build does not provide (#6576)", () => {
    const owner = {
      ...externalOwner,
      requiredCapabilities: ["gateway.teleport"],
    } as unknown as typeof externalOwner;

    expect(evaluateGatewayAttachment(owner, probe())).toMatchObject({
      ok: false,
      code: "capability_unsupported",
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

  it("fails closed when the declared supervisor status cannot be determined (#6576)", () => {
    const result = evaluateGatewayAttachment(externalOwner, probe({ supervisorActive: null }));

    expect(result).toMatchObject({ ok: false, code: "supervisor_inactive" });
    expect(result.ok === false && result.message).toMatch(/could not be confirmed active/);
  });

  it("fails instead of launching a gateway when nothing holds the port (#6576)", () => {
    const result = evaluateGatewayAttachment(
      externalOwner,
      probe({ portOccupied: false, listenerPids: [], httpReady: false }),
    );

    expect(result).toMatchObject({ ok: false, code: "gateway_unreachable" });
    expect(result.ok === false && result.message).toMatch(/will not start a competing gateway/);
  });

  it("fails when an occupied gateway port has no identifiable listener process (#6576)", () => {
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

  it("rejects a same-binary process that is not part of the declared unit (#6576)", () => {
    // The impostor answers the health probe and runs the declared executable,
    // but its PID is not in the unit's cgroup — the exact gap an exec-path match
    // alone would miss.
    const result = evaluateGatewayAttachment(
      externalOwner,
      probe({ listenerSupervisorMatch: false }),
    );

    expect(result).toMatchObject({ ok: false, code: "identity_mismatch" });
    expect(result.ok === false && result.message).toMatch(/not part of openshell-gateway\.service/);
  });

  it("fails closed when the listener cannot be bound to the declared unit (#6576)", () => {
    const result = evaluateGatewayAttachment(
      externalOwner,
      probe({ listenerSupervisorMatch: null }),
    );

    expect(result).toMatchObject({ ok: false, code: "unknown_listener" });
    expect(result.ok === false && result.message).toMatch(/could not confirm/);
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
    const owner = resolveGatewayOwner({
      gatewayName: "nemoclaw",
      gatewayPort: 31818,
      declaration: null,
      hasPackagedService: true,
    });

    expect(
      evaluateGatewayAttachment(owner, probe({ portOccupied: false, listenerPids: [] })),
    ).toMatchObject({ ok: true });
  });
});

describe("gateway owner diagnostics", () => {
  it("reports the owner identity without exposing credentials (#6576)", () => {
    expect(describeGatewayOwner(externalOwner)).toEqual({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
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
    const owner = resolveGatewayOwner({
      gatewayName: "nemoclaw",
      gatewayPort: 31818,
      declaration: null,
      hasPackagedService: false,
    });

    expect(describeGatewayOwner(owner)).toMatchObject({
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      supervisor: null,
    });
  });
});

describe("cgroupBelongsToUnit", () => {
  const UNIT = "openshell-gateway.service";

  it("matches a cgroup v2 process in the unit's system slice (#6576)", () => {
    expect(cgroupBelongsToUnit(`0::/system.slice/${UNIT}\n`, UNIT, "systemd-system")).toBe(true);
  });

  it("matches a cgroup v1 process listed under the unit (#6576)", () => {
    const v1 = [
      "12:pids:/system.slice/openshell-gateway.service",
      "0:name=systemd:/system.slice/openshell-gateway.service",
    ].join("\n");
    expect(cgroupBelongsToUnit(v1, UNIT, "systemd-system")).toBe(true);
  });

  it("matches a system-manager unit in a custom slice (#6576)", () => {
    expect(
      cgroupBelongsToUnit(`0::/platform.slice/gateways.slice/${UNIT}`, UNIT, "systemd-system"),
    ).toBe(true);
  });

  it("matches a user-manager unit path (#6576)", () => {
    expect(
      cgroupBelongsToUnit(
        `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${UNIT}`,
        UNIT,
        "systemd-user",
      ),
    ).toBe(true);
  });

  it("rejects a same-named user unit for the system manager (#6576)", () => {
    expect(
      cgroupBelongsToUnit(
        `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${UNIT}`,
        UNIT,
        "systemd-system",
      ),
    ).toBe(false);
  });

  it("rejects a same-named system unit for the user manager (#6576)", () => {
    expect(cgroupBelongsToUnit(`0::/system.slice/${UNIT}`, UNIT, "systemd-user")).toBe(false);
  });

  it("rejects a same-binary process in a login session scope (#6576)", () => {
    expect(
      cgroupBelongsToUnit("0::/user.slice/user-1000.slice/session-3.scope", UNIT, "systemd-user"),
    ).toBe(false);
  });

  it("rejects a different unit that merely shares a prefix (#6576)", () => {
    expect(
      cgroupBelongsToUnit("0::/system.slice/openshell-gateway.service.d", UNIT, "systemd-system"),
    ).toBe(false);
  });

  it("rejects empty or unreadable cgroup text (#6576)", () => {
    expect(cgroupBelongsToUnit("", UNIT, "systemd-system")).toBe(false);
  });
});
