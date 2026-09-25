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
  return { ...original, readdirSync: memory.readdirSync, writeFileSync: memory.writeFileSync };
});

const { actionReconcile, actionRollback } = await import("./runner.js");
const mockedFs = vi.mocked(await import("node:fs"));

const RUNS_DIR = `${FAKE_HOME}/.nemoclaw/state/runs`;

describe("blueprint runner run-directory readability", () => {
  beforeEach(() => {
    store.clear();
    mockExeca.mockReset();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  function mockUnreadableRunDir(runDir: string): void {
    addDir(runDir);
    mockedFs.readdirSync.mockImplementationOnce(() => {
      throw Object.assign(new Error(`EACCES: permission denied, scandir '${runDir}'`), {
        code: "EACCES",
      });
    });
  }

  it.each([
    ["rollback", actionRollback],
    ["reconcile", actionReconcile],
  ] as const)(
    "reports an unreadable run directory during %s without changing state (#10430)",
    async (_operation, action) => {
      const runDir = `${RUNS_DIR}/nc-run-1`;
      mockUnreadableRunDir(runDir);

      await expect(action("nc-run-1")).rejects.toThrow(
        /Cannot read run directory for run nc-run-1: EACCES: permission denied/,
      );

      expect(mockExeca).not.toHaveBeenCalled();
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    },
  );
});
