// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DOCKERFILE = join(import.meta.dirname, "../Dockerfile");

describe("corporate proxy CA build-time TLS anchor (#6839)", () => {
  const dockerfile = readFileSync(DOCKERFILE, "utf-8");

  // source-shape-contract: security -- The single corporate CA build arg is the sole onboard-patched supply-chain trust input
  it("declares exactly one corporate CA build arg so onboard patching stays unambiguous", () => {
    const matches = dockerfile.match(/^ARG NEMOCLAW_CORPORATE_CA_B64=/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  // source-shape-contract: security -- The build-time TLS trust anchor must precede the signature-verifying sigstore fetch
  it("decodes the CA and exports NODE_EXTRA_CA_CERTS before the reinstall audit-signatures step", () => {
    const argIndex = dockerfile.indexOf("ARG NEMOCLAW_CORPORATE_CA_B64=");
    const decodeIndex = dockerfile.indexOf('RUN if [ -n "${NEMOCLAW_CORPORATE_CA_B64}" ]; then');
    const anchorIndex = dockerfile.indexOf(
      "ENV NODE_EXTRA_CA_CERTS=/usr/local/share/nemoclaw/corporate-ca.pem",
    );
    const auditSignaturesIndex = dockerfile.indexOf("mcporter-runtime audit signatures");

    for (const [name, index] of Object.entries({
      argIndex,
      decodeIndex,
      anchorIndex,
      auditSignaturesIndex,
    })) {
      expect(index, name).toBeGreaterThan(-1);
    }
    expect(argIndex).toBeLessThan(decodeIndex);
    expect(decodeIndex).toBeLessThan(anchorIndex);
    expect(anchorIndex).toBeLessThan(auditSignaturesIndex);
  });
});
