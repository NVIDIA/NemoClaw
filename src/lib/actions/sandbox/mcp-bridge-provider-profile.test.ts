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
  it("imports the endpointless profile before managed provider use", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 0, stdout: "Imported", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: exportedEndpointlessProfile("openai", true),
        stderr: "",
      })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 0, stdout: "Imported", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: exportedEndpointlessProfile(MCP_BRIDGE_PROVIDER_TYPE, false),
        stderr: "",
      });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    expect(() => ensureMcpBridgeProviderProfile(runtimeSelection)).not.toThrow();
    expect(runOpenshell).toHaveBeenCalledTimes(6);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "profile", "import", "--file", expect.stringMatching(/openai\.yaml$/)],
      expect.any(Object),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "profile", "import", "--file", expect.stringMatching(/nemoclaw-mcp-v1\.yaml$/)],
      expect.any(Object),
    );
  });

  it("accepts existing profiles only after proving both exact endpointless boundaries", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: exportedEndpointlessProfile("openai", true),
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: exportedEndpointlessProfile(MCP_BRIDGE_PROVIDER_TYPE, false),
        stderr: "",
      });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    expect(() => ensureMcpBridgeProviderProfile(runtimeSelection)).not.toThrow();
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "profile", "export", "openai", "--output", "json"],
      expect.any(Object),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "profile", "export", MCP_BRIDGE_PROVIDER_TYPE, "--output", "json"],
      expect.any(Object),
    );
  });

  it("rejects an existing profile that can supply its own endpoint authority", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: exportedEndpointlessProfile("openai", true),
        stderr: "",
      })
      .mockReturnValueOnce({
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

    expect(() => ensureMcpBridgeProviderProfile(runtimeSelection)).toThrow(
      /does not match NemoClaw's endpointless credential contract/,
    );
  });

  it("fails closed when the gateway-only OpenAI profile cannot be registered", () => {
    const secret = "openai-import-secret-must-not-leak";
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: `import rejected: ${secret}` });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    let message = "";
    try {
      ensureMcpBridgeProviderProfile(runtimeSelection);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(
      "OpenShell could not import the checked-in 'openai' inference provider profile.",
    );
    expect(message).toContain("retry this command");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("import rejected");
    expect(runOpenshell).toHaveBeenCalledTimes(2);
  });

  it("suppresses MCP profile import output at the bridge error boundary", () => {
    const secret = "mcp-import-secret-must-not-leak";
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: exportedEndpointlessProfile("openai", true),
        stderr: "",
      })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: `import rejected: ${secret}` });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    let message = "";
    try {
      ensureMcpBridgeProviderProfile(runtimeSelection);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      `Could not import OpenShell provider profile '${MCP_BRIDGE_PROVIDER_TYPE}'.`,
    );
    expect(message).not.toContain(secret);
    expect(message).not.toContain("import rejected");
  });

  it.each([
    [
      "endpoint authority",
      JSON.stringify({
        id: "openai",
        credentials: [],
        endpoints: [{ host: "api.example.test", port: 443 }],
        binaries: [],
        inference_capable: true,
      }),
    ],
    [
      "credential authority",
      JSON.stringify({
        id: "openai",
        credentials: [{ env: "OPENAI_API_KEY" }],
        endpoints: [],
        binaries: [],
        inference_capable: true,
      }),
    ],
    ["malformed export output", "not-json"],
  ])("rejects an existing OpenAI profile with %s before MCP setup", (_case, stdout) => {
    const runOpenshell = vi.fn().mockReturnValueOnce({ status: 0, stdout, stderr: "" });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    expect(() => ensureMcpBridgeProviderProfile(runtimeSelection)).toThrow(
      /does not match NemoClaw's endpointless inference contract/,
    );
    expect(runOpenshell).toHaveBeenCalledOnce();
    expect(runOpenshell).toHaveBeenLastCalledWith(
      ["provider", "profile", "export", "openai", "--output", "json"],
      expect.any(Object),
    );
  });

  it("fails closed when the OpenAI profile cannot be exported", () => {
    const runOpenshell = vi.fn().mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "export rejected",
    });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    expect(() => ensureMcpBridgeProviderProfile(runtimeSelection)).toThrow(
      /could not be read for validation/,
    );
    expect(runOpenshell).toHaveBeenCalledOnce();
  });

  it("fails closed when the MCP profile cannot be exported", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: exportedEndpointlessProfile("openai", true),
        stderr: "",
      })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "export rejected" });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    expect(() => ensureMcpBridgeProviderProfile(runtimeSelection)).toThrow(
      /nemoclaw-mcp-v1.*could not be exported for validation/u,
    );
    expect(runOpenshell).toHaveBeenCalledTimes(2);
  });
});
