// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for nemoclaw-blueprint/scripts/wechat-diagnostics.js.
//
// The script is a self-contained IIFE that mutates process.stderr.write,
// http.request, http.get, https.request, and https.get globally on require —
// so each test runs in an isolated child Node process. The harness writes a
// small driver script per case that requires the diagnostics module, drives
// it (HTTP request, stderr write, etc.), and emits structured JSON we can
// assert on.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DIAGNOSTICS_PATH = path.join(
  import.meta.dirname,
  "..",
  "nemoclaw-blueprint",
  "scripts",
  "wechat-diagnostics.js",
);

function runDriver(driverBody: string, env: Record<string, string> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-diag-"));
  const driverPath = path.join(tmpDir, "driver.js");
  fs.writeFileSync(driverPath, driverBody);
  try {
    return spawnSync(process.execPath, [driverPath], {
      encoding: "utf-8",
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        DIAGNOSTICS_PATH,
        ...env,
      },
      timeout: 5_000,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("wechat-diagnostics: install gating", () => {
  it("is idempotent — requiring twice does not double-wrap process.stderr.write", () => {
    // The module guards on process.__nemoclawWechatDiagnosticsInstalled so a
    // second require is a no-op. Without the guard each preload of the
    // sandbox boot script (gateway + agent + bridge) would chain-wrap stderr.
    const driver = `
      const before = process.stderr.write;
      require(process.env.DIAGNOSTICS_PATH);
      const afterFirst = process.stderr.write;
      require(process.env.DIAGNOSTICS_PATH);
      const afterSecond = process.stderr.write;
      // First require must replace stderr.write; second must leave it alone.
      console.log(JSON.stringify({
        firstReplaced: before !== afterFirst,
        secondReplaced: afterFirst !== afterSecond,
        flagSet: process.__nemoclawWechatDiagnosticsInstalled === true,
      }));
    `;
    const result = runDriver(driver);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.firstReplaced).toBe(true);
    expect(out.secondReplaced).toBe(false);
    expect(out.flagSet).toBe(true);
  });
});

describe("wechat-diagnostics: provider-ready signal", () => {
  it("emits [wechat] provider ready once iLink answers a 2xx on /ilink/bot", async () => {
    // The diagnostics module wraps http.request and listens for the response
    // event. It only emits "provider ready" when (a) the host matches
    // *.weixin.qq.com, (b) the path starts with /ilink/bot, and (c) the
    // status is 2xx — the conjunction is what makes the signal reliable.
    const driver = `
      const http = require('http');
      const server = http.createServer((req, res) => {
        if (req.url.startsWith('/ilink/bot')) {
          res.writeHead(200);
          res.end('ok');
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        // Bypass DNS for the fake WeChat hostnames by overriding
        // createConnection — every request goes to the in-process server
        // regardless of the hostname set on opts (which is what the
        // diagnostics module reads to decide whether to log).
        const net = require('net');
        const createConnection = () => net.connect(port, '127.0.0.1');
        // Hostname matching is by suffix on .weixin.qq.com — we get there by
        // setting the Host header but connecting to localhost. The wrapper
        // reads opts.hostname/host directly, so we pass it that way.
        require(process.env.DIAGNOSTICS_PATH);
        const req = http.request({
          hostname: 'ilink-42.weixin.qq.com',
          port,
          path: '/ilink/bot/cgi-bin/getme',
          method: 'GET',
          createConnection,
        }, (res) => {
          res.resume();
          res.on('end', () => server.close());
        });
        req.end();
      });
    `;
    const result = runDriver(driver, { WECHAT_ACCOUNT_ID: "ilink-bot-42" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[wechat] [ilink-bot-42] provider ready");
  });

  it("does NOT emit provider ready when path is outside /ilink/bot", async () => {
    const driver = `
      const http = require('http');
      const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        // Bypass DNS for the fake WeChat hostnames by overriding
        // createConnection — every request goes to the in-process server
        // regardless of the hostname set on opts (which is what the
        // diagnostics module reads to decide whether to log).
        const net = require('net');
        const createConnection = () => net.connect(port, '127.0.0.1');
        require(process.env.DIAGNOSTICS_PATH);
        const req = http.request({
          hostname: 'foo.weixin.qq.com',
          port,
          path: '/some/other/api',
          createConnection,
        }, (res) => {
          res.resume();
          res.on('end', () => server.close());
        });
        req.end();
      });
    `;
    const result = runDriver(driver);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("provider ready");
  });

  it("does NOT emit provider ready for non-WeChat hosts even on /ilink/bot", async () => {
    // Defense in depth: a path collision on an unrelated host shouldn't
    // produce a false positive.
    const driver = `
      const http = require('http');
      const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        // Bypass DNS for the fake WeChat hostnames by overriding
        // createConnection — every request goes to the in-process server
        // regardless of the hostname set on opts (which is what the
        // diagnostics module reads to decide whether to log).
        const net = require('net');
        const createConnection = () => net.connect(port, '127.0.0.1');
        require(process.env.DIAGNOSTICS_PATH);
        const req = http.request({
          hostname: 'evil.example.com',
          port,
          path: '/ilink/bot/cgi-bin/x',
          createConnection,
        }, (res) => {
          res.resume();
          res.on('end', () => server.close());
        });
        req.end();
      });
    `;
    const result = runDriver(driver);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("provider ready");
  });

  it("does NOT emit provider ready on a 4xx response", async () => {
    const driver = `
      const http = require('http');
      const server = http.createServer((req, res) => { res.writeHead(403); res.end('forbidden'); });
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        // Bypass DNS for the fake WeChat hostnames by overriding
        // createConnection — every request goes to the in-process server
        // regardless of the hostname set on opts (which is what the
        // diagnostics module reads to decide whether to log).
        const net = require('net');
        const createConnection = () => net.connect(port, '127.0.0.1');
        require(process.env.DIAGNOSTICS_PATH);
        const req = http.request({
          hostname: 'a.weixin.qq.com',
          port,
          path: '/ilink/bot/cgi-bin/getme',
          createConnection,
        }, (res) => {
          res.resume();
          res.on('end', () => server.close());
        });
        req.end();
      });
    `;
    const result = runDriver(driver);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("provider ready");
  });

  it("only emits provider ready once even if multiple matching responses arrive", async () => {
    // readyLogged guards against repeat emission so operators get one clean
    // "provider ready" line, not a per-request stream.
    const driver = `
      const http = require('http');
      const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        // Bypass DNS for the fake WeChat hostnames by overriding
        // createConnection — every request goes to the in-process server
        // regardless of the hostname set on opts (which is what the
        // diagnostics module reads to decide whether to log).
        const net = require('net');
        const createConnection = () => net.connect(port, '127.0.0.1');
        require(process.env.DIAGNOSTICS_PATH);
        let pending = 3;
        for (let i = 0; i < 3; i++) {
          const req = http.request({
            hostname: 'a.weixin.qq.com',
            port,
            path: '/ilink/bot/cgi-bin/x' + i,
            createConnection,
          }, (res) => {
            res.resume();
            res.on('end', () => { if (--pending === 0) server.close(); });
          });
          req.end();
        }
      });
    `;
    const result = runDriver(driver);
    expect(result.status).toBe(0);
    const matches = result.stderr.match(/provider ready/g) || [];
    expect(matches.length).toBe(1);
  });

  it("uses 'default' as account id when WECHAT_ACCOUNT_ID is unset", async () => {
    const driver = `
      const http = require('http');
      const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        // Bypass DNS for the fake WeChat hostnames by overriding
        // createConnection — every request goes to the in-process server
        // regardless of the hostname set on opts (which is what the
        // diagnostics module reads to decide whether to log).
        const net = require('net');
        const createConnection = () => net.connect(port, '127.0.0.1');
        delete process.env.WECHAT_ACCOUNT_ID;
        require(process.env.DIAGNOSTICS_PATH);
        const req = http.request({
          hostname: 'a.weixin.qq.com',
          port,
          path: '/ilink/bot/cgi-bin/x',
          createConnection,
        }, (res) => {
          res.resume();
          res.on('end', () => server.close());
        });
        req.end();
      });
    `;
    const result = runDriver(driver);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[wechat] [default] provider ready");
  });

  it("uses 'default' when WECHAT_ACCOUNT_ID is whitespace-only", async () => {
    const driver = `
      const http = require('http');
      const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        // Bypass DNS for the fake WeChat hostnames by overriding
        // createConnection — every request goes to the in-process server
        // regardless of the hostname set on opts (which is what the
        // diagnostics module reads to decide whether to log).
        const net = require('net');
        const createConnection = () => net.connect(port, '127.0.0.1');
        require(process.env.DIAGNOSTICS_PATH);
        const req = http.request({
          hostname: 'a.weixin.qq.com',
          port,
          path: '/ilink/bot/cgi-bin/x',
          createConnection,
        }, (res) => {
          res.resume();
          res.on('end', () => server.close());
        });
        req.end();
      });
    `;
    const result = runDriver(driver, { WECHAT_ACCOUNT_ID: "   " });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[wechat] [default] provider ready");
  });
});

describe("wechat-diagnostics: inference-error annotation", () => {
  it("redacts bot_token query params and 'token: ...' patterns in emitted error lines", () => {
    // This is the core safety property: the diagnostics line is a free-form
    // string built from whatever the agent process logged, which means it
    // can contain credential-shaped substrings. The sanitize() pass MUST
    // strip them before re-emitting.
    const driver = `
      require(process.env.DIAGNOSTICS_PATH);
      // Trigger the providerStarted=true path via the regex on stderr.write.
      process.stderr.write('[wechat] [primary] starting provider\\n');
      // Now emit an inference error containing both a URL token and a JSON
      // token shape.
      process.stderr.write(
        'LLM request failed: GET https://ilink.weixin.qq.com/api?bot_token=secret-abc-123&user=x\\n' +
        '  body: {"bot_token":"hunter2","data":{}}\\n'
      );
    `;
    const result = runDriver(driver, { WECHAT_ACCOUNT_ID: "primary" });
    expect(result.status).toBe(0);
    // Original line passes through stderr (the wrapper calls original first),
    // but the diagnostic-emitted annotation must be redacted.
    const annotation = result.stderr
      .split(/\r?\n/)
      .find((line) => line.includes("agent turn failed after provider startup"));
    expect(annotation).toBeTruthy();
    expect(annotation).toContain("bot_token=<redacted>");
    expect(annotation).not.toContain("secret-abc-123");
    expect(annotation).not.toContain("hunter2");
  });

  it("does not annotate when an LLM error precedes any 'starting provider' marker", () => {
    // Rationale: if the bridge never started, the failure is "channel never
    // came up", which other diagnostics already cover. The annotation is
    // specifically for the "channel up, inference broken" delta.
    const driver = `
      require(process.env.DIAGNOSTICS_PATH);
      process.stderr.write('LLM request failed: timeout\\n');
    `;
    const result = runDriver(driver);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("agent turn failed after provider startup");
  });

  it("emits the annotation only once across multiple inference errors", () => {
    const driver = `
      require(process.env.DIAGNOSTICS_PATH);
      process.stderr.write('[wechat] [primary] starting provider\\n');
      process.stderr.write('LLM request failed: first\\n');
      process.stderr.write('LLM request failed: second\\n');
      process.stderr.write('FailoverError: third\\n');
    `;
    const result = runDriver(driver, { WECHAT_ACCOUNT_ID: "primary" });
    expect(result.status).toBe(0);
    const matches = result.stderr.match(/agent turn failed after provider startup/g) || [];
    expect(matches.length).toBe(1);
  });

  it("truncates the annotated error line to 600 chars to keep stderr readable", () => {
    const driver = `
      require(process.env.DIAGNOSTICS_PATH);
      process.stderr.write('[wechat] [p] starting provider\\n');
      process.stderr.write('LLM request failed: ' + 'A'.repeat(2000) + '\\n');
    `;
    const result = runDriver(driver);
    expect(result.status).toBe(0);
    const annotation = result.stderr
      .split(/\r?\n/)
      .find((line) => line.includes("agent turn failed after provider startup"));
    expect(annotation).toBeTruthy();
    // Slice happens after 'inference error: ' prefix; the captured tail
    // (600 chars max) should be far shorter than the 2000 'A's we emitted.
    const tail = annotation.split("inference error: ")[1] ?? "";
    expect(tail.length).toBeLessThanOrEqual(600);
  });
});
