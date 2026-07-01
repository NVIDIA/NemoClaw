// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanMcpArtifactSecrets } from "../tools/e2e/assert-mcp-artifact-secrets-absent.mts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "./e2e/fixtures/mcp-bridge-credentials.ts";

const roots: string[] = [];

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

    expect(scanMcpArtifactSecrets(root)).toEqual({ filesScanned: 1, leaks: [] });
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

  it("fails closed on symbolic links inside the upload tree", () => {
    const root = artifactRoot();
    const outside = path.join(artifactRoot(), "outside");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(root, "linked"));

    expect(() => scanMcpArtifactSecrets(root)).toThrow(/refuses symbolic link/);
  });
});
