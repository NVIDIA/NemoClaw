// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ensureDockerDriverGatewayLocalTlsBundle } from "./docker-driver-gateway-local-tls";

const PRIVATE_KEY_LABEL = "PRIVATE " + "KEY";
const PRIVATE_KEY_MARKER = [
  `-----BEGIN ${PRIVATE_KEY_LABEL}-----`,
  "secret test key material",
  `-----END ${PRIVATE_KEY_LABEL}-----`,
].join("\n");

describe("docker-driver-gateway-local-tls errors", () => {
  it("redacts state paths and private key material from certgen spawn errors", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-error-"));
    try {
      expect(() =>
        ensureDockerDriverGatewayLocalTlsBundle({
          env: { PATH: "/usr/bin" },
          gatewayBin: "/opt/openshell/openshell-gateway",
          stateDir,
          spawnSyncImpl: (() => ({
            error: new Error(
              `spawn failed for ${path.join(stateDir, "tls", "client", "tls.key")}\n${PRIVATE_KEY_MARKER}`,
            ),
            status: null,
            stdout: "",
            stderr: "",
          })) as never,
        }),
      ).toThrow(/<stateDir>\/tls\/client\/tls\.key.*<redacted private key>/s);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("redacts state paths and private key material from certgen failures", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-tls-error-"));
    let message = "";
    try {
      try {
        ensureDockerDriverGatewayLocalTlsBundle({
          env: { PATH: "/usr/bin" },
          gatewayBin: "/opt/openshell/openshell-gateway",
          stateDir,
          spawnSyncImpl: (() => ({
            status: 1,
            stdout: "",
            stderr: `failed writing ${path.join(stateDir, "tls", "server", "tls.key")}\n${PRIVATE_KEY_MARKER}`,
          })) as never,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain("<stateDir>/tls/server/tls.key");
      expect(message).toContain("<redacted private key>");
      expect(message).not.toContain(stateDir);
      expect(message).not.toContain(`BEGIN ${PRIVATE_KEY_LABEL}`);
      expect(message).not.toContain("secret test key material");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
