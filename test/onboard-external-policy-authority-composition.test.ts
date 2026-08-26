// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { loadAgent } from "../src/lib/agent/defs";
import { prepareInitialSandboxCreatePolicy } from "../src/lib/onboard/initial-policy";
import { runFinalOnboardFlowSlice } from "../src/lib/onboard/machine/final-flow-phases";
import {
  createOnboardPolicyAuthorityBindings,
  requiredOnboardPolicyPresets,
} from "../src/lib/onboard/policy-authority/preflight";
import { prepareSandboxCreateLaunch } from "../src/lib/onboard/sandbox-create-launch";
import {
  materializeSandboxCreatePlan,
  resolveSandboxCreateIntent,
} from "../src/lib/onboard/sandbox-create-plan";
import { runSandboxCreateWithPolicyAuthorityChecks } from "../src/lib/onboard/sandbox-create/orchestration";
import type { SandboxEntry } from "../src/lib/state/registry";
import { createSession } from "../src/lib/state/onboard-session";
import { context, createPhases, createRuntimeHarness } from "./helpers/onboard-final-flow-phases";

const REPO_ROOT = path.join(import.meta.dirname, "..");

describe("external policy authority onboarding composition", () => {
  it("completes a fresh flow without policy mutation or attribution (#9833)", async () => {
    const sandboxName = "fresh-external";
    const gatewayName = "nemoclaw";
    const provider = "ollama-local";
    const model = "llama3.1";
    const policyTier = "balanced";
    const selectedMessagingChannels = ["slack"];
    const webSearchConfig = { provider: "tavily" as const, fetchEnabled: true };
    const agent = loadAgent("openclaw");
    const basePolicyPath = path.join(
      REPO_ROOT,
      "nemoclaw-blueprint",
      "policies",
      "openclaw-sandbox.yaml",
    );
    const additionalPresets = requiredOnboardPolicyPresets({
      additionalPresets: [],
      provider,
      webSearchConfig,
      agentName: agent.name,
      observabilityEnabled: false,
    });
    expect(additionalPresets).toEqual(["local-inference", "tavily"]);
    const prepareRequiredPolicy = () =>
      prepareInitialSandboxCreatePolicy(basePolicyPath, selectedMessagingChannels, {
        directGpu: false,
        additionalPresets,
        agentName: agent.name,
        policyTier,
      });
    const effectivePolicySource = prepareRequiredPolicy();
    const effectivePolicy = YAML.parse(
      fs.readFileSync(effectivePolicySource.policyPath, "utf8"),
    ) as {
      network_policies: Record<string, unknown>;
    };
    expect(effectivePolicySource.appliedPresets).toEqual(
      expect.arrayContaining(["slack", "local-inference", "tavily"]),
    );
    expect(effectivePolicySource.cleanup?.()).toBe(true);
    expect(Object.keys(effectivePolicy.network_policies)).toEqual(
      expect.arrayContaining(["slack", "local_inference", "tavily"]),
    );
    effectivePolicy.network_policies.operator_audit = {
      name: "operator_audit",
      endpoints: [{ host: "operator.example.test", port: 443, protocol: "rest" }],
    };

    const externalInspection = {
      authority: "externally-managed" as const,
      effectivePolicy,
      policyIdentity: { hash: "sha256:external", activeVersion: 1 },
    };
    const inspectActiveGlobalPolicy = vi.fn(() => ({
      state: "active" as const,
      inspection: externalInspection,
    }));
    const inspectSandboxPolicyAuthority = vi.fn(() => externalInspection);
    let liveExists = false;
    let existingEntry: SandboxEntry | null = null;
    let durableSession = createSession({ policyPresets: ["balanced"] });
    const updateSession = vi.fn((mutator: (session: typeof durableSession) => void) => {
      mutator(durableSession);
      return durableSession;
    });
    const getAgentPolicyPath = vi.fn(() => basePolicyPath);
    const bindings = createOnboardPolicyAuthorityBindings(
      {
        GATEWAY_NAME: gatewayName,
        ROOT: REPO_ROOT,
        agentDefs: { loadAgent },
        agentOnboard: { getAgentPolicyPath },
        inspectSandboxForCreate: () => ({ existingEntry, liveExists }),
        onboardSession: {
          loadSession: () => durableSession,
          updateSession,
        },
      },
      policyTier,
      { inspectActiveGlobalPolicy, inspectSandboxPolicyAuthority },
    );

    durableSession = await bindings.bindPolicyAuthority(gatewayName, durableSession);
    expect(durableSession.policyAuthority).toBe("externally-managed");
    expect(durableSession.policyPresets).toBeNull();

    const policyRequirements = {
      gatewayName,
      sandboxName,
      agent,
      selectedMessagingChannels,
      hermesToolGateways: [],
      gpuPassthrough: false,
      provider,
      webSearchConfig,
      observabilityEnabled: false,
      operation: `prepare sandbox '${sandboxName}'`,
    };
    bindings.preflightPolicyRequirements(policyRequirements);
    bindings.preflightPolicyRequirements({ ...policyRequirements, agent: null });
    expect(inspectActiveGlobalPolicy).toHaveBeenCalledTimes(3);
    expect(inspectSandboxPolicyAuthority).not.toHaveBeenCalled();
    expect(getAgentPolicyPath).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "openclaw" }),
    );

    const intent = resolveSandboxCreateIntent({
      basePolicyPath,
      sandboxName,
      inferenceProvider: provider,
      channels: [
        {
          name: "slack",
          envKey: "SLACK_BOT_TOKEN",
          appTokenEnvKey: "SLACK_APP_TOKEN",
          label: "Slack",
          description: "Slack",
          help: "Slack",
        },
      ],
      enabledChannels: selectedMessagingChannels,
      disabledChannelNames: new Set(),
      messagingProviderRequests: [],
      primaryMessagingCredentialEnvKeys: [],
      reusableMessagingChannels: [],
      reusableMessagingProviders: [],
      hermesToolGateways: [],
      sandboxGpuConfig: { sandboxGpuEnabled: false },
      gpuCreateArgs: [],
      gpuRoutePlan: "none",
      sandboxGpuLogMessage: null,
      agentName: agent.name,
      policyTier,
    });
    const discloseInitialSandboxPolicy = vi.fn();
    const plan = materializeSandboxCreatePlan({
      intent,
      fromRef: "example.invalid/openclaw@sha256:abc",
      policyAuthority: "externally-managed",
      messagingTokenDefs: [],
      runProviderPreDeleteCleanup: vi.fn(),
      upsertMessagingProviders: vi.fn(() => []),
      getHermesToolGatewayProviderName: vi.fn(),
      discloseInitialSandboxPolicy,
    });
    const launch = prepareSandboxCreateLaunch({
      agent,
      chatUiUrl: "",
      createArgs: plan.createArgs,
      extraPlaceholderKeys: [],
      getDashboardForwardPort: () => "",
      hermesDashboardState: { config: null, enabled: false },
      manageDashboard: false,
      openshellShellCommand: (args) => args.join(" "),
      buildEnv: () => ({ OPENSHELL_SANDBOX_POLICY: "/tmp/inherited-policy.yaml" }),
    });

    await expect(
      runSandboxCreateWithPolicyAuthorityChecks({
        sandboxName,
        revalidate: (_sandboxIsLive, operation) =>
          bindings.preflightPolicyRequirements({ ...policyRequirements, operation }),
        create: async (verifyCreatedSandbox) => {
          liveExists = true;
          existingEntry = {
            name: sandboxName,
            policyAuthority: "externally-managed",
            policyTier,
            policies: [],
          } as SandboxEntry;
          await verifyCreatedSandbox(launch);
          return launch;
        },
        captureCreatedSandboxIdentity: () => "a".repeat(64),
        revalidateCreatedSandboxIdentity: vi.fn(),
        verifyCreatedPolicy: () => "verified",
        persistVerifiedPolicy: vi.fn(),
        revalidateVerifiedPolicy: vi.fn(),
        cleanupTemporarySources: vi.fn(),
      }),
    ).resolves.toBe(launch);

    expect(plan.createArgs).not.toContain("--policy");
    expect(plan.createArgs).not.toContain(plan.initialSandboxPolicy.policyPath);
    expect(launch.sandboxEnv).not.toHaveProperty("OPENSHELL_SANDBOX_POLICY");
    expect(discloseInitialSandboxPolicy).not.toHaveBeenCalled();

    Object.assign(durableSession, {
      sandboxName,
      provider,
      model,
      observabilityEnabled: false,
      machine: {
        version: 1,
        state: "openclaw",
        stateEnteredAt: "2026-08-24T00:00:00.000Z",
        revision: 0,
      },
    });
    const runtime = createRuntimeHarness(durableSession);
    const setupPoliciesWithSelection = vi.fn(async () => ["balanced"]);
    const persistAppliedPolicyPresets = vi.fn();
    const policyUpdateSession = vi.fn(() => durableSession);
    const reportDeploymentReadiness = vi.fn();
    const revalidationOperations: string[] = [];
    const recordStepComplete = vi.fn(async (_stepName: string, updates = {}) => {
      Object.assign(durableSession, updates);
      return durableSession;
    });
    const phases = createPhases("openclaw", [], {
      loadSession: () => durableSession,
      updateSession: policyUpdateSession,
      recordStepComplete,
      getActiveSandbox: () => existingEntry,
      setupPoliciesWithSelection,
      persistAppliedPolicyPresets,
      reportDeploymentReadiness,
      revalidatePolicyRequirements: (flowContext, operation) => {
        revalidationOperations.push(operation);
        bindings.revalidatePolicyRequirements(
          { ...flowContext, agent: null, session: durableSession },
          operation,
        );
      },
    });

    const finalResult = await runFinalOnboardFlowSlice({
      context: context({
        session: durableSession,
        sandboxName,
        provider,
        model,
        selectedMessagingChannels,
        hermesToolGateways: [],
        webSearchConfig,
      }),
      runtime: runtime.boundary.getRuntime(),
      phases,
      recordRepairEvent: vi.fn(async () => durableSession),
    });

    expect(runtime.getSession()).toMatchObject({
      status: "complete",
      policyAuthority: "externally-managed",
      policyPresets: null,
    });
    expect(setupPoliciesWithSelection).not.toHaveBeenCalled();
    expect(persistAppliedPolicyPresets).not.toHaveBeenCalled();
    expect(policyUpdateSession).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(inspectSandboxPolicyAuthority).toHaveBeenCalled();
    expect(revalidationOperations).toEqual(
      expect.arrayContaining([
        `configure OpenClaw in sandbox '${sandboxName}'`,
        `verify the externally managed policy for sandbox '${sandboxName}'`,
        `set sandbox '${sandboxName}' as the default`,
        `publish deployment status for sandbox '${sandboxName}'`,
        `complete onboarding for sandbox '${sandboxName}'`,
      ]),
    );
    expect(reportDeploymentReadiness).toHaveBeenCalledWith(true);
    expect(finalResult.session.status).toBe("complete");
    expect(plan.initialSandboxPolicy.cleanup?.() ?? true).toBe(true);
  });
});
