// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { testTimeout } from "../../helpers/timeouts";
import {
  buildRawOpenShellAllowedIpsRebindingPolicy,
  buildRawOpenShellAllowedIpsRebindingProbeScript,
  RAW_OPENSHELL_REBIND_HOSTNAME,
  RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER,
  RAW_OPENSHELL_REBIND_PINNED_IP,
  RAW_OPENSHELL_REBIND_POLICY_KEY,
} from "../live/openshell-allowed-ips-rebinding.ts";

const SUITE_OPTIONS = { timeout: testTimeout(15_000) };
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

function fakeCurlPath(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-raw-rebind-"));
  tempDirs.push(tempDir);
  const curl = path.join(tempDir, "curl");
  fs.writeFileSync(
    curl,
    '#!/bin/sh\nprintf %s "${FAKE_HTTP_STATUS:-000}"\nexit "${FAKE_CURL_RC:-0}"\n',
    { mode: 0o755 },
  );
  return tempDir;
}

describe("raw OpenShell allowed_ips rebinding contract", SUITE_OPTIONS, () => {
  it("adds one raw MCP policy with an exact public IP pin and no adapter identity", () => {
    const rendered = buildRawOpenShellAllowedIpsRebindingPolicy(
      `version: 1
filesystem_policy:
  include_workdir: true
network_policies:
  existing:
    name: existing
    endpoints: []
    binaries: []
`,
      31337,
    );
    const parsed = YAML.parse(rendered) as {
      network_policies: Record<
        string,
        {
          binaries: Array<{ path: string }>;
          endpoints: Array<Record<string, unknown>>;
        }
      >;
    };

    expect(parsed.network_policies.existing).toBeDefined();
    const raw = parsed.network_policies[RAW_OPENSHELL_REBIND_POLICY_KEY];
    expect(raw.binaries).toEqual([{ path: "/**" }]);
    expect(raw.endpoints).toEqual([
      expect.objectContaining({
        allowed_ips: [RAW_OPENSHELL_REBIND_PINNED_IP],
        host: RAW_OPENSHELL_REBIND_HOSTNAME,
        path: "/mcp",
        port: 31337,
        protocol: "mcp",
        rules: [{ allow: { method: "tools/list" } }],
      }),
    ]);
  });

  it("passes only an exact HTTP 403 and rejects an allowed response", () => {
    const binDir = fakeCurlPath();
    const script = buildRawOpenShellAllowedIpsRebindingProbeScript(
      `http://${RAW_OPENSHELL_REBIND_HOSTNAME}:31337/mcp`,
    );
    const run = (status: string, curlRc = "0") =>
      spawnSync("/bin/bash", ["-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_CURL_RC: curlRc,
          FAKE_HTTP_STATUS: status,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      });

    const denied = run("403");
    expect(denied.status, denied.stderr).toBe(0);
    expect(denied.stdout).toContain(`${RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER}403`);

    const allowed = run("200");
    expect(allowed.status).toBe(1);
    expect(allowed.stdout).toContain(`${RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER}200`);

    const transportFailure = run("000", "7");
    expect(transportFailure.status).toBe(7);
  });

  it("runs in the network-policy lane without calling a NemoClaw MCP adapter", () => {
    const networkPolicySource = fs.readFileSync("test/e2e/live/network-policy.test.ts", "utf8");
    const contractSource = fs.readFileSync(
      "test/e2e/live/openshell-allowed-ips-rebinding.ts",
      "utf8",
    );

    expect(networkPolicySource).toContain("await assertRawOpenShellAllowedIpsRebindingDenied");
    expect(contractSource).toContain('["policy", "set", "--policy"');
    expect(contractSource).toContain("server.requestCount()");
    expect(contractSource).toContain(
      "https://github.com/NVIDIA/OpenShell/blob/8cb16de9eae4c44d7d31e1493747d8c10abb5963/",
    );
    expect(contractSource).not.toContain("host.nemoclaw");
    expect(contractSource).not.toContain("assertAdapterDnsRebindingDenied");
  });
});
