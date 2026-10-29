// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import { CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import { hostedCredentialScanCommand } from "./inference-routing-credential-scan.ts";
import { parse as parseToml } from "smol-toml";
import {
  OPENROUTER_SMOKE,
  openRouterSmokeEnvironment,
} from "../../../tools/e2e/hosted-provider-smoke.mts";
import { parseOpenClawAgentText } from "../fixtures/openclaw-agent-output.ts";
import { isObjectRecord } from "../../../src/lib/core/json-types.ts";
import {
  parseOpenClawJsonDocuments,
  openClawAgentResponseRecord,
} from "../../../src/lib/openclaw/agent-json-provenance.ts";

import {
  AVAILABILITY_PROBE_EXTRA_ENV_KEYS,
  buildAvailabilityProbeEnv,
} from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { buildChildEnv } from "../fixtures/redaction.ts";
import {
  cleanupSandbox,
  expectOnboardSuccess,
  inferenceSandboxName,
  onboardSandbox,
  redactedResultText,
  requireLivePrerequisites,
  requireProviderSmokeSelected,
  skipLive,
  verifyCredentialPlaceholder,
} from "./inference-routing-helpers.ts";

// The OpenRouter smoke is explicitly selected through the trusted E2E controller.

test(
  "TC-INF-05 real NVIDIA key is isolated from sandbox env, process list, and filesystem",
  {
    timeout: 15 * 60_000,
    meta: {
      e2ePhases: [
        "confirm NVIDIA credential prerequisites",
        "recreate the credential-isolation sandbox",
        "onboard with the real NVIDIA credential",
        "verify sandbox credential isolation",
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

    progress.phase("verify sandbox credential isolation");
    const isolation = await sandbox.exec(sandboxName, hostedCredentialScanCommand(apiKey), {
      artifactName: "tc-inf-05-credential-isolation",
      env: buildAvailabilityProbeEnv(),
      redactionValues: [apiKey],
      timeoutMs: 90_000,
    });
    expect(isolation.exitCode, "credential isolation scan failed; inspect the artifact").toBe(0);
    const isolationEvidence = JSON.parse(isolation.stdout);
    expect(
      isolationEvidence.environmentClean,
      "real credential absent from sandbox environment",
    ).toBe(true);
    expect(
      isolationEvidence.processesClean,
      "sandbox process arguments are available and credential-free",
    ).toBe(true);
    expect(
      isolationEvidence.sampledFilesClean,
      "real credential absent from sampled sandbox files",
    ).toBe(true);
    expect(isolationEvidence.canaryDetected, "filesystem scanner detects a planted control").toBe(
      true,
    );

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

test(
  "TC-INF-07D Deep Agents Code reaches native OpenRouter",
  {
    timeout: 20 * 60_000,
    meta: {
      e2ePhases: [
        "confirm hosted OpenRouter prerequisites",
        "onboard Deep Agents Code",
        "verify Deep Agents Code credential isolation",
        "verify native OpenRouter route",
        "request a fresh Deep Agents Code response",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets, skip }) => {
    progress.phase("confirm hosted OpenRouter prerequisites");
    requireProviderSmokeSelected("openrouter", skip);
    const environment = openRouterSmokeEnvironment({
      OPENROUTER_API_KEY: secrets.optional("OPENROUTER_API_KEY"),
      NEMOCLAW_OPENROUTER_MODEL: process.env.NEMOCLAW_OPENROUTER_MODEL,
    });
    const apiKey = environment.OPENROUTER_API_KEY!;
    const model = environment.NEMOCLAW_OPENROUTER_MODEL!;
    await requireLivePrerequisites(host, runtimeProvider);
    const sandboxName = inferenceSandboxName("e2e-or-dcode");
    cleanup.add(`best-effort Deep Agents Code cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName),
    );
    await cleanupSandbox(host, sandbox, sandboxName);
    await artifacts.target.declare({
      id: "inference-routing-openrouter-dcode",
      model,
      contract: ["native OpenRouter configuration", "fresh Deep Agents Code response"],
    });
    cleanup.add(`strict Deep Agents Code cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
    );
    progress.phase("onboard Deep Agents Code");
    const onboard = await onboardSandbox(
      artifacts,
      sandboxName,
      {
        NEMOCLAW_AGENT: "langchain-deepagents-code",
        NEMOCLAW_MODEL: model,
        NEMOCLAW_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: apiKey,
      },
      [apiKey],
      "tc-inf-07d-onboard",
      progress,
    );
    expect(onboard.exitCode, redactedResultText(onboard)).toBe(0);
    const options = { env: buildAvailabilityProbeEnv(), redactionValues: [apiKey] };
    progress.phase("verify Deep Agents Code credential isolation");
    const isolation = await sandbox.exec(sandboxName, hostedCredentialScanCommand(apiKey), {
      ...options,
      artifactName: "tc-inf-07d-credential-isolation",
      timeoutMs: 90_000,
    });
    const isolationEvidence = JSON.parse(isolation.stdout) as Record<string, unknown>;
    expect(
      { exitCode: isolation.exitCode, ...isolationEvidence },
      resultText(isolation),
    ).toMatchObject({
      exitCode: 0,
      environmentClean: true,
      processesClean: true,
      sampledFilesClean: true,
      canaryDetected: true,
    });
    progress.phase("verify native OpenRouter route");
    const config = await sandbox.exec(sandboxName, ["cat", "/sandbox/.deepagents/config.toml"], {
      ...options,
      artifactName: "tc-inf-07d-native-config",
      timeoutMs: 60_000,
    });
    expect(parseToml(config.stdout)).toMatchObject({
      models: {
        default: `openrouter:${model}`,
        providers: {
          openrouter: {
            api_key_env: "OPENROUTER_API_KEY",
            base_url: "https://openrouter.ai/api/v1",
          },
        },
      },
    });
    progress.phase("request a fresh Deep Agents Code response");
    const response = await sandbox.exec(
      sandboxName,
      ["dcode", "-n", "Reply with one short greeting. Do not use tools.", "--json"],
      { ...options, artifactName: "tc-inf-07d-native-agent", timeoutMs: 180_000 },
    );
    expect(response.exitCode, resultText(response)).toBe(0);
    const envelope = JSON.parse(response.stdout);
    expect(envelope).toMatchObject({
      schema_version: 1,
      command: "non-interactive",
      data: { status: "success", exit_code: 0 },
    });
    expect(
      typeof envelope.data?.response === "string" && envelope.data.response.trim().length > 0,
    ).toBe(true);
  },
);

test(
  "TC-INF-07H Hermes authenticates immediately after OpenRouter rebuild",
  {
    timeout: 35 * 60_000,
    meta: {
      e2ePhases: [
        "confirm hosted OpenRouter prerequisites",
        "onboard Hermes with OpenRouter",
        "verify a Hermes turn before rebuild",
        "rebuild without a host credential",
        "verify the rebuilt sandbox connect probe",
        "verify the first Hermes turn after rebuild",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets, skip }) => {
    progress.phase("confirm hosted OpenRouter prerequisites");
    requireProviderSmokeSelected("openrouter", skip);
    const environment = openRouterSmokeEnvironment({
      OPENROUTER_API_KEY: secrets.optional("OPENROUTER_API_KEY"),
      NEMOCLAW_OPENROUTER_MODEL: process.env.NEMOCLAW_OPENROUTER_MODEL,
    });
    const apiKey = environment.OPENROUTER_API_KEY!;
    const model = environment.NEMOCLAW_OPENROUTER_MODEL!;
    await requireLivePrerequisites(host, runtimeProvider);
    const sandboxName = inferenceSandboxName("e2e-or-hermes");
    cleanup.add(`best-effort Hermes OpenRouter cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName),
    );
    await cleanupSandbox(host, sandbox, sandboxName);
    await artifacts.target.declare({
      id: "inference-routing-openrouter-hermes-rebuild",
      model,
      contract: [
        "Hermes completes a native OpenRouter turn before rebuild",
        "the first Hermes turn after rebuild authenticates without a fresh host credential",
      ],
    });

    progress.phase("onboard Hermes with OpenRouter");
    const onboard = await onboardSandbox(
      artifacts,
      sandboxName,
      {
        NEMOCLAW_AGENT: "hermes",
        NEMOCLAW_MODEL: model,
        NEMOCLAW_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: apiKey,
      },
      [apiKey],
      "tc-inf-07h-onboard",
      progress,
    );
    const onboardSucceeded = onboard.exitCode === 0 && !onboard.timedOut;
    cleanup.add(`strict Hermes OpenRouter cleanup for ${sandboxName}`, () =>
      onboardSucceeded
        ? cleanupSandbox(host, sandbox, sandboxName, { strict: true })
        : Promise.resolve(),
    );
    const execOptions = { env: buildAvailabilityProbeEnv(), redactionValues: [apiKey] };

    progress.phase("verify a Hermes turn before rebuild");
    const before = await host.nemoclaw(
      [sandboxName, "exec", "--", "hermes", "-z", "Reply with exactly HM-BEFORE"],
      { ...execOptions, artifactName: "tc-inf-07h-before-rebuild", timeoutMs: 180_000 },
    );
    expect(
      onboardSucceeded &&
        before.exitCode === 0 &&
        /\bHM-BEFORE\b/u.test(resultText(before)) &&
        !/HTTP 401|Missing Authentication header/iu.test(resultText(before)),
      "Hermes OpenRouter onboarding or baseline turn failed; inspect the redacted artifacts",
    ).toBe(true);

    progress.phase("rebuild without a host credential");
    const rebuilt = await host.command(
      process.execPath,
      [CLI_ENTRYPOINT, sandboxName, "rebuild", "--yes", "--verbose"],
      {
        artifactName: "tc-inf-07h-rebuild",
        env: {
          ...buildAvailabilityProbeEnv(),
          NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
        redactionValues: [apiKey],
        timeoutMs: 10 * 60_000,
      },
    );
    expect(
      rebuilt.exitCode,
      "Hermes OpenRouter rebuild failed; inspect the redacted artifact",
    ).toBe(0);

    progress.phase("verify the rebuilt sandbox connect probe");
    const connect = await host.nemoclaw([sandboxName, "connect", "--probe-only"], {
      ...execOptions,
      artifactName: "tc-inf-07h-connect-probe",
      timeoutMs: 180_000,
    });
    expect(
      connect.exitCode,
      "Hermes OpenRouter connect probe failed after rebuild; inspect the redacted artifact",
    ).toBe(0);

    progress.phase("verify the first Hermes turn after rebuild");
    const after = await host.nemoclaw(
      [sandboxName, "exec", "--", "hermes", "-z", "Reply with exactly HM-AFTER"],
      { ...execOptions, artifactName: "tc-inf-07h-after-rebuild", timeoutMs: 180_000 },
    );
    const afterText = resultText(after);
    const turnSucceeded =
      after.exitCode === 0 &&
      /\bHM-AFTER\b/u.test(afterText) &&
      !/HTTP 401|Missing Authentication header/iu.test(afterText);
    const diagnostic = turnSucceeded
      ? null
      : await hermesOpenRouterRebuildDiagnostic(host, sandboxName, apiKey);
    expect(
      turnSucceeded,
      `Hermes OpenRouter first post-rebuild turn failed: ${JSON.stringify(diagnostic)}`,
    ).toBe(true);
  },
);

async function hermesOpenRouterRebuildDiagnostic(
  host: Parameters<typeof cleanupSandbox>[0],
  sandboxName: string,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const classification: Record<string, unknown> = {
    sandbox: "unavailable",
    adapter: "unavailable",
  };
  try {
    const result = await host.nemoclaw(
      [
        sandboxName,
        "exec",
        "--",
        "/opt/hermes/.venv/bin/python3",
        "-I",
        "-c",
        String.raw`
import json, os, pathlib, re
try:
    import yaml
    config = yaml.safe_load(pathlib.Path("/sandbox/.hermes/config.yaml").read_text()) or {}
except Exception:
    config = None
key = os.environ.get("OPENROUTER_API_KEY")
def shape(value):
    if value == chr(36) + "{OPENROUTER_API_KEY}":
        return "template"
    if isinstance(value, str) and re.fullmatch(r"openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_OPENROUTER_API_KEY", value):
        return "scoped_handle"
    return "absent" if not value else "other"
model = config.get("model") if isinstance(config, dict) else None
providers = config.get("providers") if isinstance(config, dict) else None
custom = config.get("custom_providers") if isinstance(config, dict) else None
managed = providers.get("openrouter-api") if isinstance(providers, dict) else None
legacy = next((item for item in custom if isinstance(item, dict) and item.get("name") == "openrouter-api"), None) if isinstance(custom, list) else None
print(json.dumps({
    "env": shape(key),
    "configReadable": isinstance(config, dict),
    "modelProviderCustom": isinstance(model, dict) and model.get("provider") == "custom",
    "modelKey": shape(model.get("api_key")) if isinstance(model, dict) else "absent",
    "providerKey": shape(managed.get("api_key")) if isinstance(managed, dict) else "absent",
    "customProviderKey": shape(legacy.get("api_key")) if isinstance(legacy, dict) else "absent",
}))
`,
      ],
      {
        artifactName: "tc-inf-07h-auth-classification",
        env: buildAvailabilityProbeEnv(),
        redactionValues: [apiKey],
        timeoutMs: 30_000,
      },
    );
    const parsed =
      result.exitCode === 0 && result.stdout.length < 1024
        ? (JSON.parse(result.stdout) as Record<string, unknown>)
        : null;
    const allowedShape = (value: unknown) =>
      ["template", "scoped_handle", "absent", "other"].includes(String(value))
        ? value
        : "unavailable";
    classification.sandbox = parsed
      ? {
          env: allowedShape(parsed.env),
          configReadable: parsed.configReadable === true,
          modelProviderCustom: parsed.modelProviderCustom === true,
          modelKey: allowedShape(parsed.modelKey),
          providerKey: allowedShape(parsed.providerKey),
          customProviderKey: allowedShape(parsed.customProviderKey),
        }
      : "unavailable";
  } catch {
    // The original failed turn remains the assertion; diagnostics are best effort.
  }
  try {
    const attachments = await host.command(
      process.execPath,
      [
        "-e",
        String.raw`
const { spawnSync } = require("node:child_process");
const result = spawnSync(process.argv[1], ["sandbox", "provider", "list", "-g", process.argv[2], process.argv[3]], {
  encoding: "utf8", timeout: 30000, maxBuffer: 8192,
});
const lines = result.status === 0 ? result.stdout.split("\n").map(line => line.trim()).filter(Boolean) : [];
const noProviders = lines.some(line => /^No providers attached to sandbox\b/u.test(line));
const header = lines.findIndex(line => /^NAME\s+TYPE\s+CREDENTIAL_KEYS\s+CONFIG_KEYS$/u.test(line));
const rows = header < 0 ? [] : lines.slice(header + 1).map(line => /^(\S+)\s+\S+\s+\d+\s+\d+$/u.exec(line));
const validRows = rows.every(Boolean);
console.log(JSON.stringify({
  observed: noProviders || (header >= 0 && validRows),
  openRouterAttached: header >= 0 && validRows && rows.some(row => row?.[1] === "nemoclaw-openrouter-api-v1"),
}));
`,
        host.openshellCommandPath,
        process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
        sandboxName,
      ],
      {
        artifactName: "tc-inf-07h-provider-attachment",
        env: buildAvailabilityProbeEnv(),
        redactionValues: [apiKey],
        captureLimitBytes: 1024,
        timeoutMs: 30_000,
      },
    );
    const parsed =
      attachments.exitCode === 0 && attachments.stdout.length < 1024
        ? (JSON.parse(attachments.stdout) as Record<string, unknown>)
        : null;
    classification.adapter = parsed
      ? {
          observed: parsed.observed === true,
          openRouterAttached:
            parsed.observed === true ? parsed.openRouterAttached === true : "unavailable",
        }
      : "unavailable";
  } catch {
    // The original failed turn remains the assertion; diagnostics are best effort.
  }
  return classification;
}

test(
  "TC-INF-07 OpenRouter answers through its native provider",
  {
    timeout: 35 * 60_000,
    meta: {
      e2ePhases: [
        "confirm hosted provider prerequisites",
        "recreate the hosted sandbox",
        "onboard the hosted provider",
        "exercise the selected hosted lifecycle",
        "verify native agent configuration",
        "verify hosted credential isolation",
        "switch OpenRouter models when selected",
        "request a fresh agent response",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets, skip }) => {
    const selected = OPENROUTER_SMOKE;
    requireProviderSmokeSelected(selected.selector, skip);
    const environment = openRouterSmokeEnvironment({
      [selected.credential]: secrets.optional(selected.credential),
      [selected.modelEnv]: process.env[selected.modelEnv],
    });
    const apiKey = environment[selected.credential]!;
    const model = environment[selected.modelEnv]!;
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
        "OpenRouter remains usable after rebuild without a fresh host credential",
        "agent uses the native endpoint with a credential placeholder",
        "selected credential is absent from sandbox environment, process arguments, and sampled files",
        "fresh agent request answers with the selected model",
        "both OpenRouter model switches preserve a fresh agent response",
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
    progress.phase("exercise the selected hosted lifecycle");
    // Reuse routing and isolation checks after rebuild without a fresh host key.
    const rebuilt = await host.command(
      process.execPath,
      [CLI_ENTRYPOINT, sandboxName, "rebuild", "--yes", "--verbose"],
      {
        artifactName: "tc-inf-07-rebuild",
        env: {
          ...buildAvailabilityProbeEnv(),
          NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
        redactionValues: [apiKey],
        timeoutMs: 10 * 60_000,
      },
    );
    expect(rebuilt.exitCode, resultText(rebuilt)).toBe(0);
    progress.phase("verify native agent configuration");
    const config = await sandbox.exec(
      sandboxName,
      [
        "node",
        "-e",
        String.raw`
const fs = require("node:fs");
let config;
try {
  config = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));
} catch {
  console.error("native config unreadable or invalid");
  process.exit(1);
}
const provider = config.models?.providers?.[process.argv[1]];
const handle = provider?.apiKey;
const normalizedHandle = typeof handle === "string"
  ? handle.replace(/^openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_/u,
    "openshell:resolve:env:")
  : null;
console.log(JSON.stringify({
  endpointMatches: provider?.baseUrl === process.argv[3],
  credentialHandleMatches: normalizedHandle ===
    "openshell:resolve:env:" + process.argv[2],
}));
`,
        selected.providerKey,
        selected.placeholder,
        selected.endpoint,
      ],
      {
        artifactName: `${selected.id}-native-config`,
        env: buildAvailabilityProbeEnv(),
        redactionValues: [apiKey],
        timeoutMs: 60_000,
      },
    );
    expect(config.exitCode, "native provider config read failed; inspect the artifact").toBe(0);
    const providerConfig = JSON.parse(config.stdout);
    expect(providerConfig).toMatchObject({
      endpointMatches: true,
      credentialHandleMatches: true,
    });
    progress.phase("verify hosted credential isolation");
    const isolation = await sandbox.exec(sandboxName, hostedCredentialScanCommand(apiKey), {
      artifactName: `${selected.id}-credential-isolation`,
      env: buildAvailabilityProbeEnv(),
      redactionValues: [apiKey],
      timeoutMs: 90_000,
    });
    expect(isolation.exitCode, "credential isolation scan failed; inspect the artifact").toBe(0);
    const isolationEvidence = JSON.parse(isolation.stdout);
    expect(
      isolationEvidence.environmentClean,
      "real credential absent from sandbox environment",
    ).toBe(true);
    expect(
      isolationEvidence.processesClean,
      "sandbox process arguments are available and credential-free",
    ).toBe(true);
    expect(
      isolationEvidence.sampledFilesClean,
      "real credential absent from sampled sandbox files",
    ).toBe(true);
    expect(isolationEvidence.canaryDetected, "filesystem scanner detects a planted control").toBe(
      true,
    );
    const requestOpenClawAgent = async (artifactName: string) => {
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
          artifactName,
          env: buildAvailabilityProbeEnv(),
          redactionValues: [apiKey],
          timeoutMs: 180_000,
        },
      );
      const document = parseOpenClawJsonDocuments(response.stdout)
        .map(openClawAgentResponseRecord)
        .filter((value) => value !== null)
        .at(-1);
      return { response, document, text: parseOpenClawAgentText(response.stdout) };
    };
    const alternateModel =
      model === "nvidia/nemotron-3-super-120b-a12b"
        ? "nvidia/nemotron-3-ultra-550b-a55b"
        : "nvidia/nemotron-3-super-120b-a12b";
    const switchEnv = buildChildEnv(
      { ...process.env, OPENROUTER_API_KEY: apiKey },
      {
        additionalAllowedEnv: AVAILABILITY_PROBE_EXTRA_ENV_KEYS,
        secretEnv: ["OPENROUTER_API_KEY"],
        fixtureOverlay: {},
      },
    );
    progress.phase("switch OpenRouter models when selected");
    const toAlternate = await host.nemoclaw(
      [
        "inference",
        "set",
        "--provider",
        "openrouter-api",
        "--model",
        alternateModel,
        "--sandbox",
        sandboxName,
      ],
      {
        artifactName: `${selected.id}-switch-to-alternate`,
        env: switchEnv,
        redactionValues: [apiKey],
        timeoutMs: 180_000,
      },
    );
    expect(
      toAlternate.exitCode,
      "OpenRouter alternate switch failed; inspect the redacted artifact",
    ).toBe(0);
    const {
      response: alternateResponse,
      document: alternateDocument,
      text: alternateText,
    } = await requestOpenClawAgent(`${selected.id}-alternate-native-agent`);
    expect(alternateResponse.exitCode, resultText(alternateResponse)).toBe(0);
    const alternateMeta = alternateDocument?.meta;
    const alternateAgentMeta = isObjectRecord(alternateMeta) ? alternateMeta.agentMeta : undefined;
    expect(isObjectRecord(alternateAgentMeta) ? alternateAgentMeta.model : undefined).toBe(
      alternateModel,
    );
    expect(alternateText.trim()).not.toBe("");

    const backToSelected = await host.nemoclaw(
      [
        "inference",
        "set",
        "--provider",
        "openrouter-api",
        "--model",
        model,
        "--sandbox",
        sandboxName,
      ],
      {
        artifactName: `${selected.id}-switch-back`,
        env: switchEnv,
        redactionValues: [apiKey],
        timeoutMs: 180_000,
      },
    );
    expect(
      backToSelected.exitCode,
      "OpenRouter return switch failed; inspect the redacted artifact",
    ).toBe(0);
    progress.phase("request a fresh agent response");
    const { response, document, text } = await requestOpenClawAgent(`${selected.id}-native-agent`);
    expect(response.exitCode, resultText(response)).toBe(0);
    const meta = document?.meta;
    const agentSelection = isObjectRecord(meta) ? meta.agentMeta : undefined;
    expect(agentSelection).toMatchObject({
      provider: selected.providerKey,
      model,
    });
    expect(text.trim()).not.toBe("");
  },
);
