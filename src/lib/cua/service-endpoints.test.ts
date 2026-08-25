// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  CUA_SERVICE_ENDPOINT_ENV,
  materializeCuaServicePolicy,
  renderCuaServiceConfig,
  requireCuaServiceEndpoints,
} from "./service-endpoints";

const serviceEnv = {
  [CUA_SERVICE_ENDPOINT_ENV.browser]: "http://127.0.0.1:18001/",
  [CUA_SERVICE_ENDPOINT_ENV.computer]: "http://localhost:18002/",
  [CUA_SERVICE_ENDPOINT_ENV.terminal]: "http://[::1]:18003/",
  [CUA_SERVICE_ENDPOINT_ENV.fixture]: "http://127.0.0.1:18004/fixture",
};

const baseline = `
version: 1
network_policies:
  managed_inference:
    name: managed_inference
    endpoints:
      - host: inference.local
        port: 443
        access: full
    binaries:
      - path: /usr/bin/python3
  unrelated:
    name: unrelated
    endpoints:
      - host: example.com
        port: 443
        access: full
    binaries:
      - path: /bin/sh
`;

describe("NemoCUA service endpoint projection", () => {
  it("maps exactly four loopback services to the OpenShell host bridge (#10289)", () => {
    expect(requireCuaServiceEndpoints(serviceEnv)).toEqual([
      {
        role: "browser",
        sandboxUrl: "http://host.openshell.internal:18001/",
        path: "/",
        port: 18001,
      },
      {
        role: "computer",
        sandboxUrl: "http://host.openshell.internal:18002/",
        path: "/",
        port: 18002,
      },
      {
        role: "terminal",
        sandboxUrl: "http://host.openshell.internal:18003/",
        path: "/",
        port: 18003,
      },
      {
        role: "fixture",
        sandboxUrl: "http://host.openshell.internal:18004/fixture",
        path: "/fixture",
        port: 18004,
      },
    ]);
  });

  it("renders the exact NVLumina v0.0.5 tool-server settings without fixture state (#10289)", () => {
    const rendered = renderCuaServiceConfig(requireCuaServiceEndpoints(serviceEnv));

    expect(rendered).toContain("[tool_servers]");
    expect(rendered).toContain('base_host = "host.openshell.internal"');
    expect(rendered).toContain("computer_use_port = 18002");
    expect(rendered).toContain("browser_use_port = 18001");
    expect(rendered).toContain("terminal_use_port = 18003");
    expect(rendered).not.toContain("fixture");
    expect(rendered).not.toContain("127.0.0.1");
    expect(rendered).not.toContain("localhost");
  });

  it.each([
    ["missing role", { ...serviceEnv, [CUA_SERVICE_ENDPOINT_ENV.fixture]: undefined }],
    [
      "non-loopback host",
      { ...serviceEnv, [CUA_SERVICE_ENDPOINT_ENV.browser]: "http://example.com:18001" },
    ],
    [
      "credential-bearing URL",
      { ...serviceEnv, [CUA_SERVICE_ENDPOINT_ENV.browser]: "http://user:pass@127.0.0.1:18001" },
    ],
    [
      "query",
      { ...serviceEnv, [CUA_SERVICE_ENDPOINT_ENV.browser]: "http://127.0.0.1:18001/?target=other" },
    ],
    [
      "implicit port",
      { ...serviceEnv, [CUA_SERVICE_ENDPOINT_ENV.browser]: "http://127.0.0.1/browser" },
    ],
    [
      "non-root tool path",
      { ...serviceEnv, [CUA_SERVICE_ENDPOINT_ENV.browser]: "http://127.0.0.1:18001/browser" },
    ],
    [
      "duplicate port",
      { ...serviceEnv, [CUA_SERVICE_ENDPOINT_ENV.fixture]: "http://127.0.0.1:18001/fixture" },
    ],
  ])("rejects %s before sandbox creation (#10289)", (_label, env) => {
    expect(() => requireCuaServiceEndpoints(env as NodeJS.ProcessEnv)).toThrow();
  });

  it("renders only inference and four selected service policies (#10289)", () => {
    const rendered = YAML.parse(
      materializeCuaServicePolicy(baseline, requireCuaServiceEndpoints(serviceEnv)),
    ) as { network_policies: Record<string, unknown> };

    expect(Object.keys(rendered.network_policies)).toEqual([
      "managed_inference",
      "nemocua_browser",
      "nemocua_computer",
      "nemocua_terminal",
      "nemocua_fixture",
    ]);
    expect(rendered.network_policies).not.toHaveProperty("unrelated");
    expect(rendered.network_policies.nemocua_browser).toEqual({
      name: "nemocua_browser",
      endpoints: [
        {
          host: "host.openshell.internal",
          port: 18001,
          allowed_ips: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
          protocol: "rest",
          enforcement: "enforce",
          rules: [
            { allow: { method: "GET", path: "/" } },
            { allow: { method: "GET", path: "/**" } },
            { allow: { method: "POST", path: "/" } },
            { allow: { method: "POST", path: "/**" } },
          ],
        },
      ],
      binaries: [{ path: "/usr/bin/python3" }, { path: "/usr/local/bin/python3" }],
    });
  });
});
