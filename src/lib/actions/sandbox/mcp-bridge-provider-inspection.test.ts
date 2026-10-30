// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { setProviderCommandRuntimeHooksForTest } from "../../adapters/openshell/provider-command";
import {
  assertSandboxProviderAttachmentCapacity,
  getMcpProviderInspectionRuntimeSelection,
  MAX_SANDBOX_PROVIDER_ATTACHMENTS,
  resolveSandboxConfigRuntimeSelection,
  inspectMcpProvider,
} from "./mcp-bridge-provider-inspection";
import { attachProvider } from "./mcp-bridge-provider-attachments";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import * as gatewayTargets from "./gateway-target";

const temporaryDirectories: string[] = [];
const runtimeSelection = { gatewayName: "nemoclaw-8080", workspace: "default" } as const;

afterEach(() => {
  vi.restoreAllMocks();
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
  it("resolves native config operations from the recorded row despite ambient drift", () => {
    const home = temporaryDirectory("nemoclaw-config-runtime-");
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENSHELL_GATEWAY", "wrong-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "wrong-workspace");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/wrong/tls");
    const localTlsDir = path.join(
      home,
      ".local",
      "state",
      "nemoclaw",
      "openshell-docker-gateway-8091",
      "tls",
    );
    writeClientTlsBundle(localTlsDir);
    const readTarget = vi.spyOn(gatewayTargets, "getKnownSandboxTarget").mockReturnValue({
      name: "alpha",
      gatewayName: "nemoclaw-8091",
      gatewayPort: 8091,
    });
    expect(resolveSandboxConfigRuntimeSelection("alpha")).toEqual({
      gatewayName: "nemoclaw-8091",
      workspace: "default",
      localTlsDir,
    });
    expect(readTarget).toHaveBeenCalledExactlyOnceWith("alpha");
  });

  it("refuses native config access without a recorded sandbox target", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "wrong-gateway");
    vi.spyOn(gatewayTargets, "getKnownSandboxTarget").mockReturnValue(null);
    expect(() => resolveSandboxConfigRuntimeSelection("missing")).toThrow(
      "no recorded runtime target",
    );
  });

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
  it("forwards a caller deadline to the synchronous provider CLI", async () => {
    let observedTimeout: number | undefined;
    setProviderCommandRuntimeHooksForTest({
      runOpenshell: ((_args: string[], options: { timeout?: number }) => {
        observedTimeout = options.timeout;
        return {
          status: 1,
          stdout: "",
          stderr: "provider 'alpha-mcp-fake' not found",
        };
      }) as never,
    });

    await expect(
      inspectMcpProvider("alpha-mcp-fake", runtimeSelection, undefined, 4_321),
    ).resolves.toMatchObject({ exists: false });
    expect(observedTimeout).toBe(4_321);
  });

  it("accepts only an exact provider-specific absence diagnostic (#10514)", async () => {
    setProviderCommandRuntimeHooksForTest({
      runOpenshell: (() => ({
        status: 1,
        stdout: "",
        stderr: "provider 'alpha-mcp-fake' not found",
      })) as never,
    });

    await expect(inspectMcpProvider("alpha-mcp-fake", runtimeSelection)).resolves.toEqual({
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
  ])("keeps ambiguous lookup failure indeterminate: %s (#10514)", async (diagnostic) => {
    setProviderCommandRuntimeHooksForTest({
      runOpenshell: (() => ({ status: 1, stdout: "", stderr: diagnostic })) as never,
    });

    await expect(inspectMcpProvider("alpha-mcp-fake", runtimeSelection)).resolves.toMatchObject({
      exists: null,
      error: expect.any(String),
    });
  });

  it.each([null, 2])(
    "keeps exact-looking absence indeterminate for noncanonical exit %s (#10514)",
    async (status) => {
      setProviderCommandRuntimeHooksForTest({
        runOpenshell: (() => ({
          status,
          stdout: "",
          stderr: "provider 'alpha-mcp-fake' not found",
        })) as never,
      });

      await expect(inspectMcpProvider("alpha-mcp-fake", runtimeSelection)).resolves.toMatchObject({
        exists: null,
        error: expect.any(String),
      });
    },
  );

  it("refuses unattached MCP providers when the sandbox reaches the 32-provider cap", () => {
    const attachments = Array.from({ length: MAX_SANDBOX_PROVIDER_ATTACHMENTS }, (_, index) => ({
      name: index === 0 ? "nvidia-nim" : `alpha-mcp-srv${String(index)}`,
      providerId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      credentialKeys: [index === 0 ? "NVIDIA_API_KEY" : `T_MCP_${String(index)}`],
    }));
    const newEntry: McpSourceEntry = {
      server: "srv32",
      agent: "langchain-deepagents-code",
      adapter: "deepagents-config",
      url: "https://8.8.8.8/mcp/path-32",
      env: ["T_MCP_32"],
      providerName: "alpha-mcp-srv32",
      policyName: "mcp-bridge-srv32",
    };
    const alreadyAttachedEntry: McpSourceEntry = {
      ...newEntry,
      server: "srv31",
      env: ["T_MCP_31"],
      providerName: "alpha-mcp-srv31",
      policyName: "mcp-bridge-srv31",
    };

    expect(() => assertSandboxProviderAttachmentCapacity("alpha", [newEntry], attachments)).toThrow(
      "Sandbox 'alpha' already has 32 attached OpenShell providers (maximum 32 per sandbox across inference, messaging, web search, extra credential, and managed MCP providers).",
    );
    expect(() =>
      assertSandboxProviderAttachmentCapacity("alpha", [alreadyAttachedEntry], attachments),
    ).not.toThrow();
    expect(() =>
      assertSandboxProviderAttachmentCapacity(
        "alpha",
        [newEntry, { ...newEntry, server: "srv33", providerName: "alpha-mcp-srv33" }],
        attachments.slice(0, MAX_SANDBOX_PROVIDER_ATTACHMENTS - 1),
      ),
    ).toThrow(
      "Attaching 2 MCP providers to sandbox 'alpha' would reach 33 attached OpenShell providers",
    );
  });

  it("translates a concurrent gateway provider-cap error during attachProvider", async () => {
    const entry: McpSourceEntry = {
      server: "srv32",
      agent: "langchain-deepagents-code",
      adapter: "deepagents-config",
      url: "https://8.8.8.8/mcp/path-32",
      env: ["T_MCP_32"],
      providerName: "alpha-mcp-srv32",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-srv32",
    };
    const adapter = {
      getProvider: vi.fn(async () => ({
        ok: true as const,
        value: {
          name: "alpha-mcp-srv32",
          type: "nemoclaw-mcp-v1",
          credentialKeys: ["T_MCP_32"],
          configKeys: [],
          revision: { id: "11111111-2222-4333-8444-555555555555", resourceVersion: 1 },
        },
      })),
      attachProvider: vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: "command" as const,
          reason: "failed" as const,
          message:
            "Error: × code: 'Client specified an invalid argument', message: \"providers list exceeds maximum (32)\"",
        },
      })),
      listProviderAttachments: vi.fn(async () => ({
        ok: true as const,
        value: { names: [] },
      })),
    };

    await expect(
      attachProvider("alpha", entry, runtimeSelection, adapter as never),
    ).rejects.toThrow(
      "Sandbox 'alpha' already has 32 attached OpenShell providers (maximum 32 per sandbox across inference, messaging, web search, extra credential, and managed MCP providers).",
    );
  });
});
