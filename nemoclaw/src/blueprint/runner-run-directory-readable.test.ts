// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRunnerFsStore, FAKE_HOME, inMemoryFsMethods } from "./runner-mock-fixtures.js";

const { store, addDir } = createRunnerFsStore();
const { mockExeca } = vi.hoisted(() => ({ mockExeca: vi.fn() }));

vi.mock("node:os", () => ({ homedir: () => FAKE_HOME }));
vi.mock("execa", () => ({ execa: mockExeca }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  const memory = inMemoryFsMethods(store, { spy: vi.fn });
  return { ...original, readdirSync: memory.readdirSync };
});

const { actionReconcile, actionRollback } = await import("./runner.js");
const mockedReaddirSync = vi.mocked((await import("node:fs")).readdirSync);

const RUNS_DIR = `${FAKE_HOME}/.nemoclaw/state/runs`;

describe("blueprint runner run-directory readability", () => {
  beforeEach(() => {
    store.clear();
    mockExeca.mockReset();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  function mockUnreadableRunDir(runDir: string): void {
    addDir(runDir);
    mockedReaddirSync.mockImplementationOnce(() => {
      throw Object.assign(new Error(`EACCES: permission denied, scandir '${runDir}'`), {
        code: "EACCES",
      });
    });
  }

  it("reports an unreadable run directory as a failure, not a missing run (#10430)", async () => {
    const runDir = `${RUNS_DIR}/nc-run-1`;
    mockUnreadableRunDir(runDir);

    await expect(actionRollback("nc-run-1")).rejects.toThrow(
      /Cannot read run directory for run nc-run-1: EACCES: permission denied/,
    );

    expect(mockExeca).not.toHaveBeenCalled();
    expect(store.has(`${runDir}/rolled_back`)).toBe(false);
  });

  it("reports an unreadable run directory from reconcile as a failure too (#10430)", async () => {
    const runDir = `${RUNS_DIR}/nc-run-1`;
    mockUnreadableRunDir(runDir);

    await expect(actionReconcile("nc-run-1")).rejects.toThrow(
      /Cannot read run directory for run nc-run-1: EACCES: permission denied/,
    );
  });
});
