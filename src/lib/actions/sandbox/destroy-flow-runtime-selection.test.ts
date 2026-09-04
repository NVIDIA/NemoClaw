// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { expectMcpFinalizeAfterDelete } from "../../../../test/helpers/destroy-flow-test-assertions";
import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";

describe("destroySandbox OpenShell runtime selection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
  });

  it("pins MCP detach, delete, finalize, and cleanup to the selected target", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/hostile/tls");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    const runtimeSelection = {
      gatewayName: "nemoclaw-19080",
      workspace: "default",
      localTlsDir: "/authority/tls",
    };
    const harness = createDestroyHarness({
      mcpServers: ["github", "slack"],
      mcpRuntimeSelection: runtimeSelection,
    });

    await harness.destroySandbox("alpha", { yes: true, cleanupGateway: true });

    expectMcpFinalizeAfterDelete(harness);
    expect(harness.prepareMcpBridgesForDestroySpy).toHaveBeenCalledWith("alpha", {
      force: false,
      runtimeSelection,
    });
    const preflightRunner = harness.selectGatewaySpy.mock.calls[0]?.[2] as
      | ((args: string[], opts?: Record<string, unknown>) => unknown)
      | undefined;
    expect(preflightRunner).toBeTypeOf("function");
    preflightRunner?.(["gateway", "info", "nemoclaw-19080"]);
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["gateway", "info", "nemoclaw-19080"],
      expect.objectContaining({
        replaceEnv: true,
        env: expect.objectContaining({
          OPENSHELL_GATEWAY: "nemoclaw-19080",
          OPENSHELL_WORKSPACE: "default",
          OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
        }),
      }),
    );
    const preflightSandboxListOptions = harness.runOpenshellSpy.mock.calls.find(
      ([args]) => args[0] === "sandbox" && args[1] === "list",
    )?.[1] as { env?: Record<string, string>; replaceEnv?: boolean } | undefined;
    expect(preflightSandboxListOptions).toMatchObject({
      replaceEnv: true,
      env: {
        OPENSHELL_GATEWAY: "nemoclaw-19080",
        OPENSHELL_WORKSPACE: "default",
        OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
      },
    });
    expect(preflightSandboxListOptions?.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "-g", "nemoclaw-19080", "alpha"],
      expect.objectContaining({
        replaceEnv: true,
        env: expect.objectContaining({
          OPENSHELL_GATEWAY: "nemoclaw-19080",
          OPENSHELL_WORKSPACE: "default",
          OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
        }),
      }),
    );
    const deleteOptions = harness.runOpenshellSpy.mock.calls.find(
      ([args]) => args[0] === "sandbox" && args[1] === "delete" && args.at(-1) === "alpha",
    )?.[1] as { env?: Record<string, string> } | undefined;
    expect(deleteOptions?.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");

    const providerDeleteOptions = harness.runOpenshellSpy.mock.calls.find(
      ([args]) => args[0] === "provider" && args[1] === "delete",
    )?.[1] as { env?: Record<string, string>; replaceEnv?: boolean } | undefined;
    expect(providerDeleteOptions).toMatchObject({
      replaceEnv: true,
      env: {
        OPENSHELL_GATEWAY: "nemoclaw-19080",
        OPENSHELL_WORKSPACE: "default",
        OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
      },
    });
    expect(providerDeleteOptions?.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");

    const finalSandboxListOptions = [...harness.captureOpenshellSpy.mock.calls]
      .reverse()
      .find(
        (call) => Array.isArray(call[0]) && call[0][0] === "sandbox" && call[0][1] === "list",
      )?.[1] as { env?: Record<string, string>; replaceEnv?: boolean } | undefined;
    expect(finalSandboxListOptions).toMatchObject({
      replaceEnv: true,
      env: {
        OPENSHELL_GATEWAY: "nemoclaw-19080",
        OPENSHELL_WORKSPACE: "default",
        OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
      },
    });
    expect(finalSandboxListOptions?.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");

    const cleanupRunner = harness.cleanupGatewaySpy.mock.calls[0]?.[1] as
      | ((args: string[], opts?: Record<string, unknown>) => unknown)
      | undefined;
    expect(cleanupRunner).toBeTypeOf("function");
    cleanupRunner?.(["gateway", "info", "nemoclaw-19080"]);
    expect(harness.runOpenshellSpy).toHaveBeenLastCalledWith(
      ["gateway", "info", "nemoclaw-19080"],
      expect.objectContaining({
        replaceEnv: true,
        env: expect.objectContaining({
          OPENSHELL_GATEWAY: "nemoclaw-19080",
          OPENSHELL_WORKSPACE: "default",
          OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
        }),
      }),
    );
  }, 30_000);
});
