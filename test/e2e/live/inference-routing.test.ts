// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import {
  CREDENTIAL_CLASSIFICATION_PATTERN,
  cleanupSandbox,
  expectNoActiveSandbox,
  expectOnboardFailure,
  expectOnboardSuccess,
  expectOpenAiChatThroughSandbox,
  hasRawNodeStackTrace,
  inferenceSandboxName,
  onboardSandbox,
  redactedResultText,
  requireLivePrerequisites,
  runNemoclawCli,
  runRawCommand,
  TRANSPORT_CLASSIFICATION_PATTERN,
  writeFakeOpenShellForBlueprintFailClosed,
} from "./inference-routing-helpers.ts";

// This is the PR-required inference-routing lane. Credential-backed provider
// smokes live in inference-routing-provider-smoke.test.ts and are never selected
// by the PR-safe workflow job.

test("TC-INF-06 invalid API key fails with credential classification and cleanup", {
  timeout: 5 * 60_000,
  meta: {
    e2ePhases: [
      "confirm live inference prerequisites",
      "clear the invalid-key sandbox",
      "attempt onboard with an invalid NVIDIA credential",
      "confirm credential failure and no sandbox residue",
    ],
  },
}, async ({ artifacts, cleanup, host, progress, sandbox, skip }) => {
  await requireLivePrerequisites(host, skip);
  const sandboxName = inferenceSandboxName("e2e-invalid-key");
  cleanup.add(`remove inference-routing invalid-key residue for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName),
  );
  progress.phase("clear the invalid-key sandbox");
  await cleanupSandbox(host, sandbox, sandboxName);

  await artifacts.target.declare({
    id: "inference-routing-invalid-api-key",
    contract: [
      "invalid NVIDIA key exits non-zero",
      "output contains credential classification",
      "output does not expose raw stack trace or submitted key",
      "failed onboard leaves no active sandbox",
    ],
  });

  progress.phase("attempt onboard with an invalid NVIDIA credential");
  const invalidKey = ["nvapi", "INTENTIONALLY", "INVALID", "KEY", "FOR", "E2E", "TEST"].join("-");
  const result = await onboardSandbox(
    artifacts,
    sandboxName,
    { NVIDIA_INFERENCE_API_KEY: invalidKey },
    [invalidKey],
    "tc-inf-06-onboard-invalid-api-key",
    120_000,
  );
  const raw = resultText(result);
  const redacted = redactedResultText(result);

  progress.phase("confirm credential failure and no sandbox residue");
  expectOnboardFailure(result, "TC-INF-06 invalid-key onboard");
  expect(CREDENTIAL_CLASSIFICATION_PATTERN.test(raw), redacted).toBe(true);
  expect(hasRawNodeStackTrace(raw), redacted).toBe(false);
  expect(raw.includes("INTENTIONALLY-INVALID-KEY-FOR-E2E-TEST"), redacted).toBe(false);
  await expectNoActiveSandbox(host, sandboxName);
});

test("TC-INF-07 unreachable endpoint fails with transport classification and cleanup", {
  timeout: 5 * 60_000,
  meta: {
    e2ePhases: [
      "confirm live inference prerequisites",
      "clear the unreachable-endpoint sandbox",
      "attempt onboard against the unreachable endpoint",
      "confirm transport failure and no sandbox residue",
    ],
  },
}, async ({ artifacts, cleanup, host, progress, sandbox, skip }) => {
  await requireLivePrerequisites(host, skip);
  const sandboxName = inferenceSandboxName("e2e-unreachable");
  cleanup.add(`remove inference-routing unreachable residue for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName),
  );
  progress.phase("clear the unreachable-endpoint sandbox");
  await cleanupSandbox(host, sandbox, sandboxName);

  await artifacts.target.declare({
    id: "inference-routing-unreachable-endpoint",
    contract: [
      "unreachable custom endpoint exits non-zero",
      "output contains transport classification",
      "output does not expose raw stack trace",
      "failed onboard leaves no active sandbox",
    ],
  });

  progress.phase("attempt onboard against the unreachable endpoint");
  const nvidiaKey = ["nvapi", "valid", "format", "but", "fake", "key", "1234567890"].join("-");
  const compatibleKey = "fake-key-for-unreachable-test";
  const result = await onboardSandbox(
    artifacts,
    sandboxName,
    {
      COMPATIBLE_API_KEY: compatibleKey,
      NEMOCLAW_ENDPOINT_URL: "https://nemoclaw-e2e.invalid/v1",
      NEMOCLAW_MODEL: "test-model",
      NEMOCLAW_PROVIDER: "custom",
      NVIDIA_INFERENCE_API_KEY: nvidiaKey,
    },
    [nvidiaKey, compatibleKey],
    "tc-inf-07-onboard-unreachable-endpoint",
    120_000,
  );
  const raw = resultText(result);
  const redacted = redactedResultText(result);

  progress.phase("confirm transport failure and no sandbox residue");
  expectOnboardFailure(result, "TC-INF-07 unreachable-endpoint onboard");
  expect(TRANSPORT_CLASSIFICATION_PATTERN.test(raw), redacted).toBe(true);
  expect(hasRawNodeStackTrace(raw), redacted).toBe(false);
  await expectNoActiveSandbox(host, sandboxName);
});

test("TC-INF-10 DNS-backed HTTPS blueprint endpoint fails closed before OpenShell runtime handoff", {
  timeout: 5 * 60_000,
  meta: {
    e2ePhases: [
      "prepare the DNS-backed endpoint blueprint",
      "apply the blueprint with controlled DNS resolution",
      "confirm rejection before OpenShell handoff",
    ],
  },
}, async ({ artifacts, cleanup, progress }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-https-dns-fail-closed-"));
  const workdir = path.join(root, "blueprint");
  const fakeBinDir = path.join(root, "bin");
  const home = path.join(root, "home");
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  cleanup.add(`remove HTTPS DNS fail-closed temp root ${root}`, () => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const commandLogPath = writeFakeOpenShellForBlueprintFailClosed(fakeBinDir);
  fs.writeFileSync(
    path.join(workdir, "blueprint.yaml"),
    [
      'version: "1.0"',
      "components:",
      "  sandbox:",
      "    image: openclaw",
      "    name: e2e-https-dns-fail-closed",
      "  inference:",
      "    profiles:",
      "      default:",
      "        provider_type: openai",
      "        provider_name: default",
      "        endpoint: https://rebinding.example.test/v1",
      "        model: e2e-model",
      "        credential_env: E2E_API_KEY",
      "",
    ].join("\n"),
  );
  await artifacts.target.declare({
    id: "https-dns-backed-endpoint-fail-closed",
    issue: 4684,
    contract: [
      "DNS-backed HTTPS endpoint validation fails closed before handing config to OpenShell",
      "OpenShell sandbox/provider commands are not invoked for unsupported DNS-backed HTTPS endpoints",
      "The real runtime namespace is not given a host-loopback pin proxy URL as a partial fix",
    ],
  });

  const runnerScript = `
import dns from "node:dns";
const originalLookup = dns.promises.lookup;
dns.promises.lookup = ((hostname, options) => hostname === "rebinding.example.test"
  ? Promise.resolve([{ address: "93.184.216.34", family: 4 }])
  : originalLookup.call(dns.promises, hostname, options));
const { main } = await import(${JSON.stringify(path.join(REPO_ROOT, "nemoclaw/src/blueprint/runner.ts"))});
await main(["apply"]);
`;

  progress.phase("apply the blueprint with controlled DNS resolution");
  const result = await runRawCommand(
    process.execPath,
    [
      path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"),
      "--input-type=module",
      "--eval",
      runnerScript,
    ],
    {
      artifactName: "tc-inf-10-blueprint-https-dns-fail-closed",
      artifacts,
      cwd: workdir,
      env: {
        HOME: home,
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        E2E_API_KEY: "e2e-fake-key",
      },
      redactionValues: ["e2e-fake-key"],
      timeoutMs: 60_000,
    },
  );
  const raw = resultText(result);
  const openshellLog = fs.existsSync(commandLogPath) ? fs.readFileSync(commandLogPath, "utf8") : "";
  await artifacts.writeText("tc-inf-10-openshell-commands.jsonl", openshellLog);

  progress.phase("confirm rejection before OpenShell handoff");
  expectOnboardFailure(result, "TC-INF-10 DNS-backed HTTPS fail-closed blueprint apply");
  expect(raw).toMatch(/DNS-backed HTTPS endpoint/);
  expect(openshellLog).toBe("");
});

test("TC-INF-09 Deep Agents Code uses a local compatible endpoint through inference.local (#5744)", {
  timeout: 20 * 60_000,
  meta: {
    e2ePhases: [
      "confirm compatible-endpoint prerequisites",
      "start the local compatible endpoint",
      "onboard Deep Agents Code to the endpoint",
      "inspect the compatible provider route",
      "request sandbox chat through inference.local",
      "request a dcode completion through the route",
    ],
  },
}, async ({ artifacts, cleanup, host, progress, sandbox, skip }) => {
  const model = "nemoclaw-e2e-compatible";
  const apiKey = "sk-compatible-TEST-NOT-A-REAL-VALUE";
  await requireLivePrerequisites(host, skip);
  const sandboxName = inferenceSandboxName("e2e-compat-ep");
  cleanup.add(`best-effort inference-routing compatible-endpoint cleanup for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName),
  );
  await cleanupSandbox(host, sandbox, sandboxName);
  progress.phase("start the local compatible endpoint");
  const fake = await startFakeOpenAiCompatibleServer({
    apiKey,
    chatContent: "PONG",
    host: "0.0.0.0",
    model,
    port: 8000,
    publicHost: "localhost",
    requireAuth: true,
    requireAuthModels: true,
  });
  cleanup.add("close inference-routing compatible endpoint", async () => {
    try {
      await artifacts.writeJson("tc-inf-09-compatible-endpoint-requests.json", fake.requests());
    } finally {
      await fake.close();
    }
  });

  await artifacts.target.declare({
    id: "inference-routing-compatible-endpoint",
    contract: [
      "Deep Agents Code custom OpenAI-compatible endpoint onboards",
      "sandbox inference.local routes chat to compatible endpoint",
      "dcode returns the compatible endpoint response through the rewritten gateway route",
    ],
    endpointUrl: fake.baseUrl,
    model,
  });

  progress.phase("onboard Deep Agents Code to the endpoint");
  const onboard = await onboardSandbox(
    artifacts,
    sandboxName,
    {
      COMPATIBLE_API_KEY: apiKey,
      NEMOCLAW_AGENT: "langchain-deepagents-code",
      NEMOCLAW_ENDPOINT_URL: fake.baseUrl,
      NEMOCLAW_MODEL: model,
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_PROVIDER: "custom",
    },
    [apiKey],
    "tc-inf-09-onboard-compatible-endpoint",
    15 * 60_000,
  );
  expectOnboardSuccess(onboard, "TC-INF-09 compatible-endpoint onboard");
  cleanup.add(`strict inference-routing compatible-endpoint cleanup for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
  );
  progress.phase("inspect the compatible provider route");
  const provider = await sandbox.openshell(
    ["provider", "get", "-g", "nemoclaw", "compatible-endpoint"],
    {
      artifactName: "tc-inf-09-provider-get-compatible-endpoint",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  const providerText = resultText(provider).replace(/\u001b\[[0-9;]*m/g, "");
  expect(provider.exitCode, providerText).toBe(0);
  expect(providerText).toContain("Type: openai");
  expect(providerText).toContain("Credential keys: COMPATIBLE_API_KEY");
  expect(providerText).toContain("Config keys: OPENAI_BASE_URL");
  expect(fake.requests()).toContainEqual(
    expect.objectContaining({
      auth: "ok",
      hostHeader: "localhost:8000",
    }),
  );

  progress.phase("request sandbox chat through inference.local");
  const sandboxRequestOffset = fake.requests().length;
  await expectOpenAiChatThroughSandbox(
    sandbox,
    sandboxName,
    model,
    [apiKey],
    "compatible-endpoint-inference-local-chat",
  );
  expect(fake.requests().slice(sandboxRequestOffset)).toContainEqual(
    expect.objectContaining({
      auth: "ok",
      hostHeader: "host.openshell.internal:8000",
      method: "POST",
      model,
      path: "/v1/chat/completions",
    }),
  );

  progress.phase("request a dcode completion through the route");
  const dcodeRequestOffset = fake.requests().length;
  const dcode = await runNemoclawCli(
    [sandboxName, "exec", "--", "dcode", "-n", "Reply with exactly one word: PONG"],
    {
      artifactName: "tc-inf-09-dcode-compatible-endpoint",
      artifacts,
      env: buildAvailabilityProbeEnv(),
      redactionValues: [apiKey],
      timeoutMs: 3 * 60_000,
    },
  );
  const dcodeText = redactedResultText(dcode);
  expect(dcode.timedOut, `TC-INF-09 dcode timed out\n${dcodeText}`).toBe(false);
  expect(dcode.exitCode, `TC-INF-09 dcode failed\n${dcodeText}`).toBe(0);
  expect(dcodeText).toMatch(/\bPONG\b/);
  expect(fake.requests().slice(dcodeRequestOffset)).toContainEqual(
    expect.objectContaining({
      auth: "ok",
      hostHeader: "host.openshell.internal:8000",
      method: "POST",
      model,
      path: "/v1/chat/completions",
    }),
  );
});
