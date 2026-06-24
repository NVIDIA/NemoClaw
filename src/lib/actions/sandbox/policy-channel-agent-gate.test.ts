// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Lifecycle-boundary regression: `addSandboxChannel` must refuse agents that
// either fall outside the runtime allowlist or carry an explicit empty
// `messagingPlatforms` allowlist BEFORE any preset load, policy mutation,
// provider upsert, registry write, credential prompt, or rebuild trigger.
// Without this gate, a destructive sandbox rebuild can run and fail late at
// Dockerfile patching.
//
// Why dist + vi.spyOn (matches policy-channel-conflict.test.ts): the source
// policy-channel.ts loads several deps via runtime CommonJS `require()`. In
// this repo's vitest setup, `vi.mock` only intercepts ESM `import`, not plain
// `require()`. We `require()` the COMPILED module + its real compiled
// dependency modules from dist/ (one shared require cache) and `vi.spyOn`
// the dependency exports. Run `npm run build:cli` first.

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const requireDist = createRequire(import.meta.url);
const D = (p: string) => requireDist(`../../../../dist/lib/${p}`);

const registry = D("state/registry.js");
const providers = D("onboard/providers.js");
const runtime = D("adapters/openshell/runtime.js");
const defs = D("agent/defs.js");
const rebuild = D("actions/sandbox/rebuild.js");
const policy = D("policy/index.js");
const store = D("credentials/store.js");

const { addSandboxChannel } = D("actions/sandbox/policy-channel.js") as {
  addSandboxChannel: (
    name: string,
    options?: { channel?: string; dryRun?: boolean; force?: boolean },
  ) => Promise<void>;
};

let exitMock: MockInstance;
let errSpy: MockInstance;
let logSpy: MockInstance;
let getSandboxMock: MockInstance;
let upsertMock: MockInstance;
let updateSandboxMock: MockInstance;
let runOpenshellMock: MockInstance;
let applyPresetMock: MockInstance;
let loadPresetMock: MockInstance;
let saveCredentialMock: MockInstance;
let getCredentialMock: MockInstance;
let promptMock: MockInstance;
let rebuildMock: MockInstance;

function exitCodeFromError(err: unknown): number | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/^process\.exit\((\d+)\)$/);
  return match ? Number(match[1]) : null;
}

beforeEach(() => {
  delete process.env.NEMOCLAW_NON_INTERACTIVE;

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  exitMock = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);

  getSandboxMock = vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "da-test" });
  updateSandboxMock = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
  upsertMock = vi.spyOn(providers, "upsertMessagingProviders").mockImplementation(() => undefined);
  runOpenshellMock = vi
    .spyOn(runtime, "runOpenshell")
    .mockReturnValue({ status: 0, stdout: "", stderr: "" });
  loadPresetMock = vi
    .spyOn(policy, "loadPreset")
    .mockReturnValue("network_policies:\n  stub: {}\n");
  vi.spyOn(policy, "parsePresetPolicyKeys").mockReturnValue(["stub"]);
  vi.spyOn(policy, "listPresets").mockReturnValue([]);
  applyPresetMock = vi.spyOn(policy, "applyPreset").mockReturnValue(true);
  vi.spyOn(policy, "getAppliedPresets").mockReturnValue([]);
  getCredentialMock = vi.spyOn(store, "getCredential").mockReturnValue(null);
  saveCredentialMock = vi.spyOn(store, "saveCredential").mockImplementation(() => undefined);
  promptMock = vi.spyOn(store, "prompt").mockResolvedValue("");
  rebuildMock = vi.spyOn(rebuild, "rebuildSandbox").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("addSandboxChannel agent gate", () => {
  it("rejects an unknown agent before any preset, mutation, provider, credential, or rebuild call", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue({
      name: "custom-agent",
      messagingPlatforms: [],
    });

    let caught: unknown;
    try {
      await addSandboxChannel("da-test", { channel: "discord" });
    } catch (err) {
      caught = err;
    }

    expect(exitCodeFromError(caught)).toBe(1);
    const errorText = (errSpy.mock.calls as unknown[][])
      .map((call) => call.map(String).join(" "))
      .join("\n");
    expect(errorText).toMatch(/Agent 'custom-agent' does not support messaging channels/);
    expect(errorText).toMatch(/Messaging-capable agents: openclaw, hermes/);

    expect(loadPresetMock).not.toHaveBeenCalled();
    expect(applyPresetMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(updateSandboxMock).not.toHaveBeenCalled();
    expect(saveCredentialMock).not.toHaveBeenCalled();
    expect(getCredentialMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
    expect(rebuildMock).not.toHaveBeenCalled();
    expect(runOpenshellMock).not.toHaveBeenCalled();
  });

  it("rejects any agent with an explicit empty messagingPlatforms allowlist before any mutation", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue({
      name: "future-agent",
      messagingPlatforms: [],
    });

    let caught: unknown;
    try {
      await addSandboxChannel("da-test", { channel: "telegram" });
    } catch (err) {
      caught = err;
    }

    expect(exitCodeFromError(caught)).toBe(1);
    expect(loadPresetMock).not.toHaveBeenCalled();
    expect(applyPresetMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(updateSandboxMock).not.toHaveBeenCalled();
    expect(rebuildMock).not.toHaveBeenCalled();
  });

  it("does not gate messaging-capable agents (openclaw flows past the agent check)", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue({
      name: "openclaw",
      messagingPlatforms: ["telegram", "discord", "slack", "wechat", "whatsapp"],
    });

    let caught: unknown;
    try {
      await addSandboxChannel("da-test", { channel: "telegram" });
    } catch (err) {
      caught = err;
    }

    const errorText = (errSpy.mock.calls as unknown[][])
      .map((call) => call.map(String).join(" "))
      .join("\n");
    expect(errorText).not.toMatch(/does not support messaging channels/);
    expect(loadPresetMock).toHaveBeenCalled();
    void caught;
    void exitMock;
    void logSpy;
  });
});
