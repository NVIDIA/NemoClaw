// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { redactFullWithUrls } from "../security/redact";
import { createOpenshellCliHelpers } from "./openshell-cli";

it("binds typed gateway capabilities to the onboarding executable", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-capabilities-"));
  try {
    const binary = path.join(directory, "openshell");
    fs.writeFileSync(
      binary,
      `#!/bin/sh
case "$*" in
  'gateway select nemoclaw-8091') exit 0 ;;
  'status -g nemoclaw-8091') printf 'Gateway: nemoclaw-8091\\nStatus: Connected\\nServer: http://127.0.0.1:8091/\\n'; exit 0 ;;
  'gateway list -o json') printf '[{"name":"nemoclaw-8091","endpoint":"http://127.0.0.1:8091","active":true}]'; exit 0 ;;
esac
exit 91
`,
      { mode: 0o700 },
    );
    const helpers = createOpenshellCliHelpers({
      getCachedBinary: () => binary,
      setCachedBinary: vi.fn(),
      getGatewayPort: () => 8091,
      getDockerDriverGatewayEndpoint: () => "http://127.0.0.1:8091",
    });
    const target = { kind: "named", gatewayName: "nemoclaw-8091" } as const;
    expect(await helpers.gatewayLifecycleAdapter.selectGateway({ target })).toEqual({
      ok: true,
      state: "completed",
    });
    expect(
      await helpers.gatewayReuseAdapter.observeGatewayReuse({ target, expectedGatewayPort: 8091 }),
    ).toMatchObject({ namedMetadata: true, endpointBinding: "match" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("forwards host interruption to an onboarding route mutation and removes listeners", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-route-signal-"));
  const pidFile = path.join(directory, "child.pid");
  const beforeTerm = process.listeners("SIGTERM");
  const beforeInt = process.listeners("SIGINT");
  try {
    const binary = path.join(directory, "openshell");
    fs.writeFileSync(
      binary,
      `#!/bin/sh
echo $$ > ${JSON.stringify(pidFile)}
trap 'exit 0' TERM INT
while :; do sleep 1; done
`,
      { mode: 0o700 },
    );
    const helpers = createOpenshellCliHelpers({
      getCachedBinary: () => binary,
      setCachedBinary: vi.fn(),
      getGatewayPort: () => 8091,
      getDockerDriverGatewayEndpoint: () => "http://127.0.0.1:8091",
    });
    const pending = helpers.inferenceRouteMutator.setInferenceRoute({
      target: { kind: "named", gatewayName: "nemoclaw-8091" },
      route: { provider: "openai-api", model: "gpt-test" },
      verification: "skip",
      timeoutMs: 5_000,
    });
    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true));
    const forwardedTerm = process
      .listeners("SIGTERM")
      .find((listener) => !beforeTerm.includes(listener));
    expect(forwardedTerm).toBeTypeOf("function");
    forwardedTerm?.("SIGTERM");

    await expect(pending).resolves.toMatchObject({
      ok: false,
      ambiguous: true,
      error: { kind: "timeout" },
    });
    const childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(process.listeners("SIGTERM")).toEqual(beforeTerm);
    expect(process.listeners("SIGINT")).toEqual(beforeInt);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("fully redacts credentials and credential-bearing URLs from route failures", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-route-redaction-"));
  try {
    const binary = path.join(directory, "openshell");
    fs.writeFileSync(
      binary,
      `#!/bin/sh
printf '%s\n' 'NVIDIA_API_KEY=nvapi-route-secret https://route-user:route-password@gateway.example.test/v1?token=route-query-secret' >&2
exit 17
`,
      { mode: 0o700 },
    );
    const helpers = createOpenshellCliHelpers({
      getCachedBinary: () => binary,
      setCachedBinary: vi.fn(),
      getGatewayPort: () => 8091,
      getDockerDriverGatewayEndpoint: () => "http://127.0.0.1:8091",
      redactDiagnostic: redactFullWithUrls,
    });

    const result = await helpers.inferenceRouteMutator.setInferenceRoute({
      target: { kind: "named", gatewayName: "nemoclaw-8091" },
      route: { provider: "openai-api", model: "gpt-test" },
      verification: "skip",
    });
    const diagnostic = JSON.stringify(result);

    expect(result).toMatchObject({
      ok: false,
      ambiguous: false,
      error: { kind: "command", reason: "failed", exitCode: 17 },
    });
    expect(diagnostic).toContain("NVIDIA_API_KEY=<REDACTED>");
    expect(diagnostic).not.toContain("nvap");
    expect(diagnostic).not.toContain("route-user");
    expect(diagnostic).not.toContain("route-password");
    expect(diagnostic).not.toContain("route-query-secret");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
