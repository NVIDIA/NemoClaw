// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");
const NEMOTRON_FIX_SOURCE = path.join(
  import.meta.dirname,
  "..",
  "nemoclaw-blueprint",
  "scripts",
  "nemotron-inference-fix.js",
);

function extractStartScriptHeredoc(src, marker) {
  const heredoc = src.match(new RegExp(`<<'${marker}'\\n([\\s\\S]*?)\\n${marker}`));
  if (heredoc) return heredoc[1];
  if (marker === "NEMOTRON_FIX_EOF") return fs.readFileSync(NEMOTRON_FIX_SOURCE, "utf-8");
  throw new Error(`Expected ${marker} heredoc in scripts/nemoclaw-start.sh`);
}

describe("NVIDIA endpoint inference fix preload (#1193, #2051, #4063)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("entrypoint writes the preload and registers it in NODE_OPTIONS", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-nemotron-entrypoint-"));
    const preloadPath = path.join(tempDir, "nemotron-fix.js");
    const start = src.indexOf("# NVIDIA endpoint model-specific inference parameter injection");
    const end = src.indexOf("# mDNS / ciao network interface guard", start);
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(
        "Expected NVIDIA endpoint preload entrypoint block in scripts/nemoclaw-start.sh",
      );
    }
    const block = src
      .slice(start, end)
      .replaceAll("/tmp/nemoclaw-nemotron-inference-fix.js", preloadPath)
      .replace(
        '_NEMOTRON_FIX_SOURCE="/usr/local/lib/nemoclaw/preloads/nemotron-inference-fix.js"',
        `_NEMOTRON_FIX_SOURCE=${JSON.stringify(NEMOTRON_FIX_SOURCE)}`,
      );
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
      "NODE_OPTIONS='--require /already-loaded.js'",
      block,
      "printf 'NODE_OPTIONS=%s\\n' \"$NODE_OPTIONS\"",
      "printf 'SCRIPT=%s\\n' \"$_NEMOTRON_FIX_SCRIPT\"",
    ].join("\n");
    const wrapperPath = path.join(tempDir, "run.sh");

    try {
      fs.writeFileSync(wrapperPath, wrapper, { mode: 0o700 });
      const result = spawnSync("bash", [wrapperPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`SCRIPT=${preloadPath}`);
      expect(result.stdout).toContain("--require /already-loaded.js");
      expect(result.stdout).toContain(`--require ${preloadPath}`);
      const stat = fs.statSync(preloadPath);
      expect(stat.isFile()).toBe(true);
      expect((stat.mode & 0o777).toString(8)).toBe("444");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preload injects model-specific chat_template_kwargs and preserves other requests", () => {
    const preload = extractStartScriptHeredoc(src, "NEMOTRON_FIX_EOF");
    const harness = `
const http = require('http');
const https = require('https');
const records = [];
function installStub(mod) {
  mod.request = function (options) {
    const record = { options, writes: [], headers: {}, removed: [] };
    records.push(record);
    return {
      write(chunk) {
        record.writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        return true;
      },
      end(cb) {
        if (typeof cb === 'function') cb();
        return true;
      },
      getHeader(name) { return record.headers[name]; },
      setHeader(name, value) { record.headers[name] = value; },
      removeHeader(name) { record.removed.push(name); delete record.headers[name]; },
    };
  };
}
installStub(http);
installStub(https);
${preload}
function send(mod, options, body) {
  const req = mod.request(options);
  req.write(body);
  req.end();
}
send(http, { method: 'POST', path: '/v1/chat/completions' }, JSON.stringify({ model: 'NVIDIA/NEMOTRON-4', messages: [] }));
send(https, { method: 'POST', path: '/v1/chat/completions' }, JSON.stringify({ model: 'deepseek-ai/deepseek-v4-pro', messages: [], chat_template_kwargs: { existing: true, thinking: true } }));
send(https, { method: 'POST', path: '/v1/chat/completions' }, JSON.stringify({ model: 'moonshotai/kimi-k2.6', messages: [], chat_template_kwargs: { existing: true, thinking: true } }));
send(https, { method: 'POST', path: '/v1/chat/completions' }, JSON.stringify({ model: 'other-model', messages: [] }));
send(http, { method: 'POST', path: '/v1/chat/completions' }, '{not json');
send(http, { method: 'GET', path: '/v1/chat/completions' }, JSON.stringify({ model: 'nemotron' }));
send(http, { method: 'POST', path: '/v1/chat/completions' }, JSON.stringify({ model: 'deepseek-ai/deepseek-v4-flash', messages: [] }));
console.log(JSON.stringify(records));
`;

    const result = spawnSync(process.execPath, ["-e", harness], {
      encoding: "utf-8",
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    const records = JSON.parse(result.stdout.trim());
    const nemotronBody = JSON.parse(records[0].writes[0]);
    expect(nemotronBody.chat_template_kwargs.force_nonempty_content).toBe(true);
    expect(nemotronBody.chat_template_kwargs.thinking).toBeUndefined();
    expect(records[0].removed).toContain("content-length");
    expect(Number(records[0].headers["Content-Length"])).toBeGreaterThan(0);

    const deepSeekBody = JSON.parse(records[1].writes[0]);
    expect(deepSeekBody.chat_template_kwargs).toEqual({
      existing: true,
      thinking: false,
    });
    expect(deepSeekBody.chat_template_kwargs.force_nonempty_content).toBeUndefined();
    expect(records[1].removed).toContain("content-length");
    expect(Number(records[1].headers["Content-Length"])).toBeGreaterThan(0);

    const kimiBody = JSON.parse(records[2].writes[0]);
    expect(kimiBody.chat_template_kwargs).toEqual({
      existing: true,
      thinking: false,
    });
    expect(kimiBody.chat_template_kwargs.force_nonempty_content).toBeUndefined();
    expect(records[2].removed).toContain("content-length");
    expect(Number(records[2].headers["Content-Length"])).toBeGreaterThan(0);

    const otherBody = JSON.parse(records[3].writes[0]);
    expect(otherBody.chat_template_kwargs).toBeUndefined();
    expect(records[4].writes[0]).toBe("{not json");
    expect(JSON.parse(records[5].writes[0]).chat_template_kwargs).toBeUndefined();
    expect(JSON.parse(records[6].writes[0]).chat_template_kwargs).toBeUndefined();
  });

  it("preload also injects model-specific kwargs for stubbed fetch requests", () => {
    const preload = extractStartScriptHeredoc(src, "NEMOTRON_FIX_EOF");
    const harness = `
const records = [];
globalThis.fetch = async function (input, init) {
  records.push({
    input,
    body: init && init.body,
    headers: init && init.headers,
    method: init && init.method,
  });
  return new Response('{}', { status: 200 });
};
${preload}
async function main() {
  await fetch('https://inference.local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '999' },
    body: JSON.stringify({
      model: 'deepseek-ai/deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
  await fetch('https://inference.local/v1/chat/completions', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', 'content-length': '999' }),
    body: JSON.stringify({
      model: 'moonshotai/kimi-k2.6',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
  await fetch('https://inference.local/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '999' },
    body: JSON.stringify({
      model: 'other-model',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
  console.log(JSON.stringify(records.map((record) => ({
    method: record.method,
    body: record.body,
    contentLength:
      record.headers instanceof Headers
        ? record.headers.get('content-length')
        : (record.headers && record.headers['content-length']) || null,
  }))));
}
main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
`;

    const result = spawnSync(process.execPath, ["-e", harness], {
      encoding: "utf-8",
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    const records = JSON.parse(result.stdout.trim());
    expect(JSON.parse(records[0].body).chat_template_kwargs).toEqual({ thinking: false });
    expect(records[0].contentLength).toBeNull();
    expect(JSON.parse(records[1].body).chat_template_kwargs).toEqual({ thinking: false });
    expect(records[1].contentLength).toBeNull();
    expect(JSON.parse(records[2].body).chat_template_kwargs).toBeUndefined();
    expect(records[2].contentLength).toBe("999");
  });

  it("preload mutates real Node fetch/undici requests and refreshes Content-Length", () => {
    const preload = extractStartScriptHeredoc(src, "NEMOTRON_FIX_EOF");
    const harness = `
const http = require('http');
const records = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    records.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
function listen() {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}
function close() {
  return new Promise((resolve) => server.close(resolve));
}
${preload}
async function postJson(url, payload, headers) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error('unexpected response ' + response.status);
}
async function main() {
  await listen();
  try {
    const url = 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions';
    await postJson(url, {
      model: 'deepseek-ai/deepseek-v4-pro',
      messages: [{ role: 'user', content: 'ping' }],
    }, { 'content-type': 'application/json', 'content-length': '999' });
    await postJson(url, {
      model: 'moonshotai/kimi-k2.6',
      messages: [{ role: 'user', content: 'ping' }],
    }, { 'content-type': 'application/json', 'content-length': '999' });
    await postJson(url, {
      model: 'other-model',
      messages: [{ role: 'user', content: 'ping' }],
    }, { 'content-type': 'application/json' });
    // #4851: Ultra 550B injection over the real fetch/undici path
    await postJson(url, {
      model: 'nvidia/nemotron-3-ultra-550b-a55b',
      messages: [{ role: 'user', content: 'Create a file and run it.' }],
    }, { 'content-type': 'application/json', 'content-length': '999' });
    console.log(JSON.stringify(records));
  } finally {
    await close();
  }
}
main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
`;

    const result = spawnSync(process.execPath, ["-e", harness], {
      encoding: "utf-8",
      timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    const records = JSON.parse(result.stdout.trim());
    expect(records).toHaveLength(4);

    const deepSeekBody = JSON.parse(records[0].body);
    expect(deepSeekBody.chat_template_kwargs).toEqual({ thinking: false });
    expect(records[0].headers["content-length"]).toBe(String(Buffer.byteLength(records[0].body)));
    expect(records[0].headers["content-length"]).not.toBe("999");

    const kimiBody = JSON.parse(records[1].body);
    expect(kimiBody.chat_template_kwargs).toEqual({ thinking: false });
    expect(records[1].headers["content-length"]).toBe(String(Buffer.byteLength(records[1].body)));
    expect(records[1].headers["content-length"]).not.toBe("999");

    const otherBody = JSON.parse(records[2].body);
    expect(otherBody.chat_template_kwargs).toBeUndefined();

    // #4851: Ultra 550B injection takes the fetch/undici path too, system
    // message is prepended and Content-Length is refreshed for the larger body
    const ultraBody = JSON.parse(records[3].body);
    expect(ultraBody.messages[0].role).toBe("system");
    expect(ultraBody.messages[0].content).toMatch(/do not have tools/i);
    expect(ultraBody.messages[1]).toEqual({
      role: "user",
      content: "Create a file and run it.",
    });
    expect(records[3].headers["content-length"]).toBe(String(Buffer.byteLength(records[3].body)));
    expect(records[3].headers["content-length"]).not.toBe("999");
  });

  it("preload injects a tool-less system prompt for Ultra 550B without overriding caller intent (#4851)", () => {
    const preload = extractStartScriptHeredoc(src, "NEMOTRON_FIX_EOF");
    const harness = `
const http = require('http');
const records = [];
http.request = function (options) {
  const record = { options, writes: [], headers: {}, removed: [] };
  records.push(record);
  return {
    write(chunk) {
      record.writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return true;
    },
    end(cb) {
      if (typeof cb === 'function') cb();
      return true;
    },
    getHeader(name) { return record.headers[name]; },
    setHeader(name, value) { record.headers[name] = value; },
    removeHeader(name) { record.removed.push(name); delete record.headers[name]; },
  };
};
${preload}
function send(body) {
  const req = http.request({ method: 'POST', path: '/v1/chat/completions' });
  req.write(body);
  req.end();
}
// case 0: Ultra 550B, no system, no tools — expect injected system message
send(JSON.stringify({
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages: [{ role: 'user', content: 'Create a file and run it.' }],
}));
// case 1: Ultra 550B, existing system message — expect NO injection
send(JSON.stringify({
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages: [
    { role: 'system', content: 'You are pirate-themed.' },
    { role: 'user', content: 'hi' },
  ],
}));
// case 2: Ultra 550B, with tools — expect NO injection (model should use tools)
send(JSON.stringify({
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ type: 'function', function: { name: 'exec', parameters: {} } }],
}));
// case 3: non-matching Nemotron, no system, no tools — expect NO injection
send(JSON.stringify({
  model: 'nvidia/nemotron-3-super-120b-a12b',
  messages: [{ role: 'user', content: 'hi' }],
}));
// case 4: Ultra 550B with system message at non-zero index — expect NO injection
send(JSON.stringify({
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages: [
    { role: 'user', content: 'prior turn' },
    { role: 'assistant', content: 'ok' },
    { role: 'system', content: 'mid-conversation system message' },
    { role: 'user', content: 'hi again' },
  ],
}));
// case 5: Ultra 550B with non-execution tools only (toolSearch, web fetch) —
// expect INJECTION because these tools can't write files or run commands,
// matching the practical end-user config from #4851's repro
send(JSON.stringify({
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [
    { type: 'function', function: { name: 'tool_search', parameters: {} } },
    { type: 'function', function: { name: 'web_fetch', parameters: {} } },
    { type: 'function', function: { name: 'tool_describe', parameters: {} } },
  ],
}));
// case 6: Ultra 550B with mixed tools (search + bash_execute) — expect NO
// injection because execution-capable tool is present
send(JSON.stringify({
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [
    { type: 'function', function: { name: 'tool_search', parameters: {} } },
    { type: 'function', function: { name: 'bash_execute', parameters: {} } },
  ],
}));
// case 7: Ultra 550B with tools whose names contain broad tokens
// (create/run/save/command) but are NOT actually execution-capable —
// expect INJECTION because the tight allowlist rejects these false
// positives (would have been swallowed by a substring regex match).
send(JSON.stringify({
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [
    { type: 'function', function: { name: 'create_ticket', parameters: {} } },
    { type: 'function', function: { name: 'run_query', parameters: {} } },
    { type: 'function', function: { name: 'save_search', parameters: {} } },
    { type: 'function', function: { name: 'command_palette', parameters: {} } },
  ],
}));
// case 8: Ultra 550B with write_file specifically — expect NO injection
send(JSON.stringify({
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ type: 'function', function: { name: 'write_file', parameters: {} } }],
}));
// case 9: Ultra 550B with bare 'write'/'edit'/'notebook_edit' (mirrors
// nemoclaw/src/index.ts:WRITE_TOOL_NAMES) — expect NO injection
send(JSON.stringify({
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [
    { type: 'function', function: { name: 'write', parameters: {} } },
    { type: 'function', function: { name: 'edit', parameters: {} } },
    { type: 'function', function: { name: 'notebook_edit', parameters: {} } },
  ],
}));
// case 10: Ultra 550B with compact-catalog tool_call wrapper — expect NO
// injection because tool_call can dispatch to real exec/write tools.
send(JSON.stringify({
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [
    { type: 'function', function: { name: 'tool_search', parameters: {} } },
    { type: 'function', function: { name: 'tool_describe', parameters: {} } },
    { type: 'function', function: { name: 'tool_call', parameters: {} } },
  ],
}));
// case 11: top-level tool.name shape (no nested .function) — CodeRabbit nit.
// Some callers send { name, parameters } at the top level instead of the
// OpenAI nested function shape.
send(JSON.stringify({
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'bash_execute', parameters: {} }],
}));
console.log(JSON.stringify(records));
`;

    const result = spawnSync(process.execPath, ["-e", harness], {
      encoding: "utf-8",
      timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    const records = JSON.parse(result.stdout.trim());
    expect(records).toHaveLength(12);

    // case 0: system message injected at position 0
    const ultraBare = JSON.parse(records[0].writes.join(""));
    expect(ultraBare.messages[0].role).toBe("system");
    expect(ultraBare.messages[0].content).toMatch(/do not have tools/i);
    expect(ultraBare.messages[1]).toEqual({
      role: "user",
      content: "Create a file and run it.",
    });
    // kwargs still applied (Nemotron rule)
    expect(ultraBare.chat_template_kwargs).toEqual({ force_nonempty_content: true });

    // case 1: caller's system message preserved, no injection prepended
    const ultraWithSystem = JSON.parse(records[1].writes.join(""));
    expect(ultraWithSystem.messages).toHaveLength(2);
    expect(ultraWithSystem.messages[0].content).toBe("You are pirate-themed.");

    // case 2: execution-capable tool (exec) present, no injection
    const ultraWithExecTool = JSON.parse(records[2].writes.join(""));
    expect(ultraWithExecTool.messages).toHaveLength(1);
    expect(ultraWithExecTool.messages[0].role).toBe("user");

    // case 3: non-matching Nemotron model, no injection
    const superModel = JSON.parse(records[3].writes.join(""));
    expect(superModel.messages).toHaveLength(1);
    expect(superModel.messages[0].role).toBe("user");

    // case 4: system message at non-zero index — caller intent preserved
    const ultraMidSystem = JSON.parse(records[4].writes.join(""));
    expect(ultraMidSystem.messages).toHaveLength(4);
    expect(ultraMidSystem.messages[0].role).toBe("user");
    expect(ultraMidSystem.messages[2].role).toBe("system");

    // case 5: non-execution tools only (toolSearch + web fetch) — injection
    // STILL fires because these tools can't satisfy the user's exec request.
    // This is the practical end-user config from #4851's repro.
    const ultraWithSearchTools = JSON.parse(records[5].writes.join(""));
    expect(ultraWithSearchTools.messages[0].role).toBe("system");
    expect(ultraWithSearchTools.messages[0].content).toMatch(/do not have tools/i);
    expect(ultraWithSearchTools.tools).toHaveLength(3);

    // case 6: mixed tools (search + bash_execute) — no injection because
    // an execution-capable tool is present
    const ultraWithMixedTools = JSON.parse(records[6].writes.join(""));
    expect(ultraWithMixedTools.messages).toHaveLength(1);
    expect(ultraWithMixedTools.messages[0].role).toBe("user");

    // case 7: harmless business-tool names with broad tokens (create/run/
    // save/command) — injection STILL fires; tight allowlist rejects false
    // positives that a substring regex would have swallowed
    const ultraWithBusinessTools = JSON.parse(records[7].writes.join(""));
    expect(ultraWithBusinessTools.messages[0].role).toBe("system");
    expect(ultraWithBusinessTools.messages[0].content).toMatch(/do not have tools/i);
    expect(ultraWithBusinessTools.tools).toHaveLength(4);

    // case 8: write_file — explicit canonical exec tool, no injection
    const ultraWithWriteFile = JSON.parse(records[8].writes.join(""));
    expect(ultraWithWriteFile.messages).toHaveLength(1);
    expect(ultraWithWriteFile.messages[0].role).toBe("user");

    // case 9: bare write/edit/notebook_edit (mirrors WRITE_TOOL_NAMES) — no injection
    const ultraWithBareWriteEdit = JSON.parse(records[9].writes.join(""));
    expect(ultraWithBareWriteEdit.messages).toHaveLength(1);
    expect(ultraWithBareWriteEdit.messages[0].role).toBe("user");

    // case 10: tool_call wrapper present — no injection because it can
    // dispatch to real exec/write tools
    const ultraWithToolCall = JSON.parse(records[10].writes.join(""));
    expect(ultraWithToolCall.messages).toHaveLength(1);
    expect(ultraWithToolCall.messages[0].role).toBe("user");

    // case 11: top-level tool.name shape (no nested .function) — predicate
    // handles both shapes per OpenAI / non-OpenAI caller variance
    const ultraTopLevelName = JSON.parse(records[11].writes.join(""));
    expect(ultraTopLevelName.messages).toHaveLength(1);
    expect(ultraTopLevelName.messages[0].role).toBe("user");
  });

  it("preload pins path+model as the intended scope boundary (#4851)", () => {
    // Contract test: the Ultra 550B tool-less injection is scoped by HTTP
    // path (/v1/chat/completions) + model regex, not by destination host.
    // This preload runs inside NemoClaw-managed sandboxes where the only
    // chat-completions destination is the inference.local route bound to
    // NVIDIA Build. The path+model boundary is the intentional contract.
    // This test pins that contract so a future change toward narrower
    // (host-aware) gating is a deliberate decision, not silent drift.
    const preload = extractStartScriptHeredoc(src, "NEMOTRON_FIX_EOF");
    const harness = `
const http = require('http');
const records = [];
http.request = function (options) {
  const record = { options, writes: [], headers: {}, removed: [] };
  records.push(record);
  return {
    write(chunk) {
      record.writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return true;
    },
    end(cb) { if (typeof cb === 'function') cb(); return true; },
    getHeader(name) { return record.headers[name]; },
    setHeader(name, value) { record.headers[name] = value; },
    removeHeader(name) { record.removed.push(name); delete record.headers[name]; },
  };
};
${preload}
function send(host, body) {
  const req = http.request({ method: 'POST', host, path: '/v1/chat/completions' });
  req.write(body);
  req.end();
}
// Different upstream hosts — all matching the path+model contract
send('inference.local', JSON.stringify({
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages: [{ role: 'user', content: 'hi' }],
}));
send('integrate.api.nvidia.com', JSON.stringify({
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages: [{ role: 'user', content: 'hi' }],
}));
send('some-other-openai-compat-host.example.com', JSON.stringify({
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  messages: [{ role: 'user', content: 'hi' }],
}));
console.log(JSON.stringify(records));
`;
    const result = spawnSync(process.execPath, ["-e", harness], {
      encoding: "utf-8",
      timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    const records = JSON.parse(result.stdout.trim());
    expect(records).toHaveLength(3);

    // All three hosts get the injection — host is intentionally NOT part
    // of the scope boundary. If this assertion ever changes, the
    // documented contract above must change too.
    for (const r of records) {
      const body = JSON.parse(r.writes.join(""));
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[0].content).toMatch(/do not have tools/i);
    }
  });
});
