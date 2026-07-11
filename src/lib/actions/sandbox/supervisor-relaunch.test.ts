// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as registry from "../../state/registry";
import { relaunchManagedSupervisorSession } from "./supervisor-relaunch";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function withFakeOpenshellBinary<T>(fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-openshell-"));
  const bin = path.join(dir, "openshell");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", bin);
  try {
    return fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("relaunchManagedSupervisorSession", () => {
  it("returns false without exec'ing when the sandbox is not in the registry", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(null);

    expect(relaunchManagedSupervisorSession("missing-box", { quiet: true })).toBe(false);
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
  });

  it("returns false when the sandbox exec transport throws", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "throwing-box",
      agent: "openclaw",
      dashboardPort: 18789,
    });
    vi.mocked(spawnSync).mockImplementation(() => {
      throw new Error("spawn EACCES");
    });

    expect(
      withFakeOpenshellBinary(() =>
        relaunchManagedSupervisorSession("throwing-box", { quiet: true }),
      ),
    ).toBe(false);
  });
});
