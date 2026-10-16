// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import { redactString } from "../fixtures/redaction.ts";
import { driveInteractiveCommand, type InteractiveCommandRule } from "./onboard-interactive-pty.ts";
import { parsePolicyPresetState } from "./policy-list-state.ts";

// Regression coverage for #6042: "interactive onboard wizard skips Policy
// Presets TUI step". Three independent investigations could not reproduce a
// skip — the onboard state machine has no transition from any earlier state
// directly to `complete`, every path passes through `policies` — but no
// checked-in test drove the real interactive TUI through a PTY to prove it.
// This test is that proof: it answers every interactive prompt in the
// compatible-endpoint journey through a real pseudo-terminal (piped stdin
// does not reproduce the raw-mode selectors this wizard uses) and asserts
// the ordered step markers appear in order, ending with `[8/8] Policy
// presets`, before the wizard can report completion.
//
// This is a hermetic, mock-provider variant of the reporter's journey
// (`nemoclaw onboard` with "Other OpenAI-compatible endpoint"), so it needs
// no NVIDIA credential and runs in ordinary CI, not just a live-inference
// lane.

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-policy-order";
validateSandboxName(SANDBOX_NAME);
const POLICY_TIER_FLAG_SANDBOX_NAME = "e2e-policy-tier";
validateSandboxName(POLICY_TIER_FLAG_SANDBOX_NAME);
const ONBOARD_TIMEOUT_MS = 40 * 60_000;
// The #13180 journey runs second, on the gateway the first journey started,
// and finishes in about a minute. Bounding it at 15 minutes keeps both
// journeys (40 + 15) inside the trusted 60-minute target budget that
// pre-merge E2E dispatch uses.
const POLICY_TIER_FLAG_TIMEOUT_MS = 15 * 60_000;
const MODEL = "test-model";
// A Docker network namespace cannot reach host loopback directly; bind the
// fake endpoint on all interfaces and advertise the OpenShell host alias so
// both the host-side onboard validation and the sandbox's own inference
// route can reach it (matches the shared E2E inference adapter's mock mode).
const SANDBOX_HOST_ALIAS = "host.openshell.internal";

// The ordered, observable step headers the real interactive wizard prints.
// Each must appear strictly after the previous one; `[8/8] Policy presets`
// is the step the issue claims gets skipped.
const ORDERED_STEP_MARKERS = [
  "[1/8] Preflight checks",
  "[2/8] Starting OpenShell gateway",
  "[3/8] Configuring inference provider",
  "[4/8] Setting up inference provider",
  "[5/8] Messaging channels",
  "[6/8] Creating sandbox",
  "[7/8] Setting up OpenClaw inside sandbox",
  "[8/8] Policy presets",
] as const;

// The raw-mode tier selector's header. The bare "Policy tier" text also
// appears in the `--policy-tier` confirmation note, so a rule meant to prove
// the prompt is skipped must match the selector itself.
const POLICY_TIER_PROMPT_HEADER = "Policy tier — controls which network presets";

// Answers shared by every interactive compatible-endpoint journey in this file,
// up to (but not including) the policy tier selector.
function compatibleEndpointRules(baseUrl: string, apiKey: string): InteractiveCommandRule[] {
  return [
    // A reused host can already have accepted this first-run license
    // notice, so this rule might not fire.
    { trigger: "Type 'yes' to accept", response: "yes\n" },
    // Only appears when the preflight resource check warns; skipped on
    // an adequately provisioned CI runner.
    { trigger: "Continue with onboarding?", response: "y\n" },
    // "Other OpenAI-compatible endpoint" — position depends on
    // src/lib/onboard/providers.ts's provider list for the openclaw agent.
    { trigger: "Select your inference provider:", response: "4\n" },
    { trigger: "Other OpenAI-compatible endpoint", response: "" },
    { trigger: "OpenAI-compatible base URL", response: `${baseUrl}\n` },
    { trigger: "Other OpenAI-compatible endpoint API key:", response: `${apiKey}\n` },
    { trigger: "endpoint model", response: `${MODEL}\n` },
    { trigger: "Choose an action:", response: "1\n" },
    { trigger: "Enable web search", response: "1\n" },
    // Raw-mode messaging-channel selector; Enter with none toggled skips.
    { trigger: "Press 1-7 to toggle", response: "\r" },
    { trigger: "Resource profiles:", response: "6\n" },
  ];
}

test(
  "interactive onboard wizard reaches Policy presets in step order (#6042)",
  {
    timeout: ONBOARD_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "start the local compatible-endpoint fake server",
        "drive the interactive onboard wizard through a real PTY",
        "confirm every ordered onboarding step appears in order",
        "confirm Policy presets is reached before completion",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider }) => {
    await runtimeProvider.requireAvailable({
      artifactName: "prereq-runtime-provider-info",
      scenarioLabel: "onboard policy preset sequencing",
    });

    progress.phase("start the local compatible-endpoint fake server");
    const apiKey = `e2e-6042-${randomBytes(16).toString("hex")}`;
    const fake = await startFakeOpenAiCompatibleServer({
      apiKey,
      chatContent: "PONG",
      host: "0.0.0.0",
      model: MODEL,
      progress,
      publicHost: SANDBOX_HOST_ALIAS,
      requireAuth: true,
      responseText: "PONG",
    });
    artifacts.addRedactionValues([apiKey]);
    cleanup.trackDisposable("close fake compatible-endpoint server", () => fake.close());
    cleanup.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "cleanup-nemoclaw-destroy-onboard-policy-order",
      env: buildAvailabilityProbeEnv(),
      redactionValues: [apiKey],
      timeoutMs: 120_000,
    });

    progress.phase("drive the interactive onboard wizard through a real PTY");
    const result = await driveInteractiveCommand({
      activityLabel: "command: onboard-interactive-pty",
      progress,
      cmd: [
        process.execPath,
        CLI_ENTRYPOINT,
        "onboard",
        "--fresh",
        "--agent",
        "openclaw",
        "--name",
        SANDBOX_NAME,
        "--yes-i-accept-third-party-software",
      ],
      cwd: REPO_ROOT,
      env: buildAvailabilityProbeEnv(),
      rules: [
        ...compatibleEndpointRules(fake.baseUrl, apiKey),
        // Raw-mode Policy tier selector; Enter confirms the pre-selected
        // default (Balanced). This is the exact prompt the issue claims the
        // wizard never reaches.
        { trigger: "Policy tier", response: "\r" },
        // A second raw-mode selector follows immediately: individual preset
        // inclusion/rw toggles, pre-populated from the chosen tier. Enter
        // confirms the Balanced defaults.
        { trigger: "Presets  (", response: "\r" },
      ],
      timeoutMs: ONBOARD_TIMEOUT_MS - 5 * 60_000,
    });
    await artifacts.writeText("onboard-transcript.txt", result.output);

    const redactedTranscript = redactString(result.output, [apiKey]);
    expect(
      result.timedOut,
      `onboard command timed out; see onboard-transcript.txt:\n${redactedTranscript}`,
    ).toBe(false);
    expect(
      result.exitCode,
      `onboard command exited non-zero; see onboard-transcript.txt:\n${redactedTranscript}`,
    ).toBe(0);
    expect(result.firedTriggers).toContain("Other OpenAI-compatible endpoint");
    expect(result.firedTriggers).toContain("Policy tier");

    progress.phase("confirm every ordered onboarding step appears in order");
    let searchFrom = 0;
    ORDERED_STEP_MARKERS.forEach((marker) => {
      const index = result.output.indexOf(marker, searchFrom);
      expect(
        index,
        `expected step marker ${JSON.stringify(marker)} after offset ${searchFrom} in the transcript; see onboard-transcript.txt`,
      ).toBeGreaterThanOrEqual(searchFrom);
      searchFrom = index + marker.length;
    });

    progress.phase("confirm Policy presets is reached before completion");
    const policyIndex = result.output.indexOf("[8/8] Policy presets");
    const abortedIndex = result.output.search(/Onboarding did not finish/i);
    expect(policyIndex, "Policy presets step must be observed").toBeGreaterThanOrEqual(0);
    expect(
      abortedIndex,
      `onboarding must not abort after reaching Policy presets; see onboard-transcript.txt:\n${redactedTranscript}`,
    ).not.toBeGreaterThanOrEqual(0);
  },
);

// #13180: `--policy-tier` must govern the interactive journey end to end. The
// conflicting NEMOCLAW_POLICY_TIER=open would otherwise pre-select Open, whose
// defaults include npm and pypi; Restricted applies neither. Unit tests own the
// precedence and threading logic; this case proves the real CLI-to-wizard
// handoff skips the tier selector and that the created sandbox's live
// OpenShell policy carries the Restricted result.
test(
  "interactive onboard applies --policy-tier over NEMOCLAW_POLICY_TIER without the tier prompt (#13180)",
  {
    timeout: POLICY_TIER_FLAG_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "start the local compatible-endpoint fake server",
        "drive interactive onboard with --policy-tier restricted and NEMOCLAW_POLICY_TIER=open",
        "confirm the tier selector was skipped",
        "confirm the live sandbox policy has no Open-tier defaults",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider }) => {
    await runtimeProvider.requireAvailable({
      artifactName: "prereq-runtime-provider-info-policy-tier-flag",
      scenarioLabel: "onboard --policy-tier",
    });

    progress.phase("start the local compatible-endpoint fake server");
    const apiKey = `e2e-13180-${randomBytes(16).toString("hex")}`;
    const fake = await startFakeOpenAiCompatibleServer({
      apiKey,
      chatContent: "PONG",
      host: "0.0.0.0",
      model: MODEL,
      progress,
      publicHost: SANDBOX_HOST_ALIAS,
      requireAuth: true,
      responseText: "PONG",
    });
    artifacts.addRedactionValues([apiKey]);
    cleanup.trackDisposable("close fake compatible-endpoint server", () => fake.close());
    cleanup.trackSandbox(host, POLICY_TIER_FLAG_SANDBOX_NAME, {
      artifactName: "cleanup-nemoclaw-destroy-onboard-policy-tier-flag",
      env: buildAvailabilityProbeEnv(),
      redactionValues: [apiKey],
      timeoutMs: 120_000,
    });

    progress.phase(
      "drive interactive onboard with --policy-tier restricted and NEMOCLAW_POLICY_TIER=open",
    );
    const result = await driveInteractiveCommand({
      activityLabel: "command: onboard-interactive-pty-policy-tier-flag",
      progress,
      cmd: [
        process.execPath,
        CLI_ENTRYPOINT,
        "onboard",
        "--fresh",
        "--agent",
        "openclaw",
        "--name",
        POLICY_TIER_FLAG_SANDBOX_NAME,
        "--policy-tier",
        "restricted",
        "--yes-i-accept-third-party-software",
      ],
      cwd: REPO_ROOT,
      env: { ...buildAvailabilityProbeEnv(), NEMOCLAW_POLICY_TIER: "open" },
      rules: [
        ...compatibleEndpointRules(fake.baseUrl, apiKey),
        // Must not fire: answering it keeps a regression from hanging the
        // run, and the assertion below fails if the selector appeared.
        { trigger: POLICY_TIER_PROMPT_HEADER, response: "\r" },
        // The preset review still runs with the flag's tier defaults.
        { trigger: "Presets  (", response: "\r" },
      ],
      timeoutMs: POLICY_TIER_FLAG_TIMEOUT_MS - 3 * 60_000,
    });
    await artifacts.writeText("onboard-policy-tier-flag-transcript.txt", result.output);

    const redactedTranscript = redactString(result.output, [apiKey]);
    // A driver timeout exits 124, so the exit code also covers the timeout.
    expect(
      result.exitCode,
      `onboard command failed; see onboard-policy-tier-flag-transcript.txt:\n${redactedTranscript}`,
    ).toBe(0);

    progress.phase("confirm the tier selector was skipped");
    expect(result.firedTriggers).not.toContain(POLICY_TIER_PROMPT_HEADER);

    progress.phase("confirm the live sandbox policy has no Open-tier defaults");
    const policyList = await host.nemoclaw([POLICY_TIER_FLAG_SANDBOX_NAME, "policy-list"], {
      artifactName: "policy-tier-flag-policy-list-after-onboard",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 120_000,
    });
    const policyListText = `${policyList.stdout}\n${policyList.stderr}`;
    // npm is a Balanced and Open default but not a Restricted one. A failed or
    // unverified listing parses as another state and fails this assertion.
    expect(
      parsePolicyPresetState(policyListText, "npm"),
      `Restricted must not apply the Open-tier npm default:\n${policyListText}`,
    ).toBe("inactive");
  },
);
