// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildMcpCredentialDetachedCommand,
  buildMcpCredentialRevisionObservationCommand,
} from "../../../src/lib/actions/sandbox/mcp-bridge-provider-readiness.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertCleanupSucceededOrAbsent } from "../fixtures/cleanup-resources.ts";
import { assertExitZero as expectExitZero, resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "../fixtures/mcp-bridge-credentials.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { hostAddressForSandbox } from "./mcp-bridge-sandbox.ts";
import {
  type FakeMcpHttpsServer,
  startCompatibleMock,
  startFakeMcpHttpsServer,
  startPublicMcpHttpsTunnel,
} from "./mcp-bridge-servers.ts";
import {
  buildCredentialWindowChildScript,
  buildCredentialWindowOneShotScript,
  buildCredentialWindowProviderUpdateArgs,
  CREDENTIAL_WINDOW_ENV_NAME,
  CREDENTIAL_WINDOW_EXPIRY_DELAY_MS,
  CREDENTIAL_WINDOW_PATHS,
  CREDENTIAL_WINDOW_REQUEST_PREFIX,
  CREDENTIAL_WINDOW_ROTATION_COUNT,
  CREDENTIAL_WINDOW_STEPS,
  type CredentialWindowRequestStep,
  credentialWindowRequestId,
  credentialWindowSecrets,
  OPENSHELL_RETAINED_CREDENTIAL_GENERATIONS,
} from "./openshell-credential-generation-window.ts";

const SANDBOX_NAME = "e2e-mcp-credential-window";
const SERVER_NAME = "fake";
const COMPATIBLE_KEY = MCP_BRIDGE_TEST_CREDENTIALS.compatibleEndpoint;
const COMPATIBLE_MODEL = "mock/mcp-credential-window";
const BRIDGE_ALREADY_ABSENT =
  /No MCP servers are registered|No MCP server '.+' is registered|MCP server '.+' not found/iu;

interface CredentialWindowRequest {
  readonly auth: string;
  readonly body: string;
}

interface CredentialWindowChildResult {
  readonly revision: string;
  readonly outcomes: Array<{ step: string; outcome: string }>;
}

function openshellEnv(): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
}

function requestId(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { id?: unknown };
    return typeof parsed.id === "string" ? parsed.id : null;
  } catch {
    return null;
  }
}

function parseLastJsonLine<T>(output: string): T {
  return JSON.parse(output.trim().split(/\r?\n/u).at(-1) ?? "") as T;
}

function requestEvidence(
  fakeMcp: FakeMcpHttpsServer,
  id: string,
  expectedSecret: string,
): { seen: boolean; credentialRewritten: boolean; placeholderAbsent: boolean } {
  const request = fakeMcp.requests.find((candidate) => requestId(candidate.body) === id);
  return {
    seen: request !== undefined,
    credentialRewritten: request?.auth === `Bearer ${expectedSecret}`,
    placeholderAbsent: !request?.auth.includes("openshell:resolve:env"),
  };
}

async function cleanupBridge(host: HostCliClient): Promise<void> {
  const result = await host.nemoclaw([SANDBOX_NAME, "mcp", "remove", SERVER_NAME, "--force"], {
    artifactName: "cleanup-credential-window-mcp-bridge",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 4 * 60_000,
  });
  assertCleanupSucceededOrAbsent(result, BRIDGE_ALREADY_ABSENT, "cleanup credential-window MCP");
}

async function observeFreshRevision(sandbox: SandboxClient, artifactName: string): Promise<string> {
  const result = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
      buildMcpCredentialRevisionObservationCommand(CREDENTIAL_WINDOW_ENV_NAME),
    ),
    {
      artifactName,
      env: openshellEnv(),
      timeoutMs: 60_000,
    },
  );
  expectExitZero(result, artifactName);
  const revision = result.stdout.trim();
  expect(revision, `${artifactName} must return only a bounded revision`).toMatch(
    /^v[0-9]{1,20}$/u,
  );
  return revision;
}

async function observeDistinctFreshRevision(
  sandbox: SandboxClient,
  previousRevision: string,
  artifactName: string,
): Promise<string> {
  let revision = previousRevision;
  await expect
    .poll(
      async () => {
        revision = await observeFreshRevision(sandbox, artifactName);
        return revision;
      },
      {
        interval: 1_000,
        timeout: 60_000,
        message: `${artifactName} distinct credential revision`,
      },
    )
    .not.toBe(previousRevision);
  return revision;
}

async function expectFreshCredentialAbsent(
  sandbox: SandboxClient,
  artifactName: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const result = await sandbox.execShell(
          SANDBOX_NAME,
          trustedSandboxShellScript(buildMcpCredentialDetachedCommand(CREDENTIAL_WINDOW_ENV_NAME)),
          {
            artifactName,
            env: openshellEnv(),
            timeoutMs: 60_000,
          },
        );
        return result.exitCode;
      },
      {
        interval: 1_000,
        timeout: 60_000,
        message: `${artifactName} fresh credential absence`,
      },
    )
    .toBe(0);
}

async function writeControl(
  sandbox: SandboxClient,
  step: string,
  artifactName: string,
): Promise<void> {
  const result = await sandbox.exec(
    SANDBOX_NAME,
    [
      "sh",
      "-c",
      'umask 077; rm -f "$2"; printf "%s\\n" "$3" > "$1"',
      "credential-window-control",
      CREDENTIAL_WINDOW_PATHS.control,
      CREDENTIAL_WINDOW_PATHS.acknowledgement,
      step,
    ],
    {
      artifactName,
      env: openshellEnv(),
      timeoutMs: 60_000,
    },
  );
  expectExitZero(result, artifactName);
}

async function readSandboxFile(
  sandbox: SandboxClient,
  file: string,
  artifactName: string,
): Promise<ShellProbeResult> {
  return sandbox.exec(SANDBOX_NAME, ["cat", file], {
    artifactName,
    env: openshellEnv(),
    timeoutMs: 60_000,
  });
}

async function waitForReadyRevision(sandbox: SandboxClient): Promise<string> {
  await expect
    .poll(
      async () => {
        const result = await readSandboxFile(
          sandbox,
          CREDENTIAL_WINDOW_PATHS.ready,
          "credential-window-old-child-ready-poll",
        );
        return result.exitCode === 0 ? result.stdout.trim() : "";
      },
      {
        interval: 500,
        timeout: 60_000,
        message: "old credential-window child readiness",
      },
    )
    .toMatch(/^\{"revision":"v[0-9]{1,20}"\}$/u);
  const result = await readSandboxFile(
    sandbox,
    CREDENTIAL_WINDOW_PATHS.ready,
    "credential-window-old-child-ready",
  );
  expectExitZero(result, "read old credential-window child revision");
  return (JSON.parse(result.stdout) as { revision: string }).revision;
}

async function waitForAcknowledgement(
  sandbox: SandboxClient,
  step: CredentialWindowRequestStep,
  outcome: "allowed" | "denied",
): Promise<void> {
  const expected = JSON.stringify({ step, outcome });
  await expect
    .poll(
      async () => {
        const result = await readSandboxFile(
          sandbox,
          CREDENTIAL_WINDOW_PATHS.acknowledgement,
          `credential-window-${step}-ack-poll`,
        );
        return result.exitCode === 0 ? result.stdout.trim() : "";
      },
      {
        interval: 500,
        timeout: 90_000,
        message: `old child acknowledgement for ${step}`,
      },
    )
    .toBe(expected);
}

async function rotateCredential(
  host: HostCliClient,
  fakeMcp: FakeMcpHttpsServer,
  secret: string,
  generation: number,
  allSecrets: readonly string[],
): Promise<void> {
  fakeMcp.setSecret(secret);
  const result = await host.nemoclaw([SANDBOX_NAME, "mcp", "restart", SERVER_NAME], {
    artifactName: `credential-window-rotate-${generation}`,
    env: {
      ...buildAvailabilityProbeEnv(),
      [CREDENTIAL_WINDOW_ENV_NAME]: secret,
    },
    redactionValues: [...allSecrets],
    timeoutMs: 4 * 60_000,
  });
  expectExitZero(result, `credential-window rotation ${generation}`);
}

async function updateProviderCredential(
  sandbox: SandboxClient,
  providerName: string,
  secret: string,
  expiresAtMs: number,
  allSecrets: readonly string[],
  artifactName: string,
): Promise<void> {
  const result = await sandbox.openshell(
    buildCredentialWindowProviderUpdateArgs(providerName, expiresAtMs, secret.length === 0),
    {
      artifactName,
      env: {
        ...openshellEnv(),
        ...(secret.length > 0 ? { [CREDENTIAL_WINDOW_ENV_NAME]: secret } : {}),
      },
      redactionValues: [...allSecrets],
      timeoutMs: 90_000,
    },
  );
  expectExitZero(result, artifactName);
  expect(resultText(result)).toMatch(/Updated provider/iu);
}

async function runFreshRequest(
  sandbox: SandboxClient,
  mcpUrl: string,
  id: string,
  allSecrets: readonly string[],
  artifactName: string,
): Promise<{ revision: string; status: number }> {
  const result = await sandbox.exec(
    SANDBOX_NAME,
    ["nemoclaw-start", "node", "-e", buildCredentialWindowOneShotScript(), mcpUrl, id],
    {
      artifactName,
      env: openshellEnv(),
      redactionValues: [...allSecrets],
      timeoutMs: 90_000,
    },
  );
  expectExitZero(result, artifactName);
  return parseLastJsonLine<{
    revision: string;
    status: number;
  }>(result.stdout);
}

test("openshell-credential-generation-window", { timeout: 60 * 60_000 }, async ({
  artifacts,
  cleanup,
  host,
  sandbox,
}) => {
  expect(process.env.NEMOCLAW_OPENSHELL_EXACT_MAIN_PROOF).toBe("1");
  expect(CREDENTIAL_WINDOW_ROTATION_COUNT).toBeGreaterThan(
    OPENSHELL_RETAINED_CREDENTIAL_GENERATIONS,
  );

  const allSecrets = credentialWindowSecrets();
  const initialSecret = allSecrets[0]!;
  const rotationSecrets = allSecrets.slice(1, CREDENTIAL_WINDOW_ROTATION_COUNT + 1);
  const expirySecret = allSecrets.at(-2)!;
  const restartSecret = allSecrets.at(-1)!;
  artifacts.addRedactionValues([COMPATIBLE_KEY, ...allSecrets]);
  await artifacts.target.declare({
    id: "openshell-credential-generation-window",
    contracts: [
      "OpenShell f27ff150 retained credential generations",
      "NemoClaw MCP detach, restart, and rebuild lifecycle",
    ],
    sourceRevision: "3dee5570a46076a57a3b056f35f35ebc0861ac85",
  });

  const compatibleMock = await startCompatibleMock({
    apiKey: COMPATIBLE_KEY,
    model: COMPATIBLE_MODEL,
  });
  cleanup.add("stop credential-window compatible endpoint", () => compatibleMock.close());
  const fakeMcp = await startFakeMcpHttpsServer({ secret: initialSecret });
  cleanup.add("stop credential-window MCP endpoint", () => fakeMcp.close());
  const tunnel = await startPublicMcpHttpsTunnel({
    cleanup,
    label: "credential-window MCP endpoint",
    server: fakeMcp,
  });
  const hostAddress = await hostAddressForSandbox(host);
  const endpointUrl = `http://${hostAddress}:${compatibleMock.port}/v1`;
  await host.cleanupSandbox(SANDBOX_NAME, {
    artifactName: "precleanup-credential-window-sandbox",
    timeoutMs: 15 * 60_000,
  });
  cleanup.trackSandbox(host, SANDBOX_NAME, {
    artifactName: "cleanup-credential-window-sandbox",
    timeoutMs: 15 * 60_000,
  });
  const onboard = await host.nemoclaw(
    ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
    {
      artifactName: "onboard-credential-window-sandbox",
      env: {
        ...buildAvailabilityProbeEnv(),
        COMPATIBLE_API_KEY: COMPATIBLE_KEY,
        NVIDIA_INFERENCE_API_KEY: COMPATIBLE_KEY,
        NEMOCLAW_AGENT: "openclaw",
        NEMOCLAW_ENDPOINT_URL: endpointUrl,
        NEMOCLAW_MODEL: COMPATIBLE_MODEL,
        NEMOCLAW_COMPAT_MODEL: COMPATIBLE_MODEL,
        NEMOCLAW_PREFERRED_API: "openai-completions",
        NEMOCLAW_PROVIDER: "custom",
        NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
        NEMOCLAW_RECREATE_SANDBOX: "1",
      },
      redactionValues: [COMPATIBLE_KEY, ...allSecrets],
      timeoutMs: 20 * 60_000,
    },
  );
  expectExitZero(onboard, "onboard credential-window sandbox");

  const add = await host.nemoclaw(
    [
      SANDBOX_NAME,
      "mcp",
      "add",
      SERVER_NAME,
      "--url",
      tunnel.url,
      "--env",
      CREDENTIAL_WINDOW_ENV_NAME,
    ],
    {
      artifactName: "credential-window-mcp-add",
      env: {
        ...buildAvailabilityProbeEnv(),
        [CREDENTIAL_WINDOW_ENV_NAME]: initialSecret,
      },
      redactionValues: [COMPATIBLE_KEY, ...allSecrets],
      timeoutMs: 4 * 60_000,
    },
  );
  expectExitZero(add, "add credential-window MCP bridge");
  cleanup.add("remove credential-window MCP bridge", () => cleanupBridge(host));

  const status = await host.nemoclaw([SANDBOX_NAME, "mcp", "status", SERVER_NAME, "--json"], {
    artifactName: "credential-window-mcp-status",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expectExitZero(status, "inspect credential-window MCP bridge");
  const providerName = (JSON.parse(status.stdout) as { provider: { name: string } }).provider.name;
  expect(providerName).toMatch(/^e2e-mcp-credential-window-mcp-fake-[a-f0-9]{16}$/u);

  const originalRevision = await observeFreshRevision(
    sandbox,
    "credential-window-initial-fresh-revision",
  );
  const resetControl = await sandbox.exec(
    SANDBOX_NAME,
    [
      "rm",
      "-f",
      CREDENTIAL_WINDOW_PATHS.control,
      CREDENTIAL_WINDOW_PATHS.ready,
      CREDENTIAL_WINDOW_PATHS.acknowledgement,
    ],
    {
      artifactName: "credential-window-reset-control-files",
      env: openshellEnv(),
      timeoutMs: 60_000,
    },
  );
  expectExitZero(resetControl, "reset credential-window control files");

  const expiryAtMs = Date.now() + CREDENTIAL_WINDOW_EXPIRY_DELAY_MS;
  fakeMcp.setSecret(expirySecret);
  await updateProviderCredential(
    sandbox,
    providerName,
    expirySecret,
    expiryAtMs,
    allSecrets,
    "credential-window-install-expiring-generation",
  );
  const expiryRevision = await observeDistinctFreshRevision(
    sandbox,
    originalRevision,
    "credential-window-expiring-fresh-revision",
  );

  const expiryChildPromise = sandbox.exec(
    SANDBOX_NAME,
    ["nemoclaw-start", "node", "-e", buildCredentialWindowChildScript({ mcpUrl: tunnel.url })],
    {
      artifactName: "credential-window-expiry-child",
      env: openshellEnv(),
      redactionValues: [...allSecrets],
      timeoutMs: 6 * 60_000,
    },
  );
  let expiryChildRevision = "";
  let expiryChildResult: ShellProbeResult | undefined;
  let restoredRevision = "";
  try {
    expiryChildRevision = await waitForReadyRevision(sandbox);
    expect(expiryChildRevision).toBe(expiryRevision);
    await writeControl(
      sandbox,
      CREDENTIAL_WINDOW_STEPS.allowedBeforeExpiry,
      "credential-window-signal-before-expiry",
    );
    await waitForAcknowledgement(sandbox, CREDENTIAL_WINDOW_STEPS.allowedBeforeExpiry, "allowed");
    expect(
      requestEvidence(
        fakeMcp,
        credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.allowedBeforeExpiry),
        expirySecret,
      ),
    ).toEqual({
      seen: true,
      credentialRewritten: true,
      placeholderAbsent: true,
    });

    fakeMcp.setSecret(initialSecret);
    await updateProviderCredential(
      sandbox,
      providerName,
      initialSecret,
      0,
      allSecrets,
      "credential-window-clear-expiry-with-current-generation",
    );
    restoredRevision = await observeDistinctFreshRevision(
      sandbox,
      expiryRevision,
      "credential-window-current-revision-before-expiry",
    );
    const currentDuringExpiryId = `${CREDENTIAL_WINDOW_REQUEST_PREFIX}:fresh-current-during-expiry`;
    const currentDuringExpiry = await runFreshRequest(
      sandbox,
      tunnel.url,
      currentDuringExpiryId,
      allSecrets,
      "credential-window-fresh-current-during-expiry",
    );
    expect(currentDuringExpiry).toEqual({
      revision: restoredRevision,
      status: 200,
    });
    expect(requestEvidence(fakeMcp, currentDuringExpiryId, initialSecret)).toEqual({
      seen: true,
      credentialRewritten: true,
      placeholderAbsent: true,
    });

    await expect
      .poll(() => Date.now(), {
        interval: 500,
        timeout: CREDENTIAL_WINDOW_EXPIRY_DELAY_MS + 30_000,
        message: "retained credential generation expiry deadline",
      })
      .toBeGreaterThan(expiryAtMs);
    await writeControl(
      sandbox,
      CREDENTIAL_WINDOW_STEPS.deniedAfterExpiry,
      "credential-window-signal-after-expiry",
    );
    await waitForAcknowledgement(sandbox, CREDENTIAL_WINDOW_STEPS.deniedAfterExpiry, "denied");
    expect(
      requestEvidence(
        fakeMcp,
        credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.deniedAfterExpiry),
        initialSecret,
      ).seen,
    ).toBe(false);
  } finally {
    await writeControl(
      sandbox,
      CREDENTIAL_WINDOW_STEPS.stop,
      "credential-window-stop-expiry-child",
    ).catch(() =>
      host.bestEffortCleanupSandbox(SANDBOX_NAME, {
        artifactName: "credential-window-expiry-stop-fallback-destroy",
        timeoutMs: 15 * 60_000,
      }),
    );
    expiryChildResult = await expiryChildPromise;
  }

  expect(expiryChildResult).toBeDefined();
  expectExitZero(expiryChildResult!, "retained-expiry credential-window child");
  expect(parseLastJsonLine<CredentialWindowChildResult>(expiryChildResult!.stdout)).toEqual({
    revision: expiryChildRevision,
    outcomes: [
      {
        step: CREDENTIAL_WINDOW_STEPS.allowedBeforeExpiry,
        outcome: "allowed",
      },
      {
        step: CREDENTIAL_WINDOW_STEPS.deniedAfterExpiry,
        outcome: "denied",
      },
    ],
  });

  const clearExpiryControl = await sandbox.exec(
    SANDBOX_NAME,
    [
      "rm",
      "-f",
      CREDENTIAL_WINDOW_PATHS.control,
      CREDENTIAL_WINDOW_PATHS.ready,
      CREDENTIAL_WINDOW_PATHS.acknowledgement,
    ],
    {
      artifactName: "credential-window-reset-after-expiry",
      env: openshellEnv(),
      timeoutMs: 60_000,
    },
  );
  expectExitZero(clearExpiryControl, "reset credential-window controls after expiry proof");

  const oldChildPromise = sandbox.exec(
    SANDBOX_NAME,
    ["nemoclaw-start", "node", "-e", buildCredentialWindowChildScript({ mcpUrl: tunnel.url })],
    {
      artifactName: "credential-window-old-child",
      env: openshellEnv(),
      redactionValues: [...allSecrets],
      timeoutMs: 42 * 60_000,
    },
  );
  let oldChildRevision = "";
  let oldChildResult: ShellProbeResult | undefined;
  let restartedRevision = "";
  const observedRevisions = [restoredRevision];
  try {
    oldChildRevision = await waitForReadyRevision(sandbox);
    expect(oldChildRevision).toBe(restoredRevision);
    for (const [index, secret] of rotationSecrets.entries()) {
      await rotateCredential(host, fakeMcp, secret, index + 1, allSecrets);
      observedRevisions.push(
        await observeFreshRevision(sandbox, `credential-window-fresh-revision-${index + 1}`),
      );
    }
    expect(new Set(observedRevisions).size).toBe(CREDENTIAL_WINDOW_ROTATION_COUNT + 1);
    const currentRevision = observedRevisions.at(-1)!;
    expect(currentRevision).not.toBe(oldChildRevision);
    await artifacts.writeJson("credential-window-revisions.json", {
      expiryAtMs,
      expiryRevision,
      oldChildRevision,
      observedRevisions,
      restoredRevision,
      retainedGenerations: OPENSHELL_RETAINED_CREDENTIAL_GENERATIONS,
      rotations: CREDENTIAL_WINDOW_ROTATION_COUNT,
    });

    const rotatedSecret = rotationSecrets.at(-1)!;
    await writeControl(
      sandbox,
      CREDENTIAL_WINDOW_STEPS.fallbackAfterEviction,
      "credential-window-signal-fallback-after-eviction",
    );
    await waitForAcknowledgement(sandbox, CREDENTIAL_WINDOW_STEPS.fallbackAfterEviction, "allowed");
    await expect
      .poll(
        () =>
          requestEvidence(
            fakeMcp,
            credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.fallbackAfterEviction),
            rotatedSecret,
          ),
        {
          interval: 500,
          timeout: 30_000,
          message: "old revision current-key fallback",
        },
      )
      .toEqual({
        seen: true,
        credentialRewritten: true,
        placeholderAbsent: true,
      });

    const freshAfterEvictionId = `${CREDENTIAL_WINDOW_REQUEST_PREFIX}:fresh-after-eviction`;
    const freshAfterEviction = await runFreshRequest(
      sandbox,
      tunnel.url,
      freshAfterEvictionId,
      allSecrets,
      "credential-window-fresh-request-after-eviction",
    );
    expect(freshAfterEviction).toEqual({
      revision: currentRevision,
      status: 200,
    });
    expect(requestEvidence(fakeMcp, freshAfterEvictionId, rotatedSecret)).toEqual({
      seen: true,
      credentialRewritten: true,
      placeholderAbsent: true,
    });

    await updateProviderCredential(
      sandbox,
      providerName,
      "",
      0,
      allSecrets,
      "credential-window-remove-current-key",
    );
    await expectFreshCredentialAbsent(
      sandbox,
      "credential-window-fresh-credential-absent-after-key-removal",
    );
    await writeControl(
      sandbox,
      CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRemoval,
      "credential-window-signal-after-key-removal",
    );
    await waitForAcknowledgement(sandbox, CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRemoval, "denied");
    expect(
      requestEvidence(
        fakeMcp,
        credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRemoval),
        rotatedSecret,
      ).seen,
    ).toBe(false);

    fakeMcp.setSecret(restartSecret);
    await updateProviderCredential(
      sandbox,
      providerName,
      restartSecret,
      0,
      allSecrets,
      "credential-window-restore-current-key-before-detach",
    );
    const restoredKeyRevision = await observeDistinctFreshRevision(
      sandbox,
      currentRevision,
      "credential-window-fresh-revision-after-key-restore",
    );
    const freshAfterKeyRestoreId = `${CREDENTIAL_WINDOW_REQUEST_PREFIX}:fresh-after-key-restore`;
    const freshAfterKeyRestore = await runFreshRequest(
      sandbox,
      tunnel.url,
      freshAfterKeyRestoreId,
      allSecrets,
      "credential-window-fresh-request-after-key-restore",
    );
    expect(freshAfterKeyRestore).toEqual({
      revision: restoredKeyRevision,
      status: 200,
    });
    expect(requestEvidence(fakeMcp, freshAfterKeyRestoreId, restartSecret)).toEqual({
      seen: true,
      credentialRewritten: true,
      placeholderAbsent: true,
    });

    const detach = await sandbox.openshell(
      ["sandbox", "provider", "detach", SANDBOX_NAME, providerName],
      {
        artifactName: "credential-window-direct-provider-detach",
        env: openshellEnv(),
        timeoutMs: 90_000,
      },
    );
    expectExitZero(detach, "detach credential-window provider");
    expect(resultText(detach)).toMatch(/Detached provider/iu);
    await expectFreshCredentialAbsent(
      sandbox,
      "credential-window-fresh-credential-absent-after-detach",
    );

    await writeControl(
      sandbox,
      CREDENTIAL_WINDOW_STEPS.deniedAfterDetach,
      "credential-window-signal-after-detach",
    );
    await waitForAcknowledgement(sandbox, CREDENTIAL_WINDOW_STEPS.deniedAfterDetach, "denied");
    expect(
      requestEvidence(
        fakeMcp,
        credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.deniedAfterDetach),
        restartSecret,
      ).seen,
    ).toBe(false);

    await rotateCredential(
      host,
      fakeMcp,
      restartSecret,
      CREDENTIAL_WINDOW_ROTATION_COUNT + 1,
      allSecrets,
    );
    restartedRevision = await observeFreshRevision(
      sandbox,
      "credential-window-fresh-revision-after-restart",
    );
    expect(restartedRevision).not.toBe(currentRevision);
    expect(restartedRevision).not.toBe(restoredKeyRevision);
    await writeControl(
      sandbox,
      CREDENTIAL_WINDOW_STEPS.fallbackAfterRestart,
      "credential-window-signal-fallback-after-restart",
    );
    await waitForAcknowledgement(sandbox, CREDENTIAL_WINDOW_STEPS.fallbackAfterRestart, "allowed");
    await expect
      .poll(
        () =>
          requestEvidence(
            fakeMcp,
            credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.fallbackAfterRestart),
            restartSecret,
          ),
        {
          interval: 500,
          timeout: 30_000,
          message: "old revision fallback after restart",
        },
      )
      .toEqual({
        seen: true,
        credentialRewritten: true,
        placeholderAbsent: true,
      });
  } finally {
    await writeControl(
      sandbox,
      CREDENTIAL_WINDOW_STEPS.stop,
      "credential-window-stop-old-child",
    ).catch(() =>
      host.bestEffortCleanupSandbox(SANDBOX_NAME, {
        artifactName: "credential-window-stop-fallback-destroy",
        timeoutMs: 15 * 60_000,
      }),
    );
    oldChildResult = await oldChildPromise;
  }

  expect(oldChildResult).toBeDefined();
  expectExitZero(oldChildResult!, "old credential-window child");
  const childSummary = parseLastJsonLine<CredentialWindowChildResult>(oldChildResult!.stdout);
  expect(childSummary).toEqual({
    revision: oldChildRevision,
    outcomes: [
      {
        step: CREDENTIAL_WINDOW_STEPS.fallbackAfterEviction,
        outcome: "allowed",
      },
      { step: CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRemoval, outcome: "denied" },
      { step: CREDENTIAL_WINDOW_STEPS.deniedAfterDetach, outcome: "denied" },
      {
        step: CREDENTIAL_WINDOW_STEPS.fallbackAfterRestart,
        outcome: "allowed",
      },
    ],
  });

  const rebuild = await host.nemoclaw([SANDBOX_NAME, "rebuild", "--yes"], {
    artifactName: "credential-window-rebuild-with-provider-reuse",
    env: {
      ...buildAvailabilityProbeEnv(),
      COMPATIBLE_API_KEY: COMPATIBLE_KEY,
      NVIDIA_INFERENCE_API_KEY: COMPATIBLE_KEY,
    },
    redactionValues: [COMPATIBLE_KEY, ...allSecrets],
    timeoutMs: 25 * 60_000,
  });
  expectExitZero(rebuild, "rebuild credential-window sandbox without MCP host secret");
  const rebuiltRevision = await observeFreshRevision(
    sandbox,
    "credential-window-fresh-revision-after-rebuild",
  );
  const freshAfterRebuildId = `${CREDENTIAL_WINDOW_REQUEST_PREFIX}:fresh-after-rebuild`;
  const freshAfterRebuild = await runFreshRequest(
    sandbox,
    tunnel.url,
    freshAfterRebuildId,
    allSecrets,
    "credential-window-fresh-request-after-rebuild",
  );
  expect(freshAfterRebuild).toEqual({
    revision: rebuiltRevision,
    status: 200,
  });
  expect(requestEvidence(fakeMcp, freshAfterRebuildId, restartSecret)).toEqual({
    seen: true,
    credentialRewritten: true,
    placeholderAbsent: true,
  });

  const remove = await host.nemoclaw([SANDBOX_NAME, "mcp", "remove", SERVER_NAME], {
    artifactName: "credential-window-mcp-remove",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 4 * 60_000,
  });
  expectExitZero(remove, "remove credential-window MCP bridge");
  await expectFreshCredentialAbsent(
    sandbox,
    "credential-window-fresh-credential-absent-after-remove",
  );
  const providerAfterRemove = await host.command(
    host.openshellCommandPath,
    ["provider", "get", providerName],
    {
      artifactName: "credential-window-provider-absent-after-remove",
      env: openshellEnv(),
      timeoutMs: 60_000,
    },
  );
  expect(providerAfterRemove.exitCode).not.toBe(0);
  expect(resultText(providerAfterRemove)).toMatch(/not found/iu);
  const upstreamRequestIds = fakeMcp.requests.map((request) => requestId(request.body));
  expect(upstreamRequestIds).not.toContain(
    credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.deniedAfterExpiry),
  );
  expect(upstreamRequestIds).not.toContain(
    credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRemoval),
  );
  expect(upstreamRequestIds).not.toContain(
    credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.deniedAfterDetach),
  );
  expect(
    fakeMcp.requests.every(
      (request: CredentialWindowRequest) => !request.auth.includes("openshell:resolve:env"),
    ),
  ).toBe(true);
  await artifacts.target.complete({
    id: "openshell-credential-generation-window",
    expiryRevision,
    oldChildRevision,
    rebuiltRevision,
    restartedRevision,
    rotations: CREDENTIAL_WINDOW_ROTATION_COUNT,
  });
});
