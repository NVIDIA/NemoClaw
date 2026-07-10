// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertMcpCredentialBoundaryRuntimeVersion,
  MCP_CREDENTIAL_BOUNDARY_OPENSHELL_VERSION,
  McpCredentialBoundaryRuntimeVersionError,
} from "./mcp-bridge-validation";
import childVisibleCredentialManifest from "./openshell-child-visible-credentials.v0.0.72.json";

function matchingOpenshellRuntime() {
  return {
    resolveOpenshell: () => "/test/openshell",
    runVersionCommand: () => ({
      status: 0,
      stdout: "openshell 0.0.72\n",
      stderr: "",
    }),
  };
}

function captureRuntimeVersionError(validate: () => void) {
  try {
    validate();
  } catch (error) {
    expect(error).toBeInstanceOf(McpCredentialBoundaryRuntimeVersionError);
    expect(error).toMatchObject({ exitCode: 1 });
    return error as McpCredentialBoundaryRuntimeVersionError;
  }
  throw new Error("expected runtime version validation to fail");
}

describe("MCP credential-boundary runtime validation", () => {
  it("requires the runtime version to match the credential manifest (#6426)", () => {
    expect(() =>
      assertMcpCredentialBoundaryRuntimeVersion(matchingOpenshellRuntime()),
    ).not.toThrow();

    const mismatch = () =>
      assertMcpCredentialBoundaryRuntimeVersion({
        ...matchingOpenshellRuntime(),
        runVersionCommand: () => ({
          status: 0,
          stdout: "openshell 0.0.73\n",
          stderr: "",
        }),
      });
    const error = captureRuntimeVersionError(mismatch);
    expect(error.message).toMatch(
      /expected 0\.0\.72, actual 0\.0\.73 \(version mismatch\)\. Install OpenShell 0\.0\.72, or point NEMOCLAW_OPENSHELL_BIN to that version, then retry\./,
    );
    expect(error).toMatchObject({
      actualVersion: "0.0.73",
      detail: "version mismatch",
      reason: "version-mismatch",
    });
    expect(MCP_CREDENTIAL_BOUNDARY_OPENSHELL_VERSION).toBe(
      childVisibleCredentialManifest.openshellVersion,
    );
  });

  it("fails closed when the runtime binary is missing (#6426)", () => {
    const error = captureRuntimeVersionError(() =>
      assertMcpCredentialBoundaryRuntimeVersion({ resolveOpenshell: () => null }),
    );
    expect(error.message).toMatch(
      /expected 0\.0\.72, actual <missing> \(openshell binary not found\)/,
    );
    expect(error).toMatchObject({
      actualVersion: "<missing>",
      detail: "openshell binary not found",
      reason: "binary-missing",
    });
  });

  it("fails closed when openshell --version cannot be executed (#6426)", () => {
    const error = captureRuntimeVersionError(() =>
      assertMcpCredentialBoundaryRuntimeVersion({
        ...matchingOpenshellRuntime(),
        runVersionCommand: () => ({
          error: Object.assign(new Error("credential-shaped-output-must-not-be-repeated"), {
            code: "EACCES",
          }),
          status: null,
          stdout: "",
          stderr: "",
        }),
      }),
    );
    expect(error).toMatchObject({
      actualVersion: "<unavailable>",
      detail: "openshell --version failed",
      reason: "probe-failed",
    });
    expect(String(error)).not.toContain("credential-shaped-output-must-not-be-repeated");
  });

  it("fails closed with a missing-binary detail when openshell exits ENOENT (#6426)", () => {
    const error = captureRuntimeVersionError(() =>
      assertMcpCredentialBoundaryRuntimeVersion({
        ...matchingOpenshellRuntime(),
        runVersionCommand: () => ({
          error: Object.assign(new Error("credential-shaped-output-must-not-be-repeated"), {
            code: "ENOENT",
          }),
          status: null,
          stdout: "",
          stderr: "",
        }),
      }),
    );
    expect(error).toMatchObject({
      actualVersion: "<unavailable>",
      detail: "openshell binary not found",
      reason: "probe-failed",
    });
    expect(String(error)).not.toContain("credential-shaped-output-must-not-be-repeated");
  });

  it("fails closed when openshell --version exits unsuccessfully (#6426)", () => {
    const deps = {
      ...matchingOpenshellRuntime(),
      runVersionCommand: () => ({
        status: 23,
        stdout: "",
        stderr: "credential-shaped-output-must-not-be-repeated",
      }),
    };
    const error = captureRuntimeVersionError(() => assertMcpCredentialBoundaryRuntimeVersion(deps));
    expect(error.message).toMatch(
      /expected 0\.0\.72, actual <unavailable> \(openshell --version exited with status 23\)/,
    );
    expect(error).toMatchObject({
      actualVersion: "<unavailable>",
      detail: "openshell --version exited with status 23",
      reason: "probe-nonzero",
    });
    expect(String(error)).not.toContain("credential-shaped-output-must-not-be-repeated");
  });

  it("fails closed without reflecting unparseable version output (#6426)", () => {
    const deps = {
      ...matchingOpenshellRuntime(),
      runVersionCommand: () => ({
        status: 0,
        stdout: "not-a-version credential-shaped-output-must-not-be-repeated\n",
        stderr: "",
      }),
    };
    const error = captureRuntimeVersionError(() => assertMcpCredentialBoundaryRuntimeVersion(deps));
    expect(error.message).toMatch(
      /expected 0\.0\.72, actual <unparseable> \(invalid openshell --version output\)/,
    );
    expect(error).toMatchObject({
      actualVersion: "<unparseable>",
      detail: "invalid openshell --version output",
      reason: "unparseable-output",
    });
    expect(String(error)).not.toContain("credential-shaped-output-must-not-be-repeated");
  });
});
