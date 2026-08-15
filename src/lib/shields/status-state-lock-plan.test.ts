// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shields-plan-status-test-"));
  vi.stubEnv("HOME", tmpDir);
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSealedLockedState(sandboxName: string): void {
  const stateDir = path.join(tmpDir, ".nemoclaw", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, `shields-${sandboxName}.json`),
    JSON.stringify(
      {
        shieldsDown: false,
        chattrApplied: true,
        fileHashes: {
          "/sandbox/.openclaw/openclaw.json":
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

async function loadShieldsModule() {
  return import(path.join(process.cwd(), "src", "lib", "shields", "index.ts"));
}

describe("Shields status state lock plan drift", () => {
  it("reports a mismatched installed state lock plan as drift", async () => {
    const sandboxName = "openclaw";
    writeSealedLockedState(sandboxName);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

    const { shieldsStatus } = await loadShieldsModule();
    expect(() =>
      shieldsStatus(sandboxName, true, {
        verifyLockState: () => ({ ok: true, issues: [] }),
        verifyStateLockPlan: () => [
          "installed state lock plan differs from the current agent manifest",
        ],
        resolveConfig: () => ({
          agentName: "openclaw",
          configPath: "/sandbox/.openclaw/openclaw.json",
          configDir: "/sandbox/.openclaw",
        }),
      }),
    ).toThrow("exit 2");

    const errors = errorSpy.mock.calls.map((args) => args[0]).join("\n");
    expect(errors).toContain(
      "state lock plan: installed state lock plan differs from the current agent manifest",
    );
    expect(errors).toContain(
      "Recovery: rebuild the sandbox so its generated state lock plan matches the current agent manifest.",
    );
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("reports confirmed plan drift when filesystem verification also throws", async () => {
    const sandboxName = "openclaw";
    writeSealedLockedState(sandboxName);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });

    const { shieldsStatus } = await loadShieldsModule();
    expect(() =>
      shieldsStatus(sandboxName, true, {
        verifyLockState: () => {
          throw new Error("filesystem verification failed");
        },
        verifyStateLockPlan: () => [
          "installed state lock plan differs from the current agent manifest",
        ],
        resolveConfig: () => ({
          agentName: "openclaw",
          configPath: "/sandbox/.openclaw/openclaw.json",
          configDir: "/sandbox/.openclaw",
          stateLockPlanInImage: true,
        }),
      }),
    ).toThrow("exit 2");

    const errors = errorSpy.mock.calls.map((args) => args[0]).join("\n");
    expect(errors).toContain(
      "state lock plan: installed state lock plan differs from the current agent manifest",
    );
    expect(errors).toContain(
      "unable to verify agent config target: filesystem verification failed",
    );
    expect(errors).toContain(
      "Recovery: rebuild the sandbox so its generated state lock plan matches the current agent manifest.",
    );
  });
});
