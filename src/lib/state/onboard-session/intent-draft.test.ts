// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let sessionHome: string;

beforeEach(() => {
  sessionHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-intent-draft-session-"));
  vi.stubEnv("HOME", sessionHome);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(sessionHome, { recursive: true, force: true });
});

describe("onboarding intent draft session persistence (#6005)", () => {
  it("round-trips a partial secret-free draft", async () => {
    const session = await import("../onboard-session");
    const created = session.createSession();
    created.intentDraft = {
      version: 1,
      phase: "collecting",
      answers: {
        agent: "openclaw",
        inference: {
          provider: "build",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          authMethod: "api_key",
        },
      },
    };

    session.saveSession(created);

    expect(session.loadSession()?.intentDraft).toEqual(created.intentDraft);
  });

  it("drops unknown credential-shaped fields", async () => {
    const session = await import("../onboard-session");
    const created = session.createSession() as unknown as Record<string, unknown>;
    created.intentDraft = {
      version: 1,
      phase: "collecting",
      credential: "must-not-persist",
      answers: { agent: "openclaw", apiKey: "must-not-persist" },
    };

    const normalized = session.normalizeSession(created as never);

    expect(normalized?.intentDraft).toEqual({
      version: 1,
      phase: "collecting",
      answers: { agent: "openclaw" },
    });
    expect(JSON.stringify(normalized?.intentDraft)).not.toContain("must-not-persist");
  });

  it("rejects a session with a malformed non-null draft", async () => {
    const session = await import("../onboard-session");
    const created = session.createSession() as unknown as Record<string, unknown>;
    created.intentDraft = {
      version: 1,
      phase: "collecting",
      answers: { messaging: ["telegram", 42] },
    };

    expect(session.normalizeSession(created as never)).toBeNull();
  });
});
