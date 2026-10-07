// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runReviewedNpmBootstrap } from "../../support/reviewed-npm-bootstrap";

type BootstrapOptions = Parameters<typeof runReviewedNpmBootstrap>[0];

const NPM_DIAGNOSTICS_HELPER = path.join(
  import.meta.dirname,
  "../../..",
  "scripts",
  "lib",
  "npm-diagnostics.sh",
);

describe("reviewed npm bootstrap", () => {
  it("shares one bounded credential-redaction policy across npm bootstrap callers (#12192)", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; sanitize_npm_diagnostics | bounded_npm_diagnostic_excerpt 3900',
        "reviewed-npm-diagnostics",
        NPM_DIAGNOSTICS_HELPER,
      ],
      {
        encoding: "utf8",
        input: [
          "npm error code E_SHARED_POLICY",
          "npm error Authorization: Bearer fixture-secret-token",
          "npm error registry=https://fixture:fixture-secret-token@registry.example.test/package",
          "npm error token prefix ghp_1234567890abcdef",
          "npm error jwt eyJfixture1.payload.fixturepayload12345",
          "npm error opaque abcdefghijklmnopqrstuvwxyz0123456789ABCD",
          ["-----BEGIN PRIVATE", " KEY-----"].join(""),
          "fixture-secret-token",
          ["-----END PRIVATE", " KEY-----"].join(""),
          "_authToken=fixture-secret-token",
          "password=fixture-secret-token",
        ].join("\n"),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("npm error code E_SHARED_POLICY");
    expect(result.stdout).toContain("<REDACTED>");
    expect(result.stdout).toContain("<REDACTED_URL>");
    expect(result.stdout).not.toContain("fixture-secret-token");
    expect(result.stdout).not.toContain("ghp_1234567890abcdef");
    expect(result.stdout).not.toContain("eyJfixture1.payload.fixturepayload12345");
    expect(result.stdout).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789ABCD");
    expect(result.stdout).not.toContain(["BEGIN", "PRIVATE", "KEY"].join(" "));
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(3_900);
  });

  it("preserves a pack failure reported on stdout and its original status (#12192)", () => {
    const fixture = runReviewedNpmBootstrap({ packFailure: true });
    try {
      const output = `${fixture.result.stdout}\n${fixture.result.stderr}`;
      expect(fixture.result.status).toBe(47);
      expect(output).toContain("reviewed npm pack failed (exit 47)");
      expect(output).toContain("npm error code E_FIXTURE_PACK");
      expect(output).toContain("verbose diagnostic line 300");
      expect(output).toContain("<REDACTED>");
      expect(output).toContain("<REDACTED_URL>");
      expect(output).not.toContain("fixture-secret-token");
      expect(output).not.toContain("ghp_1234567890abcdef");
      expect(output).not.toContain("eyJfixture1.payload.fixturepayload12345");
      expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789ABCD");
      expect(output).not.toContain(["BEGIN", "PRIVATE", "KEY"].join(" "));
      expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(4_096);
      expect(fixture.npmInvocations).toHaveLength(1);
      expect(fixture.installCalled).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("preserves a causal pack failure from npm's private debug log (#12192)", () => {
    const fixture = runReviewedNpmBootstrap({ packFailureDebugLog: true });
    try {
      const output = `${fixture.result.stdout}\n${fixture.result.stderr}`;
      expect(fixture.result.status).toBe(47);
      expect(output).toContain("reviewed npm pack failed (exit 47)");
      expect(output).toContain("npm error code E_FIXTURE_PACK");
      expect(output).toContain("verbose diagnostic line 300");
      expect(output).toContain("<REDACTED>");
      expect(output).toContain("<REDACTED_URL>");
      expect(output).not.toContain("fixture-secret-token");
      expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(4_096);
      expect(fixture.npmInvocations).toHaveLength(1);
      expect(fixture.installCalled).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    [
      "malformed version",
      { mutateIdentity: (identity) => ({ ...identity, npmVersion: "12.x" }) },
      "invalid npmVersion",
      0,
    ],
    [
      "malformed SRI",
      { mutateIdentity: (identity) => ({ ...identity, npmIntegrity: "invalid" }) },
      "invalid npmIntegrity",
      0,
    ],
    [
      "malformed SHA-256",
      { mutateIdentity: (identity) => ({ ...identity, npmArchiveSha256: "invalid" }) },
      "invalid npmArchiveSha256",
      0,
    ],
    [
      "unreviewed registry",
      {
        mutateIdentity: (identity) => ({
          ...identity,
          registryOrigin: "https://registry.example/",
        }),
      },
      "invalid registryOrigin",
      0,
    ],
    [
      "SHA-256 mismatch",
      { mutateIdentity: (identity) => ({ ...identity, npmArchiveSha256: "0".repeat(64) }) },
      "archive integrity mismatch",
      1,
    ],
    [
      "SHA-512 SRI mismatch",
      {
        mutateIdentity: (identity) => ({
          ...identity,
          npmIntegrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
        }),
      },
      "archive integrity mismatch",
      1,
    ],
    ["archive version mismatch", { archiveManifest: "mismatched" }, "archive version 12.0.3", 1],
    ["missing archive metadata", { archiveManifest: "missing" }, "is missing or invalid", 1],
    ["invalid archive metadata", { archiveManifest: "invalid" }, "is missing or invalid", 1],
  ] as [string, BootstrapOptions, string, number][])(
    "rejects %s before installation (#8253)",
    (_caseName, options, error, npmInvocations) => {
      const fixture = runReviewedNpmBootstrap(options);
      try {
        expect(fixture.result.status).toBe(1);
        expect(fixture.result.stderr).toContain(error);
        expect(fixture.npmInvocations).toHaveLength(npmInvocations);
        expect(fixture.installCalled).toBe(false);
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("rejects a post-install npm version mismatch (#8253)", () => {
    const fixture = runReviewedNpmBootstrap({ installedVersion: "12.0.3" });
    try {
      expect(fixture.result.status).toBe(1);
      expect(fixture.result.stderr).toContain(
        "installed npm@12.0.3 does not match reviewed npm@12.0.2",
      );
      expect(fixture.npmInvocations).toHaveLength(3);
      expect(fixture.installCalled).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("installs a matching archive offline (#8253)", () => {
    const fixture = runReviewedNpmBootstrap();
    try {
      const { npmInvocations, result, tarInvocations } = fixture;
      expect(result.status).toBe(0);
      expect(npmInvocations).toHaveLength(3);
      expect(npmInvocations[0]).toMatch(
        /^pack npm@12\.0\.2 --pack-destination .* --userconfig \/dev\/null --registry https:\/\/registry\.npmjs\.org\/ --logs-dir .*\/npm-logs --logs-max 1 --ignore-scripts --no-audit --no-fund$/,
      );
      expect(npmInvocations[1]).toMatch(
        /^install --global .*\/npm-12\.0\.2\.tgz --userconfig \/dev\/null --ignore-scripts --no-audit --no-fund --offline$/,
      );
      expect(npmInvocations[2]).toBe("--version");
      expect(tarInvocations).toHaveLength(1);
      expect(tarInvocations[0]).toContain("|-xOf npm-12.0.2.tgz package/package.json");
    } finally {
      fixture.cleanup();
    }
  });

  it("overrides ambient npm configuration for the archive download (#8253)", () => {
    const fixture = runReviewedNpmBootstrap({
      environment: () => ({
        NPM_CONFIG_REGISTRY: "https://registry.example.test/",
        NPM_CONFIG_USERCONFIG: "/tmp/untrusted-npmrc",
      }),
    });
    try {
      expect(fixture.result.status).toBe(0);
      expect(fixture.npmInvocations[0]).toMatch(
        /^pack npm@12\.0\.2 --pack-destination .* --userconfig \/dev\/null --registry https:\/\/registry\.npmjs\.org\/ --logs-dir .*\/npm-logs --logs-max 1 --ignore-scripts --no-audit --no-fund$/,
      );
    } finally {
      fixture.cleanup();
    }
  });
});
