// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Exercise the published compactor with controlled summaries, without model or hardware claims. */
export function runRealOpenClawCompactionRetryProof(options: {
  dist: string;
  nodeExecutable: string;
  compaction: Record<string, unknown> | undefined;
  timeoutMs: number;
}): void {
  const proofFile = path.join(options.dist, ".nemoclaw-compaction-retry-proof.mjs");
  fs.writeFileSync(proofFile, COMPACTION_RETRY_PROOF);
  const packageRoot = path.dirname(options.dist);
  const result = spawnSync(
    options.nodeExecutable,
    [proofFile, JSON.stringify({ compaction: options.compaction })],
    {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: options.timeoutMs,
      env: {
        PATH: process.env.PATH,
        HOME: packageRoot,
        OPENCLAW_STATE_DIR: path.join(packageRoot, ".compaction-proof-state"),
        NODE_ENV: "test",
        VITEST: "true",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  assert.match(result.stdout, /NEMOCLAW_COMPACTION_RETRY_PROOF=passed/);
}

const COMPACTION_RETRY_PROOF = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dist = path.dirname(process.argv[1]);
const files = fs.readdirSync(dist).filter((name) => /^builtin-openclaw(?:-.+)?\.js$/.test(name));
const modules = await Promise.all(files.map((file) => import(pathToFileURL(path.join(dist, file)).href)));
const factories = [...new Set(modules.flatMap((module) => Object.values(module).filter(
  (value) => typeof value === "function" && value.name === "buildEmbeddedExtensionFactories",
)))];
assert.equal(factories.length, 1, "one reviewed embedded extension factory");
const [buildFactories] = factories;
const testing = globalThis[Symbol.for("openclaw.compactionSafeguardTestApi")];
assert.equal(typeof buildFactories, "function");
assert.equal(typeof testing?.setSummarizeInStagesForTest, "function");
const { compaction } = JSON.parse(process.argv[2]);

const latestAsk = "Review the release checklist before publishing.";
const identifier = "abcdef1234567890";
const messages = [
  { role: "user", content: "Keep release identifier " + identifier + " and record the release checklist.", timestamp: 1 },
  { role: "assistant", content: [{ type: "text", text: "The release checklist is recorded." }], timestamp: 2 },
  { role: "user", content: latestAsk, timestamp: 3 },
  { role: "assistant", content: [{ type: "text", text: "I will review the release checklist before publishing." }], timestamp: 4 },
];
const validSummary = [
  "## Decisions", "Use the release checklist.",
  "## Open TODOs", "Review before publishing.",
  "## Constraints/Rules", "Keep the release identifier.",
  "## Pending user asks", latestAsk,
  "## Exact identifiers", identifier,
].join("\n");
const invalidSummary = "Incomplete summary without the required headings or release identifier.";

async function runScenario(mode, policy = compaction) {
  const controller = new AbortController();
  const instructions = [];
  const sessionManager = { getSessionId: () => mode, getBranch: () => [] };
  const originalMessages = structuredClone(messages);
  let hook;
  for (const factory of buildFactories({
    cfg: { agents: { defaults: { compaction: policy } } },
    sessionManager,
    model: { id: "qwen-test", provider: "inference", contextWindow: 32768, maxTokens: 4096 },
    provider: "inference", modelId: "qwen-test", contextTokenBudget: 32768,
  })) {
    factory({ on: (name, handler) => { if (name === "session_before_compact") hook = handler; } });
  }
  assert.equal(typeof hook, "function", "generated config selects the real safeguard");
  testing.setSummarizeInStagesForTest(async (request) => {
    instructions.push(request.customInstructions);
    if (mode === "cancel" && instructions.length === 2) {
      controller.abort(new Error("controlled caller cancellation"));
      controller.signal.throwIfAborted();
    }
    if (mode === "error" && instructions.length === 2) throw new Error("controlled regeneration failure");
    return instructions.length === 1 || mode === "invalid" ? invalidSummary : validSummary;
  });
  const operation = hook({
    preparation: {
      messagesToSummarize: messages, turnPrefixMessages: [], isSplitTurn: false,
      firstKeptEntryId: "retained", tokensBefore: 1000,
      settings: { reserveTokens: 4096 },
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    },
    signal: controller.signal,
  }, {
    sessionManager,
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-placeholder" }) },
  });
  let result;
  if (mode === "cancel") await assert.rejects(operation, /controlled caller cancellation/);
  else result = await operation;
  assert.deepEqual(messages, originalMessages, "the input transcript is unchanged");
  return { result, instructions };
}

try {
  const baseline = await runScenario("recover", { ...compaction, qualityGuard: { enabled: true, maxRetries: 0 } });
  assert.equal(baseline.instructions.length, 1);
  assert.deepEqual(baseline.result, { cancel: true });

  const recovered = await runScenario("recover");
  assert.equal(recovered.instructions.length, 2, "one corrective generation");
  assert.match(recovered.instructions[1], /missing_section/);
  assert.match(recovered.instructions[1], /missing_identifiers/);
  assert.ok(recovered.result.compaction.summary.includes(identifier));
  assert.ok(recovered.result.compaction.summary.includes(latestAsk));
  assert.match(recovered.result.compaction.summary, /Recent turns preserved verbatim/);

  for (const mode of ["invalid", "error"]) {
    const rejected = await runScenario(mode);
    assert.equal(rejected.instructions.length, 2, "retry exhaustion is bounded");
    assert.deepEqual(rejected.result, { cancel: true }, "failed summaries never produce a compaction result");
  }

  const cancelled = await runScenario("cancel");
  assert.equal(cancelled.instructions.length, 2);
  assert.equal(cancelled.result, undefined);
  console.log("NEMOCLAW_COMPACTION_RETRY_PROOF=passed");
} finally {
  testing.setSummarizeInStagesForTest();
}
`;
