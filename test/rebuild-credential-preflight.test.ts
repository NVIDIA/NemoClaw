// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin real-process contracts for atomic rebuild (#2273).
 *
 * Rebuild decision branches live in the direct rebuild-flow and focused source
 * suites. This file intentionally retains only behavior whose contract crosses
 * a process boundary: interactive stdin/exit, DCode liveness after a failed
 * preflight, child-environment secret handling, and the CLI exit status.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execTimeout, testTimeout } from "./helpers/timeouts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const NODE_BIN = path.dirname(process.execPath);
const tmpFixtures: string[] = [];

afterEach(() => {
  for (const dir of tmpFixtures.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function createFixture(opts: {
  agent?: string | null;
  provider?: string;
  credentialEnv?: string;
  savedCredential?: { key: string; value: string };
  hermesAuthMethod?: string | null;
  providerRegistered?: boolean;
  sandboxDeleteExitCode?: number;
  activeSessionCount?: number | null;
  inferenceProbeHttpStatus?: number | null;
}) {
  const {
    agent = null,
    provider = "nvidia-prod",
    credentialEnv = "NVIDIA_INFERENCE_API_KEY",
    savedCredential,
    hermesAuthMethod = null,
    providerRegistered = true,
    sandboxDeleteExitCode = 0,
    activeSessionCount = 0,
    inferenceProbeHttpStatus = null,
  } = opts;
  const sandboxName = "my-assistant";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-2273-"));
  tmpFixtures.push(tmpDir);
  const nemoclawDir = path.join(tmpDir, ".nemoclaw");
  fs.mkdirSync(nemoclawDir, { recursive: true, mode: 0o700 });

  fs.writeFileSync(
    path.join(nemoclawDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "meta/llama-3.3-70b-instruct",
          provider,
          gpuEnabled: false,
          sandboxGpuMode: "0",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          dashboardPort: agent === "langchain-deepagents-code" ? 0 : 18789,
          fromDockerfile: null,
          policies: [],
          agent,
          hermesAuthMethod,
          ...(agent === "langchain-deepagents-code"
            ? {
                credentialEnv,
                preferredInferenceApi: "openai-completions",
                endpointUrl: "https://inference-api.nvidia.com/v1",
                nemoclawVersion: "0.0.72",
              }
            : {}),
        },
      },
    }),
    { mode: 0o600 },
  );

  fs.writeFileSync(
    path.join(nemoclawDir, "onboard-session.json"),
    JSON.stringify({
      version: 1,
      sessionId: "s",
      resumable: true,
      status: "complete",
      mode: "interactive",
      startedAt: "2026-01-01",
      updatedAt: "2026-01-01",
      lastStepStarted: null,
      lastCompletedStep: "policies",
      failure: null,
      agent: null,
      sandboxName,
      provider,
      model: "meta/llama-3.3-70b-instruct",
      endpointUrl: null,
      credentialEnv,
      hermesAuthMethod,
      preferredInferenceApi: null,
      nimContainer: null,
      webSearchConfig: null,
      policyPresets: [],
      messagingPlan: null,
      metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
      steps: {
        preflight: { status: "complete", startedAt: null, completedAt: null, error: null },
        gateway: { status: "complete", startedAt: null, completedAt: null, error: null },
        sandbox: { status: "complete", startedAt: null, completedAt: null, error: null },
        provider_selection: {
          status: "complete",
          startedAt: null,
          completedAt: null,
          error: null,
        },
        inference: { status: "complete", startedAt: null, completedAt: null, error: null },
        openclaw: { status: "complete", startedAt: null, completedAt: null, error: null },
        agent_setup: { status: "pending", startedAt: null, completedAt: null, error: null },
        policies: { status: "complete", startedAt: null, completedAt: null, error: null },
      },
    }),
    { mode: 0o600 },
  );

  if (savedCredential) {
    fs.writeFileSync(
      path.join(nemoclawDir, "credentials.json"),
      JSON.stringify({ [savedCredential.key]: savedCredential.value }),
      { mode: 0o600 },
    );
  }

  const fakeRoot = path.join(tmpDir, "fake-sandbox-root");
  const workspaceDir = path.join(fakeRoot, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "marker.txt"), "test-workspace");
  const deleteMarker = path.join(tmpDir, "sandbox-delete-invoked");
  const atomicityMarker = path.join(fakeRoot, "rebuild-atomicity-marker.txt");
  fs.writeFileSync(atomicityMarker, "dcode-atomicity-marker\n");

  const sshConfig = [
    `Host openshell-${sandboxName}`,
    "  HostName 127.0.0.1",
    "  Port 2222",
    "  User sandbox",
    "  StrictHostKeyChecking no",
    "  UserKnownHostsFile /dev/null",
  ].join("\\n");
  const hermesProviderStatePath = path.join(tmpDir, "hermes-provider-credential-key");
  fs.writeFileSync(
    path.join(tmpDir, "openshell"),
    `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
const hermesProviderStatePath = ${JSON.stringify(hermesProviderStatePath)};
const requiredFeatures = "request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods";
if (a[0] === "-V" || a[0] === "--version") { process.stdout.write("openshell 0.0.85\\n"); process.exit(0); }
if (a[0] === "sandbox" && a[1] === "list") { process.stdout.write("${sandboxName} Ready\\n"); process.exit(0); }
if (a[0] === "sandbox" && a[1] === "ssh-config") { process.stdout.write("${sshConfig}\\n"); process.exit(0); }
if (a[0] === "sandbox" && a[1] === "delete") { fs.writeFileSync(${JSON.stringify(deleteMarker)}, "deleted\\n"); process.exit(${sandboxDeleteExitCode}); }
if (a[0] === "sandbox" && a[1] === "exec") {
  const command = a.join(" ");
  if (command.includes("rebuild-atomicity-marker.txt")) {
    process.stdout.write(fs.readFileSync(${JSON.stringify(atomicityMarker)}, "utf-8"));
    process.exit(0);
  }
  if (command.includes("https://inference.local/")) {
    const probeStatus = ${String(inferenceProbeHttpStatus ?? 200)};
    process.stdout.write("__NEMOCLAW_SANDBOX_EXEC_STARTED__\\n" + probeStatus + "\\n");
    if (probeStatus >= 200 && probeStatus < 300) process.exit(0);
    process.stderr.write("upstream rejected stored provider credential\\n");
    process.exit(1);
  }
  process.exit(0);
}
if (a[0] === "status") { process.stdout.write("Server Status\\n  Gateway: nemoclaw\\n  Status: Connected\\n"); process.exit(0); }
if (a[0] === "gateway" && a[1] === "info") { process.stdout.write("Gateway Info\\n\\nGateway: nemoclaw\\n"); process.exit(0); }
if (a[0] === "gateway" && a[1] === "select") process.exit(0);
if (a[0] === "inference" && a[1] === "get") { process.stdout.write("Gateway inference:\\n  Provider: ${provider}\\n  Model: meta/llama-3.3-70b-instruct\\n"); process.exit(0); }
if (a[0] === "inference" && a[1] === "set") process.exit(0);
if (a[0] === "provider" && a[1] === "get") {
  const providerName = a[2];
  const persistedHermes = providerName === "hermes-provider" && fs.existsSync(hermesProviderStatePath);
  const exists = persistedHermes || ${providerRegistered ? "true" : "false"};
  if (!exists) process.exit(1);
  if (providerName === "hermes-provider") {
    const credentialKey = persistedHermes
      ? fs.readFileSync(hermesProviderStatePath, "utf8").trim()
      : ${JSON.stringify(hermesAuthMethod === "api_key" ? "NOUS_API_KEY" : "OPENAI_API_KEY")};
    process.stdout.write("Provider:\\n  Name: hermes-provider\\n  Credential keys: " + credentialKey + "\\n");
  }
  process.exit(0);
}
if (a[0] === "provider" && (a[1] === "create" || a[1] === "update")) {
  const nameIndex = a.indexOf("--name");
  const providerName = a[1] === "create" ? a[nameIndex + 1] : a[2];
  const credentialIndex = a.indexOf("--credential");
  if (providerName === "hermes-provider" && credentialIndex >= 0) {
    fs.writeFileSync(hermesProviderStatePath, a[credentialIndex + 1]);
  }
  process.exit(0);
}
if (a[0] === "provider") process.exit(0);
if (a[0] === "forward" && a[1] === "list") { process.stdout.write("SANDBOX BIND PORT PID STATUS\\n${sandboxName} 127.0.0.1 18789 4242 running\\n"); process.exit(0); }
if (a[0] === "forward") process.exit(0);
process.exit(0);
`,
    { mode: 0o755 },
  );

  for (const component of ["openshell-gateway", "openshell-sandbox"]) {
    fs.writeFileSync(
      path.join(tmpDir, component),
      `#!/usr/bin/env node
const requiredFeatures = "request-body-credential-rewrite websocket-credential-rewrite allow_all_known_mcp_methods";
if (process.argv[2] === "-V" || process.argv[2] === "--version") process.stdout.write("${component} 0.0.85\\n");
process.exit(0);
`,
      { mode: 0o755 },
    );
  }

  const activeSessionLines = Array.from(
    { length: activeSessionCount ?? 0 },
    (_, index) => `${9000 + index} ssh openshell-${sandboxName}`,
  ).join("\n");
  fs.writeFileSync(
    path.join(tmpDir, "ps"),
    `#!/usr/bin/env node
if (${activeSessionCount === null ? "true" : "false"}) process.exit(1);
process.stdout.write(${JSON.stringify(activeSessionLines)} + (${JSON.stringify(activeSessionLines)} ? "\\n" : ""));
process.exit(0);
`,
    { mode: 0o755 },
  );

  fs.writeFileSync(
    path.join(tmpDir, "docker"),
    `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "info") { process.stdout.write(JSON.stringify({ServerVersion:"27.0.0", OperatingSystem:"Docker Engine", NCPU:8, MemTotal:17179869184}) + "\\n"); process.exit(0); }
if (a[0] === "build") process.exit(0);
if (a[0] === "image" && a[1] === "inspect") {
  const formatIndex = a.indexOf("--format");
  const format = formatIndex >= 0 ? a[formatIndex + 1] : "";
  if (format === "{{.Id}}") process.stdout.write("sha256:${"a".repeat(64)}\\n");
  if (format === "{{json .RepoDigests}}") process.stdout.write("[]\\n");
  process.exit(0);
}
if (a[0] === "tag" || a[0] === "rmi") process.exit(0);
if (a[0] === "run") {
  if (a.includes("nslookup")) process.stdout.write("Server: 127.0.0.11\\n** server can't find nemoclaw.invalid: NXDOMAIN\\n");
  else if (a.includes("/usr/bin/ldd")) process.stdout.write("ldd (GNU libc) 2.41\\n");
  else process.stdout.write("nemoclaw-hermes-mcp-runtime-ok\\n");
  process.exit(0);
}
if (a[0] === "inspect") { process.stdout.write("true\\n"); process.exit(0); }
if (a[0] === "ps") process.exit(0);
process.stderr.write("unexpected docker call: " + a.join(" ") + "\\n");
process.exit(1);
`,
    { mode: 0o755 },
  );

  fs.writeFileSync(
    path.join(tmpDir, "ssh"),
    `#!/usr/bin/env node
const { spawnSync } = require("child_process");
const cmd = process.argv[process.argv.length - 1] || "";
if (cmd.includes("[ -d")) { process.stdout.write("workspace\\n"); process.exit(0); }
if (cmd.includes("tar")) {
  const result = spawnSync("tar", ["-cf", "-", "-C", ${JSON.stringify(fakeRoot)}, "workspace"], { stdio: ["ignore", "pipe", "pipe"] });
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.status || 0);
}
process.exit(0);
`,
    { mode: 0o755 },
  );

  return { tmpDir, nemoclawDir, sandboxName, deleteMarker };
}

function runCli(
  fixture: ReturnType<typeof createFixture>,
  args: string[],
  extraEnv: Record<string, string> = {},
  input?: string,
) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "nemoclaw.js"), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    input,
    env: {
      HOME: fixture.tmpDir,
      PATH: fixture.tmpDir + ":" + NODE_BIN + ":/usr/bin:/bin",
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      NEMOCLAW_SKIP_HOST_DNS_PREFLIGHT: "1",
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_NO_CONNECT_HINT: "1",
      NO_COLOR: "1",
      ...extraEnv,
    },
    timeout: execTimeout(60_000),
  });
}

function runRebuild(
  fixture: ReturnType<typeof createFixture>,
  extraEnv: Record<string, string> = {},
  options: { yes?: boolean; input?: string } = {},
) {
  const args = [fixture.sandboxName, "rebuild"];
  if (options.yes !== false) args.push("--yes");
  return runCli(fixture, args, extraEnv, options.input);
}

function registryHasSandbox(fixture: ReturnType<typeof createFixture>): boolean {
  const registryPath = path.join(fixture.nemoclawDir, "sandboxes.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
  return Boolean(registry.sandboxes?.[fixture.sandboxName]);
}

describe("atomic rebuild process contracts (#2273)", () => {
  it("cancels interactive rebuild through stdin without entering preflight or backup", () => {
    const fixture = createFixture({ providerRegistered: false });

    const result = runRebuild(fixture, {}, { yes: false, input: "n\n" });
    const output = `${result.stderr || ""}${result.stdout || ""}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("Proceed? [y/N]:");
    expect(output).toContain("Cancelled.");
    expect(output).not.toContain("preflight failed");
    expect(output).not.toContain("Backing up sandbox state");
    expect(registryHasSandbox(fixture)).toBe(true);
  });

  it("accepts trimmed case-insensitive yes input before continuing into backup", () => {
    const fixture = createFixture({
      savedCredential: {
        key: "NVIDIA_INFERENCE_API_KEY",
        value: "nvapi-test-key-for-rebuild",
      },
    });

    const result = runRebuild(fixture, {}, { yes: false, input: " YES \n" });
    const output = `${result.stderr || ""}${result.stdout || ""}`;

    expect(output).toContain("Proceed? [y/N]:");
    expect(output).not.toContain("Cancelled.");
    expect(output).not.toContain("preflight failed");
    expect(output).toContain("Backing up sandbox state");
  });

  it("prints an active SSH session warning before interactive confirmation and cancel", () => {
    const fixture = createFixture({
      activeSessionCount: 2,
      savedCredential: {
        key: "NVIDIA_INFERENCE_API_KEY",
        value: "nvapi-test-key-for-rebuild",
      },
    });

    const result = runRebuild(fixture, {}, { yes: false, input: "n\n" });
    const output = `${result.stderr || ""}${result.stdout || ""}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("Active SSH sessions detected (2 connections)");
    expect(output).toContain("terminate all active sessions with a Broken pipe error");
    expect(output).toContain("Proceed? [y/N]:");
    expect(output).toContain("Cancelled.");
    expect(output).not.toContain("Backing up sandbox state");
  });

  it("keeps a Ready DCode sandbox usable when its stored route returns 401 (#6195)", () => {
    const fixture = createFixture({
      agent: "langchain-deepagents-code",
      provider: "compatible-endpoint",
      credentialEnv: "COMPATIBLE_API_KEY",
      providerRegistered: true,
      inferenceProbeHttpStatus: 401,
    });

    const result = runRebuild(fixture, {
      NEMOCLAW_PROVIDER_KEY: "obviously-invalid-ambient-credential",
    });
    const output = `${result.stderr || ""}${result.stdout || ""}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("HTTP 401");
    expect(output).toContain("Sandbox is untouched");
    expect(output).not.toContain("Backing up sandbox state");
    expect(output).not.toContain("Deleting old sandbox");
    expect(output).not.toContain("Creating new sandbox with current image");
    expect(fs.existsSync(fixture.deleteMarker)).toBe(false);
    expect(registryHasSandbox(fixture)).toBe(true);

    const marker = runCli(fixture, [
      fixture.sandboxName,
      "exec",
      "--",
      "cat",
      "/sandbox/rebuild-atomicity-marker.txt",
    ]);
    expect(marker.status, marker.stderr).toBe(0);
    expect(marker.stdout).toContain("dcode-atomicity-marker");
  });

  it("registers an exported Hermes API key without exposing its name or value", {
    timeout: testTimeout(60_000),
  }, () => {
    const fixture = createFixture({
      agent: "hermes",
      provider: "hermes-provider",
      credentialEnv: "NOUS_API_KEY",
      hermesAuthMethod: "api_key",
      providerRegistered: false,
      sandboxDeleteExitCode: 1,
    });

    const result = runRebuild(fixture, { NOUS_API_KEY: "nous-key-from-env" });
    const output = `${result.stderr || ""}${result.stdout || ""}`;

    expect(output).toContain(
      "Hermes Provider is not registered in OpenShell; registering it from the configured exported API-key environment variable before rebuild.",
    );
    expect(output).not.toContain("NOUS_API_KEY");
    expect(output).not.toContain("nous-key-from-env");
    expect(output).toContain("Backing up sandbox state");
    expect(output).toContain("State backed up");
  });

  it("returns a nonzero CLI status when credential preflight fails", () => {
    const fixture = createFixture({ providerRegistered: false });

    const result = runRebuild(fixture);

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(fixture.deleteMarker)).toBe(false);
    expect(registryHasSandbox(fixture)).toBe(true);
  });
});
