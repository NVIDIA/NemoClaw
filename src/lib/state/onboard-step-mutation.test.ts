// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as sessionModule from "./onboard-session";

const originalHome = process.env.HOME;
let session: typeof sessionModule;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-step-status-"));
  process.env.HOME = tmpDir;
  vi.resetModules();
  session = await import("./onboard-session");
  session.clearSession();
  session.releaseOnboardLock();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("onboard step status", () => {
  it("persists status and safe updates without changing the machine snapshot", () => {
    session.saveSession(session.createSession());

    session.markStepStarted("preflight");
    session.markStepComplete("preflight", { sandboxName: "my-assistant" });
    session.markStepFailed("gateway", "Gateway failed: NVIDIA_INFERENCE_API_KEY=nvapi-secret");

    const loaded = session.loadSession();
    expect(loaded).not.toBeNull();
    expect(loaded).toMatchObject({
      sandboxName: "my-assistant",
      status: "in_progress",
      failure: null,
      machine: { state: "init", revision: 0 },
      steps: {
        preflight: { status: "complete" },
        gateway: {
          status: "failed",
          error: "Gateway failed: NVIDIA_INFERENCE_API_KEY=<REDACTED>",
        },
      },
    });
  });
});
