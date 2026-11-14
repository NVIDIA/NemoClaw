// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  allPersonalComponentsPassed,
  schedulePersonalComponents,
} from "./probe-personal-workload.mts";

type Result = { component: string; passed: boolean; execution: { childClosed: boolean } };
const result = (component: string, passed = true, childClosed = true): Result => ({
  component,
  passed,
  execution: { childClosed },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("browser-first starts the unchanged browser alone, then the remaining three concurrently", async () => {
  const pending = new Map(
    ["python", "bash", "conpty", "browser"].map((name) => [name, deferred<Result>()]),
  );
  const calls: { component: string; timeout: number }[] = [];
  const diagnostics: string[] = [];
  const scheduled = schedulePersonalComponents(
    true,
    async (component, timeout) => {
      calls.push({ component, timeout });
      return pending.get(component)!.promise;
    },
    async (canonical) => {
      diagnostics.push(canonical.component);
      return "bash-observation";
    },
  );
  assert.deepEqual(calls, [{ component: "browser", timeout: 90_000 }]);
  assert.deepEqual(diagnostics, []);
  pending.get("browser")!.resolve(result("browser"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    { component: "browser", timeout: 90_000 },
    { component: "python", timeout: 30_000 },
    { component: "bash", timeout: 30_000 },
    { component: "conpty", timeout: 30_000 },
  ]);
  // Resolve in a different order; the retained component array remains standard.
  pending.get("conpty")!.resolve(result("conpty"));
  pending.get("bash")!.resolve(result("bash"));
  pending.get("python")!.resolve(result("python"));
  const completed = await scheduled;
  assert.deepEqual(
    completed.components.map((row) => row.component),
    ["python", "bash", "conpty", "browser"],
  );
  assert.deepEqual(diagnostics, ["bash"]);
  assert.equal(completed.bashDiagnostic, "bash-observation");
  assert.deepEqual(completed.scheduling, {
    mode: "browser-first",
    browserClosedBeforeOtherComponents: true,
    skippedComponents: [],
  });
  assert.equal(allPersonalComponentsPassed(completed.components), true);
});

test("unclosed browser prevents every successor and a partial result cannot pass", async () => {
  const calls: string[] = [];
  const browser = result("browser", false, false);
  const completed = await schedulePersonalComponents(
    true,
    async (component) => {
      calls.push(component);
      return browser;
    },
    async () => {
      assert.fail("Bash diagnostic must not run");
    },
  );
  assert.deepEqual(calls, ["browser"]);
  assert.deepEqual(completed.components, [browser]);
  assert.deepEqual(completed.scheduling.skippedComponents, ["python", "bash", "conpty"]);
  assert.equal(completed.scheduling.browserClosedBeforeOtherComponents, false);
  assert.equal(allPersonalComponentsPassed(completed.components), false);
  assert.equal(allPersonalComponentsPassed([result("browser")]), false);
  assert.equal(allPersonalComponentsPassed([]), false);
});

test("closed browser failure is preserved while all remaining component results are collected", async () => {
  const browser = result("browser", false);
  const calls: string[] = [];
  const completed = await schedulePersonalComponents(
    true,
    async (component) => {
      calls.push(component);
      return component === "browser" ? browser : result(component);
    },
    async () => "unchanged Bash diagnostic",
  );
  assert.deepEqual(calls, ["browser", "python", "bash", "conpty"]);
  assert.equal(completed.components[3], browser);
  assert.equal(allPersonalComponentsPassed(completed.components), false);
});

test("only exact true opts in; default launches all four before any result settles", async () => {
  for (const flag of [undefined, false, "true", 1]) {
    const waiting = deferred<Result>();
    const calls: { component: string; timeout: number }[] = [];
    const scheduled = schedulePersonalComponents(
      flag,
      async (component, timeout) => {
        calls.push({ component, timeout });
        await waiting.promise;
        return result(component);
      },
      async () => null,
    );
    assert.deepEqual(calls, [
      { component: "python", timeout: 30_000 },
      { component: "bash", timeout: 30_000 },
      { component: "conpty", timeout: 30_000 },
      { component: "browser", timeout: 90_000 },
    ]);
    waiting.resolve(result("released"));
    const completed = await scheduled;
    assert.equal(completed.scheduling.mode, "parallel");
    assert.equal(completed.scheduling.browserClosedBeforeOtherComponents, null);
    assert.equal(allPersonalComponentsPassed(completed.components), true);
  }
});
