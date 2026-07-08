// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const modulePath = require.resolve("./onboard-session");
const originalHome = process.env.HOME;
type OnboardSessionModule = typeof import("./onboard-session");
type LoadedSession = NonNullable<ReturnType<OnboardSessionModule["loadSession"]>>;
type DebugSummary = NonNullable<ReturnType<OnboardSessionModule["summarizeForDebug"]>>;
let session: OnboardSessionModule;
let tmpDir: string;

function requireLoadedSession(
  loaded: ReturnType<OnboardSessionModule["loadSession"]>,
): LoadedSession {
  expect(loaded).not.toBeNull();
  return loaded as LoadedSession;
}

function requireDebugSummary(
  summary: ReturnType<OnboardSessionModule["summarizeForDebug"]>,
): DebugSummary {
  expect(summary).not.toBeNull();
  return summary as DebugSummary;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-session-tool-disclosure-"));
  process.env.HOME = tmpDir;
  delete require.cache[modulePath];
  session = require("./onboard-session");
  session.clearSession();
  session.releaseOnboardLock();
});

afterEach(() => {
  delete require.cache[modulePath];
  fs.rmSync(tmpDir, { recursive: true, force: true });
  Reflect.deleteProperty(process.env, "HOME");
  Object.assign(process.env, originalHome === undefined ? {} : { HOME: originalHome });
});

describe("onboard session tool disclosure", () => {
  it("round-trips direct tool disclosure and defaults legacy sessions to progressive", () => {
    session.saveSession(session.createSession({ toolDisclosure: "direct" }));
    expect(requireLoadedSession(session.loadSession()).toolDisclosure).toBe("direct");
    expect(requireDebugSummary(session.summarizeForDebug()).toolDisclosure).toBe("direct");

    const legacy = session.createSession() as unknown as Record<string, unknown>;
    delete legacy.toolDisclosure;
    const normalized = session.normalizeSession(
      legacy as Parameters<OnboardSessionModule["normalizeSession"]>[0],
    );
    expect(requireLoadedSession(normalized).toolDisclosure).toBe("progressive");
  });

  it("marks corrupt persisted tool-disclosure state instead of treating it as legacy missing", () => {
    const corrupt = session.createSession() as unknown as Record<string, unknown>;
    corrupt.toolDisclosure = "everything";

    const normalized = requireLoadedSession(session.normalizeSession(corrupt as never));
    expect(normalized.toolDisclosure).toBe("progressive");
    expect(session.hasInvalidSessionToolDisclosure(normalized)).toBe(true);
  });
});
