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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-step-start-session-"));
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

describe("onboard session step start", () => {
  it("records a started step with its filtered context in the same write (#13654)", () => {
    session.saveSession(session.createSession());

    session.markStepStarted("provider_selection", {
      provider: "compatible-endpoint",
      endpointUrl: "https://user:secret@proxy.example.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
    });

    const loaded = session.loadSession();
    expect(loaded?.steps.provider_selection.status).toBe("in_progress");
    expect(loaded).toMatchObject({
      provider: "compatible-endpoint",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
    });
    expect(loaded?.endpointUrl).not.toContain("secret");
  });
});
