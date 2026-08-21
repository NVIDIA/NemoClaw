// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setProviderCommandRuntimeHooksForTest } from "../../adapters/openshell/provider-command";
import { ensureMcpBridgeProviderProfile, MCP_BRIDGE_PROVIDER_TYPE } from "./mcp-bridge-provider";

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
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "Imported", stderr: "" }));
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    expect(() => ensureMcpBridgeProviderProfile()).not.toThrow();
    expect(runOpenshell).toHaveBeenCalledTimes(2);
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
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "already exists" })
      .mockReturnValueOnce({
        status: 0,
        stdout: exportedEndpointlessProfile("openai", true),
        stderr: "",
      })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "already exists" })
      .mockReturnValueOnce({
        status: 0,
        stdout: exportedEndpointlessProfile(MCP_BRIDGE_PROVIDER_TYPE, false),
        stderr: "",
      });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    expect(() => ensureMcpBridgeProviderProfile()).not.toThrow();
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
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "already exists" })
      .mockReturnValueOnce({
        status: 0,
        stdout: exportedEndpointlessProfile("openai", true),
        stderr: "",
      })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "already exists" })
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

    expect(() => ensureMcpBridgeProviderProfile()).toThrow(
      /does not match NemoClaw's endpointless credential contract/,
    );
  });

  it("fails closed when the gateway-only OpenAI profile cannot be registered", () => {
    const runOpenshell = vi.fn(() => ({ status: 1, stdout: "", stderr: "import rejected" }));
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    expect(() => ensureMcpBridgeProviderProfile()).toThrow("import rejected");
    expect(runOpenshell).toHaveBeenCalledOnce();
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
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "already exists" })
      .mockReturnValueOnce({ status: 0, stdout, stderr: "" });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    expect(() => ensureMcpBridgeProviderProfile()).toThrow(
      /does not match NemoClaw's gateway-only endpointless credential contract/,
    );
    expect(runOpenshell).toHaveBeenCalledTimes(2);
    expect(runOpenshell).toHaveBeenLastCalledWith(
      ["provider", "profile", "export", "openai", "--output", "json"],
      expect.any(Object),
    );
  });

  it("fails closed with a distinct diagnostic when an existing OpenAI profile cannot be exported", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "already exists" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "export rejected" });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    expect(() => ensureMcpBridgeProviderProfile()).toThrow(
      /already exists but could not be exported for validation/,
    );
    expect(runOpenshell).toHaveBeenCalledTimes(2);
  });
});
