// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execTimeout } from "../helpers/timeouts.ts";
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
    budgetIdentities: {
      "candidate-a/ci/transient": {
        candidate: "candidate-a",
        workflow: "ci",
        failureClass: "transient",
      },
      "candidate-a/base-comparison": {
        candidate: "candidate-a",
        workflow: "ci",
        failureClass: "comparison",
      },
      publication: {
        candidate: "candidate-a",
        workflow: "publication",
        failureClass: "initial",
      },
    },
  };
  saveCheckpoint(file, state, -1, state.owner);
  return { root, file, state, artifact };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("task checkpoint recovery", () => {
  it.each([
    "manualE2E.authorization.candidate-dispatch",
    "manualE2E.authorization.base-comparison",
    "manualE2E.candidate.authorization",
    "manualE2E.base.authorization",
  ])("preserves the saved dispatch grant at %s", (key) => {
    const { file, state } = fixture();
    const grant = JSON.stringify({ targets: "sandbox-operations", budgetKey: "publication" });
    const granted = structuredClone(state);
    granted.revision++;
    granted.identities[key] = grant;
    expect(() => saveCheckpoint(file, granted, 0, state.owner)).toThrow(/authorization evidence/);
    granted.authorization += "\nAccepted sandbox-operations dispatch in the fixture.";
    saveCheckpoint(file, granted, 0, state.owner);

    const changed = structuredClone(granted);
    changed.revision++;
    changed.authorization += "\nA later grant does not replace the earlier grant.";
    changed.identities[key] = JSON.stringify({ targets: "other-target", budgetKey: "publication" });
    expect(() => saveCheckpoint(file, changed, 1, state.owner)).toThrow(/authorization cannot/);
    delete changed.identities[key];
    expect(() => saveCheckpoint(file, changed, 1, state.owner)).toThrow(/authorization cannot/);
    expect(readCheckpoint(file)).toEqual(granted);

    const extended = structuredClone(granted);
    extended.revision++;
    extended.authorization += "\nAccepted a distinct candidate-b dispatch allowance.";
    extended.limits["candidate-b-dispatch"] = 1;
    extended.budgetIdentities!["candidate-b-dispatch"] = {
      candidate: "candidate-b",
      workflow: "e2e",
      failureClass: "initial",
    };
    extended.identities["manualE2E.authorization.candidate-b-dispatch"] = JSON.stringify({
      targets: "sandbox-operations",
      budgetKey: "candidate-b-dispatch",
    });
    saveCheckpoint(file, extended, 1, state.owner);
    expect(readCheckpoint(file)).toEqual(extended);
    expect(readCheckpoint(file).identities[key]).toBe(grant);
  });

  it("marks a symlink to matching evidence stale and preserves pending intent", () => {
    const { file, state, artifact, root } = fixture();
    const target = join(root, "matching-target.txt");
    writeFileSync(target, "passed");
    rmSync(artifact);
    symlinkSync(target, artifact);
    state.revision++;
    state.operations.push({
      id: "push",
      action: "Push",
      budget: "publication",
      state: "pending",
      observation: "",
    });
    saveCheckpoint(file, state, 0, state.owner);
    const report = resumeCheckpoint(file);
    expect(report.staleEvidence).toEqual([artifact]);
    expect(report.pendingOperationIds).toEqual(["push"]);
    expect(report.resumeAction).toBe("reconcile-external-state");
    expect(readFileSync(target, "utf8")).toBe("passed");
  });

  it("rejects multiple new pending intents in a single revision", () => {
    const { file, state } = fixture();
    const next = structuredClone(state);
    next.revision++;
    next.operations.push(
      { id: "push", action: "Push", budget: "publication", state: "pending", observation: "" },
      { id: "pr", action: "Create PR", budget: "publication", state: "pending", observation: "" },
    );
    expect(() => saveCheckpoint(file, next, 0, state.owner)).toThrow(
      /only one new operation intent/,
    );
    expect(readCheckpoint(file)).toEqual(state);
  });

  it.skipIf(process.platform === "win32")(
    "reports pending intent when evidence becomes a FIFO",
    () => {
      const { file, state, artifact } = fixture();
      state.revision++;
      state.operations.push({
        id: "push",
        action: "Push",
        budget: "publication",
        state: "pending",
        observation: "",
      });
      saveCheckpoint(file, state, 0, state.owner);
      rmSync(artifact);
      const fifo = spawnSync("mkfifo", [artifact], { encoding: "utf8", timeout: execTimeout() });
      expect(fifo.status, fifo.stderr).toBe(0);
      const resumed = spawnSync(
        process.execPath,
        [resolve("tools/task-continuation/checkpoint.mts"), "resume", file],
        {
          encoding: "utf8",
          env: {},
          timeout: execTimeout(),
          killSignal: "SIGKILL",
        },
      );
      expect(resumed.status, resumed.stderr).toBe(0);
      const report = JSON.parse(resumed.stdout);
      expect(report.staleEvidence).toEqual([artifact]);
      expect(report.pendingOperationIds).toEqual(["push"]);
      expect(report.resumeAction).toBe("reconcile-external-state");
    },
  );

  it("saves and resumes through a symlinked checkout path", () => {
    const { root, state } = fixture();
    const alias = join(root, "checkout");
    symlinkSync(resolve("."), alias, "dir");
    const helper = join(alias, "tools/task-continuation/checkpoint.mts");
    const file = join(root, "new-state.json");
    const saved = spawnSync(process.execPath, [helper, "save", file, "-1", state.owner], {
      input: JSON.stringify(state),
      encoding: "utf8",
      env: {},
    });
    expect(saved.status, saved.stderr).toBe(0);
    expect(readCheckpoint(file)).toEqual(state);
    const resumed = spawnSync(process.execPath, [helper, "resume", file], {
      encoding: "utf8",
      env: {},
    });
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout).revision).toBe(0);
  });

  it("rejects symlinks and directories without reading their contents", () => {
    const { root, file } = fixture();
    const alias = join(root, "state-link.json");
    symlinkSync(file, alias);
    expect(() => readCheckpoint(alias)).toThrow();
    expect(() => readCheckpoint(root)).toThrow(/regular file/);
    expect(readCheckpoint(file).revision).toBe(0);
  });

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

  it("rejects new retry budgets without additional authorization evidence", () => {
    const { file, state } = fixture();
    state.revision = 1;
    state.operations.push({
      id: "retry-1",
      action: "Retry CI for candidate-a",
      budget: "candidate-a/ci/transient",
      state: "pending",
      observation: "",
    });
    saveCheckpoint(file, state, 0, state.owner);
    state.revision = 2;
    state.operations[0]!.state = "observed";
    state.operations[0]!.observation = "Retry completed";
    saveCheckpoint(file, state, 1, state.owner);

    const renamed = structuredClone(state);
    renamed.revision++;
    renamed.limits["candidate-a/ci/transient-renamed"] = 1;
    renamed.budgetIdentities!["candidate-a/ci/transient-renamed"] = {
      ...state.budgetIdentities!["candidate-a/ci/transient"]!,
      failureClass: "different-transient",
    };
    renamed.operations.push({
      ...state.operations[0]!,
      id: "retry-2",
      budget: "candidate-a/ci/transient-renamed",
      state: "pending",
      observation: "",
    });
    expect(() => saveCheckpoint(file, renamed, 2, state.owner)).toThrow(/authorization evidence/);
    renamed.authorization += "\n   ";
    expect(() => saveCheckpoint(file, renamed, 2, state.owner)).toThrow(/authorization evidence/);
    const rewritten = structuredClone(state);
    rewritten.revision++;
    rewritten.authorization = "Replacement authority";
    expect(() => saveCheckpoint(file, rewritten, 2, state.owner)).toThrow(
      /authorization evidence cannot be rewritten/,
    );
    expect(readCheckpoint(file)).toEqual(state);
    expect(resumeCheckpoint(file).usage["candidate-a/ci/transient"]).toBe(1);
  });

  it("rejects a second key for a spent allowance even with appended authorization text", () => {
    const { file, state } = fixture();
    state.revision++;
    state.operations.push({
      id: "retry",
      action: "Retry CI",
      budget: "candidate-a/ci/transient",
      state: "pending",
      observation: "",
    });
    saveCheckpoint(file, state, 0, state.owner);
    state.revision++;
    state.operations[0]!.state = "observed";
    state.operations[0]!.observation = "Retry failed";
    saveCheckpoint(file, state, 1, state.owner);
    const renamed = structuredClone(state);
    renamed.revision++;
    renamed.authorization += "\nAnother allowance is claimed.";
    renamed.limits.alias = 1;
    renamed.budgetIdentities!.alias = { ...state.budgetIdentities!["candidate-a/ci/transient"]! };
    expect(() => saveCheckpoint(file, renamed, 2, state.owner)).toThrow(
      /Duplicate budget identity/,
    );
    const rewritten = structuredClone(state);
    rewritten.revision++;
    rewritten.budgetIdentities!["candidate-a/ci/transient"]!.failureClass = "renamed";
    expect(() => saveCheckpoint(file, rewritten, 2, state.owner)).toThrow(
      /identities cannot be rewritten/,
    );
    expect(readCheckpoint(file)).toEqual(state);
  });

  it("reads legacy records but requires an explicit budget identity migration before saving", () => {
    const { file, state } = fixture();
    const legacy = structuredClone(state);
    delete legacy.budgetIdentities;
    writeFileSync(file, JSON.stringify(legacy));
    expect(readCheckpoint(file)).toEqual(legacy);
    expect(() => saveCheckpoint(file, { ...legacy, revision: 1 }, 0, state.owner)).toThrow(
      /structured identity/,
    );
    expect(() => saveCheckpoint(file, { ...state, revision: 1 }, 0, state.owner)).toThrow(
      /authorization evidence/,
    );
    state.revision++;
    state.authorization +=
      "\nOwner checked existing allowances and bound their identities; no new allowance.";
    saveCheckpoint(file, state, 0, state.owner);
    expect(readCheckpoint(file).operations).toEqual(legacy.operations);
    expect(readCheckpoint(file).limits).toEqual(legacy.limits);
  });

  it("retains spent budgets when recorded authorization covers a new candidate allowance", () => {
    const { file, state } = fixture();
    state.revision = 1;
    state.operations.push({
      id: "retry-1",
      action: "Retry CI for candidate-a",
      budget: "candidate-a/ci/transient",
      state: "pending",
      observation: "",
    });
    saveCheckpoint(file, state, 0, state.owner);
    state.revision = 2;
    state.operations[0]!.state = "observed";
    state.operations[0]!.observation = "Retry completed";
    saveCheckpoint(file, state, 1, state.owner);
    const next = structuredClone(state);
    next.revision++;
    next.identities.candidate = "candidate-b";
    next.limits["candidate-b/ci/transient"] = 1;
    next.budgetIdentities!["candidate-b/ci/transient"] = {
      ...state.budgetIdentities!["candidate-a/ci/transient"]!,
      candidate: "candidate-b",
    };
    next.authorization +=
      "\nThe existing task authorizes one transient CI retry for the repaired candidate-b; see the recorded task request.";
    saveCheckpoint(file, next, 2, state.owner);
    expect(readCheckpoint(file).limits).toEqual({
      ...state.limits,
      "candidate-b/ci/transient": 1,
    });
    expect(readCheckpoint(file).authorization).toBe(next.authorization);
    expect(resumeCheckpoint(file).usage["candidate-a/ci/transient"]).toBe(1);
    expect(resumeCheckpoint(file).usage["candidate-b/ci/transient"]).toBe(0);
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
