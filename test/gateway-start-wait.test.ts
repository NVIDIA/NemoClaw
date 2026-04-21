// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ORIGINAL_ENV = { ...process.env };
const ONBOARD_MODULE = require.resolve("../dist/lib/onboard.js");
const PORTS_MODULE = require.resolve("../dist/lib/ports.js");

function loadOnboard() {
  delete require.cache[ONBOARD_MODULE];
  delete require.cache[PORTS_MODULE];
  return require("../dist/lib/onboard");
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete require.cache[ONBOARD_MODULE];
  delete require.cache[PORTS_MODULE];
});

describe("gateway startup wait config", () => {
  it("extends the health wait when gateway start exits non-zero but the container is still starting", () => {
    const { getGatewayHealthWaitConfig } = loadOnboard();
    process.env.NEMOCLAW_HEALTH_POLL_COUNT = "5";
    process.env.NEMOCLAW_HEALTH_POLL_INTERVAL = "2";
    process.env.NEMOCLAW_GATEWAY_START_POLL_COUNT = "60";
    process.env.NEMOCLAW_GATEWAY_START_POLL_INTERVAL = "5";

    expect(getGatewayHealthWaitConfig(1, "starting")).toEqual({
      count: 60,
      interval: 5,
      extended: true,
      containerState: "starting",
    });
  });

  it("treats a running container without a health state as a slow-start case", () => {
    const { getGatewayHealthWaitConfig } = loadOnboard();
    process.env.NEMOCLAW_GATEWAY_START_POLL_COUNT = "12";
    process.env.NEMOCLAW_GATEWAY_START_POLL_INTERVAL = "4";

    expect(getGatewayHealthWaitConfig(1, "running")).toEqual({
      count: 12,
      interval: 4,
      extended: true,
      containerState: "running",
    });
  });

  it("extends the wait for other live container states such as created or unhealthy", () => {
    const { getGatewayHealthWaitConfig } = loadOnboard();
    process.env.NEMOCLAW_GATEWAY_START_POLL_COUNT = "9";
    process.env.NEMOCLAW_GATEWAY_START_POLL_INTERVAL = "6";

    expect(getGatewayHealthWaitConfig(1, "created")).toEqual({
      count: 9,
      interval: 6,
      extended: true,
      containerState: "created",
    });
    expect(getGatewayHealthWaitConfig(1, "running unhealthy")).toEqual({
      count: 9,
      interval: 6,
      extended: true,
      containerState: "running unhealthy",
    });
  });

  it("still uses the extended wait when start exits non-zero before container metadata appears", () => {
    const { getGatewayHealthWaitConfig } = loadOnboard();
    process.env.NEMOCLAW_GATEWAY_START_POLL_COUNT = "7";
    process.env.NEMOCLAW_GATEWAY_START_POLL_INTERVAL = "3";
    process.env.NEMOCLAW_HEALTH_POLL_COUNT = "4";
    process.env.NEMOCLAW_HEALTH_POLL_INTERVAL = "1";

    expect(getGatewayHealthWaitConfig(1, "missing")).toEqual({
      count: 4,
      interval: 1,
      extended: false,
      containerState: "missing",
    });
  });

  it("uses the short wait for missing containers regardless of start exit code", () => {
    const { getGatewayHealthWaitConfig } = loadOnboard();
    process.env.NEMOCLAW_HEALTH_POLL_COUNT = "7";
    process.env.NEMOCLAW_HEALTH_POLL_INTERVAL = "3";

    expect(getGatewayHealthWaitConfig(0, "missing")).toEqual({
      count: 7,
      interval: 3,
      extended: false,
      containerState: "missing",
    });
  });

  it("extends the wait when the container is still live even if gateway start exited zero", () => {
    const { getGatewayHealthWaitConfig } = loadOnboard();
    process.env.NEMOCLAW_GATEWAY_START_POLL_COUNT = "8";
    process.env.NEMOCLAW_GATEWAY_START_POLL_INTERVAL = "6";

    expect(getGatewayHealthWaitConfig(0, "running")).toEqual({
      count: 8,
      interval: 6,
      extended: true,
      containerState: "running",
    });
  });
});

describe("gateway bootstrap secret repair", () => {
  it("uses the configured gateway port for local metadata reattachment", () => {
    process.env.NEMOCLAW_GATEWAY_PORT = "9443";
    const { getGatewayLocalEndpoint } = loadOnboard();

    expect(getGatewayLocalEndpoint()).toBe("https://127.0.0.1:9443");
  });

  it("repairs the client CA and client TLS secrets together", () => {
    const { getGatewayBootstrapRepairPlan } = loadOnboard();
    expect(
      getGatewayBootstrapRepairPlan(["openshell-client-tls"]),
    ).toEqual({
      missingSecrets: ["openshell-client-tls"],
      needsRepair: true,
      needsServerTls: false,
      needsClientBundle: true,
      needsHandshake: false,
    });
  });

  it("ignores unknown secret names when planning repairs", () => {
    const { getGatewayBootstrapRepairPlan } = loadOnboard();

    expect(
      getGatewayBootstrapRepairPlan(["openshell-client-tls", "noise", " openshell-server-tls ", ""]),
    ).toEqual({
      missingSecrets: ["openshell-client-tls", "openshell-server-tls"],
      needsRepair: true,
      needsServerTls: true,
      needsClientBundle: true,
      needsHandshake: false,
    });
  });

  it("emits a script that creates all missing bootstrap secrets", () => {
    const { buildGatewayBootstrapSecretsScript } = loadOnboard();
    const script = buildGatewayBootstrapSecretsScript([
      "openshell-server-tls",
      "openshell-server-client-ca",
      "openshell-client-tls",
      "openshell-ssh-handshake",
    ]);

    expect(script).toContain("openshell-server-tls");
    expect(script).toContain("openshell-server-client-ca");
    expect(script).toContain("openshell-client-tls");
    expect(script).toContain("openshell-ssh-handshake");
    expect(script).toContain('CN=openshell-client-ca');
    expect(script).toContain('CN=openshell-client');
    expect(script).toContain("subjectAltName=DNS:openshell");
  });

  it("skips secret generation when nothing is missing", () => {
    const { buildGatewayBootstrapSecretsScript } = loadOnboard();
    expect(buildGatewayBootstrapSecretsScript([]).trim()).toBe("exit 0");
  });
});
