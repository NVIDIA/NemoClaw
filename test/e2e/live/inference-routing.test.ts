// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
  ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS,
} from "../../../tools/e2e/onboard-timeout-contract.mts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { type E2ETargetFixtures, expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { hostedInferenceCredentialReferencePattern } from "../fixtures/hosted-inference.ts";
import { OPENSHELL_V0116_QUALIFICATION } from "../fixtures/openshell-v0116-qualification.ts";
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
  captureOpenClawPairingDiagnosticsAfterFailedOnboard,
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
} from "./inference-routing-helpers.ts";
import { startPublicMcpHttpsTunnel } from "./mcp-bridge-servers.ts";
import { startRuntimeIdentityOAuthServer } from "./runtime-identity-oauth-server.ts";
// This is the PR-required inference-routing lane. Credential-backed provider
// smokes live in inference-routing-provider-smoke.test.ts and are never selected
// by the PR-safe workflow job.

test(
  "TC-INF-06 invalid API key fails with credential classification and cleanup",
  {
    timeout: 5 * 60_000,
    meta: {
      e2ePhases: [
        "confirm live inference prerequisites",
        "clear the invalid-key sandbox",
        "attempt onboard with an invalid NVIDIA credential",
        "confirm credential failure and no sandbox residue",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    await requireLivePrerequisites(host, runtimeProvider);
    const sandboxName = inferenceSandboxName("e2e-badkey");
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
  },
);

test(
  "TC-INF-07 unreachable endpoint fails with transport classification and cleanup",
  {
    timeout: 5 * 60_000,
    meta: {
      e2ePhases: [
        "confirm live inference prerequisites",
        "clear the unreachable-endpoint sandbox",
        "attempt onboard against the unreachable endpoint",
        "confirm transport failure and no sandbox residue",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    await requireLivePrerequisites(host, runtimeProvider);
    const sandboxName = inferenceSandboxName("e2e-unreach");
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
  },
);

interface RuntimeIdentityE2EScenario {
  readonly testId: "TC-INF-12" | "TC-INF-13";
  readonly providerType: string;
  readonly credentialKey: string;
  readonly clientIdEnvironmentName: string;
  readonly refreshTokenEnvironmentName: string;
  readonly clientSecretEnvironmentName: string;
  readonly tokenPath: string;
  readonly resourcePath: string;
  readonly reviewedResourcePath: string;
  readonly deniedMethod: "GET" | "POST";
  readonly deniedPath: string;
  readonly targetId: string;
}

const RUNTIME_IDENTITY_E2E_SCENARIOS = [
  [
    "12",
    "",
    {
      testId: "TC-INF-12",
      providerType: "oauth2-runtime-conformance-v1",
      credentialKey: "E2E_ACCESS_TOKEN",
      clientIdEnvironmentName: "E2E_CLIENT_ID",
      refreshTokenEnvironmentName: "E2E_REFRESH_TOKEN",
      clientSecretEnvironmentName: "E2E_CLIENT_SECRET",
      tokenPath: "/oauth/token",
      resourcePath: "/resource",
      reviewedResourcePath: "/**",
      deniedMethod: "POST",
      deniedPath: "/resource",
      targetId: "runtime-identity-reference-real-oauth-lifecycle",
    },
  ],
  [
    "13",
    "Entra Graph ",
    {
      testId: "TC-INF-13",
      providerType: "entra-runtime-v1",
      credentialKey: "ENTRA_ACCESS_TOKEN",
      clientIdEnvironmentName: "ENTRA_CLIENT_ID",
      refreshTokenEnvironmentName: "ENTRA_REFRESH_TOKEN",
      clientSecretEnvironmentName: "ENTRA_CLIENT_SECRET",
      tokenPath: "/organizations/oauth2/v2.0/token",
      resourcePath: "/v1.0/me",
      reviewedResourcePath: "/v1.0/me",
      deniedMethod: "GET",
      deniedPath: "/v1.0/users",
      targetId: "entra-runtime-identity-real-oauth-lifecycle",
    },
  ],
] as const satisfies readonly (readonly [string, string, RuntimeIdentityE2EScenario])[];

type RuntimeIdentityE2EContext = Pick<
  E2ETargetFixtures,
  "artifacts" | "cleanup" | "host" | "progress" | "runtimeProvider" | "sandbox"
> & {
  skip: (note?: string) => never;
};

const RUNTIME_IDENTITY_E2E_OPTIONS = {
  timeout: ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "confirm live runtime identity prerequisites",
      "onboard a real OpenShell sandbox",
      "start the public OAuth issuer and protected resource",
      "apply and attach the runtime identity through OpenShell",
      "prove inference remains live after identity attachment",
      "call the protected resource with the injected bearer",
      "reject unreviewed credential delivery before bearer substitution",
      "rotate the credential behind its placeholder",
      "verify refused unsafe rollback preserves live resources",
    ],
  },
} as const;

async function runRuntimeIdentityE2EScenario(
  scenario: RuntimeIdentityE2EScenario,
  context: RuntimeIdentityE2EContext,
): Promise<void> {
  const { artifacts, cleanup, host, progress, runtimeProvider, sandbox } = context;
  const artifactPrefix = scenario.testId.toLowerCase();
  progress.phase("confirm live runtime identity prerequisites");
  await requireLivePrerequisites(host, runtimeProvider);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-identity-e2e-"));
  const workdir = path.join(root, "blueprint");
  const profileDir = path.join(workdir, "provider-profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  cleanup.add(`remove runtime identity E2E temp root ${root}`, () => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const model = "nemoclaw-e2e-runtime-identity";
  const inferenceKey = "sk-runtime-identity-TEST-NOT-A-REAL-VALUE";
  const sandboxName = inferenceSandboxName(`e2e-i${scenario.testId.slice(-2)}`);
  const providerType = scenario.providerType;
  const providerName = `e2e-${scenario.providerType}-${String(process.pid)}`;
  const credentialKey = scenario.credentialKey;
  const clientId = "e2e-runtime-identity-client-id";
  const refreshToken = "e2e-runtime-identity-refresh-token-v1";
  const clientSecret = "e2e-runtime-identity-client-secret";
  const openshellEnv = {
    ...buildAvailabilityProbeEnv(),
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
  cleanup.add(`best-effort runtime identity sandbox cleanup for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName),
  );
  cleanup.add(`strict runtime identity sandbox cleanup for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
  );
  await cleanupSandbox(host, sandbox, sandboxName);
  const inference = await startFakeOpenAiCompatibleServer({
    apiKey: inferenceKey,
    chatContent: "PONG",
    host: "0.0.0.0",
    model,
    port: 8000,
    progress,
    publicHost: "localhost",
    requireAuth: true,
    requireAuthModels: true,
  });
  cleanup.add("close runtime identity inference prerequisite", async () => {
    try {
      await artifacts.writeJson(`${artifactPrefix}-inference-requests.json`, inference.requests());
    } finally {
      await inference.close();
    }
  });
  progress.phase("onboard a real OpenShell sandbox");
  const onboard = await onboardSandbox(
    artifacts,
    sandboxName,
    {
      COMPATIBLE_API_KEY: inferenceKey,
      NEMOCLAW_ENDPOINT_URL: inference.baseUrl,
      NEMOCLAW_MODEL: model,
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_PROVIDER: "custom",
    },
    [inferenceKey],
    `${artifactPrefix}-onboard-real-openshell-sandbox`,
    progress,
    ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
  );
  expectOnboardSuccess(onboard, `${scenario.testId} real OpenShell prerequisite onboard`);
  // Remove stale fixture-owned objects left by a previously interrupted local
  // run. Both operations are best-effort and target only this E2E namespace.
  await sandbox.openshell(["provider", "delete", providerName], {
    artifactName: `${artifactPrefix}-preclean-provider`,
    env: openshellEnv,
    timeoutMs: 30_000,
  });
  await sandbox.openshell(["provider", "profile", "delete", providerType], {
    artifactName: `${artifactPrefix}-preclean-profile`,
    env: openshellEnv,
    timeoutMs: 30_000,
  });
  const settingsBefore = await sandbox.openshell(["settings", "get", "--global", "--json"], {
    artifactName: `${artifactPrefix}-provider-policy-setting-before`,
    env: openshellEnv,
    timeoutMs: 30_000,
  });
  expect(settingsBefore.exitCode, resultText(settingsBefore)).toBe(0);
  const settingsDocument = JSON.parse(settingsBefore.stdout) as {
    settings?: Record<string, string>;
  };
  const priorProvidersV2Setting = settingsDocument.settings?.providers_v2_enabled;
  const restoreSettingArgs = new Map<string, string[]>([
    ["<unset>", ["settings", "delete", "--global", "--key", "providers_v2_enabled", "--yes"]],
    [
      "false",
      ["settings", "set", "--global", "--key", "providers_v2_enabled", "--value", "false", "--yes"],
    ],
    [
      "true",
      ["settings", "set", "--global", "--key", "providers_v2_enabled", "--value", "true", "--yes"],
    ],
  ]).get(priorProvidersV2Setting ?? "");
  expect(restoreSettingArgs).toBeDefined();
  cleanup.add("restore OpenShell provider-derived policy setting", async () => {
    const restored = await sandbox.openshell(restoreSettingArgs!, {
      artifactName: `${artifactPrefix}-provider-policy-setting-restore`,
      env: openshellEnv,
      timeoutMs: 30_000,
    });
    expect(restored.exitCode, resultText(restored)).toBe(0);
  });
  const enableProviderPolicy = await sandbox.openshell(
    ["settings", "set", "--global", "--key", "providers_v2_enabled", "--value", "true", "--yes"],
    {
      artifactName: `${artifactPrefix}-provider-policy-setting-enable`,
      env: openshellEnv,
      timeoutMs: 30_000,
    },
  );
  expect(enableProviderPolicy.exitCode, resultText(enableProviderPolicy)).toBe(0);
  progress.phase("start the public OAuth issuer and protected resource");
  const oauth = await startRuntimeIdentityOAuthServer({
    clientId,
    clientSecret,
    initialRefreshToken: refreshToken,
    resourcePath: scenario.resourcePath,
    tokenPath: scenario.tokenPath,
  });
  cleanup.add("close runtime identity OAuth fixture", async () => {
    try {
      await artifacts.writeJson(
        `${artifactPrefix}-oauth-token-requests.json`,
        oauth.tokenRequests(),
      );
      await artifacts.writeJson(
        `${artifactPrefix}-protected-resource-requests.json`,
        oauth.resourceRequests(),
      );
    } finally {
      await oauth.close();
    }
  });
  const cloudflaredBin = await resolveVerifiedCloudflaredBinary(cleanup, host);
  const tunnel = await startPublicMcpHttpsTunnel({
    cloudflaredBin,
    cleanup,
    label: "runtime identity OAuth",
    progress,
    readinessPath: scenario.resourcePath,
    readinessStatus: 401,
    server: oauth,
  });
  const endpoint = new URL(tunnel.origin);
  const runtimeIdentityProfilePolicy = {
    providerType,
    clientIdEnvironmentName: scenario.clientIdEnvironmentName,
    dnsResolution: "identity-platform-controlled",
    tokenIssuer: {
      trustedHostnames: [endpoint.hostname],
      trustedHostSuffixes: [],
    },
    credentialDelivery: {
      method: "GET",
      path: scenario.reviewedResourcePath,
      trustedHostnames: [endpoint.hostname],
      trustedHostSuffixes: [],
    },
    trustedBinaries: [
      "/usr/local/bin/node",
      "/usr/bin/node",
      "/usr/local/bin/curl",
      "/usr/bin/curl",
    ],
  };
  const profileFilename = `${providerType}.yaml`;
  const profilePath = path.join(profileDir, profileFilename);
  fs.writeFileSync(
    profilePath,
    [
      `id: ${providerType}`,
      `display_name: ${scenario.testId} Runtime Identity Conformance`,
      `description: Deterministic ${scenario.testId} OAuth refresh and bearer-injection conformance profile`,
      "category: agent",
      "credentials:",
      `  - name: ${credentialKey}`,
      "    description: Short-lived conformance access token",
      "    env_vars:",
      `      - ${credentialKey}`,
      "    required: true",
      "    auth_style: bearer",
      "    header_name: authorization",
      "    refresh:",
      "      strategy: oauth2_refresh_token",
      `      token_url: ${tunnel.origin}${scenario.tokenPath}`,
      "      refresh_before_seconds: 300",
      "      max_lifetime_seconds: 3600",
      "      material:",
      "        - name: client_id",
      "          required: true",
      "        - name: refresh_token",
      "          required: true",
      "          secret: true",
      "        - name: client_secret",
      "          required: false",
      "          secret: true",
      "endpoints:",
      `  - host: ${endpoint.hostname}`,
      "    port: 443",
      "    protocol: rest",
      "    enforcement: enforce",
      "    rules:",
      `      - allow: { method: GET, path: "${scenario.reviewedResourcePath}" }`,
      "binaries:",
      "  - /usr/local/bin/node",
      "  - /usr/bin/node",
      "  - /usr/local/bin/curl",
      "  - /usr/bin/curl",
      "inference_capable: false",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(workdir, "blueprint.yaml"),
    [
      'version: "1.0"',
      "components:",
      "  sandbox:",
      "    image: openclaw",
      `    name: ${sandboxName}`,
      "  inference:",
      "    profiles:",
      "      default:",
      "        provider_type: openai",
      "        provider_name: compatible-endpoint",
      `        model: ${model}`,
      "  identity:",
      `    profile_path: provider-profiles/${profileFilename}`,
      `    provider_type: ${providerType}`,
      `    provider_name: ${providerName}`,
      `    credential_key: ${credentialKey}`,
      `    client_id_env: ${scenario.clientIdEnvironmentName}`,
      `    refresh_token_env: ${scenario.refreshTokenEnvironmentName}`,
      `    client_secret_env: ${scenario.clientSecretEnvironmentName}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const redactionValues = [...oauth.secretValues(), inferenceKey];
  const runnerPath = path.join(REPO_ROOT, "nemoclaw/src/blueprint/runner.ts");
  const tsxPath = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
  const runnerEnv = {
    ...openshellEnv,
    [scenario.clientIdEnvironmentName]: clientId,
    [scenario.refreshTokenEnvironmentName]: refreshToken,
    [scenario.clientSecretEnvironmentName]: clientSecret,
  };
  await artifacts.target.declare({
    id: scenario.targetId,
    issue: 6871,
    contract: [
      "the blueprint runner imports the profile, creates and attaches the provider through real OpenShell",
      "apply preserves the already-active provider and model route before attaching identity",
      "OpenShell exchanges the refresh token at a public HTTPS OAuth endpoint",
      `credential delivery is restricted to GET ${scenario.reviewedResourcePath}`,
      "a sandbox request carries only an opaque placeholder and the protected resource receives the minted bearer",
      "credential rotation updates the bearer resolved from the existing placeholder",
      "apply output contains no OAuth secret material",
      "unsafe rollback preserves the reused sandbox and provider",
    ],
    openshellBoundary: "real gateway, provider refresh, attachment, sandbox exec, L7 injection",
    oauthBoundary: "public DNS and publicly trusted TLS through trycloudflare.com",
  });
  progress.phase("apply and attach the runtime identity through OpenShell");
  const apply = await runRawCommand(
    process.execPath,
    [
      tsxPath,
      "--input-type=module",
      "--eval",
      `const { main } = await import(${JSON.stringify(runnerPath)}); await main(["apply"], { runtimeIdentityProfilePolicy: ${JSON.stringify(runtimeIdentityProfilePolicy)} });`,
    ],
    {
      artifactName: `${artifactPrefix}-runtime-identity-apply`,
      artifacts,
      cwd: workdir,
      env: runnerEnv,
      progress,
      redactionValues,
      timeoutMs: 5 * 60_000,
    },
  );
  const applyText = resultText(apply);
  expect(apply.exitCode, applyText).toBe(0);
  for (const secret of redactionValues) expect(applyText).not.toContain(secret);
  const runId = /^RUN_ID:(\S+)$/m.exec(apply.stdout)?.[1];
  expect(runId).toMatch(/^nc-[A-Za-z0-9-]+$/);
  progress.phase("prove inference remains live after identity attachment");
  const inferenceRequestOffset = inference.requests().length;
  await expectOpenAiChatThroughSandbox(
    sandbox,
    sandboxName,
    model,
    [inferenceKey],
    `${artifactPrefix}-inference-after-identity-attach`,
  );
  expect(inference.requests().length).toBeGreaterThan(inferenceRequestOffset);
  progress.phase("call the protected resource with the injected bearer");
  let placeholder = "";
  let placeholderProbeAttempt = 0;
  const placeholderPattern = hostedInferenceCredentialReferencePattern(credentialKey);
  await expect
    .poll(
      async () => {
        placeholderProbeAttempt += 1;
        const probe = await sandbox.exec(sandboxName, ["/usr/bin/printenv", credentialKey], {
          artifactName: `${artifactPrefix}-placeholder-before-rotation-${placeholderProbeAttempt}`,
          env: openshellEnv,
          timeoutMs: 30_000,
        });
        placeholder = probe.exitCode === 0 ? probe.stdout.trim() : "";
        return placeholder;
      },
      { interval: 2_000, timeout: 35_000 },
    )
    .toMatch(placeholderPattern);
  for (const secret of redactionValues) expect(placeholder).not.toContain(secret);
  const expectProtectedResourceVersion = async (
    projectedPlaceholder: string,
    expectedVersion: number,
    artifactPrefix: string,
  ): Promise<void> => {
    let attempt = 0;
    await expect
      .poll(
        async () => {
          attempt += 1;
          const resource = await sandbox.exec(
            sandboxName,
            [
              "/usr/bin/curl",
              "-fsS",
              "-H",
              `Authorization: Bearer ${projectedPlaceholder}`,
              `${tunnel.origin}${scenario.resourcePath}`,
            ],
            {
              artifactName: `${artifactPrefix}-${attempt}`,
              env: openshellEnv,
              timeoutMs: 60_000,
            },
          );
          let response: unknown = null;
          try {
            response = JSON.parse(resource.stdout);
          } catch {
            response = null;
          }
          return { exitCode: resource.exitCode, response };
        },
        { interval: 2_000, timeout: 35_000 },
      )
      .toEqual({
        exitCode: 0,
        response: {
          authenticated: true,
          access_token_version: expectedVersion,
        },
      });
  };
  await expectProtectedResourceVersion(placeholder, 1, `${artifactPrefix}-protected-resource-v1`);
  progress.phase("reject unreviewed credential delivery before bearer substitution");
  const admittedRequestCount = oauth.resourceRequests().length;
  const deniedResource = await sandbox.exec(
    sandboxName,
    [
      "/usr/bin/curl",
      "-fsS",
      "-X",
      scenario.deniedMethod,
      "-H",
      `Authorization: Bearer ${placeholder}`,
      `${tunnel.origin}${scenario.deniedPath}`,
    ],
    {
      artifactName: `${artifactPrefix}-unreviewed-resource-policy`,
      env: openshellEnv,
      timeoutMs: 60_000,
    },
  );
  expect(deniedResource.exitCode, resultText(deniedResource)).not.toBe(0);
  expect(oauth.resourceRequests()).toHaveLength(admittedRequestCount);
  progress.phase("rotate the credential behind its placeholder");
  const rotate = await sandbox.openshell(
    ["provider", "refresh", "rotate", providerName, "--credential-key", credentialKey],
    {
      artifactName: `${artifactPrefix}-provider-refresh-rotate-v2`,
      env: openshellEnv,
      timeoutMs: 60_000,
    },
  );
  expect(rotate.exitCode, resultText(rotate)).toBe(0);
  await expectProtectedResourceVersion(placeholder, 2, `${artifactPrefix}-protected-resource-v2`);
  progress.phase("verify refused unsafe rollback preserves live resources");
  const rollback = await runRawCommand(
    process.execPath,
    [
      tsxPath,
      "--input-type=module",
      "--eval",
      `const { main } = await import(${JSON.stringify(runnerPath)}); await main(["rollback", "--run-id", ${JSON.stringify(runId!)}]);`,
    ],
    {
      artifactName: `${artifactPrefix}-runtime-identity-rollback`,
      artifacts,
      cwd: workdir,
      env: runnerEnv,
      progress,
      redactionValues,
      timeoutMs: 2 * 60_000,
    },
  );
  expect(rollback.exitCode, resultText(rollback)).not.toBe(0);
  const providerAfterRollback = await sandbox.openshell(["provider", "get", providerName], {
    artifactName: `${artifactPrefix}-provider-after-rollback`,
    env: openshellEnv,
    timeoutMs: 30_000,
  });
  expect(providerAfterRollback.exitCode, resultText(providerAfterRollback)).toBe(0);
  const reusedSandboxAfterRollback = await sandbox.openshell(["sandbox", "get", sandboxName], {
    artifactName: `${artifactPrefix}-reused-sandbox-after-rollback`,
    env: openshellEnv,
    timeoutMs: 30_000,
  });
  expect(reusedSandboxAfterRollback.exitCode, resultText(reusedSandboxAfterRollback)).toBe(0);
  const detachProvider = await sandbox.openshell(
    ["sandbox", "provider", "detach", sandboxName, providerName],
    {
      artifactName: `${artifactPrefix}-detach-conformance-provider`,
      env: openshellEnv,
      timeoutMs: 30_000,
    },
  );
  expect(detachProvider.exitCode, resultText(detachProvider)).toBe(0);
  const deleteProvider = await sandbox.openshell(["provider", "delete", providerName], {
    artifactName: `${artifactPrefix}-delete-conformance-provider`,
    env: openshellEnv,
    timeoutMs: 30_000,
  });
  expect(deleteProvider.exitCode, resultText(deleteProvider)).toBe(0);
  const deleteProfile = await sandbox.openshell(["provider", "profile", "delete", providerType], {
    artifactName: `${artifactPrefix}-delete-conformance-profile`,
    env: openshellEnv,
    timeoutMs: 30_000,
  });
  expect(deleteProfile.exitCode, resultText(deleteProfile)).toBe(0);
}

// OpenShell 0.0.116 projects provider-refresh credentials into Docker sandboxes.
test
  .skipIf(!OPENSHELL_V0116_QUALIFICATION.supportsRuntimeIdentityRefreshProjection)
  .for(RUNTIME_IDENTITY_E2E_SCENARIOS)(
  "TC-INF-%s %sruntime identity refreshes and injects a delegated bearer through real OpenShell",
  RUNTIME_IDENTITY_E2E_OPTIONS,
  async (
    [, , scenario],
    { artifacts, cleanup, host, progress, runtimeProvider, sandbox, skip },
  ) => {
    await runRuntimeIdentityE2EScenario(scenario, {
      artifacts,
      cleanup,
      host,
      progress,
      runtimeProvider,
      sandbox,
      skip,
    });
  },
);

test(
  "TC-INF-09 local compatible endpoint routes through inference.local (#5744)",
  {
    timeout: ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm compatible-endpoint prerequisites",
        "start the local compatible endpoint",
        "onboard to the compatible endpoint",
        "request sandbox chat through inference.local",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    const model = "nemoclaw-e2e-compatible";
    const apiKey = "sk-compatible-TEST-NOT-A-REAL-VALUE";
    await requireLivePrerequisites(host, runtimeProvider);
    const sandboxName = inferenceSandboxName("e2e-compat");
    cleanup.add(
      `best-effort inference-routing compatible-endpoint cleanup for ${sandboxName}`,
      () => cleanupSandbox(host, sandbox, sandboxName),
    );
    cleanup.add(`strict inference-routing compatible-endpoint cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
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
        "a custom OpenAI-compatible endpoint onboards",
        "sandbox inference.local routes chat to compatible endpoint",
      ],
      endpointUrl: fake.baseUrl,
      model,
    });
    progress.phase("onboard to the compatible endpoint");
    const onboard = await onboardSandbox(
      artifacts,
      sandboxName,
      {
        COMPATIBLE_API_KEY: apiKey,
        NEMOCLAW_ENDPOINT_URL: fake.baseUrl,
        NEMOCLAW_MODEL: model,
        NEMOCLAW_PREFERRED_API: "openai-completions",
        NEMOCLAW_PROVIDER: "custom",
      },
      [apiKey],
      "tc-inf-09-onboard-compatible-endpoint",
      progress,
      ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
    );
    expectOnboardSuccess(onboard, "TC-INF-09 compatible-endpoint onboard");
    progress.phase("request sandbox chat through inference.local");
    const sandboxRequestOffset = fake.requests().length;
    await expectOpenAiChatThroughSandbox(
      sandbox,
      sandboxName,
      model,
      [apiKey],
      "compatible-endpoint-inference-local-chat",
    );
    expect(
      fake
        .requests()
        .slice(sandboxRequestOffset)
        .some(
          (request) =>
            request.auth === "ok" &&
            request.method === "POST" &&
            request.path === "/v1/chat/completions",
        ),
    ).toBe(true);
  },
);

test(
  "TC-INF-11 DNS-backed HTTPS custom endpoint routes through the local pinning adapter (#6141)",
  {
    timeout: ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm live inference prerequisites",
        "clear the HTTPS pin sandbox",
        "start the public HTTPS compatible endpoint",
        "onboard with the placeholder endpoint",
        "switch to the DNS-backed HTTPS endpoint",
        "verify pinned route isolation and DNS rebinding",
        "verify private redirect rejection",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    progress.phase("confirm live inference prerequisites");
    await requireLivePrerequisites(host, runtimeProvider);
    const model = "nemoclaw-e2e-https-pin";
    const apiKey = "sk-https-pin-TEST-NOT-A-REAL-VALUE";
    const sandboxName = inferenceSandboxName("e2e-https");
    cleanup.add(`best-effort inference-routing https-pin cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName),
    );
    cleanup.add(`strict inference-routing https-pin cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
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
      ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
    );
    await captureOpenClawPairingDiagnosticsAfterFailedOnboard(onboard, sandbox, sandboxName, [
      apiKey,
    ]);
    expectOnboardSuccess(onboard, "TC-INF-11 https-pin-endpoint placeholder onboard");
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
    expect(
      fake
        .requests()
        .slice(rebindRequestOffset)
        .some(
          (request) =>
            request.auth === "ok" &&
            request.method === "POST" &&
            request.path === "/v1/chat/completions",
        ),
    ).toBe(true);
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
  },
);
