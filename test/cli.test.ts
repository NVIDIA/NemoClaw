// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CLI,
  HERMES_CLI,
  OPENCLAW_EXPECTED_VERSION,
  createCloudflaredServiceDir,
  createDoctorTestSetup,
  execTimeout,
  isCliErrorCandidate,
  readBufferOrStringProperty,
  readCliErrorOutput,
  run,
  runWithEnv,
  testTimeout,
  testTimeoutOptions,
  writeHealthyDockerStub,
  writeRecordingCommand,
  writeSandboxRegistry,
} from "./cli/helpers";

describe("CLI dispatch", () => {
  it("config get validates flags and values before dispatch", async () => {
    const sandboxConfigModule = await import("../dist/lib/sandbox/config.js");
    const { parseConfigGetArgs } = (sandboxConfigModule.default ?? sandboxConfigModule) as {
      parseConfigGetArgs: (
        args: string[],
      ) =>
        | { ok: true; opts: { key: string | null; format: string } }
        | { ok: false; errors: string[] };
    };

    const missingKey = parseConfigGetArgs(["--key"]);
    expect(missingKey.ok).toBe(false);
    expect(missingKey).toEqual(
      expect.objectContaining({
        errors: expect.arrayContaining([expect.stringContaining("--key requires a value")]),
      }),
    );

    const missingFormat = parseConfigGetArgs(["--format"]);
    expect(missingFormat.ok).toBe(false);
    expect(missingFormat).toEqual(
      expect.objectContaining({
        errors: expect.arrayContaining([expect.stringContaining("--format requires a value")]),
      }),
    );

    const badFormat = parseConfigGetArgs(["--format", "xml"]);
    expect(badFormat.ok).toBe(false);
    expect(badFormat).toEqual(
      expect.objectContaining({
        errors: expect.arrayContaining([expect.stringContaining("Unknown format: xml")]),
      }),
    );

    const unknownFlag = parseConfigGetArgs(["--bogus"]);
    expect(unknownFlag.ok).toBe(false);
    expect(unknownFlag).toEqual(
      expect.objectContaining({
        errors: expect.arrayContaining([expect.stringContaining("Unknown flag: --bogus")]),
      }),
    );

    expect(parseConfigGetArgs(["--key", "gateway.auth", "--format", "yaml"])).toEqual({
      ok: true,
      opts: { key: "gateway.auth", format: "yaml" },
    });
  });

  it("help exits 0 and shows sections", () => {
    const r = run("help");
    expect(r.code).toBe(0);
    expect(r.out.includes("Getting Started")).toBeTruthy();
    expect(r.out.includes("Sandbox Management")).toBeTruthy();
    expect(r.out.includes("Policy Presets")).toBeTruthy();
    expect(r.out.includes("Compatibility Commands")).toBeTruthy();
    expect(r.out).toContain("nemoclaw upgrade-sandboxes");
    expect(r.out).toContain("(--check, --auto, --yes|-y)");
    expect(r.out).toContain("nemoclaw update");
    expect(r.out).toContain("(--check, --yes|-y)");
    expect(r.out).toContain("nemoclaw gc");
    expect(r.out).toContain("(--yes|-y|--force, --dry-run)");
    expect(r.out).toContain("nemoclaw onboard");
    expect(r.out).toContain("Configure inference endpoint and credentials");
    expect(r.out).toContain("nemoclaw onboard --from");
    expect(r.out).toContain("Use a custom Dockerfile for the sandbox image");
  });

  it("--help exits 0", () => {
    expect(run("--help").code).toBe(0);
  });

  it("version exits 0", () => {
    const r = run("version");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^nemoclaw v/);
  });

  it("-h exits 0", () => {
    expect(run("-h").code).toBe(0);
  });

  it("no args exits 0 (shows help)", () => {
    const r = run("");
    expect(r.code).toBe(0);
    expect(r.out.includes("nemoclaw")).toBeTruthy();
  });

  it("bare unknown name surfaces sandbox-not-found (#2164)", testTimeoutOptions(35_000), () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-unknown-sandbox-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(path.join(localBin, "openshell"), "#!/usr/bin/env bash\nexit 1\n", {
      mode: 0o755,
    });

    const r = runWithEnv(
      "boguscmd",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      },
      execTimeout(30_000),
    );
    expect(r.code).toBe(1);
    expect(r.out.includes("Sandbox 'boguscmd' does not exist")).toBeTruthy();
  });

  it("unknown command with non-sandbox action exits 1", () => {
    const r = run("boguscmd boguscmd2");
    expect(r.code).toBe(1);
    expect(r.out.includes("Unknown command")).toBeTruthy();
  });

  it("points OpenShell-only commands at openshell instead of sandbox connect (#3388)", () => {
    const term = run("term");
    expect(term.code).toBe(1);
    expect(term.out).toContain("Unknown nemoclaw command: term");
    expect(term.out).toContain("Run: openshell term");
    expect(term.out).not.toContain("Try: nemoclaw <sandbox-name> connect");

    const policy = run("policy set");
    expect(policy.code).toBe(1);
    expect(policy.out).toContain("Unknown nemoclaw command: policy set");
    expect(policy.out).toContain("Run: openshell policy set --policy <policy-file> <sandbox-name>");
    expect(policy.out).toContain("nemoclaw <sandbox-name> policy-add <preset>");
    expect(policy.out).not.toContain("Try: nemoclaw <sandbox-name> connect");

    const gateway = run("gateway stop");
    expect(gateway.code).toBe(1);
    expect(gateway.out).toContain("Unknown nemoclaw command: gateway stop");
    expect(gateway.out).toContain("Run: openshell gateway stop -g nemoclaw");
    expect(gateway.out).not.toContain("Try: nemoclaw <sandbox-name> connect");
  });

  it("redirects `inference set` to openshell when provider or model is missing", () => {
    for (const argv of [
      "inference set 2>&1",
      "inference set --provider nvidia-prod 2>&1",
      "inference set --model nvidia/model 2>&1",
    ]) {
      const r = run(argv);
      expect(r.code, `nemoclaw ${argv}`).toBe(1);
      expect(r.out, `nemoclaw ${argv}`).toContain("Unknown nemoclaw command: inference set");
      expect(r.out, `nemoclaw ${argv}`).toContain("This operation belongs to OpenShell.");
      expect(r.out, `nemoclaw ${argv}`).toContain(
        "Run: openshell inference set -g nemoclaw --model <model> --provider <provider>",
      );
      expect(r.out, `nemoclaw ${argv}`).not.toContain("Missing required flag");
      expect(r.out, `nemoclaw ${argv}`).not.toContain("FailedFlagValidationError");
      expect(r.out, `nemoclaw ${argv}`).not.toContain("node_modules/@oclif/core");
    }

    let hermesOut = "";
    let hermesCode = 0;
    try {
      hermesOut = execSync(`node "${HERMES_CLI}" inference set 2>&1`, {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: execTimeout(),
        env: {
          ...process.env,
          HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-test-")),
        },
      });
    } catch (err) {
      const result = readCliErrorOutput(
        isCliErrorCandidate(err)
          ? {
              status: typeof err.status === "number" ? err.status : undefined,
              stdout: readBufferOrStringProperty(err, "stdout"),
              stderr: readBufferOrStringProperty(err, "stderr"),
            }
          : String(err),
      );
      hermesOut = result.out;
      hermesCode = result.code;
    }
    expect(hermesCode).toBe(1);
    expect(hermesOut).toContain("Unknown nemohermes command: inference set");
    expect(hermesOut).toContain("This operation belongs to OpenShell.");
    expect(hermesOut).toContain(
      "Run: openshell inference set -g nemoclaw --model <model> --provider <provider>",
    );
  });

  it("suggests list for a mistyped list command", () => {
    // Isolate from any real openshell gateway on the host so recovery
    // doesn't intercept the typo suggestion.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-typo-suggest-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      ["#!/usr/bin/env bash", "exit 1"].join("\n"),
      { mode: 0o755 },
    );

    try {
      const r = runWithEnv("liost", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
        NEMOCLAW_HEALTH_POLL_COUNT: "0",
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain("Unknown command: liost");
      expect(r.out).toContain("Did you mean: nemoclaw list?");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("recovers a live sandbox before suggesting a bare command typo", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-recover-typo-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'printf "%s\\n" "$*" >> "$HOME/openshell-calls.log"',
        'case "$*" in',
        '  "status") printf "Status: Connected\\nGateway: nemoclaw\\n"; exit 0 ;;',
        '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
        '  "sandbox list") echo "liost Ready"; exit 0 ;;',
        '  "sandbox get liost") printf "Name: liost\\nPhase: Ready\\nPolicy:\\n"; exit 0 ;;',
        '  "policy get --full liost") exit 1 ;;',
        '  "inference get") exit 1 ;;',
        '  "sandbox connect liost") echo "CONNECTED_LIOST"; exit 0 ;;',
        "  *) exit 0 ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("liost", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
      NEMOCLAW_CONNECT_TIMEOUT: "1",
      NEMOCLAW_NO_CONNECT_HINT: "1",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("CONNECTED_LIOST");
    expect(r.out).not.toContain("Unknown command: liost");
  });

  it("fails fast on gated NEMOCLAW_VLLM_MODEL without HF token before sandbox side effects", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-vllm-preflight-"));
    try {
      const localBin = path.join(home, "bin");
      fs.mkdirSync(localBin, { recursive: true });
      writeSandboxRegistry(home);
      const openshellLog = path.join(home, "openshell-calls.log");
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          `printf "%s\\n" "$*" >> ${JSON.stringify(openshellLog)}`,
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const childEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) childEnv[key] = value;
      }
      delete childEnv.HF_TOKEN;
      delete childEnv.HUGGING_FACE_HUB_TOKEN;
      childEnv.HOME = home;
      childEnv.PATH = `${localBin}:${process.env.PATH || ""}`;
      childEnv.NEMOCLAW_HEALTH_POLL_COUNT = "1";
      childEnv.NEMOCLAW_HEALTH_POLL_INTERVAL = "0";
      childEnv.NEMOCLAW_VLLM_MODEL = "deepseek-r1-distill-70b";

      let code = 0;
      let out = "";
      try {
        execSync(`node "${CLI}" alpha connect 2>&1`, {
          encoding: "utf-8",
          stdio: "pipe",
          timeout: execTimeout(),
          env: childEnv,
        });
      } catch (err) {
        const e = err as {
          status?: number;
          stdout?: string | Buffer;
          stderr?: string | Buffer;
        };
        code = typeof e.status === "number" ? e.status : 1;
        out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }

      expect(code).toBe(1);
      expect(out).toMatch(/gated on Hugging Face/);
      expect(out).toMatch(/HF_TOKEN/);
      expect(out).toMatch(/HUGGING_FACE_HUB_TOKEN/);
      expect(out).toContain(
        "NEMOCLAW_VLLM_MODEL is consumed by the managed-vLLM install path",
      );
      const calls = fs.existsSync(openshellLog) ? fs.readFileSync(openshellLog, "utf8") : "";
      expect(calls).not.toMatch(/\bsandbox\s+(get|connect|list)\b/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("explains sandbox connect command order when the sandbox name is last", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-order-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      ["#!/usr/bin/env bash", "exit 1"].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("hermes connect alpha", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("Sandbox 'hermes' does not exist");
    expect(r.out).toContain("Command order is: nemoclaw <sandbox-name> connect");
    expect(r.out).toContain("Did you mean: nemoclaw alpha connect?");
  });

  it("list exits 0", () => {
    const r = run("list");
    expect(r.code).toBe(0);
    // With empty HOME, should say no sandboxes
    expect(r.out.includes("No sandboxes")).toBeTruthy();
  });

  it("list --help exits 0 and shows list usage", () => {
    const r = run("list --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("list [--json]");
    expect(r.out).toContain("List all sandboxes");
  });

  it("nemohermes list --help uses alias branding", () => {
    const out = execSync(`node "${HERMES_CLI}" list --help`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: execTimeout(),
      env: {
        ...process.env,
        HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-test-")),
      },
    });
    expect(out).toContain("$ nemohermes list [--json]");
    expect(out).not.toContain("$ nemoclaw list [--json]");
  });

  it("nemohermes inference set --help uses alias branding and agent-aware wording", () => {
    const out = execSync(`node "${HERMES_CLI}" inference set --help`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: execTimeout(),
      env: {
        ...process.env,
        HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-test-")),
      },
    });
    expect(out).toContain("$ nemohermes inference set --provider <provider> --model <model>");
    expect(out).toContain("[--sandbox <name>] [--no-verify]");
    expect(out).toMatch(/OpenClaw or Hermes\s+sandbox config/);
  });

  it("inference set rejects empty provider values during oclif parsing", () => {
    const result = run("inference set --provider '' --model nvidia/model");
    expect(result.code).toBe(1);
    expect(result.out).toContain("Parsing --provider");
    expect(result.out).toContain("OpenShell inference provider name cannot be empty");
  });

  it("inference get reports the live NemoClaw gateway route", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-inference-get-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
        "  echo 'Gateway inference:'",
        "  echo '  Provider: nvidia-prod'",
        "  echo '  Model: nvidia/nemotron-3-super-120b-a12b'",
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const text = runWithEnv("inference get", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });
      expect(text.code).toBe(0);
      expect(text.out).toContain("Provider: nvidia-prod");
      expect(text.out).toContain("Model:    nvidia/nemotron-3-super-120b-a12b");

      const json = runWithEnv("inference get --json", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });
      expect(json.code).toBe(0);
      expect(JSON.parse(json.out)).toEqual({
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("list --json emits structured empty inventory", () => {
    const r = run("list --json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      schemaVersion: 1,
      defaultSandbox: null,
      recovery: {
        recoveredFromSession: false,
        recoveredFromGateway: 0,
      },
      lastOnboardedSandbox: null,
      sandboxes: [],
    });
  });

  it("list --json emits structured sandbox details", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-json-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "configured-model",
            provider: "configured-provider",
            gpuEnabled: true,
            policies: ["pypi"],
            agent: "openclaw",
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "ps"),
      ["#!/bin/sh", "echo '123 ssh openshell-alpha'", "exit 0"].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list --json", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      schemaVersion: 1,
      defaultSandbox: "alpha",
      recovery: {
        recoveredFromSession: false,
        recoveredFromGateway: 0,
      },
      lastOnboardedSandbox: null,
      sandboxes: [
        {
          name: "alpha",
          model: "configured-model",
          provider: "configured-provider",
          gpuEnabled: true,
          policies: ["pypi"],
          agent: "openclaw",
          isDefault: true,
          activeSessionCount: 1,
          connected: true,
          hostGpuDetected: false,
          sandboxGpuEnabled: true,
          sandboxGpuMode: null,
          sandboxGpuDevice: null,
          openshellDriver: null,
          openshellVersion: null,
        },
      ],
    });
  });

  it("list forwards oclif parse errors for unknown options", () => {
    const r = run("list --bogus");
    expect(r.code).toBe(2);
    expect(r.out.includes("Nonexistent flag: --bogus")).toBeTruthy();
    expect(r.out.includes("See more help with --help")).toBeTruthy();
  });

  it("gateway-token help uses native oclif usage", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-token-help-"));
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha gateway-token --help", { HOME: home });

    expect(r.code).toBe(0);
    expect(r.out).toContain("$ nemoclaw sandbox gateway token <name> [--quiet|-q]");
    expect(r.out).toContain("Print the OpenClaw gateway auth token");
  });

  it("doctor fails a present sandbox that is not Ready", () => {
    const setup = createDoctorTestSetup("nemoclaw-cli-doctor-not-ready-", [
      'case "$*" in',
      '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
      '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
      '  "sandbox list") printf "NAME STATUS\\nalpha Creating\\n"; exit 0 ;;',
      '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
      "esac",
    ]);

    const r = setup.runDoctor();

    expect(r.code).toBe(1);
    const report = JSON.parse(r.out) as {
      checks: Array<{ label: string; status: string; detail: string }>;
    };
    const liveSandbox = report.checks.find((check) => check.label === "Live sandbox");
    expect(liveSandbox).toEqual(
      expect.objectContaining({
        status: "fail",
        detail: expect.stringContaining("Creating"),
      }),
    );
  });

  it("doctor does not inspect the legacy k3s gateway container in Docker-driver mode", () => {
    const setup = createDoctorTestSetup("nemoclaw-cli-doctor-docker-driver-", [
      'case "$*" in',
      '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
      '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
      '  "sandbox list") printf "NAME STATUS\\nalpha Ready\\n"; exit 0 ;;',
      '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
      "esac",
    ]);
    // Docker-driver sandbox: no legacy `openshell-cluster-*` container exists.
    writeSandboxRegistry(setup.home, "alpha", { openshellDriver: "docker" });
    // Record docker argv and make `docker inspect` fail like an absent legacy
    // container would. The doctor must not even attempt the inspect, so this
    // should never produce a failure — and we assert the call was skipped, not
    // merely that its failure was tolerated.
    const dockerCalls = path.join(setup.home, "docker-calls");
    fs.writeFileSync(
      path.join(setup.localBin, "docker"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> ${JSON.stringify(dockerCalls)}`,
        'if [ "$1" = "info" ]; then echo "24.0.0"; exit 0; fi',
        'if [ "$1" = "inspect" ]; then echo "Error: No such object: $3" >&2; exit 1; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    // Healthy curl so the unrelated provider-health probe does not fail the
    // report and mask the gateway-only assertions below.
    fs.writeFileSync(
      path.join(setup.localBin, "curl"),
      ["#!/usr/bin/env bash", 'echo "{}"', "exit 0"].join("\n"),
      { mode: 0o755 },
    );

    const r = setup.runDoctor("alpha doctor --json");

    expect(r.out).not.toContain("openshell-cluster");
    const report = JSON.parse(r.out) as {
      status: string;
      checks: Array<{ group: string; label: string; status: string; detail: string }>;
    };
    expect(report.checks.find((check) => check.label === "Docker container")).toBeUndefined();
    // Core contract: the legacy k3s container inspect must be skipped entirely,
    // not attempted-and-ignored.
    const recordedDockerCalls = fs.existsSync(dockerCalls)
      ? fs.readFileSync(dockerCalls, "utf8")
      : "";
    expect(recordedDockerCalls).not.toMatch(/\binspect\b/);
    const openshellStatus = report.checks.find((check) => check.label === "OpenShell status");
    expect(openshellStatus).toEqual(
      expect.objectContaining({ group: "Gateway", status: "ok", detail: "connected to nemoclaw" }),
    );
    // The Docker-driver gateway is healthy, so no Gateway check should fail.
    expect(report.checks.filter((c) => c.group === "Gateway" && c.status === "fail")).toEqual([]);
    expect(report.status).toBe("ok");
    expect(r.code).toBe(0);
  });

  it("doctor still inspects the legacy k3s gateway container for the kubernetes driver", () => {
    const setup = createDoctorTestSetup("nemoclaw-cli-doctor-k8s-driver-", [
      'case "$*" in',
      '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
      '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
      '  "sandbox list") printf "NAME STATUS\\nalpha Ready\\n"; exit 0 ;;',
      '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
      "esac",
    ]);
    writeSandboxRegistry(setup.home, "alpha", { openshellDriver: "kubernetes" });

    const r = setup.runDoctor("alpha doctor --json");

    const report = JSON.parse(r.out) as {
      checks: Array<{ group: string; label: string; status: string; detail: string }>;
    };
    const dockerContainer = report.checks.find((check) => check.label === "Docker container");
    expect(dockerContainer).toEqual(
      expect.objectContaining({
        group: "Gateway",
        status: "ok",
        detail: expect.stringContaining("openshell-cluster-nemoclaw"),
      }),
    );
  });

  it(
    "doctor reports fresh shields state as not configured instead of down",
    testTimeoutOptions(30_000),
    () => {
      const setup = createDoctorTestSetup("nemoclaw-cli-doctor-shields-default-", [
        'case "$*" in',
        '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
        '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
        '  "sandbox list") printf "NAME STATUS\\nalpha Ready\\n"; exit 0 ;;',
        '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
        "esac",
      ]);

      const r = setup.runDoctor("alpha doctor --json");

      const report = JSON.parse(r.out) as {
        checks: Array<{ label: string; status: string; detail: string; hint?: string }>;
      };
      const shields = report.checks.find((check) => check.label === "Shields");
      expect(shields).toEqual(
        expect.objectContaining({
          status: "info",
          detail: "not configured (default mutable state)",
        }),
      );
      expect(shields?.detail).not.toBe("down");
    },
  );

  it("doctor does not query sandbox state from a different active gateway", () => {
    const setup = createDoctorTestSetup("nemoclaw-cli-doctor-wrong-gateway-", [
      'case "$*" in',
      '  "status") printf "Server Status\\n\\n  Gateway: other\\n  Status: Connected\\n"; exit 0 ;;',
      '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
      '  "gateway select nemoclaw") exit 1 ;;',
      '  "gateway start --name nemoclaw --port 8080") exit 1 ;;',
      '  "sandbox list") echo "queried wrong gateway sandbox list" >> "$marker_file"; exit 0 ;;',
      "esac",
    ]);

    const r = setup.runDoctor("alpha doctor");

    expect(r.code).toBe(1);
    expect(r.out).toContain("OpenShell status");
    expect(r.out).toContain("Gateway: other");
    expect(setup.readCalls().some((call) => /^sandbox list(\s|$)/.test(call))).toBe(false);
  });

  it("doctor treats a live non-cloudflared PID as stale", () => {
    const { sandboxName, serviceDir } = createCloudflaredServiceDir("doctorpid-");
    const setup = createDoctorTestSetup(
      "nemoclaw-cli-doctor-wrong-cloudflared-pid-",
      [
        'case "$*" in',
        '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
        '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
        `  "sandbox list") printf "NAME STATUS\\n${sandboxName} Ready\\n"; exit 0 ;;`,
        '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
        "esac",
      ],
      sandboxName,
    );
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    const sleeperPid = sleeper.pid;
    if (typeof sleeperPid !== "number") {
      throw new Error("expected spawned helper process to have a PID");
    }

    try {
      fs.writeFileSync(path.join(serviceDir, "cloudflared.pid"), String(sleeperPid));
      const r = setup.runDoctor(`${sandboxName} doctor --json`);

      const report = JSON.parse(r.out) as {
        checks: Array<{ label: string; status: string; detail: string }>;
      };
      const cloudflared = report.checks.find((check) => check.label === "cloudflared");
      expect(cloudflared).toEqual(
        expect.objectContaining({
          status: "warn",
          detail: `stale PID ${sleeperPid}`,
        }),
      );
    } finally {
      sleeper.kill();
      fs.rmSync(serviceDir, { recursive: true, force: true });
    }
  });

  it("doctor accepts a live cloudflared PID", testTimeoutOptions(35_000), () => {
    const { sandboxName, serviceDir } = createCloudflaredServiceDir("doctorcloudflared-");
    const setup = createDoctorTestSetup(
      "nemoclaw-cli-doctor-cloudflared-pid-",
      [
        'case "$*" in',
        '  "status") printf "Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n"; exit 0 ;;',
        '  "gateway info -g nemoclaw") printf "Gateway: nemoclaw\\n"; exit 0 ;;',
        `  "sandbox list") printf "NAME STATUS\\n${sandboxName} Ready\\n"; exit 0 ;;`,
        '  "inference get") printf "Provider: nvidia-prod\\nModel: test-model\\n"; exit 0 ;;',
        "esac",
      ],
      sandboxName,
    );
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloudflared-shim-"));
    const cloudflaredBin = path.join(shimDir, "cloudflared");
    fs.symlinkSync(process.execPath, cloudflaredBin);
    const sleeper = spawn(cloudflaredBin, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    const sleeperPid = sleeper.pid;
    if (typeof sleeperPid !== "number") {
      throw new Error("expected spawned helper process to have a PID");
    }

    try {
      fs.writeFileSync(path.join(serviceDir, "cloudflared.pid"), String(sleeperPid));
      const r = setup.runDoctor(`${sandboxName} doctor --json`);

      const report = JSON.parse(r.out) as {
        checks: Array<{ label: string; status: string; detail: string }>;
      };
      const cloudflared = report.checks.find((check) => check.label === "cloudflared");
      expect(cloudflared).toEqual(
        expect.objectContaining({
          status: "ok",
          detail: `running (PID ${sleeperPid})`,
        }),
      );
    } finally {
      sleeper.kill();
      fs.rmSync(serviceDir, { recursive: true, force: true });
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("preserves the gateway runtime by default when the last sandbox is destroyed (#2166)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-last-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy -y", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    const openshellOutput = fs.readFileSync(openshellLog, "utf8");
    expect(openshellOutput).toContain("sandbox delete alpha");
    expect(openshellOutput).toContain("NAME STATUS");
    // Gateway preservation is now the default. `--yes` confirms only the
    // sandbox; the shared NemoClaw gateway must stay up so the next
    // `nemoclaw onboard` reuses it.
    expect(openshellOutput).not.toContain("forward stop 18789");
    expect(openshellOutput).not.toContain("gateway destroy -g nemoclaw");
    expect(openshellOutput).not.toContain("gateway remove nemoclaw");
    expect(fs.readFileSync(bashLog, "utf8")).not.toContain("volume ls -q --filter");
  });

  it("tears down the gateway runtime when --cleanup-gateway is passed (#2166)", testTimeoutOptions(30_000), () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-last-cleanup-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(localBin, "pgrep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(localBin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const r = runWithEnv(
      "alpha destroy -y --cleanup-gateway",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      },
      30_000,
    );

    expect(r.code, r.out).toBe(0);
    const openshellOutput = fs.readFileSync(openshellLog, "utf8");
    expect(openshellOutput).toContain("sandbox delete alpha");
    expect(openshellOutput).toContain("forward stop 18789");
    expect(openshellOutput).toContain(
      process.platform === "linux" ? "gateway remove nemoclaw" : "gateway destroy -g nemoclaw",
    );
    expect(fs.readFileSync(bashLog, "utf8")).toContain("volume ls -q --filter");
  });

  it("honours NEMOCLAW_CLEANUP_GATEWAY=1 as the env-driven opt-in (#2166)", testTimeoutOptions(30_000), () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-last-env-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(localBin, "pgrep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(localBin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const r = runWithEnv(
      "alpha destroy -y",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
        NEMOCLAW_CLEANUP_GATEWAY: "1",
      },
      30_000,
    );

    expect(r.code, r.out).toBe(0);
    const openshellOutput = fs.readFileSync(openshellLog, "utf8");
    expect(openshellOutput).toContain("forward stop 18789");
    expect(openshellOutput).toContain(
      process.platform === "linux" ? "gateway remove nemoclaw" : "gateway destroy -g nemoclaw",
    );
  });

  it("keeps the gateway runtime when other sandboxes still exist", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-shared-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
          beta: {
            name: "beta",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\nbeta Ready\\n" >> "$log_file"',
        '  printf "NAME STATUS\\nbeta Ready\\n"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway remove nemoclaw");
    if (fs.existsSync(bashLog)) {
      expect(fs.readFileSync(bashLog, "utf8")).not.toContain("volume ls -q --filter");
    }
  });

  it("keeps the gateway runtime when the live gateway still reports sandboxes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-live-shared-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\nbeta Ready\\n" >> "$log_file"',
        '  printf "NAME STATUS\\nbeta Ready\\n"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("beta Ready");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway remove nemoclaw");
    if (fs.existsSync(bashLog)) {
      expect(fs.readFileSync(bashLog, "utf8")).not.toContain("volume ls -q --filter");
    }
  });

  it("fails destroy when openshell sandbox delete returns a real error", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-failure-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
        '  echo "transport error: gateway unavailable" >&2',
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("transport error: gateway unavailable");
    expect(r.out).toContain("Failed to destroy sandbox 'alpha'.");
    expect(r.out).not.toContain("Sandbox 'alpha' destroyed");

    const registryAfter = JSON.parse(
      fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"),
    );
    expect(registryAfter.sandboxes.alpha).toBeTruthy();
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway remove nemoclaw");
  });

  it("treats an already-missing sandbox as destroyed and clears the stale registry entry", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-missing-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
        '  printf \'%s\\n\' "$*" >> "$log_file"',
        '  echo "Error: status: Not Found, message: \\"sandbox not found\\"" >&2',
        "  exit 1",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        '  printf "NAME STATUS\\n"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("already absent from the live gateway");
    expect(r.out).toContain("Sandbox 'alpha' destroyed");

    const registryAfter = JSON.parse(
      fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"),
    );
    expect(registryAfter.sandboxes.alpha).toBeFalsy();
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(bashLog, "utf8")).not.toContain("volume ls -q --filter");
  });

  it("deletes messaging providers when destroying a sandbox", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-providers-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    const log = fs.readFileSync(openshellLog, "utf8");
    expect(log).toContain("provider delete alpha-telegram-bridge");
    expect(log).toContain("provider delete alpha-discord-bridge");
    expect(log).toContain("provider delete alpha-slack-bridge");
    expect(log).toContain("provider delete alpha-slack-app");
  });

  it("connect does not pre-start a duplicate port forward", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-forward-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "openshell-calls");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'alpha   Ready   2m ago'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "connect" ] && [ "$3" = "alpha" ]; then',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(localBin, "sleep"), ["#!/usr/bin/env bash", "exit 0"].join("\n"), {
      mode: 0o755,
    });

    const r = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls).toContain("sandbox connect alpha");
    expect(calls.some((call) => call.startsWith("forward start --background 18789"))).toBe(false);
  });

  it("shows connect help without opening an interactive session", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-help-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const sshMarkerFile = path.join(home, "ssh-calls");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> ${JSON.stringify(markerFile)}`,
        "exit 99",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeRecordingCommand(localBin, "ssh", sshMarkerFile, 98);

    const r = runWithEnv("alpha connect --help", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });
    const implicit = runWithEnv("alpha --help", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: nemoclaw alpha connect");
    expect(r.out).toContain("--probe-only");
    expect(implicit.code).toBe(0);
    expect(implicit.out).toContain("Usage: nemoclaw alpha connect");
    expect(fs.existsSync(markerFile)).toBe(false);
    expect(fs.existsSync(sshMarkerFile)).toBe(false);
  });

  it("rejects the removed skip-permissions connect flag", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-flags-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const sshMarkerFile = path.join(home, "ssh-calls");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> ${JSON.stringify(markerFile)}`,
        "exit 99",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeRecordingCommand(localBin, "ssh", sshMarkerFile, 98);
    writeSandboxRegistry(home);

    const r = runWithEnv("alpha connect --dangerously-skip-permissions", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("--dangerously-skip-permissions was removed");
    expect(fs.existsSync(markerFile)).toBe(false);
    expect(fs.existsSync(sshMarkerFile)).toBe(false);
  });

  it("connect --probe-only recovers the gateway without opening SSH", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const sshMarkerFile = path.join(home, "ssh-calls");
    const stateFile = path.join(home, "probe-state");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(stateFile, "stopped");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        '  cmd="$8"',
        '  case "$cmd" in',
        '    *"OPENCLAW="*)',
        '      echo recovered > "$state_file"',
        "      echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        "      echo 'GATEWAY_PID=123'",
        "      exit 42",
        "      ;;",
        "    *'curl -so'*)",
        "      echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        '      if [ "$(cat "$state_file")" = recovered ]; then echo RUNNING; else echo STOPPED; fi',
        "      exit 0",
        "      ;;",
        "  esac",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeRecordingCommand(localBin, "ssh", sshMarkerFile, 98);

    const r = runWithEnv("alpha connect --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Probe complete: recovered OpenClaw gateway");
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls.some((call) => call.startsWith("sandbox exec --name alpha -- sh -c"))).toBe(true);
    expect(calls).not.toContain("sandbox ssh-config alpha");
    expect(calls).not.toContain("sandbox connect alpha");
    expect(fs.existsSync(sshMarkerFile)).toBe(false);
  });

  it("waits for recovered gateway health before failing probe-only", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-wait-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const stateFile = path.join(home, "probe-state");
    const readyCountFile = path.join(home, "ready-count");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(stateFile, "stopped");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        `ready_count_file=${JSON.stringify(readyCountFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        '  cmd="$8"',
        '  case "$cmd" in',
        '    *"OPENCLAW="*)',
        '      echo recovered > "$state_file"',
        "      echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        "      echo 'GATEWAY_PID=123'",
        "      exit 0",
        "      ;;",
        "    *'curl -so'*)",
        "      echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        '      if [ "$(cat "$state_file")" != recovered ]; then echo STOPPED; exit 0; fi',
        '      count=$(cat "$ready_count_file" 2>/dev/null || echo 0)',
        "      count=$((count + 1))",
        '      echo "$count" > "$ready_count_file"',
        '      if [ "$count" -ge 3 ]; then echo RUNNING; else echo STOPPED; fi',
        "      exit 0",
        "      ;;",
        "  esac",
        "fi",
        'if [ "$1" = "forward" ]; then',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
      NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS: "3",
      NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS: "0",
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Probe complete: recovered OpenClaw gateway");
    expect(fs.readFileSync(readyCountFile, "utf8").trim()).toBe("3");
  });

  it("treats leading --probe-only as an implicit connect probe", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-leading-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const sshMarkerFile = path.join(home, "ssh-calls");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        '  cmd="$8"',
        '  if [[ "$cmd" == *"curl -so"* ]]; then echo "__NEMOCLAW_SANDBOX_EXEC_STARTED__"; echo RUNNING; exit 0; fi',
        '  if [[ "$cmd" == *"OPENCLAW="* ]]; then echo "__NEMOCLAW_SANDBOX_EXEC_STARTED__"; echo UNEXPECTED_RECOVERY; exit 1; fi',
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeRecordingCommand(localBin, "ssh", sshMarkerFile, 98);

    const r = runWithEnv("alpha --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Probe complete: OpenClaw gateway is running");
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls.some((call) => call.startsWith("sandbox exec --name alpha -- sh -c"))).toBe(true);
    expect(calls).not.toContain("sandbox ssh-config alpha");
    expect(calls).not.toContain("sandbox connect alpha");
    expect(fs.existsSync(sshMarkerFile)).toBe(false);
  });

  it("connect --probe-only does not retry a failed sandbox exec recovery over SSH", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-no-ssh-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const sshMarkerFile = path.join(home, "ssh-calls");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        '  cmd="$8"',
        '  if [[ "$cmd" == *"OPENCLAW="* ]]; then echo "__NEMOCLAW_SANDBOX_EXEC_STARTED__"; echo RECOVERY_FAILED >&2; exit 42; fi',
        '  if [[ "$cmd" == *"curl -so"* ]]; then echo "__NEMOCLAW_SANDBOX_EXEC_STARTED__"; echo STOPPED; exit 0; fi',
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ]; then',
        "  echo 'Host openshell-alpha'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeRecordingCommand(localBin, "ssh", sshMarkerFile, 98);

    const r = runWithEnv("alpha connect --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls.some((call) => call.startsWith("sandbox exec --name alpha -- sh -c"))).toBe(true);
    expect(calls).not.toContain("sandbox ssh-config alpha");
    expect(fs.existsSync(sshMarkerFile)).toBe(false);
  });

  it("connect --probe-only falls back to SSH when sandbox exec never starts", testTimeoutOptions(15_000), () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-exec-fallback-"),
    );
    const localBin = path.join(home, "bin");
    const openshellCalls = path.join(home, "openshell-calls");
    const sshCalls = path.join(home, "ssh-calls");
    const stateFile = path.join(home, "probe-state");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(stateFile, "stopped");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `calls=${JSON.stringify(openshellCalls)}`,
        'printf \'%s\\n\' "$*" >> "$calls"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
        "  echo 'error: sandbox exec transport failed before command start' >&2",
        "  exit 2",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Host openshell-alpha'",
        "  echo '  HostName 127.0.0.1'",
        "  echo '  User sandbox'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "ssh"),
      [
        "#!/usr/bin/env bash",
        `calls=${JSON.stringify(sshCalls)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        'cmd="${@: -1}"',
        'printf \'ARGS %s\\n\' "$*" >> "$calls"',
        'printf \'CMD %s\\n\' "$cmd" >> "$calls"',
        'if [[ "$cmd" == *"OPENCLAW="* ]]; then',
        '  echo recovered > "$state_file"',
        "  echo 'GATEWAY_PID=456'",
        "  exit 0",
        "fi",
        'if [[ "$cmd" == *"curl -so"* ]]; then',
        '  if [ "$(cat "$state_file")" = recovered ]; then echo RUNNING; else echo STOPPED; fi',
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Probe complete: recovered OpenClaw gateway");
    const openshellLog = fs.readFileSync(openshellCalls, "utf8");
    const sshLog = fs.readFileSync(sshCalls, "utf8");
    expect(openshellLog).toContain("sandbox exec --name alpha -- sh -c");
    expect(openshellLog).toContain("sandbox ssh-config alpha");
    expect(openshellLog).not.toContain("sandbox connect");
    expect(sshLog).toContain('OPENCLAW="$(command -v openclaw)"');
    expect(sshLog).not.toMatch(/(^|\s)-tt?(\s|$)/);
  });

  it("connect --probe-only falls back to SSH when sandbox exec times out after starting", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-exec-timeout-"),
    );
    const localBin = path.join(home, "bin");
    const openshellCalls = path.join(home, "openshell-calls");
    const sshCalls = path.join(home, "ssh-calls");
    const stateFile = path.join(home, "probe-state");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(stateFile, "stopped");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `calls=${JSON.stringify(openshellCalls)}`,
        'printf \'%s\\n\' "$*" >> "$calls"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
        "  echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        "  sleep 1",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Host openshell-alpha'",
        "  echo '  HostName 127.0.0.1'",
        "  echo '  User sandbox'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "ssh"),
      [
        "#!/usr/bin/env bash",
        `calls=${JSON.stringify(sshCalls)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        'cmd="${@: -1}"',
        'printf \'CMD %s\\n\' "$cmd" >> "$calls"',
        'if [[ "$cmd" == *"OPENCLAW="* ]]; then',
        '  echo recovered > "$state_file"',
        "  echo 'GATEWAY_PID=789'",
        "  exit 0",
        "fi",
        'if [[ "$cmd" == *"curl -so"* ]]; then',
        '  if [ "$(cat "$state_file")" = recovered ]; then echo RUNNING; else echo STOPPED; fi',
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
      NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS: "50",
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Probe complete: recovered OpenClaw gateway");
    const openshellLog = fs.readFileSync(openshellCalls, "utf8");
    const sshLog = fs.readFileSync(sshCalls, "utf8");
    expect(openshellLog).toContain("sandbox exec --name alpha -- sh -c");
    expect(openshellLog).toContain("sandbox ssh-config alpha");
    expect(sshLog).toContain('OPENCLAW="$(command -v openclaw)"');
  });

  it("recovers non-OpenClaw agents over SSH instead of root sandbox exec", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-agent-"));
    const localBin = path.join(home, "bin");
    const openshellCalls = path.join(home, "openshell-calls");
    const sshCalls = path.join(home, "ssh-calls");
    const stateFile = path.join(home, "probe-state");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, { agent: "hermes" });
    fs.writeFileSync(stateFile, "stopped");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `calls=${JSON.stringify(openshellCalls)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        'printf \'%s\\n\' "$*" >> "$calls"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        '  cmd="$8"',
        '  if [[ "$cmd" == *"curl -so"* ]]; then',
        "    echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        '    if [ "$(cat "$state_file")" = recovered ]; then echo RUNNING; else echo STOPPED; fi',
        "    exit 0",
        "  fi",
        '  if [[ "$cmd" == *"HERMES_HOME=/sandbox/.hermes"* || "$cmd" == *"AGENT_BIN="* ]]; then',
        "    echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        "    echo UNEXPECTED_ROOT_EXEC_RECOVERY",
        "    exit 1",
        "  fi",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Host openshell-alpha'",
        "  echo '  HostName 127.0.0.1'",
        "  echo '  User sandbox'",
        "  exit 0",
        "fi",
        'if [ "$1" = "forward" ]; then',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "ssh"),
      [
        "#!/usr/bin/env bash",
        `calls=${JSON.stringify(sshCalls)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        'cmd="${@: -1}"',
        'printf \'ARGS %s\\n\' "$*" >> "$calls"',
        'printf \'CMD %s\\n\' "$cmd" >> "$calls"',
        'if [[ "$cmd" == *"AGENT_BIN=\'/usr/local/bin/hermes\'"* ]]; then',
        '  echo recovered > "$state_file"',
        "  echo 'GATEWAY_PID=789'",
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Probe complete: recovered Hermes Agent gateway");
    const openshellLog = fs.readFileSync(openshellCalls, "utf8");
    const sshLog = fs.readFileSync(sshCalls, "utf8");
    expect(openshellLog).toContain("sandbox exec --name alpha -- sh -c");
    expect(openshellLog).toContain("sandbox ssh-config alpha");
    expect(openshellLog).not.toContain("HERMES_HOME=/sandbox/.hermes");
    expect(openshellLog).not.toContain("AGENT_BIN=");
    expect(openshellLog).not.toContain("sandbox connect");
    expect(sshLog).toContain("HERMES_HOME=/sandbox/.hermes");
    expect(sshLog).toContain("AGENT_BIN='/usr/local/bin/hermes'");
    expect(sshLog).not.toMatch(/(^|\s)-tt?(\s|$)/);
  });

  it("waits for sandbox readiness before connecting", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-wait-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "openshell-calls");
    const stateFile = path.join(home, "sandbox-list-count");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Pending'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  count=$(cat "$state_file" 2>/dev/null || echo 0)',
        "  count=$((count + 1))",
        '  echo "$count" > "$state_file"',
        '  if [ "$count" -eq 1 ]; then',
        "    echo 'alpha   ContainerCreating   10s ago'",
        "  else",
        "    echo 'alpha   Ready   20s ago'",
        "  fi",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "connect" ] && [ "$3" = "alpha" ]; then',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(localBin, "sleep"), ["#!/usr/bin/env bash", "exit 0"].join("\n"), {
      mode: 0o755,
    });
    // Healthy Docker so the connect readiness wait is not short-circuited by
    // the #4428 docker-down fast-fail.
    writeHealthyDockerStub(localBin);

    const r = runWithEnv(
      "alpha connect",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      },
      execTimeout(30_000),
    );

    expect(r.code).toBe(0);
    expect(r.out.includes("Waiting for sandbox 'alpha' to be ready")).toBeTruthy();
    expect(r.out.includes("Sandbox is ready. Connecting")).toBeTruthy();
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls.filter((call) => call === "sandbox list").length).toBeGreaterThanOrEqual(2);
    expect(calls).toContain("sandbox connect alpha");
  });

  it(
    "fails fast with gateway recovery guidance when connect readiness sees a disconnected gateway",
    () => {
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-cli-connect-gateway-down-"),
      );
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const markerFile = path.join(home, "openshell-calls");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      writeHealthyDockerStub(localBin);
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          `marker_file=${JSON.stringify(markerFile)}`,
          'printf \'%s\\n\' "$*" >> "$marker_file"',
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Sandbox:'",
          "  echo",
          "  echo '  Id: abc'",
          "  echo '  Name: alpha'",
          "  echo '  Namespace: openshell'",
          "  echo '  Phase: Pending'",
          "  exit 0",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          "  echo 'alpha   unknown   103s ago'",
          "  exit 0",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Server Status'",
          "  echo",
          "  echo '  Gateway: nemoclaw'",
          "  echo '  Status: Disconnected'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  echo 'Gateway Info'",
          "  echo",
          "  echo '  Gateway: nemoclaw'",
          "  exit 0",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "connect" ] && [ "$3" = "alpha" ]; then',
          "  echo 'should-not-connect' >> \"$marker_file\"",
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv(
        "alpha connect",
        {
          HOME: home,
          NEMOCLAW_CONNECT_TIMEOUT: "1",
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(10_000),
      );

      expect(r.code).toBe(1);
      expect(r.out).toContain("OpenShell gateway is not running or unreachable");
      expect(r.out).toContain("nemoclaw onboard");
      expect(r.out).not.toContain("Timed out after 1s");
      const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
      expect(calls).toContain("status");
      expect(calls).not.toContain("should-not-connect");
    },
    testTimeout(15_000),
  );

  it("prints recovery guidance when readiness polling hits a terminal sandbox state", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-failed-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "openshell-calls");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Failed'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'alpha   Failed   1m ago'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "connect" ] && [ "$3" = "alpha" ]; then',
        "  echo 'should-not-connect' >> \"$marker_file\"",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out.includes("Sandbox 'alpha' is in 'Failed' state")).toBeTruthy();
    expect(r.out.includes("nemoclaw alpha logs --follow")).toBeTruthy();
    expect(r.out.includes("nemoclaw alpha status")).toBeTruthy();
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    expect(calls).toContain("sandbox get alpha");
    expect(calls).toContain("sandbox list");
    expect(calls).not.toContain("should-not-connect");
  });

  it("preserves the registry entry when connect targets a missing live sandbox (#4497)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-stale-connect-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Error: status: NotFound, message: \"sandbox not found\"' >&2",
        "  exit 1",
        "fi",
        // Simulate a healthy, active `nemoclaw` named gateway so the
        // lifecycle guard confirms healthy_named. Even on this path connect
        // must now preserve the entry so a follow-up rebuild can recover it
        // (#4497); it previously removed it here (#2276).
        'if [ "$1" = "status" ]; then',
        "  printf 'Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  printf 'Gateway: nemoclaw\\n'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out.includes("Removed stale local registry entry")).toBe(false);
    expect(r.out.includes("registered locally, but is not present")).toBeTruthy();
    expect(r.out.includes("preserved")).toBeTruthy();
    const saved = JSON.parse(fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeDefined();
  });

  it("recovers a missing registry entry from the last onboard session during list", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-session-recover-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          gamma: {
            name: "gamma",
            model: "existing-model",
            provider: "existing-provider",
            gpuEnabled: false,
            policies: ["npm"],
          },
        },
        defaultSandbox: "gamma",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: ["pypi"],
          metadata: { gatewayName: "nemoclaw" },
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
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'NAME           STATUS     AGE'",
        "  echo 'alpha          Ready      2m ago'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(
      r.out.includes("Recovered sandbox inventory from the last onboard session."),
    ).toBeTruthy();
    expect(r.out.includes("alpha")).toBeTruthy();
    expect(r.out.includes("gamma")).toBeTruthy();
    const saved = JSON.parse(fs.readFileSync(path.join(nemoclawDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeTruthy();
    expect(saved.sandboxes.alpha.policies).toEqual(["pypi"]);
    expect(saved.sandboxes.gamma).toBeTruthy();
    expect(saved.defaultSandbox).toBe("gamma");
  });

  it("imports additional live sandboxes into the registry during list recovery", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-live-recover-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          gamma: {
            name: "gamma",
            model: "existing-model",
            provider: "existing-provider",
            gpuEnabled: false,
            policies: ["npm"],
          },
        },
        defaultSandbox: "gamma",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: ["pypi"],
          metadata: { gatewayName: "nemoclaw" },
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
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'NAME        PHASE'",
        "  echo 'alpha       Ready'",
        "  echo 'beta        Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(
      r.out.includes("Recovered sandbox inventory from the last onboard session."),
    ).toBeTruthy();
    expect(
      r.out.includes("Recovered 1 sandbox entry from the live OpenShell gateway."),
    ).toBeTruthy();
    expect(r.out.includes("alpha")).toBeTruthy();
    expect(r.out.includes("beta")).toBeTruthy();
    expect(r.out.includes("gamma")).toBeTruthy();
    const saved = JSON.parse(fs.readFileSync(path.join(nemoclawDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeTruthy();
    expect(saved.sandboxes.alpha.policies).toEqual(["pypi"]);
    expect(saved.sandboxes.beta).toBeTruthy();
    expect(saved.sandboxes.gamma).toBeTruthy();
    expect(saved.defaultSandbox).toBe("gamma");
  });

  it("skips invalid recovered sandbox names during list recovery", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-list-invalid-recover-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          gamma: {
            name: "gamma",
            model: "existing-model",
            provider: "existing-provider",
            gpuEnabled: false,
            policies: ["npm"],
          },
        },
        defaultSandbox: "gamma",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "Alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: ["pypi"],
          metadata: { gatewayName: "nemoclaw" },
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
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'NAME        PHASE'",
        "  echo 'alpha       Ready'",
        "  echo 'Bad_Name    Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("list", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out.includes("alpha")).toBeTruthy();
    expect(r.out.includes("Bad_Name")).toBeFalsy();
    const saved = JSON.parse(fs.readFileSync(path.join(nemoclawDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeTruthy();
    expect(saved.sandboxes.Bad_Name).toBeUndefined();
    expect(saved.sandboxes.Alpha).toBeUndefined();
    expect(saved.sandboxes.gamma).toBeTruthy();
  });

  it("connect recovers a named sandbox from the last onboard session when the registry is empty", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-recover-session-"));
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    const markerFile = path.join(home, "connect-args");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: null,
          metadata: { gatewayName: "nemoclaw" },
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
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `marker_file=${JSON.stringify(markerFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'NAME           STATUS     AGE'",
        "  echo 'alpha          Ready      2m ago'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "connect" ] && [ "$3" = "alpha" ]; then',
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    const log = fs.readFileSync(markerFile, "utf8");
    expect(log.includes("sandbox list")).toBeTruthy();
    expect(log.includes("sandbox get alpha")).toBeTruthy();
    expect(log.includes("sandbox connect alpha")).toBeTruthy();
  });

  it("connect surfaces sandbox-not-found when recovery cannot find the requested sandbox (#2164)", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-connect-unknown-after-recovery-"),
    );
    const localBin = path.join(home, "bin");
    const nemoclawDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(nemoclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(nemoclawDir, "onboard-session.json"),
      JSON.stringify(
        {
          version: 1,
          sessionId: "session-1",
          resumable: true,
          status: "complete",
          mode: "interactive",
          startedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          lastStepStarted: "policies",
          lastCompletedStep: "policies",
          failure: null,
          sandboxName: "alpha",
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          nimContainer: null,
          policyPresets: null,
          metadata: { gatewayName: "nemoclaw" },
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
            policies: { status: "complete", startedAt: null, completedAt: null, error: null },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        "  echo 'No sandboxes found.'",
        "  exit 0",
        "fi",
        'if [ "$1" = "--version" ]; then',
        "  echo 'openshell 0.0.16'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("beta connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out.includes("Sandbox 'beta' does not exist")).toBeTruthy();
    // Recovery from onboard-session.json restores "alpha" into the local registry,
    // so the helper lists it rather than the empty-registry onboard hint.
    expect(r.out.includes("Registered sandboxes: alpha")).toBeTruthy();
  });

  it(
    "keeps registry entries when status hits a gateway-level transport error",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-gateway-error-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Error: transport error: handshake verification failed' >&2",
          "  exit 1",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );

      expect(r.code).toBe(1);
      expect(r.out.includes("Could not verify sandbox 'alpha'")).toBeTruthy();
      expect(r.out.includes("gateway identity drift after restart")).toBeTruthy();
      const saved = JSON.parse(fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"));
      expect(saved.sandboxes.alpha).toBeTruthy();
    },
    testTimeout(10_000),
  );

  it(
    "keeps status bounded when a live sandbox probe leaves child pipes open",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-timeout-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          `  ${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)" &`,
          "  wait",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const started = Date.now();
      const r = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
          NEMOCLAW_STATUS_PROBE_TIMEOUT_MS: "100",
        },
        10000,
      );

      expect(Date.now() - started).toBeLessThan(7000);
      expect(r.code).toBe(1);
      expect(r.out).toContain("Model:    test-model");
      expect(r.out).toContain("Live sandbox status probe timed out");
    },
    testTimeout(10_000),
  );

  it("recovers status after gateway runtime is reattached", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-recover-status-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const stateFile = path.join(home, "sandbox-get-count");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `state_file=${JSON.stringify(stateFile)}`,
        'count=$(cat "$state_file" 2>/dev/null || echo 0)',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  count=$((count + 1))",
        '  echo "$count" > "$state_file"',
        '  if [ "$count" -eq 1 ]; then',
        "    echo 'Error: transport error: Connection refused' >&2",
        "    exit 1",
        "  fi",
        "  echo 'Sandbox: alpha'",
        "  exit 0",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out.includes("Recovered NemoClaw gateway runtime")).toBeTruthy();
    expect(r.out.includes("Sandbox: alpha")).toBeTruthy();
  });

  it("shows a clear local inference warning when Ollama is down", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-local-inference-down-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "llama3.2:1b",
            provider: "ollama-local",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox: alpha'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ] && [ "$3" = "alpha" ]; then',
        "  exit 1",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo",
        "  echo '  Provider: ollama-local'",
        "  echo '  Model: llama3.2:1b'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "curl"),
      [
        "#!/usr/bin/env bash",
        'out=""',
        'url=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    -o) out="$2"; shift 2 ;;',
        "    -w|--connect-timeout|--max-time) shift 2 ;;",
        "    -s|-S|-sS|-f) shift ;;",
        '    http://*|https://*) url="$1"; shift ;;',
        "    *) shift ;;",
        "  esac",
        "done",
        'if [ -n "$out" ]; then : > "$out"; fi',
        'if echo "$url" | grep -q "11434/api/tags"; then',
        '  printf "000"',
        "  exit 7",
        "fi",
        'printf "000"',
        "exit 7",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    // #3265: backend label is qualified `Inference (ollama backend):` so the
    // upcoming auth-proxy subprobe line renders in parallel.
    expect(r.out).toContain("Inference (ollama backend):");
    expect(r.out).toContain("unreachable");
    expect(r.out).toContain("Start Ollama and retry");
    expect(r.out).toContain("http://127.0.0.1:11434/api/tags");
  });

  it(
    "status reports fresh shields state as not configured instead of down",
    testTimeoutOptions(30_000),
    () => {
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-cli-status-shields-default-"),
      );
      const localBin = path.join(home, "bin");
      fs.mkdirSync(localBin, { recursive: true });
      writeSandboxRegistry(home);
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Error: sandbox not found' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Server Status'",
          "  echo",
          "  echo '  Gateway: nemoclaw'",
          "  echo '  Status: Connected'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  echo 'Gateway Info'",
          "  echo",
          "  echo '  Gateway: nemoclaw'",
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv("alpha status 2>&1", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code).toBe(1);
      expect(r.out).toContain("Permissions: not configured (default mutable state)");
      expect(r.out).not.toContain("Permissions: shields down");
    },
  );

  it("prints healthy inference only after the sandbox and gateway are verified", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-healthy-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, {
      model: "configured-model",
      provider: "nvidia-prod",
      gpuEnabled: true,
      policies: ["pypi"],
    });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> ${JSON.stringify(markerFile)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo",
        "  echo '  Provider: nvidia-prod'",
        "  echo '  Model: live-model'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        "  echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        "  echo 'RUNNING'",
        "  exit 0",
        "fi",
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
        'printf "200"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Sandbox: alpha");
    expect(r.out).toContain("Model:    live-model");
    expect(r.out).toContain("Provider: nvidia-prod");
    expect(r.out).toContain("Inference:");
    expect(r.out).toContain("healthy");
    expect(r.out).not.toContain("not verified");
    const calls = fs.readFileSync(markerFile, "utf8").trim().split("\n").filter(Boolean);
    const sandboxGetIdx = calls.indexOf("sandbox get alpha");
    const inferenceGetIdx = calls.indexOf("inference get");
    expect(sandboxGetIdx).toBeGreaterThanOrEqual(0);
    expect(inferenceGetIdx).toBeGreaterThan(sandboxGetIdx);
  });

  it("status reports the live sandbox agent version instead of cached host metadata", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-agent-drift-"));
    const localBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home, {
      model: "configured-model",
      provider: "nvidia-prod",
      agentVersion: "2026.5.18",
    });
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Host openshell-alpha'",
        "  echo '  HostName 127.0.0.1'",
        "  exit 0",
        "fi",
        'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
        "  echo 'Gateway inference:'",
        "  echo",
        "  echo '  Provider: nvidia-prod'",
        "  echo '  Model: live-model'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        "  echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        "  echo 'RUNNING'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "ssh"),
      ["#!/usr/bin/env bash", "echo 'OpenClaw 2026.3.11 (old)'", "exit 0"].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha status", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Agent:    OpenClaw v2026.3.11");
    expect(r.out).toContain("Update:");
    expect(r.out).toContain(`v${OPENCLAW_EXPECTED_VERSION} available`);
    expect(r.out).toContain("Run `nemoclaw alpha rebuild` to upgrade");
    expect(r.out).not.toContain("Agent:    OpenClaw v2026.5.18");
  });

  it(
    "does not treat a different connected gateway as a healthy nemoclaw gateway",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-mixed-gateway-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Error: transport error: Connection refused' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Server Status'",
          "  echo",
          "  echo '  Gateway: openshell'",
          "  echo '  Status: Connected'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  echo 'Gateway Info'",
          "  echo",
          "  echo '  Gateway: nemoclaw'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "select" ] && [ "$3" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "start" ] && [ "$3" = "--name" ] && [ "$4" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          'if [ "$1" = "inference" ] && [ "$2" = "get" ]; then',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );

      expect(r.code).toBe(1);
      expect(r.out.includes("Recovered NemoClaw gateway runtime")).toBeFalsy();
      expect(r.out.includes("Could not verify sandbox 'alpha'")).toBeTruthy();
      expect(r.out.includes("verify the active gateway")).toBeTruthy();
    },
    testTimeout(10_000),
  );

  it(
    "matches ANSI-decorated gateway transport errors when printing lifecycle hints",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-ansi-transport-hint-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  printf '\\033[31mError: trans\\033[0mport error: Connec\\033[33mtion refused\\033[0m\\n' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Server Status'",
          "  echo",
          "  echo '  Gateway: openshell'",
          "  echo '  Status: Disconnected'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  printf 'Gateway Info\\n\\n  Gateway: openshell\\n'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "select" ] && [ "$3" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );

      expect(r.code).toBe(1);
      expect(r.out.includes("current gateway/runtime is not reachable")).toBeTruthy();
    },
    testTimeout(10_000),
  );

  it(
    "matches ANSI-decorated gateway auth errors when printing lifecycle hints",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-ansi-auth-hint-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  printf '\\033[31mMissing gateway auth\\033[0m token\\n' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Server Status'",
          "  echo",
          "  echo '  Gateway: openshell'",
          "  echo '  Status: Disconnected'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  printf 'Gateway Info\\n\\n  Gateway: openshell\\n'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "select" ] && [ "$3" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );

      expect(r.code).toBe(1);
      expect(
        r.out.includes("Verify the active gateway and retry after re-establishing the runtime."),
      ).toBeTruthy();
    },
    testTimeout(10_000),
  );

  it("explains unrecoverable gateway trust rotation after restart", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-identity-drift-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Error: transport error: handshake verification failed' >&2",
        "  exit 1",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  echo 'Server Status'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  echo '  Status: Connected'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
        "  echo 'Gateway Info'",
        "  echo",
        "  echo '  Gateway: nemoclaw'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const statusResult = runWithEnv(
      "alpha status",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      },
      execTimeout(),
    );
    expect(statusResult.code).toBe(1);
    expect(statusResult.out.includes("gateway trust material rotated after restart")).toBeTruthy();
    expect(statusResult.out.includes("cannot be reattached safely")).toBeTruthy();

    const connectResult = runWithEnv("alpha connect", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });
    expect(connectResult.code).toBe(1);
    // After the auto-recovery attempt (clear stale host keys + retry), the
    // fake openshell still returns the handshake error, so recovery fails.
    expect(connectResult.out.includes("Could not reconnect")).toBeTruthy();
    expect(connectResult.out.includes("Recreate this sandbox")).toBeTruthy();
  });

  it(
    "explains when gateway metadata exists but the restarted API is still refusing connections",
    { timeout: 30000 },
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-gateway-unreachable-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const markerFile = path.join(home, "openshell-calls");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          `printf '%s\\n' "$*" >> ${JSON.stringify(markerFile)}`,
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Error: transport error: Connection refused' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Server Status'",
          "  echo",
          "  echo '  Gateway: nemoclaw'",
          "  echo '  Server: https://127.0.0.1:8080'",
          "  echo 'Error: client error (Connect)' >&2",
          "  echo 'Connection refused (os error 111)' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  echo 'Gateway Info'",
          "  echo",
          "  echo '  Gateway: nemoclaw'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "select" ] && [ "$3" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "start" ] && [ "$3" = "--name" ] && [ "$4" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
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
          'printf "200"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const statusResult = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );
      expect(statusResult.code).toBe(1);
      expect(statusResult.out).not.toContain("Inference: healthy");
      expect(statusResult.out).toContain(
        "Inference: not verified (gateway/sandbox state not verified)",
      );
      expect(fs.readFileSync(markerFile, "utf8")).not.toContain("inference get");
      expect(
        statusResult.out.includes("gateway is still refusing connections after restart"),
      ).toBeTruthy();
      expect(
        statusResult.out.includes("Retry `openshell gateway start --name nemoclaw`"),
      ).toBeTruthy();

      const connectResult = runWithEnv("alpha connect", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });
      expect(connectResult.code).toBe(1);
      expect(
        connectResult.out.includes("gateway is still refusing connections after restart"),
      ).toBeTruthy();
      expect(connectResult.out.includes("If the gateway never becomes healthy")).toBeTruthy();
    },
  );

  it(
    "explains when the named gateway is no longer configured after restart or rebuild",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-gateway-missing-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              policies: [],
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
          "  echo 'Error: transport error: Connection refused' >&2",
          "  exit 1",
          "fi",
          'if [ "$1" = "status" ]; then',
          "  echo 'Gateway Status'",
          "  echo",
          "  echo '  Status: No gateway configured.'",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "info" ] && [ "$3" = "-g" ] && [ "$4" = "nemoclaw" ]; then',
          "  exit 1",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "select" ] && [ "$3" = "nemoclaw" ]; then',
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "start" ] && [ "$3" = "--name" ] && [ "$4" = "nemoclaw" ]; then',
          "  exit 1",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const statusResult = runWithEnv(
        "alpha status",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        execTimeout(),
      );
      expect(statusResult.code).toBe(1);
      expect(
        statusResult.out.includes("gateway is no longer configured after restart/rebuild"),
      ).toBeTruthy();
      expect(statusResult.out.includes("Start the gateway again")).toBeTruthy();
    },
    testTimeout(10_000),
  );

  it("preserves an orphan registry entry on passive status when the named gateway is healthy", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-status-orphan-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Error: status: NotFound, message: \"sandbox not found\"' >&2",
        "  exit 1",
        "fi",
        'if [ "$1" = "status" ]; then',
        "  printf 'Server Status\\n\\n  Gateway: nemoclaw\\n  Status: Connected\\n'",
        "  exit 0",
        "fi",
        'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
        "  printf 'Gateway: nemoclaw\\n'",
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const statusResult = runWithEnv(
      "alpha status",
      {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      },
      execTimeout(),
    );

    expect(statusResult.code).toBe(1);
    expect(statusResult.out).not.toContain("Inference: healthy");
    expect(statusResult.out).toContain(
      "registered locally, but is not present in the live OpenShell gateway",
    );
    expect(statusResult.out).toContain("No local registry entry was removed");
    expect(statusResult.out).not.toContain("Removed stale local registry entry");

    const saved = JSON.parse(fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"));
    expect(saved.sandboxes.alpha).toBeDefined();
    expect(saved.defaultSandbox).toBe("alpha");
  });
});
