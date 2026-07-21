// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../adapters/openshell/runtime", () => ({
  captureOpenshell: vi.fn(),
}));

vi.mock("../auto-pair-approval", () => ({
  runSandboxAutoPairApprovalPass: vi.fn(),
}));

import { captureOpenshell } from "../../../adapters/openshell/runtime";
import { runSandboxAutoPairApprovalPass } from "../auto-pair-approval";
import {
  buildGatewayAdminRpcShell,
  callOpenclawGateway,
  GATEWAY_ADMIN_RPC_SCRIPT,
} from "./gateway-rpc";

const captureMock = captureOpenshell as unknown as ReturnType<typeof vi.fn>;
const autoPairMock = runSandboxAutoPairApprovalPass as unknown as ReturnType<typeof vi.fn>;

function captureResult(
  status: number,
  output: string,
  streams: { stdout?: string; stderr?: string } = {},
) {
  return { status, output, ...streams, error: undefined as Error | undefined };
}

function gatewayScriptHarness(envLines: string[]): string {
  return [
    "const Module = require('node:module');",
    "const originalRequire = Module.prototype.require;",
    "Module.prototype.require = function patchedRequire(id) {",
    "  if (id === 'node:fs') {",
    "    return { accessSync() { throw new Error('openclaw lookup should not run'); }, constants: { X_OK: 1 }, realpathSync() { throw new Error('realpath should not run'); } };",
    "  }",
    "  return originalRequire.apply(this, arguments);",
    "};",
    ...envLines,
    `import("data:text/javascript;base64,${Buffer.from(GATEWAY_ADMIN_RPC_SCRIPT, "utf8").toString("base64")}");`,
  ].join("\n");
}

let processExitSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  captureMock.mockReset();
  autoPairMock.mockReset();
  processExitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit:${code ?? 0}`);
  });
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  processExitSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

describe("callOpenclawGateway", () => {
  it("runs the bounded auto-pair pass before dispatching the gateway RPC", () => {
    captureMock.mockReturnValue(captureResult(0, '{"ok":true,"key":"agent:main:main"}'));

    const result = callOpenclawGateway({
      sandboxName: "alpha",
      method: "sessions.reset",
      params: { key: "agent:main:main", reason: "reset" },
    });

    expect(autoPairMock).toHaveBeenCalledTimes(1);
    expect(autoPairMock).toHaveBeenCalledWith("alpha");
    expect(captureMock).toHaveBeenCalledTimes(1);
    const command = captureMock.mock.calls[0]?.[0];
    expect(command).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--",
      "bash",
      "-lc",
      expect.stringContaining("set -e"),
      "nemoclaw-sessions-admin-rpc",
      GATEWAY_ADMIN_RPC_SCRIPT,
      "sessions.reset",
      Buffer.from('{"key":"agent:main:main","reason":"reset"}', "utf8").toString("base64"),
    ]);
    const shell = String(command?.[7] ?? "");
    expect(shell).toContain("\n");
    expect(shell).toContain("node --input-type=module");
    expect(shell).toContain("NEMOCLAW_GATEWAY_RPC_METHOD");
    expect(shell).toContain("NEMOCLAW_GATEWAY_RPC_PARAMS_B64");
    expect(shell).toContain("proxy_env='/tmp/nemoclaw-proxy-env.sh'");
    expect(shell).toContain('[ -L "$proxy_env" ]');
    expect(shell).toContain("expected root:444");
    expect(shell).toContain('. "$proxy_env"');
    const script = String(command?.[9] ?? "");
    expect(script).toContain("callGatewayFromCli");
    expect(script).toContain("requireCanonicalGatewayPort");
    expect(script).toContain("url: `ws://127.0.0.1:${port}`");
    expect(script).toContain('clientName: "gateway-client"');
    expect(script).toContain('mode: "backend"');
    expect(script).toContain('scopes: ["operator.admin"]');
    expect(captureMock.mock.calls[0]?.[1]).toMatchObject({
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
    });
    expect(result.payload).toMatchObject({ ok: true, key: "agent:main:main" });
  });

  it("runs a second auto-pair pass and retries once for pairing-pending failures", () => {
    captureMock
      .mockReturnValueOnce(
        captureResult(
          1,
          "GatewayClientRequestError: scope upgrade pending approval (requestId: r-1)",
        ),
      )
      .mockReturnValueOnce(captureResult(0, '{"ok":true,"key":"agent:main:main"}'));

    const result = callOpenclawGateway({
      sandboxName: "alpha",
      method: "sessions.reset",
      params: { key: "agent:main:main", reason: "reset" },
    });

    expect(autoPairMock).toHaveBeenCalledTimes(2);
    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(result.payload).toMatchObject({ ok: true, key: "agent:main:main" });
  });

  it("sends the gateway shell and module source byte-exactly as multiline OpenShell arguments", () => {
    captureMock.mockReturnValue(captureResult(0, '{"ok":true,"key":"agent:main:main"}'));

    callOpenclawGateway({
      sandboxName: "alpha",
      method: "sessions.reset",
      params: { key: "agent:main:main", reason: "reset" },
    });

    const command = (captureMock.mock.calls[0]?.[0] ?? []) as string[];
    expect(command.every((arg) => typeof arg === "string")).toBe(true);
    expect(command[7]).toBe(buildGatewayAdminRpcShell());
    expect(command[7]).toContain("\n");
    expect(command[9]).toBe(GATEWAY_ADMIN_RPC_SCRIPT);
    expect(
      command.filter((_, index) => index !== 7 && index !== 9).every((arg) => !/[\n\r]/.test(arg)),
    ).toBe(true);
  });

  it("validates the sourced proxy env file before invoking sessions admin RPC", () => {
    captureMock.mockReturnValue(captureResult(0, '{"ok":true,"key":"agent:main:main"}'));

    callOpenclawGateway({
      sandboxName: "alpha",
      method: "sessions.reset",
      params: { key: "agent:main:main", reason: "reset" },
    });

    const shell = buildGatewayAdminRpcShell();
    const sourceIndex = shell.indexOf('. "$proxy_env"');
    const execIndex = shell.indexOf("exec node --input-type=module");
    expect(sourceIndex).toBeGreaterThan(-1);
    expect(execIndex).toBeGreaterThan(sourceIndex);
    expect(shell).toContain('[ -L "$proxy_env" ] || [ ! -f "$proxy_env" ]');
    expect(shell).toContain("exit 126");
    expect(shell).toContain("mode=$perms (expected root:444)");
  });

  it("refuses unsafe proxy env before launching node", () => {
    const dir = mkdtempSync(join(tmpdir(), "nemoclaw-gateway-rpc-"));
    const target = join(dir, "target-env.sh");
    const proxyEnv = join(dir, "proxy-env.sh");
    symlinkSync(target, proxyEnv);
    try {
      const shell = buildGatewayAdminRpcShell(proxyEnv);
      const result = spawnSync(
        "bash",
        [
          "-lc",
          shell,
          "test-shell",
          "throw new Error('node should not run')",
          "sessions.reset",
          "e30=",
        ],
        { encoding: "utf8" },
      );

      // Login-shell teardown hooks may replace the explicit 126 status, but
      // the security rejection must remain non-zero and happen before Node.
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("[SECURITY]");
      expect(result.stderr).toContain("expected regular root-owned mode 444 file");
      expect(result.stderr).not.toContain("node should not run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed gateway ports before loading OpenClaw or using the gateway token", () => {
    const script = gatewayScriptHarness([
      'process.env.NEMOCLAW_GATEWAY_RPC_METHOD = "sessions.reset";',
      'process.env.NEMOCLAW_GATEWAY_RPC_PARAMS_B64 = "e30=";',
      'process.env.OPENCLAW_GATEWAY_TOKEN = "secret-gateway-token";',
      'process.env.OPENCLAW_GATEWAY_PORT = "18789@attacker.example";',
    ]);

    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENCLAW_GATEWAY_PORT must be a canonical TCP port");
    expect(result.stderr).not.toContain("secret-gateway-token");
    expect(result.stderr).not.toContain("openclaw lookup should not run");
  });

  it("rejects unsupported script methods before loading OpenClaw or using the gateway token", () => {
    const script = gatewayScriptHarness([
      'process.env.NEMOCLAW_GATEWAY_RPC_METHOD = "devices.approve";',
      'process.env.NEMOCLAW_GATEWAY_RPC_PARAMS_B64 = "e30=";',
      'process.env.OPENCLAW_GATEWAY_TOKEN = "secret-gateway-token";',
      'process.env.OPENCLAW_GATEWAY_PORT = "18789";',
    ]);

    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsupported gateway RPC method: devices.approve");
    expect(result.stderr).not.toContain("secret-gateway-token");
    expect(result.stderr).not.toContain("openclaw lookup should not run");
  });

  it("rejects unsupported gateway admin RPC methods before touching OpenShell", () => {
    expect(() =>
      callOpenclawGateway({
        sandboxName: "alpha",
        method: "devices.approve",
        params: { requestId: "r-1" },
      } as never),
    ).toThrow(/process\.exit:1/);

    expect(autoPairMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "  Refusing unsupported OpenClaw gateway admin RPC method 'devices.approve' for sandbox 'alpha'.",
    );
  });

  it("does not retry unrelated gateway failures", () => {
    captureMock.mockReturnValue(captureResult(1, "openclaw gateway crashed"));

    expect(() =>
      callOpenclawGateway({
        sandboxName: "alpha",
        method: "sessions.reset",
        params: { key: "agent:main:main", reason: "reset" },
      }),
    ).toThrow(/process\.exit:1/);

    expect(autoPairMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-pairing GatewayClientRequestError failures", () => {
    captureMock.mockReturnValue(captureResult(1, "GatewayClientRequestError: invalid params"));

    expect(() =>
      callOpenclawGateway({
        sandboxName: "alpha",
        method: "sessions.reset",
        params: { key: "agent:main:main", reason: "reset" },
      }),
    ).toThrow(/process\.exit:1/);

    expect(autoPairMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it("parses stdout payload before trailing stderr JSON diagnostics", () => {
    captureMock.mockReturnValue(
      captureResult(
        0,
        '{"ok":true,"key":"agent:main:main"}\n{"error":{"message":"stderr warning"}}',
        {
          stdout: '{"ok":true,"key":"agent:main:main"}\n',
          stderr: '{"error":{"message":"stderr warning"}}',
        },
      ),
    );

    const result = callOpenclawGateway({
      sandboxName: "alpha",
      method: "sessions.reset",
      params: { key: "agent:main:main", reason: "reset" },
    });

    expect(result.payload).toMatchObject({ ok: true, key: "agent:main:main" });
    expect(result.rawOutput).toBe('{"ok":true,"key":"agent:main:main"}\n');
  });

  it("does not expose stderr tokens through rawOutput on unexpected successful payload", () => {
    captureMock.mockReturnValue(
      captureResult(0, '{"ok":true}\nOPENCLAW_GATEWAY_TOKEN=secret-gateway-token', {
        stdout: '{"ok":true}\n',
        stderr: "OPENCLAW_GATEWAY_TOKEN=secret-gateway-token",
      }),
    );

    const result = callOpenclawGateway({
      sandboxName: "alpha",
      method: "sessions.reset",
      params: { key: "agent:main:main", reason: "reset" },
    });

    expect(result.rawOutput).toBe('{"ok":true}\n');
    expect(result.rawOutput).not.toContain("secret-gateway-token");
    expect(result.diagnosticOutput).not.toContain("secret-gateway-token");
    expect(result.diagnosticOutput).toContain("OPENCLAW_GATEWAY_TOKEN=<REDACTED>");
  });

  it("redacts gateway token-shaped values from captured stderr before printing", () => {
    captureMock.mockReturnValue(
      captureResult(1, "Gateway failed: OPENCLAW_GATEWAY_TOKEN=secret-gateway-token"),
    );

    expect(() =>
      callOpenclawGateway({
        sandboxName: "alpha",
        method: "sessions.reset",
        params: { key: "agent:main:main", reason: "reset" },
      }),
    ).toThrow(/process\.exit:1/);

    const printed = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(printed).not.toContain("secret-gateway-token");
    expect(printed).toContain("OPENCLAW_GATEWAY_TOKEN=<REDACTED>");
  });

  it("redacts JSON token fields from captured stderr before printing", () => {
    captureMock.mockReturnValue(captureResult(1, '{"token":"secret-gateway-token"}'));

    expect(() =>
      callOpenclawGateway({
        sandboxName: "alpha",
        method: "sessions.reset",
        params: { key: "agent:main:main", reason: "reset" },
      }),
    ).toThrow(/process\.exit:1/);

    const printed = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(printed).not.toContain("secret-gateway-token");
    expect(printed).toContain('"token":"<REDACTED>"');
  });
});
