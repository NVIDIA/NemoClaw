// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface ProofOptions {
  dist: string;
  nodeExecutable: string;
  timeoutMs: number;
  tmp: string;
}

export function runRealOpenClawWorkerProxyProof(options: ProofOptions): void {
  const worker = path.join(options.dist, "worker", "worker.mjs");
  const source = fs.readFileSync(worker, "utf8");
  const guardEntry = "async function fetchWithSsrFGuard(Ot){";
  if (source.split(guardEntry).length !== 2) {
    throw new Error("Expected one real worker guarded-fetch entry");
  }
  const proofModule = path.join(path.dirname(worker), `.nemoclaw-proxy-proof-${randomUUID()}.mjs`);
  const proofScript = path.join(options.tmp, "worker-proxy-proof.mjs");
  const stateDir = path.join(options.tmp, "worker-proxy-state");
  fs.mkdirSync(stateDir);
  // Observe guard inputs without replacing the guard or its callers. Export
  // the real tool from a temporary worker copy; prewarm skips the CLI loop.
  const observedSource = source.replace(
    guardEntry,
    `${guardEntry}globalThis.__nemoclawWorkerGuardObservations.push({url:Ot.url,mode:Ot.mode,policy:structuredClone(Ot.policy)});`,
  );
  fs.writeFileSync(
    proofModule,
    `${observedSource}\ninit_web_fetch(); export {createWebFetchTool};\n`,
  );
  fs.writeFileSync(
    proofScript,
    `import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
process.argv = [process.argv[0], process.argv[1], "--internal-worker-prewarm"];
globalThis.__nemoclawWorkerGuardObservations = [];
let requests = [];
const networkFetch = async (url, init) => {
  requests.push({ url, dispatcher: Boolean(init.dispatcher) });
  return new Response("real worker proxy proof", {
    status: 200, headers: { "content-type": "text/plain" },
  });
};
// The worker recognizes this as a network stub. Its real hostname checks,
// mode selection, dispatcher construction, and response handling still run.
networkFetch.mock = {};
globalThis.fetch = networkFetch;
const { createWebFetchTool } = await import(pathToFileURL(${JSON.stringify(proofModule)}));
const cases = [
  { id: "sandbox-host", sandbox: true, proxy: true, host: "host.openshell.internal", allowed: true },
  { id: "sandbox-public", sandbox: true, proxy: true, host: "public.example", allowed: true },
  { id: "sandbox-private", sandbox: true, proxy: true, host: "127.0.0.1", allowed: false },
  { id: "sandbox-strict-host", sandbox: true, proxy: false, host: "host.openshell.internal", allowed: false },
  { id: "sandbox-strict-public", sandbox: true, proxy: false, host: "public.example", allowed: true },
  { id: "outside-host", sandbox: false, proxy: true, host: "host.openshell.internal", allowed: false },
];
for (const scenario of cases) {
  if (scenario.sandbox) process.env.OPENSHELL_SANDBOX = "1";
  else delete process.env.OPENSHELL_SANDBOX;
  requests = [];
  globalThis.__nemoclawWorkerGuardObservations = [];
  const policy = { allowedHostnames: ["keep.example"], allowRfc2544BenchmarkRange: true };
  const url = "http://" + scenario.host + ":1234/" + scenario.id;
  const tool = createWebFetchTool({
    config: { tools: { web: { fetch: {
      enabled: true, useTrustedEnvProxy: scenario.proxy, cacheTtlMinutes: 0, ssrfPolicy: policy,
    } } } },
    lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
  });
  const invocation = () => tool.execute(scenario.id, { url, extractMode: "text" });
  if (scenario.allowed) {
    const result = await invocation();
    assert.equal(result.details.status, 200, scenario.id);
    assert.equal(result.details.finalUrl, url, scenario.id);
    assert.ok(result.details.text.includes("real worker proxy proof"), scenario.id);
  } else {
    await assert.rejects(invocation, { name: "SsrFBlockedError" }, scenario.id);
  }
  assert.deepEqual(requests, scenario.allowed ? [{ url, dispatcher: true }] : [], scenario.id);
  assert.deepEqual(globalThis.__nemoclawWorkerGuardObservations, [{
    url, mode: scenario.proxy ? "trusted_env_proxy" : "strict",
    policy: { ...policy, allowedHostnames: scenario.id === "sandbox-host"
      ? ["keep.example", "host.openshell.internal"] : ["keep.example"] },
  }], scenario.id);
  assert.deepEqual(policy, { allowedHostnames: ["keep.example"], allowRfc2544BenchmarkRange: true }, scenario.id);
}
console.log("real worker web_fetch proxy proof: 6 scenarios passed");
`,
  );
  try {
    const result = spawnSync(options.nodeExecutable, [proofScript], {
      encoding: "utf8",
      timeout: options.timeoutMs,
      // This package proof needs no contributor credentials or ambient config.
      env: {
        PATH: process.env.PATH,
        TMPDIR: options.tmp,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "",
      },
    });
    if (result.status !== 0) {
      throw new Error(
        `Real worker proxy proof failed: ${result.stderr || result.stdout || result.error}`,
      );
    }
    if (!result.stdout.includes("real worker web_fetch proxy proof: 6 scenarios passed")) {
      throw new Error("Real worker proxy proof did not report completion");
    }
  } finally {
    fs.rmSync(proofModule, { force: true });
    fs.rmSync(proofScript, { force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}
