// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  cleanupSandbox,
  expectAnthropicMessageThroughSandbox,
  expectOnboardSuccess,
  expectOpenAiChatThroughSandbox,
  inferenceSandboxName,
  onboardSandbox,
  rawOpenShellEnv,
  redactedResultText,
  requireLivePrerequisites,
  requireProviderSmokeSelected,
  runOpenShell,
  skipLive,
  verifyCredentialPlaceholder,
  verifyProcessListCredentialIsolation,
} from "./inference-routing-helpers.ts";

// These credential-backed smokes are intentionally outside the PR-required
// inference-routing lane. A future workflow that supplies provider credentials
// must run them only from trusted main.

test("TC-INF-05 real NVIDIA key is isolated from sandbox env, process list, and filesystem", {
  timeout: 15 * 60_000,
}, async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
  const apiKey =
    secrets.optional("NVIDIA_INFERENCE_API_KEY") ??
    skipLive(skip, "NVIDIA_INFERENCE_API_KEY not set — cannot test credential isolation");
  await requireLivePrerequisites(host, skip);
  const sandboxName = inferenceSandboxName("e2e-inf-cred");
  cleanup.add(`best-effort inference-routing credential-isolation cleanup for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName),
  );
  await cleanupSandbox(host, sandbox, sandboxName);

  await artifacts.target.declare({
    id: "inference-routing-credential-isolation",
    contract: [
      "real NVIDIA_INFERENCE_API_KEY does not appear in sandbox environment",
      "real NVIDIA_INFERENCE_API_KEY does not appear in sandbox process list when ps is available",
      "real NVIDIA_INFERENCE_API_KEY does not appear in sampled sandbox filesystem",
      "sandbox NVIDIA_INFERENCE_API_KEY, when present, is a placeholder rather than the real key",
    ],
  });

  const onboard = await onboardSandbox(
    artifacts,
    sandboxName,
    { NVIDIA_INFERENCE_API_KEY: apiKey },
    [apiKey],
    "tc-inf-05-onboard-credential-isolation",
  );
  expectOnboardSuccess(onboard, "TC-INF-05 credential-isolation onboard");
  cleanup.add(`strict inference-routing credential-isolation cleanup for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
  );

  const sandboxEnv = await runOpenShell(["sandbox", "exec", "-n", sandboxName, "--", "env"], {
    artifactName: "tc-inf-05-sandbox-env",
    artifacts,
    env: buildAvailabilityProbeEnv(),
    redactionValues: [apiKey],
    timeoutMs: 60_000,
  });
  expect(sandboxEnv.exitCode, redactedResultText(sandboxEnv)).toBe(0);
  expect(sandboxEnv.stdout.includes(apiKey), redactedResultText(sandboxEnv)).toBe(false);

  const processList = await runOpenShell(
    [
      "sandbox",
      "exec",
      "-n",
      sandboxName,
      "--",
      "sh",
      "-lc",
      "ps aux 2>/dev/null || ps -ef 2>/dev/null",
    ],
    {
      artifactName: "tc-inf-05-sandbox-process-list",
      artifacts,
      env: buildAvailabilityProbeEnv(),
      redactionValues: [apiKey],
      timeoutMs: 60_000,
    },
  );
  await verifyProcessListCredentialIsolation(artifacts, processList, apiKey);

  const scanScript = [
    "const crypto=require('crypto')",
    "const fs=require('fs')",
    "const {execFileSync}=require('child_process')",
    "const len=Number(process.env.KEY_LEN||'0')",
    "const salt=process.env.SCAN_SALT||''",
    "const target=process.env.TARGET_HASH||''",
    "const digest=(value)=>crypto.createHash('sha256').update(salt).update(value).digest('hex')",
    "if(!len||!salt||!target){console.log('SCAN_CONFIG_MISSING');process.exit(0)}",
    "let out=''",
    "try{out=execFileSync('sh',['-lc','find /tmp /sandbox /home -type f -size -1M 2>/dev/null | head -200'],{encoding:'utf8'})}catch{console.log('SCAN_ERROR');process.exit(0)}",
    "for(const file of out.trim().split(/\\n/).filter(Boolean)){try{const content=fs.readFileSync(file,'utf8');for(let i=0;i<=content.length-len;i++){if(digest(content.slice(i,i+len))===target){console.log('FOUND:'+file);break}}}catch{}}",
    "console.log('SCAN_DONE')",
  ].join(";");
  const leakCanary = `nemoclaw-fs-scan-canary-${crypto.randomUUID()}`;
  const canaryPath = "/tmp/nemoclaw-fs-scan-canary.txt";
  const plantCanary = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(`printf '%s' '${leakCanary}' > ${canaryPath}`),
    {
      artifactName: "tc-inf-05-sandbox-filesystem-canary-plant",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(plantCanary.exitCode, resultText(plantCanary)).toBe(0);
  const canarySalt = crypto.randomUUID();
  const canaryScan = await runOpenShell(
    ["sandbox", "exec", "-n", sandboxName, "--", "node", "-e", scanScript],
    {
      artifactName: "tc-inf-05-sandbox-filesystem-canary-scan",
      artifacts,
      env: rawOpenShellEnv({
        KEY_LEN: String(leakCanary.length),
        SCAN_SALT: canarySalt,
        TARGET_HASH: crypto
          .createHash("sha256")
          .update(canarySalt)
          .update(leakCanary)
          .digest("hex"),
      }),
      timeoutMs: 90_000,
    },
  );
  expect(canaryScan.stdout, redactedResultText(canaryScan)).toContain(`FOUND:${canaryPath}`);

  const removeCanary = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(`rm -f ${canaryPath}`),
    {
      artifactName: "tc-inf-05-sandbox-filesystem-canary-remove",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(removeCanary.exitCode, resultText(removeCanary)).toBe(0);

  const secretScanSalt = crypto.randomUUID();
  const filesystemScan = await runOpenShell(
    ["sandbox", "exec", "-n", sandboxName, "--", "node", "-e", scanScript],
    {
      artifactName: "tc-inf-05-sandbox-filesystem-scan",
      artifacts,
      env: rawOpenShellEnv({
        KEY_LEN: String(apiKey.length),
        SCAN_SALT: secretScanSalt,
        TARGET_HASH: crypto
          .createHash("sha256")
          .update(secretScanSalt)
          .update(apiKey)
          .digest("hex"),
      }),
      redactionValues: [apiKey],
      timeoutMs: 90_000,
    },
  );
  expect(filesystemScan.stdout).not.toContain("SCAN_CONFIG_MISSING");
  expect(filesystemScan.stdout).not.toContain("FOUND:");
  expect(filesystemScan.stdout, redactedResultText(filesystemScan)).toContain("SCAN_DONE");

  const placeholder = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript("printenv NVIDIA_INFERENCE_API_KEY 2>/dev/null || true"),
    {
      artifactName: "tc-inf-05-sandbox-placeholder",
      env: buildAvailabilityProbeEnv(),
      redactionValues: [apiKey],
      timeoutMs: 30_000,
    },
  );
  const placeholderValue = placeholder.stdout.trim();
  await verifyCredentialPlaceholder(artifacts, placeholderValue, apiKey);
});

test("TC-INF-02 OpenAI provider responds through inference.local", {
  timeout: 15 * 60_000,
}, async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
  requireProviderSmokeSelected("openai", skip);
  const apiKey = secrets.optional("OPENAI_API_KEY") ?? skipLive(skip, "OPENAI_API_KEY not set");
  await requireLivePrerequisites(host, skip);
  const sandboxName = inferenceSandboxName("e2e-openai");
  const model = process.env.NEMOCLAW_OPENAI_MODEL || "gpt-4o-mini";
  cleanup.add(`best-effort inference-routing OpenAI cleanup for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName),
  );
  await cleanupSandbox(host, sandbox, sandboxName);

  await artifacts.target.declare({
    id: "inference-routing-openai",
    contract: ["OpenAI provider onboards", "sandbox inference.local routes chat to OpenAI"],
    model,
  });

  const onboard = await onboardSandbox(
    artifacts,
    sandboxName,
    { NEMOCLAW_MODEL: model, NEMOCLAW_PROVIDER: "openai", OPENAI_API_KEY: apiKey },
    [apiKey],
    "tc-inf-02-onboard-openai",
  );
  expectOnboardSuccess(onboard, "TC-INF-02 OpenAI onboard");
  cleanup.add(`strict inference-routing OpenAI cleanup for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
  );
  await expectOpenAiChatThroughSandbox(
    sandbox,
    sandboxName,
    model,
    [apiKey],
    "openai-inference-local-chat",
  );
});

test("TC-INF-03 Anthropic provider responds through inference.local", {
  timeout: 15 * 60_000,
}, async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
  requireProviderSmokeSelected("anthropic", skip);
  const apiKey =
    secrets.optional("ANTHROPIC_API_KEY") ?? skipLive(skip, "ANTHROPIC_API_KEY not set");
  await requireLivePrerequisites(host, skip);
  const sandboxName = inferenceSandboxName("e2e-anthropic");
  const model = process.env.NEMOCLAW_ANTHROPIC_MODEL || "claude-sonnet-4-6";
  cleanup.add(`best-effort inference-routing Anthropic cleanup for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName),
  );
  await cleanupSandbox(host, sandbox, sandboxName);

  await artifacts.target.declare({
    id: "inference-routing-anthropic",
    contract: [
      "Anthropic provider onboards",
      "sandbox inference.local routes Messages API to Anthropic",
    ],
    model,
  });

  const onboard = await onboardSandbox(
    artifacts,
    sandboxName,
    { ANTHROPIC_API_KEY: apiKey, NEMOCLAW_MODEL: model, NEMOCLAW_PROVIDER: "anthropic" },
    [apiKey],
    "tc-inf-03-onboard-anthropic",
  );
  expectOnboardSuccess(onboard, "TC-INF-03 Anthropic onboard");
  cleanup.add(`strict inference-routing Anthropic cleanup for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
  );
  await expectAnthropicMessageThroughSandbox(sandbox, sandboxName, model, [apiKey]);
});
