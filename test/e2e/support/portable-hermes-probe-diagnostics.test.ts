// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { recordPortableHermesGatewayProbeFailure } from "../fixtures/portable-hermes-probe-diagnostics.ts";

it("redacts the entire probe output before retaining the bounded failure tail", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-probe-diagnostic-"));
  try {
    const artifacts = new ArtifactSink(root);
    const token = `secret-${"opaque".repeat(100)}`;
    await recordPortableHermesGatewayProbeFailure(artifacts, token, {
      status: 126,
      stdout: `response ${token}`,
      stderr: `${"x".repeat(3_000)}Bearer ${token}\ncrun: operation not permitted`,
    });
    const bytes = fs.readFileSync(
      path.join(root, "portable-hermes-gateway-probe-failure.json"),
      "utf-8",
    );
    const evidence = JSON.parse(bytes) as {
      status: number;
      stdoutTail: string;
      stderrTail: string;
    };
    expect(bytes).not.toContain(token);
    expect(evidence.status).toBe(126);
    expect(evidence.stdoutTail).toContain("[REDACTED]");
    expect(evidence.stderrTail).toContain("crun: operation not permitted");
    expect(evidence.stderrTail).toContain("[REDACTED]");
    expect(evidence.stderrTail.length).toBeLessThanOrEqual(2_048);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

it("does not record a probe artifact when the route succeeds", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-probe-success-"));
  try {
    await recordPortableHermesGatewayProbeFailure(new ArtifactSink(root), "synthetic-token", {
      status: 0,
      stdout: '{"httpStatus":200}',
      stderr: "",
    });
    expect(fs.existsSync(path.join(root, "portable-hermes-gateway-probe-failure.json"))).toBe(
      false,
    );
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

it("records an mTLS Health probe failure without a sandbox bearer token", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mtls-probe-"));
  try {
    await recordPortableHermesGatewayProbeFailure(new ArtifactSink(root), "", {
      status: 2,
      stdout: '{"error":"connection refused"}',
      stderr: "Health probe could not reach the gateway",
    });
    const evidence = JSON.parse(
      fs.readFileSync(path.join(root, "portable-hermes-gateway-probe-failure.json"), "utf-8"),
    );
    expect(evidence).toEqual({
      schemaVersion: 1,
      status: 2,
      stdoutTail: '{"error":"connection refused"}',
      stderrTail: "Health probe could not reach the gateway",
    });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
