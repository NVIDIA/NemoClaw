// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// CI-only dependency/transport smoke. Local deterministic provider; no external key/service.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
function argument(name: string) {
  const offset = process.argv.indexOf(name);
  assert(offset >= 0 && process.argv[offset + 1]);
  return path.resolve(process.argv[offset + 1]);
}
const app = argument("--app-root"),
  output = argument("--output");
assert(!fs.existsSync(output));
fs.mkdirSync(output, { recursive: true });
const state = path.join(output, "state"),
  workspace = path.join(output, "workspace");
fs.mkdirSync(state);
fs.mkdirSync(workspace);
const nonce = randomBytes(10).toString("hex"),
  marker = "COMPILED_TRANSPORT_" + nonce,
  token = "owned-local-provider-" + nonce;
const file = path.join(workspace, "controlled.txt");
const shellCommand =
  process.platform === "win32" ? `Write-Output 'SHELL_${nonce}'` : `printf '%s' 'SHELL_${nonce}'`;
const codeCommand =
  process.platform === "win32"
    ? `& '${process.execPath.replaceAll("'", "''")}' -e "process.stdout.write('CODE_${nonce}:'+String(6*7))"`
    : `'${process.execPath.replaceAll("'", "'\\''")}' -e 'process.stdout.write("CODE_${nonce}:"+String(6*7))'`;
const calls = [
  { name: "write", args: { path: file, content: nonce }, expect: "" },
  { name: "read", args: { path: file }, expect: nonce },
  { name: "exec", args: { command: shellCommand, timeout: 10 }, expect: "SHELL_" + nonce },
  { name: "exec", args: { command: codeCommand, timeout: 10 }, expect: "CODE_" + nonce + ":42" },
];
const observations: { path: string; model: string; toolResults: unknown[] }[] = [];
let serverError: unknown;
const server = http.createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      assert(bytes <= 1024 * 1024);
      chunks.push(chunk);
    }
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer " + token);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.model, "fixture");
    assert.equal(body.stream, true);
    const results = body.messages.filter((message: { role: string }) => message.role === "tool");
    observations.push({ path: request.url!, model: body.model, toolResults: results });
    assert(observations.length <= 5);
    if (results.length) {
      const prior = calls[results.length - 1];
      assert(prior);
      const text = JSON.stringify(results.at(-1));
      assert(!/"isError"\s*:\s*true/.test(text));
      if (prior.expect)
        assert(text.includes(prior.expect), "The actual tool output differs: " + prior.name);
    }
    const next = calls[results.length];
    const delta = next
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_" + results.length,
              type: "function",
              function: { name: next.name, arguments: JSON.stringify(next.args) },
            },
          ],
        }
      : { role: "assistant", content: marker };
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    for (const [payload, finish] of [
      [delta, null],
      [{}, next ? "tool_calls" : "stop"],
    ] as const)
      response.write(
        "data: " +
          JSON.stringify({
            id: "chatcmpl-" + nonce,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "fixture",
            choices: [{ index: 0, delta: payload, finish_reason: finish }],
          }) +
          "\n\n",
      );
    response.end("data: [DONE]\n\n");
  } catch (error) {
    serverError ??= error;
    response.writeHead(500);
    response.end("controlled provider rejected request");
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const config = {
  update: { checkOnStart: false, auto: { enabled: false } },
  models: {
    mode: "merge",
    providers: {
      nemoclawNative: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: token,
        api: "openai-completions",
        models: [
          {
            id: "fixture",
            name: "fixture",
            reasoning: false,
            input: ["text"],
            contextWindow: 131072,
            maxTokens: 4096,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      workspace,
      skipBootstrap: true,
      model: { primary: "nemoclawNative/fixture" },
      thinkingDefault: "off",
    },
    list: [{ id: "main", default: true }],
  },
  tools: { exec: { security: "full", ask: "off" } },
  gateway: { mode: "local" },
};
fs.writeFileSync(path.join(state, "openclaw.json"), JSON.stringify(config));
const entry = path.join(app, "openclaw-app.cjs"),
  driver = path.join(output, "driver.cjs");
fs.writeFileSync(
  driver,
  `const cp=require("node:child_process"),fs=require("node:fs"),Module=require("node:module");const loaded=new Set();const originalLoad=Module._load;Module._load=function(request,...rest){const value=originalLoad.call(this,request,...rest);if(request==="undici")loaded.add(value);return value;};for(const name of ["spawn","spawnSync","execFile","execFileSync"]){const original=cp[name];cp[name]=function(...args){if(/(?:npm|npx|pnpm|yarn|pip)(?:\\b|[-.])/i.test(JSON.stringify(args.slice(0,2)))){fs.writeFileSync(${JSON.stringify(path.join(output, "package-manager-attempt"))},name);throw Error("Unexpected package-manager invocation");}return original.apply(this,args);};}Module.syncBuiltinESMExports();process.on("exit",()=>fs.writeFileSync(${JSON.stringify(path.join(output, "undici-instances.json"))},JSON.stringify({instances:loaded.size})));const entry=${JSON.stringify(entry)};process.argv=[process.execPath,entry,"agent","--local","--agent","main","--session-id",${JSON.stringify(nonce)},"--message",${JSON.stringify("Run the controlled test tools then reply " + marker)},"--json"];require(entry).runCli(process.argv).catch(error=>{console.error(error);process.exitCode=1;});`,
);
const env: NodeJS.ProcessEnv = {};
for (const [key, value] of Object.entries(process.env))
  if (
    [
      "systemroot",
      "windir",
      "systemdrive",
      "comspec",
      "path",
      "pathext",
      "temp",
      "tmp",
      "programfiles",
      "programfiles(x86)",
      "os",
      "processor_architecture",
      "lang",
      "lc_all",
      "tmpdir",
    ].includes(key.toLowerCase())
  )
    env[key] = value;
Object.assign(env, {
  HOME: state,
  USERPROFILE: state,
  LOCALAPPDATA: state,
  APPDATA: state,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_HOME: state,
  OPENCLAW_COMPILED_ASSET_ROOT: app,
  OPENCLAW_NO_RESPAWN: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_NO_AUTO_UPDATE: "1",
  NODE_DISABLE_COMPILE_CACHE: "1",
});
const systemRoot = Object.entries(env).find(([name]) => name.toUpperCase() === "SYSTEMROOT")?.[1];
env.PATH = [
  path.dirname(process.execPath),
  ...(systemRoot ? [path.join(systemRoot, "System32"), systemRoot] : ["/usr/bin", "/bin"]),
].join(path.delimiter);
const child = spawn(process.execPath, [driver], {
  cwd: workspace,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "",
  stderr = "",
  closed = false;
const completion = new Promise<number | null>((resolve) =>
  child.once("close", (code) => {
    closed = true;
    resolve(code);
  }),
);
child.stdout!.on("data", (chunk) => {
  stdout += chunk;
  if (stdout.length > 2 * 1024 * 1024) child.kill();
});
child.stderr!.on("data", (chunk) => {
  stderr += chunk;
  if (stderr.length > 2 * 1024 * 1024) child.kill();
});
const timer = setTimeout(() => child.kill(), 90000);
let primary: unknown;
let code: number | null = null;
try {
  code = await completion;
  assert.equal(code, 0);
  if (serverError) throw serverError;
  assert.equal(observations.length, 5);
  const reply = JSON.parse(stdout);
  assert.equal(reply.payloads?.[0]?.text, marker);
  const transcript = fs
    .readFileSync(path.join(state, "agents", "main", "sessions", nonce + ".jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).message)
    .filter(Boolean);
  const results = transcript.filter((message) => message.role === "toolResult");
  assert.equal(results.length, calls.length);
  for (const [index, result] of results.entries()) {
    assert.equal(result.toolName, calls[index].name);
    assert.equal(result.isError, false);
    if (calls[index].name === "exec") {
      assert.equal(result.details?.status, "completed");
      assert.equal(result.details?.exitCode, 0);
    }
    if (calls[index].expect) assert(JSON.stringify(result.content).includes(calls[index].expect));
  }
  assert.equal(fs.readFileSync(file, "utf8"), nonce);
  assert(!fs.existsSync(path.join(output, "package-manager-attempt")));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(output, "undici-instances.json"), "utf8")).instances,
    1,
  );
} catch (error) {
  primary = error;
} finally {
  clearTimeout(timer);
  if (!closed) {
    child.kill();
    await completion;
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.writeFileSync(path.join(output, "stdout.log"), stdout.split(token).join("[REDACTED]"));
  fs.writeFileSync(path.join(output, "stderr.log"), stderr.split(token).join("[REDACTED]"));
  fs.writeFileSync(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        classification: "compiled-openclaw-local-provider-tool-control",
        verdict: primary ? "fail" : "pass",
        exitCode: code,
        requests: observations.length,
        tools: ["write", "read", "shell", "node-code"],
        singleUndiciInstance: fs.existsSync(path.join(output, "undici-instances.json"))
          ? JSON.parse(fs.readFileSync(path.join(output, "undici-instances.json"), "utf8"))
          : null,
        error: primary instanceof Error ? primary.message : null,
        localProvider: true,
        externalModelRequest: false,
        fixtureExecAuthorized: true,
        shippingPolicyQualified: false,
        containedWindowsQualified: false,
      },
      null,
      2,
    ) + "\n",
  );
}
if (primary) throw primary;
console.log(
  "PASS actual compiled local inference, file read/write, shell and Node code; one Undici instance.",
);
