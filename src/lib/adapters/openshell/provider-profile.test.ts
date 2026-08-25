// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  endpointlessProviderProfilePath,
  ensureEndpointlessProviderProfile,
  type EndpointlessProviderProfileRunner,
} from "./provider-profile";

const PROFILE_ID = "openai";
const PROFILE_PATH = "/repo/nemoclaw-blueprint/provider-profiles/openai.yaml";
const EXPECTED_PROFILE = JSON.stringify({
  id: PROFILE_ID,
  credentials: [],
  endpoints: [],
  binaries: [],
  inference_capable: true,
});

function ensureProfile(runOpenshell: ReturnType<typeof vi.fn>) {
  return ensureEndpointlessProviderProfile({
    profileId: PROFILE_ID,
    inferenceCapable: true,
    profilePath: PROFILE_PATH,
    runOpenshell: runOpenshell as EndpointlessProviderProfileRunner,
  });
}

describe("OpenShell endpointless provider profiles", () => {
  it("resolves a checked-in profile path for the requested profile", () => {
    expect(endpointlessProviderProfilePath("/repo", PROFILE_ID)).toBe(
      path.join("/repo", "nemoclaw-blueprint", "provider-profiles", "openai.yaml"),
    );
  });

  it("imports a missing endpointless profile with suppressed command output (#9875)", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 0 });

    expect(ensureProfile(runOpenshell)).toEqual({ ok: true });
    expect(runOpenshell).toHaveBeenNthCalledWith(
      1,
      ["provider", "profile", "export", PROFILE_ID, "--output", "json"],
      {
        ignoreError: true,
        suppressOutput: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
    expect(runOpenshell).toHaveBeenNthCalledWith(
      2,
      ["provider", "profile", "import", "--file", PROFILE_PATH],
      {
        ignoreError: true,
        suppressOutput: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
  });

  it("imports after the supported structured missing-profile response (#10155)", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        output: [
          null,
          Buffer.from(""),
          Buffer.from("Error: × status: 'NotFound', message: \"provider profile not found\"\n"),
        ],
      })
      .mockReturnValueOnce({ status: 0 });

    expect(ensureProfile(runOpenshell)).toEqual({ ok: true });
    expect(runOpenshell).toHaveBeenCalledTimes(2);
  });

  it("imports after OpenShell wraps the missing-profile message (#10155)", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stderr:
          "Error:   × code: 'Some requested entity was not found', message: \"provider profile\n  │ not found\"",
      })
      .mockReturnValueOnce({ status: 0 });

    expect(ensureProfile(runOpenshell)).toEqual({ ok: true });
    expect(runOpenshell).toHaveBeenCalledTimes(2);
  });

  it("does not import after an unrelated structured not-found response (#10155)", () => {
    const runOpenshell = vi.fn().mockReturnValueOnce({
      status: 1,
      output: [
        null,
        Buffer.from(""),
        Buffer.from("Error: × status: 'NotFound', message: \"gateway not found\"\n"),
      ],
    });

    expect(ensureProfile(runOpenshell)).toEqual({ ok: false, reason: "export-failed" });
    expect(runOpenshell).toHaveBeenCalledOnce();
  });

  it("reuses an exact existing profile without importing it (#10155)", () => {
    const runOpenshell = vi.fn().mockReturnValueOnce({ status: 0, stdout: EXPECTED_PROFILE });

    expect(ensureProfile(runOpenshell)).toEqual({ ok: true });
    expect(runOpenshell).toHaveBeenCalledOnce();
  });

  it("rejects an incompatible existing profile without importing it (#10155)", () => {
    const runOpenshell = vi.fn().mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        id: PROFILE_ID,
        credentials: [],
        endpoints: ["https://example.invalid"],
        binaries: [],
        inference_capable: true,
      }),
    });

    expect(ensureProfile(runOpenshell)).toEqual({ ok: false, reason: "incompatible" });
    expect(runOpenshell).toHaveBeenCalledOnce();
  });

  it("does not import when profile inspection fails (#10155)", () => {
    const runOpenshell = vi.fn().mockReturnValueOnce({
      status: 1,
      stderr: "gateway unavailable",
    });

    expect(ensureProfile(runOpenshell)).toEqual({ ok: false, reason: "export-failed" });
    expect(runOpenshell).toHaveBeenCalledOnce();
  });

  it("does not import when profile inspection has no exit status (#10155)", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: null, stderr: "provider profile not found" });

    expect(ensureProfile(runOpenshell)).toEqual({ ok: false, reason: "export-failed" });
    expect(runOpenshell).toHaveBeenCalledOnce();
  });

  it.each(["not-json", `${EXPECTED_PROFILE}\n${EXPECTED_PROFILE}`])(
    "rejects malformed or ambiguous existing profile output (#9875)",
    (stdout) => {
      const runOpenshell = vi.fn().mockReturnValueOnce({ status: 0, stdout });

      expect(ensureProfile(runOpenshell)).toEqual({ ok: false, reason: "incompatible" });
    },
  );

  it("classifies an import failure without returning command diagnostics (#9875)", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "provider profile not found" })
      .mockReturnValueOnce({
        status: 1,
        stderr: "request failed with credential-must-not-leak",
      });

    expect(ensureProfile(runOpenshell)).toEqual({ ok: false, reason: "import-failed" });
  });

  it("reuses an exact profile created by a concurrent importer (#10155)", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 1, stderr: "provider profile already exists" })
      .mockReturnValueOnce({ status: 0, stdout: EXPECTED_PROFILE });

    expect(ensureProfile(runOpenshell)).toEqual({ ok: true });
    expect(runOpenshell).toHaveBeenCalledTimes(3);
  });

  it("rejects a conflicting profile created by a concurrent importer (#10155)", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 1, stderr: "provider profile already exists" })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          id: PROFILE_ID,
          credentials: [],
          endpoints: ["https://foreign.invalid"],
          binaries: [],
          inference_capable: true,
        }),
      });

    expect(ensureProfile(runOpenshell)).toEqual({ ok: false, reason: "incompatible" });
  });

  it("fails closed when a concurrent import cannot be inspected (#10155)", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 1, stderr: "provider profile already exists" })
      .mockReturnValueOnce({ status: 1, stderr: "gateway unavailable" });

    expect(ensureProfile(runOpenshell)).toEqual({ ok: false, reason: "export-failed" });
  });
});
