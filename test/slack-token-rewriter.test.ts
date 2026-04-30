// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for nemoclaw-blueprint/scripts/slack-token-rewriter.js.
//
// Loads the canonical rewriter source into a function-scoped sandbox with
// stubbed http/https modules, then drives the wrapped methods through every
// signature shape Node accepts and asserts the placeholder is rewritten to
// the canonical openshell:resolve:env:VAR form before reaching the original
// request function.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";

const CANONICAL_REWRITER = path.join(
  import.meta.dirname,
  "..",
  "nemoclaw-blueprint",
  "scripts",
  "slack-token-rewriter.js",
);

// Build fresh stub modules and load the rewriter on top of them. Returns the
// stub modules whose request/get methods have been monkey-patched by the
// rewriter, plus a `captured` array recording the args each wrapped call
// passed to the underlying (un-rewritten) implementation.
function loadRewriter() {
  const src = fs.readFileSync(CANONICAL_REWRITER, "utf-8");
  const captured: { method: string; args: unknown[]; req: ReturnType<typeof makeRequest> }[] = [];

  const makeRequest = (args: unknown[]) => {
    const headers = new Map<string, string>();
    const calls: { method: string; args: unknown[] }[] = [];
    const opts = args.find(
      (arg) => arg && typeof arg === "object" && !Array.isArray(arg) && !(arg instanceof URL),
    ) as { headers?: Record<string, string> } | undefined;
    if (opts?.headers) {
      for (const [k, v] of Object.entries(opts.headers)) {
        headers.set(k.toLowerCase(), String(v));
      }
    }
    return {
      calls,
      _header: null as string | null,
      headersSent: false,
      getHeader(name: string) {
        return headers.get(name.toLowerCase());
      },
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), String(value));
      },
      write(...writeArgs: unknown[]) {
        calls.push({ method: "write", args: writeArgs });
        return true;
      },
      end(...endArgs: unknown[]) {
        calls.push({ method: "end", args: endArgs });
        return this;
      },
    };
  };

  const make = (label: string) => ({
    request(...args: unknown[]) {
      const req = makeRequest(args);
      captured.push({ method: `${label}.request`, args, req });
      return req;
    },
    get(...args: unknown[]) {
      const req = makeRequest(args);
      captured.push({ method: `${label}.get`, args, req });
      return req;
    },
  });

  const http = make("http");
  const https = make("https");
  const fakeRequire = (name: string) => {
    if (name === "http") return http;
    if (name === "https") return https;
    throw new Error(`unexpected require: ${name}`);
  };

  // Evaluate the rewriter source with a custom `require`. The rewriter is an
  // IIFE that touches only `require`, `URL`, and built-in globals — running
  // it inside a Function() body keeps the global URL constructor identity
  // consistent with the test code, so `arg1 instanceof URL` works correctly.
  new Function("require", src)(fakeRequire);

  return { http, https, captured };
}

describe("slack-token-rewriter: string rewriting", () => {
  let mod: ReturnType<typeof loadRewriter>;
  beforeEach(() => {
    mod = loadRewriter();
  });

  it("rewrites Bolt-shape placeholder in a string URL argument", () => {
    mod.https.request(
      "https://api.slack.com/api/auth.test?token=xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
    );
    const [arg0] = mod.captured[0].args;
    expect(arg0).toBe(
      "https://api.slack.com/api/auth.test?token=openshell:resolve:env:SLACK_BOT_TOKEN",
    );
  });

  it("rewrites Bolt-shape placeholder in a URL object", () => {
    const url = new URL(
      "https://api.slack.com/api/auth.test?token=xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
    );
    mod.https.request(url);
    const [arg0] = mod.captured[0].args;
    expect(arg0 instanceof URL).toBe(true);
    expect((arg0 as URL).href).toContain("openshell:resolve:env:SLACK_APP_TOKEN");
    expect((arg0 as URL).href).not.toContain("OPENSHELL-RESOLVE-ENV-");
  });

  it("rewrites options.path", () => {
    const opts = {
      hostname: "api.slack.com",
      path: "/api/auth.test?token=xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
    };
    mod.https.request(opts);
    expect(opts.path).toBe("/api/auth.test?token=openshell:resolve:env:SLACK_BOT_TOKEN");
  });

  it("rewrites options.headers.Authorization (Bearer prefix)", () => {
    const opts = {
      hostname: "api.slack.com",
      path: "/api/auth.test",
      headers: { Authorization: "Bearer xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN" },
    };
    mod.https.request(opts);
    expect(opts.headers.Authorization).toBe("Bearer openshell:resolve:env:SLACK_BOT_TOKEN");
  });

  it("rewrites lowercase header name", () => {
    const opts = {
      headers: { authorization: "Bearer xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN" },
    };
    mod.https.request(opts);
    expect(opts.headers.authorization).toBe("Bearer openshell:resolve:env:SLACK_BOT_TOKEN");
  });

  it("rewrites array-valued header entries", () => {
    const opts = {
      headers: {
        "X-Slack-Audit": [
          "Bearer xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
          "no-placeholder-here",
        ],
      },
    };
    mod.https.request(opts);
    expect(opts.headers["X-Slack-Audit"][0]).toBe("Bearer openshell:resolve:env:SLACK_APP_TOKEN");
    expect(opts.headers["X-Slack-Audit"][1]).toBe("no-placeholder-here");
  });

  it("leaves non-placeholder strings untouched (fast path)", () => {
    const opts = {
      hostname: "api.slack.com",
      path: "/api/auth.test",
      headers: { Authorization: "Bearer xoxb-real-1234567890-abcdef" },
    };
    mod.https.request(opts);
    expect(opts.headers.Authorization).toBe("Bearer xoxb-real-1234567890-abcdef");
    expect(opts.path).toBe("/api/auth.test");
  });
});

describe("slack-token-rewriter: identity and idempotence", () => {
  it("preserves options object identity (axios reuses the headers object)", () => {
    const mod = loadRewriter();
    const headers = { Authorization: "Bearer xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN" };
    const opts = { hostname: "api.slack.com", path: "/", headers };
    mod.https.request(opts);
    const [arg0] = mod.captured[0].args;
    expect(arg0).toBe(opts);
    expect((arg0 as { headers: object }).headers).toBe(headers);
  });

  it("is idempotent — replaying captured args produces the same canonical form", () => {
    const mod = loadRewriter();
    const opts = {
      headers: { Authorization: "Bearer xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN" },
    };
    mod.https.request(opts);
    const firstPass = opts.headers.Authorization;
    mod.https.request(opts);
    expect(opts.headers.Authorization).toBe(firstPass);
    expect(opts.headers.Authorization).toBe("Bearer openshell:resolve:env:SLACK_BOT_TOKEN");
  });
});

describe("slack-token-rewriter: request bodies", () => {
  it("rewrites Buffer body chunks and adjusts Content-Length", () => {
    const mod = loadRewriter();
    const original = Buffer.from("token=xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN");
    const expected = "token=openshell:resolve:env:SLACK_BOT_TOKEN";
    const req = mod.https.request({
      headers: { "Content-Length": String(original.length) },
    });

    req.write(original);

    const written = req.calls[0].args[0] as Buffer;
    expect(Buffer.isBuffer(written)).toBe(true);
    expect(written.toString("utf-8")).toBe(expected);
    expect(req.getHeader("content-length")).toBe(String(Buffer.byteLength(expected)));
  });

  it("rewrites string body chunks passed to end()", () => {
    const mod = loadRewriter();
    const original = "token=xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN";
    const expected = "token=openshell:resolve:env:SLACK_APP_TOKEN";
    const req = mod.https.request({
      headers: { "content-length": String(Buffer.byteLength(original)) },
    });

    req.end(original, "utf8");

    expect(req.calls[0].args[0]).toBe(expected);
    expect(req.getHeader("content-length")).toBe(String(Buffer.byteLength(expected)));
  });

  it("does not rewrite non-UTF-8 body chunks even if the marker bytes appear", () => {
    const mod = loadRewriter();
    const original = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0xfd]),
      Buffer.from("xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN"),
    ]);
    const req = mod.https.request({
      headers: { "content-length": String(original.length) },
    });

    req.write(original);

    expect(req.calls[0].args[0]).toBe(original);
    expect(req.getHeader("content-length")).toBe(String(original.length));
  });
});

describe("slack-token-rewriter: every wrapped method", () => {
  it("wraps http.request, http.get, https.request, and https.get", () => {
    const mod = loadRewriter();
    const opts = () => ({
      headers: { Authorization: "Bearer xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN" },
    });

    const a = opts();
    mod.http.request(a);
    expect(a.headers.Authorization).toBe("Bearer openshell:resolve:env:SLACK_BOT_TOKEN");

    const b = opts();
    mod.http.get(b);
    expect(b.headers.Authorization).toBe("Bearer openshell:resolve:env:SLACK_BOT_TOKEN");

    const c = opts();
    mod.https.request(c);
    expect(c.headers.Authorization).toBe("Bearer openshell:resolve:env:SLACK_BOT_TOKEN");

    const d = opts();
    mod.https.get(d);
    expect(d.headers.Authorization).toBe("Bearer openshell:resolve:env:SLACK_BOT_TOKEN");

    expect(mod.captured.map((c) => c.method)).toEqual([
      "http.request",
      "http.get",
      "https.request",
      "https.get",
    ]);
  });
});

describe("slack-token-rewriter: signature shapes", () => {
  it("supports request(url, options) — both args mutated", () => {
    const mod = loadRewriter();
    const opts = {
      headers: { Authorization: "Bearer xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN" },
    };
    mod.https.request("https://api.slack.com/api/auth.test?t=xoxb-OPENSHELL-RESOLVE-ENV-X", opts);
    const [arg0] = mod.captured[0].args;
    expect(arg0).toContain("openshell:resolve:env:X");
    expect(opts.headers.Authorization).toBe("Bearer openshell:resolve:env:SLACK_BOT_TOKEN");
  });

  it("supports request(url, callback) — callback is not treated as options", () => {
    const mod = loadRewriter();
    const cb = () => {
      /* noop */
    };
    mod.https.request("https://api.slack.com/?t=xoxb-OPENSHELL-RESOLVE-ENV-X", cb);
    const args = mod.captured[0].args;
    expect(args[0]).toContain("openshell:resolve:env:X");
    expect(args[1]).toBe(cb);
  });
});
