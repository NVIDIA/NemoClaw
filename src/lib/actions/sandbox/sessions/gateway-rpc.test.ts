// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseGatewayCallPayload } from "./gateway-rpc-envelope";

describe("parseGatewayCallPayload", () => {
  it("returns a single-line success payload directly", () => {
    const payload = parseGatewayCallPayload<{ ok: true; key: string }>(
      '{"ok":true,"key":"agent:main:main","entry":null}',
    );
    expect(payload).toMatchObject({ ok: true, key: "agent:main:main", entry: null });
  });

  it("returns an `ok: false` failure payload", () => {
    const payload = parseGatewayCallPayload(
      '{"ok":false,"error":{"code":"E_LOCKED","message":"session locked"}}',
    );
    expect(payload).toEqual({ ok: false, error: { code: "E_LOCKED", message: "session locked" } });
  });

  it("returns a bare `error` payload (transport-level failure)", () => {
    const payload = parseGatewayCallPayload(
      '{"error":{"code":"E_NOT_FOUND","message":"no such session"}}',
    );
    expect(payload?.error).toEqual({ code: "E_NOT_FOUND", message: "no such session" });
  });

  it("returns null for blank output", () => {
    expect(parseGatewayCallPayload("")).toBeNull();
    expect(parseGatewayCallPayload("   \n  ")).toBeNull();
  });

  it("returns null for non-JSON output", () => {
    expect(parseGatewayCallPayload("OpenClaw is down")).toBeNull();
  });

  it("returns null when no candidate carries `ok` or `error`", () => {
    // Plain JSON without `ok`/`error` keys is not a gateway response shape
    // and must be rejected rather than passed through to downstream code.
    expect(parseGatewayCallPayload('{"foo":"bar"}')).toBeNull();
    expect(
      parseGatewayCallPayload(
        ['{"level":"info","msg":"starting"}', '{"foo":"bar"}'].join("\n"),
      ),
    ).toBeNull();
  });

  it("tolerates leading log noise on a single-line payload", () => {
    const payload = parseGatewayCallPayload<{ ok: true }>(
      `verbose junk\n{"ok":true,"key":"agent:main:main"}\n`,
    );
    expect(payload).toMatchObject({ ok: true });
  });

  it("prefers the gateway response over a trailing non-response JSON line", () => {
    // Regression: a debug log object emitted after the payload must not
    // masquerade as the response.
    const payload = parseGatewayCallPayload<{ ok: true; key: string }>(
      [
        '{"ok":true,"key":"agent:main:main"}',
        '{"level":"debug","msg":"gateway call complete"}',
      ].join("\n"),
    );
    expect(payload).toMatchObject({ ok: true, key: "agent:main:main" });
  });

  it("parses a multi-line pretty-printed payload", () => {
    const payload = parseGatewayCallPayload<{ ok: true; key: string }>(
      [
        "{",
        '  "ok": true,',
        '  "key": "agent:main:main",',
        '  "entry": null',
        "}",
      ].join("\n"),
    );
    expect(payload).toMatchObject({ ok: true, key: "agent:main:main" });
  });

  it("recovers a multi-line payload embedded after log noise", () => {
    const payload = parseGatewayCallPayload<{ ok: true; key: string }>(
      [
        "  Loading config /sandbox/.openclaw/openclaw.json",
        "  Connecting to gateway ws://127.0.0.1:18789",
        "{",
        '  "ok": true,',
        '  "key": "agent:main:main"',
        "}",
      ].join("\n"),
    );
    expect(payload).toMatchObject({ ok: true, key: "agent:main:main" });
  });

  it("picks the correct payload when multiple multi-line JSON blocks are present", () => {
    // A debug-log object printed before the real response would otherwise be
    // concatenated with the response if we only sliced first-`{` to last-`}`.
    // The scan must try every (`{` start, `}` end) pairing and accept the
    // first slice that parses into a valid response shape.
    const payload = parseGatewayCallPayload<{ ok: true; key: string }>(
      [
        "{",
        '  "level": "debug",',
        '  "msg": "starting gateway client"',
        "}",
        "now calling gateway",
        "{",
        '  "ok": true,',
        '  "key": "agent:main:main"',
        "}",
      ].join("\n"),
    );
    expect(payload).toMatchObject({ ok: true, key: "agent:main:main" });
  });
});
