// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import { recordedNativeProviderAttachment } from "../../../src/lib/inference/native-provider/recorded-selection.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { readRegistrySandboxEntry } from "../fixtures/phases/state-validation.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import { redactString } from "../fixtures/redaction.ts";
import { driveInteractiveCommand } from "./onboard-interactive-pty.ts";

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
// (`nemoclaw onboard` with "Other OpenAI-compatible endpoint"). It selects
// Personal so the same journey also proves the hosted custom endpoint remains
// on inference.local without acquiring a native provider attachment.

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-policy-order";
validateSandboxName(SANDBOX_NAME);
const ONBOARD_TIMEOUT_MS = 40 * 60_000;
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

test(
  "interactive onboard wizard reaches Policy presets in step order (#6042)",
  {
    timeout: ONBOARD_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "start the local compatible-endpoint fake server",
        "drive the interactive onboard wizard through a real PTY",
        "confirm every ordered onboarding step appears in order",
        "confirm Personal keeps the hosted custom endpoint on inference.local",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
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
        { trigger: "OpenAI-compatible base URL", response: `${fake.baseUrl}\n` },
        { trigger: "Other OpenAI-compatible endpoint API key:", response: `${apiKey}\n` },
        { trigger: "endpoint model", response: `${MODEL}\n` },
        { trigger: "Choose an action:", response: "1\n" },
        { trigger: "Enable web search", response: "1\n" },
        // Raw-mode messaging-channel selector; Enter with none toggled skips.
        { trigger: "Press 1-7 to toggle", response: "\r" },
        { trigger: "Resource profiles:", response: "6\n" },
        // Raw-mode Policy tier selector. Balanced is pre-selected at index 1;
        // move twice to Personal, select it, then confirm. Paced writes keep
        // each raw-mode key as a distinct input event.
        { trigger: "Policy tier", response: ["j", "j", " ", "\r"], settleMs: 200 },
        // A second raw-mode selector follows immediately: individual preset
        // inclusion/rw toggles, pre-populated from the chosen tier. Enter
        // confirms the Personal defaults.
        { trigger: "Presets  (", response: "\r" },
      ],
      timeoutMs: ONBOARD_TIMEOUT_MS - 5 * 60_000,
    });
    await artifacts.writeText("onboard-transcript.txt", result.output);

    const redactedTranscript = redactString(result.output, [apiKey]);
    expect(
      result.exitCode,
      `onboard command exited non-zero; see onboard-transcript.txt:\n${redactedTranscript}`,
    ).toBe(0);

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

    progress.phase("confirm Personal keeps the hosted custom endpoint on inference.local");
    const policyList = await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "policy-list"], {
      artifactName: "policy-list-personal-compatible-endpoint",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });
    const policyListText = resultText(policyList).replace(/\u001b\[[0-9;]*m/gu, "");
    expect(policyList.exitCode, policyListText).toBe(0);
    expect(policyListText).toMatch(/●\s+personal-open-internet\s+\[/u);

    const registered = readRegistrySandboxEntry(SANDBOX_NAME);
    expect(recordedNativeProviderAttachment(registered)).toBeUndefined();

    const chat = await sandbox.exec(
      SANDBOX_NAME,
      [
        "curl",
        "-fsS",
        "--max-time",
        "60",
        "https://inference.local/v1/chat/completions",
        "-H",
        "Content-Type: application/json",
        "--data-raw",
        JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
          max_tokens: 50,
        }),
      ],
      {
        artifactName: "personal-compatible-endpoint-inference-local-chat",
        env: buildAvailabilityProbeEnv(),
        redactionValues: [apiKey],
        timeoutMs: 90_000,
      },
    );
    expect(chat.exitCode, resultText(chat)).toBe(0);
    expect(chat.stdout).toContain("PONG");
  },
);
