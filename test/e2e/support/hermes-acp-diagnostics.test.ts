// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import { createHermesAcpDiagnostics } from "../fixtures/hermes-acp-diagnostics.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-diagnostics-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const diagnostics = createHermesAcpDiagnostics(new ArtifactSink(root, ["explicit-secret"]));
  const read = async () => {
    await diagnostics.write("stderr.txt");
    return fs.readFileSync(path.join(root, "stderr.txt"), "utf8");
  };
  return { diagnostics, read };
}

it("redacts complete diagnostic lines after split secrets arrive", async () => {
  const { diagnostics, read } = fixture();
  diagnostics.append("gateway recovery failed: explicit-");
  diagnostics.append(
    "secret Authorization: Bearer bearer-secret\nhttps://host.invalid/?token=query-secret\n",
  );
  const output = await read();
  expect(output).toContain("gateway recovery failed:");
  expect(output).not.toMatch(/explicit-secret|bearer-secret|query-secret/u);
});

it("discards oversized and incomplete lines without retaining secret fragments", async () => {
  const { diagnostics, read } = fixture();
  diagnostics.append("unsafe-prefix" + "x".repeat(4096));
  diagnostics.append("secret-tail\nuseful complete diagnostic\nunfinished-secret");
  const output = await read();
  expect(output).toContain("useful complete diagnostic");
  expect(output).toContain("diagnostics discarded");
  expect(output).not.toMatch(/unsafe-prefix|secret-tail|unfinished-secret/u);
});

it("bounds the retained diagnostic line count", async () => {
  const { diagnostics, read } = fixture();
  diagnostics.append("safe diagnostic\n".repeat(40));
  const output = await read();
  expect(output.match(/safe diagnostic/gu)).toHaveLength(32);
  expect(output).toContain("diagnostics discarded");
});

it("bounds retained UTF-8 bytes including the discard marker", async () => {
  const { diagnostics, read } = fixture();
  diagnostics.append(("é".repeat(1500) + "\n").repeat(10));
  const output = await read();
  expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(16 * 1024);
  expect(output).toContain("diagnostics discarded");
});

it("drops protocol-shaped stderr and stops recording after initialization", async () => {
  const { diagnostics, read } = fixture();
  diagnostics.append('gateway starting\n{"jsonrpc":"2.0","result":"private payload"}\n');
  diagnostics.append('  "prompt": "private continuation",\n');
  diagnostics.append('debug: {"params":{"prompt":"private prefixed payload"}}\n');
  diagnostics.append('[1/3] {"params":{"prompt":"private progress payload"}}\n');
  diagnostics.append("partial startup");
  diagnostics.stop();
  diagnostics.append("later agent output\n");
  const output = await read();
  expect(output).toContain("gateway starting");
  expect(output).toContain("diagnostics discarded");
  expect(output).not.toMatch(/private|partial startup|later agent/u);
});

it("retains the recovery producer's numeric progress lines while rejecting JSON arrays", async () => {
  const { diagnostics, read } = fixture();
  diagnostics.append('[1/3] Starting gateway\n[2/3] Waiting for readiness\n["private payload"]\n');
  const output = await read();
  expect(output).toContain("[1/3] Starting gateway");
  expect(output).toContain("[2/3] Waiting for readiness");
  expect(output).not.toContain("private payload");
  expect(output).toContain("diagnostics discarded");
});
