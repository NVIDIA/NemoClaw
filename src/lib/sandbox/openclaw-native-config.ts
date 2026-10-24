// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Host-side OpenClaw native config commands and scoped provider handle materialization.

import type { OpenShellRuntimeSelection } from "../adapters/openshell/client";
import type { ConfigValue } from "../security/credential-filter";
import { nativeLocalCredentialReference } from "../inference/native-local/model-router";
import { usesNativeLocalInference } from "../inference/native-local/eligibility";
import { NATIVE_LOCAL_CREDENTIAL_ENV } from "../inference/native-local/agent-config";
const {
  buildSelectedOpenShellSubprocessEnv,
  captureOpenshellCommand,
  runOpenshellCommand,
}: typeof import("../adapters/openshell/client") = require("../adapters/openshell/client");
const {
  OPENSHELL_OPERATION_TIMEOUT_MS,
}: typeof import("../adapters/openshell/timeouts") = require("../adapters/openshell/timeouts");
const { shellQuote }: typeof import("../core/shell-quote") = require("../core/shell-quote");
const {
  NVIDIA_INFERENCE_PLACEHOLDER,
}: typeof import("../inference-credential") = require("../inference-credential");
const {
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_NATIVE_ENDPOINT,
}: typeof import("../inference/native-nvidia/contract") = require("../inference/native-nvidia/contract");
const {
  nativeHostedAgentConfig,
}: typeof import("../inference/native-provider/agent-config") = require("../inference/native-provider/agent-config");
const {
  fixedNativeProvider,
  nativeOpenClawProviderKey,
}: typeof import("../inference/native-provider/fixed") = require("../inference/native-provider/fixed");
const {
  isConfigObject,
}: typeof import("../security/credential-filter") = require("../security/credential-filter");
const { redactFull }: typeof import("../security/redact") = require("../security/redact");

export function runOpenClawNativeConfigCommand(
  binary: string,
  maxBuffer: number,
  sandboxName: string,
  args: string[],
  gateway?: string | OpenShellRuntimeSelection,
): void {
  const result = captureOpenshellCommand(
    binary,
    [
      ...(gateway ? ["-g", typeof gateway === "string" ? gateway : gateway.gatewayName] : []),
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--env",
      "HOME=/sandbox",
      "--",
      "openclaw",
      "config",
      ...args,
    ],
    {
      ...(!gateway || typeof gateway === "string"
        ? {}
        : {
            env: buildSelectedOpenShellSubprocessEnv(gateway),
            replaceEnv: true,
          }),
      ignoreError: true,
      includeStreams: true,
      maxBuffer,
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    },
  );
  if (!result.error && !result.signal && result.status === 0) return;
  const detail = redactFull(result.error?.message || result.stderr?.trim() || "command failed");
  throw new Error(`Native OpenClaw config command failed: ${detail}`);
}

export function buildOpenClawNativeConfigSetInvocation(
  sandboxName: string,
  dotpath: string,
  value: ConfigValue,
  gateway?: string | OpenShellRuntimeSelection,
) {
  return buildOpenClawNativeConfigBatchInvocation(sandboxName, [{ dotpath, value }], gateway);
}

export interface OpenClawConfigUpdate {
  dotpath: string;
  value: ConfigValue;
}

// A provider attached after sandbox creation appears in fresh OpenShell exec
// processes, but not in the existing OpenClaw gateway's environment. The
// gateway restart replaces that process image with its old environment. Pin
// the supervisor-issued handle in the native config batch before restarting;
// the actual credential remains outside the sandbox and endpoint-bound.
const materializeNativeProviderHandle = [
  "import json, os, re, sys",
  "credential_env, endpoint, placeholder, provider_path = sys.argv[2:6]",
  'handle = os.environ.get(credential_env, "")',
  "if not handle:",
  '    sys.stderr.write("NEMOCLAW_NATIVE_PROVIDER_HANDLE_PENDING\\n")',
  "    raise SystemExit(75)",
  'if not re.fullmatch(r"openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_" + re.escape(credential_env), handle):',
  '    raise SystemExit("Native provider handle is unavailable or invalid")',
  'with open(sys.argv[1], "r+", encoding="utf-8") as stream:',
  "    updates = json.load(stream)",
  "    if not isinstance(updates, list):",
  '        raise SystemExit("Invalid OpenClaw config batch")',
  "    matched = 0",
  "    for update in updates:",
  '        if not isinstance(update, dict) or update.get("path") != provider_path:',
  "            continue",
  '        provider = update.get("value")',
  '        if not isinstance(provider, dict) or provider.get("apiKey") != placeholder:',
  "            continue",
  '        if provider.get("baseUrl") != endpoint:',
  '            raise SystemExit("Native provider endpoint does not match")',
  '        provider["apiKey"] = handle',
  "        matched += 1",
  "    if matched != 1:",
  '        raise SystemExit("Expected one native provider config update")',
  "    stream.seek(0)",
  '    json.dump(updates, stream, separators=(",", ":"))',
  "    stream.truncate()",
].join("\n");

function nativeProviderHandleUpdate(updates: readonly OpenClawConfigUpdate[]) {
  const matching = updates.filter(({ dotpath, value }) => {
    if (!dotpath.startsWith("models.providers.") || !isConfigObject(value)) return false;
    if (value.apiKey === NVIDIA_INFERENCE_PLACEHOLDER) return true;
    if (
      typeof value.apiKey !== "string" ||
      !/^openshell:resolve:env:[A-Z][A-Z0-9_]*$/u.test(value.apiKey)
    )
      return false;
    const headers = isConfigObject(value.headers) ? value.headers : {};
    const provider = headers["X-NemoClaw-Upstream-Provider"];
    return (
      typeof provider === "string" &&
      (Boolean(fixedNativeProvider(provider)) ||
        (typeof value.baseUrl === "string" &&
          (Boolean(nativeHostedAgentConfig(provider, value.baseUrl)) ||
            (usesNativeLocalInference(provider, value.baseUrl) &&
              Boolean(nativeLocalCredentialReference(provider, value.baseUrl))))))
    );
  });
  if (matching.length === 0) return undefined;
  if (matching.length !== 1) throw new Error("Expected one native provider config update");
  const value = matching[0]!.value;
  if (!isConfigObject(value)) throw new Error("Invalid native provider config update");
  const headers = isConfigObject(value.headers) ? value.headers : {};
  const provider = headers["X-NemoClaw-Upstream-Provider"];
  const local =
    typeof provider === "string" &&
    typeof value.baseUrl === "string" &&
    usesNativeLocalInference(provider, value.baseUrl)
      ? nativeLocalCredentialReference(provider, value.baseUrl)
      : null;
  const native =
    value.apiKey === NVIDIA_INFERENCE_PLACEHOLDER
      ? {
          credentialEnv: NVIDIA_HOSTED_CREDENTIAL_ENV,
          apiKey: NVIDIA_INFERENCE_PLACEHOLDER,
        }
      : local
        ? { credentialEnv: NATIVE_LOCAL_CREDENTIAL_ENV, apiKey: local }
        : typeof provider === "string" && typeof value.baseUrl === "string"
          ? nativeHostedAgentConfig(provider, value.baseUrl)
          : undefined;
  if (!native) {
    throw new Error("Native provider identity does not match its credential placeholder");
  }
  if (value.apiKey !== native.apiKey || typeof value.baseUrl !== "string") {
    throw new Error("Native provider credential placeholder or endpoint does not match");
  }
  if (
    value.apiKey === NVIDIA_INFERENCE_PLACEHOLDER &&
    value.baseUrl !== NVIDIA_HOSTED_NATIVE_ENDPOINT
  ) {
    throw new Error("Native provider endpoint does not match");
  }
  if (
    value.apiKey === NVIDIA_INFERENCE_PLACEHOLDER &&
    provider !== undefined &&
    provider !== "nvidia-prod"
  ) {
    throw new Error("Native NVIDIA provider identity does not match its credential placeholder");
  }
  const logicalProvider =
    value.apiKey === NVIDIA_INFERENCE_PLACEHOLDER
      ? "nvidia-prod"
      : typeof provider === "string"
        ? provider
        : null;
  const providerKey = local
    ? "inference"
    : nativeOpenClawProviderKey(logicalProvider, typeof value.api === "string" ? value.api : null);
  if (!providerKey)
    throw new Error("Native provider identity does not match its credential placeholder");
  const expectedPath = `models.providers.${providerKey}`;
  if (matching[0]!.dotpath !== expectedPath) {
    throw new Error("Native provider config path does not match its identity");
  }
  return {
    credentialEnv: native.credentialEnv,
    endpoint: value.baseUrl,
    placeholder: native.apiKey,
    providerPath: expectedPath,
  };
}

export function buildOpenClawNativeConfigBatchInvocation(
  sandboxName: string,
  updates: readonly OpenClawConfigUpdate[],
  gateway?: string | OpenShellRuntimeSelection,
) {
  const nativeHandleUpdate = nativeProviderHandleUpdate(updates);
  const materializeCommand = nativeHandleUpdate
    ? `python3 -c ${shellQuote(materializeNativeProviderHandle)} "$file" ${shellQuote(nativeHandleUpdate.credentialEnv)} ${shellQuote(nativeHandleUpdate.endpoint)} ${shellQuote(nativeHandleUpdate.placeholder)} ${shellQuote(nativeHandleUpdate.providerPath)} || exit $?; `
    : "";
  return {
    nativeHandleUpdate: Boolean(nativeHandleUpdate),
    ...(!gateway || typeof gateway === "string"
      ? {}
      : {
          env: buildSelectedOpenShellSubprocessEnv(gateway),
          replaceEnv: true,
        }),
    args: [
      ...(gateway ? ["-g", typeof gateway === "string" ? gateway : gateway.gatewayName] : []),
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--env",
      "HOME=/sandbox",
      "--",
      "sh",
      "-c",
      `umask 077; file=$(mktemp /tmp/nemoclaw-openclaw-config.XXXXXX) || exit $?; trap 'rm -f "$file"' EXIT; cat >"$file" || exit $?; ${materializeCommand}openclaw config set --batch-file "$file"`,
      "nemoclaw-openclaw-config-set-batch",
    ],
    input: JSON.stringify(updates.map(({ dotpath, value }) => ({ path: dotpath, value }))),
  };
}

export function executeOpenClawNativeConfigSet(
  binary: string,
  maxBuffer: number,
  sandboxName: string,
  dotpath: string,
  value: ConfigValue,
  gateway?: string | OpenShellRuntimeSelection,
): void {
  const invocation = buildOpenClawNativeConfigSetInvocation(sandboxName, dotpath, value, gateway);
  const result = runOpenshellCommand(binary, invocation.args, {
    env: invocation.env,
    replaceEnv: invocation.replaceEnv,
    ignoreError: true,
    input: invocation.input,
    maxBuffer,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
  });
  if (!result.error && !result.signal && result.status === 0) return;
  const detail = redactFull(
    result.error?.message || String(result.stderr ?? "").trim() || "command failed",
  );
  throw new Error(`Native OpenClaw config command failed: ${detail}`);
}

export function executeOpenClawNativeConfigBatch(
  binary: string,
  maxBuffer: number,
  sandboxName: string,
  updates: readonly OpenClawConfigUpdate[],
  gateway?: string | OpenShellRuntimeSelection,
): void {
  const invocation = buildOpenClawNativeConfigBatchInvocation(sandboxName, updates, gateway);
  runOpenClawNativeConfigBatchUntilHandleReady(invocation.nativeHandleUpdate, () =>
    runOpenshellCommand(binary, invocation.args, {
      env: invocation.env,
      replaceEnv: invocation.replaceEnv,
      ignoreError: true,
      input: invocation.input,
      maxBuffer,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    }),
  );
}

type NativeConfigBatchResult = Pick<
  ReturnType<typeof runOpenshellCommand>,
  "error" | "signal" | "status" | "stderr"
>;

export function runOpenClawNativeConfigBatchUntilHandleReady(
  nativeHandleUpdate: boolean,
  run: () => NativeConfigBatchResult,
  wait: (ms: number) => void = (ms) =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  warn: (message: string) => void = console.warn,
): void {
  // OpenShell 0.0.116 attach can confirm desired state before a fresh process
  // receives the new environment. This retry is owned by native inference and
  // applies only when the materializer exited before OpenClaw changed config.
  const maxAttempts = nativeHandleUpdate ? 10 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = run();
    if (!result.error && !result.signal && result.status === 0) return;
    const handlePending =
      !result.error &&
      !result.signal &&
      result.status === 75 &&
      String(result.stderr ?? "").includes("NEMOCLAW_NATIVE_PROVIDER_HANDLE_PENDING");
    if (handlePending && attempt < maxAttempts) {
      warn(`Native provider handle pending; config attempt ${attempt}/${maxAttempts}`);
      wait(2_000);
      continue;
    }
    const detail = redactFull(
      result.error?.message || String(result.stderr ?? "").trim() || "command failed",
    );
    throw new Error(`Native OpenClaw config command failed after ${attempt} attempt(s): ${detail}`);
  }
}
