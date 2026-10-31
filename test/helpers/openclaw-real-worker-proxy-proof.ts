// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface ProofOptions {
  dist: string;
  archivedWorkerDirectory?: string;
  nodeExecutable: string;
  timeoutMs: number;
  tmp: string;
}

export function runRealOpenClawWorkerProxyProof(options: ProofOptions): void {
  runWorkerProxyProof(options, false);
  if (options.archivedWorkerDirectory) runWorkerProxyProof(options, true);
}

function runWorkerProxyProof(options: ProofOptions, splitGraph: boolean): void {
  const directory = options.archivedWorkerDirectory ?? path.join(options.dist, "worker");
  const worker = path.join(
    directory,
    options.archivedWorkerDirectory
      ? splitGraph
        ? "worker-chunk-D7mbn7lZ.mjs"
        : "sqlite-store.worker.mjs"
      : "worker.mjs",
  );
  const source = fs.readFileSync(worker, "utf8");
  const guardFile = splitGraph ? path.join(directory, "worker-chunk-CMCl78Z0.mjs") : worker;
  const guardSource = splitGraph ? fs.readFileSync(guardFile, "utf8") : source;
  const guardParameter = splitGraph ? "e" : "Ot";
  const guardEntry = `async function fetchWithSsrFGuard(${guardParameter}){`;
  if (guardSource.split(guardEntry).length !== 2) {
    throw new Error("Expected one real worker guarded-fetch entry");
  }
  const proofModule = path.join(path.dirname(worker), `.nemoclaw-proxy-proof-${randomUUID()}.mjs`);
  const proofScript = path.join(options.tmp, "worker-proxy-proof.mjs");
  const stateDir = path.join(options.tmp, "worker-proxy-state");
  fs.mkdirSync(stateDir);
  try {
    // Observe guard inputs without replacing the guard or its callers. Export
    // the real tool from a temporary worker copy; prewarm skips the CLI loop.
    const observedSource = guardSource.replace(
      guardEntry,
      `${guardEntry}globalThis.__nemoclawWorkerGuardObservations.push({url:${guardParameter}.url,mode:${guardParameter}.mode,policy:structuredClone(${guardParameter}.policy)});`,
    );
    if (splitGraph) {
      if (
        !source.includes("function createWebFetchTool(e){") ||
        !source.includes("Ok=e((()=>{te()")
      ) {
        throw new Error("Unreviewed archived web-fetch module initialization");
      }
      // The tool and its lazy web guard import this exact staged guard module.
      // Append exports and observations only; do not replace native guard logic.
      fs.writeFileSync(guardFile, `${observedSource}\nexport { assertExplicitProxyAllowed };\n`);
      fs.writeFileSync(
        proofModule,
        `${source}\nOk(); export { createWebFetchTool };\nexport { assertExplicitProxyAllowed } from "./${path.basename(guardFile)}";\n`,
      );
    } else {
      fs.writeFileSync(
        proofModule,
        `${observedSource}\ninit_web_fetch(); export {createWebFetchTool, assertExplicitProxyAllowed};\n`,
      );
    }
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
${splitGraph ? `await import(pathToFileURL(${JSON.stringify(path.join(directory, "worker.mjs"))}));` : ""}
const { createWebFetchTool, assertExplicitProxyAllowed } = await import(pathToFileURL(${JSON.stringify(proofModule)}));
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
    await assert.rejects(invocation, (error) => {
      assert.equal(error.name, "SsrFBlockedError", scenario.id + ": " + error.stack);
      return true;
    }, scenario.id);
  }
  assert.deepEqual(requests, scenario.allowed ? [{ url, dispatcher: true }] : [], scenario.id);
  assert.deepEqual(globalThis.__nemoclawWorkerGuardObservations, [{
    // The split module imports the patched strict-mode export, which selects
    // trusted proxy transport while retaining the caller's hostname policy.
    url, mode: ${splitGraph ? '"trusted_env_proxy"' : 'scenario.proxy ? "trusted_env_proxy" : "strict"'},
    policy: { ...policy, allowedHostnames: scenario.id === "sandbox-host"
      ? ["keep.example", "host.openshell.internal"] : ["keep.example"] },
  }], scenario.id);
  assert.deepEqual(policy, { allowedHostnames: ["keep.example"], allowRfc2544BenchmarkRange: true }, scenario.id);
}
// Supply root-file observations at the filesystem boundary. The real bundled
// guard, URL parser, ownership checks, and denial path remain in the call.
// CI runs without uid 0; these observations do not claim image ownership proof.
const getBuiltinModule = process.getBuiltinModule;
let trustedProxy = "http://10.200.0.1:3128\\n";
let fileUid = 0;
let closed = 0;
const proxyFs = {
  constants: getBuiltinModule("node:fs").constants,
  openSync(file, flags) {
    assert.equal(file, "/usr/local/share/nemoclaw/openclaw-proxy-url");
    assert.ok(flags & this.constants.O_NOFOLLOW);
    return 713;
  },
  fstatSync(fd) {
    assert.equal(fd, 713);
    return { isFile: () => true, uid: fileUid, gid: 0, mode: 0o100444, nlink: 1,
      size: Buffer.byteLength(trustedProxy), mtimeMs: 1, ctimeMs: 1 };
  },
  readSync(fd, bytes) {
    assert.equal(fd, 713);
    return Buffer.from(trustedProxy).copy(bytes);
  },
  closeSync(fd) { assert.equal(fd, 713); closed++; },
};
process.getBuiltinModule = (name) => name === "node:fs" ? proxyFs : getBuiltinModule(name);
process.env.OPENSHELL_SANDBOX = "1";
process.env.NEMOCLAW_PROXY_HOST = "attacker.example";
process.env.HTTP_PROXY = "http://attacker.example:3128";
try {
  const invoke = (proxyUrl) => assertExplicitProxyAllowed({ mode: "explicit-proxy", proxyUrl });
  await invoke("http://10.200.0.1:3128");
  for (const url of ["http://attacker.example:3128", "http://10.0.0.1:3128", "http://169.254.169.254:3128", "http://user:secret@10.200.0.1:3128", "http://10.200.0.1:3128/path"]) {
    await assert.rejects(invoke(url), /root-owned OpenShell proxy endpoint/);
  }
  trustedProxy = "http://custom.internal:3129\\n";
  await invoke("http://custom.internal:3129/");
  await assert.rejects(invoke("http://10.200.0.1:3128"), /root-owned OpenShell proxy endpoint/);
  fileUid = 1000;
  await assert.rejects(invoke("http://custom.internal:3129"), /root-owned OpenShell proxy endpoint/);
  assert.equal(closed, 9);
} finally {
  process.getBuiltinModule = getBuiltinModule;
}
console.log("real worker web_fetch proxy proof: 6 scenarios passed; 9 explicit-proxy checks passed");
${options.archivedWorkerDirectory ? "process.exit(0);" : ""}
`,
    );
    const arguments_ = options.archivedWorkerDirectory
      ? [
          "--input-type=module",
          "-e",
          `
      import { Worker } from "node:worker_threads";
      const worker = new Worker(${JSON.stringify(proofScript)}, { execArgv: [] });
      worker.on("error", (error) => { console.error(error.stack); process.exitCode = 1; });
      worker.on("exit", (code) => { if (code !== 0) process.exitCode = code; });
    `,
        ]
      : [proofScript];
    const result = spawnSync(options.nodeExecutable, arguments_, {
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
    if (splitGraph) fs.writeFileSync(guardFile, guardSource);
    fs.rmSync(proofModule, { force: true });
    fs.rmSync(proofScript, { force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}
