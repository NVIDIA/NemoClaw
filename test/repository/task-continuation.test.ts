// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readCheckpoint,
  resumeCheckpoint,
  saveCheckpoint,
  type Checkpoint,
} from "../../tools/task-continuation/checkpoint.mts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "task-continuation-"));
  roots.push(root);
  const artifact = join(root, "validation.txt");
  writeFileSync(artifact, "passed");
  const file = join(root, "state.json");
  const state: Checkpoint = {
    version: 1,
    revision: 0,
    objective: "Upgrade dependency",
    scope: "One PR",
    authorization: "Publish draft; no merge",
    owner: "upgrade-owner",
    identities: { candidate: "candidate-a", base: "base-a" },
    nextAction: "Publish validated candidate",
    evidence: [{ path: artifact, sha256: createHash("sha256").update("passed").digest("hex") }],
    operations: [],
    limits: { "candidate-a/ci/transient": 1, "candidate-a/base-comparison": 1, publication: 2 },
  };
  saveCheckpoint(file, state, -1, state.owner);
  return { root, file, state, artifact };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("task checkpoint recovery", () => {
  it("retains completed validation after the worker terminates", () => {
    const { file, state } = fixture();
    const stopped = spawnSync(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"], {
      env: {},
    });
    expect(stopped.signal).toBe("SIGKILL");
    const resumed = spawnSync(
      process.execPath,
      [resolve("tools/task-continuation/checkpoint.mts"), "resume", file],
      { env: {}, encoding: "utf8" },
    );
    expect(resumed.status, resumed.stderr).toBe(0);
    const report = JSON.parse(resumed.stdout);
    expect(report.evidence).toEqual(state.evidence);
    expect(report.staleEvidence).toEqual([]);
    expect(report.resumeAction).toBe("recheck-mutable-state");
  });

  it.each(["branch", "pr", "retry"])(
    "recovers after interruption at %s without forgetting intent or evidence",
    (boundary) => {
      const { file, state, root } = fixture();
      const child = join(root, "interrupted.mts");
      const helper = resolve("tools/task-continuation/checkpoint.mts");
      const operation = {
        id: boundary,
        action: boundary,
        budget: boundary === "retry" ? "candidate-a/ci/transient" : "publication",
        state: "pending",
        observation: "",
      };
      writeFileSync(
        child,
        `import { writeFileSync } from 'node:fs';
      import { readCheckpoint, saveCheckpoint } from ${JSON.stringify(helper)};
      const file = ${JSON.stringify(file)};
      const state = readCheckpoint(file);
        state.operations.push(${JSON.stringify(operation)}); state.revision++;
        saveCheckpoint(file, state, 0, state.owner);
        writeFileSync(${JSON.stringify(join(root, "external-result"))}, 'published-once');
      process.kill(process.pid, 'SIGKILL');`,
      );
      const stopped = spawnSync(process.execPath, [child], { env: {}, encoding: "utf8" });
      expect(stopped.signal, stopped.stderr).toBe("SIGKILL");
      const resumed = spawnSync(process.execPath, [helper, "resume", file], {
        env: {},
        encoding: "utf8",
      });
      expect(resumed.status, resumed.stderr).toBe(0);
      const report = JSON.parse(resumed.stdout);
      expect(report.identities).toEqual(state.identities);
      expect(report.authorization).toBe(state.authorization);
      expect(report.staleEvidence).toEqual([]);
      expect(report.resumeAction).toBe("reconcile-external-state");
      expect(report.pendingOperationIds).toEqual([boundary]);
      expect(report.usage[operation.budget]).toBe(1);
      expect(readFileSync(join(root, "external-result"), "utf8")).toBe("published-once");
    },
  );

  it.each(["before", "after"])(
    "retains a complete checkpoint when killed %s atomic replacement",
    (boundary) => {
      const { file, root } = fixture();
      const helper = resolve("tools/task-continuation/checkpoint.mts");
      const child = join(root, "interrupted-save.mts");
      writeFileSync(
        child,
        `import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { readCheckpoint, saveCheckpoint } from ${JSON.stringify(helper)};
      const state = readCheckpoint(${JSON.stringify(file)}); state.revision++;
      state.operations.push({ id: 'push', action: 'Publish', budget: 'publication', state: 'pending', observation: '' });
      const rename = fs.renameSync;
      fs.renameSync = (...args) => {
        if (${JSON.stringify(boundary)} === 'before') process.kill(process.pid, 'SIGKILL');
        rename(...args);
        process.kill(process.pid, 'SIGKILL');
      };
      syncBuiltinESMExports();
      saveCheckpoint(${JSON.stringify(file)}, state, 0, state.owner);`,
      );
      const stopped = spawnSync(process.execPath, [child], { env: {}, encoding: "utf8" });
      expect(stopped.signal, stopped.stderr).toBe("SIGKILL");
      expect(readCheckpoint(file).revision).toBe(boundary === "before" ? 0 : 1);
      expect(resumeCheckpoint(file).resumeAction).toBe("reconcile-local-writer");
      // The child has terminated; clearing its lock is an explicit recovery action.
      rmSync(`${file}.lock`);
      expect(resumeCheckpoint(file).resumeAction).toBe(
        boundary === "before" ? "recheck-mutable-state" : "reconcile-external-state",
      );
    },
  );

  it("preserves an unexecuted intent after restart and requires external reconciliation", () => {
    const { file, state } = fixture();
    state.revision++;
    state.operations.push({
      id: "push",
      action: "Push candidate-a",
      budget: "publication",
      state: "pending",
      observation: "",
    });
    saveCheckpoint(file, state, 0, state.owner);
    const resumed = spawnSync(
      process.execPath,
      [resolve("tools/task-continuation/checkpoint.mts"), "resume", file],
      { env: {}, encoding: "utf8" },
    );
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout).resumeAction).toBe("reconcile-external-state");
  });

  it("transfers the same journal only with acknowledgement and rejects the outgoing writer", () => {
    const { file, state } = fixture();
    const next = { ...state, revision: 1, owner: "receiving-owner" };
    expect(() => saveCheckpoint(file, next, 0, state.owner)).toThrow(/acknowledgement/);
    saveCheckpoint(
      file,
      { ...next, handoff: "Receiving owner acknowledged in task message" },
      0,
      state.owner,
    );
    expect(() => saveCheckpoint(file, { ...next, revision: 2 }, 1, state.owner)).toThrow(/owner/);
    expect(resumeCheckpoint(file).owner).toBe("receiving-owner");
  });

  it("blocks a duplicate write until pending publication is reconciled", () => {
    const { file, state } = fixture();
    state.revision = 1;
    state.operations.push({
      id: "push",
      action: "Push candidate-a",
      budget: "publication",
      state: "pending",
      observation: "",
    });
    saveCheckpoint(file, state, 0, state.owner);
    const next = structuredClone(state);
    next.revision++;
    next.operations.push({
      id: "pr",
      action: "Create PR",
      budget: "publication",
      state: "pending",
      observation: "",
    });
    expect(() => saveCheckpoint(file, next, 1, state.owner)).toThrow(/Reconcile pending/);
    state.revision++;
    state.operations[0]!.state = "observed";
    state.operations[0]!.observation = "Remote branch equals candidate-a";
    saveCheckpoint(file, state, 1, state.owner);
    expect(resumeCheckpoint(file).pendingOperationIds).toEqual([]);
    next.revision = 3;
    next.operations[0] = state.operations[0]!;
    saveCheckpoint(file, next, 2, state.owner);
    expect(resumeCheckpoint(file).pendingOperationIds).toEqual(["pr"]);
  });

  it("retains spent retry budgets and distinguishes comparison trials", () => {
    const { file, state } = fixture();
    state.revision++;
    state.operations.push({
      id: "retry-1",
      action: "Retry CI",
      budget: "candidate-a/ci/transient",
      state: "pending",
      observation: "",
    });
    saveCheckpoint(file, state, 0, state.owner);
    expect(resumeCheckpoint(file).usage).toMatchObject({
      "candidate-a/ci/transient": 1,
      "candidate-a/base-comparison": 0,
    });
    const reset = structuredClone(state);
    reset.revision++;
    reset.operations = [];
    expect(() => saveCheckpoint(file, reset, 1, state.owner)).toThrow(/history/);
    reset.operations = state.operations;
    reset.limits["candidate-a/ci/transient"] = 2;
    expect(() => saveCheckpoint(file, reset, 1, state.owner)).toThrow(/budgets/);
    const retry = structuredClone(state);
    retry.revision++;
    retry.operations.push({ ...state.operations[0]!, id: "retry-2" });
    expect(() => saveCheckpoint(file, retry, 1, state.owner)).toThrow(/budget exhausted/);
  });

  it("rejects stale writers and leaves the last valid checkpoint intact", () => {
    const { file, state } = fixture();
    const previous = readFileSync(file, "utf8");
    expect(() => saveCheckpoint(file, { ...state, revision: 1 }, 0, "other-owner")).toThrow(
      /owner/,
    );
    expect(() => saveCheckpoint(file, { ...state, revision: 2 }, 1, state.owner)).toThrow(/Stale/);
    expect(() => saveCheckpoint(file, { ...state, version: 2 }, 0, state.owner)).toThrow(/schema/);
    writeFileSync(`${file}.lock`, "interrupted writer");
    expect(() => saveCheckpoint(file, { ...state, revision: 1 }, 0, state.owner)).toThrow();
    expect(resumeCheckpoint(file).resumeAction).toBe("reconcile-local-writer");
    expect(readFileSync(file, "utf8")).toBe(previous);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("invalidates changed or missing evidence while preserving the completed record", () => {
    const { file, artifact, state } = fixture();
    writeFileSync(artifact, "changed");
    expect(resumeCheckpoint(file).resumeAction).toBe("refresh-evidence");
    expect(resumeCheckpoint(file).staleEvidence).toEqual([artifact]);
    rmSync(artifact);
    expect(resumeCheckpoint(file).staleEvidence).toEqual([artifact]);
    expect(readCheckpoint(file)).toEqual(state);
  });
});
