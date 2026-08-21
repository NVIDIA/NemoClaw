// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import path from "node:path";

import { REPOSITORY_ROOT } from "../core/repository-root";
import {
  ensureMessagingCredentialProviderProfile,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
  messagingCredentialProviderProfilePath,
} from "./provider-profile";

const EXPECTED_PROFILE = JSON.stringify({
  id: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
  credentials: [],
  endpoints: [],
  binaries: [],
  inference_capable: false,
});

describe("messaging credential provider profile", () => {
  it("resolves the checked-in profile from the source repository root (#9875)", () => {
    expect(messagingCredentialProviderProfilePath(REPOSITORY_ROOT)).toBe(
      path.join(REPOSITORY_ROOT, "nemoclaw-blueprint", "provider-profiles", "nemoclaw-mcp-v1.yaml"),
    );
  });

  it("imports the endpointless profile from the checked-in path (#9875)", () => {
    const runOpenshell = vi.fn(() => ({ status: 0 }));

    ensureMessagingCredentialProviderProfile({
      root: "/repo",
      runOpenshell,
    });

    expect(runOpenshell).toHaveBeenCalledOnce();
    expect(runOpenshell).toHaveBeenCalledWith(
      [
        "provider",
        "profile",
        "import",
        "--file",
        "/repo/nemoclaw-blueprint/provider-profiles/nemoclaw-mcp-v1.yaml",
      ],
      { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("validates an existing profile before accepting it (#9875)", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "profile already exists" })
      .mockReturnValueOnce({ status: 0, stdout: EXPECTED_PROFILE });

    expect(() =>
      ensureMessagingCredentialProviderProfile({
        root: "/repo",
        runOpenshell,
      }),
    ).not.toThrow();

    expect(runOpenshell).toHaveBeenNthCalledWith(
      2,
      ["provider", "profile", "export", MESSAGING_CREDENTIAL_PROVIDER_TYPE, "--output", "json"],
      { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("rejects an incompatible existing profile (#9875)", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "profile already exists" })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          id: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
          credentials: [],
          endpoints: ["https://example.invalid"],
          binaries: [],
          inference_capable: false,
        }),
      });

    expect(() =>
      ensureMessagingCredentialProviderProfile({
        root: "/repo",
        runOpenshell,
      }),
    ).toThrow(/does not match NemoClaw's endpointless messaging credential contract/);
  });

  it("reports a failed existing-profile export separately (#9875)", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "profile already exists" })
      .mockReturnValueOnce({ status: 1, stderr: "gateway unavailable" });

    expect(() =>
      ensureMessagingCredentialProviderProfile({
        root: "/repo",
        runOpenshell,
      }),
    ).toThrow(/already exists but could not be exported for validation/);
  });

  it.each(["not-json", `${EXPECTED_PROFILE}\n${EXPECTED_PROFILE}`])(
    "rejects malformed or ambiguous existing profile output (#9875)",
    (stdout) => {
      const runOpenshell = vi
        .fn()
        .mockReturnValueOnce({ status: 1, stderr: "profile already exists" })
        .mockReturnValueOnce({ status: 0, stdout });

      expect(() =>
        ensureMessagingCredentialProviderProfile({
          root: "/repo",
          runOpenshell,
        }),
      ).toThrow(/does not match NemoClaw's endpointless messaging credential contract/);
    },
  );

  it("suppresses profile import diagnostics (#9875)", () => {
    const runOpenshell = vi.fn(() => ({
      status: 1,
      stderr: "request failed with discord-credential-must-not-leak",
    }));

    expect(() =>
      ensureMessagingCredentialProviderProfile({
        root: "/repo",
        runOpenshell,
      }),
    ).toThrow("Could not import the OpenShell messaging credential profile.");
  });
});
