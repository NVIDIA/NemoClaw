// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { runReviewedNpmBootstrap } from "../../support/reviewed-npm-bootstrap";

type BootstrapOptions = Parameters<typeof runReviewedNpmBootstrap>[0];

describe("reviewed npm bootstrap", () => {
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
      const { npmInvocations, result } = fixture;
      expect(result.status).toBe(0);
      expect(npmInvocations).toHaveLength(3);
      expect(npmInvocations[0]).toMatch(
        /^pack npm@12\.0\.2 --pack-destination .* --userconfig \/dev\/null --registry https:\/\/registry\.npmjs\.org\/ --ignore-scripts --no-audit --no-fund$/,
      );
      expect(npmInvocations[1]).toMatch(
        /^install --global .*\/npm-12\.0\.2\.tgz --userconfig \/dev\/null --ignore-scripts --no-audit --no-fund --offline$/,
      );
      expect(npmInvocations[2]).toBe("--version");
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
        /^pack npm@12\.0\.2 --pack-destination .* --userconfig \/dev\/null --registry https:\/\/registry\.npmjs\.org\/ --ignore-scripts --no-audit --no-fund$/,
      );
    } finally {
      fixture.cleanup();
    }
  });
});
