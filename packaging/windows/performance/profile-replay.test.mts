// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer, request } from "node:http";
import { buffer } from "node:stream/consumers";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { stripTypeScriptTypes } from "node:module";
import {
  harvestReplay,
  makeDiagnosticReplay,
  matchesProfileChatNavigation,
} from "./profile-replay.mts";
import { assertDashboardReceipt } from "./profile-installed-openclaw.mts";

const original = process.env.NEMOCLAW_PROFILE_BASELINE_RUNNER;
test(
  "the exact f8 replay and generated contained program parse with all deltas recorded",
  { skip: !original },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-replay-source-"));
    try {
      const source = fs.readFileSync(original!, "utf8");
      const replay = makeDiagnosticReplay(source, root, path.join(root, "collector.mts"));
      assert(replay.changes.length >= 10);
      assert(replay.source.includes('"--cpu-prof"'));
      assert(replay.source.includes("OPENCLAW_GATEWAY_STARTUP_TRACE"));
      assert(replay.source.includes("profilingSandboxAbsent && profilingGatewayStopped"));
      assert(replay.source.includes("clearInterval(profilingBudget)"));
      const host = path.join(root, "replay.mts");
      fs.writeFileSync(host, replay.source);
      const checked = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", "--check", host],
        { encoding: "utf8" },
      );
      assert.equal(checked.status, 0, checked.stderr);
      const start = replay.source.indexOf("function gatewaySource()");
      const end = replay.source.indexOf("\nfunction resolveEdge()", start);
      assert(start >= 0 && end > start);
      const workload = new Function(
        replay.source.slice(start, end) + "\nreturn gatewaySource();",
      )();
      const contained = path.join(root, "contained.mjs");
      fs.writeFileSync(contained, workload);
      const parsed = spawnSync(process.execPath, ["--check", contained], { encoding: "utf8" });
      assert.equal(parsed.status, 0, parsed.stderr);
      assert(workload.includes("registryModule.c()"));
      assert.throws(() => makeDiagnosticReplay(source + "\n", root, host), /exact f8/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

function completed() {
  return {
    classification: "installed-nemoclaw-native-windows-openclaw-control-ui",
    verdict: "pass",
    turnCount: 3,
    onboardingSkipped: true,
    deterministicLocalModel: true,
    inferenceTransport: "contained-deterministic-model",
    sandboxDeleted: true,
    sandboxRegistryAbsent: true,
    gatewayStopped: true,
    qualificationRootsRemoved: true,
    turns: Array.from({ length: 3 }, (_, index) => ({
      expected: `NATIVE_WINDOWS_TURN_${index + 1}_OK`,
      visible: true,
    })),
  };
}
test("a returning process cannot replace the actual dashboard and cleanup receipt", () => {
  assert.doesNotThrow(() => assertDashboardReceipt(completed()));
  for (const key of [
    "sandboxDeleted",
    "sandboxRegistryAbsent",
    "gatewayStopped",
    "qualificationRootsRemoved",
  ])
    assert.throws(() => assertDashboardReceipt({ ...completed(), [key]: false }), /dashboard/u);
  assert.throws(() => assertDashboardReceipt({ ...completed(), turns: [] }), /dashboard/u);
  assert.throws(
    () => assertDashboardReceipt({ ...completed(), deterministicLocalModel: false }),
    /dashboard/u,
  );
});

test("harvest retains real CPU/event files after the producer exits and removes token literals", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-harvest-"));
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  fs.mkdirSync(source);
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--cpu-prof",
        "--cpu-prof-dir=" + source,
        "--trace-event-categories=v8,node.fs.sync",
        "--trace-event-file-pattern=" + path.join(source, "node-${pid}-${rotation}.json"),
        "-e",
        "require('node:fs').readFileSync(process.execPath); for(let i=0;i<100000;i++)Math.sqrt(i);",
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    fs.writeFileSync(
      path.join(source, "openclaw-startup.jsonl"),
      "startup trace: config.snapshot 1.0ms total=1.0ms CANARY_BROKER_TOKEN\n",
    );
    fs.writeFileSync(
      path.join(source, "active-plugins.json"),
      JSON.stringify({ registryAvailable: true, plugins: [] }),
    );
    await harvestReplay(source, output, true, ["CANARY_BROKER_TOKEN"]);
    const receipt = JSON.parse(fs.readFileSync(path.join(output, "harvest.json"), "utf8"));
    assert(receipt.complete);
    assert(receipt.producerStopped);
    assert(receipt.files.some((f: { path: string }) => f.path.endsWith(".cpuprofile")));
    assert(
      !fs
        .readFileSync(path.join(output, "openclaw-startup.jsonl"), "utf8")
        .includes("CANARY_BROKER_TOKEN"),
    );
    assert(
      fs
        .readFileSync(path.join(source, "openclaw-startup.jsonl"), "utf8")
        .includes("CANARY_BROKER_TOKEN"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const kind of ["active", "symbolic", "hardlink"] as const)
  test(`harvest refuses ${kind} producers/files`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-refusal-"));
    const source = path.join(root, "source");
    fs.mkdirSync(source);
    try {
      const outside = path.join(root, "outside.json");
      fs.writeFileSync(outside, "private fixture");
      if (kind === "symbolic") fs.symlinkSync(outside, path.join(source, "node-x.json"));
      if (kind === "hardlink") fs.linkSync(outside, path.join(source, "node-x.json"));
      await assert.rejects(harvestReplay(source, path.join(root, "output"), kind !== "active", []));
      assert.equal(fs.readFileSync(outside, "utf8"), "private fixture");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test(
  "the actual original and instrumented deterministic model handlers preserve HTTP streaming",
  { skip: !original },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-model-handler-"));
    try {
      const source = fs.readFileSync(original!, "utf8");
      const replay = makeDiagnosticReplay(source, root, path.join(root, "collector.mts"));
      for (const [mode, text] of [
        ["original", source],
        ["diagnostic", replay.source],
      ]) {
        const start = text.indexOf("function gatewaySource()");
        const end = text.indexOf("\nfunction resolveEdge()", start);
        const workload = new Function(text.slice(start, end) + "\nreturn gatewaySource();")();
        const handler = workload.slice(
          workload.indexOf("const sleep ="),
          workload.indexOf("const configDirectory ="),
        );
        const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
        const server = await new AsyncFunction(
          "createServer",
          "fs",
          "join",
          "qualification",
          "brokerTunnel",
          "modelPort",
          "modelToken",
          "modelId",
          "profilingRoot",
          "rejectProfilingBudget",
          handler + "\nreturn mock;",
        )(
          createServer,
          fs,
          path.join,
          true,
          null,
          0,
          "MODEL_FIXTURE",
          "native-preview",
          root,
          (error: Error) => {
            throw error;
          },
        );
        try {
          const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
            const req = request(
              {
                host: "127.0.0.1",
                port: server.address().port,
                path: "/v1/chat/completions",
                method: "POST",
                headers: {
                  authorization: "Bearer MODEL_FIXTURE",
                  "content-type": "application/json",
                },
              },
              (res) => {
                buffer(res).then(
                  (bytes) => resolve({ status: res.statusCode ?? 0, body: bytes.toString() }),
                  reject,
                );
              },
            );
            req.on("error", reject);
            req.end(
              JSON.stringify({
                model: "native-preview",
                stream: true,
                messages: [
                  { role: "user", content: "Reply exactly with NATIVE_WINDOWS_TURN_1_OK" },
                ],
              }),
            );
          });
          assert.equal(result.status, 200);
          assert(result.body.includes('"content":"NATIVE_WINDOWS_TURN_1_OK"'));
          assert(result.body.endsWith("data: [DONE]\n\n"));
          if (mode === "diagnostic") {
            const measured = JSON.parse(
              fs.readFileSync(path.join(root, "model-timing.jsonl"), "utf8"),
            );
            assert.equal(measured.realProviderLatency, false);
            assert.equal(measured.status, 200);
            assert(measured.elapsedMs >= 0);
            assert(!JSON.stringify(measured).includes("MODEL_FIXTURE"));
          }
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("the profiling chat gate accepts application session state only on its expected origin and path", () => {
  const expected = "http://127.0.0.1:51258/chat";
  assert.equal(matchesProfileChatNavigation(new URL(expected), expected), true);
  assert.equal(
    matchesProfileChatNavigation(new URL(expected + "?session=agent%3Amain%3Amain"), expected),
    true,
  );
  assert.equal(
    matchesProfileChatNavigation(
      new URL("http://127.0.0.1:51259/chat?session=agent%3Amain%3Amain"),
      expected,
    ),
    false,
  );
  assert.equal(
    matchesProfileChatNavigation(new URL("https://127.0.0.1:51258/chat"), expected),
    false,
  );
  assert.equal(
    matchesProfileChatNavigation(new URL("http://localhost:51258/chat"), expected),
    false,
  );
  assert.equal(
    matchesProfileChatNavigation(
      new URL("http://127.0.0.1:51258/launching.html?session=agent%3Amain%3Amain"),
      expected,
    ),
    false,
  );
  assert.equal(matchesProfileChatNavigation(new URL(expected + "/other"), expected), false);
});

test("the normal Windows qualifier preserves the expected chat origin and path with session queries", () => {
  const source = fs.readFileSync(
    new URL("../runtime/run-installed-native-web-ui.mts", import.meta.url),
    "utf8",
  );
  const match = source.match(
    /await page\.waitForURL\(\s*(\(url: URL\) => \{[\s\S]*?\n\s*\}),\s*\{ timeout: 30_000 \},?\s*\)/u,
  );
  assert(match, "the actual normal qualifier callback must be available");
  const callback = stripTypeScriptTypes("const predicate=" + match[1]);
  const accepts = new Function("openClawUrl", callback + ";return predicate;")(
    "http://127.0.0.1:51258",
  ) as (url: URL) => boolean;
  assert.equal(accepts(new URL("http://127.0.0.1:51258/chat?session=agent%3Amain%3Amain")), true);
  assert.equal(accepts(new URL("http://127.0.0.1:51258/chat")), true);
  assert.equal(accepts(new URL("http://127.0.0.1:51259/chat")), false);
  assert.equal(accepts(new URL("http://127.0.0.1:51258/launching.html")), false);
  assert.equal(accepts(new URL("https://127.0.0.1:51258/chat")), false);
  assert.equal(accepts(new URL("http://localhost:51258/chat")), false);
});
