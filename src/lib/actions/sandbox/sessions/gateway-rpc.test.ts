// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseGatewayCallEnvelope } from "./gateway-rpc-envelope";

describe("parseGatewayCallEnvelope", () => {
  it("parses a single-line success envelope", () => {
    const env = parseGatewayCallEnvelope<{ ok: true; key: string }>(
      '{"result":{"ok":true,"key":"agent:main:main"}}',
    );
    expect(env?.result).toEqual({ ok: true, key: "agent:main:main" });
  });

  it("parses an error envelope", () => {
    const env = parseGatewayCallEnvelope(
      '{"error":{"code":"E_NOT_FOUND","message":"no such session"}}',
    );
    expect(env?.error?.code).toBe("E_NOT_FOUND");
    expect(env?.error?.message).toBe("no such session");
  });

  it("returns the last JSON-shaped line when output has noise", () => {
    const env = parseGatewayCallEnvelope<{ ok: true }>(
      [
        "warning: discovered stale session lock",
        "info: reaping...",
        '{"result":{"ok":true}}',
      ].join("\n"),
    );
    expect(env?.result).toEqual({ ok: true });
  });

  it("returns null for blank output", () => {
    expect(parseGatewayCallEnvelope("")).toBeNull();
    expect(parseGatewayCallEnvelope("   \n  ")).toBeNull();
  });

  it("returns null for non-JSON output", () => {
    expect(parseGatewayCallEnvelope("OpenClaw is down")).toBeNull();
  });

  it("tolerates leading noise on the JSON line", () => {
    const env = parseGatewayCallEnvelope<{ ok: true }>(
      `verbose junk\n{"result":{"ok":true}}\n`,
    );
    expect(env?.result).toEqual({ ok: true });
  });

  it("prefers the gateway envelope even when an unrelated JSON line trails it", () => {
    // Regression: the parser must ignore trailing non-envelope JSON. An
    // earlier version picked the last JSON-shaped line on stdout, which
    // would let a debug log object emitted after the envelope masquerade as
    // the gateway response.
    const env = parseGatewayCallEnvelope<{ ok: true; key: string }>(
      [
        '{"result":{"ok":true,"key":"agent:main:main"}}',
        '{"level":"debug","msg":"gateway call complete"}',
      ].join("\n"),
    );
    expect(env?.result).toEqual({ ok: true, key: "agent:main:main" });
  });

  it("returns null when no line carries the envelope contract", () => {
    // Plain JSON without `result`/`error` keys is not a gateway envelope and
    // must be rejected rather than coerced into one.
    expect(parseGatewayCallEnvelope('{"foo":"bar"}')).toBeNull();
    expect(
      parseGatewayCallEnvelope(
        ['{"level":"info","msg":"starting"}', '{"foo":"bar"}'].join("\n"),
      ),
    ).toBeNull();
  });
});
