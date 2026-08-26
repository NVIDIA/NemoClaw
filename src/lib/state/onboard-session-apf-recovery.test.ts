// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatRetainedApfSandboxRecoveryReceipt } from "../onboard/created-sandbox-failure";

const originalHome = process.env.HOME;
type OnboardSessionModule = typeof import("./onboard-session");
let session: OnboardSessionModule;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-apf-recovery-"));
  process.env.HOME = tmpDir;
  vi.resetModules();
  session = await import("./onboard-session");
  session.clearSession();
});

afterEach(() => {
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  Reflect.deleteProperty(process.env, "HOME");
  Object.assign(process.env, originalHome === undefined ? {} : { HOME: originalHome });
});

describe("APF retained-sandbox session recovery", () => {
  it.each([
    ["identifiable", "b".repeat(64)],
    ["label-only", null],
  ])("round-trips exact %s evidence through terminal failure (#9833)", (_caseName, fingerprint) => {
    const createAttemptNonce = "a".repeat(62);
    const receipt = formatRetainedApfSandboxRecoveryReceipt({
      createAttemptNonce,
      liveIdentityFingerprint: fingerprint,
    });
    session.saveSession(
      session.createSession({
        apfInterceptorRequested: true,
        sandboxName: "alpha",
      }),
    );

    const finalized = session.finalizeIncompleteOnboardStep("sandbox", receipt);
    const loaded = session.loadSession();
    const onDisk = JSON.parse(fs.readFileSync(session.SESSION_FILE, "utf8"));

    expect(receipt.length).toBeLessThanOrEqual(240);
    expect(finalized?.failure?.message).toBe(receipt);
    expect(finalized?.steps.sandbox?.error).toBe(receipt);
    expect(loaded?.failure?.message).toBe(receipt);
    expect(loaded?.steps.sandbox?.error).toBe(receipt);
    expect(onDisk.failure.message).toBe(receipt);
    expect(onDisk.steps.sandbox.error).toBe(receipt);
    expect(loaded?.failure?.message).toContain(createAttemptNonce);
    expect(loaded?.failure?.message).toContain(fingerprint ?? "unresolved");
  });
});
