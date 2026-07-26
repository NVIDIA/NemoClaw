// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HTTPS_PIN_RUNTIME_ADAPTER_BASE_ORIGIN } from "../../../src/lib/inference/https-pin-runtime.ts";
import { REGISTRY_FILE, type SandboxEntry } from "../../../src/lib/state/registry.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { resolveVerifiedCloudflaredBinary } from "./cloudflared-prerequisite.ts";
import {
  remapDnsRebindingHostname,
  restoreDnsRebindingHostsFixture,
  setupDnsRebindingHostsFixture,
} from "./dns-rebinding-hosts-fixture.ts";
import { startFakeHttpsCompatibleServer } from "./https-pin-compatible-server.ts";
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
import { startPublicMcpHttpsTunnel } from "./mcp-bridge-servers.ts";

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
    progress,
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
    progress,
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
      progress,
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
    progress,
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
    progress,
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
      progress,
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

test("TC-INF-11 DNS-backed HTTPS custom endpoint routes through the local pinning adapter (#6141)", {
  timeout: 20 * 60_000,
  meta: {
    e2ePhases: [
      "confirm live inference prerequisites",
      "clear the HTTPS pin sandbox",
      "start the public HTTPS compatible endpoint",
      "onboard with the placeholder endpoint",
      "reject credential-bearing endpoint state",
      "switch to the DNS-backed HTTPS endpoint",
      "verify pinned route isolation and DNS rebinding",
      "verify private redirect rejection",
    ],
  },
}, async ({ artifacts, cleanup, host, progress, sandbox, skip }) => {
  progress.phase("confirm live inference prerequisites");
  await requireLivePrerequisites(host, skip);
  const model = "nemoclaw-e2e-https-pin";
  const apiKey = "sk-https-pin-TEST-NOT-A-REAL-VALUE";
  const sandboxName = inferenceSandboxName("e2e-https-pin");
  cleanup.add(`best-effort inference-routing https-pin cleanup for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName),
  );
  progress.phase("clear the HTTPS pin sandbox");
  await cleanupSandbox(host, sandbox, sandboxName);

  progress.phase("start the public HTTPS compatible endpoint");
  const fake = await startFakeHttpsCompatibleServer({ apiKey, chatContent: "PONG", model });
  cleanup.add("close https-pin fake HTTPS compatible server", async () => {
    try {
      await artifacts.writeJson("tc-inf-11-https-pin-endpoint-requests.json", fake.requests());
    } finally {
      await fake.close();
    }
  });

  // A genuinely public, DNS-resolvable, publicly-trusted-certificate origin
  // is required: the adapter's SSRF preflight rejects loopback/private
  // addresses, and only a real TLS trust chain exercises its SNI-pinned
  // certificate validation. This reuses the same trycloudflare.com quick
  // tunnel mechanism as the MCP-bridge DNS-rebinding coverage.
  const cloudflaredBin = await resolveVerifiedCloudflaredBinary(cleanup, host);
  const tunnel = await startPublicMcpHttpsTunnel({
    cloudflaredBin,
    cleanup,
    label: "https-pin inference routing",
    progress,
    readinessPath: "/v1/models",
    readinessStatus: 401,
    server: fake,
  });
  const endpointUrl = `${tunnel.origin}/v1`;
  const endpointHostname = new URL(tunnel.origin).hostname;

  await artifacts.target.declare({
    id: "https-pin-runtime-adapter-dns-backed-endpoint",
    issue: 6141,
    contract: [
      "inference set routes a DNS-backed HTTPS endpoint through the local pinning adapter",
      "the real upstream hostname is never persisted to the NemoClaw sandbox registry",
      "credential-bearing query and userinfo endpoints are rejected without changing host state",
      "OpenShell's own policy view never references the real upstream hostname",
      "a real chat completion round-trips through the pinned TLS connection to the public endpoint",
      "a DNS rebind of the upstream hostname after inference set does not redirect adapter traffic",
      "an upstream redirect to a private target is rejected without relaying Location or reaching the target",
    ],
    endpointUrl,
    model,
  });

  // Onboarding's own SSRF preflight (assertEndpointResolvesPublic) only
  // rejects private/internal addresses; it does not fail closed on
  // DNS-backed HTTPS the way the HTTPS Pin Runtime adapter's call site does,
  // and onboarding never wires that adapter itself (only
  // inference-set-route-containment.ts's normalizeCustomEndpointUrl does, on
  // the `inference set --endpoint-url` path). Onboard with a disposable
  // plain-HTTP placeholder endpoint first -- the same shape TC-INF-09 already
  // onboards successfully with -- then switch to the DNS-backed HTTPS
  // endpoint through `inference set --endpoint-url`, the actual #6141 call
  // site this test exercises.
  // Advertise localhost so onboarding exercises its host-bridge rewrite, but
  // listen beyond host loopback so the resulting sandbox route can reach it.
  const placeholder = await startFakeOpenAiCompatibleServer({
    apiKey,
    chatContent: "placeholder",
    host: "0.0.0.0",
    model,
    port: 8000,
    progress,
    publicHost: "localhost",
    requireAuth: true,
    requireAuthModels: true,
  });
  cleanup.add("close https-pin onboarding placeholder endpoint", () => placeholder.close());

  progress.phase("onboard with the placeholder endpoint");
  const onboard = await onboardSandbox(
    artifacts,
    sandboxName,
    {
      COMPATIBLE_API_KEY: apiKey,
      NEMOCLAW_ENDPOINT_URL: placeholder.baseUrl,
      NEMOCLAW_MODEL: model,
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_PROVIDER: "custom",
    },
    [apiKey],
    "tc-inf-11-onboard-https-pin-placeholder",
    progress,
    15 * 60_000,
  );
  expectOnboardSuccess(onboard, "TC-INF-11 https-pin-endpoint placeholder onboard");
  cleanup.add(`strict inference-routing https-pin cleanup for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
  );

  progress.phase("reject credential-bearing endpoint state");
  const userinfoEndpoint = new URL(endpointUrl);
  userinfoEndpoint.username = "e2e-user";
  userinfoEndpoint.password = apiKey;
  for (const [shape, credentialEndpoint] of [
    ["userinfo", userinfoEndpoint.toString()],
    ["query", `${endpointUrl}?api_key=${encodeURIComponent(apiKey)}`],
  ] as const) {
    const rejected = await runNemoclawCli(
      [
        "inference",
        "set",
        "--provider",
        "compatible-endpoint",
        "--model",
        model,
        "--sandbox",
        sandboxName,
        "--endpoint-url",
        credentialEndpoint,
        "--credential-env",
        "COMPATIBLE_API_KEY",
        "--inference-api",
        "openai-completions",
      ],
      {
        artifactName: `tc-inf-11-reject-${shape}-endpoint`,
        artifacts,
        env: { ...buildAvailabilityProbeEnv(), COMPATIBLE_API_KEY: apiKey },
        progress,
        redactionValues: [apiKey],
        timeoutMs: 60_000,
      },
    );
    const rejectedText = redactedResultText(rejected);
    expect(rejected.exitCode, rejectedText).not.toBe(0);
    expect(rejectedText).toContain("without userinfo, query, or fragment components");
    const unchangedRegistry = fs.readFileSync(REGISTRY_FILE, "utf8");
    expect(unchangedRegistry).not.toContain(apiKey);
    expect(unchangedRegistry).not.toContain(endpointHostname);
  }

  progress.phase("switch to the DNS-backed HTTPS endpoint");
  const inferenceSet = await runNemoclawCli(
    [
      "inference",
      "set",
      "--provider",
      "compatible-endpoint",
      "--model",
      model,
      "--sandbox",
      sandboxName,
      "--endpoint-url",
      endpointUrl,
      "--credential-env",
      "COMPATIBLE_API_KEY",
      "--inference-api",
      "openai-completions",
    ],
    {
      artifactName: "tc-inf-11-inference-set-https-pin-endpoint",
      artifacts,
      env: { ...buildAvailabilityProbeEnv(), COMPATIBLE_API_KEY: apiKey },
      progress,
      redactionValues: [apiKey],
      timeoutMs: 60_000,
    },
  );
  expect(
    inferenceSet.exitCode,
    `TC-INF-11 inference set https-pin endpoint failed\n${redactedResultText(inferenceSet)}`,
  ).toBe(0);

  // The real hostname must never reach the NemoClaw sandbox registry on
  // disk: only the local adapter's host.openshell.internal route is
  // persisted (#6141 requirement: hostname hidden from the runtime
  // boundary; credential-bearing URL state is never persisted in plaintext).
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as {
    sandboxes?: Record<string, SandboxEntry>;
  };
  const registryEntry = registry.sandboxes?.[sandboxName];
  expect(registryEntry?.endpointUrl ?? "").toContain(
    `${HTTPS_PIN_RUNTIME_ADAPTER_BASE_ORIGIN}/route/`,
  );
  expect(registryEntry?.endpointUrl ?? "").not.toContain(endpointHostname);

  const provider = await sandbox.openshell(
    ["provider", "get", "-g", "nemoclaw", "compatible-endpoint"],
    {
      artifactName: "tc-inf-11-provider-get-compatible-endpoint",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  const providerText = resultText(provider).replace(/\u001b\[[0-9;]*m/g, "");
  expect(provider.exitCode, providerText).toBe(0);
  expect(providerText).toContain("Type: openai");
  expect(providerText).toContain("Credential keys: COMPATIBLE_API_KEY");
  expect(providerText).toContain("Config keys: OPENAI_BASE_URL");

  progress.phase("verify pinned route isolation and DNS rebinding");
  // OpenShell's own network-policy view is a second, independent witness:
  // it must never learn the real upstream hostname either, only the local
  // adapter's host.openshell.internal boundary that everything else here
  // already resolves through.
  const policy = await sandbox.openshell(["policy", "get", "--full", sandboxName], {
    artifactName: "tc-inf-11-policy-get-https-pin",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  const policyText = resultText(policy).replace(/\u001b\[[0-9;]*m/g, "");
  expect(policy.exitCode, policyText).toBe(0);
  expect(policyText).not.toContain(endpointHostname);

  const sandboxRequestOffset = fake.requests().length;
  // OpenShell 0.0.85 refreshes the sandbox-side inference bundle every five
  // seconds. Because this switch intentionally keeps the same provider/model
  // identity while replacing only its endpoint binding, an immediate request
  // can still use the placeholder route cached before `inference set`. Poll
  // through two refresh intervals, but accept success only after the real
  // pinned upstream records the authenticated request.
  let routeProbeAttempt = 0;
  await expect
    .poll(
      async () => {
        routeProbeAttempt += 1;
        await expectOpenAiChatThroughSandbox(
          sandbox,
          sandboxName,
          model,
          [apiKey],
          `https-pin-endpoint-inference-local-chat-${routeProbeAttempt}`,
        );
        return fake
          .requests()
          .slice(sandboxRequestOffset)
          .some(
            (request) =>
              request.auth === "ok" &&
              request.method === "POST" &&
              request.path === "/v1/chat/completions",
          );
      },
      { interval: 5_000, timeout: 11_000 },
    )
    .toBe(true);
  expect(fake.requests().slice(sandboxRequestOffset)).toContainEqual(
    expect.objectContaining({
      auth: "ok",
      method: "POST",
      path: "/v1/chat/completions",
    }),
  );

  // The assertions above only prove the *initial* `inference set` reached
  // the real target. They do not prove the adapter is resistant to a DNS
  // record changing after the route is already pinned -- the exact
  // SSRF/DNS-rebinding vulnerability the pinning mechanism exists to close.
  // Rebind the tunnel hostname to a reserved, unreachable documentation
  // address (RFC 5737 TEST-NET-1) now that the route is registered: if the
  // adapter re-resolved DNS per request instead of using the addresses it
  // already pinned, this chat call would fail to connect instead of
  // succeeding.
  const hostsFixture = await setupDnsRebindingHostsFixture(host, sandboxName, endpointHostname);
  cleanup.add(`restore https-pin DNS rebinding hosts fixture for ${sandboxName}`, () =>
    restoreDnsRebindingHostsFixture(host, sandboxName, hostsFixture),
  );
  await remapDnsRebindingHostname(
    host,
    sandboxName,
    hostsFixture,
    "192.0.2.1",
    "tc-inf-11-dns-rebind-after-inference-set",
  );

  const rebindRequestOffset = fake.requests().length;
  await expectOpenAiChatThroughSandbox(
    sandbox,
    sandboxName,
    model,
    [apiKey],
    "https-pin-endpoint-dns-rebinding-chat",
  );
  expect(fake.requests().slice(rebindRequestOffset)).toContainEqual(
    expect.objectContaining({
      auth: "ok",
      method: "POST",
      path: "/v1/chat/completions",
    }),
  );

  await restoreDnsRebindingHostsFixture(host, sandboxName, hostsFixture);

  progress.phase("verify private redirect rejection");
  const privateTargetRequestOffset = placeholder.requests().length;
  const redirectTarget = new URL("chat/completions", `${placeholder.baseUrl}/`).toString();
  fake.setChatRedirect(redirectTarget);
  const redirectPayload = JSON.stringify({
    model,
    messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
    max_tokens: 50,
  });
  const redirect = await sandbox.exec(
    sandboxName,
    [
      "curl",
      "-sS",
      "--include",
      "--location",
      "--max-redirs",
      "3",
      "--max-time",
      "60",
      "https://inference.local/v1/chat/completions",
      "-H",
      "Content-Type: application/json",
      "--data-raw",
      redirectPayload,
    ],
    {
      artifactName: "tc-inf-11-private-redirect-rejection",
      env: buildAvailabilityProbeEnv(),
      redactionValues: [apiKey],
      timeoutMs: 90_000,
    },
  );
  const redirectText = resultText(redirect);
  expect(redirect.exitCode, redirectText).toBe(0);
  expect(redirectText).toMatch(/HTTP\/1\.[01] 502/u);
  expect(redirectText).toContain("redirect_blocked");
  expect(redirectText.toLowerCase()).not.toContain("location:");
  expect(placeholder.requests()).toHaveLength(privateTargetRequestOffset);
});
