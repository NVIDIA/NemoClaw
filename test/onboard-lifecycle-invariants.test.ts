// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Characterization baseline for the onboarding create-path lifecycle (#6225,
// epic #6224). These tests pin CURRENT main behavior — including orderings the
// epic flags as contract gaps (e.g. gateway messaging credential upserts run
// AFTER the destructive sandbox delete, and credential-binding validation only
// happens at plan materialization time, which is also after the delete). They
// are a regression baseline, not an endorsement: later children (#6226/#6227/
// #6228) are expected to change some of these pins deliberately.
//
// The `createSandbox` orchestration in src/lib/onboard.ts cannot run
// hermetically (it shells out to OpenShell/Docker), so its cross-module
// ordering is pinned as a source-order characterization over the function
// body, while every decision that lives in an injectable module
// (sandbox-messaging-preflight, sandbox-create-plan, sandbox-resume,
// resume-config) is pinned with direct unit-level calls.

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxMessagingPlan } from "../src/lib/messaging/manifest/types.js";
import type { SandboxResumeDecision } from "../src/lib/onboard/machine/handlers/sandbox-resume.js";
import {
  applySandboxResumeDecision,
  decideSandboxResume,
  type SandboxResumeDeps,
  type SandboxResumeSignals,
} from "../src/lib/onboard/machine/handlers/sandbox-resume.js";
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

// ── 1. Source-order characterization of createSandbox ──────────────────────
//
// Pins which deterministic validations and checkpoints complete before the
// first destructive effect (the `openshell sandbox delete` of a pre-existing
// sandbox) and which effects run after it. The markers are call-site snippets
// inside `async function createSandbox(` in src/lib/onboard.ts, verified at
// HEAD: messaging preflight (which hosts the #5954-shared conflict guard),
// fail-closed pre-recreate backup, the delete boundary, the create plan whose
// materialization performs the gateway messaging upsert, the create stream,
// the readiness gate, and post-ready registration.

const repoRoot = path.join(import.meta.dirname, "..");
const onboardSource = fs.readFileSync(path.join(repoRoot, "src", "lib", "onboard.ts"), "utf8");
const createSandboxStart = onboardSource.indexOf("async function createSandbox(");
const createSandboxEnd = onboardSource.indexOf("\nasync function ", createSandboxStart + 1);
const createSandboxBody = onboardSource.slice(createSandboxStart, createSandboxEnd);

const DELETE_SNIPPET = 'runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });';

const CREATE_LIFECYCLE_MARKERS = [
  { label: "sandbox name validation", snippet: "const sandboxName = validateName(" },
  {
    label: "messaging preflight with the conflict guard",
    snippet: "sandboxMessagingPreflight.prepareSandboxMessagingPreflight(",
  },
  {
    label: "pre-upgrade backup selection",
    snippet: "notReadyRecreate.selectPreUpgradeBackupForCreate(",
  },
  {
    label: "fail-closed pre-recreate workspace backup",
    snippet: "backupSandboxBeforeRecreate({ sandboxName });",
  },
  {
    label: "provider pre-delete cleanup",
    snippet: "runSandboxProviderPreDeleteCleanup(sandboxName, { runOpenshell, redact });",
  },
  { label: "destructive sandbox delete", snippet: DELETE_SNIPPET },
  { label: "previous image removal", snippet: "dockerRmi(previousEntry.imageTag" },
  { label: "registry entry removal", snippet: "registry.removeSandbox(sandboxName);" },
  {
    label: "create plan preparation with the gateway messaging upsert",
    snippet: "sandboxCreatePlan.prepareSandboxCreatePlan({",
  },
  { label: "sandbox create stream", snippet: "await streamSandboxCreate(" },
  { label: "readiness gate", snippet: "waitForCreatedSandboxReadyWithTrace({" },
  {
    label: "post-ready registry registration",
    snippet: "sandboxRegistration.registerCreatedSandbox({",
  },
] as const;

const markerIndex = (snippet: string): number => createSandboxBody.indexOf(snippet);

const consecutiveMarkerPairs = CREATE_LIFECYCLE_MARKERS.slice(1).map((later, index) => ({
  earlierLabel: CREATE_LIFECYCLE_MARKERS[index].label,
  earlierSnippet: CREATE_LIFECYCLE_MARKERS[index].snippet,
  laterLabel: later.label,
  laterSnippet: later.snippet,
}));

describe("createSandbox source ordering on the onboard create path (#6225)", () => {
  it("bounds the createSandbox body for source scanning (#6225)", () => {
    expect(createSandboxStart).toBeGreaterThanOrEqual(0);
    expect(createSandboxEnd).toBeGreaterThan(createSandboxStart);
  });

  it.each([
    ...CREATE_LIFECYCLE_MARKERS,
  ])("locates the $label call site inside createSandbox (#6225)", ({ snippet }) => {
    expect(markerIndex(snippet)).toBeGreaterThanOrEqual(0);
  });

  it.each(consecutiveMarkerPairs)("keeps the $earlierLabel ahead of the $laterLabel (#6225)", ({
    earlierSnippet,
    laterSnippet,
  }) => {
    expect(markerIndex(earlierSnippet)).toBeLessThan(markerIndex(laterSnippet));
  });

  it("returns from the reuse fast paths before reaching the destructive sandbox delete (#6225)", () => {
    const firstReuseReturn = createSandboxBody.indexOf("return sandboxName;");
    expect(firstReuseReturn).toBeGreaterThanOrEqual(0);
    expect(firstReuseReturn).toBeLessThan(markerIndex(DELETE_SNIPPET));
  });

  it("issues exactly two sandbox delete commands with the failed-create cleanup after the create stream (#6225)", () => {
    expect(createSandboxBody.split(DELETE_SNIPPET).length - 1).toBe(2);
    const streamIndex = markerIndex("await streamSandboxCreate(");
    expect(createSandboxBody.indexOf(DELETE_SNIPPET, streamIndex)).toBeGreaterThan(streamIndex);
  });

  // Divergence pinned for #6225: the create plan's provider cleanup re-run is
  // the tolerant variant (the sandbox is already gone) and the gateway
  // messaging credential upsert is wired into the plan, i.e. it executes only
  // after the destructive delete and before the create stream.
  it("wires the tolerant cleanup re-run and the gateway messaging upsert into the post-delete create plan (#6225)", () => {
    const planRegion = createSandboxBody.slice(
      markerIndex("sandboxCreatePlan.prepareSandboxCreatePlan({"),
      markerIndex("await streamSandboxCreate("),
    );
    expect(planRegion).toContain("tolerateMissingSandbox: true");
    expect(planRegion).toContain("upsertMessagingProviders,");
  });
});

// ── 2. Messaging conflict guard wiring inside the sandbox messaging preflight ──
//
// The preflight is the injectable module the create path runs before any
// destructive effect (see the source-order pins above). It hosts the shared
// messaging conflict guard (#5954) with the onboard-specific interactive
// wiring: a "Continue anyway?" prompt is allowed here, unlike the rebuild
// preflight's forced non-interactive abort.

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

// ── 3. Gateway messaging upsert ordering inside the create plan ────────────
//
// On the create path this module runs AFTER the destructive delete (pinned in
// section 1). Inside the plan itself, deterministic intent resolution and
// credential-binding validation complete before any gateway effect, and the
// tolerant cleanup re-run precedes the credential upsert.

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

// ── 4. Resume identity: recorded sandbox name and the sandbox step gate ────
//
// The deciding functions behind the #2753 contract: the recorded sandbox name
// is trusted (as resume identity and as a conflict source) only when the
// session's sandbox step actually completed. onboard() applies the same
// predicate when it seeds `recordedSandboxName` for the flow context, and
// `decideSandboxResume` collapses to a plain create when the step is
// incomplete.

describe("resume identity honors the recorded sandbox name only after the sandbox step completed (#2753)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { status: "pending" },
    { status: "in_progress" },
    { status: "failed" },
    { status: "skipped" },
  ])("ignores the recorded sandbox name while the sandbox step is $status (#2753)", ({
    status,
  }) => {
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

  it("ignores provider and model env hints during interactive resume conflict checks (#6225)", () => {
    vi.stubEnv("NEMOCLAW_PROVIDER", "cloud");
    vi.stubEnv("NEMOCLAW_MODEL", "meta/llama-3.3-70b-instruct");

    const conflicts = getResumeConfigConflicts(
      { provider: "nvidia-nim", model: "recorded-model" },
      {},
    );

    expect(conflicts).toEqual([]);
  });

  it("resolves Dockerfile paths before comparing resume intent with the recorded session (#6225)", () => {
    const recordedOnly = getResumeConfigConflicts(
      { metadata: { fromDockerfile: "fixtures/Dockerfile.recorded" } },
      {},
    );
    const equivalentSpelling = getResumeConfigConflicts(
      { metadata: { fromDockerfile: "./fixtures/Dockerfile.recorded" } },
      { fromDockerfile: "fixtures/Dockerfile.recorded" },
    );

    expect(recordedOnly).toEqual([
      {
        field: "fromDockerfile",
        requested: null,
        recorded: path.resolve("fixtures/Dockerfile.recorded"),
      },
    ]);
    expect(equivalentSpelling).toEqual([]);
  });
});

// ── 5. decideSandboxResume: the pure reuse/recreate policy ─────────────────

const READY_RESUME_SIGNALS: SandboxResumeSignals = {
  resume: true,
  resumeAgentChanged: false,
  sandboxStepComplete: true,
  sandboxReuseState: "ready",
  webSearchConfigChanged: false,
  sandboxGpuConfigChanged: false,
  messagingChannelConfigChanged: false,
  hermesToolGatewayConfigChanged: false,
};

const resumeSignals = (overrides: Partial<SandboxResumeSignals> = {}): SandboxResumeSignals => ({
  ...READY_RESUME_SIGNALS,
  ...overrides,
});

describe("decideSandboxResume pins the sandbox reuse contract (#6225)", () => {
  it("decides create when the sandbox step never completed even with a ready recorded sandbox (#2753)", () => {
    expect(decideSandboxResume(resumeSignals({ sandboxStepComplete: false }))).toEqual({
      kind: "create",
    });
    expect(
      decideSandboxResume(
        resumeSignals({
          sandboxStepComplete: false,
          resumeAgentChanged: true,
          webSearchConfigChanged: true,
          sandboxReuseState: "not_ready",
        }),
      ),
    ).toEqual({ kind: "create" });
  });

  it("decides create when the run is not a resume (#6225)", () => {
    expect(decideSandboxResume(resumeSignals({ resume: false }))).toEqual({ kind: "create" });
  });

  it("decides reuse only for a ready driftless resume with a completed sandbox step (#6225)", () => {
    expect(decideSandboxResume(resumeSignals())).toEqual({ kind: "reuse" });
  });

  it.each([
    {
      flag: "resumeAgentChanged",
      note: "  [resume] Agent selection changed; revalidating sandbox compatibility.",
      removeRegistryEntry: false,
    },
    {
      flag: "webSearchConfigChanged",
      note: "  [resume] Web Search configuration changed; recreating sandbox.",
      removeRegistryEntry: true,
    },
    {
      flag: "sandboxGpuConfigChanged",
      note: "  [resume] Sandbox GPU settings changed; recreating sandbox.",
      removeRegistryEntry: true,
    },
    {
      flag: "messagingChannelConfigChanged",
      note: "  [resume] Messaging channel configuration changed; recreating sandbox.",
      removeRegistryEntry: true,
    },
    {
      flag: "hermesToolGatewayConfigChanged",
      note: "  [resume] Hermes managed tool gateway selection changed; recreating sandbox.",
      removeRegistryEntry: true,
    },
  ])("recreates on $flag drift and pins its note and registry removal policy (#6225)", ({
    flag,
    note,
    removeRegistryEntry,
  }) => {
    const decision = decideSandboxResume({
      ...READY_RESUME_SIGNALS,
      [flag]: true,
    } as SandboxResumeSignals);

    expect(decision).toEqual({ kind: "recreate", note, removeRegistryEntry });
  });

  it("prefers the agent drift decision when every drift flag is set (#6225)", () => {
    const decision = decideSandboxResume(
      resumeSignals({
        resumeAgentChanged: true,
        webSearchConfigChanged: true,
        sandboxGpuConfigChanged: true,
        messagingChannelConfigChanged: true,
        hermesToolGatewayConfigChanged: true,
      }),
    );

    expect(decision).toEqual({
      kind: "recreate",
      note: "  [resume] Agent selection changed; revalidating sandbox compatibility.",
      removeRegistryEntry: false,
    });
  });

  it("repairs and recreates a recorded sandbox that is not ready (#6225)", () => {
    expect(decideSandboxResume(resumeSignals({ sandboxReuseState: "not_ready" }))).toEqual({
      kind: "repair-and-recreate",
    });
  });

  it("recreates with registry removal when the recorded sandbox state is unavailable (#6225)", () => {
    expect(decideSandboxResume(resumeSignals({ sandboxReuseState: "unknown" }))).toEqual({
      kind: "recreate",
      note: "  [resume] Recorded sandbox state is unavailable; recreating it.",
      removeRegistryEntry: true,
    });
  });
});

// ── 6. applySandboxResumeDecision: the side-effect contract ────────────────

function buildResumeDecisionHarness({ repairError = null }: { repairError?: Error | null } = {}) {
  const events: string[] = [];
  const deps: SandboxResumeDeps = {
    note: vi.fn((message: string) => {
      events.push(`note:${message.trim()}`);
    }),
    removeSandboxFromRegistry: vi.fn((sandboxName: string) => {
      events.push(`remove-registry:${sandboxName}`);
    }),
    repairRecordedSandbox: vi.fn((sandboxName: string | null) => {
      events.push(`repair:${sandboxName}`);
      const failure = [repairError].filter((error): error is Error => error !== null);
      failure.forEach((error) => {
        throw error;
      });
    }),
    recordRepairEvent: vi.fn(async (type: string) => {
      events.push(type);
      return null;
    }),
  };
  return { deps, events };
}

describe("applySandboxResumeDecision side effect contract (#6225)", () => {
  it("removes the registry entry only when the recreate decision says so (#6225)", async () => {
    const harness = buildResumeDecisionHarness();
    const decision: SandboxResumeDecision = {
      kind: "recreate",
      note: "  [resume] Web Search configuration changed; recreating sandbox.",
      removeRegistryEntry: true,
    };

    await applySandboxResumeDecision(decision, "sandbox-a", harness.deps);

    expect(harness.events).toEqual([
      "note:[resume] Web Search configuration changed; recreating sandbox.",
      "remove-registry:sandbox-a",
    ]);
  });

  it("keeps the registry entry for an agent change recreate (#6225)", async () => {
    const harness = buildResumeDecisionHarness();
    const decision: SandboxResumeDecision = {
      kind: "recreate",
      note: "  [resume] Agent selection changed; revalidating sandbox compatibility.",
      removeRegistryEntry: false,
    };

    await applySandboxResumeDecision(decision, "sandbox-a", harness.deps);

    expect(harness.deps.removeSandboxFromRegistry).not.toHaveBeenCalled();
    expect(harness.events).toEqual([
      "note:[resume] Agent selection changed; revalidating sandbox compatibility.",
    ]);
  });

  it.each([
    { kind: "create" as const },
    { kind: "reuse" as const },
  ])("performs no side effects for a $kind decision (#6225)", async ({ kind }) => {
    const harness = buildResumeDecisionHarness();

    await applySandboxResumeDecision({ kind }, "sandbox-a", harness.deps);

    expect(harness.events).toEqual([]);
  });

  it("emits repair started and completed events around the recorded sandbox cleanup (#6225)", async () => {
    const harness = buildResumeDecisionHarness();

    await applySandboxResumeDecision({ kind: "repair-and-recreate" }, "sandbox-a", harness.deps);

    expect(harness.events).toEqual([
      "note:[resume] Recorded sandbox 'sandbox-a' exists but is not ready; recreating it.",
      "state.repair.started",
      "repair:sandbox-a",
      "state.repair.completed",
    ]);
    expect(harness.deps.recordRepairEvent).toHaveBeenCalledWith("state.repair.started", {
      state: "sandbox",
      metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "sandbox-a" },
    });
  });

  it("emits a repair failed event and rethrows when the recorded sandbox cleanup throws (#6225)", async () => {
    const harness = buildResumeDecisionHarness({ repairError: new Error("cleanup exploded") });

    await expect(
      applySandboxResumeDecision({ kind: "repair-and-recreate" }, "sandbox-a", harness.deps),
    ).rejects.toThrow("cleanup exploded");

    expect(harness.events).toContain("state.repair.failed");
    expect(harness.events).not.toContain("state.repair.completed");
    expect(harness.deps.recordRepairEvent).toHaveBeenCalledWith("state.repair.failed", {
      state: "sandbox",
      error: "cleanup exploded",
      metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "sandbox-a" },
    });
  });
});
