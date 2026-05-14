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
  inferenceProbeResponses?: string[];
  inferenceSetStatus?: number;
};

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
      inferenceProbeResponses: options.inferenceProbeResponses ?? ["OK 200"],
      inferenceSetCalls: [],
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
  fs.writeFileSync(stateFile, JSON.stringify(state));
  process.stdout.write(response);
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "connect") {
  // Don't actually drop into a shell — just exit successfully
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

function runConnect(tmpDir: string, sandboxName: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const repoRoot = path.join(import.meta.dirname, "..");
  return spawnSync(
    process.execPath,
    [path.join(repoRoot, "bin", "nemoclaw.js"), sandboxName, "connect"],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${path.join(tmpDir, ".local", "bin")}:/usr/bin:/bin`,
        NEMOCLAW_NO_CONNECT_HINT: "1",
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
          ],
        },
      );

      const result = runConnect(tmpDir, sandboxName, {
        NEMOCLAW_FORCE_VM_DNS_MONKEYPATCH: "1",
      });
      expect(result.status).toBe(0);

      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      expect(state.inferenceSetCalls.length).toBe(1);
      expect(state.dockerCalls.length).toBe(0);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("OpenShell VM DNS monkeypatch did not apply");
      expect(combined).toContain("Reapplying OpenShell inference route");
      expect(combined).toContain("OpenShell vm gateway path");
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
});
