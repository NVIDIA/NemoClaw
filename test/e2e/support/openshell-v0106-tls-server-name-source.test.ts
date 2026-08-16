// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import * as dockerDriverGatewayEnv from "../../../src/lib/onboard/docker-driver-gateway-env.ts";
import { createDockerDriverGatewayRuntimeHelpers } from "../../../src/lib/onboard/docker-driver-gateway-runtime.ts";
import { OPENSHELL_V0106_QUALIFICATION } from "../fixtures/openshell-v0106-qualification.ts";
import {
  assertTlsServerNameRegressionInjectsAndRejects,
  assertTlsServerNameRemovedAfterUserEnvironmentMerge,
  OPENSHELL_V0106_TLS_SERVER_NAME_REGRESSIONS,
  OPENSHELL_V0106_TLS_SERVER_NAME_SOURCES,
  verifyOpenShellTlsServerNameSourceBoundary,
} from "../live/openshell-v0106-tls-server-name-source.ts";

describe("OpenShell 0.0.106 TLS server-name boundary", () => {
  it("covers every local supervisor driver changed by the upstream security fix", () => {
    expect(OPENSHELL_V0106_TLS_SERVER_NAME_SOURCES.map(({ driver }) => driver)).toEqual([
      "docker",
      "podman",
      "vm",
    ]);
    expect(OPENSHELL_V0106_TLS_SERVER_NAME_REGRESSIONS.map(({ driver }) => driver)).toEqual([
      "docker",
      "podman",
      "vm",
    ]);
  });

  it("rejects a regression assertion that occurs before hostile-value injection", () => {
    const contract = OPENSHELL_V0106_TLS_SERVER_NAME_REGRESSIONS[0];
    const source = `${contract.testToken}\n${contract.assertionToken}\n${contract.injectionToken}\n`;
    const bytes = Buffer.from(source, "utf8");
    const header = Buffer.from(`blob ${String(bytes.byteLength)}\0`, "utf8");
    expect(() =>
      assertTlsServerNameRegressionInjectsAndRejects(
        {
          ...contract,
          blobSha: createHash("sha1").update(header).update(bytes).digest("hex"),
        },
        source,
      ),
    ).toThrow(/must inject and reject/u);
  });

  it("binds the live qualification target to the production supervisor map", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-v0106-supervisor-map-"));
    vi.stubEnv("OPENSHELL_DOCKER_SUPERVISOR_IMAGE", "");
    vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR", stateDir);
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", process.env.OPENSHELL_LOCAL_TLS_DIR ?? "");
    try {
      const helpers = createDockerDriverGatewayRuntimeHelpers({
        gatewayPort: 18_080,
        getBlueprintMaxOpenshellVersion: () => OPENSHELL_V0106_QUALIFICATION.version,
        getCachedOpenshellBinary: () => null,
        getInstalledOpenshellVersion: () => null,
        isOpenshellDevVersion: () => false,
        loadDockerDriverGatewayEnv: () => dockerDriverGatewayEnv,
        runCapture: () => "",
        shouldUseOpenshellDevChannel: () => false,
        supportedOpenshellFallbackVersion: OPENSHELL_V0106_QUALIFICATION.version,
      });

      expect(
        helpers.getDockerDriverGatewayEnv(null, "linux").OPENSHELL_DOCKER_SUPERVISOR_IMAGE,
      ).toBe(OPENSHELL_V0106_QUALIFICATION.supervisorImage);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects removal that occurs before the user environment merge", () => {
    const contract = OPENSHELL_V0106_TLS_SERVER_NAME_SOURCES[0];
    const source = `${contract.removeToken}\n${contract.mergeToken}\n`;
    const bytes = Buffer.from(source, "utf8");
    const header = Buffer.from(`blob ${String(bytes.byteLength)}\0`, "utf8");
    expect(() =>
      assertTlsServerNameRemovedAfterUserEnvironmentMerge(
        {
          ...contract,
          blobSha: createHash("sha1").update(header).update(bytes).digest("hex"),
        },
        source,
      ),
    ).toThrow(/must remove.*after merging user environment/u);
  });

  it("requires every exact Docker, Podman, and VM source before passing", async () => {
    const fixtures = OPENSHELL_V0106_TLS_SERVER_NAME_SOURCES.map((contract, index) => {
      const regression = OPENSHELL_V0106_TLS_SERVER_NAME_REGRESSIONS[index];
      const source =
        `${contract.mergeToken}\n${contract.removeToken}\n` +
        `${regression.testToken}\n${regression.injectionToken}\n${regression.assertionToken}\n`;
      const bytes = Buffer.from(source, "utf8");
      const header = Buffer.from(`blob ${String(bytes.byteLength)}\0`, "utf8");
      return {
        blobSha: createHash("sha1").update(header).update(bytes).digest("hex"),
        contract,
        regression,
        source,
      };
    });
    const contracts = fixtures.map(({ blobSha, contract }) => ({ ...contract, blobSha }));
    const regressions = fixtures.map(({ blobSha, regression }) => ({ ...regression, blobSha }));
    const fetchSource = vi.fn<typeof fetch>(async (input) => {
      const path = String(input).split(`${OPENSHELL_V0106_QUALIFICATION.sourceRevision}/`)[1] ?? "";
      const fixture = fixtures.find(
        ({ contract, regression }) => contract.path === path || regression.path === path,
      );
      return fixture
        ? new Response(fixture.source, { status: 200 })
        : new Response("", { status: 404 });
    });

    await expect(
      verifyOpenShellTlsServerNameSourceBoundary(fetchSource, contracts, regressions),
    ).resolves.toMatchObject({
      drivers: [{ driver: "docker" }, { driver: "podman" }, { driver: "vm" }],
      regressions: [{ driver: "docker" }, { driver: "podman" }, { driver: "vm" }],
      sourceRevision: OPENSHELL_V0106_QUALIFICATION.sourceRevision,
      version: "0.0.106",
    });
  });
});
