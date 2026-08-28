// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
  gatewayIdForStateDir,
} from "./docker-driver-gateway-config";
import {
  MANAGED_GATEWAY_STATE_ROOT_MARKER,
  ensureManagedGatewayStateRoot,
  managedGatewayStateRootOwnershipFailure,
} from "./gateway-binding";

function target(stateDir: string, gatewayPort = 9123) {
  return { gatewayName: `nemoclaw-${String(gatewayPort)}`, gatewayPort, stateDir };
}

describe("managed gateway state root ownership", () => {
  it("rejects an existing nonempty directory that NemoClaw does not own", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-unowned-gateway-root-"));
    const stateDir = path.join(root, "gateway");
    try {
      fs.mkdirSync(stateDir, { mode: 0o700 });
      fs.writeFileSync(path.join(stateDir, "operator-data"), "keep\n", { mode: 0o600 });

      expect(() => ensureManagedGatewayStateRoot(target(stateDir))).toThrow(
        /refusing to adopt an existing nonempty directory/,
      );
      expect(fs.readFileSync(path.join(stateDir, "operator-data"), "utf8")).toBe("keep\n");
      expect(fs.existsSync(path.join(stateDir, MANAGED_GATEWAY_STATE_ROOT_MARKER))).toBe(false);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("marks an empty dedicated directory and binds it to one gateway", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-owned-gateway-root-"));
    const stateDir = path.join(root, "gateway");
    try {
      ensureManagedGatewayStateRoot(target(stateDir));

      expect(managedGatewayStateRootOwnershipFailure(target(stateDir))).toBeNull();
      expect(managedGatewayStateRootOwnershipFailure(target(stateDir, 9124))).toMatch(
        /does not identify the selected gateway/,
      );
      expect(fs.statSync(path.join(stateDir, MANAGED_GATEWAY_STATE_ROOT_MARKER)).mode & 0o777).toBe(
        0o600,
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("adopts valid pre-marker managed gateway state for interrupted-onboard recovery", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-legacy-gateway-root-"));
    const stateDir = path.join(root, "gateway");
    try {
      const jwtBundle = ensureDockerDriverGatewayJwtBundle(stateDir);
      fs.writeFileSync(
        path.join(stateDir, "openshell-gateway.toml"),
        buildDockerDriverGatewayConfigToml(
          {
            OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:9123",
            OPENSHELL_LOCAL_TLS_DIR: path.join(stateDir, "tls"),
            OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
            OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor:test",
          },
          "/usr/bin/openshell-sandbox",
          jwtBundle,
          gatewayIdForStateDir(stateDir),
        ),
        { mode: 0o600 },
      );

      expect(
        managedGatewayStateRootOwnershipFailure(target(stateDir), {
          allowLegacyManagedState: true,
        }),
      ).toBeNull();
      ensureManagedGatewayStateRoot(target(stateDir), {
        isLegacyManagedState: () => true,
      });
      expect(fs.existsSync(path.join(stateDir, MANAGED_GATEWAY_STATE_ROOT_MARKER))).toBe(true);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
