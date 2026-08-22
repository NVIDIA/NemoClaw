// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const sourceRequireHook = path.resolve("test/helpers/onboard-script-mocks.cjs");

describe("managed MCP policy authority", () => {
  it(
    "verifies external policy before active MCP mutations and preserves owned teardown cleanup (#9833)",
    { timeout: 40_000 },
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-policy-authority-"));
      const script = String.raw`
process.env.HOME = ${JSON.stringify(home)};
process.env.MCP_TOKEN = "host-only-secret";
require("node:dns/promises").lookup = async () => [{ address: "8.8.8.8", family: 4 }];
const replace = (module, name, value) => Object.defineProperty(module, name, {
  configurable: true, enumerable: true, value, writable: true,
});
const registry = require("./src/lib/state/registry.js");
const policies = require("./src/lib/policy/index.js");
const adapters = require("./src/lib/actions/sandbox/mcp-bridge-adapters.js");
const contracts = require("./src/lib/actions/sandbox/mcp-bridge-contracts.js");
const policy = require("./src/lib/actions/sandbox/mcp-bridge-policy.js");
const policyAuthority = require("./src/lib/actions/sandbox/policy-authority/preflight.js");
const provider = require("./src/lib/actions/sandbox/mcp-bridge-provider.js");
const runtime = require("./src/lib/actions/sandbox/mcp-bridge-runtime-capabilities.js");
const state = require("./src/lib/actions/sandbox/mcp-bridge-state.js");
const validation = require("./src/lib/actions/sandbox/mcp-bridge-validation.js");

const mutations = [];
const preflights = [];
let authorityMode = "missing";
let authorityCheck = 0;
let rejectAuthorityAt = 0;
let rejectAfterAdapter = false;
let refuseRollbackAfterAdapterFailure = false;
let refusePolicyRemoval = false;
let rollbackRefusalOffset = 1;
let recordRollbackInspections = false;
let adapterRegistered = false;
let providerExists = false;
let providerDrifted = false;
let providerRecoverable = true;
const providerId = "11111111-2222-4333-8444-555555555555";

const inspectPolicyAuthority = (options) => {
  authorityCheck += 1;
  const requirement = options.requiredPolicyContents?.[0] ?? "";
  preflights.push({
    externalPolicy: options.externalPolicy,
    hasBoundRequirement:
      requirement.includes("mcp_bridge_example:") &&
      requirement.includes("credential_binding:"),
    operation: options.operation,
    providerBinding: /\n\s+provider:\s+(\S+)/u.exec(requirement)?.[1] ?? null,
    requirementCount: options.requiredPolicyContents?.length ?? 0,
  });
  if (
    options.sandboxName === "alpha" &&
    registry.getSandbox("alpha")?.policyAuthority === undefined
  ) {
    registry.updateSandbox("alpha", { policyAuthority: "externally-managed" });
  }
  if (authorityMode === "missing") {
    throw new policy.McpPolicyAuthorityRefusalError(
      "the externally managed policy has missing entries",
    );
  }
  if (authorityMode === "refuse") {
    throw new Error("this sandbox policy is externally managed");
  }
  if (rejectAuthorityAt === authorityCheck) {
    throw new policy.McpPolicyAuthorityRefusalError(
      "OpenShell policy authority changed during MCP setup",
    );
  }
  return authorityMode === "managed" ? "nemoclaw-managed" : "externally-managed";
};
replace(policy, "preflightMcpPolicyAuthority", inspectPolicyAuthority);
replace(policyAuthority, "preflightSandboxPolicyAuthority", inspectPolicyAuthority);
replace(policy, "applyGeneratedPolicy", () => mutations.push("policy:apply"));
replace(policy, "removeGeneratedPolicy", () => {
  mutations.push("policy:remove");
  if (refusePolicyRemoval) {
    throw new policy.McpPolicyAuthorityRefusalError(
      "OpenShell policy authority changed during MCP removal",
    );
  }
});
replace(policy, "assertGeneratedPolicyMutationSafe", () => {
  mutations.push("policy:managed-ownership-check");
  throw new Error("managed policy ownership check must not run");
});
replace(policies, "getPresetContentGatewayState", () => {
  mutations.push("policy:managed-state-check");
  return "absent";
});

replace(adapters, "assertAgentMcpConfigMutationAllowed", () => {});
replace(adapters, "assertAgentMcpMutationRuntimeCapability", () => {});
replace(adapters, "assertAgentMcpTeardownRuntimeCapability", () => {});
replace(adapters, "inspectAgentAdapterRegistration", () => ({
  state: adapterRegistered ? "registered" : "absent",
}));
replace(adapters, "registerAgentAdapter", () => {
  adapterRegistered = true;
  mutations.push("adapter:register");
  if (refuseRollbackAfterAdapterFailure) {
    rejectAuthorityAt = authorityCheck + rollbackRefusalOffset;
    recordRollbackInspections = true;
    throw new contracts.McpBridgeError("adapter reload failed", 2, "unresolved", {
      cause: new Error("adapter reload root"),
    });
  }
  if (rejectAfterAdapter) rejectAuthorityAt = authorityCheck + 1;
});
replace(adapters, "unregisterAgentAdapter", () => {
  adapterRegistered = false;
  mutations.push("adapter:remove");
});
replace(runtime, "assertMcpAdapterConfigMutationsAllowed", () => {});
replace(runtime, "assertMcpAdapterMutationRuntimeCapabilities", () => {});

const providerInspection = () => {
  if (recordRollbackInspections) mutations.push("provider:inspect");
  return {
    credentialKeys: providerExists ? ["MCP_TOKEN"] : null,
    exists: providerExists,
    id: providerExists
      ? providerDrifted
        ? "99999999-8888-4777-8666-555555555555"
        : providerId
      : null,
    resourceVersion: providerExists ? "1" : null,
    type: providerExists ? "nemoclaw-mcp-v1" : null,
  };
};
replace(provider, "assertMcpProviderRecoverable", () => {
  if (!providerRecoverable) throw new Error("provider recovery failed");
  return providerInspection();
});
replace(provider, "assertNoAttachedProviderCredentialCollisions", () => {});
replace(provider, "assertNoProviderCredentialCollisions", () => {});
replace(provider, "attachProvider", () => mutations.push("provider:attach"));
replace(provider, "deleteProvider", () => {
  providerExists = false;
  mutations.push("provider:delete");
});
replace(provider, "detachProvider", () => {
  mutations.push("provider:detach");
  return "detached";
});
replace(provider, "ensureMcpBridgeProviderProfile", () => mutations.push("provider:profile"));
replace(provider, "inspectMcpProvider", providerInspection);
replace(provider, "observeMcpCredentialRevision", () => "v1");
replace(provider, "preflightMcpEntryTargets", async (entries) => new Map(
  entries.map((entry) => [entry.server, { addresses: ["8.8.8.8"] }]),
));
replace(provider, "refreshMcpProviderEnvironment", () => mutations.push("provider:refresh"));
replace(provider, "upsertMcpProvider", (_name, _env, options) => {
  const action = providerExists ? "updated" : "created";
  if (action === "updated") options.prepareMutation?.("update");
  providerExists = true;
  mutations.push("provider:" + action);
  return { action, inspection: providerInspection() };
});
replace(provider, "waitForAttachedMcpCredential", () => {});
replace(provider, "waitForDetachedMcpCredential", () => {});

replace(state, "ensureSandboxGatewaySelected", async () => mutations.push("gateway:select"));
const writeBridgeEntry = state.writeBridgeEntry;
replace(state, "writeBridgeEntry", (...args) => {
  mutations.push("registry:write");
  return writeBridgeEntry(...args);
});
replace(validation, "assertMcpCredentialBoundaryRuntimeVersion", () => {});

registry.registerSandbox({
  name: "alpha",
  agent: "openclaw",
  createdAt: "2026-08-20T00:00:00.000Z",
  gatewayName: "nemoclaw",
  lifecycleGeneration: "11111111-1111-4111-8111-111111111111",
});
const bridge = require("./src/lib/actions/sandbox/mcp-bridge.js");
const addOptions = {
  server: "example",
  url: "https://mcp.example.test/mcp",
  env: [{ name: "MCP_TOKEN" }],
};

(async () => {
  const missingMessages = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await bridge.addMcpBridge("alpha", addOptions);
    } catch (error) {
      missingMessages.push(error instanceof Error ? error.message : String(error));
    }
  }
  const afterMissing = {
    bridge: registry.getSandbox("alpha")?.mcp?.bridges?.example,
    bridgePresent: !!registry.getSandbox("alpha")?.mcp?.bridges?.example,
    customPolicies: registry.getCustomPolicies("alpha"),
    mutations: [...mutations],
    policyAuthority: registry.getSandbox("alpha")?.policyAuthority,
  };
  registry.removeSandbox("alpha");
  registry.registerSandbox({
    name: "alpha",
    agent: "openclaw",
    createdAt: "2026-08-20T00:00:00.000Z",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "22222222-2222-4222-8222-222222222222",
    policyAuthority: "externally-managed",
  });
  let nextLifecycleMessage = "";
  try {
    await bridge.addMcpBridge("alpha", addOptions);
  } catch (error) {
    nextLifecycleMessage = error instanceof Error ? error.message : String(error);
  }

  registry.registerSandbox({
    name: "drift-add",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    policyAuthority: "externally-managed",
  });
  authorityMode = "external";
  authorityCheck = 0;
  rejectAuthorityAt = 2;
  mutations.length = 0;
  let driftAddMessage = "";
  try {
    await bridge.addMcpBridge("drift-add", addOptions);
  } catch (error) {
    driftAddMessage = error instanceof Error ? error.message : String(error);
  }
  const afterDriftAdd = {
    bridge: registry.getSandbox("drift-add")?.mcp?.bridges?.example,
    bridgePresent: !!registry.getSandbox("drift-add")?.mcp?.bridges?.example,
    mutations: [...mutations],
  };

  authorityMode = "external";
  authorityCheck = 0;
  rejectAuthorityAt = 0;
  mutations.length = 0;
  await bridge.addMcpBridge("alpha", addOptions);
  const afterAdd = {
    bridge: registry.getSandbox("alpha")?.mcp?.bridges?.example,
    customPolicies: registry.getCustomPolicies("alpha"),
    mutations: [...mutations],
  };

  authorityCheck = 0;
  rejectAuthorityAt = 2;
  mutations.length = 0;
  let driftRestartMessage = "";
  try {
    await bridge.restartMcpBridge("alpha", "example");
  } catch (error) {
    driftRestartMessage = error instanceof Error ? error.message : String(error);
  }
  const afterDriftRestart = {
    bridgePresent: !!registry.getSandbox("alpha")?.mcp?.bridges?.example,
    mutations: [...mutations],
  };

  authorityCheck = 0;
  rejectAuthorityAt = 0;
  mutations.length = 0;
  await bridge.restartMcpBridge("alpha", "example");
  const afterRestart = {
    bridgePresent: !!registry.getSandbox("alpha")?.mcp?.bridges?.example,
    customPolicies: registry.getCustomPolicies("alpha"),
    mutations: [...mutations],
  };

  registry.registerSandbox({
    name: "final-drift",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    policyAuthority: "externally-managed",
  });
  authorityCheck = 0;
  rejectAuthorityAt = 0;
  rejectAfterAdapter = true;
  adapterRegistered = false;
  providerExists = false;
  mutations.length = 0;
  let finalDriftMessage = "";
  try {
    await bridge.addMcpBridge("final-drift", addOptions);
  } catch (error) {
    finalDriftMessage = error instanceof Error ? error.message : String(error);
  }
  rejectAfterAdapter = false;
  const afterFinalDrift = {
    bridge: registry.getSandbox("final-drift")?.mcp?.bridges?.example,
    mutations: [...mutations],
  };

  const rollbackRaces = [];
  for (rollbackRefusalOffset = 1; rollbackRefusalOffset <= 5; rollbackRefusalOffset += 1) {
    const sandboxName = "rollback-drift-" + rollbackRefusalOffset;
    registry.registerSandbox({
      name: sandboxName,
      agent: "openclaw",
      gatewayName: "nemoclaw",
      policyAuthority: "externally-managed",
    });
    authorityCheck = 0;
    rejectAuthorityAt = 0;
    refuseRollbackAfterAdapterFailure = true;
    adapterRegistered = false;
    providerExists = false;
    mutations.length = 0;
    let message = "";
    let exitCode = null;
    let reasonCode = null;
    let causeMessage = null;
    try {
      await bridge.addMcpBridge(sandboxName, addOptions);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      exitCode = error?.exitCode ?? null;
      reasonCode = error?.reasonCode ?? null;
      causeMessage = error?.cause instanceof Error ? error.cause.message : null;
    }
    refuseRollbackAfterAdapterFailure = false;
    recordRollbackInspections = false;
    rollbackRaces.push({
      bridge: registry.getSandbox(sandboxName)?.mcp?.bridges?.example,
      causeMessage,
      exitCode,
      message,
      mutations: [...mutations],
      reasonCode,
      refusalOffset: rollbackRefusalOffset,
    });
  }

  registry.registerSandbox({
    name: "rb-policy-refusal",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    policyAuthority: "nemoclaw-managed",
  });
  authorityMode = "managed";
  authorityCheck = 0;
  rejectAuthorityAt = 0;
  rollbackRefusalOffset = 99;
  refuseRollbackAfterAdapterFailure = true;
  refusePolicyRemoval = true;
  adapterRegistered = false;
  providerExists = false;
  mutations.length = 0;
  let rollbackPolicyRefusal = null;
  try {
    await bridge.addMcpBridge("rb-policy-refusal", addOptions);
  } catch (error) {
    rollbackPolicyRefusal = {
      causeMessage: error?.cause instanceof Error ? error.cause.message : null,
      exitCode: error?.exitCode ?? null,
      message: error instanceof Error ? error.message : String(error),
      nestedCauseMessage:
        error?.cause?.cause instanceof Error ? error.cause.cause.message : null,
      reasonCode: error?.reasonCode ?? null,
    };
  }
  refuseRollbackAfterAdapterFailure = false;
  refusePolicyRemoval = false;
  recordRollbackInspections = false;
  const rollbackPolicyRefusalMutations = [...mutations];

  const restart = require("./src/lib/actions/sandbox/mcp-bridge-restart.js");
  authorityMode = "external";
  const restoreRaces = [];
  for (let refusalAt = 1; refusalAt <= 6; refusalAt += 1) {
    const sandboxName = "restore-race-" + refusalAt;
    const restoreEntry = {
      ...afterAdd.bridge,
      providerName: sandboxName + "-mcp-example",
    };
    registry.registerSandbox({
      name: sandboxName,
      agent: "openclaw",
      gatewayName: "nemoclaw",
      policyAuthority: "externally-managed",
      mcp: { bridges: { example: restoreEntry } },
    });
    authorityCheck = 0;
    rejectAuthorityAt = 0;
    providerExists = true;
    mutations.length = 0;
    let containingCheck = 0;
    let message = "";
    try {
      await restart.restoreExistingMcpBridgeRuntime(sandboxName, [restoreEntry], {
        validateContainingPolicyReceipt: async () => {
          containingCheck += 1;
          if (containingCheck === refusalAt) {
            throw new Error("containing policy authority changed");
          }
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    restoreRaces.push({ message, mutations: [...mutations], refusalAt });
  }

  authorityMode = "refuse";
  mutations.length = 0;
  let removeMessage = "";
  try {
    await bridge.removeMcpBridge("alpha", "example");
  } catch (error) {
    removeMessage = error instanceof Error ? error.message : String(error);
  }
  const afterRemove = {
    bridgePresent: !!registry.getSandbox("alpha")?.mcp?.bridges?.example,
    customPolicies: registry.getCustomPolicies("alpha"),
    mutations: [...mutations],
  };

  const removeDriftEntry = {
    ...afterAdd.bridge,
    providerName: "remove-drift-mcp-example",
    providerId,
  };
  registry.registerSandbox({
    name: "remove-drift",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    policyAuthority: "nemoclaw-managed",
    mcp: { bridges: { example: removeDriftEntry } },
  });
  authorityMode = "managed";
  refusePolicyRemoval = true;
  adapterRegistered = true;
  providerExists = true;
  mutations.length = 0;
  let removeDriftMessage = "";
  try {
    await bridge.removeMcpBridge("remove-drift", "example");
  } catch (error) {
    removeDriftMessage = error instanceof Error ? error.message : String(error);
  }
  refusePolicyRemoval = false;
  const afterRemoveDrift = {
    bridgePresent: !!registry.getSandbox("remove-drift")?.mcp?.bridges?.example,
    mutations: [...mutations],
  };

  const removeResidualRefusalEntry = {
    ...afterAdd.bridge,
    providerName: "rm-resid-refusal-mcp-example",
    providerId,
  };
  registry.registerSandbox({
    name: "rm-resid-refusal",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    policyAuthority: "nemoclaw-managed",
    mcp: { bridges: { example: removeResidualRefusalEntry } },
  });
  refusePolicyRemoval = true;
  providerDrifted = true;
  adapterRegistered = true;
  providerExists = true;
  mutations.length = 0;
  let removeResidualRefusalMessage = "";
  let removeResidualRefusalName = "";
  try {
    await bridge.removeMcpBridge("rm-resid-refusal", "example", {
      force: true,
      allowResidual: true,
    });
  } catch (error) {
    removeResidualRefusalMessage = error instanceof Error ? error.message : String(error);
    removeResidualRefusalName = error?.name ?? "";
  }
  refusePolicyRemoval = false;
  providerDrifted = false;
  const afterRemoveResidualRefusal = {
    bridgePresent: !!registry.getSandbox("rm-resid-refusal")?.mcp?.bridges?.example,
    mutations: [...mutations],
  };

  registry.registerSandbox({
    name: "resume",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    policyAuthority: "externally-managed",
    mcp: {
      bridges: {
        example: {
          server: "example",
          agent: "openclaw",
          adapter: "mcporter",
          url: "https://mcp.example.test/mcp",
          env: ["MCP_TOKEN"],
          providerName: "resume-mcp-example-fixed",
          providerId,
          policyName: "mcp-bridge-example",
          addedAt: "2026-08-20T00:00:00.000Z",
          addState: "preflighted",
        },
      },
    },
  });
  authorityMode = "external";
  providerExists = true;
  providerRecoverable = false;
  delete process.env.MCP_TOKEN;
  mutations.length = 0;
  let resumeMessage = "";
  try {
    await bridge.addMcpBridge("resume", addOptions);
  } catch (error) {
    resumeMessage = error instanceof Error ? error.message : String(error);
  }
  const afterResumeFailure = {
    bridgePresent: !!registry.getSandbox("resume")?.mcp?.bridges?.example,
    customPolicies: registry.getCustomPolicies("resume"),
    mutations: [...mutations],
  };

  process.stdout.write(JSON.stringify({
    afterAdd,
    afterDriftAdd,
    afterDriftRestart,
    afterFinalDrift,
    afterMissing,
    afterRemove,
    afterRemoveDrift,
    afterRemoveResidualRefusal,
    afterResumeFailure,
    afterRestart,
    driftAddMessage,
    driftRestartMessage,
    finalDriftMessage,
    missingMessages,
    nextLifecycleMessage,
    preflights,
    removeMessage,
    removeDriftMessage,
    removeResidualRefusalMessage,
    removeResidualRefusalName,
    rollbackPolicyRefusal,
    rollbackPolicyRefusalMutations,
    rollbackRaces,
    restoreRaces,
    resumeMessage,
  }));
})().catch((error) => {
  process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
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
        const payload = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as {
          afterAdd: {
            bridge?: { addState?: string; providerName?: string };
            customPolicies: unknown[];
            mutations: string[];
          };
          afterDriftAdd: {
            bridge?: { addState?: string; providerName?: string };
            bridgePresent: boolean;
            mutations: string[];
          };
          afterDriftRestart: {
            bridgePresent: boolean;
            mutations: string[];
          };
          afterFinalDrift: {
            bridge?: { addState?: string };
            mutations: string[];
          };
          afterMissing: {
            bridge?: { addState?: string; providerName?: string };
            bridgePresent: boolean;
            customPolicies: unknown[];
            mutations: string[];
            policyAuthority?: string;
          };
          afterRemove: {
            bridgePresent: boolean;
            customPolicies: unknown[];
            mutations: string[];
          };
          afterRemoveDrift: {
            bridgePresent: boolean;
            mutations: string[];
          };
          afterRemoveResidualRefusal: {
            bridgePresent: boolean;
            mutations: string[];
          };
          afterResumeFailure: {
            bridgePresent: boolean;
            customPolicies: unknown[];
            mutations: string[];
          };
          afterRestart: {
            bridgePresent: boolean;
            customPolicies: unknown[];
            mutations: string[];
          };
          driftAddMessage: string;
          driftRestartMessage: string;
          finalDriftMessage: string;
          missingMessages: string[];
          nextLifecycleMessage: string;
          preflights: Array<{
            externalPolicy: string;
            hasBoundRequirement: boolean;
            operation: string;
            providerBinding: string | null;
            requirementCount: number;
          }>;
          removeMessage: string;
          removeDriftMessage: string;
          removeResidualRefusalMessage: string;
          removeResidualRefusalName: string;
          rollbackPolicyRefusal: {
            causeMessage: string | null;
            exitCode: number | null;
            message: string;
            nestedCauseMessage: string | null;
            reasonCode: string | null;
          } | null;
          rollbackPolicyRefusalMutations: string[];
          rollbackRaces: Array<{
            bridge?: { addState?: string };
            causeMessage: string | null;
            exitCode: number | null;
            message: string;
            mutations: string[];
            reasonCode: string | null;
            refusalOffset: number;
          }>;
          restoreRaces: Array<{
            message: string;
            mutations: string[];
            refusalAt: number;
          }>;
          resumeMessage: string;
        };

        expect(payload.missingMessages).toEqual([
          expect.stringContaining("missing entries"),
          expect.stringContaining("missing entries"),
        ]);
        expect(
          payload.preflights.slice(0, 2).map(({ providerBinding }) => providerBinding),
        ).toEqual([
          expect.stringMatching(/^alpha-mcp-example-[a-f0-9]{16}$/u),
          expect.stringMatching(/^alpha-mcp-example-[a-f0-9]{16}$/u),
        ]);
        expect(payload.preflights[0]?.providerBinding).toBe(payload.preflights[1]?.providerBinding);
        expect(payload.preflights[2]?.providerBinding).toMatch(/^alpha-mcp-example-[a-f0-9]{16}$/u);
        expect(payload.preflights[2]?.providerBinding).not.toBe(
          payload.preflights[0]?.providerBinding,
        );
        expect(payload.nextLifecycleMessage).toContain("missing entries");
        const stableProviderName = String(payload.preflights[0]?.providerBinding);
        expect(payload.missingMessages).toEqual([
          expect.stringContaining(`Required OpenShell provider name: '${stableProviderName}'.`),
          expect.stringContaining(`Required OpenShell provider name: '${stableProviderName}'.`),
        ]);
        expect(payload.afterMissing.bridgePresent).toBe(false);
        expect(payload.afterMissing.bridge).toBeUndefined();
        expect(payload.afterMissing.customPolicies).toEqual([]);
        expect(payload.afterMissing.mutations).not.toContain("registry:write");
        expect(payload.afterMissing.policyAuthority).toBe("externally-managed");
        expect(
          payload.afterMissing.mutations.some((event) =>
            /^(adapter|policy|provider):/u.test(event),
          ),
        ).toBe(false);
        expect(payload.driftAddMessage).toContain("authority changed");
        expect(payload.afterDriftAdd.bridgePresent).toBe(true);
        expect(payload.afterDriftAdd.bridge).toEqual(
          expect.objectContaining({ addState: "prepared", providerName: expect.any(String) }),
        );
        expect(
          payload.afterDriftAdd.mutations.some((event) =>
            /^(adapter|policy|provider):/u.test(event),
          ),
        ).toBe(false);

        expect(payload.afterAdd.bridge).toEqual(
          expect.not.objectContaining({ addState: "prepared" }),
        );
        expect(payload.afterAdd.customPolicies).toEqual([]);
        expect(payload.afterAdd.mutations).toEqual(
          expect.arrayContaining(["provider:created", "provider:attach", "adapter:register"]),
        );
        expect(payload.afterAdd.mutations.some((event) => event.startsWith("policy:"))).toBe(false);

        expect(payload.afterRestart.bridgePresent).toBe(true);
        expect(payload.afterRestart.customPolicies).toEqual([]);
        expect(payload.afterRestart.mutations).toEqual(
          expect.arrayContaining(["provider:updated", "provider:attach", "adapter:register"]),
        );
        expect(payload.afterRestart.mutations.some((event) => event.startsWith("policy:"))).toBe(
          false,
        );
        expect(payload.driftRestartMessage).toContain("authority changed");
        expect(payload.afterDriftRestart.bridgePresent).toBe(true);
        expect(
          payload.afterDriftRestart.mutations.some((event) =>
            /^(adapter|policy|provider):/u.test(event),
          ),
        ).toBe(false);

        expect(payload.finalDriftMessage).toContain("authority changed");
        expect(payload.afterFinalDrift.bridge).toEqual(
          expect.objectContaining({ addState: "preflighted" }),
        );
        expect(payload.afterFinalDrift.mutations).toContain("adapter:register");
        expect(payload.afterFinalDrift.mutations).toEqual(
          expect.arrayContaining(["adapter:remove", "provider:detach", "provider:delete"]),
        );

        const rollbackSequence = [
          "provider:inspect",
          "adapter:remove",
          "provider:detach",
          "provider:inspect",
          "provider:delete",
        ];
        expect(payload.rollbackRaces).toHaveLength(rollbackSequence.length);
        expect(payload.rollbackRaces.map(({ message }) => message)).toEqual(
          Array.from({ length: rollbackSequence.length }, () =>
            expect.stringContaining("adapter reload failed"),
          ),
        );
        expect(payload.rollbackRaces.map(({ bridge }) => bridge)).toEqual([
          expect.objectContaining({ addState: "preflighted" }),
          expect.objectContaining({ addState: "preflighted" }),
          expect.objectContaining({ addState: "preflighted" }),
          expect.objectContaining({ addState: "preflighted" }),
          expect.objectContaining({ addState: "preflighted" }),
        ]);
        expect(payload.rollbackRaces[0]).toEqual(
          expect.objectContaining({
            causeMessage: "adapter reload root",
            exitCode: 2,
            reasonCode: "unresolved",
          }),
        );
        expect(payload.rollbackPolicyRefusal).toEqual({
          causeMessage: "adapter reload failed",
          exitCode: 2,
          message: expect.stringContaining("authority changed during MCP removal"),
          nestedCauseMessage: "adapter reload root",
          reasonCode: "unresolved",
        });
        expect(payload.rollbackPolicyRefusalMutations).toContain("policy:apply");
        expect(payload.rollbackPolicyRefusalMutations).toContain("policy:remove");
        expect(
          payload.rollbackRaces.map(({ mutations }) => {
            const adapterRegistration = mutations.lastIndexOf("adapter:register");
            expect(adapterRegistration).toBeGreaterThanOrEqual(0);
            return mutations.slice(adapterRegistration + 1);
          }),
        ).toEqual(Array.from({ length: rollbackSequence.length }, () => rollbackSequence));

        expect(payload.restoreRaces).toHaveLength(6);
        expect(payload.restoreRaces.map(({ message }) => message)).toEqual([
          expect.stringContaining("containing policy authority changed"),
          expect.stringContaining("containing policy authority changed"),
          expect.stringContaining("containing policy authority changed"),
          expect.stringContaining("containing policy authority changed"),
          expect.stringContaining("containing policy authority changed"),
          expect.stringContaining("containing policy authority changed"),
        ]);
        expect(payload.restoreRaces.map(({ mutations }) => mutations.length)).toEqual([
          0, 1, 2, 3, 4, 5,
        ]);

        expect(payload.removeMessage).toBe("");
        expect(payload.afterRemove.bridgePresent).toBe(false);
        expect(payload.afterRemove.customPolicies).toEqual([]);
        expect(payload.afterRemove.mutations).toEqual(
          expect.arrayContaining(["adapter:remove", "provider:detach", "provider:delete"]),
        );
        expect(payload.afterRemove.mutations.some((event) => event.startsWith("policy:"))).toBe(
          false,
        );
        expect(payload.removeDriftMessage).toContain("authority changed during MCP removal");
        expect(payload.afterRemoveDrift.bridgePresent).toBe(true);
        expect(payload.afterRemoveDrift.mutations).toEqual(
          expect.arrayContaining([
            "adapter:remove",
            "policy:remove",
            "provider:detach",
            "provider:delete",
          ]),
        );
        expect(payload.removeResidualRefusalName).toBe("McpPolicyAuthorityRefusalError");
        expect(payload.removeResidualRefusalMessage).toContain(
          "authority changed during MCP removal",
        );
        expect(payload.afterRemoveResidualRefusal.bridgePresent).toBe(true);
        expect(payload.afterRemoveResidualRefusal.mutations).toContain("adapter:remove");
        expect(payload.afterRemoveResidualRefusal.mutations).toContain("policy:remove");
        expect(payload.afterRemoveResidualRefusal.mutations).not.toContain("provider:detach");
        expect(payload.afterRemoveResidualRefusal.mutations).not.toContain("provider:delete");
        expect(payload.resumeMessage).toContain("provider recovery failed");
        expect(payload.afterResumeFailure.bridgePresent).toBe(true);
        expect(payload.afterResumeFailure.customPolicies).toEqual([]);
        expect(
          payload.afterResumeFailure.mutations.some((event) => event.startsWith("policy:")),
        ).toBe(false);
        expect(
          payload.preflights.filter(({ operation }) => operation === "add MCP server 'example'")
            .length,
        ).toBeGreaterThanOrEqual(7);
        expect(payload.preflights).toContainEqual(
          expect.objectContaining({ providerBinding: "resume-mcp-example-fixed" }),
        );
        expect(
          payload.preflights.filter(({ operation }) => operation === "restart MCP server 'example'")
            .length,
        ).toBeGreaterThanOrEqual(5);
        expect(
          payload.preflights.filter(({ operation }) => operation === "remove MCP server 'example'"),
        ).toEqual([]);
        expect(payload.preflights).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ hasBoundRequirement: true, requirementCount: 1 }),
          ]),
        );
        expect(payload.preflights.every(({ hasBoundRequirement }) => hasBoundRequirement)).toBe(
          true,
        );
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
