// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildMcpCredentialDetachedCommand,
  buildMcpCredentialRevisionObservationCommand,
} from "../../../src/lib/actions/sandbox/mcp-bridge-provider-readiness.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertCleanupSucceededOrAbsent } from "../fixtures/cleanup-resources.ts";
import {
  assertExitZero as expectExitZero,
  resultText,
} from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
} from "../fixtures/clients/sandbox.ts";
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
  CREDENTIAL_WINDOW_PATHS,
  CREDENTIAL_WINDOW_REQUEST_PREFIX,
  CREDENTIAL_WINDOW_REFRESH_COUNT,
  CREDENTIAL_WINDOW_STEPS,
  type CredentialWindowRequestStep,
  credentialWindowRequestId,
  credentialWindowSecrets,
} from "./openshell-credential-generation-window.ts";

const SANDBOX_NAME = "e2e-cred-window";
const SERVER_NAME = "fake";
const COMPATIBLE_KEY = MCP_BRIDGE_TEST_CREDENTIALS.compatibleEndpoint;
const COMPATIBLE_MODEL = "mock/mcp-credential-window";
const BRIDGE_ALREADY_ABSENT =
  /No MCP servers are registered|No MCP server '.+' is registered|MCP server '.+' not found/iu;
const RESTORED_CREDENTIAL_WINDOW_PATHS = {
  control: "/tmp/nemoclaw-restored-credential-window.control",
  ready: "/tmp/nemoclaw-restored-credential-window.ready.json",
  acknowledgement: "/tmp/nemoclaw-restored-credential-window.ack.json",
} as const;

interface CredentialWindowRequest {
  readonly auth: string;
  readonly body: string;
}

interface CredentialWindowPaths {
  readonly control: string;
  readonly ready: string;
  readonly acknowledgement: string;
}

interface CredentialWindowChildResult {
  readonly stableHandle: string;
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
  const request = fakeMcp.requests.find(
    (candidate) => requestId(candidate.body) === id,
  );
  return {
    seen: request !== undefined,
    credentialRewritten: request?.auth === `Bearer ${expectedSecret}`,
    placeholderAbsent: !request?.auth.includes("openshell:resolve:env"),
  };
}

async function cleanupBridge(host: HostCliClient): Promise<void> {
  const result = await host.nemoclaw(
    [SANDBOX_NAME, "mcp", "remove", SERVER_NAME, "--force"],
    {
      artifactName: "cleanup-credential-window-mcp-bridge",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 4 * 60_000,
    },
  );
  assertCleanupSucceededOrAbsent(
    result,
    BRIDGE_ALREADY_ABSENT,
    "cleanup credential-window MCP",
  );
}

async function observeFreshStableHandle(
  sandbox: SandboxClient,
  artifactName: string,
): Promise<string> {
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
  const stableHandle = result.stdout.trim();
  expect(
    stableHandle,
    `${artifactName} must return only a stable credential handle`,
  ).toMatch(/^s[a-f0-9]{64}$/u);
  return stableHandle;
}

async function observeDistinctFreshStableHandle(
  sandbox: SandboxClient,
  previousStableHandle: string,
  artifactName: string,
): Promise<string> {
  let stableHandle = previousStableHandle;
  await expect
    .poll(
      async () => {
        stableHandle = await observeFreshStableHandle(sandbox, artifactName);
        return stableHandle;
      },
      {
        interval: 1_000,
        timeout: 60_000,
        message: `${artifactName} distinct stable credential handle`,
      },
    )
    .not.toBe(previousStableHandle);
  return stableHandle;
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
          trustedSandboxShellScript(
            buildMcpCredentialDetachedCommand(CREDENTIAL_WINDOW_ENV_NAME),
          ),
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
  paths: CredentialWindowPaths = CREDENTIAL_WINDOW_PATHS,
): Promise<void> {
  const result = await sandbox.exec(
    SANDBOX_NAME,
    [
      "sh",
      "-c",
      'umask 077; rm -f "$2"; printf "%s\\n" "$3" > "$1"',
      "credential-window-control",
      paths.control,
      paths.acknowledgement,
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

async function waitForReadyStableHandle(
  sandbox: SandboxClient,
  paths: CredentialWindowPaths = CREDENTIAL_WINDOW_PATHS,
): Promise<string> {
  await expect
    .poll(
      async () => {
        const result = await readSandboxFile(
          sandbox,
          paths.ready,
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
    .toMatch(/^\{"stableHandle":"s[a-f0-9]{64}"\}$/u);
  const result = await readSandboxFile(
    sandbox,
    paths.ready,
    "credential-window-old-child-ready",
  );
  expectExitZero(result, "read old credential-window child stable handle");
  return (JSON.parse(result.stdout) as { stableHandle: string }).stableHandle;
}

async function waitForAcknowledgement(
  sandbox: SandboxClient,
  step: CredentialWindowRequestStep,
  outcome: "allowed" | "denied",
  paths: CredentialWindowPaths = CREDENTIAL_WINDOW_PATHS,
): Promise<void> {
  const expected = JSON.stringify({ step, outcome });
  await expect
    .poll(
      async () => {
        const result = await readSandboxFile(
          sandbox,
          paths.acknowledgement,
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
  const result = await host.nemoclaw(
    [SANDBOX_NAME, "mcp", "restart", SERVER_NAME],
    {
      artifactName: `credential-window-rotate-${generation}`,
      env: {
        ...buildAvailabilityProbeEnv(),
        [CREDENTIAL_WINDOW_ENV_NAME]: secret,
      },
      redactionValues: [...allSecrets],
      timeoutMs: 4 * 60_000,
    },
  );
  expectExitZero(result, `credential-window rotation ${generation}`);
}

async function updateProviderCredential(
  sandbox: SandboxClient,
  providerName: string,
  secret: string,
  allSecrets: readonly string[],
  artifactName: string,
): Promise<void> {
  const result = await sandbox.openshell(
    buildCredentialWindowProviderUpdateArgs(providerName, secret.length === 0),
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
): Promise<{ stableHandle: string; status: number }> {
  const result = await sandbox.exec(
    SANDBOX_NAME,
    [
      "nemoclaw-start",
      "node",
      "-e",
      buildCredentialWindowOneShotScript(),
      mcpUrl,
      id,
    ],
    {
      artifactName,
      env: openshellEnv(),
      redactionValues: [...allSecrets],
      timeoutMs: 90_000,
    },
  );
  expectExitZero(result, artifactName);
  return parseLastJsonLine<{
    stableHandle: string;
    status: number;
  }>(result.stdout);
}

test(
  "openshell-credential-generation-window",
  {
    timeout: 60 * 60_000,
    meta: {
      e2ePhases: [
        "start endpoints and onboard the credential-window sandbox",
        "attach the MCP provider and observe its initial stable handle",
        "refresh the token while keeping the stable handle authorized",
        "prove key removal revokes the original stable handle",
        "restore the key with a fresh authorization epoch",
        "prove detach and re-add revoke the restored stable handle",
        "rebuild the sandbox and confirm stable handle reuse",
        "remove the MCP bridge and audit denied requests",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox }) => {
    expect(process.env.NEMOCLAW_OPENSHELL_EXACT_MAIN_PROOF).toBe("1");

    const allSecrets = credentialWindowSecrets();
    const initialSecret = allSecrets[0]!;
    const refreshSecrets = allSecrets.slice(
      1,
      CREDENTIAL_WINDOW_REFRESH_COUNT + 1,
    );
    const restoredKeySecret = allSecrets.at(-2)!;
    const readdedSecret = allSecrets.at(-1)!;
    artifacts.addRedactionValues([COMPATIBLE_KEY, ...allSecrets]);
    await artifacts.target.declare({
      id: "openshell-credential-generation-window",
      contracts: [
        "OpenShell 0.0.116 stable credential authorization epochs",
        "NemoClaw MCP detach, restart, and rebuild lifecycle",
      ],
      sourceRevision: "d1155aa70042d3e2ee49dbfa15346b108b7c1d92",
    });

    const compatibleMock = await startCompatibleMock({
      apiKey: COMPATIBLE_KEY,
      model: COMPATIBLE_MODEL,
    });
    cleanup.add("stop credential-window compatible endpoint", () =>
      compatibleMock.close(),
    );
    const fakeMcp = await startFakeMcpHttpsServer({ secret: initialSecret });
    cleanup.add("stop credential-window MCP endpoint", () => fakeMcp.close());
    const tunnel = await startPublicMcpHttpsTunnel({
      cleanup,
      label: "credential-window MCP endpoint",
      progress,
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
      [
        "onboard",
        "--non-interactive",
        "--yes",
        "--yes-i-accept-third-party-software",
      ],
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

    progress.phase(
      "attach the MCP provider and observe its initial stable handle",
    );
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
    cleanup.add("remove credential-window MCP bridge", () =>
      cleanupBridge(host),
    );

    const status = await host.nemoclaw(
      [SANDBOX_NAME, "mcp", "status", SERVER_NAME, "--json"],
      {
        artifactName: "credential-window-mcp-status",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 60_000,
      },
    );
    expectExitZero(status, "inspect credential-window MCP bridge");
    const providerName = (
      JSON.parse(status.stdout) as { provider: { name: string } }
    ).provider.name;
    expect(providerName).toMatch(/^e2e-cred-window-mcp-fake-[a-f0-9]{16}$/u);

    const initialStableHandle = await observeFreshStableHandle(
      sandbox,
      "credential-window-initial-fresh-stable-handle",
    );
    const resetControl = await sandbox.exec(
      SANDBOX_NAME,
      [
        "rm",
        "-f",
        CREDENTIAL_WINDOW_PATHS.control,
        CREDENTIAL_WINDOW_PATHS.ready,
        CREDENTIAL_WINDOW_PATHS.acknowledgement,
        RESTORED_CREDENTIAL_WINDOW_PATHS.control,
        RESTORED_CREDENTIAL_WINDOW_PATHS.ready,
        RESTORED_CREDENTIAL_WINDOW_PATHS.acknowledgement,
      ],
      {
        artifactName: "credential-window-reset-control-files",
        env: openshellEnv(),
        timeoutMs: 60_000,
      },
    );
    expectExitZero(resetControl, "reset credential-window control files");

    progress.phase(
      "refresh the token while keeping the stable handle authorized",
    );
    const initialChildPromise = sandbox.exec(
      SANDBOX_NAME,
      [
        "nemoclaw-start",
        "node",
        "-e",
        buildCredentialWindowChildScript({ mcpUrl: tunnel.url }),
      ],
      {
        artifactName: "credential-window-initial-epoch-child",
        env: openshellEnv(),
        redactionValues: [...allSecrets],
        timeoutMs: 42 * 60_000,
      },
    );
    let initialChildHandle = "";
    let initialChildResult: ShellProbeResult | undefined;
    let restoredKeyHandle = "";
    const observedRefreshHandles: string[] = [];
    try {
      initialChildHandle = await waitForReadyStableHandle(sandbox);
      expect(initialChildHandle).toBe(initialStableHandle);

      const firstRefreshSecret = refreshSecrets[0]!;
      await rotateCredential(host, fakeMcp, firstRefreshSecret, 1, allSecrets);
      const firstRefreshHandle = await observeFreshStableHandle(
        sandbox,
        "credential-window-fresh-stable-handle-1",
      );
      observedRefreshHandles.push(firstRefreshHandle);
      await writeControl(
        sandbox,
        CREDENTIAL_WINDOW_STEPS.allowedAfterRefresh,
        "credential-window-signal-after-first-refresh",
      );
      await waitForAcknowledgement(
        sandbox,
        CREDENTIAL_WINDOW_STEPS.allowedAfterRefresh,
        "allowed",
      );
      expect(
        requestEvidence(
          fakeMcp,
          credentialWindowRequestId(
            CREDENTIAL_WINDOW_STEPS.allowedAfterRefresh,
          ),
          firstRefreshSecret,
        ),
      ).toEqual({
        seen: true,
        credentialRewritten: true,
        placeholderAbsent: true,
      });

      for (const [index, secret] of refreshSecrets.slice(1).entries()) {
        const generation = index + 2;
        await rotateCredential(host, fakeMcp, secret, generation, allSecrets);
        const freshHandle = await observeFreshStableHandle(
          sandbox,
          "credential-window-fresh-stable-handle-" + String(generation),
        );
        observedRefreshHandles.push(freshHandle);
      }
      expect(observedRefreshHandles).toEqual(
        Array(refreshSecrets.length).fill(initialStableHandle),
      );

      const currentSecret = refreshSecrets.at(-1)!;
      await writeControl(
        sandbox,
        CREDENTIAL_WINDOW_STEPS.allowedAfterRotations,
        "credential-window-signal-after-refreshes",
      );
      await waitForAcknowledgement(
        sandbox,
        CREDENTIAL_WINDOW_STEPS.allowedAfterRotations,
        "allowed",
      );
      expect(
        requestEvidence(
          fakeMcp,
          credentialWindowRequestId(
            CREDENTIAL_WINDOW_STEPS.allowedAfterRotations,
          ),
          currentSecret,
        ),
      ).toEqual({
        seen: true,
        credentialRewritten: true,
        placeholderAbsent: true,
      });
      await artifacts.writeJson("credential-window-stable-handles.json", {
        initialStableHandle,
        observedRefreshHandles,
        refreshes: CREDENTIAL_WINDOW_REFRESH_COUNT,
      });

      progress.phase("prove key removal revokes the original stable handle");
      await updateProviderCredential(
        sandbox,
        providerName,
        "",
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
      await waitForAcknowledgement(
        sandbox,
        CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRemoval,
        "denied",
      );
      expect(
        requestEvidence(
          fakeMcp,
          credentialWindowRequestId(
            CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRemoval,
          ),
          currentSecret,
        ).seen,
      ).toBe(false);

      progress.phase("restore the key with a fresh authorization epoch");
      fakeMcp.setSecret(restoredKeySecret);
      await updateProviderCredential(
        sandbox,
        providerName,
        restoredKeySecret,
        allSecrets,
        "credential-window-restore-current-key",
      );
      restoredKeyHandle = await observeDistinctFreshStableHandle(
        sandbox,
        initialStableHandle,
        "credential-window-fresh-stable-handle-after-key-restore",
      );
      const freshAfterKeyRestoreId =
        CREDENTIAL_WINDOW_REQUEST_PREFIX + ":fresh-after-key-restore";
      const freshAfterKeyRestore = await runFreshRequest(
        sandbox,
        tunnel.url,
        freshAfterKeyRestoreId,
        allSecrets,
        "credential-window-fresh-request-after-key-restore",
      );
      expect(freshAfterKeyRestore).toEqual({
        stableHandle: restoredKeyHandle,
        status: 200,
      });
      expect(
        requestEvidence(fakeMcp, freshAfterKeyRestoreId, restoredKeySecret),
      ).toEqual({
        seen: true,
        credentialRewritten: true,
        placeholderAbsent: true,
      });
      await writeControl(
        sandbox,
        CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRestore,
        "credential-window-signal-old-handle-after-key-restore",
      );
      await waitForAcknowledgement(
        sandbox,
        CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRestore,
        "denied",
      );
      expect(
        requestEvidence(
          fakeMcp,
          credentialWindowRequestId(
            CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRestore,
          ),
          restoredKeySecret,
        ).seen,
      ).toBe(false);
    } finally {
      await writeControl(
        sandbox,
        CREDENTIAL_WINDOW_STEPS.stop,
        "credential-window-stop-initial-epoch-child",
      ).catch(() =>
        host.bestEffortCleanupSandbox(SANDBOX_NAME, {
          artifactName: "credential-window-initial-epoch-stop-fallback-destroy",
          timeoutMs: 15 * 60_000,
        }),
      );
      initialChildResult = await initialChildPromise;
    }

    expect(initialChildResult).toBeDefined();
    expectExitZero(
      initialChildResult!,
      "initial authorization-epoch credential-window child",
    );
    expect(
      parseLastJsonLine<CredentialWindowChildResult>(
        initialChildResult!.stdout,
      ),
    ).toEqual({
      stableHandle: initialChildHandle,
      outcomes: [
        {
          step: CREDENTIAL_WINDOW_STEPS.allowedAfterRefresh,
          outcome: "allowed",
        },
        {
          step: CREDENTIAL_WINDOW_STEPS.allowedAfterRotations,
          outcome: "allowed",
        },
        {
          step: CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRemoval,
          outcome: "denied",
        },
        {
          step: CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRestore,
          outcome: "denied",
        },
      ],
    });

    const restoredControlReset = await sandbox.exec(
      SANDBOX_NAME,
      [
        "rm",
        "-f",
        RESTORED_CREDENTIAL_WINDOW_PATHS.control,
        RESTORED_CREDENTIAL_WINDOW_PATHS.ready,
        RESTORED_CREDENTIAL_WINDOW_PATHS.acknowledgement,
      ],
      {
        artifactName: "credential-window-reset-restored-control-files",
        env: openshellEnv(),
        timeoutMs: 60_000,
      },
    );
    expectExitZero(
      restoredControlReset,
      "reset restored credential-window control files",
    );

    const restoredChildPromise = sandbox.exec(
      SANDBOX_NAME,
      [
        "nemoclaw-start",
        "node",
        "-e",
        buildCredentialWindowChildScript({
          mcpUrl: tunnel.url,
          maxRuntimeMs: 10 * 60_000,
          paths: RESTORED_CREDENTIAL_WINDOW_PATHS,
        }),
      ],
      {
        artifactName: "credential-window-restored-epoch-child",
        env: openshellEnv(),
        redactionValues: [...allSecrets],
        timeoutMs: 12 * 60_000,
      },
    );
    let restoredChildHandle = "";
    let restoredChildResult: ShellProbeResult | undefined;
    let readdedHandle = "";
    try {
      restoredChildHandle = await waitForReadyStableHandle(
        sandbox,
        RESTORED_CREDENTIAL_WINDOW_PATHS,
      );
      expect(restoredChildHandle).toBe(restoredKeyHandle);
      await writeControl(
        sandbox,
        CREDENTIAL_WINDOW_STEPS.allowedBeforeDetach,
        "credential-window-signal-before-detach",
        RESTORED_CREDENTIAL_WINDOW_PATHS,
      );
      await waitForAcknowledgement(
        sandbox,
        CREDENTIAL_WINDOW_STEPS.allowedBeforeDetach,
        "allowed",
        RESTORED_CREDENTIAL_WINDOW_PATHS,
      );
      expect(
        requestEvidence(
          fakeMcp,
          credentialWindowRequestId(
            CREDENTIAL_WINDOW_STEPS.allowedBeforeDetach,
          ),
          restoredKeySecret,
        ),
      ).toEqual({
        seen: true,
        credentialRewritten: true,
        placeholderAbsent: true,
      });

      progress.phase(
        "prove detach and re-add revoke the restored stable handle",
      );
      const removeBeforeReadd = await host.nemoclaw(
        [SANDBOX_NAME, "mcp", "remove", SERVER_NAME],
        {
          artifactName: "credential-window-remove-before-readd",
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 4 * 60_000,
        },
      );
      expectExitZero(
        removeBeforeReadd,
        "remove credential-window bridge before re-add",
      );
      await expectFreshCredentialAbsent(
        sandbox,
        "credential-window-fresh-credential-absent-after-detach",
      );
      await writeControl(
        sandbox,
        CREDENTIAL_WINDOW_STEPS.deniedAfterDetach,
        "credential-window-signal-after-detach",
        RESTORED_CREDENTIAL_WINDOW_PATHS,
      );
      await waitForAcknowledgement(
        sandbox,
        CREDENTIAL_WINDOW_STEPS.deniedAfterDetach,
        "denied",
        RESTORED_CREDENTIAL_WINDOW_PATHS,
      );
      expect(
        requestEvidence(
          fakeMcp,
          credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.deniedAfterDetach),
          restoredKeySecret,
        ).seen,
      ).toBe(false);

      fakeMcp.setSecret(readdedSecret);
      const readd = await host.nemoclaw(
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
          artifactName: "credential-window-readd-after-removal",
          env: {
            ...buildAvailabilityProbeEnv(),
            [CREDENTIAL_WINDOW_ENV_NAME]: readdedSecret,
          },
          redactionValues: [...allSecrets],
          timeoutMs: 4 * 60_000,
        },
      );
      expectExitZero(readd, "re-add credential-window bridge");
      readdedHandle = await observeDistinctFreshStableHandle(
        sandbox,
        restoredKeyHandle,
        "credential-window-fresh-stable-handle-after-readd",
      );
      expect(readdedHandle).not.toBe(initialStableHandle);
      const freshAfterReaddId =
        CREDENTIAL_WINDOW_REQUEST_PREFIX + ":fresh-after-readd";
      const freshAfterReadd = await runFreshRequest(
        sandbox,
        tunnel.url,
        freshAfterReaddId,
        allSecrets,
        "credential-window-fresh-request-after-readd",
      );
      expect(freshAfterReadd).toEqual({
        stableHandle: readdedHandle,
        status: 200,
      });
      expect(
        requestEvidence(fakeMcp, freshAfterReaddId, readdedSecret),
      ).toEqual({
        seen: true,
        credentialRewritten: true,
        placeholderAbsent: true,
      });
      await writeControl(
        sandbox,
        CREDENTIAL_WINDOW_STEPS.deniedAfterReadd,
        "credential-window-signal-denied-after-readd",
        RESTORED_CREDENTIAL_WINDOW_PATHS,
      );
      await waitForAcknowledgement(
        sandbox,
        CREDENTIAL_WINDOW_STEPS.deniedAfterReadd,
        "denied",
        RESTORED_CREDENTIAL_WINDOW_PATHS,
      );
      expect(
        requestEvidence(
          fakeMcp,
          credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.deniedAfterReadd),
          readdedSecret,
        ).seen,
      ).toBe(false);
    } finally {
      await writeControl(
        sandbox,
        CREDENTIAL_WINDOW_STEPS.stop,
        "credential-window-stop-restored-epoch-child",
        RESTORED_CREDENTIAL_WINDOW_PATHS,
      ).catch(() =>
        host.bestEffortCleanupSandbox(SANDBOX_NAME, {
          artifactName:
            "credential-window-restored-epoch-stop-fallback-destroy",
          timeoutMs: 15 * 60_000,
        }),
      );
      restoredChildResult = await restoredChildPromise;
    }

    expect(restoredChildResult).toBeDefined();
    expectExitZero(
      restoredChildResult!,
      "restored authorization-epoch credential-window child",
    );
    expect(
      parseLastJsonLine<CredentialWindowChildResult>(
        restoredChildResult!.stdout,
      ),
    ).toEqual({
      stableHandle: restoredChildHandle,
      outcomes: [
        {
          step: CREDENTIAL_WINDOW_STEPS.allowedBeforeDetach,
          outcome: "allowed",
        },
        {
          step: CREDENTIAL_WINDOW_STEPS.deniedAfterDetach,
          outcome: "denied",
        },
        {
          step: CREDENTIAL_WINDOW_STEPS.deniedAfterReadd,
          outcome: "denied",
        },
      ],
    });

    progress.phase("rebuild the sandbox and confirm stable handle reuse");
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
    expectExitZero(
      rebuild,
      "rebuild credential-window sandbox without MCP host secret",
    );
    const rebuiltHandle = await observeFreshStableHandle(
      sandbox,
      "credential-window-fresh-stable-handle-after-rebuild",
    );
    expect(rebuiltHandle).toBe(readdedHandle);
    const freshAfterRebuildId = `${CREDENTIAL_WINDOW_REQUEST_PREFIX}:fresh-after-rebuild`;
    const freshAfterRebuild = await runFreshRequest(
      sandbox,
      tunnel.url,
      freshAfterRebuildId,
      allSecrets,
      "credential-window-fresh-request-after-rebuild",
    );
    expect(freshAfterRebuild).toEqual({
      stableHandle: rebuiltHandle,
      status: 200,
    });
    expect(
      requestEvidence(fakeMcp, freshAfterRebuildId, readdedSecret),
    ).toEqual({
      seen: true,
      credentialRewritten: true,
      placeholderAbsent: true,
    });

    progress.phase("remove the MCP bridge and audit denied requests");
    const remove = await host.nemoclaw(
      [SANDBOX_NAME, "mcp", "remove", SERVER_NAME],
      {
        artifactName: "credential-window-mcp-remove",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 4 * 60_000,
      },
    );
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
    const upstreamRequestIds = fakeMcp.requests.map((request) =>
      requestId(request.body),
    );
    expect(upstreamRequestIds).not.toContain(
      credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRemoval),
    );
    expect(upstreamRequestIds).not.toContain(
      credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.deniedAfterKeyRestore),
    );
    expect(upstreamRequestIds).not.toContain(
      credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.deniedAfterDetach),
    );
    expect(upstreamRequestIds).not.toContain(
      credentialWindowRequestId(CREDENTIAL_WINDOW_STEPS.deniedAfterReadd),
    );
    expect(
      fakeMcp.requests.every(
        (request: CredentialWindowRequest) =>
          !request.auth.includes("openshell:resolve:env"),
      ),
    ).toBe(true);
    await artifacts.target.complete({
      id: "openshell-credential-generation-window",
      initialStableHandle,
      readdedHandle,
      rebuiltHandle,
      restoredKeyHandle,
      refreshes: CREDENTIAL_WINDOW_REFRESH_COUNT,
    });
  },
);
