// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { serializedLlamaCppHostLocalInferenceReceipt } from "../../../../../test/helpers/host-local-inference-receipt";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
  detectUnconfiguredMessagingChannels: vi.fn(() => []),
}));

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-host-local-resume-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

async function resumedHostLocalSandbox() {
  const { handleSandboxState } = await import("./sandbox");
  const { baseOptions, createDeps } = await import("./sandbox-test-fixtures");
  const { createSession } = await import("../../../state/onboard-session");
  const registry = await import("../../../state/registry");
  const { normalizeInferenceSelection } = await import("../../../inference/selection");
  const { qualifyPendingSandboxCreateReservation } =
    await import("../../../state/registry/route-reservation");
  const { createSandboxHostLocalInferenceProvenance } =
    await import("../../../state/registry/host-local-inference");
  const session = createSession({ sandboxName: "saved" });
  session.steps.sandbox.status = "complete";
  const hostLocalInferenceReceipt = serializedLlamaCppHostLocalInferenceReceipt("docker");
  const route = {
    provider: "llama-cpp-local",
    model: "llama-cpp-model",
    endpointUrl: "https://inference.local/v1",
    endpointSource: "inference-set" as const,
    credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
    preferredInferenceApi: "openai-completions",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    openshellDriver: "docker",
    hostLocalInferenceReceipt,
    hostLocalInferenceProvenance: createSandboxHostLocalInferenceProvenance(
      "saved",
      hostLocalInferenceReceipt,
    ),
  };
  registry.restoreSandboxEntry({ name: "saved", ...route });
  const original = registry.getSandbox("saved");
  const admitted = new Error("create admission reached");
  const createSandbox = vi.fn(
    async (...args: Parameters<ReturnType<typeof createDeps>["deps"]["createSandbox"]>) => {
      const authority = args[14];
      assert(authority, "Missing create reservation authority");
      const entry = registry.getSandbox(args[4]);
      expect(authority.sessionId).toBe(session.sessionId);
      expect(normalizeInferenceSelection(authority.selection)).toEqual(
        normalizeInferenceSelection(route),
      );
      qualifyPendingSandboxCreateReservation(
        { sandboxName: args[4], gatewayName: route.gatewayName, ...authority },
        entry,
      );
      throw admitted;
    },
  );
  const { deps } = createDeps(
    {
      createSandbox,
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: registry.getSandbox,
      reserveSandboxInferenceRoute: registry.reserveSandboxInferenceRoute,
    },
    session,
  );
  const options = { ...baseOptions(deps, session), ...route, resume: true, sandboxName: "saved" };
  return {
    run: () => handleSandboxState(options),
    options,
    registry,
    route,
    session,
    createSandbox,
    admitted,
    original,
  };
}

it("reserves the exact published host-local route before resumed create admission", async () => {
  const test = await resumedHostLocalSandbox();
  await expect(test.run()).rejects.toBe(test.admitted);
  expect(test.createSandbox).toHaveBeenCalledOnce();
  expect(test.registry.getSandbox("saved")).toMatchObject({
    ...test.route,
    pendingRouteReservation: true,
    reservationSessionId: test.session.sessionId,
  });
});

it("rejects a changed host-local route before create and preserves its authority", async () => {
  const test = await resumedHostLocalSandbox();
  test.options.model = "different-model";
  await expect(test.run()).rejects.toThrow(
    "Cannot change an explicit host-local inference lifecycle reservation",
  );
  expect(test.createSandbox).not.toHaveBeenCalled();
  expect(test.registry.getSandbox("saved")).toEqual(test.original);
});

it("does not take over a pending reservation owned by another session", async () => {
  const test = await resumedHostLocalSandbox();
  test.registry.reserveSandboxInferenceRoute("saved", {
    ...test.route,
    reservationSessionId: "another-session",
  });
  const before = test.registry.getSandbox("saved");
  await expect(test.run()).rejects.toThrow(
    "its inference route reservation belongs to another onboarding session",
  );
  expect(test.createSandbox).not.toHaveBeenCalled();
  expect(test.registry.getSandbox("saved")).toEqual(before);
});

it.each(["gatewayPort", "openshellDriver"] as const)(
  "reports recovery guidance for a published host-local row missing %s",
  async (field) => {
    const test = await resumedHostLocalSandbox();
    test.registry.restoreSandboxEntry({ name: "saved", ...test.route, [field]: null });
    const before = test.registry.getSandbox("saved");
    const failure = test.run();
    await expect(failure).rejects.toThrow(
      "Cannot reserve host-local inference provenance without exact runtime and gateway authority",
    );
    await expect(failure).rejects.toThrow("sandbox 'saved'");
    await expect(failure).rejects.toThrow("nemoclaw saved doctor");
    await expect(failure).rejects.toHaveProperty(
      "cause.message",
      "Cannot reserve host-local inference provenance without exact runtime and gateway authority",
    );
    expect(test.createSandbox).not.toHaveBeenCalled();
    expect(test.registry.getSandbox("saved")).toEqual(before);
  },
);

it("reuses the same session's pending host-local authority without changing the row", async () => {
  const test = await resumedHostLocalSandbox();
  test.registry.reserveSandboxInferenceRoute("saved", {
    ...test.route,
    reservationSessionId: test.session.sessionId,
  });
  const before = test.registry.getSandbox("saved");
  await expect(test.run()).rejects.toBe(test.admitted);
  expect(test.createSandbox).toHaveBeenCalledOnce();
  expect(test.registry.getSandbox("saved")).toEqual(before);
});

it.each(["gatewayPort", "openshellDriver"] as const)(
  "rejects a pending host-local row missing %s before create",
  async (field) => {
    const test = await resumedHostLocalSandbox();
    test.registry.restoreSandboxEntry({
      name: "saved",
      ...test.route,
      [field]: undefined,
      pendingRouteReservation: true,
      reservationSessionId: test.session.sessionId,
    });
    const before = test.registry.getSandbox("saved");
    const failure = test.run();
    await expect(failure).rejects.toThrow(
      "Cannot reserve host-local inference provenance without exact runtime and gateway authority",
    );
    await expect(failure).rejects.toThrow("sandbox 'saved'");
    await expect(failure).rejects.toThrow("nemoclaw saved doctor");
    await expect(failure).rejects.toHaveProperty(
      "cause.message",
      "Cannot reserve host-local inference provenance without exact runtime and gateway authority",
    );
    expect(test.createSandbox).not.toHaveBeenCalled();
    expect(test.registry.getSandbox("saved")).toEqual(before);
  },
);
