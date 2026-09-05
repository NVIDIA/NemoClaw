// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { setProviderCommandRuntimeHooksForTest } from "../../adapters/openshell/provider-command";
import {
  getMcpProviderInspectionRuntimeSelection,
  inspectMcpProvider,
} from "./mcp-bridge-provider-inspection";

const temporaryDirectories: string[] = [];

afterEach(() => {
  setProviderCommandRuntimeHooksForTest({});
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function writeClientTlsBundle(localTlsDir: string): void {
  fs.mkdirSync(path.join(localTlsDir, "client"), { recursive: true });
  fs.writeFileSync(path.join(localTlsDir, "ca.crt"), "ca");
  fs.writeFileSync(path.join(localTlsDir, "client", "tls.crt"), "cert");
  fs.writeFileSync(path.join(localTlsDir, "client", "tls.key"), "key");
}

function writeExternalGatewayDeclaration(home: string, endpoint: string, stateDir: string): string {
  const declarationPath = path.join(home, "gateway-management.json");
  fs.writeFileSync(
    declarationPath,
    JSON.stringify({
      version: 1,
      mode: "externally-supervised",
      endpoint,
      stateDir,
      supervisor: {
        kind: "systemd-user",
        serviceName: "openshell-gateway.service",
        execPath: "/usr/bin/openshell-gateway",
      },
      requiredCapabilities: [],
    }),
  );
  return declarationPath;
}

describe("MCP provider runtime selection", () => {
  it("binds a nondefault managed gateway to its own client TLS directory (#10514)", () => {
    const home = temporaryDirectory("nemoclaw-provider-runtime-");
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/tmp/ambient-gateway-tls");
    const localTlsDir = path.join(
      home,
      ".local",
      "state",
      "nemoclaw",
      "openshell-docker-gateway-8091",
      "tls",
    );
    writeClientTlsBundle(localTlsDir);

    expect(
      getMcpProviderInspectionRuntimeSelection({
        name: "alpha",
        gatewayName: "nemoclaw-8091",
        gatewayPort: 8091,
      }),
    ).toEqual({
      gatewayName: "nemoclaw-8091",
      localTlsDir,
      workspace: "default",
    });
  });

  it("uses the declared state directory for an external HTTPS gateway (#10514)", () => {
    const home = temporaryDirectory("nemoclaw-provider-runtime-");
    const stateDir = path.join(home, "external-gateway");
    const localTlsDir = path.join(stateDir, "tls");
    writeClientTlsBundle(localTlsDir);
    const declarationPath = writeExternalGatewayDeclaration(
      home,
      "https://127.0.0.1:8091",
      stateDir,
    );
    vi.stubEnv("HOME", home);
    vi.stubEnv("NEMOCLAW_GATEWAY_MANAGEMENT", declarationPath);
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/tmp/ambient-gateway-tls");

    expect(
      getMcpProviderInspectionRuntimeSelection({
        name: "alpha",
        gatewayName: "nemoclaw-8091",
        gatewayPort: 8091,
      }),
    ).toEqual({
      gatewayName: "nemoclaw-8091",
      localTlsDir,
      workspace: "default",
    });
  });

  it("omits client TLS for an external HTTP gateway (#10514)", () => {
    const home = temporaryDirectory("nemoclaw-provider-runtime-");
    const stateDir = path.join(home, "external-gateway");
    const declarationPath = writeExternalGatewayDeclaration(
      home,
      "http://127.0.0.1:8091",
      stateDir,
    );
    vi.stubEnv("HOME", home);
    vi.stubEnv("NEMOCLAW_GATEWAY_MANAGEMENT", declarationPath);

    expect(
      getMcpProviderInspectionRuntimeSelection({
        name: "alpha",
        gatewayName: "nemoclaw-8091",
        gatewayPort: 8091,
      }),
    ).toEqual({ gatewayName: "nemoclaw-8091", workspace: "default" });
  });

  it("refuses an incomplete external HTTPS client bundle (#10514)", () => {
    const home = temporaryDirectory("nemoclaw-provider-runtime-");
    const stateDir = path.join(home, "external-gateway");
    const localTlsDir = path.join(stateDir, "tls");
    writeClientTlsBundle(localTlsDir);
    fs.rmSync(path.join(localTlsDir, "client", "tls.key"));
    const declarationPath = writeExternalGatewayDeclaration(
      home,
      "https://127.0.0.1:8091",
      stateDir,
    );
    vi.stubEnv("HOME", home);
    vi.stubEnv("NEMOCLAW_GATEWAY_MANAGEMENT", declarationPath);

    expect(() =>
      getMcpProviderInspectionRuntimeSelection({
        name: "alpha",
        gatewayName: "nemoclaw-8091",
        gatewayPort: 8091,
      }),
    ).toThrow("client/tls.key");
  });
});

describe("MCP provider absence inspection", () => {
  it("accepts only an exact provider-specific absence diagnostic (#10514)", () => {
    setProviderCommandRuntimeHooksForTest({
      runOpenshell: (() => ({
        status: 1,
        stdout: "",
        stderr: "provider 'alpha-mcp-fake' not found",
      })) as never,
    });

    expect(inspectMcpProvider("alpha-mcp-fake")).toEqual({
      exists: false,
      id: null,
      resourceVersion: null,
      type: null,
      credentialKeys: null,
    });
  });

  it.each([
    "NotFound",
    "NotFound: provider",
    "provider 'other-mcp-fake' not found",
    'status: NotFound, message: "gateway not found"',
    "workspace 'default' does not exist",
    "transport unavailable",
  ])("keeps ambiguous lookup failure indeterminate: %s (#10514)", (diagnostic) => {
    setProviderCommandRuntimeHooksForTest({
      runOpenshell: (() => ({ status: 1, stdout: "", stderr: diagnostic })) as never,
    });

    expect(inspectMcpProvider("alpha-mcp-fake")).toMatchObject({
      exists: null,
      error: diagnostic,
    });
  });

  it.each([null, 2])(
    "keeps exact-looking absence indeterminate for noncanonical exit %s (#10514)",
    (status) => {
      setProviderCommandRuntimeHooksForTest({
        runOpenshell: (() => ({
          status,
          stdout: "",
          stderr: "provider 'alpha-mcp-fake' not found",
        })) as never,
      });

      expect(inspectMcpProvider("alpha-mcp-fake")).toMatchObject({
        exists: null,
        error: "provider 'alpha-mcp-fake' not found",
      });
    },
  );
});
