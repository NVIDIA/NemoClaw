// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { managedImageOpenShellProbe } from "../../../scripts/checks/run-managed-image-openshell-e2e.ts";

const OPENCLAW_HEALTH_URL = "http://127.0.0.1:18789/health";

function openClawHealthFragment(endpoint: string): string {
  const probe = managedImageOpenShellProbe("openclaw");
  const assignmentMarker = 'openclaw_health_code="';
  const assignmentOffset = probe.indexOf(assignmentMarker);
  const caseEndMarker = "\nesac";
  const caseEndOffset = probe.indexOf(caseEndMarker, assignmentOffset);
  const stepStartOffset = probe.lastIndexOf("if ! {", assignmentOffset);
  const stepEndMarker = "\nfi";
  const stepEndOffset = probe.indexOf(stepEndMarker, caseEndOffset);
  expect(assignmentOffset).toBeGreaterThanOrEqual(0);
  expect(caseEndOffset).toBeGreaterThan(assignmentOffset);
  expect(stepStartOffset).toBeGreaterThanOrEqual(0);
  expect(stepEndOffset).toBeGreaterThan(caseEndOffset);
  expect(probe).toContain(`-w '%{http_code}'`);
  expect(probe).toContain(OPENCLAW_HEALTH_URL);
  return probe
    .slice(stepStartOffset, stepEndOffset + stepEndMarker.length)
    .replace(OPENCLAW_HEALTH_URL, endpoint);
}

function runOpenClawHealthProbe(endpoint: string) {
  return new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const child = spawn("/bin/sh", ["-c", `set -eu\n${openClawHealthFragment(endpoint)}`], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

async function withHealthStatus<T>(statusCode: number, run: (endpoint: string) => Promise<T>) {
  const server = createServer((_request, response) => {
    response.writeHead(statusCode).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}/health`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("protected managed-image OpenClaw health probe", () => {
  it.each([200, 401])("accepts HTTP %s as authoritative gateway readiness", async (code) => {
    const result = await withHealthStatus(code, runOpenClawHealthProbe);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects HTTP 500 with an exact diagnostic", async () => {
    const result = await withHealthStatus(500, runOpenClawHealthProbe);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("OpenClaw /health returned HTTP 500\n");
  });

  it("reports transport failure as HTTP 000", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );

    const result = await runOpenClawHealthProbe(`http://127.0.0.1:${address.port}/health`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OpenClaw /health returned HTTP 000\n");
  });
});
