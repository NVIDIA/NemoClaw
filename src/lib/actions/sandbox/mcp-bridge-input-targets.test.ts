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
const providerInspection = require("./src/lib/actions/sandbox/mcp-bridge-provider-inspection.js");
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
replace(providerInspection, "getMcpProviderInspectionRuntimeSelection", () => ({ gatewayName: "nemoclaw-9090", workspace: "default" }));
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
const providerInspection = require("./src/lib/actions/sandbox/mcp-bridge-provider-inspection.js");
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
replace(providerInspection, "getMcpProviderInspectionRuntimeSelection", () => ({
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
const expectFailure = phase === "policy-url-mismatch";
if (phase === "provider-hostless") delete process.env.GITHUB_TOKEN;
const providerId = "11111111-2222-4333-8444-555555555555";
const state = {
  policy: ["policy", "policy-url-mismatch", "provider", "provider-hostless", "attachment"].includes(phase) ? "capability" : phase === "bound-policy" || phase === "adapter" ? "bound" : "absent",
  provider: ["provider", "provider-hostless", "attachment", "bound-policy", "adapter"].includes(phase),
  attachment: ["attachment", "bound-policy", "adapter"].includes(phase),
  adapter: phase === "adapter",
};
const replace = (module, name, value) => Object.defineProperty(module, name, {
  configurable: true, enumerable: true, value, writable: true,
});
const registry = require("./src/lib/state/registry.js");
const policies = require("./src/lib/policy/index.js");
const adapters = require("./src/lib/actions/sandbox/mcp-bridge-adapters.js");
const provider = require("./src/lib/actions/sandbox/mcp-bridge-provider.js");
const providerInspection = require("./src/lib/actions/sandbox/mcp-bridge-provider-inspection.js");
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
replace(adapters, "unregisterAgentAdapter", () => "removed");
replace(bridgeState, "ensureSandboxGatewaySelected", async () => {});
replace(validation, "assertMcpCredentialBoundaryRuntimeVersion", () => {});
replace(providerInspection, "getMcpProviderInspectionRuntimeSelection", () => ({ gatewayName: "nemoclaw", workspace: "default" }));
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
replace(provider, "upsertMcpProvider", (_name, _env, options) => {
  const action = state.provider ? process.env.GITHUB_TOKEN ? "updated" : "reused" : "created";
  if (action !== "reused") options.prepareMutation && options.prepareMutation(action === "updated" ? "update" : "create");
  state.provider = true;
  return { action, inspection: provider.inspectMcpProvider() };
});
replace(provider, "attachProvider", () => { state.attachment = true; });
replace(provider, "observeMcpCredentialRevision", () => "v6");
replace(provider, "waitForAttachedMcpCredential", () => "v7");
replace(provider, "refreshMcpProviderEnvironment", () => {});
replace(policies, "getPresetContentGatewayState", (_sandbox, content) => {
  if (state.policy === "absent") return "absent";
  if (expectFailure) return "drift";
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
        ...(expectFailure ? { url: "https://other.example/mcp" } : {}),
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
    state,
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

  it.each([
    { agent: "hermes", adapter: "hermes-config", registryText: null },
    { agent: "hermes", adapter: "hermes-config", registryText: "{invalid" },
    { agent: "langchain-deepagents-code", adapter: "deepagents-config", registryText: null },
    { agent: "langchain-deepagents-code", adapter: "deepagents-config", registryText: "{invalid" },
  ])(
    "runs $agent source and policy mutations with registry $registryText",
    ({ agent, adapter, registryText }) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-live-operation-"));
      const openshell = path.join(home, "openshell");
      // Policy still resolves an executable before calling the modeled writer.
      fs.writeFileSync(openshell, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
      const script = String.raw`
const fs = require("node:fs");
const assert = require("node:assert/strict");
const YAML = require("yaml");
const replace = (module, name, value) => Object.defineProperty(module, name, { configurable: true, enumerable: true, value, writable: true });
const state = require("./src/lib/actions/sandbox/mcp-bridge-state.js");
const provider = require("./src/lib/actions/sandbox/mcp-bridge-provider.js");
const inspection = require("./src/lib/actions/sandbox/mcp-bridge-provider-inspection.js");
const adapters = require("./src/lib/actions/sandbox/mcp-bridge-adapters.js");
const recovery = require("./src/lib/actions/sandbox/process-recovery.js");
const policyReader = require("./src/lib/adapters/openshell/sandbox-policy-cli.js");
const identity = require("./src/lib/adapters/openshell/sandbox-identity-cli.js");
const validation = require("./src/lib/actions/sandbox/mcp-bridge-validation.js");
const { REGISTRY_FILE } = require("./src/lib/state/registry/persistence.js");
const registryText = ${JSON.stringify(registryText)};
if (registryText !== null) { fs.mkdirSync(require("node:path").dirname(REGISTRY_FILE), { recursive: true }); fs.writeFileSync(REGISTRY_FILE, registryText, { mode: 0o600 }); }
const runtimeSelection = { gatewayName: "nemoclaw-9090", workspace: "default" };
let identityChecks = 0, resolutions = 0, native = false, attached = false, exists = false, writes = 0;
const target = { sandbox: { name: "alpha", agent: ${JSON.stringify(agent)}, gatewayName: runtimeSelection.gatewayName }, runtimeSelection, liveIdentity: { sandboxId: "exact-live-id", assertCurrent() { assert.equal(this, target.liveIdentity); identityChecks++; } } };
replace(state, "resolveMcpOperationTarget", () => { resolutions++; return target; });
replace(state, "ensureSandboxGatewaySelected", async () => {});
replace(validation, "assertMcpCredentialBoundaryRuntimeVersion", () => {});
replace(adapters, "assertAgentMcpMutationRuntimeCapability", () => {});
replace(adapters, "assertAgentMcpTeardownRuntimeCapability", () => {});
replace(adapters, "inspectAgentAdapterRegistration", () => ({ state: native ? "registered" : "absent" }));
replace(adapters, "registerAgentAdapterAtCurrentCredentialRevision", (_name, actualAdapter, _entry, selection, _env, _revision, options) => { assert.equal(actualAdapter, ${JSON.stringify(adapter)}); assert.equal(selection, runtimeSelection); assert.equal(options.operationTarget, target); native = true; return "v7"; });
replace(adapters, "unregisterAgentAdapter", (_name, actualAdapter, _entry, selection, options) => { assert.equal(actualAdapter, ${JSON.stringify(adapter)}); assert.equal(selection, runtimeSelection); assert.equal(options.operationTarget, target); native = false; return "removed"; });
replace(adapters, "reloadOpenClawGatewayAfterMcpMutation", (_name, _adapters, actualTarget) => assert.equal(actualTarget, target));
const metadata = () => ({ exists, id: exists ? "11111111-2222-4333-8444-555555555555" : null, resourceVersion: exists ? 7 : null, type: exists ? "nemoclaw-mcp-v1" : null, credentialKeys: exists ? ["HOSTLESS_MCP_TOKEN"] : null });
replace(provider, "inspectMcpProvider", metadata);
replace(inspection, "inspectMcpProvider", metadata);
replace(provider, "inspectMcpProviderAttachments", () => ({ attachments: attached ? [{ name: "alpha-mcp-github", providerId: metadata().id, credentialKeys: ["HOSTLESS_MCP_TOKEN"] }] : [] }));
replace(provider, "assertNoProviderCredentialCollisions", (_name, _entries, selection, actualTarget) => { assert.equal(selection, runtimeSelection); assert.equal(actualTarget, target); });
replace(provider, "ensureMcpBridgeProviderProfile", () => {});
replace(provider, "assertMcpProviderRecoverable", metadata);
replace(provider, "upsertMcpProvider", () => { const action = exists ? "updated" : "created"; exists = true; return { action, inspection: metadata() }; });
replace(provider, "attachProvider", () => { attached = true; });
replace(provider, "detachProvider", () => { assert.equal(YAML.parse(document).network_policies?.mcp_bridge_github, undefined); attached = false; return "detached"; });
replace(provider, "observeMcpCredentialRevision", () => "v7");
replace(provider, "waitForAttachedMcpCredential", () => "v7");
replace(provider, "waitForDetachedMcpCredential", () => assert.equal(attached, false));
replace(provider, "refreshMcpProviderEnvironment", () => {});
replace(recovery, "executeSandboxCommand", (_name, command, options) => {
  assert.equal(options.runtimeSelection, runtimeSelection);
  const records = native ? [{ server: "github", url: "https://8.8.8.8/mcp", env: "HOSTLESS_MCP_TOKEN", source: "native" }] : [];
  const source = ${JSON.stringify(adapter)} === "hermes-config" ? JSON.stringify({ mcp_servers: native ? { github: { url: records[0].url, headers: { Authorization: "Bearer openshell:resolve:env:v7_HOSTLESS_MCP_TOKEN" } } } : {} }) : JSON.stringify(records);
  return { status: 0, stdout: command.includes("MAX_BYTES = 262144") ? source : "registered", stderr: "" };
});
let document = "version: 1\nnetwork_policies: {}\n";
replace(identity, "inspectOpenShellSandboxIdentityFingerprint", () => "exact-fingerprint");
replace(policyReader.syncCliOpenShellSandboxPolicyReader, "inspectSandboxPolicy", () => ({ ok: true, value: { policySource: "sandbox", effectivePolicy: {}, policyIdentity: { hash: "policy-alpha", activeVersion: 7 } } }));
replace(policyReader.syncCliOpenShellSandboxPolicyReader, "readSandboxPolicy", (request) => { assert.equal(request.sandboxName, "alpha"); assert.equal(request.runtimeSelection, runtimeSelection); return { ok: true, value: { document, appliedRevision: 7 } }; });
replace(policyReader.syncCliOpenShellSandboxPolicyWriter, "setSandboxPolicy", (request) => { assert.equal(request.sandboxName, "alpha"); assert.equal(request.runtimeSelection, runtimeSelection); document = fs.readFileSync(request.policyPath, "utf8"); writes++; return { outcome: { kind: "applied" }, status: 0 }; });
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
(async () => {
  await bridge.addMcpBridge("alpha", { server: "github", url: "https://8.8.8.8/mcp", env: [{ name: "HOSTLESS_MCP_TOKEN", value: "fixture-only-secret" }] });
  await bridge.updateMcpBridgeDenyTools("alpha", "github", ["delete_*"]);
  await bridge.restartMcpBridge("alpha", "github");
  await bridge.removeMcpBridge("alpha", "github");
  assert.equal(native, false); assert.equal(attached, false); assert.equal(exists, true);
  assert.deepEqual(YAML.parse(document).network_policies, {});
  const finalRegistry = fs.existsSync(REGISTRY_FILE) ? fs.readFileSync(REGISTRY_FILE, "utf8") : null;
  process.stdout.write("__RESULT__" + JSON.stringify({ finalRegistry, writes, identityChecks, resolutions }), () => process.exit(0));
})().catch((error) => { process.stderr.write(error.stack || String(error), () => process.exit(1)); });
`;
      try {
        const result = spawnSync(process.execPath, ["-e", script], {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            HOME: home,
            NEMOCLAW_OPENSHELL_BIN: openshell,
            NODE_OPTIONS: [
              process.env.NODE_OPTIONS,
              `--require=${path.resolve("test/helpers/onboard-script-mocks.cjs")}`,
            ]
              .filter(Boolean)
              .join(" "),
          },
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        const outcome = JSON.parse(result.stdout.split("__RESULT__")[1]) as {
          finalRegistry: string | null;
          writes: number;
          identityChecks: number;
          resolutions: number;
        };
        expect(outcome.finalRegistry).toBe(registryText);
        expect(outcome.writes).toBe(5);
        expect(outcome.identityChecks).toBeGreaterThan(5);
        expect(outcome.resolutions).toBe(4);
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
