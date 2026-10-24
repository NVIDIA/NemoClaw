// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";

import { setProviderCommandRuntimeHooksForTest } from "../../adapters/openshell/provider-command";
import { ensureMcpBridgeProviderProfile, mcpBridgeProviderType } from "./mcp-bridge-provider";

const CREDENTIAL = "GITHUB_TOKEN";
const MCP_BRIDGE_PROVIDER_TYPE = mcpBridgeProviderType(CREDENTIAL);

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
    credentials: [
      {
        name: CREDENTIAL,
        env_vars: [CREDENTIAL],
        required: true,
        auth_style: "bearer",
        header_name: "Authorization",
        query_param: "",
      },
    ],
    endpoints: [],
    binaries: [],
    inference_capable: inferenceCapable,
  });
}

describe("OpenShell MCP provider profile", () => {
  it("imports the endpointless profile before managed provider use", async () => {
    let generatedPath = "";
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "provider profile not found" })
      .mockImplementationOnce((args: string[]) => {
        generatedPath = args[4];
        const profile = JSON.parse(readFileSync(generatedPath, "utf8"));
        expect(profile).toMatchObject(
          JSON.parse(exportedEndpointlessProfile(MCP_BRIDGE_PROVIDER_TYPE, false)),
        );
        return { status: 0, stdout: "Imported", stderr: "" };
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: exportedEndpointlessProfile(MCP_BRIDGE_PROVIDER_TYPE, false),
        stderr: "",
      });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    await expect(
      ensureMcpBridgeProviderProfile(runtimeSelection, CREDENTIAL),
    ).resolves.toBeUndefined();
    expect(runOpenshell).toHaveBeenCalledTimes(3);
    expect(existsSync(generatedPath)).toBe(false);
    expect(runOpenshell).toHaveBeenCalledWith(
      [
        "provider",
        "profile",
        "import",
        "--file",
        expect.stringMatching(/nemoclaw-mcp-profile-[^/]+\/profile\.json$/),
      ],
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

    await expect(
      ensureMcpBridgeProviderProfile(runtimeSelection, CREDENTIAL),
    ).resolves.toBeUndefined();
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "profile", "export", MCP_BRIDGE_PROVIDER_TYPE, "--output", "json"],
      expect.any(Object),
    );
  });

  it.each([
    ["endpoint authority", { endpoints: [{ host: "other.example", port: 443 }] }],
    ["missing credential declaration", { credentials: [] }],
    ["inference authority", { inference_capable: true }],
    [
      "workload files",
      { files: [{ path: "client.yaml", content: "unowned", env_var: "CLIENT_CONFIG" }] },
    ],
  ] as const)("rejects an existing profile that supplies unowned %s", async (_name, unowned) => {
    const runOpenshell = vi.fn().mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        ...JSON.parse(exportedEndpointlessProfile(MCP_BRIDGE_PROVIDER_TYPE, false)),
        ...unowned,
      }),
      stderr: "",
    });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    await expect(ensureMcpBridgeProviderProfile(runtimeSelection, CREDENTIAL)).rejects.toThrow(
      /does not match NemoClaw's endpointless credential contract/,
    );
    expect(runOpenshell).toHaveBeenCalledOnce();
  });

  it("suppresses MCP profile import output at the bridge error boundary", async () => {
    const secret = "mcp-import-secret-must-not-leak";
    let generatedPath = "";
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "provider profile not found" })
      .mockImplementationOnce((args: string[]) => {
        generatedPath = args[4];
        return { status: 1, stdout: "", stderr: `import rejected: ${secret}` };
      });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    let message = "";
    try {
      await ensureMcpBridgeProviderProfile(runtimeSelection, CREDENTIAL);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      `Could not import OpenShell provider profile '${MCP_BRIDGE_PROVIDER_TYPE}'.`,
    );
    expect(message).not.toContain(secret);
    expect(message).not.toContain("import rejected");
    expect(generatedPath).not.toBe("");
    expect(existsSync(generatedPath)).toBe(false);
  });

  it("fails closed when the MCP profile cannot be exported", async () => {
    const runOpenshell = vi.fn().mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "export rejected",
    });
    setProviderCommandRuntimeHooksForTest({ runOpenshell: runOpenshell as never });

    await expect(ensureMcpBridgeProviderProfile(runtimeSelection, CREDENTIAL)).rejects.toThrow(
      /nemoclaw-mcp-v1.*could not be exported for validation/u,
    );
    expect(runOpenshell).toHaveBeenCalledOnce();
  });
});
