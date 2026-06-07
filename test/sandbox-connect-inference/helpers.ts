// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { execTimeout } from "../helpers/timeouts";

/**
 * Tests for #1248 — inference route swap on sandbox connect.
 *
 * Each test creates a fake openshell binary that records calls to a state
 * file, sets up a sandbox registry, and spawns the real CLI entrypoint.
 */

export type SandboxEntryFixture = {
  name: string;
  model?: string | null;
  provider?: string | null;
  nimContainer?: string | null;
  gpuEnabled?: boolean;
  openshellDriver?: string | null;
  policies?: string[];
};

export type SetupFixtureOptions = {
  curlExitCode?: number;
  curlHttpStatus?: string;
  curlStderr?: string;
  inferenceProbeExitStatuses?: number[];
  inferenceProbeResponses?: string[];
  inferenceSetStatus?: number;
  writeOllamaProxyState?: boolean;
};

export function isHostWsl() {
  return (
    process.platform === "linux" &&
    (Boolean(process.env.WSL_DISTRO_NAME) ||
      Boolean(process.env.WSL_INTEROP) ||
      /microsoft/i.test(os.release()))
  );
}

function writeRegistryState(
  registryDir: string,
  sandboxName: string,
  sandboxEntry: SandboxEntryFixture,
  options: SetupFixtureOptions,
) {
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: { [sandboxName]: sandboxEntry },
    }),
    { mode: 0o600 },
  );

  if (
    sandboxEntry.provider !== "ollama-local" ||
    options.writeOllamaProxyState === false
  ) {
    return;
  }

  fs.writeFileSync(path.join(registryDir, "ollama-proxy-token"), "test-token\n", {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(registryDir, "ollama-auth-proxy.pid"), "12345\n", {
    mode: 0o600,
  });
}

function buildInferenceBlock(
  liveInferenceProvider: string | null,
  liveInferenceModel: string | null,
) {
  if (liveInferenceProvider && liveInferenceModel) {
    return `Gateway inference:\\n  Provider: ${liveInferenceProvider}\\n  Model: ${liveInferenceModel}\\n`;
  }
  return `Gateway inference:\\n  Not configured\\n`;
}

function initStateFile(stateFile: string, options: SetupFixtureOptions) {
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      dockerCalls: [],
      curlExitCode: options.curlExitCode ?? 0,
      curlHttpStatus: options.curlHttpStatus ?? "200",
      curlStderr: options.curlStderr ?? "",
      curlCalls: [],
      curlEnvs: [],
      inferenceProbeExitStatuses: options.inferenceProbeExitStatuses ?? [],
      inferenceProbeResponses: options.inferenceProbeResponses ?? ["OK 200"],
      inferenceSetCalls: [],
      sandboxConnectCalls: [],
      sandboxExecCalls: [],
    }),
  );
}

function writeExecutable(filePath: string, contents: string) {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

function writeOpenshellStub(
  openshellPath: string,
  stateFile: string,
  sandboxName: string,
  inferenceBlock: string,
  options: SetupFixtureOptions,
) {
  writeExecutable(
    openshellPath,
    `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
const stateFile = ${JSON.stringify(stateFile)};
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));

if (args[0] === "status") {
  process.stdout.write("Gateway: nemoclaw\\nStatus: Connected\\n");
  process.exit(0);
}

if (args[0] === "gateway" && args[1] === "info") {
  process.stdout.write("Gateway: nemoclaw\\nGateway endpoint: https://127.0.0.1:8080\\n");
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "get" && args[2] === ${JSON.stringify(sandboxName)}) {
  process.stdout.write("Sandbox:\\n\\n  \\x1b[2mId:\\x1b[0m abc\\n  Name: ${sandboxName}\\n  Phase: Ready\\n");
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "list") {
  process.stdout.write("${sandboxName}   Ready   2m ago\\n");
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "exec") {
  state.sandboxExecCalls.push(args);
  const command = args.join(" ");
  if (!command.includes("inference.local/v1/models")) {
    fs.writeFileSync(stateFile, JSON.stringify(state));
    // Test hook (#4263 / CodeRabbit): when the connect-time auto-pair
    // approval pass is specifically targeted, simulate the failure
    // path the production code must tolerate. The approval-pass script
    // is identifiable by its embedded \`openclaw devices approve\` call.
    if (
      process.env.NEMOCLAW_TEST_FAIL_APPROVAL_PASS === "1" &&
      command.includes("openclaw") &&
      command.includes("devices") &&
      command.includes("approve")
    ) {
      process.stderr.write("simulated sandbox exec failure\\n");
      process.exit(7);
    }
    process.stdout.write("__NEMOCLAW_SANDBOX_EXEC_STARTED__\\nRUNNING\\n");
    process.exit(0);
  }
  const response = state.inferenceProbeResponses.length
    ? state.inferenceProbeResponses.shift()
    : 'BROKEN 503 {"error":"missing mocked inference probe response"}';
  const exitStatus = Number(state.inferenceProbeExitStatuses.shift() || 0);
  fs.writeFileSync(stateFile, JSON.stringify(state));
  process.stdout.write(response);
  process.exit(exitStatus);
}

if (args[0] === "sandbox" && args[1] === "connect") {
  // Don't actually drop into a shell — just exit successfully
  state.sandboxConnectCalls.push(args);
  fs.writeFileSync(stateFile, JSON.stringify(state));
  process.exit(0);
}

if (args[0] === "inference" && args[1] === "get") {
  process.stdout.write(${JSON.stringify(inferenceBlock.replace(/\\n/g, "\n"))});
  process.exit(0);
}

if (args[0] === "inference" && args[1] === "set") {
  state.inferenceSetCalls.push(args.slice(2));
  fs.writeFileSync(stateFile, JSON.stringify(state));
  process.exit(${JSON.stringify(options.inferenceSetStatus ?? 0)});
}

if (args[0] === "logs") {
  process.exit(0);
}

if (args[0] === "forward") {
  process.exit(0);
}

// Default — succeed silently
process.exit(0);
`,
  );
}

function writeDockerStub(dockerPath: string, stateFile: string, sandboxName: string) {
  writeExecutable(
    dockerPath,
    `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
const stateFile = ${JSON.stringify(stateFile)};
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
state.dockerCalls.push(args);
fs.writeFileSync(stateFile, JSON.stringify(state));
const cmd = args.join(" ");

if (args[0] === "ps") {
  process.stdout.write("openshell-cluster-nemoclaw\\n");
  process.exit(0);
}

if (cmd.includes("get service kube-dns")) {
  process.stdout.write("10.43.0.10");
  process.exit(0);
}
if (cmd.includes("get endpoints kube-dns")) {
  process.stdout.write("10.42.0.15");
  process.exit(0);
}
if (cmd.includes("get pods -n openshell -o name")) {
  process.stdout.write("pod/${sandboxName}-abc\\n");
  process.exit(0);
}
if (cmd.includes("ip addr show")) {
  process.stdout.write("10.200.0.1\\n");
  process.exit(0);
}
if (cmd.includes("cat /tmp/dns-proxy.pid")) {
  process.stdout.write("12345\\n");
  process.exit(0);
}
if (cmd.includes("cat /tmp/dns-proxy.log")) {
  process.stdout.write("dns-proxy: 10.200.0.1:53 -> 10.43.0.10:53 pid=12345\\n");
  process.exit(0);
}
if (cmd.includes("python3 -c")) {
  process.stdout.write("ok");
  process.exit(0);
}
if (cmd.includes("ls /run/netns/")) {
  process.stdout.write("sandbox-ns\\n");
  process.exit(0);
}
if (cmd.includes("test -x")) {
  process.exit(cmd.includes("/usr/sbin/iptables") ? 0 : 1);
}
if (cmd.includes("cat /etc/resolv.conf")) {
  process.stdout.write("nameserver 10.200.0.1\\n");
  process.exit(0);
}
if (cmd.includes("getent hosts github.com")) {
  process.stdout.write("140.82.112.4 github.com\\n");
  process.exit(0);
}

process.exit(0);
`,
  );
}

function writeCurlStub(curlPath: string, stateFile: string) {
  writeExecutable(
    curlPath,
    `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
const stateFile = ${JSON.stringify(stateFile)};
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
state.curlCalls.push(args);
state.curlEnvs.push({
  ALL_PROXY: process.env.ALL_PROXY || "",
  HTTP_PROXY: process.env.HTTP_PROXY || "",
  NO_PROXY: process.env.NO_PROXY || "",
  all_proxy: process.env.all_proxy || "",
  http_proxy: process.env.http_proxy || "",
  no_proxy: process.env.no_proxy || "",
});
fs.writeFileSync(stateFile, JSON.stringify(state));
const endpoint = args[args.length - 1] || "";
if (
  process.env.OPENSHELL_TEST_FAIL_LOCALHOST_OLLAMA === "1" &&
  endpoint.includes("127.0.0.1:11434/api/tags")
) {
  process.exit(7);
}
const outIndex = args.indexOf("-o");
const exitCode = Number(state.curlExitCode || 0);
const status = String(state.curlHttpStatus || "200");
if (outIndex >= 0 && args[outIndex + 1] && args[outIndex + 1] !== "/dev/null" && exitCode === 0) {
  fs.writeFileSync(args[outIndex + 1], '{"models":[]}');
}
if (state.curlStderr) {
  process.stderr.write(String(state.curlStderr));
}
if (args.includes("-w")) {
  process.stdout.write(status);
} else {
  process.stdout.write('{"models":[]}');
}
process.exit(exitCode);
`,
  );
}

function writePsStub(psPath: string) {
  writeExecutable(
    psPath,
    `#!${process.execPath}
process.stdout.write("node /tmp/ollama-auth-proxy.js\\n");
process.exit(0);
`,
  );
}

export function setupFixture(
  sandboxEntry: SandboxEntryFixture,
  liveInferenceProvider: string | null,
  liveInferenceModel: string | null,
  options: SetupFixtureOptions = {},
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-inf-swap-"));
  const homeLocalBin = path.join(tmpDir, ".local", "bin");
  const registryDir = path.join(tmpDir, ".nemoclaw");
  const stateFile = path.join(tmpDir, "state.json");
  const openshellPath = path.join(homeLocalBin, "openshell");
  const dockerPath = path.join(homeLocalBin, "docker");
  const curlPath = path.join(homeLocalBin, "curl");
  const psPath = path.join(homeLocalBin, "ps");
  const sandboxName = String(sandboxEntry.name);

  fs.mkdirSync(homeLocalBin, { recursive: true });
  fs.mkdirSync(registryDir, { recursive: true });

  const inferenceBlock = buildInferenceBlock(liveInferenceProvider, liveInferenceModel);
  writeRegistryState(registryDir, sandboxName, sandboxEntry, options);
  initStateFile(stateFile, options);
  writeOpenshellStub(openshellPath, stateFile, sandboxName, inferenceBlock, options);
  writeDockerStub(dockerPath, stateFile, sandboxName);
  writeCurlStub(curlPath, stateFile);
  writePsStub(psPath);

  return { tmpDir, stateFile, sandboxName };
}

export function createVmRootfs(tmpDir: string, sandboxId = "abc") {
  const rootfs = path.join(
    tmpDir,
    ".local",
    "state",
    "nemoclaw",
    "openshell-docker-gateway",
    "vm-driver",
    "sandboxes",
    sandboxId,
    "rootfs",
  );
  fs.mkdirSync(path.join(rootfs, "etc"), { recursive: true });
  fs.mkdirSync(path.join(rootfs, "srv"), { recursive: true });
  fs.writeFileSync(
    path.join(rootfs, "etc", "resolv.conf"),
    "nameserver 8.8.8.8\nnameserver 8.8.4.4\n",
  );
  fs.writeFileSync(
    path.join(rootfs, "srv", "openshell-vm-sandbox-init.sh"),
    [
      "elif ip link show eth0 >/dev/null 2>&1; then",
      "    if [ ! -s /etc/resolv.conf ]; then",
      '        echo "nameserver 8.8.8.8" > /etc/resolv.conf',
      '        echo "nameserver 8.8.4.4" >> /etc/resolv.conf',
      "    fi",
      "fi",
      "",
    ].join("\n"),
  );
  return rootfs;
}

export function runConnect(
  tmpDir: string,
  sandboxName: string,
  extraEnv: NodeJS.ProcessEnv = {},
  connectArgs: string[] = [],
) {
  const repoRoot = path.join(import.meta.dirname, "..", "..");
  return spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "bin", "nemoclaw.js"),
      sandboxName,
      "connect",
      ...connectArgs,
    ],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        HOME: tmpDir,
        PATH: `${path.join(tmpDir, ".local", "bin")}:/usr/bin:/bin`,
        NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT: "1",
        NEMOCLAW_NO_CONNECT_HINT: "1",
        NEMOCLAW_OLLAMA_PORT: "11434",
        NEMOCLAW_OLLAMA_PROXY_PORT: "11435",
        VITEST: "true",
        ...extraEnv,
      },
      timeout: execTimeout(15_000),
    },
  );
}

export function extractApprovalPassScript(stateFile: string, sandboxName: string): string {
  const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  const approvalExec = (state.sandboxExecCalls as string[][]).find(
    (call) =>
      call.includes("--") &&
      call.some((segment) => segment.includes("openclaw")) &&
      call.some((segment) => segment.includes("devices")) &&
      call.some((segment) => segment.includes("approve")),
  );
  expect(approvalExec).toBeDefined();
  expect(approvalExec).toContain("sandbox");
  expect(approvalExec).toContain("exec");
  expect(approvalExec).toContain("--name");
  expect(approvalExec).toContain(sandboxName);
  return approvalExec?.[approvalExec.length - 1] || "";
}

export function runApprovalPassScript(
  script: string,
  pending: unknown[],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-pass-"));
  const openclawPath = path.join(tmpDir, "openclaw");
  const approvalsFile = path.join(tmpDir, "approvals.log");
  const approvalEnvFile = path.join(tmpDir, "approval-env.log");
  const pendingResponse = JSON.stringify({ pending, paired: [] });

  try {
    fs.writeFileSync(
      openclawPath,
      `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "devices" && args[1] === "list") {
  process.stdout.write(${JSON.stringify(`${pendingResponse}\n`)});
  process.exit(0);
}
if (args[0] === "devices" && args[1] === "approve") {
  fs.appendFileSync(${JSON.stringify(approvalsFile)}, args[2] + "\\n");
  fs.appendFileSync(
    ${JSON.stringify(approvalEnvFile)},
    [
      process.env.OPENCLAW_GATEWAY_URL || "unset",
      process.env.OPENCLAW_GATEWAY_PORT || "unset",
      process.env.OPENCLAW_GATEWAY_TOKEN || "unset",
    ].join(":") + "\\n",
  );
  process.stdout.write("{}\\n");
  process.exit(0);
}
process.stderr.write("unexpected openclaw args: " + args.join(" ") + "\\n");
process.exit(2);
`,
      { mode: 0o755 },
    );

    const result = spawnSync("sh", ["-c", script], {
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${tmpDir}:/usr/bin:/bin`,
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
        OPENCLAW_GATEWAY_PORT: "18789",
        OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
        ...extraEnv,
      },
      timeout: 10_000,
    });
    const approvals = fs.existsSync(approvalsFile)
      ? fs.readFileSync(approvalsFile, "utf-8").trim().split("\n").filter(Boolean)
      : [];
    const approvalEnv = fs.existsSync(approvalEnvFile)
      ? fs.readFileSync(approvalEnvFile, "utf-8").trim().split("\n").filter(Boolean)
      : [];
    return { result, approvals, approvalEnv };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
