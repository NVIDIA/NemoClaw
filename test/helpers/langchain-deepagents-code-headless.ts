// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

export const headlessCheckPath = path.join(
  repoRoot,
  "test",
  "e2e",
  "e2e-cloud-experimental",
  "checks",
  "07-deepagents-code-headless-inference.sh",
);

export const DCODE_CANONICAL_PATH =
  "/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin";

export const PROXY_URL_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
] as const;
export const NO_PROXY_ENV_NAMES = ["NO_PROXY", "no_proxy"] as const;
export const TRUSTED_FETCH_PROXY_ENV_NAME = "DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL" as const;
const CLEARED_PROXY_ENV_NAMES = ["ALL_PROXY", "all_proxy", "OPENAI_PROXY"] as const;
export const TRACING_ENABLE_ENV_NAMES = [
  "DEEPAGENTS_CODE_LANGSMITH_TRACING",
  "DEEPAGENTS_CODE_LANGSMITH_TRACING_V2",
  "DEEPAGENTS_CODE_LANGCHAIN_TRACING",
  "DEEPAGENTS_CODE_LANGCHAIN_TRACING_V2",
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING",
  "LANGCHAIN_TRACING_V2",
] as const;
export const ANALYTICS_DISABLE_ENV_NAMES = ["LANGGRAPH_CLI_NO_ANALYTICS"] as const;

export function makeStartScriptFixture(
  tempDir: string,
  original: string,
): {
  envFile: string;
  scriptPath: string;
} {
  const envFile = path.join(tempDir, "proxy-env.sh");
  const scriptPath = path.join(tempDir, "start.sh");
  const rlimitLib = path.join(tempDir, "sandbox-rlimits.sh");
  const hostFile = path.join(tempDir, "trusted-proxy-host");
  const portFile = path.join(tempDir, "trusted-proxy-port");
  const markerDir = path.join(tempDir, "persistent-dcode-state");
  expect(original).toContain("local target=/tmp/nemoclaw-proxy-env.sh");
  expect(original).toContain('tmp="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"');
  expect(original).toContain("local marker_dir=/sandbox/.deepagents");
  const fixture = original
    .replace("/usr/local/lib/nemoclaw/sandbox-rlimits.sh", rlimitLib)
    .replace(
      'readonly MANAGED_PROXY_HOST_FILE="/usr/local/share/nemoclaw/dcode-proxy-host"',
      `readonly MANAGED_PROXY_HOST_FILE="${hostFile}"`,
    )
    .replace(
      'readonly MANAGED_PROXY_PORT_FILE="/usr/local/share/nemoclaw/dcode-proxy-port"',
      `readonly MANAGED_PROXY_PORT_FILE="${portFile}"`,
    )
    .replace(
      "readonly MANAGED_PROXY_OWNER_UID=0",
      `readonly MANAGED_PROXY_OWNER_UID=${process.getuid?.() ?? 0}`,
    )
    .replace("local target=/tmp/nemoclaw-proxy-env.sh", `local target="${envFile}"`)
    .replace(
      'tmp="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"',
      `tmp="$(mktemp "${tempDir}/nemoclaw-proxy-env.XXXXXX")"`,
    )
    .replace("local marker_dir=/sandbox/.deepagents", `local marker_dir="${markerDir}"`);
  expect(fixture).toContain(`local target="${envFile}"`);
  expect(fixture).toContain(`tmp="$(mktemp "${tempDir}/nemoclaw-proxy-env.XXXXXX")"`);
  expect(fixture).not.toContain("local target=/tmp/nemoclaw-proxy-env.sh");
  expect(fixture).not.toContain('tmp="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"');
  expect(fixture).toContain(`local marker_dir="${markerDir}"`);
  expect(fixture).not.toContain("local marker_dir=/sandbox/.deepagents");
  fs.writeFileSync(hostFile, "10.200.0.1\n", "utf8");
  fs.writeFileSync(portFile, "3128\n", "utf8");
  fs.writeFileSync(
    rlimitLib,
    "harden_resource_limits() { :; }\nverify_resource_limits_exact() { :; }\n",
    "utf8",
  );
  fs.chmodSync(hostFile, 0o444);
  fs.chmodSync(portFile, 0o444);
  fs.writeFileSync(scriptPath, fixture, "utf8");
  fs.chmodSync(scriptPath, 0o755);
  return { envFile, scriptPath };
}

type HeadlessCheckOperation =
  | "classify-output"
  | "contains-secret"
  | "entrypoint-rlimits"
  | "managed-placeholder"
  | "managed-route"
  | "positive-integer";

type HeadlessCheckEnvironment = Partial<
  Record<
    | "CONFIG"
    | "DCODE_EXIT"
    | "DEEPAGENTS_HEADLESS_TIMEOUT"
    | "HEADLESS_OUTPUT"
    | "PROC_ROOT"
    | "TOKEN",
    string
  >
>;

const HEADLESS_CHECK_HELPER_SCRIPT = `
source test/e2e/e2e-cloud-experimental/checks/07-deepagents-code-headless-inference.sh
case "$1" in
  managed-route)
    printf "%s" "$CONFIG" | references_managed_inference_route && printf route
    ;;
  managed-placeholder)
    printf "%s" "$CONFIG" | references_managed_placeholder_key && printf key
    ;;
  classify-output)
    if classification="$(classify_headless_output "$DCODE_EXIT" "$HEADLESS_OUTPUT")"; then
      printf "pass:%s" "$classification"
    else
      printf "fail:%s" "$classification"
    fi
    ;;
  positive-integer)
    if is_positive_integer "$HEADLESS_TIMEOUT"; then printf valid; else printf invalid; fi
    ;;
  contains-secret)
    if printf "%s" "$TOKEN" | contains_secret; then printf secret; else printf clean; fi
    ;;
  entrypoint-rlimits)
    command="$(dcode_entrypoint_rlimit_contract_command "$PROC_ROOT")"
    bash -c "$command"
    ;;
  *)
    printf "unsupported helper operation\\n" >&2
    exit 64
    ;;
esac
`;

export function runStartScriptProxyProbe(
  scriptPath: string,
  envFile: string,
  env: NodeJS.ProcessEnv,
): { envFileText: string; output: string } {
  const probe = [
    ...[
      ...PROXY_URL_ENV_NAMES,
      TRUSTED_FETCH_PROXY_ENV_NAME,
      ...NO_PROXY_ENV_NAMES,
      ...CLEARED_PROXY_ENV_NAMES,
      ...TRACING_ENABLE_ENV_NAMES,
      ...ANALYTICS_DISABLE_ENV_NAMES,
    ].map((name) => `printf 'RUNTIME_${name}=%s\\n' "\${${name}-__unset__}"`),
    "unset HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy ALL_PROXY all_proxy",
    "export ALL_PROXY=socks5://persisted-user:persisted-password@persisted-all-proxy.example:1080",
    "export all_proxy=socks5://lower-persisted-user:lower-persisted-password@lower-persisted-all-proxy.example:1080",
    '. "$NEMOCLAW_TEST_PROXY_ENV"',
    ...[
      ...PROXY_URL_ENV_NAMES,
      TRUSTED_FETCH_PROXY_ENV_NAME,
      ...NO_PROXY_ENV_NAMES,
      ...CLEARED_PROXY_ENV_NAMES,
      ...TRACING_ENABLE_ENV_NAMES,
      ...ANALYTICS_DISABLE_ENV_NAMES,
    ].map((name) => `printf 'SOURCED_${name}=%s\\n' "\${${name}-__unset__}"`),
  ].join("\n");
  const result = spawnSync("bash", [scriptPath, "bash", "-c", probe], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...env,
      NEMOCLAW_TEST_PROXY_ENV: envFile,
    },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return {
    envFileText: fs.readFileSync(envFile, "utf8"),
    output: `${result.stdout}\n${result.stderr}`,
  };
}

export function runHeadlessCheckHelper(
  operation: HeadlessCheckOperation,
  env: HeadlessCheckEnvironment = {},
): string {
  return execFileSync("/bin/bash", ["-c", HEADLESS_CHECK_HELPER_SCRIPT, "bash", operation], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      CONFIG: env.CONFIG ?? "",
      DCODE_EXIT: env.DCODE_EXIT ?? "",
      DEEPAGENTS_HEADLESS_TIMEOUT: env.DEEPAGENTS_HEADLESS_TIMEOUT ?? "",
      HEADLESS_OUTPUT: env.HEADLESS_OUTPUT ?? "",
      PATH: "/usr/bin:/bin",
      PROC_ROOT: env.PROC_ROOT ?? "",
      TOKEN: env.TOKEN ?? "",
    },
  });
}

export function runHeadlessCheckSnippet(
  snippet: string,
  env: NodeJS.ProcessEnv = {},
  sourcePath = headlessCheckPath,
): string {
  const source = fs
    .readFileSync(sourcePath, "utf8")
    .replace("${BASH_SOURCE[0]}", "${BASH_SOURCE[0]-}");
  return execFileSync("/bin/bash", ["-s"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    input: `${source}\n${snippet}\n`,
  });
}
