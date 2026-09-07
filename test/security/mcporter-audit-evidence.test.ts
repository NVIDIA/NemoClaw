// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "lib", "verify-mcporter-audit.sh");

let root = "";
let seedRoot = "";
let secretRoot = "";
let nodeLog = "";

function runGate(receiptSha256 = "") {
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`,
      NEMOCLAW_MCPORTER_AUDIT_RECEIPT_SHA256: receiptSha256,
      NEMOCLAW_MCPORTER_AUDIT_SECRET_ROOT: secretRoot,
      NEMOCLAW_MCPORTER_AUDIT_SEED_ROOT: seedRoot,
      NEMOCLAW_TEST_NODE_LOG: nodeLog,
    },
  });
}

function writeEvidence(directory: string, receiptName: string, rawName: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const receipt = Buffer.from('{"receipt":"fixture"}\n');
  fs.writeFileSync(path.join(directory, receiptName), receipt);
  fs.writeFileSync(path.join(directory, rawName), '{"vulnerabilities":{}}\n');
  return crypto.createHash("sha256").update(receipt).digest("hex");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcporter-audit-evidence-"));
  seedRoot = path.join(root, "seed");
  secretRoot = path.join(root, "secrets");
  nodeLog = path.join(root, "node.log");
  fs.mkdirSync(path.join(root, "bin"));
  fs.mkdirSync(seedRoot);
  fs.mkdirSync(secretRoot);
  fs.writeFileSync(
    path.join(root, "bin", "node"),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >"$NEMOCLAW_TEST_NODE_LOG"\n',
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(root, { force: true, recursive: true });
});

describe("mcporter reviewed audit evidence gate", () => {
  it("runs the live fail-closed audit when no receipt source exists", () => {
    const result = runGate();

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(nodeLog, "utf8")).toContain(
      "/scripts/lib/reviewed-npm-audit.mts --directory /usr/local/lib/nemoclaw/mcporter-runtime",
    );
  });

  it("verifies complete seed-carried evidence before invoking the receipt gate", () => {
    const directory = path.join(seedRoot, "reviewed-npm-audit");
    const receiptSha256 = writeEvidence(
      directory,
      "mcporter-runtime.receipt.json",
      "mcporter-runtime.raw.json",
    );
    fs.writeFileSync(path.join(directory, "mcporter-runtime.receipt.sha256"), `${receiptSha256}\n`);

    const result = runGate();

    expect(result.status, result.stderr).toBe(0);
    const invocation = fs.readFileSync(nodeLog, "utf8");
    expect(invocation).toContain("/scripts/lib/npm-audit-receipt.mts --receipt");
    expect(invocation).toContain(path.join(directory, "mcporter-runtime.receipt.json"));
    expect(invocation).toContain(path.join(directory, "mcporter-runtime.raw.json"));
  });

  it("rejects incomplete or hash-mismatched seed evidence without a live fallback", () => {
    const directory = path.join(seedRoot, "reviewed-npm-audit");
    const receiptSha256 = writeEvidence(
      directory,
      "mcporter-runtime.receipt.json",
      "mcporter-runtime.raw.json",
    );

    const incomplete = runGate();
    expect(incomplete.status).not.toBe(0);
    expect(incomplete.stderr).toContain("seed-cached mcporter audit evidence is incomplete");
    expect(fs.existsSync(nodeLog)).toBe(false);

    fs.writeFileSync(path.join(directory, "mcporter-runtime.receipt.sha256"), `${receiptSha256}\n`);
    fs.appendFileSync(path.join(directory, "mcporter-runtime.receipt.json"), "tampered");
    const tampered = runGate();
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain("cached mcporter audit receipt hash does not match");
    expect(fs.existsSync(nodeLog)).toBe(false);
  });

  it("requires paired secret evidence and its exact receipt hash", () => {
    const receiptSha256 = writeEvidence(
      secretRoot,
      "nemoclaw-mcporter-audit-receipt",
      "nemoclaw-mcporter-audit-raw-report",
    );

    const result = runGate(receiptSha256);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(nodeLog, "utf8")).toContain(
      "/scripts/lib/npm-audit-receipt.mts --receipt",
    );
  });
});
