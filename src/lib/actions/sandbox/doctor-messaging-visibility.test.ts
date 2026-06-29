// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { compileTelegramPlanForTests } from "../../messaging/__test-utils__/telegram-plan";
import {
  createDoctorHarness as createDoctorHarnessShared,
  type DoctorHarness,
  mockTelegramDoctorRegistryForHarness,
  setupDoctorRealPlanReader as setupDoctorRealPlanReaderShared,
} from "./__test-utils__/doctor-harness";

const requireDist = createRequire(import.meta.url);
const doctorModulePath = "./doctor.js";

function createDoctorHarness(): DoctorHarness {
  return createDoctorHarnessShared(requireDist);
}

function mockTelegramDoctorRegistry(
  options: Parameters<typeof mockTelegramDoctorRegistryForHarness>[1],
): void {
  mockTelegramDoctorRegistryForHarness(requireDist, options);
}

async function setupDoctorRealPlanReader(
  harness: { getSandboxSpy: MockInstance },
  options: Parameters<typeof setupDoctorRealPlanReaderShared>[2],
): Promise<void> {
  await setupDoctorRealPlanReaderShared(requireDist, harness, options);
}

describe("runSandboxDoctor messaging visibility", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[requireDist.resolve(doctorModulePath)];
  });

  it("surfaces Telegram visible config inputs in the Messaging doctor section", async () => {
    const harness = createDoctorHarness();
    mockTelegramDoctorRegistry({
      agent: "openclaw",
      inputs: [{ inputId: "requireMention", value: "0" }],
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });

    expect(report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: "Messaging",
          label: "Telegram group mention mode",
          status: "ok",
          detail: "all group messages (TELEGRAM_REQUIRE_MENTION=0)",
        }),
        expect.objectContaining({
          group: "Messaging",
          label: "Telegram group policy",
          status: "info",
          detail: "open groups (default)",
        }),
      ]),
    );
    const messagingChecks = (report?.checks ?? []).filter((check) => check.group === "Messaging");
    const sensitiveLabels = ["Bot Token", "User ID", "secret"];
    const leakedLabel = messagingChecks.find((check) =>
      sensitiveLabels.some((sensitive) =>
        check.label.toLowerCase().includes(sensitive.toLowerCase()),
      ),
    );
    expect(leakedLabel).toBeUndefined();
  });

  it("hides the OpenClaw-only Telegram group policy when the sandbox runs Hermes", async () => {
    const harness = createDoctorHarness();
    harness.getSandboxSpy.mockReturnValue({
      name: "alpha",
      agent: "hermes",
      model: "registry-model",
      provider: "ollama-local",
      openshellDriver: "docker",
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
      messaging: undefined,
    });
    mockTelegramDoctorRegistry({ agent: "hermes" });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });
    const messagingChecks = (report?.checks ?? []).filter((check) => check.group === "Messaging");

    expect(messagingChecks.some((check) => check.label === "Telegram group policy")).toBe(false);
    expect(
      messagingChecks.find((check) => check.label === "Telegram group mention mode"),
    ).toMatchObject({ status: "info", detail: "mention-only (default)" });
  });

  it("hides agent-applicability-restricted visible config when a legacy SandboxEntry omits the agent field", async () => {
    const harness = createDoctorHarness();
    harness.getSandboxSpy.mockReturnValue({
      name: "alpha",
      model: "registry-model",
      provider: "ollama-local",
      openshellDriver: "docker",
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
      messaging: undefined,
    });
    mockTelegramDoctorRegistry({ agent: "openclaw" });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });
    const messagingChecks = (report?.checks ?? []).filter((check) => check.group === "Messaging");

    expect(messagingChecks.some((check) => check.label === "Telegram group policy")).toBe(false);
    expect(
      messagingChecks.find((check) => check.label === "Telegram group mention mode"),
    ).toMatchObject({ status: "info", detail: "mention-only (default)" });
  });

  it("flags an invalid persisted Telegram group policy without echoing the raw value", async () => {
    const harness = createDoctorHarness();
    mockTelegramDoctorRegistry({
      agent: "openclaw",
      inputs: [{ inputId: "groupPolicy", value: "definitely-not-a-policy" }],
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });
    const policyCheck = (report?.checks ?? []).find(
      (check) => check.group === "Messaging" && check.label === "Telegram group policy",
    );

    expect(policyCheck).toBeDefined();
    expect(policyCheck?.status).toBe("warn");
    expect(policyCheck?.detail).toMatch(
      /invalid persisted value \(expected: open \| allowlist \| disabled\)/,
    );
    expect(policyCheck?.detail).not.toContain("definitely-not-a-policy");
  });

  it("flags a present-but-empty Telegram mention-mode value as invalid rather than defaulting", async () => {
    const harness = createDoctorHarness();
    mockTelegramDoctorRegistry({
      agent: "openclaw",
      inputs: [{ inputId: "requireMention", value: "" }],
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });
    const mentionCheck = (report?.checks ?? []).find(
      (check) => check.group === "Messaging" && check.label === "Telegram group mention mode",
    );

    expect(mentionCheck).toBeDefined();
    expect(mentionCheck?.status).toBe("warn");
    expect(mentionCheck?.detail).toMatch(/invalid persisted value/);
    expect(mentionCheck?.detail).not.toMatch(/default/);
  });

  it("surfaces Telegram visible config from a plan compiled out of process env through doctor", async () => {
    const harness = createDoctorHarness();
    const compiledPlan = await compileTelegramPlanForTests({
      envOverrides: { TELEGRAM_GROUP_POLICY: "allowlist" },
    });
    const registry = requireDist("../../state/registry.js");
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["telegram"]);
    vi.spyOn(registry, "getDisabledMessagingChannelsFromEntry").mockReturnValue([]);
    vi.spyOn(registry, "getMessagingPlanFromEntry").mockReturnValue(compiledPlan);

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });
    const messagingChecks = (report?.checks ?? []).filter((check) => check.group === "Messaging");

    expect(messagingChecks.find((check) => check.label === "Telegram group policy")).toMatchObject({
      status: "ok",
      detail: "allowlisted groups only (TELEGRAM_GROUP_POLICY=allowlist)",
    });
    expect(
      messagingChecks.find((check) => check.label === "Telegram group mention mode"),
    ).toMatchObject({
      status: "ok",
      detail: "mention-only (TELEGRAM_REQUIRE_MENTION=1)",
    });
  });

  it("reads Telegram visible config from a non-interactive compact registry entry through the real plan reader", async () => {
    const harness = createDoctorHarness();
    await setupDoctorRealPlanReader(harness, {
      envOverrides: { TELEGRAM_GROUP_POLICY: "allowlist", TELEGRAM_REQUIRE_MENTION: "0" },
      isInteractive: false,
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });
    const messagingChecks = (report?.checks ?? []).filter((check) => check.group === "Messaging");

    expect(messagingChecks.find((check) => check.label === "Telegram group policy")).toMatchObject({
      status: "ok",
      detail: "allowlisted groups only (TELEGRAM_GROUP_POLICY=allowlist)",
    });
    expect(
      messagingChecks.find((check) => check.label === "Telegram group mention mode"),
    ).toMatchObject({
      status: "ok",
      detail: "all group messages (TELEGRAM_REQUIRE_MENTION=0)",
    });
  });

  it("renders mention-only when a non-interactive compact registry entry omits TELEGRAM_REQUIRE_MENTION", async () => {
    const harness = createDoctorHarness();
    await setupDoctorRealPlanReader(harness, {
      envOverrides: { TELEGRAM_GROUP_POLICY: undefined, TELEGRAM_REQUIRE_MENTION: undefined },
      isInteractive: false,
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });
    const messagingChecks = (report?.checks ?? []).filter((check) => check.group === "Messaging");

    expect(
      messagingChecks.find((check) => check.label === "Telegram group mention mode"),
    ).toMatchObject({
      status: "ok",
      detail: "mention-only (TELEGRAM_REQUIRE_MENTION=1)",
    });
  });

  it("bounds tampered out-of-allowlist Telegram visible config from a compact registry entry through the real plan reader", async () => {
    const harness = createDoctorHarness();
    await setupDoctorRealPlanReader(harness, {
      envOverrides: { TELEGRAM_GROUP_POLICY: "allowlist", TELEGRAM_REQUIRE_MENTION: "0" },
      isInteractive: false,
      tamperedInputs: { groupPolicy: "definitely-not-a-policy", requireMention: "" },
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });
    const messagingChecks = (report?.checks ?? []).filter((check) => check.group === "Messaging");

    const policy = messagingChecks.find((check) => check.label === "Telegram group policy");
    expect(policy?.status).toBe("warn");
    expect(policy?.detail).toMatch(
      /invalid persisted value \(expected: open \| allowlist \| disabled\)/,
    );
    expect(policy?.detail).not.toContain("definitely-not-a-policy");

    const mention = messagingChecks.find((check) => check.label === "Telegram group mention mode");
    expect(mention?.status).toBe("warn");
    expect(mention?.detail).toMatch(/invalid persisted value/);
  });

  it("redacts non-scalar Telegram visible config from a compact registry entry through the real plan reader", async () => {
    const harness = createDoctorHarness();
    await setupDoctorRealPlanReader(harness, {
      envOverrides: { TELEGRAM_GROUP_POLICY: "allowlist", TELEGRAM_REQUIRE_MENTION: "0" },
      isInteractive: false,
      tamperedInputs: {
        groupPolicy: { smuggled: "secret-id" } as unknown,
        requireMention: ["1", "0"] as unknown,
      },
    });

    const report = await harness.runSandboxDoctor("alpha", ["--json"], { quietJson: true });
    const messagingChecks = (report?.checks ?? []).filter((check) => check.group === "Messaging");

    const policy = messagingChecks.find((check) => check.label === "Telegram group policy");
    expect(policy?.detail).toMatch(/invalid persisted value \(unsupported type\)/);
    expect(policy?.detail).not.toContain("secret-id");
    expect(policy?.detail).not.toContain("smuggled");

    const mention = messagingChecks.find((check) => check.label === "Telegram group mention mode");
    expect(mention?.detail).toMatch(/invalid persisted value \(unsupported type\)/);
  });
});
