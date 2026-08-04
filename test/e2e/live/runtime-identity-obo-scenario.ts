// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { type E2ETargetFixtures, expect } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { resolveVerifiedCloudflaredBinary } from "./cloudflared-prerequisite.ts";
import {
  cleanupSandbox,
  expectOnboardSuccess,
  inferenceSandboxName,
  onboardSandbox,
  requireLivePrerequisites,
  runRawCommand,
} from "./inference-routing-helpers.ts";
import { startPublicMcpHttpsTunnel } from "./mcp-bridge-servers.ts";
import { startRuntimeIdentityOAuthServer } from "./runtime-identity-oauth-server.ts";

type RuntimeIdentityOboContext = Pick<
  E2ETargetFixtures,
  "artifacts" | "cleanup" | "host" | "progress" | "sandbox"
> & {
  skip: (note?: string) => never;
};

export const RUNTIME_IDENTITY_OBO_E2E_OPTIONS = {
  timeout: 20 * 60_000,
  meta: {
    e2ePhases: [
      "confirm live OBO prerequisites",
      "establish the reusable inference route",
      "start the public OBO issuer and protected resource",
      "apply OBO identity and create the sandbox through OpenShell",
      "prove admitted bearer delivery and denied-request isolation",
      "rollback the owned OBO sandbox and provider",
    ],
  },
} as const;

export async function runRuntimeIdentityOboE2EScenario(
  context: RuntimeIdentityOboContext,
): Promise<void> {
  const { artifacts, cleanup, host, progress, sandbox, skip } = context;
  const artifactPrefix = "tc-inf-14";
  await requireLivePrerequisites(host, skip);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-identity-obo-e2e-"));
  const workdir = path.join(root, "blueprint");
  const profileDir = path.join(workdir, "provider-profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  cleanup.add(`remove OBO runtime identity E2E temp root ${root}`, () => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const model = "nemoclaw-e2e-runtime-identity-obo";
  const inferenceKey = "sk-runtime-identity-obo-TEST-NOT-A-REAL-VALUE";
  const prerequisiteSandboxName = inferenceSandboxName("e2e-tc-inf-14-prerequisite");
  const sandboxName = inferenceSandboxName("e2e-tc-inf-14");
  const providerType = "okta-obo-v1";
  const providerName = `e2e-okta-obo-v1-${String(process.pid)}`;
  const credentialKey = "OKTA_OBO_ACCESS_TOKEN";
  const clientId = "e2e-okta-obo-client-id";
  const clientSecret = "e2e-okta-obo-client-secret";
  const subjectToken = "e2e-okta-obo-subject-token";
  const delegatedToken = "e2e-okta-obo-delegated-token";
  const audience = "api://nemoclaw-e2e";
  const scope = "resource.read";
  const tokenPath = "/oauth/token";
  const resourcePath = "/resource";
  const openshellEnv = {
    ...buildAvailabilityProbeEnv(),
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };

  cleanup.add(`remove OBO runtime identity sandbox residue for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName),
  );
  cleanup.add(`remove OBO prerequisite sandbox residue for ${prerequisiteSandboxName}`, () =>
    cleanupSandbox(host, sandbox, prerequisiteSandboxName),
  );
  await cleanupSandbox(host, sandbox, sandboxName);
  await cleanupSandbox(host, sandbox, prerequisiteSandboxName);

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
  cleanup.add("close OBO runtime identity inference prerequisite", () => inference.close());

  progress.phase("establish the reusable inference route");
  const onboard = await onboardSandbox(
    artifacts,
    prerequisiteSandboxName,
    {
      COMPATIBLE_API_KEY: inferenceKey,
      NEMOCLAW_ENDPOINT_URL: inference.baseUrl,
      NEMOCLAW_MODEL: model,
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_PROVIDER: "custom",
    },
    [inferenceKey],
    `${artifactPrefix}-onboard-inference-prerequisite`,
    progress,
    15 * 60_000,
  );
  expectOnboardSuccess(onboard, "TC-INF-14 inference prerequisite onboard");

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
  ]).get(settingsDocument.settings?.providers_v2_enabled ?? "");
  expect(restoreSettingArgs).toBeDefined();
  cleanup.add("restore OBO provider-derived policy setting", async () => {
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

  progress.phase("start the public OBO issuer and protected resource");
  const oauth = await startRuntimeIdentityOAuthServer({
    clientId,
    clientSecret,
    resourcePath,
    tokenPath,
    tokenExchange: { subjectToken, audience, scope, accessToken: delegatedToken },
  });
  cleanup.add("close OBO token-exchange fixture", async () => {
    try {
      await artifacts.writeJson(
        `${artifactPrefix}-token-exchange-requests.json`,
        oauth.tokenExchangeRequests(),
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
    label: "runtime identity OBO",
    progress,
    readinessPath: resourcePath,
    readinessStatus: 401,
    server: oauth,
  });
  const endpoint = new URL(tunnel.origin);

  fs.writeFileSync(
    path.join(profileDir, `${providerType}.yaml`),
    [
      `id: ${providerType}`,
      "display_name: TC-INF-14 Okta OBO Runtime Identity Conformance",
      "description: Deterministic host exchange and real OpenShell bearer-injection conformance profile",
      "category: agent",
      "credentials:",
      `  - name: ${credentialKey}`,
      "    description: Short-lived conformance delegated token",
      "    env_vars:",
      `      - ${credentialKey}`,
      "    required: true",
      "    auth_style: bearer",
      "    header_name: authorization",
      "endpoints:",
      `  - host: ${endpoint.hostname}`,
      "    port: 443",
      "    protocol: rest",
      "    enforcement: enforce",
      "    rules:",
      `      - allow: { method: GET, path: "${resourcePath}" }`,
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
      `    profile_path: provider-profiles/${providerType}.yaml`,
      `    provider_type: ${providerType}`,
      `    provider_name: ${providerName}`,
      `    credential_key: ${credentialKey}`,
      "    client_id_env: OKTA_CLIENT_ID",
      "    client_secret_env: OKTA_CLIENT_SECRET",
      "    subject_token_env: OKTA_SUBJECT_TOKEN",
      `    token_url: ${tunnel.origin}${tokenPath}`,
      `    audience: ${audience}`,
      "    scopes:",
      `      - ${scope}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const runtimeIdentityProfilePolicy = {
    providerType,
    clientIdEnvironmentName: "OKTA_CLIENT_ID",
    flow: "oauth2-token-exchange" as const,
    dnsResolution: "identity-platform-controlled",
    tokenIssuer: {
      trustedHostnames: [endpoint.hostname],
      trustedHostSuffixes: [],
    },
    credentialDelivery: {
      method: "GET",
      path: resourcePath,
      hostPolicy: "reviewed" as const,
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
  const redactionValues = [...oauth.secretValues(), inferenceKey];
  const runnerPath = path.join(REPO_ROOT, "nemoclaw/src/blueprint/runner.ts");
  const tsxPath = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
  const runnerEnv = {
    ...openshellEnv,
    OKTA_CLIENT_ID: clientId,
    OKTA_CLIENT_SECRET: clientSecret,
    OKTA_SUBJECT_TOKEN: subjectToken,
  };

  await artifacts.target.declare({
    id: "okta-obo-runtime-identity-real-boundary",
    issue: 6871,
    contract: [
      "the host exchanges the subject token without exposing OAuth material to the sandbox",
      "the direct blueprint runner creates a ready sandbox with the headless no-op command",
      "the sandbox receives only an opaque provider placeholder",
      "OpenShell substitutes the delegated bearer only for the admitted request",
      "an unreviewed method is denied before bearer delivery",
      "rollback removes the owned sandbox and provider",
    ],
    openshellBoundary: "real gateway, provider creation, attachment, sandbox exec, L7 injection",
    oauthBoundary: "deterministic RFC 8693 fixture over public DNS and trusted TLS",
  });

  progress.phase("apply OBO identity and create the sandbox through OpenShell");
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
  expect(applyText).toContain(`Sandbox '${sandboxName}' is ready.`);
  expect(applyText).not.toContain("already exists, reusing");
  for (const secret of redactionValues) expect(applyText).not.toContain(secret);
  expect(oauth.tokenExchangeRequests()).toEqual([
    {
      method: "POST",
      path: tokenPath,
      grantTypeOk: true,
      subjectTokenOk: true,
      subjectTokenTypeOk: true,
      requestedTokenTypeOk: true,
      audienceOk: true,
      scopeOk: true,
      clientAuthOk: true,
      issued: true,
    },
  ]);

  const runId = /^RUN_ID:(\S+)$/m.exec(apply.stdout)?.[1];
  expect(runId).toMatch(/^nc-[A-Za-z0-9-]+$/);
  const stateDir = path.join(os.homedir(), ".nemoclaw", "state", "runs", runId!);
  const persistedPlan = fs.readFileSync(path.join(stateDir, "plan.json"), "utf8");
  expect(JSON.parse(persistedPlan)).toMatchObject({
    sandbox_created_by_apply: true,
    identity: {
      provider_type: providerType,
      provider_name: providerName,
      credential_key: credentialKey,
      provider_created: true,
      attachment_created: true,
    },
  });
  for (const secret of redactionValues) expect(persistedPlan).not.toContain(secret);

  let placeholder = "";
  await expect
    .poll(
      async () => {
        const probe = await sandbox.exec(sandboxName, ["/usr/bin/printenv", credentialKey], {
          artifactName: `${artifactPrefix}-sandbox-placeholder`,
          env: openshellEnv,
          timeoutMs: 30_000,
        });
        placeholder = probe.exitCode === 0 ? probe.stdout.trim() : "";
        return placeholder;
      },
      { interval: 2_000, timeout: 35_000 },
    )
    .toMatch(new RegExp(`^openshell:resolve:env:(?:v[0-9]+_)?${credentialKey}$`));

  const sandboxEnvironment = await sandbox.exec(sandboxName, ["/usr/bin/env"], {
    artifactName: `${artifactPrefix}-sandbox-environment`,
    env: openshellEnv,
    timeoutMs: 30_000,
  });
  expect(sandboxEnvironment.exitCode, resultText(sandboxEnvironment)).toBe(0);
  expect(sandboxEnvironment.stdout).toContain(`${credentialKey}=${placeholder}`);
  expect(sandboxEnvironment.stdout).not.toContain("OKTA_CLIENT_SECRET=");
  expect(sandboxEnvironment.stdout).not.toContain("OKTA_SUBJECT_TOKEN=");
  for (const secret of redactionValues) expect(sandboxEnvironment.stdout).not.toContain(secret);

  progress.phase("prove admitted bearer delivery and denied-request isolation");
  const allowed = await sandbox.exec(
    sandboxName,
    [
      "/usr/bin/curl",
      "-fsS",
      "-H",
      `Authorization: Bearer ${placeholder}`,
      `${tunnel.origin}${resourcePath}`,
    ],
    {
      artifactName: `${artifactPrefix}-allowed-resource`,
      env: openshellEnv,
      timeoutMs: 60_000,
    },
  );
  expect(allowed.exitCode, resultText(allowed)).toBe(0);
  expect(JSON.parse(allowed.stdout)).toEqual({ authenticated: true, access_token_version: 1 });
  expect(oauth.resourceRequests()).toEqual([
    { method: "GET", path: resourcePath, auth: "ok", accessTokenVersion: 1 },
  ]);

  const admittedRequestCount = oauth.resourceRequests().length;
  const denied = await sandbox.exec(
    sandboxName,
    [
      "/usr/bin/curl",
      "-fsS",
      "-X",
      "POST",
      "-H",
      `Authorization: Bearer ${placeholder}`,
      `${tunnel.origin}${resourcePath}`,
    ],
    {
      artifactName: `${artifactPrefix}-denied-resource`,
      env: openshellEnv,
      timeoutMs: 60_000,
    },
  );
  expect(denied.exitCode, resultText(denied)).not.toBe(0);
  expect(oauth.resourceRequests()).toHaveLength(admittedRequestCount);

  progress.phase("rollback the owned OBO sandbox and provider");
  const rollback = await runRawCommand(
    process.execPath,
    [
      tsxPath,
      "--input-type=module",
      "--eval",
      `const { main } = await import(${JSON.stringify(runnerPath)}); await main(["rollback", "--run-id", ${JSON.stringify(runId)}]);`,
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
  expect(rollback.exitCode, resultText(rollback)).toBe(0);
  expect(fs.existsSync(path.join(stateDir, "rolled_back"))).toBe(true);

  const providerAfterRollback = await sandbox.openshell(["provider", "get", providerName], {
    artifactName: `${artifactPrefix}-provider-after-rollback`,
    env: openshellEnv,
    timeoutMs: 30_000,
  });
  expect(providerAfterRollback.exitCode).not.toBe(0);
  const sandboxAfterRollback = await sandbox.openshell(["sandbox", "get", sandboxName], {
    artifactName: `${artifactPrefix}-sandbox-after-rollback`,
    env: openshellEnv,
    timeoutMs: 30_000,
  });
  expect(sandboxAfterRollback.exitCode).not.toBe(0);

  const deleteProfile = await sandbox.openshell(["provider", "profile", "delete", providerType], {
    artifactName: `${artifactPrefix}-delete-conformance-profile`,
    env: openshellEnv,
    timeoutMs: 30_000,
  });
  expect(deleteProfile.exitCode, resultText(deleteProfile)).toBe(0);
}
