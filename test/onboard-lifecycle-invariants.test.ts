// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Characterization baseline for the onboarding create-path lifecycle (#6225,
// epic #6224). Pins CURRENT main behavior at the injectable decision seams:
// the sandbox messaging preflight (hosting the #5954-shared conflict guard),
// the sandbox create plan (whose materialization performs the gateway
// messaging upsert), and the resume identity predicate behind #2753. A
// regression baseline, not an endorsement: later children (#6226/#6227/#6228)
// are expected to change some pins deliberately.
//
// The cross-module ordering of the non-hermetic `createSandbox` orchestration
// in src/lib/onboard.ts has no behavioral seam today; it is documented in
// src/lib/onboard/lifecycle-contracts.md, with executable coverage deferred
// to the issue that introduces the seam.

import { describe, expect, it, vi } from "vitest";

import type { SandboxMessagingPlan } from "../src/lib/messaging/manifest/types.js";
import type { MessagingConflictGuardDeps } from "../src/lib/onboard/messaging-conflict-guard.js";
import type {
  CreateSandboxMessagingPrepResult,
  MessagingTokenDef,
} from "../src/lib/onboard/messaging-prep.js";
import {
  getResumeConfigConflicts,
  getResumeSandboxConflict,
} from "../src/lib/onboard/resume-config.js";
import {
  materializeSandboxCreatePlan,
  prepareSandboxCreatePlan,
  resolveSandboxCreateIntent,
  resolveSandboxCreateMessagingProviderRequests,
} from "../src/lib/onboard/sandbox-create-plan.js";
import type { SandboxGpuCreateConfig } from "../src/lib/onboard/sandbox-gpu-create.js";
import {
  prepareSandboxMessagingPreflight,
  type SandboxMessagingPreflightDeps,
  type SandboxMessagingPreflightInput,
} from "../src/lib/onboard/sandbox-messaging-preflight.js";

// ── Shared fixtures ─────────────────────────────────────────────────────────

const telegramChannel = {
  name: "telegram",
  envKey: "TELEGRAM_BOT_TOKEN",
  label: "Telegram",
  description: "Telegram",
  help: "Telegram",
};

const telegramTokenDef: MessagingTokenDef = {
  name: "sandbox-telegram-bridge",
  envKey: "TELEGRAM_BOT_TOKEN",
  token: "telegram-token",
};

const sandboxGpuConfig: SandboxGpuCreateConfig = {
  sandboxGpuEnabled: true,
  sandboxGpuDevice: "nvidia.com/gpu=0",
};

class OnboardAbortError extends Error {
  constructor(readonly code: number) {
    super(`onboard aborted with exit code ${code}`);
  }
}

// ── 1. Messaging conflict guard wiring inside the sandbox messaging preflight ──
//
// The preflight is the injectable module the create path runs before any
// destructive effect. It hosts the shared messaging conflict guard (#5954)
// with the onboard-specific interactive wiring: a "Continue anyway?" prompt is
// allowed here, unlike the rebuild preflight's forced non-interactive abort.

function buildMessagingPrepResult(
  overrides: Partial<CreateSandboxMessagingPrepResult> = {},
): CreateSandboxMessagingPrepResult {
  return {
    disabledChannelNames: new Set<string>(),
    messagingTokenDefs: [],
    extraPlaceholderKeys: [],
    hasMessagingTokens: false,
    reusableMessagingProviders: [],
    reusableMessagingChannels: [],
    missingWebSearchCredentialEnv: null,
    ...overrides,
  };
}

function buildPreflightHarness({
  planSandboxName = "sandbox-a",
  prepResult = buildMessagingPrepResult(),
}: {
  planSandboxName?: string;
  prepResult?: CreateSandboxMessagingPrepResult;
} = {}) {
  const events: string[] = [];
  const exits: number[] = [];
  const errorLines: string[] = [];
  const guardDepsSeen: MessagingConflictGuardDeps[] = [];
  const envPlan = {
    schemaVersion: 1,
    sandboxName: planSandboxName,
    disabledChannels: [],
  } as unknown as SandboxMessagingPlan;
  const promptYesNoOrDefault = vi.fn(async () => true);
  const deps: SandboxMessagingPreflightDeps = {
    readMessagingPlanFromEnv: vi.fn(() => envPlan),
    resolveDisabledChannels: vi.fn(() => {
      events.push("resolve-disabled-channels");
      return ["slack"];
    }),
    gatewayName: "nemoclaw",
    registry: {} as SandboxMessagingPreflightDeps["registry"],
    providerExistsInGateway: vi.fn(() => true),
    isNonInteractive: () => false,
    promptYesNoOrDefault,
    cliName: () => "nemoclaw",
    log: vi.fn(),
    error: vi.fn((message: string) => {
      errorLines.push(message);
    }),
    exitProcess: (code: number): never => {
      exits.push(code);
      throw new OnboardAbortError(code);
    },
    getValidatedMessagingTokenByEnvKey: vi.fn(() => null),
    getCredential: vi.fn(() => null),
    normalizeCredentialValue: (value: unknown) => String(value ?? ""),
    registerExtraPlaceholderProviders: vi.fn(() => []),
    getMessagingChannelForEnvKey: vi.fn(() => null),
    prepareCreateSandboxMessaging: vi.fn(() => {
      events.push("prepare-messaging");
      return prepResult;
    }),
    enforceMessagingChannelConflicts: vi.fn(async (guardDeps: MessagingConflictGuardDeps) => {
      events.push("conflict-guard");
      guardDepsSeen.push(guardDeps);
    }),
  };
  const input: SandboxMessagingPreflightInput = {
    sandboxName: "sandbox-a",
    agentName: "openclaw",
    channels: [telegramChannel],
    enabledChannels: ["telegram"],
    webSearchConfig: null,
    env: {},
  };
  return { deps, input, events, exits, errorLines, guardDepsSeen, promptYesNoOrDefault, envPlan };
}

describe("messaging conflict guard wiring in prepareSandboxMessagingPreflight (#6225)", () => {
  it("runs the conflict guard against the matching env plan before preparing messaging state (#6225)", async () => {
    const harness = buildPreflightHarness();

    const result = await prepareSandboxMessagingPreflight(harness.input, harness.deps);

    expect(harness.events).toEqual([
      "resolve-disabled-channels",
      "conflict-guard",
      "prepare-messaging",
    ]);
    expect(harness.guardDepsSeen[0]?.sandboxName).toBe("sandbox-a");
    expect(harness.guardDepsSeen[0]?.gatewayName).toBe("nemoclaw");
    expect(harness.guardDepsSeen[0]?.currentPlan).toBe(harness.envPlan);
    expect(harness.guardDepsSeen[0]?.currentSandboxDisabledChannels).toEqual(["slack"]);
    expect(result.disabledChannels).toEqual(["slack"]);
  });

  it("skips the conflict guard when the env plan belongs to a different sandbox (#6225)", async () => {
    const harness = buildPreflightHarness({ planSandboxName: "other-sandbox" });

    await prepareSandboxMessagingPreflight(harness.input, harness.deps);

    expect(harness.events).toEqual(["resolve-disabled-channels", "prepare-messaging"]);
    expect(harness.guardDepsSeen).toEqual([]);
  });

  // Onboard-vs-rebuild divergence pinned for #6225: this path hands the guard
  // an interactive continue prompt; the rebuild preflight (#5954) forces a
  // non-interactive abort instead.
  it("wires an interactive continue prompt and the onboard exit into the conflict guard (#6225)", async () => {
    const harness = buildPreflightHarness();

    await prepareSandboxMessagingPreflight(harness.input, harness.deps);
    const guardDeps = harness.guardDepsSeen[0] as MessagingConflictGuardDeps;
    const continueAnswer = await guardDeps.promptContinue();

    expect(continueAnswer).toBe(true);
    expect(harness.promptYesNoOrDefault).toHaveBeenCalledWith("  Continue anyway?", null, false);
    expect(guardDeps.exit).toBe(harness.deps.exitProcess);
  });

  it("aborts with exit code 1 when the web search credential is missing from the process (#6225)", async () => {
    const harness = buildPreflightHarness({
      prepResult: buildMessagingPrepResult({ missingWebSearchCredentialEnv: "BRAVE_API_KEY" }),
    });

    await expect(prepareSandboxMessagingPreflight(harness.input, harness.deps)).rejects.toThrow(
      OnboardAbortError,
    );

    expect(harness.exits).toEqual([1]);
    expect(harness.errorLines[0]).toContain("BRAVE_API_KEY is not available in this process");
    expect(harness.errorLines[1]).toContain("disable web search before recreating the sandbox");
  });
});

// ── 2. Gateway messaging upsert ordering inside the create plan ────────────
//
// On the create path this module runs AFTER the destructive delete (see
// src/lib/onboard/lifecycle-contracts.md). Inside the plan itself,
// deterministic intent resolution and credential-binding validation complete
// before any gateway effect, and the tolerant cleanup re-run precedes the
// credential upsert.

describe("gateway messaging upsert ordering in the sandbox create plan (#6225)", () => {
  it("re-runs provider cleanup before upserting messaging credentials with replaceExisting (#6225)", () => {
    const events: string[] = [];
    const upsertMessagingProviders = vi.fn(
      (_tokenDefs: MessagingTokenDef[], _options: { replaceExisting: true }) => {
        events.push("gateway-upsert");
        return ["sandbox-telegram-bridge"];
      },
    );

    const result = prepareSandboxCreatePlan({
      basePolicyPath: "/repo/policy.yaml",
      buildCtx: "/tmp/nemoclaw-build-1",
      sandboxName: "sandbox",
      channels: [telegramChannel],
      enabledChannels: ["telegram"],
      disabledChannelNames: new Set(),
      messagingTokenDefs: [telegramTokenDef],
      reusableMessagingChannels: [],
      reusableMessagingProviders: [],
      hermesToolGateways: [],
      sandboxGpuConfig,
      dockerDriverGateway: true,
      appendResourceFlags: (args) => {
        events.push("resource-flags");
        args.push("--memory", "16g");
      },
      runProviderPreDeleteCleanup: () => {
        events.push("pre-delete-cleanup-re-run");
      },
      upsertMessagingProviders,
      getMessagingChannelForEnvKey: (envKey) =>
        envKey === "TELEGRAM_BOT_TOKEN" ? "telegram" : null,
      getHermesToolGatewayProviderName: vi.fn(),
      policyTier: null,
      deps: {
        resolveDockerGpuSandboxCreatePlan: vi.fn(() => ({
          useDockerGpuPatch: false,
          logMessage: null,
        })),
        prepareInitialSandboxCreatePolicy: vi.fn(() => ({
          policyPath: "/tmp/policy.yaml",
          appliedPresets: [],
        })),
        buildSandboxGpuCreateArgs: vi.fn(() => []),
      },
    });

    expect(events).toEqual(["resource-flags", "pre-delete-cleanup-re-run", "gateway-upsert"]);
    expect(upsertMessagingProviders).toHaveBeenCalledWith([telegramTokenDef], {
      replaceExisting: true,
    });
    expect(result.messagingProviders).toEqual(["sandbox-telegram-bridge"]);
  });

  // Pinned gap for #6225: this validation is deterministic and fail-closed,
  // but on the recreate path it only runs after the old sandbox was deleted —
  // a binding drift halts gateway writes yet cannot restore the sandbox.
  it("rejects a drifted credential binding before any gateway effect runs (#6225)", () => {
    const intent = resolveSandboxCreateIntent({
      basePolicyPath: "/repo/policy.yaml",
      sandboxName: "sandbox",
      channels: [telegramChannel],
      enabledChannels: ["telegram"],
      disabledChannelNames: new Set(),
      messagingProviderRequests: resolveSandboxCreateMessagingProviderRequests(
        [telegramTokenDef],
        () => "telegram",
      ),
      primaryMessagingCredentialEnvKeys: ["TELEGRAM_BOT_TOKEN"],
      reusableMessagingChannels: [],
      reusableMessagingProviders: [],
      hermesToolGateways: [],
      sandboxGpuConfig,
      gpuCreateArgs: [],
      useDockerGpuPatch: false,
      sandboxGpuLogMessage: null,
      policyTier: null,
    });
    const preparePolicy = vi.fn(() => ({ policyPath: "/tmp/policy.yaml", appliedPresets: [] }));
    const appendResourceFlags = vi.fn();
    const runProviderPreDeleteCleanup = vi.fn();
    const upsertMessagingProviders = vi.fn(() => []);

    expect(() =>
      materializeSandboxCreatePlan({
        intent,
        buildCtx: "/tmp/nemoclaw-build-1",
        messagingTokenDefs: [{ ...telegramTokenDef, token: null }],
        prepareInitialSandboxCreatePolicy: preparePolicy,
        appendResourceFlags,
        runProviderPreDeleteCleanup,
        upsertMessagingProviders,
        getHermesToolGatewayProviderName: vi.fn(),
      }),
    ).toThrow("credential availability changed for provider 'sandbox-telegram-bridge'");
    expect(preparePolicy).not.toHaveBeenCalled();
    expect(appendResourceFlags).not.toHaveBeenCalled();
    expect(runProviderPreDeleteCleanup).not.toHaveBeenCalled();
    expect(upsertMessagingProviders).not.toHaveBeenCalled();
  });
});

// ── 3. Resume identity: recorded sandbox name and the sandbox step gate ────
//
// The deciding functions behind the #2753 contract: the recorded sandbox name
// is trusted (as resume identity and as a conflict source) only when the
// session's sandbox step actually completed. onboard() applies the same
// predicate when it seeds `recordedSandboxName` for the flow context, and the
// resume decision collapses to a plain create when the step is incomplete
// (see sandbox-resume.test.ts for the decision-side coverage).

describe("resume identity honors the recorded sandbox name only after the sandbox step completed (#2753)", () => {
  it.each([
    "pending",
    "in_progress",
    "failed",
    "skipped",
  ])("ignores the recorded sandbox name while the sandbox step is %s (#2753)", (status) => {
    const conflict = getResumeSandboxConflict(
      { sandboxName: "recorded-sandbox", steps: { sandbox: { status } } },
      { sandboxName: "requested-sandbox" },
    );

    expect(conflict).toBeNull();
  });

  it("reports a conflict between requested and recorded names once the sandbox step is complete (#2753)", () => {
    const conflict = getResumeSandboxConflict(
      { sandboxName: "recorded-sandbox", steps: { sandbox: { status: "complete" } } },
      { sandboxName: "requested-sandbox" },
    );

    expect(conflict).toEqual({
      requestedSandboxName: "requested-sandbox",
      recordedSandboxName: "recorded-sandbox",
    });
  });

  it("normalizes the requested name before comparing it to the recorded name (#2753)", () => {
    const conflict = getResumeSandboxConflict(
      { sandboxName: "recorded-sandbox", steps: { sandbox: { status: "complete" } } },
      { sandboxName: "  Recorded-Sandbox  " },
    );

    expect(conflict).toBeNull();
  });

  it("reports no conflict without a requested override name even for a completed step (#2753)", () => {
    const conflict = getResumeSandboxConflict(
      { sandboxName: "recorded-sandbox", steps: { sandbox: { status: "complete" } } },
      {},
    );

    expect(conflict).toBeNull();
  });

  it("omits the sandbox conflict for an incomplete session so a new name can recover a phantom (#2753)", () => {
    const conflicts = getResumeConfigConflicts(
      { sandboxName: "phantom-sandbox", steps: { sandbox: { status: "in_progress" } } },
      { sandboxName: "fresh-name" },
    );

    expect(conflicts).toEqual([]);
  });

  it("keeps the sandbox conflict for a completed session in the full conflict list (#2753)", () => {
    const conflicts = getResumeConfigConflicts(
      { sandboxName: "recorded-sandbox", steps: { sandbox: { status: "complete" } } },
      { sandboxName: "fresh-name" },
    );

    expect(conflicts).toEqual([
      { field: "sandbox", requested: "fresh-name", recorded: "recorded-sandbox" },
    ]);
  });
});
