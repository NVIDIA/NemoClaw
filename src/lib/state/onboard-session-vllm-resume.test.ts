// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OnboardSessionModule = typeof import("./onboard-session");

let session: OnboardSessionModule;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vllm-resume-session-"));
  vi.stubEnv("HOME", tmpDir);
  vi.resetModules();
  session = await import("./onboard-session");
  session.clearSession();
});

afterEach(() => {
  session.releaseOnboardLock();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function requireLoadedSession(): NonNullable<ReturnType<OnboardSessionModule["loadSession"]>> {
  const loaded = session.loadSession();
  expect(loaded).not.toBeNull();
  return loaded!;
}

describe("managed vLLM resume checkpoint persistence", () => {
  it("retains a secret-free model across failure and clears it on success", () => {
    session.saveSession(session.createSession({ mode: "non-interactive" }));
    session.markStepStarted("provider_selection");
    session.checkpointVllmInstallModel("Inferact/Muse-Glimmer-30B-NVFP4-W4A4");
    session.markStepFailed("provider_selection", "image pull failed");

    let loaded = requireLoadedSession();
    expect(loaded.vllmInstallModel).toBe("Inferact/Muse-Glimmer-30B-NVFP4-W4A4");
    expect(session.summarizeForDebug()?.vllmInstallModel).toBe(
      "Inferact/Muse-Glimmer-30B-NVFP4-W4A4",
    );

    session.markStepStarted("provider_selection");
    session.markStepComplete("provider_selection", {
      provider: "vllm-local",
      model: "Inferact/Muse-Glimmer-30B-NVFP4-W4A4",
    });
    loaded = requireLoadedSession();
    expect(loaded.vllmInstallModel).toBeNull();
  });

  it("accepts legacy sessions and rejects malformed checkpoints", () => {
    const legacy = session.createSession() as unknown as Record<string, unknown>;
    delete legacy.vllmInstallModel;
    expect(session.normalizeSession(legacy as never)?.vllmInstallModel).toBeNull();

    const malformed = session.createSession() as unknown as Record<string, unknown>;
    malformed.vllmInstallModel = "unsafe model; token=secret";
    expect(session.normalizeSession(malformed as never)).toBeNull();
  });

  it("persists a vLLM GPU UUID and keeps sessions without the new field compatible", () => {
    const uuid = "GPU-69adb14e-820e-bfb4-0993-171e73f68504";
    session.saveSession(session.createSession({ vllmGpuDevice: uuid }));

    expect(requireLoadedSession().vllmGpuDevice).toBe(uuid);
    expect(session.summarizeForDebug()?.vllmGpuDevice).toBe(uuid);

    const legacy = session.createSession() as unknown as Record<string, unknown>;
    delete legacy.vllmGpuDevice;
    expect(session.normalizeSession(legacy as never)?.vllmGpuDevice).toBeNull();

    const malformed = session.createSession() as unknown as Record<string, unknown>;
    malformed.vllmGpuDevice = "nvidia.com/gpu=0";
    expect(session.normalizeSession(malformed as never)).toBeNull();
  });

  it("refuses to checkpoint outside provider selection", () => {
    session.saveSession(session.createSession());
    expect(() => session.checkpointVllmInstallModel("example/model")).toThrow(
      "only be checkpointed during provider selection",
    );
    expect(requireLoadedSession().vllmInstallModel).toBeNull();
  });

  it("clears the checkpoint when provider selection is rejected", () => {
    session.saveSession(session.createSession({ mode: "non-interactive" }));
    session.markStepStarted("provider_selection");
    session.checkpointVllmInstallModel("example/model");

    const rejected = session.markStepRejected("provider_selection");

    expect(rejected.vllmInstallModel).toBeNull();
    expect(rejected.steps.provider_selection?.status).toBe("skipped");
    expect(rejected.resumable).toBe(false);
    expect(requireLoadedSession().vllmInstallModel).toBeNull();
  });
});
