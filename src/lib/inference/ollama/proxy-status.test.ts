// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, test, vi } from "vitest";

import { printProxyStartupReason } from "./proxy-status";

const OLLAMA_PORT = 11434;
const OLLAMA_BACKEND = `http://127.0.0.1:${OLLAMA_PORT}`;
const NOT_LOOPBACK = { reason: "backend-not-loopback", details: "00000000:8000" };

let errors: string[];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((message: string) => {
    errors.push(message);
  });
});

describe("printProxyStartupReason backend-not-loopback remediation", () => {
  test("keeps the Ollama daemon remediation when no compatible endpoint was selected", () => {
    printProxyStartupReason(NOT_LOOPBACK, OLLAMA_PORT, undefined);

    expect(errors.join("\n")).toContain(`OLLAMA_HOST=127.0.0.1:${OLLAMA_PORT}`);
    expect(errors[0]).toBe("  Error: Ollama auth proxy refused to start.");
  });

  test.each([
    ["a vLLM endpoint", "http://localhost:8000", "localhost:8000", "only on port 8000"],
    ["a llama-server endpoint", "http://127.0.0.1:8080", "127.0.0.1:8080", "only on port 8080"],
    ["an IPv6 loopback endpoint", "http://[::1]:8000", "[::1]:8000", "only on port 8000"],
    // A compatible endpoint may sit on the Ollama daemon's own port, so the URL
    // cannot identify the daemon; only an absent selection can.
    ["an endpoint on the Ollama port", OLLAMA_BACKEND, "127.0.0.1:11434", "only on port 11434"],
  ])(
    "names %s instead of Ollama when it fronts a compatible endpoint (#9730)",
    (_label, backendUrl, authority, portClause) => {
      printProxyStartupReason(NOT_LOOPBACK, OLLAMA_PORT, backendUrl);

      const rendered = errors.join("\n");
      expect(rendered).toContain(authority);
      expect(rendered).toContain(portClause);
      expect(rendered).not.toContain("OLLAMA_HOST=");
      expect(rendered).not.toContain("bind Ollama to loopback");
    },
  );

  test.each([
    ["a URL with no port", "http://endpoint.internal", "endpoint.internal"],
    ["a value that is not a URL", "not-a-url", "not-a-url"],
  ])("asks for a loopback bind without naming a port for %s", (_label, backendUrl, authority) => {
    printProxyStartupReason(NOT_LOOPBACK, OLLAMA_PORT, backendUrl);

    const rendered = errors.join("\n");
    expect(rendered).toContain(authority);
    expect(rendered).toContain("bound to a loopback address only, then re-run onboarding.");
    expect(rendered).not.toContain("on port");
  });

  test("never tells an IPv6 loopback endpoint to bind the IPv4 loopback address", () => {
    printProxyStartupReason(NOT_LOOPBACK, OLLAMA_PORT, "http://[::1]:8000");

    expect(errors.join("\n")).not.toContain("127.0.0.1");
  });

  test("reports the observed non-loopback listeners in every case", () => {
    printProxyStartupReason(NOT_LOOPBACK, OLLAMA_PORT, "http://localhost:8000");

    expect(errors.join("\n")).toContain("00000000:8000");
  });

  test("falls back to the generic reason for any other structured exit", () => {
    const handled = printProxyStartupReason(
      { reason: "listen-error", details: "EADDRINUSE" },
      OLLAMA_PORT,
      "http://localhost:8000",
    );

    expect(handled).toBe(true);
    expect(errors.join("\n")).toContain("exited during startup: listen-error");
  });

  test("returns false when the proxy wrote no structured reason", () => {
    expect(printProxyStartupReason(null, OLLAMA_PORT, "http://localhost:8000")).toBe(false);
    expect(errors).toEqual([]);
  });
});
