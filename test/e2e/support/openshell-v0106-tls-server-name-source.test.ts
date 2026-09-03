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
  assertOpenShellTlsServerNameSource,
  type OpenShellTlsServerNameSource,
  OPENSHELL_V0106_TLS_SERVER_NAME_SOURCES,
  verifyOpenShellTlsServerNameSourceBoundary,
} from "../live/openshell-v0106-tls-server-name-source.ts";

function withBlobSha(
  reviewedSource: OpenShellTlsServerNameSource,
  source: string,
): OpenShellTlsServerNameSource {
  const bytes = Buffer.from(source, "utf8");
  const header = Buffer.from(`blob ${String(bytes.byteLength)}\0`, "utf8");
  return {
    ...reviewedSource,
    blobSha: createHash("sha1").update(header).update(bytes).digest("hex"),
  };
}

function checkFor(reviewedSource: OpenShellTlsServerNameSource, category: "driver" | "regression") {
  const check = reviewedSource.checks.find((candidate) => candidate.category === category);
  expect(check).toBeDefined();
  return check!;
}

describe("OpenShell 0.0.106 TLS server-name boundary", () => {
  it("covers every local supervisor driver changed by the upstream security fix", () => {
    const checks = OPENSHELL_V0106_TLS_SERVER_NAME_SOURCES.flatMap(({ checks }) => checks);

    expect(
      checks.filter(({ category }) => category === "driver").map(({ driver }) => driver),
    ).toEqual(["docker", "podman", "vm"]);
    expect(
      checks.filter(({ category }) => category === "regression").map(({ driver }) => driver),
    ).toEqual(["docker", "podman", "vm"]);
  });

  it("rejects a regression assertion that occurs before hostile-value injection", () => {
    const reviewedSource = OPENSHELL_V0106_TLS_SERVER_NAME_SOURCES[1]!;
    const check = checkFor(reviewedSource, "regression");
    const [testToken, injectionToken, assertionToken] = check.orderedTokens;
    const source = `${testToken}\n${assertionToken}\n${injectionToken}\n`;

    expect(() =>
      assertOpenShellTlsServerNameSource(withBlobSha(reviewedSource, source), source),
    ).toThrow(/docker regression does not preserve/u);
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
    const reviewedSource = OPENSHELL_V0106_TLS_SERVER_NAME_SOURCES[0]!;
    const check = checkFor(reviewedSource, "driver");
    const [mergeToken, removeToken] = check.orderedTokens;
    const source = `${removeToken}\n${mergeToken}\n`;

    expect(() =>
      assertOpenShellTlsServerNameSource(withBlobSha(reviewedSource, source), source),
    ).toThrow(/docker driver does not preserve/u);
  });

  it("fetches each exact source once before projecting driver and regression results", async () => {
    const fixtures = OPENSHELL_V0106_TLS_SERVER_NAME_SOURCES.map((reviewedSource) => {
      const source = reviewedSource.checks.flatMap(({ orderedTokens }) => orderedTokens).join("\n");
      return {
        reviewedSource: withBlobSha(reviewedSource, source),
        source,
      };
    });
    const fetchSource = vi.fn<typeof fetch>(async (input) => {
      const sourcePath =
        String(input).split(`${OPENSHELL_V0106_QUALIFICATION.sourceRevision}/`)[1] ?? "";
      const fixture = fixtures.find(({ reviewedSource }) => reviewedSource.path === sourcePath);
      return fixture
        ? new Response(fixture.source, { status: 200 })
        : new Response("", { status: 404 });
    });

    await expect(
      verifyOpenShellTlsServerNameSourceBoundary(
        fetchSource,
        fixtures.map(({ reviewedSource }) => reviewedSource),
      ),
    ).resolves.toMatchObject({
      drivers: [{ driver: "docker" }, { driver: "podman" }, { driver: "vm" }],
      regressions: [{ driver: "docker" }, { driver: "podman" }, { driver: "vm" }],
      sourceRevision: OPENSHELL_V0106_QUALIFICATION.sourceRevision,
      version: "0.0.106",
    });
    expect(fetchSource).toHaveBeenCalledTimes(4);
  });
});
