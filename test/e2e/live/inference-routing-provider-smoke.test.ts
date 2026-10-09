// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import { HOSTED_PROVIDER_SMOKE_CASES as hostedCases } from "../../../tools/e2e/hosted-provider-smoke.mts";
import { parseOpenClawAgentText } from "../fixtures/openclaw-agent-output.ts";
import {
  parseOpenClawJsonDocuments,
  openClawAgentResponseRecord,
} from "../../../src/lib/openclaw/agent-json-provenance.ts";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  cleanupSandbox,
  expectOnboardSuccess,
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
// inference-routing lane. Explicit hosted-inference catalogue targets supply
// only the selected credential through the trusted E2E controller.

test(
  "TC-INF-05 real NVIDIA key is isolated from sandbox env, process list, and filesystem",
  {
    timeout: 15 * 60_000,
    meta: {
      e2ePhases: [
        "confirm NVIDIA credential prerequisites",
        "recreate the credential-isolation sandbox",
        "onboard with the real NVIDIA credential",
        "inspect sandbox environment and processes",
        "scan the sandbox filesystem for the credential",
        "confirm placeholder credential injection",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets, skip }) => {
    const apiKey =
      secrets.optional("NVIDIA_INFERENCE_API_KEY") ??
      skipLive(skip, "NVIDIA_INFERENCE_API_KEY not set — cannot test credential isolation");
    await requireLivePrerequisites(host, runtimeProvider);
    const sandboxName = inferenceSandboxName("e2e-cred");
    cleanup.add(
      `best-effort inference-routing credential-isolation cleanup for ${sandboxName}`,
      () => cleanupSandbox(host, sandbox, sandboxName),
    );
    progress.phase("recreate the credential-isolation sandbox");
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

    progress.phase("onboard with the real NVIDIA credential");
    const onboard = await onboardSandbox(
      artifacts,
      sandboxName,
      { NVIDIA_INFERENCE_API_KEY: apiKey },
      [apiKey],
      "tc-inf-05-onboard-credential-isolation",
      progress,
    );
    expectOnboardSuccess(onboard, "TC-INF-05 credential-isolation onboard");
    cleanup.add(`strict inference-routing credential-isolation cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
    );

    progress.phase("inspect sandbox environment and processes");
    const sandboxEnv = await runOpenShell(["sandbox", "exec", "-n", sandboxName, "--", "env"], {
      artifactName: "tc-inf-05-sandbox-env",
      artifacts,
      env: buildAvailabilityProbeEnv(),
      progress,
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
        progress,
        redactionValues: [apiKey],
        timeoutMs: 60_000,
      },
    );
    await verifyProcessListCredentialIsolation(artifacts, processList, apiKey);

    progress.phase("scan the sandbox filesystem for the credential");
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
        progress,
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
        progress,
        redactionValues: [apiKey],
        timeoutMs: 90_000,
      },
    );
    expect(filesystemScan.stdout).not.toContain("SCAN_CONFIG_MISSING");
    expect(filesystemScan.stdout).not.toContain("FOUND:");
    expect(filesystemScan.stdout, redactedResultText(filesystemScan)).toContain("SCAN_DONE");

    progress.phase("confirm placeholder credential injection");
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
  },
);

// Each case uses OpenClaw only; deterministic tests own the other supported agents.

test.for(hostedCases)(
  "$id $label answers through its native provider",
  {
    timeout: 15 * 60_000,
    meta: {
      e2ePhases: [
        "confirm hosted provider prerequisites",
        "recreate the hosted sandbox",
        "onboard the hosted provider",
        "verify native agent configuration",
        "request a fresh agent response",
      ],
    },
  },
  async (
    selected,
    { artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets, skip },
  ) => {
    requireProviderSmokeSelected(selected.selector, skip);
    const apiKey =
      secrets.optional(selected.credential) ?? skipLive(skip, `${selected.credential} not set`);
    const model =
      process.env[selected.modelEnv] ||
      ("defaultModel" in selected ? selected.defaultModel : "") ||
      skipLive(skip, `${selected.modelEnv} must name an available model`);
    await requireLivePrerequisites(host, runtimeProvider);
    const sandboxName = inferenceSandboxName(`e2e-${selected.selector}`);
    cleanup.add(`best-effort hosted inference cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName),
    );
    progress.phase("recreate the hosted sandbox");
    await cleanupSandbox(host, sandbox, sandboxName);
    await artifacts.target.declare({
      id: `inference-routing-${selected.selector}`,
      model,
      contract: [
        "hosted provider onboards",
        "agent uses the native endpoint with a credential placeholder",
        "fresh agent process answers with the selected model",
      ],
    });
    progress.phase("onboard the hosted provider");
    const onboard = await onboardSandbox(
      artifacts,
      sandboxName,
      {
        NEMOCLAW_AGENT: "openclaw",
        NEMOCLAW_MODEL: model,
        NEMOCLAW_PROVIDER: selected.provider,
        [selected.credential]: apiKey,
      },
      [apiKey],
      `${selected.id}-onboard`,
      progress,
    );
    expectOnboardSuccess(onboard, `${selected.id} hosted onboard`);
    cleanup.add(`strict hosted inference cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
    );
    progress.phase("verify native agent configuration");
    const config = await sandbox.exec(
      sandboxName,
      ["openclaw", "config", "get", `models.providers.${selected.providerKey}`, "--json"],
      {
        artifactName: `${selected.id}-native-config`,
        env: buildAvailabilityProbeEnv(),
        redactionValues: [apiKey],
        timeoutMs: 60_000,
      },
    );
    expect(config.exitCode, resultText(config)).toBe(0);
    expect(JSON.parse(config.stdout)).toMatchObject({
      baseUrl: selected.endpoint,
      apiKey: `openshell:resolve:env:${selected.placeholder}`,
    });
    progress.phase("request a fresh agent response");
    const response = await sandbox.exec(
      sandboxName,
      [
        "nemoclaw-start",
        "openclaw",
        "agent",
        "--agent",
        "main",
        "--json",
        "--thinking",
        "off",
        "--session-id",
        `native-${crypto.randomUUID()}`,
        "-m",
        "Reply with one short greeting. Do not use tools.",
      ],
      {
        artifactName: `${selected.id}-native-agent`,
        env: buildAvailabilityProbeEnv(),
        redactionValues: [apiKey],
        timeoutMs: 180_000,
      },
    );
    expect(response.exitCode, resultText(response)).toBe(0);
    const responses = parseOpenClawJsonDocuments(response.stdout)
      .map(openClawAgentResponseRecord)
      .filter((value) => value !== null);
    expect(responses.at(-1)).toMatchObject({
      meta: { agentMeta: { provider: selected.providerKey, model } },
    });
    expect(parseOpenClawAgentText(response.stdout).trim()).not.toBe("");
  },
);
