// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero as expectExitZero, resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "../fixtures/mcp-bridge-credentials.ts";

const SERVER_NAME = "fake";
const HOST_SECRET = MCP_BRIDGE_TEST_CREDENTIALS.host;
const ROTATED_HOST_SECRET = MCP_BRIDGE_TEST_CREDENTIALS.rotatedHost;
const INSPECTION_CONTROL_MARKER = "MCP_INSPECT_FORGED_CONTROL_LINE";
const REGISTRY_FILE = path.join(process.env.HOME ?? os.homedir(), ".nemoclaw", "sandboxes.json");

export async function assertHermesConfig(
  sandbox: SandboxClient,
  sandboxName: string,
  mcpUrl: string,
): Promise<void> {
  const script = [
    "set -eu",
    "/opt/hermes/.venv/bin/python - <<'PY'",
    "import pathlib, yaml",
    "path = pathlib.Path('/sandbox/.hermes/config.yaml')",
    "text = path.read_text(encoding='utf-8')",
    "data = yaml.safe_load(text) or {}",
    `entry = data['mcp_servers'][${JSON.stringify(SERVER_NAME)}]`,
    `assert entry['url'] == ${JSON.stringify(mcpUrl)}`,
    "assert entry['headers']['Authorization'] == 'Bearer openshell:resolve:env:FAKE_MCP_SECRET'",
    `assert ${JSON.stringify(HOST_SECRET)} not in text`,
    "PY",
  ].join("\n");
  const result = await sandbox.execShell(sandboxName, trustedSandboxShellScript(script), {
    artifactName: "hermes-mcp-config-assertions",
    env: buildAvailabilityProbeEnv(),
    redactionValues: [HOST_SECRET, Buffer.from(script, "utf8").toString("base64")],
    timeoutMs: 60_000,
  });
  expectExitZero(result, "Hermes MCP config contains placeholder and no raw host secret");
}

// No host `nemoclaw mcp inspect` command exists; exercise the packaged CLI
// through the same OpenShell sandbox boundary used by live MCP reconciliation.
export async function assertHermesInspectionRejectsUnmanagedFields(
  sandbox: SandboxClient,
  sandboxName: string,
): Promise<void> {
  const payload = Buffer.from(
    JSON.stringify({
      present: {
        [SERVER_NAME]: {
          command: [HOST_SECRET, `\u001b[31m${INSPECTION_CONTROL_MARKER}\u001b[0m`],
          transport: `stdio\r\n${ROTATED_HOST_SECRET}`,
        },
      },
      absent: [],
    }),
    "utf8",
  ).toString("base64");
  const script = [
    "set -eu",
    `payload="$(printf '%s' '${payload}' | base64 -d)"`,
    '/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py inspect --payload "$payload"',
  ].join("\n");
  const result = await sandbox.execShell(sandboxName, trustedSandboxShellScript(script), {
    artifactName: "hermes-mcp-inspect-rejects-unmanaged-fields",
    env: buildAvailabilityProbeEnv(),
    redactionValues: [
      HOST_SECRET,
      ROTATED_HOST_SECRET,
      payload,
      Buffer.from(script, "utf8").toString("base64"),
    ],
    timeoutMs: 60_000,
  });
  const output = resultText(result);
  expect(result.exitCode, `malformed Hermes MCP inspection must fail\n${output}`).not.toBe(0);
  expect(output).toContain("Hermes MCP inspection expected config has invalid fields");
  expect(output).not.toContain(HOST_SECRET);
  expect(output).not.toContain(ROTATED_HOST_SECRET);
  expect(output).not.toContain(INSPECTION_CONTROL_MARKER);
  expect(output).not.toContain("\u001b");
  expect(output).not.toContain("\r");
}

/**
 * Prove the removal tombstone survives an actual supervisor-mediated Hermes
 * gateway restart. A successful post-restart `mcp list` runs the in-sandbox
 * integrity inspector against the empty registry projection, so it covers the
 * current intended/applied digest and the absence of the retired server in the
 * config used by the newly healthy gateway.
 */
export async function assertHermesRemovalSurvivesGatewayRestart(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
): Promise<void> {
  expect(fs.existsSync(REGISTRY_FILE), `registry file not found: ${REGISTRY_FILE}`).toBe(true);
  const registryRaw = fs.readFileSync(REGISTRY_FILE, "utf8");
  expect(registryRaw).not.toContain(HOST_SECRET);
  expect(registryRaw).not.toContain(ROTATED_HOST_SECRET);
  const registry = JSON.parse(registryRaw) as {
    sandboxes?: Record<
      string,
      { mcp?: { bridges?: Record<string, unknown>; managedServerNames?: string[] } }
    >;
  };
  const mcpState = registry.sandboxes?.[sandboxName]?.mcp;
  expect(mcpState?.bridges, "removed Hermes bridge must leave no active registry intent").toEqual(
    {},
  );
  expect(
    mcpState?.managedServerNames,
    "removed Hermes bridge must retain its managed-name tombstone",
  ).toContain(SERVER_NAME);

  const restart = await host.nemoclaw([sandboxName, "gateway", "restart"], {
    artifactName: "hermes-mcp-removal-gateway-restart",
    env: buildAvailabilityProbeEnv(),
    redactionValues: [HOST_SECRET, ROTATED_HOST_SECRET],
    timeoutMs: 12 * 60_000,
  });
  expectExitZero(restart, "Hermes gateway restart after managed MCP removal");
  expect(resultText(restart)).toContain("Gateway restarted");
  expect(resultText(restart)).toContain("health passed");
  expect(resultText(restart)).not.toContain(HOST_SECRET);
  expect(resultText(restart)).not.toContain(ROTATED_HOST_SECRET);

  const list = await host.nemoclaw([sandboxName, "mcp", "list", "--json"], {
    artifactName: "hermes-mcp-list-after-removal-gateway-restart",
    env: buildAvailabilityProbeEnv(),
    redactionValues: [HOST_SECRET, ROTATED_HOST_SECRET],
    timeoutMs: 60_000,
  });
  expectExitZero(list, "Hermes MCP list after removal gateway restart");
  expect(JSON.parse(list.stdout).bridges).toEqual([]);
  expect(resultText(list)).not.toContain(HOST_SECRET);
  expect(resultText(list)).not.toContain(ROTATED_HOST_SECRET);

  const config = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      [
        "set -eu",
        '/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py inspect --payload \'{"present":{},"absent":["fake"]}\'',
      ].join("\n"),
    ),
    {
      artifactName: "hermes-mcp-effective-config-after-removal-gateway-restart",
      env: buildAvailabilityProbeEnv(),
      redactionValues: [HOST_SECRET, ROTATED_HOST_SECRET],
      timeoutMs: 60_000,
    },
  );
  expectExitZero(config, "Hermes effective MCP config after removal gateway restart");
  expect(config.stdout).toContain('"state": "matched"');
  expect(resultText(config)).not.toContain(HOST_SECRET);
  expect(resultText(config)).not.toContain(ROTATED_HOST_SECRET);
}
