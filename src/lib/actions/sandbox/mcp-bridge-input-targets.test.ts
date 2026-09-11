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
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
const state = require("./src/lib/actions/sandbox/mcp-bridge-state.js");
const sourceState = require("./src/lib/actions/sandbox/mcp-bridge-source.js");
const validation = require("./src/lib/actions/sandbox/mcp-bridge-validation.js");
const trusted = require("./src/lib/security/trusted-private-endpoint.js");
let admittedTarget;
let registeredEntry;
let gatewayRestarted = false;
replace(policies, "getPresetContentGatewayState", () => "absent");
replace(adapters, "assertAgentMcpMutationRuntimeCapability", () => {});
replace(adapters, "inspectAgentAdapterRegistration", () => ({ state: "absent" }));
replace(adapters, "registerAgentAdapterAtCurrentCredentialRevision", (_sandbox, _adapter, entry) => { registeredEntry = entry; return "v1"; });
replace(policy, "applyGeneratedPolicy", (_sandbox, _entry, target) => { admittedTarget = target; });
replace(state, "ensureSandboxGatewaySelected", async () => {});
replace(validation, "assertMcpCredentialBoundaryRuntimeVersion", () => {});
replace(provider, "assertNoProviderCredentialCollisions", () => {});
replace(provider, "getMcpProviderInspectionRuntimeSelection", () => ({ gatewayName: "nemoclaw-9090", workspace: "default" }));
replace(provider, "ensureMcpBridgeProviderProfile", () => {});
replace(provider, "inspectMcpProvider", () => ({
  credentialKeys: null, exists: false, id: null, resourceVersion: null, type: null,
}));
replace(provider, "inspectMcpProviderAttachments", () => ({ attachments: [] }));
replace(provider, "upsertMcpProvider", () => ({
  action: "created",
  inspection: {
    credentialKeys: ["LOCAL_MCP_TOKEN"], exists: true,
    id: "11111111-2222-4333-8444-555555555555", resourceVersion: 1, type: "nemoclaw-mcp-v1",
  },
}));
replace(provider, "attachProvider", () => {});
replace(provider, "refreshMcpProviderEnvironment", () => {});
replace(provider, "observeMcpCredentialRevision", () => "v1");
replace(provider, "waitForAttachedMcpCredential", () => "v1");
replace(processRecovery, "executeSandboxCommand", (_sandbox, command) => ({
  status: 0,
  stdout: command === "command -v mcporter" ? "/usr/bin/mcporter\\n" : command.includes('"config", "get"') ? "registered\\n" : "",
  stderr: "",
}));
replace(processRecovery, "executeSandboxExecCommand", () => ({
  status: 0,
  stdout: "v1\\n",
  stderr: "",
}));
replace(processRecovery, "restartSandboxGateway", () => {
  gatewayRestarted = true;
  return { ok: true, restarted: true, healthPassed: true, forwardRecovered: true };
});
replace(sourceState, "inspectSourceBridgeState", () => ({
  bridges: {}, sources: { native: {}, legacy: {} },
}));
registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  gatewayName: "nemoclaw-9090",
  gatewayPort: 9090,
});
require("./src/lib/actions/sandbox/mcp-bridge.js").addMcpBridge("alpha", {
  server: "local",
  url: "https://mcp.corp.example/mcp",
  env: [{ name: "LOCAL_MCP_TOKEN" }],
  trustedPrivateHosts: ["MCP.CORP.EXAMPLE."],
}).then(() => {
  process.stdout.write(JSON.stringify({
    entry: registeredEntry,
    target: {
      addresses: admittedTarget.addresses,
      capability: trusted.isTrustedPrivateEndpointCapability(
        admittedTarget.trustedPrivateCapability,
      ),
      capabilityAddresses: admittedTarget.trustedPrivateCapability.addresses,
      trustedPrivateHost: admittedTarget.trustedPrivateHost,
    },
    gatewayRestarted,
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
          gatewayRestarted: boolean;
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
        expect(admission.gatewayRestarted).toBe(true);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("does not adopt a retained same-name provider after remove then add", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-retained-provider-"));
    const sourceRequireHook = path.resolve("test/helpers/onboard-script-mocks.cjs");
    const script = `
process.env.HOME = ${JSON.stringify(home)};
process.env.GITHUB_TOKEN = "replacement-host-only-secret";
require("node:dns/promises").lookup = async () => [{ address: "8.8.8.8", family: 4 }];
const replace = (module, name, value) => Object.defineProperty(module, name, {
  configurable: true, enumerable: true, value, writable: true,
});
const registry = require("./src/lib/state/registry.js");
const adapters = require("./src/lib/actions/sandbox/mcp-bridge-adapters.js");
const policies = require("./src/lib/policy/index.js");
const provider = require("./src/lib/actions/sandbox/mcp-bridge-provider.js");
const state = require("./src/lib/actions/sandbox/mcp-bridge-state.js");
const sourceState = require("./src/lib/actions/sandbox/mcp-bridge-source.js");
const validation = require("./src/lib/actions/sandbox/mcp-bridge-validation.js");
const nativeSourceState = {};
replace(adapters, "assertAgentMcpMutationRuntimeCapability", () => {});
replace(adapters, "inspectAgentAdapterRegistration", () => ({ state: "absent" }));
replace(adapters, "registerAgentAdapterAtCurrentCredentialRevision", (_sandbox, _adapter, entry) => {
  nativeSourceState[entry.server] = { ...entry, source: "native" };
  return "v1";
});
replace(state, "ensureSandboxGatewaySelected", async () => {});
replace(validation, "assertMcpCredentialBoundaryRuntimeVersion", () => {});
replace(provider, "assertNoProviderCredentialCollisions", () => {});
replace(provider, "getMcpProviderInspectionRuntimeSelection", () => ({
  gatewayName: "nemoclaw-9090", workspace: "default",
}));
replace(provider, "inspectMcpProvider", () => ({
  credentialKeys: ["GITHUB_TOKEN"], exists: true,
  id: "11111111-2222-4333-8444-555555555555", resourceVersion: 7,
  type: "nemoclaw-mcp-v1",
}));
replace(provider, "inspectMcpProviderAttachments", () => ({ attachments: [] }));
replace(policies, "getPresetContentGatewayState", () => "absent");
replace(sourceState, "inspectSourceBridgeState", () => ({
  bridges: { ...nativeSourceState }, sources: { native: { ...nativeSourceState }, legacy: {} },
}));
const sandbox = {
  name: "alpha", agent: "openclaw", gatewayName: "nemoclaw-9090", gatewayPort: 9090,
};
registry.registerSandbox(sandbox);
const runtimeSelection = { gatewayName: "nemoclaw-9090", workspace: "default" };
const before = sourceState.inspectSourceBridgeState(sandbox, runtimeSelection).sources.native;
require("./src/lib/actions/sandbox/mcp-bridge.js").addMcpBridge("alpha", {
  server: "github",
  url: "https://8.8.8.8/mcp",
  env: [{ name: "GITHUB_TOKEN" }],
}).then(() => process.exit(2), (error) => {
  const after = sourceState.inspectSourceBridgeState(sandbox, runtimeSelection).sources.native;
  process.stdout.write(JSON.stringify({
    message: String(error && error.message ? error.message : error), before, after,
  }), () => process.exit(0));
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
      expect(result.status, result.stderr).toBe(0);
      const rejection = JSON.parse(result.stdout) as {
        message: string;
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      };
      expect(rejection.message).toContain("non-prefix partial state");
      expect(rejection.message).toContain("No source was changed");
      expect(rejection.after).toEqual(rejection.before);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    "policy",
    "policy-url-mismatch",
    "provider",
    "provider-hostless",
    "attachment",
    "bound-policy",
    "adapter",
    "adapter-stable-unauthorized",
    "adapter-update-failed",
  ] as const)(
    "recovers a process-isolated add after the %s phase",
    (phase) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-mcp-recovery-${phase}-`));
      const sourceRequireHook = path.resolve("test/helpers/onboard-script-mocks.cjs");
      const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
process.env.GITHUB_TOKEN = "host-only-secret";
// Simulate DNS rotation after the original policy mutation. An exact retry
// must replay the committed public pins rather than deriving a new request.
require("node:dns/promises").lookup = async () => [{ address: "1.1.1.1", family: 4 }];
const phase = ${JSON.stringify(phase)};
const stableUnauthorized = phase === "adapter-stable-unauthorized";
const updateFailed = phase === "adapter-update-failed";
const seedPhase = stableUnauthorized || updateFailed ? "adapter" : phase;
const expectFailure = phase === "policy-url-mismatch" || stableUnauthorized || updateFailed;
let authorizationProbe;
if (phase === "provider-hostless") delete process.env.GITHUB_TOKEN;
const providerId = "11111111-2222-4333-8444-555555555555";
const state = {
  policy: ["policy", "policy-url-mismatch", "provider", "provider-hostless", "attachment"].includes(seedPhase) ? "capability" : seedPhase === "bound-policy" || seedPhase === "adapter" ? "bound" : "absent",
  provider: ["provider", "provider-hostless", "attachment", "bound-policy", "adapter"].includes(seedPhase),
  attachment: ["attachment", "bound-policy", "adapter"].includes(seedPhase),
  adapter: seedPhase === "adapter",
};
const replace = (module, name, value) => Object.defineProperty(module, name, {
  configurable: true, enumerable: true, value, writable: true,
});
const registry = require("./src/lib/state/registry.js");
const policies = require("./src/lib/policy/index.js");
const adapters = require("./src/lib/actions/sandbox/mcp-bridge-adapters.js");
const provider = require("./src/lib/actions/sandbox/mcp-bridge-provider.js");
const sourceState = require("./src/lib/actions/sandbox/mcp-bridge-source.js");
const bridgeState = require("./src/lib/actions/sandbox/mcp-bridge-state.js");
const validation = require("./src/lib/actions/sandbox/mcp-bridge-validation.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
const entry = () => ({
  server: "github", agent: "openclaw", adapter: "openclaw-config",
  url: "https://8.8.8.8/mcp", env: ["GITHUB_TOKEN"],
  allowedIps: ["8.8.8.8"], providerName: "alpha-mcp-github",
  ...(state.provider ? { providerId } : {}),
  policyName: "mcp-bridge-github", source: "native",
});
replace(adapters, "assertAgentMcpMutationRuntimeCapability", () => {});
replace(adapters, "inspectAgentAdapterRegistration", () => ({ state: state.adapter ? "registered" : "absent" }));
replace(adapters, "registerAgentAdapterAtCurrentCredentialRevision", () => { state.adapter = true; return "v7"; });
replace(adapters, "unregisterAgentAdapter", () => { state.adapter = false; return "removed"; });
replace(bridgeState, "ensureSandboxGatewaySelected", async () => {});
replace(validation, "assertMcpCredentialBoundaryRuntimeVersion", () => {});
replace(provider, "getMcpProviderInspectionRuntimeSelection", () => ({ gatewayName: "nemoclaw", workspace: "default" }));
replace(provider, "inspectMcpProvider", () => state.provider ? ({
  exists: true, id: providerId, resourceVersion: 7,
  type: "nemoclaw-mcp-v1", credentialKeys: ["GITHUB_TOKEN"],
}) : ({ exists: false, id: null, resourceVersion: null, type: null, credentialKeys: null }));
replace(provider, "inspectMcpProviderAttachments", () => ({
  attachments: state.attachment ? [{ name: "alpha-mcp-github", providerId, credentialKeys: ["GITHUB_TOKEN"] }] : [],
}));
replace(provider, "assertNoProviderCredentialCollisions", () => {});
replace(provider, "assertMcpProviderRecoverable", () => provider.inspectMcpProvider());
replace(provider, "ensureMcpBridgeProviderProfile", () => {});
replace(provider, "upsertMcpProvider", async (_name, _env, options) => {
  const action = state.provider ? process.env.GITHUB_TOKEN ? "updated" : "reused" : "created";
  if (action !== "reused") await (options.prepareMutation && options.prepareMutation(action === "updated" ? "update" : "create"));
  state.provider = true;
  if (updateFailed) throw new Error("provider update committed before transport failed");
  return { action, inspection: provider.inspectMcpProvider() };
});
replace(provider, "attachProvider", () => { state.attachment = true; });
const stable = "s" + "a".repeat(64);
replace(provider, "observeMcpCredentialRevision", () => stableUnauthorized ? stable : "v6");
replace(provider, "waitForAttachedMcpCredential", () => stableUnauthorized ? stable : "v7");
if (stableUnauthorized) replace(require("./src/lib/actions/sandbox/mcp-bridge-status.js"), "statusMcpBridge", async (_sandbox, server, options) => {
  authorizationProbe = { server, options };
  return [{ provider: { credentialResolution: { ok: null, httpStatus: 401, controlHttpStatus: 401, detail: "updated credential remained unauthorized" } } }];
});
replace(provider, "refreshMcpProviderEnvironment", () => {});
replace(policies, "getPresetContentGatewayState", (_sandbox, content) => {
  if (state.policy === "absent") return "absent";
  if (phase === "policy-url-mismatch") return "drift";
  const expected = content.includes("credential_binding") ? "bound" : "capability";
  return state.policy === expected && content.includes("8.8.8.8") ? "match" : "drift";
});
replace(policies, "applyPresetContent", (_sandbox, _name, content) => {
  state.policy = content.includes("credential_binding") ? "bound" : "capability";
  return true;
});
replace(sourceState, "inspectSourceBridgeState", () => ({
  bridges: state.adapter ? { github: entry() } : {},
  sources: { native: state.adapter ? { github: entry() } : {}, legacy: {} },
}));
replace(sourceState, "inspectPolicyOnlyMcpEntry", () =>
  state.policy === "absent"
    ? null
    : {
        ...entry(),
        ...(phase === "policy-url-mismatch" ? { url: "https://other.example/mcp" } : {}),
        source: "policy",
        ...(state.policy === "capability" ? { providerName: undefined, providerId: undefined } : {}),
      },
);
replace(processRecovery, "restartSandboxGateway", () => ({
  ok: true, restarted: true, healthPassed: true, forwardRecovered: true,
}));
registry.registerSandbox({ name: "alpha", agent: "openclaw", gatewayName: "nemoclaw" });
require("./src/lib/actions/sandbox/mcp-bridge.js").addMcpBridge("alpha", {
  server: "github", url: "https://8.8.8.8/mcp", env: [{ name: "GITHUB_TOKEN" }],
}).then(() => {
  if (expectFailure) process.exit(2);
  process.stdout.write(JSON.stringify({ state }), () => process.exit(0));
}, (error) => {
  if (!expectFailure) {
    process.stderr.write(String(error && error.stack || error), () => process.exit(1));
    return;
  }
  process.stdout.write(JSON.stringify({
    message: String(error && error.message || error),
    state, authorizationProbe,
  }), () => process.exit(0));
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
        expect(`${result.stdout}\n${result.stderr}`).not.toContain("host-only-secret");
        const outcome = JSON.parse(result.stdout) as {
          message?: string;
          state: Record<string, unknown>;
        };
        expect(outcome).toMatchObject(
          phase === "policy-url-mismatch"
            ? {
                message: expect.stringContaining("incomplete add transaction for a different URL"),
                state: {
                  adapter: false,
                  attachment: false,
                  policy: "capability",
                  provider: false,
                },
              }
            : phase === "adapter-stable-unauthorized" || phase === "adapter-update-failed"
              ? {
                  message: expect.stringContaining(
                    phase === "adapter-stable-unauthorized"
                      ? "did not authorize its unchanged stable credential handle after provider update"
                      : "provider update committed before transport failed",
                  ),
                  state: { adapter: false, attachment: true, policy: "bound", provider: true },
                  ...(phase === "adapter-stable-unauthorized"
                    ? {
                        authorizationProbe: {
                          server: "github",
                          options: expect.objectContaining({
                            probeCredentialResolution: true,
                            runtimeSelection: { gatewayName: "nemoclaw", workspace: "default" },
                          }),
                        },
                      }
                    : {}),
                }
              : {
                  state: {
                    adapter: true,
                    attachment: true,
                    policy: "bound",
                    provider: true,
                  },
                },
        );
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
    40_000,
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
