// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  cacheEnvironment,
  cacheNamespace,
  runCompileCacheExperiment,
} from "./compile-cache-experiment.mts";

test("cache experiments replace case-insensitive inherited cache and Node preload controls", () => {
  const base = {
    Path: "owned",
    node_compile_cache: "host-cache",
    Node_Options: "--import host.mjs",
    NODE_DISABLE_COMPILE_CACHE: "1",
    NODE_V8_COVERAGE: "host-coverage",
    NODE_COMPILE_CACHE_PORTABLE: "1",
  };
  assert.deepEqual(cacheEnvironment(base, "guest-cache"), {
    Path: "owned",
    NODE_COMPILE_CACHE: "guest-cache",
  });
  assert.deepEqual(cacheEnvironment(base, null), {
    Path: "owned",
    NODE_DISABLE_COMPILE_CACHE: "1",
  });
  assert.equal(base.node_compile_cache, "host-cache");
});
test("cache namespace separates every runtime, Node and agent identity", () => {
  const first = cacheNamespace("a".repeat(64), "b".repeat(64), "openclaw");
  assert.match(first, /^[a-f0-9]{64}$/u);
  for (const [node, manifest, agent] of [
    ["c".repeat(64), "b".repeat(64), "openclaw"],
    ["a".repeat(64), "c".repeat(64), "openclaw"],
    ["a".repeat(64), "b".repeat(64), "pi"],
  ])
    assert.notEqual(cacheNamespace(node!, manifest!, agent!), first);
  assert.throws(() => cacheNamespace("a".repeat(40), "b".repeat(64), "openclaw"));
  assert.throws(() => cacheNamespace("a".repeat(64), "b".repeat(64), "../agent"));
});
test("actual Node enables and populates an isolated cache across six bounded command samples", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-cache-control-"));
  try {
    const entry = path.join(root, "fixture.mjs");
    fs.writeFileSync(entry, 'process.stdout.write("local\\n");\n');
    const receipt = await runCompileCacheExperiment({
      node: process.execPath,
      entry,
      home: root,
      environment: process.env,
      evidenceRoot: root,
      runtimeManifestSha256: "d".repeat(64),
    });
    assert.equal(receipt.passed, true);
    assert.equal(receipt.samples.length, 6);
    assert.equal(receipt.cacheHitAttributionVerified, false);
    assert.equal(receipt.osCold, false);
    assert.equal(receipt.runtimeBytesCopied, 0);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, "compile-cache-result.json"), "utf8")),
      receipt,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("a real failed command persists the first failed stage without proceeding to later samples", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-cache-failure-"));
  try {
    const entry = path.join(root, "fixture.mjs");
    fs.writeFileSync(entry, "process.exitCode=23;\n");
    await assert.rejects(
      runCompileCacheExperiment({
        node: process.execPath,
        entry,
        home: root,
        environment: process.env,
        evidenceRoot: root,
        runtimeManifestSha256: "e".repeat(64),
      }),
      /disabled-initial/u,
    );
    const receipt = JSON.parse(
      fs.readFileSync(path.join(root, "compile-cache-result.json"), "utf8"),
    );
    assert.equal(receipt.passed, false);
    assert.equal(receipt.samples.length, 1);
    assert.equal(receipt.samples[0].command.exitCode, 23);
    assert.match(receipt.error, /disabled-initial/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("actual Node parent and child cache observations retain the upstream-style respawn cost", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-cache-respawn-"));
  try {
    const entry = path.join(root, "fixture.mjs");
    fs.writeFileSync(
      entry,
      `import {spawnSync} from "node:child_process";
import path from "node:path";
if (process.env.NEMOCLAW_CACHE_FIXTURE_CHILD === "1") process.stdout.write("local\\n");
else {
  const env = {...process.env,NEMOCLAW_CACHE_FIXTURE_CHILD:"1"};
  if (env.NODE_COMPILE_CACHE) env.NODE_COMPILE_CACHE=path.join(env.NODE_COMPILE_CACHE,"package-version");
  const child=spawnSync(process.execPath,[...process.execArgv,process.argv[1]],{env,stdio:"inherit"});
  process.exitCode=child.status??1;
}
`,
    );
    const receipt = await runCompileCacheExperiment({
      node: process.execPath,
      entry,
      home: root,
      environment: process.env,
      evidenceRoot: root,
      runtimeManifestSha256: "f".repeat(64),
    });
    assert.equal(receipt.passed, true);
    assert.equal(receipt.upstreamRespawnOverheadIncluded, true);
    for (const sample of receipt.samples) {
      const states = sample.states as { processId: number; parentProcessId: number }[];
      assert.equal(states.length, 2);
      assert.equal(sample.preloadObservationCount, 2);
      assert.equal(states[1]!.parentProcessId, states[0]!.processId);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
