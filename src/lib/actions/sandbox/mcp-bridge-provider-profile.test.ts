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

describe("OpenShell MCP provider profile", () => {
  it("imports the endpointless profile before managed provider use", () => {
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "Imported", stderr: "" }));
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    expect(() => ensureMcpBridgeProviderProfile()).not.toThrow();
    expect(runOpenshell).toHaveBeenCalledOnce();
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "profile", "import", "--file", expect.stringMatching(/nemoclaw-mcp-v1\.yaml$/)],
      expect.any(Object),
    );
  });

  it("accepts an existing profile only after proving the exact endpointless boundary", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "already exists" })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          id: MCP_BRIDGE_PROVIDER_TYPE,
          credentials: [],
          endpoints: [],
          binaries: [],
          inference_capable: false,
        }),
        stderr: "",
      });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    expect(() => ensureMcpBridgeProviderProfile()).not.toThrow();
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
});
