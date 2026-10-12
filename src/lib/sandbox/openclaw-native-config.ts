// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Host-side OpenClaw native config commands and scoped NVIDIA handle materialization.

import type { OpenShellRuntimeSelection } from "../adapters/openshell/client";
import type { ConfigValue } from "../security/credential-filter";
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
  NVIDIA_HOSTED_NATIVE_ENDPOINT,
}: typeof import("../inference/native-nvidia/contract") = require("../inference/native-nvidia/contract");
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
const materializeNativeNvidiaHandle = [
  "import json, os, re, sys",
  'handle = os.environ.get("NVIDIA_INFERENCE_API_KEY", "")',
  "if not handle:",
  '    sys.stderr.write("NEMOCLAW_NATIVE_PROVIDER_HANDLE_PENDING\\n")',
  "    raise SystemExit(75)",
  'if not re.fullmatch(r"openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_NVIDIA_INFERENCE_API_KEY", handle):',
  '    raise SystemExit("Native NVIDIA provider handle is unavailable or invalid")',
  'with open(sys.argv[1], "r+", encoding="utf-8") as stream:',
  "    updates = json.load(stream)",
  "    if not isinstance(updates, list):",
  '        raise SystemExit("Invalid OpenClaw config batch")',
  "    matched = 0",
  "    for update in updates:",
  '        if not isinstance(update, dict) or update.get("path") != "models.providers.inference":',
  "            continue",
  '        provider = update.get("value")',
  '        if not isinstance(provider, dict) or provider.get("apiKey") != sys.argv[3]:',
  "            continue",
  '        if provider.get("baseUrl") != sys.argv[2]:',
  '            raise SystemExit("Native NVIDIA provider endpoint does not match")',
  '        provider["apiKey"] = handle',
  "        matched += 1",
  "    if matched != 1:",
  '        raise SystemExit("Expected one native NVIDIA provider config update")',
  "    stream.seek(0)",
  '    json.dump(updates, stream, separators=(",", ":"))',
  "    stream.truncate()",
].join("\n");
export function buildOpenClawNativeConfigBatchInvocation(
  sandboxName: string,
  updates: readonly OpenClawConfigUpdate[],
  gateway?: string | OpenShellRuntimeSelection,
) {
  const nativeNvidiaUpdate = updates.some(
    ({ dotpath, value }) =>
      dotpath === "models.providers.inference" &&
      isConfigObject(value) &&
      value.apiKey === NVIDIA_INFERENCE_PLACEHOLDER,
  );
  const materializeCommand = nativeNvidiaUpdate
    ? `python3 -c ${shellQuote(materializeNativeNvidiaHandle)} "$file" ${shellQuote(NVIDIA_HOSTED_NATIVE_ENDPOINT)} ${shellQuote(NVIDIA_INFERENCE_PLACEHOLDER)} || exit $?; `
    : "";
  return {
    nativeNvidiaUpdate,
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
  runOpenClawNativeConfigBatchUntilHandleReady(invocation.nativeNvidiaUpdate, () =>
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
  nativeNvidiaUpdate: boolean,
  run: () => NativeConfigBatchResult,
  wait: (ms: number) => void = (ms) =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  warn: (message: string) => void = console.warn,
): void {
  // OpenShell 0.0.116 attach can confirm desired state before a fresh process
  // receives the new environment. This retry is owned by native inference and
  // applies only when the materializer exited before OpenClaw changed config.
  const maxAttempts = nativeNvidiaUpdate ? 10 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = run();
    if (!result.error && !result.signal && result.status === 0) return;
    const handlePending =
      !result.error &&
      !result.signal &&
      result.status === 75 &&
      String(result.stderr ?? "").includes("NEMOCLAW_NATIVE_PROVIDER_HANDLE_PENDING");
    if (handlePending && attempt < maxAttempts) {
      warn(`Native NVIDIA provider handle pending; config attempt ${attempt}/${maxAttempts}`);
      wait(2_000);
      continue;
    }
    const detail = redactFull(
      result.error?.message || String(result.stderr ?? "").trim() || "command failed",
    );
    throw new Error(`Native OpenClaw config command failed after ${attempt} attempt(s): ${detail}`);
  }
}
