// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let temporaryHome: string;

const activationEvidence = {
  schemaVersion: 1 as const,
  activationId: "4b5a8e18-f967-4e27-a3b2-f2cc315abe21",
  componentId: "policy-governance",
  lifecycleGeneration: "generation-1",
  sandboxIdentityFingerprint: `sha256:${"b".repeat(64)}`,
  resultClass: "ambiguous" as const,
};

beforeEach(() => {
  temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-component-session-"));
  vi.stubEnv("HOME", temporaryHome);
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(temporaryHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("external component activation session evidence", () => {
  it("does not change persisted sessions without activation evidence (#11340)", async () => {
    const sessionState = await import("./onboard-session.js");

    sessionState.saveSession(sessionState.createSession());

    expect(fs.readFileSync(sessionState.SESSION_FILE, "utf-8")).not.toContain(
      "externalComponentActivation",
    );
  });

  it("persists bounded incomplete state without mutable sandbox identity (#11340)", async () => {
    const sessionState = await import("./onboard-session.js");

    sessionState.saveSession(
      sessionState.createSession({ externalComponentActivation: activationEvidence }),
    );

    expect(sessionState.loadSession()?.externalComponentActivation).toEqual(activationEvidence);
    const raw = fs.readFileSync(sessionState.SESSION_FILE, "utf-8");
    const persisted = JSON.parse(raw) as {
      externalComponentActivation: Record<string, unknown>;
    };
    expect(persisted.externalComponentActivation).toEqual(activationEvidence);
    expect(persisted.externalComponentActivation).not.toHaveProperty("sandboxName");
    expect(JSON.stringify(persisted.externalComponentActivation)).not.toMatch(
      /credential|secret|token|password|api.?key/iu,
    );
  });

  it("rejects added fields and malformed durable evidence (#11340)", async () => {
    const sessionState = await import("./onboard-session.js");
    const withSecret = {
      ...activationEvidence,
      credential: "do-not-persist",
    };

    expect(
      sessionState.filterSafeUpdates({
        externalComponentActivation: withSecret,
      } as never),
    ).toEqual({});
    expect(() =>
      sessionState.normalizeSession({
        ...sessionState.createSession(),
        externalComponentActivation: withSecret,
      } as never),
    ).toThrow(sessionState.InvalidPersistedExternalComponentActivationError);
  });
});
