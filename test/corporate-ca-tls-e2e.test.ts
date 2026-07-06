// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Focused simulated-MITM TLS test for the corporate-proxy CA import (#6210).
//
// Reproduces the reporter's scenario without DGX hardware:
//   * A corporate root CA re-signs external TLS (the MITM proxy).
//   * A server presents a leaf cert signed ONLY by that corporate CA.
//   * OpenShell's own bundle does NOT contain the corporate root.
//
// It runs the REAL merge_corporate_proxy_ca block extracted from
// scripts/nemoclaw-start.sh to append the baked corporate CA to the OpenShell
// bundle, then proves TLS verification succeeds only after the merge, while the
// OpenShell root stays trusted (the #1828 behavior is preserved).

import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  type CaMaterial,
  cleanupCaSetup,
  httpsGetStatus,
  resolveCaSetup,
  runMergeBlock,
  startTlsServer,
} from "./helpers/corporate-ca-support";

const OPENCLAW_START = path.join(import.meta.dirname, "../scripts/nemoclaw-start.sh");

const setup = resolveCaSetup("corporate-ca-tls-e2e");

afterAll(() => cleanupCaSetup(setup));

describe.skipIf(!setup.ok)("corporate proxy CA TLS verification (#6210)", () => {
  const mat = setup as CaMaterial;

  it("verifies a corporate-CA-signed endpoint only after the merge", async () => {
    const merged = runMergeBlock(OPENCLAW_START, mat.openshellCaCert, mat.corporateCaCert, mat.dir);
    const server = await startTlsServer(mat.serverKey, mat.serverCert);
    try {
      // Pre-fix state: OpenShell bundle alone cannot verify the corporate leaf.
      await expect(httpsGetStatus(server.port, mat.openshellCaCert)).rejects.toThrow(
        /unable to (get local issuer|verify)|self.signed|UNABLE_TO_/i,
      );
      // Post-fix: the merged bundle trusts the corporate root.
      await expect(httpsGetStatus(server.port, merged)).resolves.toBe(200);
    } finally {
      await server.close();
    }
  });

  // Also preserves the OpenShell CA trust behavior from #1828.
  it("still trusts the OpenShell root through the merged bundle (#6210)", async () => {
    const merged = runMergeBlock(OPENCLAW_START, mat.openshellCaCert, mat.corporateCaCert, mat.dir);
    const server = await startTlsServer(mat.openshellServerKey, mat.openshellServerCert);
    try {
      await expect(httpsGetStatus(server.port, merged)).resolves.toBe(200);
    } finally {
      await server.close();
    }
  });
});
