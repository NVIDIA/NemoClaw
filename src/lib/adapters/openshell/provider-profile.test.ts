// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";

import {
  compareExportedProfileToCheckedIn,
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

  it("reuses an exact profile whose import-race diagnostic is wrapped across a box-drawing line (#10371)", () => {
    // Same failure shape #10159 fixed for the "not found" match: OpenShell
    // can wrap "already exists" across a box-drawing continuation depending
    // on terminal width/TTY-ness, which a plain substring test would miss.
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 1, stderr: "provider profile already\n │ exists" })
      .mockReturnValueOnce({ status: 0, stdout: EXPECTED_PROFILE });

    expect(ensureProfile(runOpenshell)).toEqual({ ok: true });
    expect(runOpenshell).toHaveBeenCalledTimes(3);
  });
});

describe("compareExportedProfileToCheckedIn", () => {
  // A refreshing profile as this repository checks it in: the kebab-case
  // strategy spelling, and material entries that omit `secret`/`required`
  // where the default is false.
  const CHECKED_IN = {
    id: "google-chat-bridge",
    credentials: [
      {
        name: "access_token",
        env_vars: ["GOOGLE_CHAT_ACCESS_TOKEN"],
        required: true,
        auth_style: "bearer",
        header_name: "Authorization",
        query_param: "",
        refresh: {
          strategy: "google-service-account-jwt",
          scopes: ["https://www.googleapis.com/auth/chat.bot"],
          material: [
            { name: "client_email", description: "JWT issuer", required: true },
            {
              name: "private_key",
              description: "signs the assertion",
              required: true,
              secret: true,
            },
            { name: "scope", description: "scope to mint for" },
          ],
        },
      },
    ],
    endpoints: [{ host: "chat.googleapis.com", port: 443, protocol: "rest", access: "read-write" }],
    binaries: ["/usr/bin/node"],
    inference_capable: false,
  };

  // What `openshell provider profile export -o json` returns for that same
  // profile on the pinned OpenShell v0.0.106: the stored profile is
  // re-serialized, so `serialize_refresh_strategy` writes the snake_case wire
  // spelling and CredentialRefreshMaterialProfile's `required`/`secret` carry
  // no `skip_serializing_if`, so both appear on every material entry.
  const PINNED_EXPORT = {
    ...CHECKED_IN,
    credentials: [
      {
        ...CHECKED_IN.credentials[0],
        refresh: {
          ...CHECKED_IN.credentials[0].refresh,
          strategy: "google_service_account_jwt",
          material: [
            { name: "client_email", description: "JWT issuer", required: true, secret: false },
            {
              name: "private_key",
              description: "signs the assertion",
              required: true,
              secret: true,
            },
            { name: "scope", description: "scope to mint for", required: false, secret: false },
          ],
        },
      },
    ],
  };

  const compare = (exported: unknown, readCheckedIn: () => string) =>
    compareExportedProfileToCheckedIn(
      JSON.stringify(exported),
      readCheckedIn,
      "google-chat-bridge",
    );

  const readCheckedIn = () => YAML.stringify(CHECKED_IN);

  it("accepts OpenShell's own re-serialization of the checked-in profile (#10371)", () => {
    // The gateway holds exactly what this checkout imported. Comparing the
    // export byte-for-byte against the YAML would report a byte-valid,
    // unmodified profile as drift and route the operator to delete it.
    expect(compare(PINNED_EXPORT, readCheckedIn)).toBe("match");
  });

  it("ignores refresh material help text outside the credential boundary", () => {
    const updatedHelp = {
      ...PINNED_EXPORT,
      credentials: [
        {
          ...PINNED_EXPORT.credentials[0],
          refresh: {
            ...PINNED_EXPORT.credentials[0].refresh,
            material: PINNED_EXPORT.credentials[0].refresh.material.map((entry) => ({
              ...entry,
              description: `updated ${entry.name} help`,
            })),
          },
        },
      ],
    };

    expect(compare(updatedHelp, readCheckedIn)).toBe("match");
  });

  it("does not accept checked-in refresh YAML as an exported profile", () => {
    // The pinned exporter always emits both material flags. Missing flags mean
    // the output did not complete the expected OpenShell serialization.
    expect(compare(CHECKED_IN, readCheckedIn)).toBe("indeterminate");
  });

  it("reports a registered profile with different endpoint authority as drift", () => {
    const drifted = { ...PINNED_EXPORT, endpoints: [{ host: "attacker.example", port: 443 }] };
    expect(compare(drifted, readCheckedIn)).toBe("mismatch");
  });

  it("keeps the pinned exporter's multi-entry endpoint order in the boundary", () => {
    // OpenShell v0.0.106 stores and serializes profile sequences as Vec values,
    // so declaration order survives import/export and remains part of the
    // exact checked-in contract.
    const endpoints = [
      { host: "chat.googleapis.com", port: 443 },
      { host: "pubsub.googleapis.com", port: 443 },
    ];
    const readTwoEndpoints = () => YAML.stringify({ ...CHECKED_IN, endpoints });

    expect(compare({ ...PINNED_EXPORT, endpoints }, readTwoEndpoints)).toBe("match");
    expect(
      compare({ ...PINNED_EXPORT, endpoints: [...endpoints].reverse() }, readTwoEndpoints),
    ).toBe("mismatch");
  });

  it("reports a genuinely different refresh strategy as drift, not a spelling difference", () => {
    const drifted = {
      ...PINNED_EXPORT,
      credentials: [
        {
          ...PINNED_EXPORT.credentials[0],
          refresh: { ...PINNED_EXPORT.credentials[0].refresh, strategy: "oauth2_refresh_token" },
        },
      ],
    };
    expect(compare(drifted, readCheckedIn)).toBe("mismatch");
  });

  it("reports a material entry promoted to secret as drift", () => {
    const drifted = {
      ...PINNED_EXPORT,
      credentials: [
        {
          ...PINNED_EXPORT.credentials[0],
          refresh: {
            ...PINNED_EXPORT.credentials[0].refresh,
            material: [
              { name: "client_email", description: "JWT issuer", required: true, secret: true },
            ],
          },
        },
      ],
    };
    expect(compare(drifted, readCheckedIn)).toBe("mismatch");
  });

  it.each(["required", "secret"])(
    "reports a null exported refresh material %s flag as indeterminate",
    (field) => {
      const malformed = {
        ...PINNED_EXPORT,
        credentials: [
          {
            ...PINNED_EXPORT.credentials[0],
            refresh: {
              ...PINNED_EXPORT.credentials[0].refresh,
              material: [
                {
                  ...PINNED_EXPORT.credentials[0].refresh.material[0],
                  [field]: null,
                },
              ],
            },
          },
        ],
      };
      expect(compare(malformed, readCheckedIn)).toBe("indeterminate");
    },
  );

  it("reports an unreadable checked-in profile as indeterminate, not drift (#10371)", () => {
    const throwing = () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    expect(compare(PINNED_EXPORT, throwing)).toBe("indeterminate");
  });

  it("reports an unparseable checked-in profile as indeterminate, not drift (#10371)", () => {
    expect(compare(PINNED_EXPORT, () => "id: [unterminated")).toBe("indeterminate");
  });

  it("reports a checked-in file that is not a provider profile as indeterminate", () => {
    expect(compare(PINNED_EXPORT, () => YAML.stringify({ id: "google-chat-bridge" }))).toBe(
      "indeterminate",
    );
  });

  it("reports an export that is not JSON as indeterminate, not drift (#10371)", () => {
    // A truncated or diagnostic-laden export is a read that never completed.
    // Treating it as drift would tell the operator to delete a profile whose
    // contents were never seen.
    expect(
      compareExportedProfileToCheckedIn("gateway unavailable", readCheckedIn, "google-chat-bridge"),
    ).toBe("indeterminate");
  });

  it("reports a valid JSON export that is not a provider profile as indeterminate", () => {
    expect(compare({}, readCheckedIn)).toBe("indeterminate");
  });

  it("reports an export of a different profile id as drift", () => {
    expect(compare({ ...PINNED_EXPORT, id: "brave" }, readCheckedIn)).toBe("mismatch");
  });
});
