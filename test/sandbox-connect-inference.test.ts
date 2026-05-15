// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execTimeout, testTimeoutOptions } from "./helpers/timeouts";

/**
 * Tests for #1248 — inference route swap on sandbox connect.
 *
 * Each test creates a fake openshell binary that records calls to a state
 * file, sets up a sandbox registry, and spawns the real CLI entrypoint.
 */

type SandboxEntryFixture = {
  name: string;
  model?: string | null;
  provider?: string | null;
  nimContainer?: string | null;
  gpuEnabled?: boolean;
  openshellDriver?: string | null;
  policies?: string[];
};

type SetupFixtureOptions = {
  curlExitCode?: number;
  curlHttpStatus?: string;
  curlStderr?: string;
  inferenceProbeExitStatuses?: number[];
  inferenceProbeResponses?: string[];
  inferenceSetStatus?: number;
  writeOllamaProxyState?: boolean;
};

function isHostWsl() {
  return (
    process.platform === "linux" &&
    (Boolean(process.env.WSL_DISTRO_NAME) ||
      Boolean(process.env.WSL_INTEROP) ||
      /microsoft/i.test(os.release()))
  );
}

function setupFixture(
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

  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: { [sandboxName]: sandboxEntry },
    }),
    { mode: 0o600 },
  );

  if (sandboxEntry.provider === "ollama-local" && options.writeOllamaProxyState !== false) {
    fs.writeFileSync(path.join(registryDir, "ollama-proxy-token"), "test-token\n", {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(registryDir, "ollama-auth-proxy.pid"), "12345\n", {
      mode: 0o600,
    });
  }

  // Build the Gateway inference section for `openshell inference get`
  let inferenceBlock;
  if (liveInferenceProvider && liveInferenceModel) {
    inferenceBlock = `Gateway inference:\\n  Provider: ${liveInferenceProvider}\\n  Model: ${liveInferenceModel}\\n`;
  } else {
    inferenceBlock = `Gateway inference:\\n  Not configured\\n`;
  }

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

  // Fake openshell binary — records inference set calls, stubs everything else
  fs.writeFileSync(
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
    process.stdout.write("__NEMOCLAW_SANDBOX_EXEC_STARTED__\\nRUNNING\\n");
    process.exit(0);
  }
  const response = state.inferenceProbeResponses.shift() || "OK 200";
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
    { mode: 0o755 },
  );

  fs.writeFileSync(
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
    { mode: 0o755 },
  );

  fs.writeFileSync(
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
    { mode: 0o755 },
  );

  fs.writeFileSync(
    psPath,
    `#!${process.execPath}
process.stdout.write("node /tmp/ollama-auth-proxy.js\\n");
process.exit(0);
`,
    { mode: 0o755 },
  );

  return { tmpDir, stateFile, sandboxName };
}

function createVmRootfs(tmpDir: string, sandboxId = "abc") {
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

function runConnect(
  tmpDir: string,
  sandboxName: string,
  extraEnv: NodeJS.ProcessEnv = {},
  connectArgs: string[] = [],
) {
  const repoRoot = path.join(import.meta.dirname, "..");
  return spawnSync(
    process.execPath,
    [path.join(repoRoot, "bin", "nemoclaw.js"), sandboxName, "connect", ...connectArgs],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${path.join(tmpDir, ".local", "bin")}:/usr/bin:/bin`,
        NEMOCLAW_NO_CONNECT_HINT: "1",
        NEMOCLAW_OLLAMA_PORT: "11434",
        NEMOCLAW_OLLAMA_PROXY_PORT: "11435",
        ...extraEnv,
      },
      timeout: execTimeout(15_000),
    },
  );
}

describe("sandbox connect inference route swap (#1248)", () => {
  it(
    "swaps inference route when live route does not match sandbox provider",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "my-sandbox",
          model: "claude-sonnet-4-20250514",
          provider: "anthropic-prod",
          gpuEnabled: false,
          policies: [],
        },
        "nvidia-prod", // live route points to a different provider
        "nvidia/nemotron-3-super-120b-a12b",
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls.length).toBe(1);
      expect(state.inferenceSetCalls[0]).toEqual([
        "--provider",
        "anthropic-prod",
        "--model",
        "claude-sonnet-4-20250514",
        "--no-verify",
      ]);

      // Verify the notice was printed
      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain(
        "Switching inference route to anthropic-prod/claude-sonnet-4-20250514",
      );
    },
  );

  it(
    "does not swap inference route for legacy sandbox without provider",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "legacy-sandbox",
          gpuEnabled: false,
          policies: [],
          // No provider or model — pre-v0.0.18 sandbox
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls.length).toBe(0);
    },
  );

  it(
    "does not swap when live route already matches sandbox provider",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "matched-sandbox",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls.length).toBe(0);
    },
  );

  it(
    "repairs the sandbox DNS proxy when inference.local returns 503",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "stale-dns-sandbox",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          openshellDriver: "docker",
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
        {
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"inference service unavailable"}',
            "OK 200",
          ],
        },
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const dockerCalls = state.dockerCalls as string[][];
      const inferenceExecCalls = state.sandboxExecCalls.filter((call: string[]) =>
        JSON.stringify(call).includes("inference.local/v1/models"),
      );
      expect(state.inferenceSetCalls.length).toBe(0);
      expect(inferenceExecCalls.length).toBe(2);
      expect(dockerCalls.some((call) => call.join(" ").includes("get service kube-dns"))).toBe(true);
      expect(dockerCalls.some((call) => call.join(" ").includes("get endpoints kube-dns"))).toBe(false);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("inference.local is unavailable inside 'stale-dns-sandbox'");
      expect(combined).toContain("inference.local route repaired");
    },
  );

  it(
    "does not run legacy DNS proxy repair for VM sandboxes",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "vm-sandbox",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          openshellDriver: "vm",
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
        {
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"inference service unavailable"}',
            'BROKEN 503 {"error":"inference service unavailable"}',
            'BROKEN 503 {"error":"inference service unavailable"}',
          ],
        },
      );

      const result = runConnect(tmpDir, sandboxName, {
        NEMOCLAW_FORCE_VM_DNS_MONKEYPATCH: "1",
      });
      expect(result.status).toBe(1);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls.length).toBe(2);
      expect(state.dockerCalls.length).toBe(0);
      expect(state.sandboxConnectCalls).toEqual([]);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("OpenShell VM DNS monkeypatch did not apply");
      expect(combined).toContain("Reapplying OpenShell inference route");
      expect(combined).toContain("OpenShell vm gateway path");
      expect(combined).toContain("Connect is stopping because the sandbox inference route is known to be broken");
    },
  );

  it(
    "uses the macOS VM DNS monkeypatch without legacy DNS repair or route reset when it restores inference.local",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "vm-dns-sandbox",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          openshellDriver: "vm",
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
        {
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"inference service unavailable"}',
            "OK 200",
          ],
        },
      );
      const rootfs = createVmRootfs(tmpDir);

      const result = runConnect(tmpDir, sandboxName, {
        NEMOCLAW_FORCE_VM_DNS_MONKEYPATCH: "1",
      });
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls.length).toBe(0);
      expect(state.dockerCalls.length).toBe(0);
      expect(fs.readFileSync(path.join(rootfs, "etc", "resolv.conf"), "utf-8")).toBe(
        "nameserver 192.168.127.1\n",
      );
      expect(
        fs.readFileSync(path.join(rootfs, "srv", "openshell-vm-sandbox-init.sh"), "utf-8"),
      ).toContain('nameserver ${GVPROXY_GATEWAY_IP}');

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("Applying OpenShell VM DNS monkeypatch");
      expect(combined).toContain("inference.local route repaired");
      expect(combined).not.toContain("Reapplying OpenShell inference route");
      expect(combined).not.toContain("Repairing sandbox DNS proxy");
    },
  );

  it(
    "falls back to OpenShell inference route reapply when the VM DNS monkeypatch applies but inference.local stays broken",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "vm-dns-still-broken",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          openshellDriver: "vm",
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
        {
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"inference service unavailable"}',
            'BROKEN 503 {"error":"inference service unavailable"}',
            "OK 200",
          ],
        },
      );
      const rootfs = createVmRootfs(tmpDir);

      const result = runConnect(tmpDir, sandboxName, {
        NEMOCLAW_FORCE_VM_DNS_MONKEYPATCH: "1",
      });
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls.length).toBe(1);
      expect(state.dockerCalls.length).toBe(0);
      expect(fs.readFileSync(path.join(rootfs, "etc", "resolv.conf"), "utf-8")).toBe(
        "nameserver 192.168.127.1\n",
      );

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("Applying OpenShell VM DNS monkeypatch");
      expect(combined).toContain(
        "OpenShell VM DNS monkeypatch completed but inference.local is still unavailable",
      );
      expect(combined).toContain("Reapplying OpenShell inference route");
      expect(combined).toContain("inference.local route repaired");
    },
  );

  it(
    "probes VM inference health after route reapply even when inference set exits nonzero",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "vm-route-set-nonzero",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          openshellDriver: "vm",
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
        {
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"inference service unavailable"}',
            "OK 200",
          ],
          inferenceSetStatus: 1,
        },
      );

      const result = runConnect(tmpDir, sandboxName, {
        NEMOCLAW_FORCE_VM_DNS_MONKEYPATCH: "1",
      });
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls).toEqual([
        [
          "--provider",
          "nvidia-prod",
          "--model",
          "nvidia/nemotron-3-super-120b-a12b",
          "--no-verify",
        ],
      ]);
      expect(state.dockerCalls.length).toBe(0);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("OpenShell VM DNS monkeypatch did not apply");
      expect(combined).toContain("Reapplying OpenShell inference route");
      expect(combined).toContain("inference.local route repaired");
      expect(combined).not.toContain("OpenShell vm gateway path");
    },
  );

  it(
    "repairs the sandbox DNS proxy when inference.local returns 000 with a non-zero probe exit",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "dns-000-sandbox",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
        {
          inferenceProbeExitStatuses: [1, 0],
          inferenceProbeResponses: ["BROKEN 000 ", "OK 200"],
        },
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const dockerCalls = state.dockerCalls as string[][];
      const inferenceExecCalls = state.sandboxExecCalls.filter((call: string[]) =>
        JSON.stringify(call).includes("inference.local/v1/models"),
      );
      expect(state.inferenceSetCalls.length).toBe(0);
      expect(inferenceExecCalls.length).toBe(2);
      expect(dockerCalls.some((call) => call.join(" ").includes("get service kube-dns"))).toBe(true);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("inference.local is unavailable inside 'dns-000-sandbox'");
      expect(combined).toContain("inference.local route repaired");
    },
  );

  it(
    "checks the Ollama auth proxy before local provider health during probe-only route reset",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "probe-only-ollama-sandbox",
          model: "qwen3:0.6b",
          provider: "ollama-local",
          gpuEnabled: false,
          policies: [],
        },
        "ollama-local",
        "qwen3:0.6b",
        {
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            "OK 200",
          ],
        },
      );

      const nonWslPlatformPreload = path.join(tmpDir, "force-non-wsl-platform.cjs");
      fs.writeFileSync(
        nonWslPlatformPreload,
        [
          'const os = require("node:os");',
          'Object.defineProperty(process, "platform", { value: "linux" });',
          'os.release = () => "6.8.0-generic";',
          "delete process.env.WSL_DISTRO_NAME;",
          "delete process.env.WSL_INTEROP;",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const result = runConnect(
        tmpDir,
        sandboxName,
        {
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${nonWslPlatformPreload}`.trim(),
        },
        ["--probe-only"],
      );
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const endpoints = (state.curlCalls as string[][]).map((call) => call[call.length - 1]);
      const backendIndexes = endpoints
        .map((endpoint, index) =>
          endpoint.includes("127.0.0.1:11434/api/tags") ? index : -1,
        )
        .filter((index) => index >= 0);
      const firstProxyIndex = endpoints.findIndex(
        (endpoint) =>
          endpoint.includes("127.0.0.1:11435/v1/models") ||
          endpoint.includes("localhost:11435/v1/models"),
      );
      expect(firstProxyIndex).toBeGreaterThanOrEqual(0);
      expect(backendIndexes.length).toBeGreaterThanOrEqual(2);
      expect(firstProxyIndex).toBeLessThan(backendIndexes[1]);
    },
  );

  it(
    "resets matching inference route when DNS repair leaves inference.local broken",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "stale-route-sandbox",
          model: "qwen3:0.6b",
          provider: "ollama-local",
          gpuEnabled: false,
          policies: [],
        },
        "ollama-local",
        "qwen3:0.6b",
        {
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            "OK 200",
          ],
        },
      );

      const result = runConnect(tmpDir, sandboxName, {
        ALL_PROXY: "http://127.0.0.1:9",
        NEMOCLAW_LOCAL_INFERENCE_TIMEOUT: "321",
        NO_PROXY: "",
        http_proxy: "http://127.0.0.1:9",
        no_proxy: "",
      });
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const curlCalls = state.curlCalls as string[][];
      const curlEnvs = state.curlEnvs as Record<string, string>[];
      const inferenceExecCalls = state.sandboxExecCalls.filter((call: string[]) =>
        JSON.stringify(call).includes("inference.local/v1/models"),
      );
      expect(state.inferenceSetCalls).toEqual([
        [
          "--provider",
          "ollama-local",
          "--model",
          "qwen3:0.6b",
          "--no-verify",
          "--timeout",
          "321",
        ],
      ]);
      expect(inferenceExecCalls.length).toBe(3);
      if (!isHostWsl()) {
        expect(
          curlCalls.some((call) => call.join(" ").includes("127.0.0.1:11435/v1/models")),
        ).toBe(true);
      }
      expect(curlCalls.flat().join(" ")).not.toContain("Authorization: Bearer");
      for (const [index, call] of curlCalls.entries()) {
        const endpoint = call[call.length - 1];
        if (!endpoint.includes("127.0.0.1") && !endpoint.includes("localhost")) continue;
        const proxyBypass = `${curlEnvs[index]?.NO_PROXY || ""},${curlEnvs[index]?.no_proxy || ""}`;
        expect(proxyBypass).toContain("127.0.0.1");
        expect(proxyBypass).toContain("localhost");
        expect(curlEnvs[index]?.ALL_PROXY || "").toBe("");
      }

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("Resetting inference route to ollama-local/qwen3:0.6b");
      expect(combined).toContain("inference.local route repaired");
    },
  );

  it(
    "probes route health before failing a non-zero managed route reset",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "managed-route-set-nonzero",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          openshellDriver: "docker",
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
        {
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            "OK 200",
          ],
          inferenceSetStatus: 1,
        },
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const inferenceExecCalls = state.sandboxExecCalls.filter((call: string[]) =>
        JSON.stringify(call).includes("inference.local/v1/models"),
      );
      expect(state.inferenceSetCalls).toEqual([
        [
          "--provider",
          "nvidia-prod",
          "--model",
          "nvidia/nemotron-3-super-120b-a12b",
          "--no-verify",
        ],
      ]);
      expect(inferenceExecCalls.length).toBe(3);
      expect(state.sandboxConnectCalls).toEqual([["sandbox", "connect", sandboxName]]);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain(
        "Resetting inference route to nvidia-prod/nvidia/nemotron-3-super-120b-a12b",
      );
      expect(combined).toContain("inference.local route repaired");
      expect(combined).not.toContain("failed to reset the OpenShell inference route");
    },
  );

  it(
    "stops before sandbox connect when inference.local is still broken after route reset",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "still-broken-sandbox",
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
        },
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
        {
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
          ],
        },
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(1);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls).toEqual([
        [
          "--provider",
          "nvidia-prod",
          "--model",
          "nvidia/nemotron-3-super-120b-a12b",
          "--no-verify",
        ],
      ]);
      expect(state.sandboxConnectCalls).toEqual([]);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("inference.local is still unavailable");
      expect(combined).toContain("Connect is stopping because the sandbox inference route is known to be broken");
    },
  );

  it(
    "diagnoses host Ollama before resetting a broken ollama-local route",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "ollama-down-sandbox",
          model: "qwen3:0.6b",
          provider: "ollama-local",
          gpuEnabled: false,
          policies: [],
        },
        "ollama-local",
        "qwen3:0.6b",
        {
          curlExitCode: 7,
          curlHttpStatus: "000",
          curlStderr: "curl: (7) Failed to connect to 127.0.0.1 port 11434\n",
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
          ],
          writeOllamaProxyState: false,
        },
      );

      const result = runConnect(tmpDir, sandboxName);
      expect(result.status).toBe(1);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls).toEqual([]);
      expect(state.sandboxConnectCalls).toEqual([]);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("Local Ollama is selected for inference");
      expect(combined).toContain("Start Ollama and retry");
      expect(combined).toContain("Connect is stopping because the sandbox inference route is known to be broken");
    },
  );

  it(
    "repairs WSL ollama-local routes without requiring the auth proxy",
    testTimeoutOptions(20_000),
    () => {
      const { tmpDir, stateFile, sandboxName } = setupFixture(
        {
          name: "wsl-ollama-sandbox",
          model: "qwen3:0.6b",
          provider: "ollama-local",
          gpuEnabled: false,
          policies: [],
        },
        "ollama-local",
        "qwen3:0.6b",
        {
          inferenceProbeResponses: [
            'BROKEN 503 {"error":"upstream unavailable"}',
            'BROKEN 503 {"error":"upstream unavailable"}',
            "OK 200",
          ],
          writeOllamaProxyState: false,
        },
      );

      const wslPlatformPreload = path.join(tmpDir, "force-wsl-platform.cjs");
      fs.writeFileSync(
        wslPlatformPreload,
        'Object.defineProperty(process, "platform", { value: "linux" });\n',
        { mode: 0o600 },
      );
      const result = runConnect(tmpDir, sandboxName, {
        ALL_PROXY: "http://127.0.0.1:9",
        HTTP_PROXY: "http://127.0.0.1:9",
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${wslPlatformPreload}`.trim(),
        NO_PROXY: "",
        OPENSHELL_TEST_FAIL_LOCALHOST_OLLAMA: "1",
        WSL_DISTRO_NAME: "Ubuntu",
        no_proxy: "",
      });
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      const curlCalls = state.curlCalls as string[][];
      const curlEnvs = state.curlEnvs as Record<string, string>[];
      const windowsHostIndexes = curlCalls
        .map((call, index) => (call.join(" ").includes("host.docker.internal:11434") ? index : -1))
        .filter((index) => index >= 0);
      expect(state.inferenceSetCalls).toEqual([
        [
          "--provider",
          "ollama-local",
          "--model",
          "qwen3:0.6b",
          "--no-verify",
          "--timeout",
          "180",
        ],
      ]);
      expect(windowsHostIndexes.length).toBeGreaterThan(0);
      for (const index of windowsHostIndexes) {
        const proxyBypass = `${curlEnvs[index]?.NO_PROXY || ""},${curlEnvs[index]?.no_proxy || ""}`;
        expect(proxyBypass).toContain("host.docker.internal");
        expect(curlEnvs[index]?.ALL_PROXY || "").toBe("");
      }
      expect(state.sandboxConnectCalls).toEqual([["sandbox", "connect", sandboxName]]);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("Resetting inference route to ollama-local/qwen3:0.6b");
      expect(combined).toContain("inference.local route repaired");
      expect(combined).not.toContain("Ollama auth proxy token is missing");
    },
  );
});
