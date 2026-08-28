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
const { mockExeca } = vi.hoisted(() => ({ mockExeca: vi.fn() }));

vi.mock("node:os", () => ({ homedir: () => FAKE_HOME }));
vi.mock("execa", () => ({ execa: mockExeca }));
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

const { actionRollback, actionStatus } = await import("./runner.js");
const stdoutCapture = createStdoutCapture();

describe("blueprint runner status recovery", () => {
  beforeEach(() => {
    store.clear();
    mockExeca.mockReset();
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
        reconciliation_action: expect.stringMatching(
          /blueprint runner integration.*reconcile.*nc-run-incomplete.*no standalone/su,
        ),
      },
    });
  });

  it("reports blocked recovery for incomplete policy creation without claiming an unavailable cleanup action (#9833)", async () => {
    const rid = "nc-run-incomplete-create";
    const runDir = `${FAKE_HOME}/.nemoclaw/state/runs/${rid}`;
    const identity = "b".repeat(64);
    addDir(runDir);
    addFile(
      `${runDir}/plan.json`,
      JSON.stringify({
        run_id: rid,
        sandbox_name: "alpha",
        sandbox_created_by_apply: true,
        policy_creation_transition: {
          status: "incomplete",
          gateway: "nemoclaw",
          gateway_host: "127.0.0.1",
          gateway_port: 8080,
          sandbox_name: "alpha",
          lifecycle_generation: "11111111-1111-4111-8111-111111111111",
          sandbox_identity_fingerprint: identity,
        },
      }),
    );

    actionStatus(rid);

    expect(stdoutCapture.jsonOutput()).toMatchObject({
      run_id: rid,
      policy_creation_transition: {
        status: "incomplete",
        recovery_required: true,
        recovery_action: expect.stringContaining(
          "no safe automatic or manual cleanup action is currently supported",
        ),
        sandbox_identity_fingerprint: identity,
      },
    });
    const recovery = (
      stdoutCapture.jsonOutput() as {
        policy_creation_transition: { recovery_action: string };
      }
    ).policy_creation_transition.recovery_action;
    expect(recovery).toContain(rid);
    expect(recovery).toContain("nemoclaw");
    expect(recovery).toContain("alpha");
    expect(recovery).toContain("11111111-1111-4111-8111-111111111111");
    expect(recovery).toContain(identity);
    expect(recovery).toContain("Recovery is blocked");
    expect(recovery).not.toContain("perform identity-bound recovery");
    await expect(actionRollback(rid)).rejects.toThrow(/policy creation is incomplete/u);
    expect(mockExeca).not.toHaveBeenCalled();
  });
});
