// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import { setProviderCommandRuntimeHooksForTest } from "../../adapters/openshell/provider-command";
import { inspectMcpProvider } from "./mcp-bridge-provider-inspection";

afterEach(() => setProviderCommandRuntimeHooksForTest({}));

describe("MCP provider absence inspection", () => {
  it("accepts only an exact provider-specific absence diagnostic (#10514)", () => {
    setProviderCommandRuntimeHooksForTest({
      runOpenshell: (() => ({
        status: 1,
        stdout: "",
        stderr: "provider 'alpha-mcp-fake' not found",
      })) as never,
    });

    expect(inspectMcpProvider("alpha-mcp-fake")).toMatchObject({ exists: false });
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
