// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero as expectExitZero, resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "../fixtures/mcp-bridge-credentials.ts";
import { buildMcpCredentialHandleAuthorizationPattern } from "./mcp-provider-rewrite-probe.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { cleanupMcpBridge } from "./mcp-bridge-cleanup.ts";
import { addBridgeAndReadStatus } from "./mcp-bridge-reliability.ts";
import { startFakeMcpHttpsServer, startPublicMcpHttpsTunnel } from "./mcp-bridge-servers.ts";

const SERVER_NAME = "fake";
const HOST_SECRET = MCP_BRIDGE_TEST_CREDENTIALS.host;
const ROTATED_HOST_SECRET = MCP_BRIDGE_TEST_CREDENTIALS.rotatedHost;
const INSPECTION_CONTROL_MARKER = "MCP_INSPECT_FORGED_CONTROL_LINE";

export async function assertHermesConfig(
  sandbox: SandboxClient,
  sandboxName: string,
  mcpUrl: string,
): Promise<void> {
  const authorizationPattern = buildMcpCredentialHandleAuthorizationPattern("FAKE_MCP_SECRET");
  const script = [
    "set -eu",
    "/opt/hermes/.venv/bin/python - <<'PY'",
    "import pathlib, re, yaml",
    "path = pathlib.Path('/sandbox/.hermes/config.yaml')",
    "text = path.read_text(encoding='utf-8')",
    "data = yaml.safe_load(text) or {}",
    `entry = data['mcp_servers'][${JSON.stringify(SERVER_NAME)}]`,
    `assert entry['url'] == ${JSON.stringify(mcpUrl)}`,
    "authorization = entry['headers']['Authorization']",
    `assert re.fullmatch(r${JSON.stringify(authorizationPattern)}, authorization)`,
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

/**
 * Focused #7499 live regression after the supported managed add has executed
 * the real unprivileged Hermes transaction: restart the real gateway, then
 * prove the strict baseline remains root-owned while the compatibility hash
 * matches the managed config and transaction state.
 */
export async function assertHermesManagedAddSurvivesGatewayRestartAndStateLayout(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
  mcpUrl: string,
): Promise<void> {
  const restart = await host.nemoclaw([sandboxName, "gateway", "restart"], {
    artifactName: "hermes-mcp-add-gateway-restart",
    env: buildAvailabilityProbeEnv(),
    redactionValues: [HOST_SECRET, ROTATED_HOST_SECRET],
    timeoutMs: 12 * 60_000,
  });
  expectExitZero(restart, "Hermes gateway restart with managed MCP present");
  expect(resultText(restart)).toContain("Gateway restarted");
  expect(resultText(restart)).toContain("health passed");

  const compatibilityIntegrity = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      [
        "set -u",
        "echo HERMES_MCP_STRICT_HASH",
        "cat /etc/nemoclaw/hermes.config-hash",
        "echo HERMES_MCP_COMPAT_HASH",
        "cat /sandbox/.hermes/.config-hash",
        "strict_status=0; sha256sum -c /etc/nemoclaw/hermes.config-hash || strict_status=$?",
        "compat_status=0; sha256sum -c /sandbox/.hermes/.config-hash || compat_status=$?",
        'printf "HERMES_MCP_HASH_STATUS strict=%s compat=%s\\n" "$strict_status" "$compat_status"',
        "set -e",
        'test "$(stat -c \'%u:%g:%a\' /etc/nemoclaw/hermes.config-hash)" = "0:0:444"',
        "! cmp -s /etc/nemoclaw/hermes.config-hash /sandbox/.hermes/.config-hash",
        'test "$strict_status" -ne 0',
        'test "$compat_status" -eq 0',
        "echo HERMES_MCP_COMPAT_INTEGRITY_CURRENT",
      ].join("\n"),
    ),
    {
      artifactName: "hermes-mcp-compat-integrity-after-add-gateway-restart",
      env: buildAvailabilityProbeEnv(),
      redactionValues: [HOST_SECRET, ROTATED_HOST_SECRET],
      timeoutMs: 60_000,
    },
  );
  expectExitZero(
    compatibilityIntegrity,
    "Hermes MCP strict baseline and compatibility integrity after gateway restart",
  );
  expect(compatibilityIntegrity.stdout).toContain("HERMES_MCP_COMPAT_INTEGRITY_CURRENT");

  const list = await host.nemoclaw([sandboxName, "mcp", "list", "--json"], {
    artifactName: "hermes-mcp-list-after-add-gateway-restart",
    env: buildAvailabilityProbeEnv(),
    redactionValues: [HOST_SECRET, ROTATED_HOST_SECRET],
    timeoutMs: 60_000,
  });
  expectExitZero(list, "Hermes MCP list after add gateway restart");
  const listJson = JSON.parse(list.stdout) as {
    bridges: Array<{ server: string; url: string; adapter: { registered: boolean | null } }>;
  };
  expect(listJson.bridges).toEqual([
    expect.objectContaining({
      server: SERVER_NAME,
      url: mcpUrl,
      adapter: expect.objectContaining({ registered: true }),
    }),
  ]);

  const expectedPayload = Buffer.from(
    JSON.stringify({
      present: {
        [SERVER_NAME]: {
          url: mcpUrl,
          headers: {
            Authorization: "Bearer openshell:resolve:env:FAKE_MCP_SECRET",
          },
          timeout: 120,
          connect_timeout: 60,
          tools: { prompts: true, resources: true },
          enabled: true,
        },
      },
      absent: [],
    }),
    "utf8",
  ).toString("base64");
  const effectiveConfig = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      [
        "set -eu",
        `payload="$(printf '%s' '${expectedPayload}' | base64 -d)"`,
        '/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py inspect --payload "$payload"',
      ].join("\n"),
    ),
    {
      artifactName: "hermes-mcp-effective-config-after-add-gateway-restart",
      env: buildAvailabilityProbeEnv(),
      redactionValues: [HOST_SECRET, ROTATED_HOST_SECRET, expectedPayload],
      timeoutMs: 60_000,
    },
  );
  expectExitZero(effectiveConfig, "Hermes effective MCP config after add gateway restart");
  const effectiveConfigJson = JSON.parse(effectiveConfig.stdout) as { state: string };
  expect(effectiveConfigJson.state).toBe("matched");
}

/**
 * Inject a first-reload failure around the packaged transaction helper, then
 * require its real rollback reload to restore the prior config, both integrity
 * anchors, and a healthy managed gateway in the live sandbox.
 */
export async function assertHermesReloadRollback(
  sandbox: SandboxClient,
  sandboxName: string,
  mcpUrl: string,
): Promise<void> {
  const payload = JSON.stringify({
    server: "rollback_probe",
    url: mcpUrl,
    headers: {
      Authorization: "Bearer openshell:resolve:env:FAKE_MCP_SECRET",
    },
    replace_existing: false,
  });
  const inspectionPayload = Buffer.from(
    JSON.stringify({
      present: {
        [SERVER_NAME]: {
          url: mcpUrl,
          headers: {
            Authorization: "Bearer openshell:resolve:env:FAKE_MCP_SECRET",
          },
          timeout: 120,
          connect_timeout: 60,
          tools: { prompts: true, resources: true },
          enabled: true,
        },
      },
      absent: ["rollback_probe"],
    }),
    "utf8",
  ).toString("base64");
  const script = [
    "set -eu",
    "/opt/hermes/.venv/bin/python - <<'PY'",
    "import importlib.util, json, os, pathlib, sys",
    "module_path = '/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py'",
    "spec = importlib.util.spec_from_file_location('nemoclaw_mcp_tx_rollback_e2e', module_path)",
    "assert spec is not None and spec.loader is not None",
    "module = importlib.util.module_from_spec(spec)",
    "sys.modules[spec.name] = module",
    "spec.loader.exec_module(module)",
    `payload = json.loads(${JSON.stringify(payload)})`,
    "paths = (",
    "    pathlib.Path('/sandbox/.hermes/config.yaml'),",
    "    pathlib.Path('/etc/nemoclaw/hermes.config-hash'),",
    "    pathlib.Path('/sandbox/.hermes/.config-hash'),",
    ")",
    "before = {path: path.read_bytes() for path in paths}",
    "if os.geteuid() == 0:",
    "    raise RuntimeError('rollback regression must run as the sandbox identity')",
    "real_reload = module.reload_gateway",
    "reload_calls = 0",
    "rollback_reloaded = None",
    "def fail_then_reload():",
    "    global reload_calls, rollback_reloaded",
    "    reload_calls += 1",
    "    if reload_calls == 1:",
    "        raise RuntimeError('injected first managed reload failure')",
    "    rollback_reloaded = real_reload()",
    "    return rollback_reloaded",
    "module.reload_gateway = fail_then_reload",
    "try:",
    "    module.execute('add', payload)",
    "except RuntimeError as error:",
    "    failure = str(error)",
    "else:",
    "    raise RuntimeError('injected managed reload failure unexpectedly succeeded')",
    "if reload_calls != 2:",
    "    raise RuntimeError(f'rollback performed {reload_calls} reload attempts instead of 2')",
    "if 'injected first managed reload failure' not in failure:",
    "    raise RuntimeError('transaction did not report the injected reload failure')",
    "if rollback_reloaded is not True:",
    "    raise RuntimeError('rollback did not restore a healthy managed gateway')",
    "after = {path: path.read_bytes() for path in paths}",
    "if after != before:",
    "    raise RuntimeError('rollback did not restore config and both hash anchors exactly')",
    "PY",
    `inspection_payload="$(printf '%s' '${inspectionPayload}' | base64 -d)"`,
    '/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py inspect --payload "$inspection_payload"',
  ].join("\n");
  const result = await sandbox.execShell(sandboxName, trustedSandboxShellScript(script), {
    artifactName: "hermes-mcp-failed-reload-rollback",
    env: buildAvailabilityProbeEnv(),
    redactionValues: [
      HOST_SECRET,
      ROTATED_HOST_SECRET,
      inspectionPayload,
      Buffer.from(script, "utf8").toString("base64"),
    ],
    timeoutMs: 7 * 60_000,
  });
  expectExitZero(result, "Hermes failed MCP reload restores config, hashes, and gateway");
  expect(JSON.parse(result.stdout)).toEqual({
    ok: true,
    state: "matched",
  });
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

// Live proof for #12594: a retained Hermes MCP entry keeps working after
// another provider advances the provider environment and the sandbox restarts
// without MCP re-registration.
const REVISION_SERVER_NAME = "revision";
const REVISION_CREDENTIAL_ENV = "REVISION_MCP_SECRET";
const HANDLE_PATTERN = "openshell:resolve:env:[vs][0-9]*_FAKE_MCP_SECRET";

type FakeMcpServer = Awaited<ReturnType<typeof startFakeMcpHttpsServer>>;

/** Fail when a listed secret appears under any listed sandbox path. */
export async function assertSecretAbsentFromSandbox(
  sandbox: SandboxClient,
  sandboxName: string,
  paths: string[],
  secrets: string[] = [HOST_SECRET],
  artifactName = "assert-secret-absent-from-sandbox",
): Promise<void> {
  const script = [
    "set -eu",
    ...secrets.map(
      (secret) => `! grep -R ${JSON.stringify(secret)} ${paths.join(" ")} 2>/dev/null`,
    ),
  ].join("\n");
  const result = await sandbox.execShell(sandboxName, trustedSandboxShellScript(script), {
    artifactName,
    env: buildAvailabilityProbeEnv(),
    redactionValues: [...secrets, Buffer.from(script, "utf8").toString("base64")],
    timeoutMs: 60_000,
  });
  expectExitZero(result, "host MCP secret must not appear in sandbox files");
}

// Diagnostic evidence only: the authenticated tool call proves the rebinding.
async function recordFakeAuthorizationHandle(
  sandbox: SandboxClient,
  sandboxName: string,
  artifactName: string,
): Promise<void> {
  await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(`grep -o '${HANDLE_PATTERN}' /sandbox/.hermes/config.yaml || true`),
    { artifactName, env: buildAvailabilityProbeEnv(), timeoutMs: 60_000 },
  );
}

export async function assertHermesMcpHandleSurvivesProviderRevisionRestart(options: {
  host: HostCliClient;
  sandbox: SandboxClient;
  cleanup: CleanupRegistry;
  progress: Parameters<typeof startPublicMcpHttpsTunnel>[0]["progress"];
  sandboxName: string;
  assertToolCall: (artifactName: string, otherEndpoint: FakeMcpServer) => Promise<void>;
}): Promise<void> {
  const { host, sandbox, sandboxName } = options;
  const revisionMcp = await startFakeMcpHttpsServer({ secret: ROTATED_HOST_SECRET });
  options.cleanup.add("stop Hermes revision MCP HTTPS server", () => revisionMcp.close());
  const revisionTunnel = await startPublicMcpHttpsTunnel({
    cleanup: options.cleanup,
    label: "Hermes revision MCP HTTPS server",
    progress: options.progress,
    server: revisionMcp,
  });
  await recordFakeAuthorizationHandle(
    sandbox,
    sandboxName,
    "hermes-revision-restart-handle-before",
  );
  await addBridgeAndReadStatus(host, sandbox, {
    sandboxName,
    mcpUrl: revisionTunnel.url,
    expectedAdapter: "hermes-config",
    artifactPrefix: "hermes-revision-restart",
    credential: ROTATED_HOST_SECRET,
    serverName: REVISION_SERVER_NAME,
    credentialEnvName: REVISION_CREDENTIAL_ENV,
  });
  await recordFakeAuthorizationHandle(sandbox, sandboxName, "hermes-revision-restart-handle-added");
  const gateway = process.env.OPENSHELL_GATEWAY ?? "nemoclaw";
  const env = buildAvailabilityProbeEnv();
  const stop = await sandbox.openshell(["sandbox", "stop", "-g", gateway, sandboxName], {
    artifactName: "hermes-revision-restart-openshell-stop",
    env,
    timeoutMs: 120_000,
  });
  const start = await sandbox.openshell(["sandbox", "start", "-g", gateway, sandboxName], {
    artifactName: "hermes-revision-restart-openshell-start",
    env,
    timeoutMs: 300_000,
  });
  expect(
    stop.exitCode === 0 && start.exitCode === 0,
    `${resultText(stop)}\n${resultText(start)}`,
  ).toBe(true);
  const ready = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      [
        "attempt=0",
        'while [ "$attempt" -lt 36 ]; do',
        "  curl -q --noproxy '*' -sf --max-time 5 http://127.0.0.1:8642/health >/dev/null && exit 0",
        "  attempt=$((attempt + 1)); sleep 5",
        "done",
        "exit 1",
      ].join("\n"),
    ),
    { artifactName: "hermes-revision-restart-native-ready", env, timeoutMs: 240_000 },
  );
  expectExitZero(ready, "Hermes native gateway readiness after stop and start");
  await recordFakeAuthorizationHandle(sandbox, sandboxName, "hermes-revision-restart-handle-after");
  await options.assertToolCall(
    "hermes-real-mcp-tool-call-after-provider-revision-restart",
    revisionMcp,
  );
  await assertSecretAbsentFromSandbox(
    sandbox,
    sandboxName,
    ["/sandbox/.hermes", "/tmp/nemoclaw-start.log"],
    [HOST_SECRET, ROTATED_HOST_SECRET],
    "hermes-assert-secrets-absent-after-provider-revision-restart",
  );
  // Later steps expect only the original server, so remove this one now.
  await cleanupMcpBridge(host, sandboxName, REVISION_SERVER_NAME, "hermes-config");
}
