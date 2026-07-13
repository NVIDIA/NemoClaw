// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  runWithEnv,
  testTimeoutOptions,
  writeHealthyDockerStub,
  writeSandboxRegistry,
} from "./helpers";

function createInferenceRouteStatusSetup(options: {
  executeRouteCommand?: boolean;
  routeOutput: string;
  routeExit?: number;
  upstreamHttpStatus?: string;
  upstreamExit?: number;
}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-route-"));
  const localBin = path.join(home, "bin");
  const sandboxName = `route-${process.pid}-${Date.now()}`;
  fs.mkdirSync(localBin, { recursive: true });
  writeSandboxRegistry(home, sandboxName, {
    model: "nvidia/nemotron",
    provider: "nvidia-prod",
    openshellDriver: "docker",
  });
  fs.writeFileSync(
    path.join(localBin, "docker"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "info" ]; then echo "Server: docker"; exit 0; fi',
      `if [ "$1" = "ps" ]; then echo "openshell-cluster-nemoclaw"; echo "openshell-${sandboxName}-7616dcb1"; exit 0; fi`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(localBin, "curl"),
    [
      "#!/usr/bin/env bash",
      'out=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -o) out="$2"; shift 2 ;;',
      "    -w|--connect-timeout|--max-time) shift 2 ;;",
      "    *) shift ;;",
      "  esac",
      "done",
      'if [ -n "$out" ]; then printf "{}" > "$out"; fi',
      `printf ${JSON.stringify(options.upstreamHttpStatus ?? "200")}`,
      `exit ${String(options.upstreamExit ?? 0)}`,
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(localBin, "openshell"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "sandbox" ] && [ "$2" = "get" ]; then',
      `  echo 'Name: ${sandboxName}'`,
      "  echo 'Phase: Ready'",
      "  exit 0",
      "fi",
      'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
      ...(options.executeRouteCommand
        ? [
            '  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
            '  [ "$#" -gt 0 ] && shift',
            '  exec "$@"',
          ]
        : [
            `  printf '%s\\n' ${JSON.stringify(options.routeOutput)}`,
            `  exit ${String(options.routeExit ?? 0)}`,
          ]),
      "fi",
      'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
      "  echo 'Provider: nvidia-prod'",
      "  echo 'Model: nvidia/nemotron'",
      "  exit 0",
      "fi",
      'if [ "$1" = "status" ]; then',
      "  echo 'Gateway: nemoclaw'",
      "  echo 'Status: Connected'",
      "  exit 0",
      "fi",
      'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
      "  echo 'Gateway: nemoclaw'",
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { home, localBin, sandboxName };
}

describe("CLI sandbox status JSON output", testTimeoutOptions(20_000), () => {
  it("sandbox status --json emits structured per-sandbox report", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-"));
    const localBin = path.join(home, "bin");
    const sandboxName = `alpha-${process.pid}-${Date.now()}`;
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, sandboxName, {
      model: "configured-model",
      provider: "configured-provider",
      gpuEnabled: true,
      policies: ["npm"],
      hostGpuDetected: true,
      sandboxGpuEnabled: true,
      sandboxGpuMode: "passthrough",
      sandboxGpuDevice: "0",
      openshellDriver: "docker",
      openshellVersion: "0.0.44",
    });
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "info" ]; then echo "Server: docker"; exit 0; fi',
        `if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then echo "openshell-cluster-nemoclaw"; echo "openshell-${sandboxName}-7616dcb1"; exit 0; fi`,
        `if [ "$1" = "ps" ]; then echo "openshell-cluster-nemoclaw"; echo "openshell-${sandboxName}-7616dcb1"; exit 0; fi`,
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo",
        "  echo '  Provider: nvidia-prod'",
        "  echo '  Model: nvidia/nemotron'",
        "  exit 0",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  echo 'Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
        "  echo 'OK 200'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv(`${sandboxName} status --json`, {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out.trim().startsWith("{")).toBe(true);
    expect(r.out.trim().endsWith("}")).toBe(true);
    expect(r.out).not.toContain("Sandbox: ");
    expect(r.out).not.toContain("Nonexistent flag: --json");

    const parsed = JSON.parse(r.out);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      name: sandboxName,
      found: true,
      model: "nvidia/nemotron",
      provider: "nvidia-prod",
      recordedRoute: { provider: "configured-provider", model: "configured-model" },
      liveRoute: { provider: "nvidia-prod", model: "nvidia/nemotron" },
      routeDrift: {
        live: { provider: "nvidia-prod", model: "nvidia/nemotron" },
        recorded: { provider: "configured-provider", model: "configured-model" },
        canConnect: true,
      },
      hostGpuDetected: true,
      sandboxGpuEnabled: true,
      sandboxGpuMode: "passthrough",
      sandboxGpuDevice: "0",
      openshellDriver: "docker",
      openshellVersion: "0.0.44",
      policies: ["npm"],
      rpcIssue: null,
    });
    expect(typeof parsed.openshellDriver).toBe("string");
    expect(typeof parsed.openshellVersion).toBe("string");
    expect(parsed).toHaveProperty("phase");
    expect(parsed).toHaveProperty("inferenceHealth");
    expect(parsed).toHaveProperty("gatewayState");
  });

  it.each([
    {
      name: "transport failure",
      routeOutput: "BROKEN 000",
      expectedFailure: "unreachable",
      expectedProbed: true,
    },
    {
      name: "HTTP 503",
      routeOutput: "BROKEN 503 service unavailable",
      expectedFailure: "unhealthy",
      expectedProbed: true,
    },
    {
      name: "HTTP 199 interim response",
      routeOutput: "BROKEN 199",
      expectedFailure: "unreachable",
      expectedProbed: true,
    },
    {
      name: "unavailable probe",
      routeOutput: "",
      routeExit: 1,
      expectedFailure: undefined,
      expectedProbed: false,
    },
  ])("sandbox status --json fails for $name on inference.local (#6192)", (testCase) => {
    const { home, localBin, sandboxName } = createInferenceRouteStatusSetup(testCase);

    const result = runWithEnv(`${sandboxName} status --json`, {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.out);
    expect(parsed.inferenceHealth).toMatchObject({
      ok: false,
      probed: testCase.expectedProbed,
      endpoint: "https://inference.local/v1/models",
      ...(testCase.expectedFailure ? { failureLabel: testCase.expectedFailure } : {}),
    });
    expect(parsed.inferenceHealth.subprobes).toEqual([
      expect.objectContaining({ ok: true, probeLabel: "upstream" }),
    ]);
  });

  it("sandbox status --json ignores failed upstream diagnostics when inference.local is healthy (#6192)", () => {
    const { home, localBin, sandboxName } = createInferenceRouteStatusSetup({
      routeOutput: "OK 200",
      upstreamHttpStatus: "000",
      upstreamExit: 7,
    });

    const result = runWithEnv(`${sandboxName} status --json`, {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out);
    expect(parsed.inferenceHealth).toMatchObject({
      ok: true,
      probed: true,
      endpoint: "https://inference.local/v1/models",
    });
    expect(parsed.inferenceHealth.subprobes).toEqual([
      expect.objectContaining({ ok: false, probeLabel: "upstream" }),
    ]);
  });

  it.each([
    401, 403,
  ])("sandbox status --json treats an inference.local HTTP %s as healthy (#6192)", (httpStatus) => {
    const { home, localBin, sandboxName } = createInferenceRouteStatusSetup({
      routeOutput: `OK ${httpStatus}`,
    });

    const result = runWithEnv(`${sandboxName} status --json`, {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out);
    expect(parsed.inferenceHealth).toMatchObject({
      ok: true,
      probed: true,
      endpoint: "https://inference.local/v1/models",
    });
    expect(parsed.inferenceHealth).not.toHaveProperty("failureLabel");
  });

  it("sandbox status --json fails closed when the injected CA bundle is missing (#6192)", () => {
    const { home, localBin, sandboxName } = createInferenceRouteStatusSetup({
      executeRouteCommand: true,
      routeOutput: "",
    });

    const result = runWithEnv(`${sandboxName} status --json`, {
      CURL_CA_BUNDLE: path.join(home, "missing-openshell-ca.pem"),
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
      SSL_CERT_FILE: "",
    });

    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.out);
    expect(parsed.inferenceHealth).toMatchObject({
      ok: false,
      probed: false,
      endpoint: "https://inference.local/v1/models",
    });
    expect(parsed.inferenceHealth).not.toHaveProperty("failureLabel");
  });

  it("sandbox status --json defaults openshell driver/version to 'unknown' strings", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-unknown-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
        "  echo 'OK 200'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    const parsed = JSON.parse(r.out);
    expect(r.code).toBe(0);
    expect(parsed.openshellDriver).toBe("unknown");
    expect(parsed.openshellVersion).toBe("unknown");
    expect(typeof parsed.openshellDriver).toBe("string");
    expect(typeof parsed.openshellVersion).toBe("string");
  });

  it("sandbox status --json surfaces rpcIssue and exits 1 on protobuf mismatch", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-rpc-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'protobuf decode: invalid wire type'",
        "  exit 0",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  echo 'Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out);
    expect(parsed.rpcIssue).toEqual({ kind: "protobuf_mismatch" });
    expect(parsed.inferenceHealth).toBeNull();
    expect(parsed.model).toBe("test-model");
    expect(parsed.provider).toBe("nvidia-prod");
  });

  it("sandbox status --json reports found:false and exits 1 for unknown sandbox via canonical form", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-notfound-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    // Registry contains "alpha"; we will query a different name so the
    // canonical `sandbox status <name> --json` path produces the documented
    // automation contract: `found: false`, gatewayState != present, exit 1.
    writeSandboxRegistry(home, "alpha");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ]; then',
        "  echo 'NotFound: sandbox not found'",
        "  exit 1",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  echo 'Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("sandbox status ghost --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out);
    expect(parsed.name).toBe("ghost");
    expect(parsed.found).toBe(false);
    expect(parsed.gatewayState).not.toBe("present");
    expect(parsed.rpcIssue).toBeNull();
    expect(parsed.model).toBe("unknown");
    expect(parsed.provider).toBe("unknown");
    expect(parsed.openshellDriver).toBe("unknown");
    expect(parsed.openshellVersion).toBe("unknown");
  });

  it("sandbox status --json reports gatewayState!=present and exits 1 when sandbox is registered but gateway lookup is missing", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-nonpresent-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha", {
      model: "configured-model",
      provider: "configured-provider",
    });
    // openshell `sandbox get alpha` returns NotFound -> gatewayState becomes
    // "missing" after reconciliation against a healthy named gateway.
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ]; then',
        "  echo 'NotFound: sandbox not found'",
        "  exit 1",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  echo 'Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out);
    expect(parsed.name).toBe("alpha");
    expect(parsed.found).toBe(true);
    expect(parsed.gatewayState).not.toBe("present");
    expect(parsed.rpcIssue).toBeNull();
    // Live inference probe is not attempted when gateway is not present, so
    // the report falls back to registry model/provider rather than "unknown".
    expect(parsed.model).toBe("configured-model");
    expect(parsed.provider).toBe("configured-provider");
    expect(parsed.inferenceHealth).toBeNull();
  });

  it("sandbox status --json sets failureLayer=docker_unreachable, suppresses inferenceHealth, and exits 1 when the host Docker daemon is unreachable", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-docker-unreachable-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha", {
      provider: "openai-api",
      model: "gpt-4o-mini",
      openshellDriver: "docker",
    });

    fs.writeFileSync(path.join(localBin, "docker"), ["#!/usr/bin/env bash", "exit 1"].join("\n"), {
      mode: 0o755,
    });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo '  Provider: openai-api'",
        "  echo '  Model: gpt-4o-mini'",
        "  exit 0",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  echo 'Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out);
    expect(parsed.failureLayer).toBe("docker_unreachable");
    expect(parsed.inferenceHealth).toBeNull();
    expect(parsed.name).toBe("alpha");
    expect(parsed.found).toBe(true);
  });

  it("sandbox status --json sets failureLayer=sandbox_container_stopped when the per-sandbox container is stopped", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-container-stopped-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha", {
      provider: "openai-api",
      model: "gpt-4o-mini",
      openshellDriver: "docker",
    });

    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "info" ]; then echo "Server: docker"; exit 0; fi',
        'if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then echo "openshell-alpha-7616dcb1"; exit 0; fi',
        'if [ "$1" = "ps" ]; then echo "openshell-cluster-nemoclaw"; exit 0; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo '  Name: alpha'",
        "  echo '  Phase: Error'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo '  Provider: openai-api'",
        "  echo '  Model: gpt-4o-mini'",
        "  exit 0",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  echo 'Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out);
    expect(parsed.failureLayer).toBe("sandbox_container_stopped");
    expect(parsed.phase).toBe("Error");
    expect(parsed.inferenceHealth).toBeNull();
  });

  it("sandbox status --json reports terminal runtime OOM degradation and exits 1 (#5796)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-json-dcode-oom-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha", {
      agent: "langchain-deepagents-code",
      provider: "openai-api",
      model: "gpt-4o-mini",
      openshellDriver: "docker",
    });
    writeHealthyDockerStub(localBin);
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo '  Name: alpha'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
        "  echo 'oom_kill=3'",
        "  echo 'source=/sys/fs/cgroup/memory.oom_control'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo '  Provider: openai-api'",
        "  echo '  Model: gpt-4o-mini'",
        "  exit 0",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  echo 'Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out);
    expect(parsed.phase).toBe("Ready");
    expect(parsed.agentRuntime).toBe("terminal");
    expect(parsed.terminalRuntimeHealth).toEqual({
      kind: "degraded",
      oomKillCount: 3,
      source: "/sys/fs/cgroup/memory.oom_control",
    });
  });

  it("sandbox status --json sets failureLayer=sandbox_dashboard_port_conflict when the dashboard port is held by a foreign listener", async () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-port-conflict-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });

    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("failed to bind foreign listener on a free port");
    }
    const dashboardPort = address.port;

    try {
      writeSandboxRegistry(home, "alpha", {
        provider: "openai-api",
        model: "gpt-4o-mini",
        openshellDriver: "docker",
        dashboardPort,
      });

      fs.writeFileSync(
        path.join(localBin, "docker"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "info" ]; then echo "Server: docker"; exit 0; fi',
          'if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then echo "openshell-alpha-7616dcb1"; exit 0; fi',
          'if [ "$1" = "ps" ]; then echo "openshell-cluster-nemoclaw"; exit 0; fi',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Sandbox:'",
          "  echo '  Name: alpha'",
          "  echo '  Phase: Error'",
          "  exit 0",
          "fi",
          'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
          "  echo 'Gateway inference:'",
          "  echo '  Provider: openai-api'",
          "  echo '  Model: gpt-4o-mini'",
          "  exit 0",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Gateway: nemoclaw'",
          "  echo 'Status: Connected'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
          "  echo 'Gateway: nemoclaw'",
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv("alpha status --json", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code).toBe(1);
      const parsed = JSON.parse(r.out);
      expect(parsed.failureLayer).toBe("sandbox_dashboard_port_conflict");
      expect(parsed.phase).toBe("Error");
      expect(parsed.inferenceHealth).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("sandbox status --json sets failureLayer=null when no preflight failure applies", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-sandbox-status-json-failure-layer-null-"),
    );
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, "alpha", {
      provider: "compatible-endpoint",
      model: "gpt-4o-mini",
      openshellDriver: "vm",
    });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo '  Provider: compatible-endpoint'",
        "  echo '  Model: gpt-4o-mini'",
        "  exit 0",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  echo 'Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    const parsed = JSON.parse(r.out);
    expect(parsed.failureLayer).toBeNull();
  });
});
