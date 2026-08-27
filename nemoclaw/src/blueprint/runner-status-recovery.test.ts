// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRunnerFsStore,
  createStdoutCapture,
  FAKE_HOME,
  inMemoryFsMethods,
} from "./runner-mock-fixtures.js";

const { store, addDir, addFile } = createRunnerFsStore();

vi.mock("node:os", () => ({ homedir: () => FAKE_HOME }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  const memory = inMemoryFsMethods(store, { spy: vi.fn });
  return {
    ...original,
    existsSync: memory.existsSync,
    readFileSync: memory.readFileSync,
    readdirSync: memory.readdirSync,
  };
});

const { actionStatus } = await import("./runner.js");
const stdoutCapture = createStdoutCapture();

describe("blueprint runner status recovery", () => {
  beforeEach(() => {
    store.clear();
    stdoutCapture.reset();
    vi.spyOn(process.stdout, "write").mockImplementation(stdoutCapture.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the maintainer recovery action for an incomplete policy transition (#9833)", () => {
    const rid = "nc-run-incomplete";
    const runDir = `${FAKE_HOME}/.nemoclaw/state/runs/${rid}`;
    addDir(runDir);
    addFile(
      `${runDir}/plan.json`,
      JSON.stringify({
        run_id: rid,
        policy_transition: {
          status: "incomplete",
          sandbox_name: "alpha",
          gateway: "nemoclaw",
          gateway_host: "127.0.0.1",
          gateway_port: 8080,
          expected_authority: "nemoclaw-managed",
          policy_addition_names: ["github"],
          target_policy_digest: "a".repeat(64),
        },
      }),
    );

    actionStatus(rid);

    expect(stdoutCapture.jsonOutput()).toMatchObject({
      run_id: rid,
      policy_transition: {
        status: "incomplete",
        reconciliation_required: true,
        reconciliation_action:
          "Do not retry `apply` or `rollback`. Ask a NemoClaw maintainer to call `actionReconcile(runId)` through the direct blueprint runner API for this exact run.",
      },
    });
  });
});
