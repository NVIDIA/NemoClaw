// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { isTrustedPrivateEndpointCapability } from "../../security/trusted-private-endpoint";
import { addMcpBridge, normalizeMcpServerUrl } from "./mcp-bridge";
import {
  inspectMcpRecordedTargetPins,
  preflightMcpServerUrlResolvedTarget,
} from "./mcp-bridge-url-validation";

describe("MCP URL target validation", () => {
  it("sorts and deduplicates public DNS pins deterministically", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "8.8.8.8", family: 4 },
      { address: "8.8.8.8", family: 4 },
    ] as never);
    try {
      await expect(
        preflightMcpServerUrlResolvedTarget(new URL("https://mcp.example.test/mcp")),
      ).resolves.toEqual({ addresses: ["2606:4700:4700::1111", "8.8.8.8"] });
    } finally {
      lookup.mockRestore();
    }
  });

  it("rejects private DNS answers and OpenShell host aliases before DNS", async () => {
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);
    try {
      await expect(
        preflightMcpServerUrlResolvedTarget(new URL("https://mcp.example.test/mcp")),
      ).rejects.toThrow(/resolves to private, local, or special-use address '127\.0\.0\.1'/);
      await expect(
        preflightMcpServerUrlResolvedTarget(new URL("https://host.openshell.internal:31337/mcp")),
      ).rejects.toThrow(/does not expose an attested driver gateway address/);
      expect(lookup).toHaveBeenCalledOnce();
    } finally {
      lookup.mockRestore();
    }
  });

  it("rejects IPv6 literals before DNS until the pinned proxy parser supports them", async () => {
    const lookup = vi.spyOn(dns, "lookup");
    try {
      await expect(
        preflightMcpServerUrlResolvedTarget(new URL("https://[2606:4700:4700::1111]/mcp")),
      ).rejects.toThrow(/IPv6-literal MCP server URLs are not supported/);
      await expect(
        preflightMcpServerUrlResolvedTarget(new URL("https://[fd00::40]/mcp"), {
          trustedPrivateHosts: ["fd00::40"],
          requireTrustedPrivateEndpoint: true,
        }),
      ).rejects.toThrow(/IPv6-literal MCP server URLs are not supported/);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it("issues exact private pins only for the matching operator trust (#8176)", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "10.20.30.41", family: 4 },
      { address: "10.20.30.40", family: 4 },
      { address: "10.20.30.40", family: 4 },
    ] as never);
    try {
      await expect(
        preflightMcpServerUrlResolvedTarget(new URL("https://mcp.corp.example/mcp"), {
          trustedPrivateHosts: ["mcp.corp.example"],
          requireTrustedPrivateEndpoint: true,
        }),
      ).resolves.toEqual({
        addresses: ["10.20.30.40", "10.20.30.41"],
        trustedPrivateCapability: expect.objectContaining({
          addresses: ["10.20.30.40", "10.20.30.41"],
        }),
        trustedPrivateHost: "mcp.corp.example",
      });
    } finally {
      lookup.mockRestore();
    }
  });

  it("admits a direct private IPv4 target with exact host-bound authority (#8267)", async () => {
    const lookup = vi.spyOn(dns, "lookup");
    try {
      const url = normalizeMcpServerUrl("https://10.20.30.40/mcp", {
        trustedPrivateHosts: ["10.20.30.40"],
      });
      const target = await preflightMcpServerUrlResolvedTarget(new URL(url), {
        trustedPrivateHosts: ["10.20.30.40"],
        requireTrustedPrivateEndpoint: true,
      });

      expect(lookup).not.toHaveBeenCalled();
      expect(target).toMatchObject({
        addresses: ["10.20.30.40"],
        trustedPrivateHost: "10.20.30.40",
      });
      expect(isTrustedPrivateEndpointCapability(target.trustedPrivateCapability)).toBe(true);
      expect(target.trustedPrivateCapability).toMatchObject({
        host: "10.20.30.40",
        addresses: ["10.20.30.40"],
      });
    } finally {
      lookup.mockRestore();
    }
  });

  it("admits a trusted reserved-suffix DNS target with exact private pins (#8267)", async () => {
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockResolvedValue([{ address: "10.20.30.40", family: 4 }] as never);
    try {
      expect(() => normalizeMcpServerUrl("https://mcp.corp.internal/mcp")).toThrow(
        /private, local, or special-use/,
      );
      const url = normalizeMcpServerUrl("https://mcp.corp.internal/mcp", {
        trustedPrivateHosts: ["mcp.corp.internal"],
      });
      await expect(
        preflightMcpServerUrlResolvedTarget(new URL(url), {
          trustedPrivateHosts: ["mcp.corp.internal"],
          requireTrustedPrivateEndpoint: true,
        }),
      ).resolves.toMatchObject({
        addresses: ["10.20.30.40"],
        trustedPrivateHost: "mcp.corp.internal",
        trustedPrivateCapability: {
          host: "mcp.corp.internal",
          addresses: ["10.20.30.40"],
        },
      });
    } finally {
      lookup.mockRestore();
    }
  });

  it(
    "persists exact normalized pins after successful trusted-private admission (#8267)",
    {
      timeout: 40_000,
    },
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-private-mcp-add-success-"));
      const sourceRequireHook = path.resolve("test/helpers/onboard-script-mocks.cjs");
      const script = `
process.env.HOME = ${JSON.stringify(home)};
process.env.LOCAL_MCP_TOKEN = "host-only-secret";
require("node:dns/promises").lookup = async () => [
  { address: "10.20.30.41", family: 4 },
  { address: "10.20.30.40", family: 4 },
  { address: "10.20.30.40", family: 4 },
];
const replace = (module, name, value) => Object.defineProperty(module, name, {
  configurable: true, enumerable: true, value, writable: true,
});
const registry = require("./src/lib/state/registry.js");
const policies = require("./src/lib/policy/index.js");
const adapters = require("./src/lib/actions/sandbox/mcp-bridge-adapters.js");
const policy = require("./src/lib/actions/sandbox/mcp-bridge-policy.js");
const provider = require("./src/lib/actions/sandbox/mcp-bridge-provider.js");
const state = require("./src/lib/actions/sandbox/mcp-bridge-state.js");
const validation = require("./src/lib/actions/sandbox/mcp-bridge-validation.js");
const trusted = require("./src/lib/security/trusted-private-endpoint.js");
let admittedTarget;
replace(policies, "getPresetContentGatewayState", () => "absent");
replace(adapters, "assertAgentMcpConfigMutationAllowed", () => {});
replace(adapters, "assertAgentMcpMutationRuntimeCapability", () => {});
replace(adapters, "inspectAgentAdapterRegistration", () => ({ state: "absent" }));
replace(adapters, "registerAgentAdapter", () => {});
replace(policy, "applyGeneratedPolicy", (_sandbox, _entry, target) => { admittedTarget = target; });
replace(state, "ensureSandboxGatewaySelected", async () => {});
replace(validation, "assertMcpCredentialBoundaryRuntimeVersion", () => {});
replace(provider, "assertNoProviderCredentialCollisions", () => {});
replace(provider, "ensureMcpBridgeProviderProfile", () => {});
replace(provider, "inspectMcpProvider", () => ({
  credentialKeys: null, exists: false, id: null, resourceVersion: null, type: null,
}));
replace(provider, "upsertMcpProvider", () => ({
  action: "created",
  inspection: {
    credentialKeys: ["LOCAL_MCP_TOKEN"], exists: true,
    id: "11111111-2222-4333-8444-555555555555", resourceVersion: "1", type: "nemoclaw-mcp-v1",
  },
}));
replace(provider, "attachProvider", () => {});
replace(provider, "observeMcpCredentialRevision", () => "v-before-private-target-update");
replace(provider, "refreshMcpProviderEnvironment", () => {});
replace(provider, "waitForAttachedMcpCredential", () => "v-after-private-target-update");
registry.registerSandbox({ name: "alpha", agent: "openclaw" });
require("./src/lib/actions/sandbox/mcp-bridge.js").addMcpBridge("alpha", {
  server: "local",
  url: "https://mcp.corp.example/mcp",
  env: [{ name: "LOCAL_MCP_TOKEN" }],
  trustedPrivateHosts: ["MCP.CORP.EXAMPLE."],
}).then(() => {
  const entry = registry.getSandbox("alpha").mcp.bridges.local;
  process.stdout.write(JSON.stringify({
    entry,
    target: {
      addresses: admittedTarget.addresses,
      capability: trusted.isTrustedPrivateEndpointCapability(
        admittedTarget.trustedPrivateCapability,
      ),
      capabilityAddresses: admittedTarget.trustedPrivateCapability.addresses,
      trustedPrivateHost: admittedTarget.trustedPrivateHost,
    },
  }), () => process.exit(0));
}, (error) => {
  process.stderr.write(error.stack || error.message, () => process.exit(1));
});
`;
      try {
        const result = spawnSync(process.execPath, ["-e", script], {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${sourceRequireHook}`]
              .filter(Boolean)
              .join(" "),
          },
          timeout: 30_000,
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        const admission = JSON.parse(result.stdout) as {
          entry: Record<string, unknown>;
          target: Record<string, unknown>;
        };
        expect(admission.entry).toMatchObject({
          allowedIps: ["10.20.30.40", "10.20.30.41"],
          trustedPrivateHost: "mcp.corp.example",
        });
        expect(admission.target).toEqual({
          addresses: ["10.20.30.40", "10.20.30.41"],
          capability: true,
          capabilityAddresses: ["10.20.30.40", "10.20.30.41"],
          trustedPrivateHost: "mcp.corp.example",
        });
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("rejects mixed answers and an unused trusted-private option (#8267)", async () => {
    const lookup = vi.spyOn(dns, "lookup");
    try {
      lookup.mockResolvedValueOnce([
        { address: "10.20.30.40", family: 4 },
        { address: "8.8.8.8", family: 4 },
      ] as never);
      await expect(
        preflightMcpServerUrlResolvedTarget(new URL("https://mcp.corp.example/mcp"), {
          trustedPrivateHosts: ["mcp.corp.example"],
          requireTrustedPrivateEndpoint: true,
        }),
      ).rejects.toThrow(/must resolve only to supported routed private addresses/);

      lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }] as never);
      await expect(
        preflightMcpServerUrlResolvedTarget(new URL("https://mcp.corp.example/mcp"), {
          trustedPrivateHosts: ["mcp.corp.example"],
          requireTrustedPrivateEndpoint: true,
        }),
      ).rejects.toThrow(/is unused/);
    } finally {
      lookup.mockRestore();
    }
  });

  it("reports recorded private pins as match, drift, or unresolved without mutation (#8267)", async () => {
    const lookup = vi.spyOn(dns, "lookup");
    const matchingPins = ["10.20.30.40"];
    const driftedPins = ["10.20.30.40"];
    const unresolvedPins = ["10.20.30.40"];
    try {
      lookup.mockResolvedValueOnce([{ address: "10.20.30.40", family: 4 }] as never);
      await expect(
        inspectMcpRecordedTargetPins(
          new URL("https://mcp.corp.example/mcp"),
          "mcp.corp.example",
          matchingPins,
        ),
      ).resolves.toMatchObject({ state: "match", currentAddresses: ["10.20.30.40"] });
      expect(matchingPins).toEqual(["10.20.30.40"]);

      lookup.mockResolvedValueOnce([{ address: "10.20.30.41", family: 4 }] as never);
      await expect(
        inspectMcpRecordedTargetPins(
          new URL("https://mcp.corp.example/mcp"),
          "mcp.corp.example",
          driftedPins,
        ),
      ).resolves.toMatchObject({ state: "drift", currentAddresses: ["10.20.30.41"] });
      expect(driftedPins).toEqual(["10.20.30.40"]);

      lookup.mockRejectedValueOnce(new Error("resolver unavailable"));
      await expect(
        inspectMcpRecordedTargetPins(
          new URL("https://mcp.corp.example/mcp"),
          "mcp.corp.example",
          unresolvedPins,
        ),
      ).resolves.toMatchObject({ state: "unresolved" });
      expect(unresolvedPins).toEqual(["10.20.30.40"]);
    } finally {
      lookup.mockRestore();
    }
  });

  it("requires a routed private endpoint for an explicitly trusted loopback URL (#8267)", () => {
    expect(() =>
      normalizeMcpServerUrl("https://127.0.0.1/mcp", {
        trustedPrivateHosts: ["127.0.0.1"],
      }),
    ).toThrow(/Sandbox loopback is not the host MCP service.*stable routed private address/);
  });

  it.each(["host.openshell.internal", "host.docker.internal", "host.containers.internal"])(
    "rejects the hostile %s alias before sandbox or network side effects",
    async (host) => {
      const lookup = vi.spyOn(dns, "lookup");
      try {
        await expect(
          addMcpBridge("missing-sandbox", {
            server: "local",
            url: `https://${host}:31337/mcp`,
            env: [{ name: "SAFE_MCP_TOKEN", value: "host-only-secret" }],
          }),
        ).rejects.toThrow(/does not expose an attested driver gateway address/);
        expect(lookup).not.toHaveBeenCalled();
      } finally {
        lookup.mockRestore();
      }
    },
  );

  it.each(["%", "%GG", "%2"])(
    "rejects the malformed %j path before DNS or sandbox side effects",
    async (path) => {
      const lookup = vi.spyOn(dns, "lookup");
      try {
        await expect(
          addMcpBridge("missing-sandbox", {
            server: "malformed",
            url: `https://mcp.example.test/${path}`,
            env: [{ name: "SAFE_MCP_TOKEN", value: "host-only-secret" }],
          }),
        ).rejects.toThrow(/percent characters/);
        expect(lookup).not.toHaveBeenCalled();
      } finally {
        lookup.mockRestore();
      }
    },
  );

  it("rejects local, private, and OpenShell host-alias URL targets", () => {
    expect(() => normalizeMcpServerUrl("https://localhost:31337/mcp")).toThrow(
      /private, local, or special-use IP/,
    );
    expect(() => normalizeMcpServerUrl("https://127.0.0.1:31337/mcp")).toThrow(
      /private, local, or special-use IP/,
    );
    expect(() => normalizeMcpServerUrl("https://169.254.169.254/latest")).toThrow(
      /private, local, or special-use IP/,
    );
    expect(() => normalizeMcpServerUrl("https://[::1]:31337/mcp")).toThrow(
      /IPv6-literal MCP server URLs are not supported/,
    );
    expect(() => normalizeMcpServerUrl("https://[::ffff:a00:1]:31337/mcp")).toThrow(
      /IPv6-literal MCP server URLs are not supported/,
    );
    expect(() => normalizeMcpServerUrl("https://[::ffff:127.0.0.1]:31337/mcp")).toThrow(
      /IPv6-literal MCP server URLs are not supported/,
    );
    expect(() => normalizeMcpServerUrl("https://[::ffff:7f00:1]:31337/mcp")).toThrow(
      /IPv6-literal MCP server URLs are not supported/,
    );
    expect(() => normalizeMcpServerUrl("http://mcp.example.test/mcp")).toThrow(/must use https/);
    expect(normalizeMcpServerUrl("https://8.8.8.8/mcp")).toBe("https://8.8.8.8/mcp");
    expect(() => normalizeMcpServerUrl("https://[2606:4700::1]/mcp")).toThrow(
      /IPv6-literal MCP server URLs are not supported/,
    );
    expect(() => normalizeMcpServerUrl("http://host.openshell.internal:31337/mcp")).toThrow(
      /must use https/,
    );
  });

  it.each(["2130706433", "0177.0.0.1", "0x7f.0.0.1", "localhost."])(
    "rejects the local host spelling %s",
    (host) => {
      expect(() => normalizeMcpServerUrl(`https://${host}:31337/mcp`)).toThrow(
        /private, local, or special-use IP/,
      );
    },
  );

  it.each([
    "host.openshell.internal",
    "host.openshell.internal.",
    "host.docker.internal",
    "host.containers.internal",
  ])("rejects the unattested OpenShell host alias %s", (host) => {
    expect(() => normalizeMcpServerUrl(`https://${host}:31337/mcp`)).toThrow(
      /does not expose an attested driver gateway address/,
    );
  });

  it("explains managed-vs-agent-native parity in the https rejection (#6971)", () => {
    // A plain-http URL an agent-native path (OpenClaw mcporter) accepts must not read as a
    // Hermes-specific limitation; the managed rejection names the shared, every-agent boundary.
    expect(() => normalizeMcpServerUrl("http://mcp.example.test/mcp")).toThrow(
      /Managed mcp add enforces this for every agent/,
    );
    expect(() => normalizeMcpServerUrl("http://mcp.example.test/mcp")).toThrow(
      /agent-native registration path/,
    );
  });
});
