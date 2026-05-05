// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

function extractStartScriptHeredoc(src, marker) {
  const heredoc = src.match(new RegExp(`<<'${marker}'\\n([\\s\\S]*?)\\n${marker}`));
  if (!heredoc) {
    throw new Error(`Expected ${marker} heredoc in scripts/nemoclaw-start.sh`);
  }
  return heredoc[1];
}

describe("NVIDIA endpoint inference fix preload (#1193, #2051)", () => {
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
      .replaceAll("/tmp/nemoclaw-nemotron-inference-fix.js", preloadPath);
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

    const otherBody = JSON.parse(records[2].writes[0]);
    expect(otherBody.chat_template_kwargs).toBeUndefined();
    expect(records[3].writes[0]).toBe("{not json");
    expect(JSON.parse(records[4].writes[0]).chat_template_kwargs).toBeUndefined();
    expect(JSON.parse(records[5].writes[0]).chat_template_kwargs).toBeUndefined();
  });
});
