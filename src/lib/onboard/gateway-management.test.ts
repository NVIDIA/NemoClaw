// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  GATEWAY_MANAGEMENT_ENV_VAR,
  loadGatewayManagementDeclaration,
  parseGatewayManagementDeclaration,
} from "./gateway-management";

function externalDeclaration(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

describe("gateway management declaration", () => {
  it("accepts an externally supervised declaration (#6576)", () => {
    const result = parseGatewayManagementDeclaration(
      externalDeclaration({ requiredCapabilities: ["sandbox.create", "gateway.health"] }),
    );

    expect(result).toEqual({
      ok: true,
      declaration: {
        version: 1,
        mode: "externally-supervised",
        endpoint: "http://127.0.0.1:8080",
        stateDir: "/var/lib/openshell/gateway",
        supervisor: {
          kind: "systemd-system",
          serviceName: "openshell-gateway.service",
          execPath: "/usr/local/bin/openshell-gateway",
        },
        requiredCapabilities: ["sandbox.create", "gateway.health"],
      },
    });
  });

  it("accepts a nemoclaw-managed declaration without a supervisor (#6576)", () => {
    const result = parseGatewayManagementDeclaration({
      version: 1,
      mode: "nemoclaw-managed",
    });

    expect(result).toEqual({
      ok: true,
      declaration: {
        version: 1,
        mode: "nemoclaw-managed",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      },
    });
  });

  it("rejects external-only fields on a nemoclaw-managed declaration (#6576)", () => {
    const result = parseGatewayManagementDeclaration({
      version: 1,
      mode: "nemoclaw-managed",
      endpoint: "http://127.0.0.1:31818",
      stateDir: "/home/user/.local/state/nemoclaw/gateway",
    });

    expect(result.ok === false && result.reason).toMatch(/must not be declared/);
  });

  it("rejects an unknown contract version instead of treating it as absent (#6576)", () => {
    const result = parseGatewayManagementDeclaration(externalDeclaration({ version: 2 }));

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toMatch(/unsupported gateway-management contract/);
  });

  it("rejects a supervisor on a nemoclaw-managed declaration (#6576)", () => {
    const result = parseGatewayManagementDeclaration({
      version: 1,
      mode: "nemoclaw-managed",
      supervisor: externalDeclaration().supervisor,
    });

    expect(result.ok === false && result.reason).toMatch(/supervisor must not be declared/);
  });

  it("requires a supervisor when external supervision is declared (#6576)", () => {
    const result = parseGatewayManagementDeclaration(
      externalDeclaration({ supervisor: undefined }),
    );

    expect(result.ok === false && result.reason).toMatch(/supervisor is required/);
  });

  it("requires supervisor.execPath so a listener can be checked against it (#6576)", () => {
    const result = parseGatewayManagementDeclaration(
      externalDeclaration({
        supervisor: { kind: "systemd-system", serviceName: "openshell-gateway.service" },
      }),
    );

    expect(result.ok === false && result.reason).toMatch(
      /supervisor\.execPath must be a non-empty/,
    );
  });

  it("rejects a supervisor unit that could be parsed as a systemctl option (#6576)", () => {
    const result = parseGatewayManagementDeclaration(
      externalDeclaration({
        supervisor: {
          kind: "systemd-system",
          serviceName: "--no-pager.service",
          execPath: "/usr/local/bin/openshell-gateway",
        },
      }),
    );

    expect(result.ok === false && result.reason).toMatch(/must name one systemd/);
  });

  it("rejects unknown fields so credentials cannot ride the contract (#6576)", () => {
    const result = parseGatewayManagementDeclaration(
      externalDeclaration({ apiToken: "sk-live-not-a-real-token" }),
    );

    expect(result.ok === false && result.reason).toMatch(
      /unknown declaration field\(s\): apiToken/,
    );
  });

  it("rejects an endpoint that embeds credentials (#6576)", () => {
    const result = parseGatewayManagementDeclaration(
      externalDeclaration({ endpoint: "http://user:secret@127.0.0.1:8080" }),
    );

    expect(result.ok === false && result.reason).toMatch(/must not embed credentials/);
  });

  it("rejects an endpoint carrying a query string (#6576)", () => {
    const result = parseGatewayManagementDeclaration(
      externalDeclaration({ endpoint: "http://127.0.0.1:8080?token=abc" }),
    );

    expect(result.ok === false && result.reason).toMatch(/query string/);
  });

  it.each([
    ["a remote host", "http://gateway.example.com:8080"],
    ["a DNS-resolved localhost name", "http://localhost:8080"],
    ["a cloud metadata address", "http://169.254.169.254:8080"],
    ["a link-local address", "http://169.254.1.1:8080"],
    ["a non-loopback private address", "http://10.0.0.5:8080"],
  ])("rejects an endpoint pointing at %s, which onboarding would otherwise request (#6576)", (_label, endpoint) => {
    const result = parseGatewayManagementDeclaration(externalDeclaration({ endpoint }));

    expect(result.ok === false && result.reason).toMatch(/not a supported local gateway origin/);
  });

  it("accepts only numeric loopback endpoint hosts (#6576)", () => {
    for (const endpoint of ["http://127.0.0.1:8080", "http://[::1]:8080"]) {
      expect(parseGatewayManagementDeclaration(externalDeclaration({ endpoint }))).toMatchObject({
        ok: true,
      });
    }
  });

  it("rejects a capability this build does not provide (#6576)", () => {
    const result = parseGatewayManagementDeclaration(
      externalDeclaration({ requiredCapabilities: ["gateway.teleport"] }),
    );

    expect(result.ok === false && result.reason).toMatch(/unsupported capability/);
  });

  it("does not echo malformed declaration values in errors (#6576)", () => {
    const secret = "sk-live-not-a-real-token";
    for (const declaration of [
      externalDeclaration({ version: secret }),
      externalDeclaration({ mode: secret }),
      externalDeclaration({ endpoint: secret }),
      externalDeclaration({ requiredCapabilities: [secret] }),
    ]) {
      const result = parseGatewayManagementDeclaration(declaration);
      expect(result).toMatchObject({ ok: false });
      expect(result.ok === false && result.reason).not.toContain(secret);
    }
  });

  it("rejects a relative state directory (#6576)", () => {
    const result = parseGatewayManagementDeclaration(
      externalDeclaration({ stateDir: "relative/state" }),
    );

    expect(result.ok === false && result.reason).toMatch(/absolute path/);
  });
});

describe("gateway management declaration loading", () => {
  it("returns no declaration when nothing is configured (#6576)", () => {
    expect(loadGatewayManagementDeclaration({ env: {} })).toEqual({
      ok: true,
      declaration: null,
      source: null,
    });
  });

  it("loads a declaration from the environment-configured file (#6576)", () => {
    const result = loadGatewayManagementDeclaration({
      env: { [GATEWAY_MANAGEMENT_ENV_VAR]: "/etc/nemoclaw/gateway.json" },
      readFile: () => JSON.stringify(externalDeclaration()),
    });

    expect(result).toMatchObject({ ok: true, source: "file" });
    expect(result.ok === true && result.declaration?.mode).toBe("externally-supervised");
  });

  it("fails closed when the configured file is unreadable (#6576)", () => {
    const result = loadGatewayManagementDeclaration({
      env: { [GATEWAY_MANAGEMENT_ENV_VAR]: "/etc/nemoclaw/gateway.json" },
      readFile: () => {
        throw new Error("ENOENT: no such file");
      },
    });

    expect(result.ok === false && result.reason).toMatch(/could not be read/);
  });

  it("fails closed on malformed JSON rather than self-managing the gateway (#6576)", () => {
    const secret = "sk-live-not-a-real-token";
    const result = loadGatewayManagementDeclaration({
      env: { [GATEWAY_MANAGEMENT_ENV_VAR]: "/etc/nemoclaw/gateway.json" },
      readFile: () => `{ "token": "${secret}"`,
    });

    expect(result.ok === false && result.reason).toMatch(/not valid JSON/);
    expect(result.ok === false && result.reason).not.toContain(secret);
  });

  it("prefers an in-process profile declaration over the environment file (#6576)", () => {
    const result = loadGatewayManagementDeclaration({
      declaration: externalDeclaration(),
      env: { [GATEWAY_MANAGEMENT_ENV_VAR]: "/etc/nemoclaw/gateway.json" },
      readFile: () => {
        throw new Error("must not read the file when a profile declares the mode");
      },
    });

    expect(result).toMatchObject({ ok: true, source: "profile" });
  });
});

describe("supported supervisor kinds (#6576)", () => {
  it("accepts the systemd kinds it can bind a listener to", () => {
    for (const kind of ["systemd-system", "systemd-user"]) {
      expect(
        parseGatewayManagementDeclaration(
          externalDeclaration({
            supervisor: {
              kind,
              serviceName: "openshell-gateway.service",
              execPath: "/usr/local/bin/openshell-gateway",
            },
          }),
        ),
      ).toMatchObject({ ok: true });
    }
  });

  it("rejects the opaque 'external' kind, which could never attach", () => {
    const result = parseGatewayManagementDeclaration(
      externalDeclaration({
        supervisor: {
          kind: "external",
          serviceName: "some-supervisor",
          execPath: "/usr/local/bin/openshell-gateway",
        },
      }),
    );

    expect(result.ok === false && result.reason).toMatch(/supervisor\.kind must be one of/);
  });
});
