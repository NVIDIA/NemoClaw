// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { REPOSITORY_ROOT } from "../core/repository-root";
import {
  ensureMessagingCredentialProviderProfile,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
  messagingCredentialProviderProfilePath,
} from "./provider-profile";

describe("messaging credential provider profile", () => {
  it("resolves the checked-in profile from the source repository root (#9875)", () => {
    expect(messagingCredentialProviderProfilePath(REPOSITORY_ROOT)).toBe(
      path.join(REPOSITORY_ROOT, "nemoclaw-blueprint", "provider-profiles", "nemoclaw-mcp-v1.yaml"),
    );
  });

  it("imports the messaging profile from the checked-in path (#9875)", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          id: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
          credentials: [],
          endpoints: [],
          binaries: [],
          inference_capable: false,
        }),
      });

    ensureMessagingCredentialProviderProfile({ root: "/repo", runOpenshell });

    expect(runOpenshell).toHaveBeenNthCalledWith(
      2,
      [
        "provider",
        "profile",
        "import",
        "--file",
        "/repo/nemoclaw-blueprint/provider-profiles/nemoclaw-mcp-v1.yaml",
      ],
      {
        ignoreError: true,
        suppressOutput: true,
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(runOpenshell).toHaveBeenNthCalledWith(
      3,
      ["provider", "profile", "export", MESSAGING_CREDENTIAL_PROVIDER_TYPE, "--output", "json"],
      {
        ignoreError: true,
        suppressOutput: true,
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  });

  it("reports a fixed messaging import failure without command diagnostics (#9875)", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "provider profile not found" })
      .mockReturnValueOnce({
        status: 1,
        stderr: "request failed with discord-credential-must-not-leak",
      });

    expect(() => ensureMessagingCredentialProviderProfile({ root: "/repo", runOpenshell })).toThrow(
      "Could not import the OpenShell messaging credential profile.",
    );
  });

  it("reports a messaging-specific export failure (#10155)", () => {
    const runOpenshell = vi.fn().mockReturnValueOnce({
      status: 1,
      stderr: "gateway unavailable",
    });

    expect(() => ensureMessagingCredentialProviderProfile({ root: "/repo", runOpenshell })).toThrow(
      `OpenShell provider profile '${MESSAGING_CREDENTIAL_PROVIDER_TYPE}' could not be exported for validation.`,
    );
  });

  it("reports a messaging-specific incompatible-profile failure (#10155)", () => {
    const runOpenshell = vi.fn().mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        id: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
        credentials: [],
        endpoints: ["https://example.invalid"],
        binaries: [],
        inference_capable: false,
      }),
    });

    expect(() => ensureMessagingCredentialProviderProfile({ root: "/repo", runOpenshell })).toThrow(
      /does not match NemoClaw's endpointless messaging credential contract/u,
    );
  });
});
