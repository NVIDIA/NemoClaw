// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import credentialBoundaryManifest from "../../src/lib/actions/sandbox/openshell-child-visible-credentials.v0.1.7.json";
import { runCommandWithInstalledVersion } from "../support/openshell-installed-version";

const REQUIRED_OPENSHELL_VERSION = credentialBoundaryManifest.openshellVersion;

describe("OpenShell split sandbox installation", () => {
  it.each([
    ["0.1.2", "5b2178f3b64a6c96eff9ed61bd7feeada4b4a4b3c68f3664e3b8f4f2b264a9b1", true],
    ["0.1.2", "9b527c257e7917d11cee34075369cdfb69a57764198da6e72cc0847cb9b427aa", true],
    ["0.1.2", "0".repeat(64), false],
    ["0.1.2", "326ee26df8f8575ba761470757a12fe5c1cdc904ba064b81946692dd0328dd40", false],
    ["0.1.3", "38fe063f19c72680a1bc4b0c343a3ec5b7a5cb087a627faab5b2aefd9d50d094", true],
    ["0.1.3", "23147b42d31bd0b13e1a9ed7b3834b8e6075836cba0872fffa9e7d481f6dd281", true],
    ["0.1.3", "5b2178f3b64a6c96eff9ed61bd7feeada4b4a4b3c68f3664e3b8f4f2b264a9b1", false],
    ["0.1.2", "23147b42d31bd0b13e1a9ed7b3834b8e6075836cba0872fffa9e7d481f6dd281", false],
    ["0.1.3", "0".repeat(64), false],
    ["0.1.5", "a048b1fd2acd78f44f50a4cf0e02cdefec691656f3941e92c5ec0e09a69990e2", true],
    ["0.1.5", "65aa2a2afb96e7d1351c1d197ded7a966e20bcad68e18a58a94621a8f23769bc", true],
    ["0.1.5", "23147b42d31bd0b13e1a9ed7b3834b8e6075836cba0872fffa9e7d481f6dd281", false],
    ["0.1.7", "b4ae1d60b238c84e290bcd08a962997e5c36ed04237fa59b09b5799b11363feb", true],
    ["0.1.7", "d13966b032b07d75c917d3fbb7471e608edfdf1f25e9d922e5aa7c779cf6ad21", true],
    ["0.1.7", "65aa2a2afb96e7d1351c1d197ded7a966e20bcad68e18a58a94621a8f23769bc", false],
  ] as const)(
    "checks the sandbox digest and claimed version before deferring supervisor policy verification [%s, %s]",
    (version, digest, accepted) => {
      const result = runCommandWithInstalledVersion(
        version,
        {},
        {
          entrypoint: version === REQUIRED_OPENSHELL_VERSION ? "direct" : "feature-check",
          sandboxMarkers: "",
          sandboxBinaryDigest: digest,
        },
      );
      expect(result.status === 0, result.stdout + result.stderr).toBe(accepted);
    },
  );
});
