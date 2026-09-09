// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { scanMcpArtifactSecrets } from "../../tools/e2e/assert-mcp-artifact-secrets-absent.mts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "../e2e/fixtures/mcp-bridge-credentials.ts";

import { probePublicTunnel } from "../e2e/live/mcp-bridge-servers";

const roots: string[] = [];

async function failedTunnelProbe(error: unknown) {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(error);
  try {
    return await probePublicTunnel("https://private.example.test", "/mcp?token=private-token", 405);
  } finally {
    fetchMock.mockRestore();
  }
}

function artifactRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-artifact-scan-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("MCP artifact credential scan", () => {
  it("accepts clean trees and missing artifact directories", () => {
    const root = artifactRoot();
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "nested", "result.json"), '{"status":"clean"}\n');

    expect(scanMcpArtifactSecrets(root)).toEqual({
      filesScanned: 1,
      leaks: [],
    });
    expect(scanMcpArtifactSecrets(path.join(root, "missing"))).toEqual({
      filesScanned: 0,
      leaks: [],
    });
  });

  it("finds raw and directly encoded fixture credentials without reporting their values", () => {
    const root = artifactRoot();
    fs.writeFileSync(path.join(root, "raw.txt"), MCP_BRIDGE_TEST_CREDENTIALS.host);
    fs.writeFileSync(
      path.join(root, "encoded.txt"),
      Buffer.from(MCP_BRIDGE_TEST_CREDENTIALS.rotatedHost).toString("base64url"),
    );

    const result = scanMcpArtifactSecrets(root);
    expect(result.leaks).toEqual(
      expect.arrayContaining([
        { credential: "host", encoding: "raw", file: "raw.txt" },
        { credential: "rotatedHost", encoding: "base64", file: "encoded.txt" },
      ]),
    );
    expect(JSON.stringify(result)).not.toContain(MCP_BRIDGE_TEST_CREDENTIALS.host);
    expect(JSON.stringify(result)).not.toContain(MCP_BRIDGE_TEST_CREDENTIALS.rotatedHost);
  });

  it("decodes larger base64 payloads before checking for embedded credentials", () => {
    const root = artifactRoot();
    const encoded = Buffer.from(
      `prefix:${MCP_BRIDGE_TEST_CREDENTIALS.rebindHost}:suffix`,
      "utf8",
    ).toString("base64");
    const wrapped = encoded.match(/.{1,7}/gu)?.join("\n") ?? encoded;
    fs.writeFileSync(path.join(root, "wrapped.json"), JSON.stringify({ payload: wrapped }));

    expect(scanMcpArtifactSecrets(root).leaks).toContainEqual({
      credential: "rebindHost",
      encoding: "base64",
      file: "wrapped.json",
    });
  });

  it("finds every generated credential-window value through its shared prefix", () => {
    const root = artifactRoot();
    fs.writeFileSync(
      path.join(root, "generation.txt"),
      `${MCP_BRIDGE_TEST_CREDENTIALS.generationWindow}09`,
    );

    expect(scanMcpArtifactSecrets(root).leaks).toContainEqual({
      credential: "generationWindow",
      encoding: "raw",
      file: "generation.txt",
    });
  });

  it("fails closed on symbolic links inside the upload tree", () => {
    const root = artifactRoot();
    const outside = path.join(artifactRoot(), "outside");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(root, "linked"));

    expect(() => scanMcpArtifactSecrets(root)).toThrow(/refuses symbolic link/);
  });
});

describe("MCP public tunnel diagnostic privacy", () => {
  it.each([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNRESET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "CERT_HAS_EXPIRED",
  ])("retains the safe tunnel cause code %s without request or error details", async (code) => {
    const cause = Object.assign(new Error("Authorization: Bearer private-cause-secret"), { code });
    const result = await failedTunnelProbe(
      new TypeError("https://user:secret@private.invalid", { cause }),
    );
    expect(result).toEqual({
      ready: false,
      diagnostic: `public HEAD probe failed (TypeError; codes=${code})`,
    });
  });

  it("reports bounded aggregate network causes and terminates cyclic cause graphs", async () => {
    const aggregate = new AggregateError(
      [
        Object.assign(new Error("private IPv6 endpoint"), { code: "ENETUNREACH" }),
        Object.assign(new Error("private IPv4 endpoint"), { code: "ETIMEDOUT" }),
      ],
      "private aggregate message",
    );
    const failure = new TypeError("private fetch message", { cause: aggregate });
    Object.defineProperty(aggregate, "cause", { value: failure });
    expect(await failedTunnelProbe(failure)).toEqual({
      ready: false,
      diagnostic: "public HEAD probe failed (TypeError; codes=ENETUNREACH,ETIMEDOUT)",
    });

    const hidden = Object.assign(new Error("deep private cause"), { code: "CERT_HAS_EXPIRED" });
    const deep = Array.from({ length: 20 }).reduce<Error>(
      (cause) => new Error("private wrapper", { cause }),
      hidden,
    );
    expect(await failedTunnelProbe(deep)).toEqual({
      ready: false,
      diagnostic: "public HEAD probe failed (Error; codes=unknown)",
    });
  });

  it("never invokes error getters or proxy traps while collecting tunnel diagnostics", async () => {
    const getter = vi.fn(() => {
      throw new Error("private getter content");
    });
    const failure = new TypeError("private initial message");
    Object.defineProperties(
      failure,
      Object.fromEntries(
        ["name", "message", "stack", "code", "cause", "errors"].map((key) => [
          key,
          { get: getter },
        ]),
      ),
    );
    expect(await failedTunnelProbe(failure)).toEqual({
      ready: false,
      diagnostic: "public HEAD probe failed (TypeError; codes=unknown)",
    });
    expect(getter).not.toHaveBeenCalled();

    const trap = vi.fn(() => {
      throw new Error("private proxy content");
    });
    const hostile = new Proxy(new Error(), {
      get: trap,
      getPrototypeOf: trap,
      getOwnPropertyDescriptor: trap,
    });
    expect(await failedTunnelProbe(hostile)).toEqual({
      ready: false,
      diagnostic: "public HEAD probe failed (unknown error; codes=unknown)",
    });
    expect(trap).not.toHaveBeenCalled();
    const revoked = Proxy.revocable(new Error(), {});
    revoked.revoke();
    expect(await failedTunnelProbe(revoked.proxy)).toEqual({
      ready: false,
      diagnostic: "public HEAD probe failed (unknown error; codes=unknown)",
    });
  });

  it("ignores arbitrary names and codes while retaining native timeout classification", async () => {
    const failure = Object.assign(new Error("private message"), {
      name: "PRIVATE_TOKEN=private-name",
      code: "ENOTFOUND private-code",
      headers: { authorization: "private-header" },
      url: "https://private.invalid",
    });
    expect(await failedTunnelProbe(failure)).toEqual({
      ready: false,
      diagnostic: "public HEAD probe failed (Error; codes=unknown)",
    });
    expect(await failedTunnelProbe("private thrown string")).toEqual({
      ready: false,
      diagnostic: "public HEAD probe failed (unknown error; codes=unknown)",
    });
    expect(await failedTunnelProbe(new DOMException("private timeout", "TimeoutError"))).toEqual({
      ready: false,
      diagnostic: "public HEAD probe failed (TimeoutError; codes=unknown)",
    });
    expect(await failedTunnelProbe(new DOMException("private abort", "AbortError"))).toEqual({
      ready: false,
      diagnostic: "public HEAD probe failed (AbortError; codes=unknown)",
    });
    expect(await failedTunnelProbe(new DOMException("private value", "private name"))).toEqual({
      ready: false,
      diagnostic: "public HEAD probe failed (DOMException; codes=unknown)",
    });
  });
});
