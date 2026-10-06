// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setProviderCommandRuntimeHooksForTest } from "../../adapters/openshell/provider-command";
import { ensureMcpBridgeProviderProfile, MCP_BRIDGE_PROVIDER_TYPE } from "./mcp-bridge-provider";

const runtimeSelection = { gatewayName: "nemoclaw-8080", workspace: "default" };

beforeEach(() => {
  setProviderCommandRuntimeHooksForTest({});
});

afterEach(() => {
  setProviderCommandRuntimeHooksForTest({});
});

function exportedEndpointlessProfile(id: string, inferenceCapable: boolean): string {
  return JSON.stringify({
    id,
    credentials: [],
    endpoints: [],
    binaries: [],
    inference_capable: inferenceCapable,
  });
}

describe("OpenShell MCP provider profile", () => {
  it("imports the endpointless profile before managed provider use", async () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 0, stdout: "Imported", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: exportedEndpointlessProfile(MCP_BRIDGE_PROVIDER_TYPE, false),
        stderr: "",
      });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    await expect(ensureMcpBridgeProviderProfile(runtimeSelection)).resolves.toBeUndefined();
    expect(runOpenshell).toHaveBeenCalledTimes(3);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "profile", "import", "--file", expect.stringMatching(/nemoclaw-mcp-v1\.yaml$/)],
      expect.any(Object),
    );
  });

  it("accepts an existing profile only after proving its exact endpointless boundary", async () => {
    const runOpenshell = vi.fn().mockReturnValueOnce({
      status: 0,
      stdout: exportedEndpointlessProfile(MCP_BRIDGE_PROVIDER_TYPE, false),
      stderr: "",
    });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    await expect(ensureMcpBridgeProviderProfile(runtimeSelection)).resolves.toBeUndefined();
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "profile", "export", MCP_BRIDGE_PROVIDER_TYPE, "--output", "json"],
      expect.any(Object),
    );
  });

  it("rejects an existing profile that can supply its own endpoint authority", async () => {
    const runOpenshell = vi.fn().mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        id: MCP_BRIDGE_PROVIDER_TYPE,
        credentials: [],
        endpoints: [{ host: "other.example", port: 443 }],
        binaries: [],
        inference_capable: false,
      }),
      stderr: "",
    });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    await expect(ensureMcpBridgeProviderProfile(runtimeSelection)).rejects.toThrow(
      /does not match NemoClaw's endpointless credential contract/,
    );
  });

  it("suppresses MCP profile import output at the bridge error boundary", async () => {
    const secret = "mcp-import-secret-must-not-leak";
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: `import rejected: ${secret}` });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    let message = "";
    try {
      await ensureMcpBridgeProviderProfile(runtimeSelection);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      `Could not import OpenShell provider profile '${MCP_BRIDGE_PROVIDER_TYPE}'.`,
    );
    expect(message).not.toContain(secret);
    expect(message).not.toContain("import rejected");
  });

  it("fails closed when the MCP profile cannot be exported", async () => {
    const runOpenshell = vi.fn().mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "export rejected",
    });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    await expect(ensureMcpBridgeProviderProfile(runtimeSelection)).rejects.toThrow(
      /nemoclaw-mcp-v1.*could not be exported for validation/u,
    );
    expect(runOpenshell).toHaveBeenCalledOnce();
  });
});
