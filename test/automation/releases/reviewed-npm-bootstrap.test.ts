// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { runReviewedNpmBootstrap } from "../../support/reviewed-npm-bootstrap";

type BootstrapOptions = Parameters<typeof runReviewedNpmBootstrap>[0];

describe("reviewed npm bootstrap", () => {
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
    ["version mismatch", { archiveManifest: "mismatched" }, "archive version 12.0.3", 1],
    ["missing metadata", { archiveManifest: "missing" }, "is missing or invalid", 1],
    ["invalid metadata", { archiveManifest: "invalid" }, "is missing or invalid", 1],
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

  it("installs the verified archive offline despite ambient npm configuration (#8253)", () => {
    const fixture = runReviewedNpmBootstrap({
      environment: () => ({
        NPM_CONFIG_REGISTRY: "https://registry.example.test/",
        NPM_CONFIG_USERCONFIG: "/tmp/untrusted-npmrc",
      }),
    });
    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      expect(fixture.installCalled).toBe(true);
      expect(fixture.npmInvocations).toHaveLength(2);
      expect(fixture.npmInvocations[0]).toMatch(
        /^pack npm@12\.0\.2 --pack-destination .* --userconfig \/dev\/null --registry https:\/\/registry\.npmjs\.org\/ --ignore-scripts --no-audit --no-fund$/,
      );
      expect(fixture.npmInvocations[1]).toMatch(
        /^install --global .*\/npm-12\.0\.2\.tgz --userconfig \/dev\/null --ignore-scripts --no-audit --no-fund --offline$/,
      );
    } finally {
      fixture.cleanup();
    }
  });
});
