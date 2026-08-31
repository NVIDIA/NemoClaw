// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "../fixtures/mcp-bridge-credentials.ts";
import { startTestProgress } from "../fixtures/progress.ts";
import { ShellProbe } from "../fixtures/shell-probe.ts";
import {
  confirmHermesMcpRegistrationAfterRestartSettlement,
  isHermesMcpAddPostProbeNotReady,
  isHermesMcpStatusAwaitingRestartSettlement,
  isHermesRestartTransportFailure,
  isRetryableOpenClawBaselineScopeOnboardFailure,
  MCP_BRIDGE_TEST_REDACTION_VALUES,
  readConcurrentMcpStatusAndConfirmHermesRegistration,
  restartBridgeWithoutHostSecret,
  retryAfterHermesRestartTransportFailure,
  retryHermesGatewayDraining,
  retryOpenClawBaselineScopeOnboardFailure,
} from "../live/mcp-bridge-reliability.ts";

const HTTP_STATUS_MARKER = "NEMOCLAW_HERMES_MCP_HTTP_STATUS=";

function gatewayResult(status: number, code: string) {
  return {
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify({ error: { code } }),
    stderr: `${HTTP_STATUS_MARKER}${status}\n`,
  };
}

const HERMES_BROKEN_PIPE = `  Effective egress that would be opened:
    policy 'mcp-bridge-concurrent':
      - fixture.trycloudflare.com:443 (protocol: rest, enforcement: enforce)
  Applied preset: mcp-bridge-concurrent
  Narrowing sandbox egress — removing: fixture.trycloudflare.com
  Removed preset: mcp-bridge-concurrent
\u001b[1m\u001b[32m✓\u001b[39m\u001b[0m Policy version 3 submitted (hash: abcdef0123)
\u001b[1m\u001b[32m✓\u001b[39m\u001b[0m Policy version 3 loaded (active version: 3)
  Preset not found: mcp-bridge-concurrent
\u001b[1m\u001b[32m✓\u001b[39m\u001b[0m Policy version 4 submitted (hash: 0123abcdef)
\u001b[1m\u001b[32m✓\u001b[39m\u001b[0m Policy version 4 loaded (active version: 4)
  Error:   \u00d7 code: 'Unknown error', message: "h2 protocol error: error reading a body
  \u2502 from connection", source: hyper::Error(Body, Error { kind: Io(Custom
  \u2502 { kind: BrokenPipe, error: "stream closed because of a broken pipe" }) })
  \u251c\u2500\u25b6 error reading a body from connection
  \u2570\u2500\u25b6 stream closed because of a broken pipe`;

const HERMES_RESTART_SETTLING_PAYLOAD = {
  server: "concurrent",
  agent: "hermes",
  url: "https://fixture.trycloudflare.com/mcp",
  addedAt: "2026-08-31T00:00:00.000Z",
  warnings: [],
  support: { supported: true, mode: "bridge", adapter: "hermes-config" },
  env: { names: ["FAKE_MCP_SECRET"], missing: [], ready: true },
  provider: {
    name: "e2e-mcp-hermes-mcp-concurrent-0123456789abcdef",
    registryPresent: true,
    gatewayPresent: true,
    attached: true,
    credentialReady: true,
    credentialResolution: {
      ok: null,
      detail: "probe skipped: the current OpenShell credential revision could not be observed",
    },
  },
  policy: {
    name: "mcp-bridge-concurrent",
    registryPresent: true,
    gatewayPresent: true,
  },
  adapter: {
    registered: null,
    detail:
      "Adapter inspection was skipped because the current OpenShell credential revision could not be observed.",
  },
};

const HERMES_RESTART_SETTLING_STATUS = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: JSON.stringify(HERMES_RESTART_SETTLING_PAYLOAD),
  stderr: "",
};

const HERMES_RESTART_SETTLEMENT_FIELD_MISMATCHES: Array<
  [string, (payload: typeof HERMES_RESTART_SETTLING_PAYLOAD) => void]
> = [
  ["agent differs", (payload) => Object.assign(payload, { agent: "openclaw" })],
  ["warnings are present", (payload) => Object.assign(payload, { warnings: ["warning"] })],
  ["warnings are not an array", (payload) => Object.assign(payload, { warnings: "warning" })],
  ["support is unavailable", (payload) => Object.assign(payload.support, { supported: false })],
  ["support mode differs", (payload) => Object.assign(payload.support, { mode: "direct" })],
  ["support adapter differs", (payload) => Object.assign(payload.support, { adapter: "mcporter" })],
  ["environment names are empty", (payload) => Object.assign(payload.env, { names: [] })],
  ["environment name is not text", (payload) => Object.assign(payload.env, { names: [42] })],
  [
    "environment reports a missing credential",
    (payload) => Object.assign(payload.env, { missing: ["FAKE_MCP_SECRET"] }),
  ],
  ["environment is not ready", (payload) => Object.assign(payload.env, { ready: false })],
  ["provider name is empty", (payload) => Object.assign(payload.provider, { name: "" })],
  [
    "provider registry is incomplete",
    (payload) => Object.assign(payload.provider, { registryPresent: false }),
  ],
  [
    "provider gateway is incomplete",
    (payload) => Object.assign(payload.provider, { gatewayPresent: false }),
  ],
  ["provider is detached", (payload) => Object.assign(payload.provider, { attached: false })],
  [
    "provider credential is not ready",
    (payload) => Object.assign(payload.provider, { credentialReady: false }),
  ],
  [
    "credential resolution result differs",
    (payload) => Object.assign(payload.provider.credentialResolution, { ok: false }),
  ],
  [
    "credential resolution detail differs",
    (payload) =>
      Object.assign(payload.provider.credentialResolution, {
        detail: "credential revision mismatch",
      }),
  ],
  ["policy name is empty", (payload) => Object.assign(payload.policy, { name: "" })],
  [
    "policy registry is incomplete",
    (payload) => Object.assign(payload.policy, { registryPresent: false }),
  ],
  [
    "policy gateway is incomplete",
    (payload) => Object.assign(payload.policy, { gatewayPresent: false }),
  ],
  [
    "adapter registration is resolved",
    (payload) => Object.assign(payload.adapter, { registered: false }),
  ],
  [
    "adapter detail differs",
    (payload) => Object.assign(payload.adapter, { detail: "adapter inspection failed" }),
  ],
];

const HERMES_ADD_POST_PROBE_NOT_READY = {
  ...HERMES_RESTART_SETTLING_STATUS,
  stdout: `MCP server 'concurrent' added to sandbox 'e2e-mcp-hermes'.
Credential FAKE_MCP_SECRET probe was inconclusive: Error:   × code: 'The system is not in a state required for the operation's
│ execution', message: "sandbox is not ready"
`,
};

const HERMES_REGISTERED_ADAPTER = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: "registered\n",
  stderr: "",
};

async function readRestartFailureArtifacts(root: string): Promise<string> {
  const artifactBase = path.join(root, "shell/secret-shaped-restart-mcp-restart-provider-reuse");
  return (
    await Promise.all(
      ["stdout.txt", "stderr.txt", "result.json"].map((suffix) =>
        fs.readFile(`${artifactBase}.${suffix}`, "utf8"),
      ),
    )
  ).join("\n");
}

describe("MCP bridge transient classification", () => {
  it("recognizes only a successful Hermes add with the post-reload not-ready result (#9485)", () => {
    expect(isHermesMcpAddPostProbeNotReady("hermes-config", HERMES_ADD_POST_PROBE_NOT_READY)).toBe(
      true,
    );
    expect(isHermesMcpAddPostProbeNotReady("mcporter", HERMES_ADD_POST_PROBE_NOT_READY)).toBe(
      false,
    );
    expect(
      isHermesMcpAddPostProbeNotReady("hermes-config", {
        ...HERMES_ADD_POST_PROBE_NOT_READY,
        exitCode: 1,
      }),
    ).toBe(false);
    expect(
      isHermesMcpAddPostProbeNotReady("hermes-config", {
        ...HERMES_ADD_POST_PROBE_NOT_READY,
        stdout: HERMES_ADD_POST_PROBE_NOT_READY.stdout.replace(
          "sandbox is not ready",
          "provider is unavailable",
        ),
      }),
    ).toBe(false);
  });

  it.each([
    ["receives a signal", { signal: "SIGTERM" as const }],
    ["times out", { timedOut: true }],
  ])("rejects a Hermes add post-probe result when the command %s (#9485)", (_label, override) => {
    expect(
      isHermesMcpAddPostProbeNotReady("hermes-config", {
        ...HERMES_ADD_POST_PROBE_NOT_READY,
        ...override,
      }),
    ).toBe(false);
  });

  it("recognizes only the complete Hermes restart-settlement status (#9485)", () => {
    expect(
      isHermesMcpStatusAwaitingRestartSettlement(
        "hermes-config",
        "concurrent",
        HERMES_RESTART_SETTLING_STATUS,
      ),
    ).toBe(true);
    expect(
      isHermesMcpStatusAwaitingRestartSettlement(
        "mcporter",
        "concurrent",
        HERMES_RESTART_SETTLING_STATUS,
      ),
    ).toBe(false);
    expect(
      isHermesMcpStatusAwaitingRestartSettlement("hermes-config", "other", {
        ...HERMES_RESTART_SETTLING_STATUS,
      }),
    ).toBe(false);
  });

  it.each(HERMES_RESTART_SETTLEMENT_FIELD_MISMATCHES)(
    "rejects Hermes restart settlement when %s (#9485)",
    (_label, mutatePayload) => {
      const payload = structuredClone(HERMES_RESTART_SETTLING_PAYLOAD);
      mutatePayload(payload);
      expect(
        isHermesMcpStatusAwaitingRestartSettlement("hermes-config", "concurrent", {
          ...HERMES_RESTART_SETTLING_STATUS,
          stdout: JSON.stringify(payload),
        }),
      ).toBe(false);
    },
  );

  it.each([
    ["the command exits nonzero", { exitCode: 1 }],
    ["the command receives a signal", { signal: "SIGTERM" as const }],
    ["the command times out", { timedOut: true }],
    ["stderr is nonempty", { stderr: "sandbox diagnostic" }],
  ])("rejects Hermes restart settlement when %s (#9485)", (_label, resultOverride) => {
    expect(
      isHermesMcpStatusAwaitingRestartSettlement("hermes-config", "concurrent", {
        ...HERMES_RESTART_SETTLING_STATUS,
        ...resultOverride,
      }),
    ).toBe(false);
  });

  it("retries one read-only Hermes registration observation and records both attempts (#9485)", async () => {
    const observeCurrentRegistration = vi.fn(async () => ({
      source: "direct-adapter" as const,
      result: HERMES_REGISTERED_ADAPTER,
    }));
    const sleep = vi.fn(async () => undefined);
    const recordedEvidence: unknown[] = [];

    const outcome = await confirmHermesMcpRegistrationAfterRestartSettlement({
      adapter: "hermes-config",
      server: "concurrent",
      committedAddResult: HERMES_ADD_POST_PROBE_NOT_READY,
      initialStatusResult: HERMES_RESTART_SETTLING_STATUS,
      observeCurrentRegistration,
      sleep,
      onEvidence: (evidence) => {
        recordedEvidence.push(evidence);
      },
    });

    expect(outcome.registered).toBe(true);
    expect(outcome.evidence).toMatchObject({
      operation: "mcp-bridge.hermes-registration-observation",
      owner: "mcp-bridge",
      idempotence: "read-only",
      maxAttempts: 2,
      outcome: "passed-after-retry",
      attempts: [
        {
          attempt: 1,
          outcome: "failed",
          failureClass: "transient-external",
          retryScheduled: true,
        },
        { attempt: 2, outcome: "passed", retryScheduled: false },
      ],
    });
    expect(observeCurrentRegistration).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(recordedEvidence).toEqual([outcome.evidence]);
  });

  it("returns unregistered without another retry when the bounded Hermes adapter observation mismatches (#9485)", async () => {
    const observeCurrentRegistration = vi.fn(async () => ({
      source: "direct-adapter" as const,
      result: { ...HERMES_REGISTERED_ADAPTER, stdout: "mismatch\n" },
    }));
    const sleep = vi.fn(async () => undefined);

    const outcome = await confirmHermesMcpRegistrationAfterRestartSettlement({
      adapter: "hermes-config",
      server: "concurrent",
      committedAddResult: HERMES_ADD_POST_PROBE_NOT_READY,
      initialStatusResult: HERMES_RESTART_SETTLING_STATUS,
      observeCurrentRegistration,
      sleep,
    });

    expect(outcome.registered).toBe(false);
    expect(outcome.evidence).toMatchObject({
      outcome: "failed-no-retry",
      attempts: [
        { attempt: 1, retryScheduled: true },
        {
          attempt: 2,
          outcome: "failed",
          failureClass: "deterministic",
          retryScheduled: false,
        },
      ],
    });
    expect(observeCurrentRegistration).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("does not retry an observed Hermes adapter mismatch (#9485)", async () => {
    const mismatch = {
      ...HERMES_RESTART_SETTLING_STATUS,
      stdout: HERMES_RESTART_SETTLING_STATUS.stdout.replace(
        '"registered":null',
        '"registered":false',
      ),
    };
    const observeCurrentRegistration = vi.fn(async () => ({
      source: "direct-adapter" as const,
      result: HERMES_REGISTERED_ADAPTER,
    }));
    const sleep = vi.fn(async () => undefined);

    const outcome = await confirmHermesMcpRegistrationAfterRestartSettlement({
      adapter: "hermes-config",
      server: "concurrent",
      committedAddResult: HERMES_ADD_POST_PROBE_NOT_READY,
      initialStatusResult: mismatch,
      observeCurrentRegistration,
      sleep,
    });

    expect(outcome.registered).toBe(false);
    expect(outcome.evidence.outcome).toBe("failed-no-retry");
    expect(observeCurrentRegistration).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry restart-settlement status without the matching committed add result (#9485)", async () => {
    const observeCurrentRegistration = vi.fn(async () => ({
      source: "direct-adapter" as const,
      result: HERMES_REGISTERED_ADAPTER,
    }));
    const sleep = vi.fn(async () => undefined);

    const outcome = await confirmHermesMcpRegistrationAfterRestartSettlement({
      adapter: "hermes-config",
      server: "concurrent",
      committedAddResult: {
        ...HERMES_ADD_POST_PROBE_NOT_READY,
        stdout: HERMES_ADD_POST_PROBE_NOT_READY.stdout.replace(
          "sandbox is not ready",
          "provider is unavailable",
        ),
      },
      initialStatusResult: HERMES_RESTART_SETTLING_STATUS,
      observeCurrentRegistration,
      sleep,
    });

    expect(outcome.registered).toBe(false);
    expect(outcome.evidence.outcome).toBe("failed-no-retry");
    expect(observeCurrentRegistration).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not repeat full status when Hermes registration needs a read-only confirmation (#9485)", async () => {
    const status = vi.fn(async () => HERMES_RESTART_SETTLING_STATUS);
    const execShell = vi
      .fn()
      .mockResolvedValueOnce({ ...HERMES_REGISTERED_ADAPTER, stdout: "v4\n" })
      .mockResolvedValueOnce(HERMES_REGISTERED_ADAPTER);
    const writeJson = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);

    const outcome = await readConcurrentMcpStatusAndConfirmHermesRegistration({
      clients: {
        artifacts: { writeJson } as unknown as Pick<ArtifactSink, "writeJson">,
        host: { nemoclaw: status } as unknown as Pick<HostCliClient, "nemoclaw">,
        sandbox: { execShell } as unknown as Pick<SandboxClient, "execShell">,
      },
      committedAddResult: HERMES_ADD_POST_PROBE_NOT_READY,
      credentialEnvName: "FAKE_MCP_SECRET",
      env: { FAKE_MCP_SECRET: "fixture-secret" },
      redactionValues: ["fixture-secret"],
      scenario: {
        artifactPrefix: "hermes",
        expectedAdapter: "hermes-config",
        mcpUrl: "https://fixture.trycloudflare.com/mcp",
        sandboxName: "e2e-mcp-hermes",
      },
      server: "concurrent",
      sleep,
    });

    expect(outcome.result).toBe(HERMES_RESTART_SETTLING_STATUS);
    expect(outcome.registered).toBe(true);
    expect(status).toHaveBeenCalledOnce();
    expect(execShell).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(writeJson).toHaveBeenCalledOnce();
    expect(writeJson).toHaveBeenCalledWith(
      "retry/hermes-mcp-concurrent-registration-restart-settlement.json",
      expect.objectContaining({
        idempotence: "read-only",
        outcome: "passed-after-retry",
      }),
    );
  });

  it("rejects an invalid credential observation that mimics adapter registration (#9485)", async () => {
    const status = vi.fn(async () => HERMES_RESTART_SETTLING_STATUS);
    const execShell = vi.fn(async () => HERMES_REGISTERED_ADAPTER);
    const writeJson = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);

    const outcome = await readConcurrentMcpStatusAndConfirmHermesRegistration({
      clients: {
        artifacts: { writeJson } as unknown as Pick<ArtifactSink, "writeJson">,
        host: { nemoclaw: status } as unknown as Pick<HostCliClient, "nemoclaw">,
        sandbox: { execShell } as unknown as Pick<SandboxClient, "execShell">,
      },
      committedAddResult: HERMES_ADD_POST_PROBE_NOT_READY,
      credentialEnvName: "FAKE_MCP_SECRET",
      env: { FAKE_MCP_SECRET: "fixture-secret" },
      redactionValues: ["fixture-secret"],
      scenario: {
        artifactPrefix: "hermes",
        expectedAdapter: "hermes-config",
        mcpUrl: "https://fixture.trycloudflare.com/mcp",
        sandboxName: "e2e-mcp-hermes",
      },
      server: "concurrent",
      sleep,
    });

    expect(outcome.registered).toBe(false);
    expect(status).toHaveBeenCalledOnce();
    expect(execShell).toHaveBeenCalledOnce();
    expect(writeJson).toHaveBeenCalledWith(
      "retry/hermes-mcp-concurrent-registration-restart-settlement.json",
      expect.objectContaining({
        outcome: "failed-no-retry",
        attempts: [
          expect.objectContaining({ attempt: 1, retryScheduled: true }),
          expect.objectContaining({
            attempt: 2,
            failureClass: "deterministic",
            retryScheduled: false,
          }),
        ],
      }),
    );
  });

  it("retries only the exact OpenClaw baseline-scope settlement failure", () => {
    const sandboxName = "e2e-pr-exact-mcp-1";
    const message = `OpenClaw onboarding for '${sandboxName}' is incomplete because its canonical CLI device did not receive the required baseline scopes. Resume or rerun onboarding.`;
    const result = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: `policy loaded\n${message}\n`,
      stderr: "",
    };

    expect(isRetryableOpenClawBaselineScopeOnboardFailure("openclaw", sandboxName, result)).toBe(
      true,
    );
    expect(isRetryableOpenClawBaselineScopeOnboardFailure("hermes", sandboxName, result)).toBe(
      false,
    );
    expect(
      isRetryableOpenClawBaselineScopeOnboardFailure("openclaw", "other-sandbox", result),
    ).toBe(false);
    expect(
      isRetryableOpenClawBaselineScopeOnboardFailure("openclaw", sandboxName, {
        ...result,
        exitCode: 0,
      }),
    ).toBe(false);
    expect(
      isRetryableOpenClawBaselineScopeOnboardFailure("openclaw", sandboxName, {
        ...result,
        stdout: message.replace("baseline scopes", "device pairing"),
      }),
    ).toBe(false);
  });

  it("retries the qualified OpenClaw onboarding failure exactly once", async () => {
    const sandboxName = "e2e-pr-exact-mcp-1";
    const initialResult = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: `OpenClaw onboarding for '${sandboxName}' is incomplete because its canonical CLI device did not receive the required baseline scopes. Resume or rerun onboarding.\n`,
      stderr: "",
    };
    const passing = { ...initialResult, exitCode: 0, stdout: "onboarded\n" };
    const retry = vi.fn(async () => passing);

    await expect(
      retryOpenClawBaselineScopeOnboardFailure({
        agent: "openclaw",
        sandboxName,
        initialResult,
        retry,
      }),
    ).resolves.toBe(passing);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("redacts every MCP fixture credential from a restart-command failure artifact", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-mcp-restart-redaction-"));
    const progress = startTestProgress(
      "MCP restart redaction",
      ["run failing MCP restart", "inspect redacted failure artifacts"],
      { logLine: () => undefined },
    );
    try {
      const leakedValues = [
        ...Object.values(MCP_BRIDGE_TEST_CREDENTIALS),
        `${MCP_BRIDGE_TEST_CREDENTIALS.generationWindow}7`,
      ];
      const script = path.join(root, "nemoclaw-secret-shaped-failure");
      await fs.writeFile(
        script,
        [
          "#!/bin/sh",
          ...leakedValues.map((value) => `printf '%s\\n' '${value}' >&2`),
          "exit 23",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const artifacts = new ArtifactSink(path.join(root, "artifacts"));
      const host = new HostCliClient(
        new ShellProbe({
          artifacts,
          progress,
          redact: (text) => text,
          signal: new AbortController().signal,
        }),
        { cliPath: script },
      );

      let failure: unknown;
      try {
        await restartBridgeWithoutHostSecret(host, "sandbox", "secret-shaped-restart");
      } catch (error) {
        failure = error;
      }

      expect(MCP_BRIDGE_TEST_REDACTION_VALUES).toEqual(Object.values(MCP_BRIDGE_TEST_CREDENTIALS));
      expect(failure).toBeInstanceOf(Error);
      progress.phase("inspect redacted failure artifacts");
      const failureMessage = failure instanceof Error ? failure.message : String(failure);
      const artifactText = await readRestartFailureArtifacts(artifacts.rootDir);
      expect(failureMessage).toContain("[REDACTED]");
      expect(artifactText).toContain("[REDACTED]");
      const persistedFailure = `${failureMessage}\n${artifactText}`;
      expect(persistedFailure).not.toContain(MCP_BRIDGE_TEST_CREDENTIALS.host);
      expect(persistedFailure).not.toContain(MCP_BRIDGE_TEST_CREDENTIALS.rotatedHost);
      expect(persistedFailure).not.toContain(MCP_BRIDGE_TEST_CREDENTIALS.rebindHost);
      expect(persistedFailure).not.toContain(MCP_BRIDGE_TEST_CREDENTIALS.compatibleEndpoint);
      expect(persistedFailure).not.toContain(MCP_BRIDGE_TEST_CREDENTIALS.generationWindow);
      expect(persistedFailure).not.toContain(`${MCP_BRIDGE_TEST_CREDENTIALS.generationWindow}7`);
    } finally {
      progress.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts only the Hermes managed-restart broken-pipe signature (#6692)", () => {
    expect(isHermesRestartTransportFailure("hermes-config", HERMES_BROKEN_PIPE)).toBe(true);
    expect(isHermesRestartTransportFailure("mcporter", HERMES_BROKEN_PIPE)).toBe(false);
    expect(isHermesRestartTransportFailure("deepagents-config", HERMES_BROKEN_PIPE)).toBe(false);
    expect(isHermesRestartTransportFailure("hermes-config", "h2 protocol error")).toBe(false);
    expect(isHermesRestartTransportFailure("hermes-config", "stream closed: broken pipe")).toBe(
      false,
    );
    expect(
      isHermesRestartTransportFailure(
        "hermes-config",
        HERMES_BROKEN_PIPE.replace("error reading a body from connection", "unrelated failure"),
      ),
    ).toBe(false);
    expect(
      isHermesRestartTransportFailure(
        "hermes-config",
        `unexpected diagnostic before retry evidence\n${HERMES_BROKEN_PIPE}`,
      ),
    ).toBe(false);
    expect(
      isHermesRestartTransportFailure(
        "hermes-config",
        `${HERMES_BROKEN_PIPE}\nadditional failure after transport closed`,
      ),
    ).toBe(false);
  });

  it("keeps the original duplicate rejection without retrying", async () => {
    const originalResult = { exitCode: 1 };
    const retry = vi.fn(async () => ({ exitCode: 2 }));

    await expect(
      retryAfterHermesRestartTransportFailure({
        adapter: "hermes-config",
        committedBridgeVerified: true,
        diagnostic: "server already exists",
        originalResult,
        retry,
      }),
    ).resolves.toBe(originalResult);
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries the exact Hermes restart transport failure once", async () => {
    const retryResult = { exitCode: 1 };
    const retry = vi.fn(async () => retryResult);

    await expect(
      retryAfterHermesRestartTransportFailure({
        adapter: "hermes-config",
        committedBridgeVerified: true,
        diagnostic: HERMES_BROKEN_PIPE,
        originalResult: { exitCode: 1 },
        retry,
      }),
    ).resolves.toBe(retryResult);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("fails closed for an unknown rejection", async () => {
    const retry = vi.fn(async () => ({ exitCode: 1 }));

    await expect(
      retryAfterHermesRestartTransportFailure({
        adapter: "hermes-config",
        committedBridgeVerified: true,
        diagnostic: "unexpected transport error",
        originalResult: { exitCode: 1 },
        retry,
      }),
    ).rejects.toThrow("not a known Hermes restart transport failure");
    expect(retry).not.toHaveBeenCalled();
  });

  it("refuses retry before the committed bridge is verified", async () => {
    const retry = vi.fn(async () => ({ exitCode: 1 }));

    await expect(
      retryAfterHermesRestartTransportFailure({
        adapter: "hermes-config",
        committedBridgeVerified: false,
        diagnostic: HERMES_BROKEN_PIPE,
        originalResult: { exitCode: 1 },
        retry,
      }),
    ).rejects.toThrow("requires a verified committed bridge");
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries the exact gateway draining response with a bounded delay", async () => {
    const passing = gatewayResult(200, "none");
    const retry = vi
      .fn<(attempt: number) => Promise<typeof passing>>()
      .mockResolvedValueOnce(gatewayResult(503, "gateway_draining"))
      .mockResolvedValueOnce(passing);
    const wait = vi.fn(async () => undefined);

    await expect(
      retryHermesGatewayDraining({
        initialResult: gatewayResult(503, "gateway_draining"),
        retry,
        wait,
      }),
    ).resolves.toBe(passing);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 5_000);
    expect(wait).toHaveBeenNthCalledWith(2, 5_000);
  });

  it("stops after three gateway draining retries", async () => {
    const draining = gatewayResult(503, "gateway_draining");
    const retry = vi.fn(async () => draining);
    const wait = vi.fn(async () => undefined);

    await expect(
      retryHermesGatewayDraining({ initialResult: draining, retry, wait }),
    ).resolves.toBe(draining);
    expect(retry).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(3);
  });

  it("does not retry a different Hermes HTTP failure", async () => {
    const failed = gatewayResult(503, "other");
    const retry = vi.fn(async () => gatewayResult(200, "none"));
    const wait = vi.fn(async () => undefined);

    await expect(retryHermesGatewayDraining({ initialResult: failed, retry, wait })).resolves.toBe(
      failed,
    );
    expect(retry).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });
});
