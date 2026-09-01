// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";
import { runInstallerSourcedBody } from "../helpers/installer-run-fixture";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "../..", "scripts", "install.sh");

type StubAssignments = {
  cliBin?: string;
  cliPath?: string;
};

function runOnboardWithMockCli(
  env: Record<string, string>,
  assignments: StubAssignments = {},
): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-onboard-yes-"));
  const stubBin = path.join(tmp, "stub-cli");
  const argvLog = path.join(tmp, "argv.txt");

  fs.writeFileSync(stubBin, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\nexit 0\n`, {
    mode: 0o755,
  });

  const cliBin = assignments.cliBin ?? stubBin;
  // Quote each assignment so an empty string survives the heredoc — `_CLI_PATH=`
  // with nothing after it is a valid bash assignment to empty, but reads more
  // ambiguously than the explicit `_CLI_PATH=""` form.
  const cliPathAssignment =
    assignments.cliPath !== undefined ? `_CLI_PATH="${assignments.cliPath}"` : "";

  const snippet = `
    set -e
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
    _CLI_BIN="${cliBin}"
    ${cliPathAssignment}
    info() { :; }
    warn() { :; }
    error() { return 0; }
    command_exists() { return 1; }
    run_onboard >/dev/null 2>&1 || true
  `;

  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`shell exit ${result.status}: ${result.stderr}`);
  }

  const captured = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf-8") : "";
  return captured.split("\n").filter((line) => line.length > 0);
}

function runOnboardWithStubAtPath(
  env: Record<string, string>,
  cliBinName: string,
): { argv: string[]; argvLog: string; stubBin: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-onboard-clipath-"));
  const stubBin = path.join(tmp, "stub-cli");
  const argvLog = path.join(tmp, "argv.txt");

  fs.writeFileSync(stubBin, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\nexit 0\n`, {
    mode: 0o755,
  });

  const snippet = `
    set -e
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
    _CLI_BIN="${cliBinName}"
    _CLI_PATH="${stubBin}"
    info() { :; }
    warn() { :; }
    error() { return 0; }
    command_exists() { return 1; }
    run_onboard >/dev/null 2>&1 || true
  `;

  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`shell exit ${result.status}: ${result.stderr}`);
  }

  const captured = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf-8") : "";
  return {
    argv: captured.split("\n").filter((line) => line.length > 0),
    argvLog,
    stubBin,
  };
}

// Run run_onboard against a crafted ~/.nemoclaw/onboard-session.json so the
// session classifier path runs. Unlike the helpers above (which stub
// command_exists to false to skip classification), this keeps command_exists
// real so `command_exists node` is true and the real node classifier runs.
function runOnboardWithSession(
  env: Record<string, string>,
  session: Record<string, unknown>,
): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-onboard-session-"));
  const home = path.join(tmp, "home");
  const stubBin = path.join(tmp, "stub-cli");
  const argvLog = path.join(tmp, "argv.txt");
  fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(path.join(home, ".nemoclaw", "onboard-session.json"), JSON.stringify(session));
  fs.writeFileSync(
    stubBin,
    `#!/usr/bin/env bash\nprintf 'AUTO_FRESH=%s\\n' "\${NEMOCLAW_INSTALLER_AUTO_FRESH_RECEIPT_GENERATION:-}" > "${argvLog}"\nprintf '%s\\n' "$@" >> "${argvLog}"\nexit 0\n`,
    { mode: 0o755 },
  );

  const snippet = `
    set -e
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
    _CLI_BIN="${stubBin}"
    info() { :; }
    warn() { :; }
    error() { return 0; }
    run_onboard >/dev/null 2>&1 || true
  `;
  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: { ...process.env, ...env, HOME: home },
  });
  expect(result.status, result.stderr).toBe(0);
  const captured = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf-8") : "";
  return captured.split("\n").filter((line) => line.length > 0);
}

type FailedPromptMode = "non-interactive" | "unreadable-tty" | "read-failure";
type FailedSessionAgent = "" | "hermes" | "langchain-deepagents-code";

function runFailedSessionRecovery(mode: FailedPromptMode, agent: FailedSessionAgent = "") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-failed-recovery-"));
  const home = path.join(tmp, "home");
  const promptInput = path.join(tmp, "prompt-input.txt");
  const argvLog = path.join(tmp, "argv.txt");
  const cliName =
    agent === "hermes"
      ? "nemohermes"
      : agent === "langchain-deepagents-code"
        ? "nemo-deepagents"
        : "nemoclaw";
  const cliBin = path.join(tmp, cliName);
  fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".nemoclaw", "onboard-session.json"),
    JSON.stringify({
      status: "failed",
      resumable: true,
      failure: { step: "inference" },
    }),
  );
  fs.writeFileSync(promptInput, "");
  fs.writeFileSync(cliBin, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\n`, {
    mode: 0o755,
  });

  const snippet = `
    set -e
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
    _CLI_PATH=""
    show_usage_notice() { :; }
    info() { :; }
    warn() { :; }
    error() { printf 'ERROR: %s\\n' "$*" >&2; exit 1; }
    function [ {
      if [[ "$#" -eq 3 && "$1" = "-t" && "$2" = "0" && "$3" = "]" ]]; then
        if [[ "$PROMPT_MODE" = "read-failure" ]]; then return 0; fi
        return 1
      fi
      if [[ "$PROMPT_MODE" = "unreadable-tty" && "$#" -eq 4 && "$1" = "!" && "$2" = "-r" && "$3" = "/dev/tty" && "$4" = "]" ]]; then
        return 0
      fi
      builtin [ "$@"
    }
    run_onboard < "$PROMPT_INPUT_FILE"
  `;
  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: {
      ...process.env,
      FRESH: "",
      HOME: home,
      NEMOCLAW_AGENT: agent,
      NEMOCLAW_FRESH: "",
      NEMOCLAW_NON_INTERACTIVE: "",
      NON_INTERACTIVE: mode === "non-interactive" ? "1" : "",
      PATH: `${tmp}:${process.env.PATH ?? ""}`,
      PROMPT_INPUT_FILE: promptInput,
      PROMPT_MODE: mode,
    },
  });
  return {
    argvLog,
    output: `${result.stdout}${result.stderr}`,
    status: result.status,
  };
}

describe("install.sh run_onboard — session classification (#5626)", () => {
  it("starts fresh (not --resume) when interrupted before sandbox creation", () => {
    // in_progress with no sandboxName and an incomplete sandbox step: nothing
    // to resume, so auto-attaching --resume would dead-end at the CLI
    // non-interactive resume guard (#2753). Classifier must pick --fresh.
    const argv = runOnboardWithSession(
      { NON_INTERACTIVE: "1" },
      {
        version: 1,
        status: "in_progress",
        resumable: true,
        sandboxName: null,
        steps: { sandbox: { status: "pending" } },
      },
    );
    expect(argv).toContain("onboard");
    expect(argv).toContain("--fresh");
    expect(argv).not.toContain("--resume");
  });

  it("marks an automatic fresh reset to preserve a loaded Station receipt", () => {
    const generation = "0123456789abcdef0123456789abcdef";
    const argv = runOnboardWithSession(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_STATION_EXPRESS: "1",
        NEMOCLAW_STATION_EXPRESS_RECEIPT_GENERATION: generation,
      },
      {
        version: 1,
        status: "in_progress",
        resumable: true,
        sandboxName: null,
        stationExpressIntent: null,
        steps: { sandbox: { status: "pending" } },
      },
    );

    expect(argv).toContain("--fresh");
    expect(argv).toContain(`AUTO_FRESH=${generation}`);
  });

  it("does not mark an explicit fresh reset as receipt-preserving", () => {
    const generation = "0123456789abcdef0123456789abcdef";
    const argv = runOnboardWithSession(
      {
        FRESH: "1",
        NON_INTERACTIVE: "1",
        NEMOCLAW_STATION_EXPRESS: "1",
        NEMOCLAW_STATION_EXPRESS_RECEIPT_GENERATION: generation,
      },
      {
        version: 1,
        status: "in_progress",
        resumable: true,
        sandboxName: null,
        stationExpressIntent: null,
        steps: { sandbox: { status: "pending" } },
      },
    );

    expect(argv).toContain("--fresh");
    expect(argv).toContain("AUTO_FRESH=");
    expect(argv).not.toContain(`AUTO_FRESH=${generation}`);
  });

  it("still auto-resumes when a sandbox was already created", () => {
    // A sandbox exists to resume into (#2753's legitimate resume path), so the
    // classifier must keep auto-attaching --resume and never --fresh.
    const argv = runOnboardWithSession(
      { NON_INTERACTIVE: "1" },
      {
        version: 1,
        status: "in_progress",
        resumable: true,
        sandboxName: "my-assistant",
        steps: { sandbox: { status: "complete" } },
      },
    );
    expect(argv).toContain("--resume");
    expect(argv).not.toContain("--fresh");
  });

  it("resumes the exact Station receipt attempt before sandbox creation", () => {
    const generation = "0123456789abcdef0123456789abcdef";
    const argv = runOnboardWithSession(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_STATION_EXPRESS_RECEIPT_GENERATION: generation,
      },
      {
        version: 1,
        status: "in_progress",
        resumable: true,
        sandboxName: null,
        stationExpressIntent: {
          version: 1,
          model: "nemotron-3-ultra-550b-a55b",
          sandboxName: "my-assistant",
          receiptGeneration: generation,
        },
        steps: { sandbox: { status: "pending" } },
      },
    );

    expect(argv).toContain("--resume");
    expect(argv).not.toContain("--fresh");
  });

  it("preserves a mismatched Station receipt instead of automatically starting fresh", () => {
    const sessionGeneration = "0123456789abcdef0123456789abcdef";
    const receiptGeneration = "fedcba9876543210fedcba9876543210";
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-receipt-mismatch-"));
    const home = path.join(tmp, "home");
    const stateDir = path.join(home, ".nemoclaw");
    const receipt = path.join(stateDir, "station-express-resume");
    const argvLog = path.join(tmp, "argv.txt");
    const stubBin = path.join(tmp, "stub-cli");
    const receiptText =
      `revision=${"a".repeat(40)}\n` +
      "model=nemotron-3-ultra-550b-a55b\n" +
      `generation=${receiptGeneration}\n`;
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(stateDir, "onboard-session.json"),
      JSON.stringify({
        version: 1,
        status: "in_progress",
        resumable: true,
        sandboxName: null,
        stationExpressIntent: {
          version: 1,
          model: "nemotron-3-ultra-550b-a55b",
          sandboxName: "my-assistant",
          receiptGeneration: sessionGeneration,
        },
        steps: { sandbox: { status: "pending" } },
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(receipt, receiptText, { mode: 0o600 });
    fs.writeFileSync(stubBin, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\n`, {
      mode: 0o755,
    });

    try {
      const snippet = `
        set -e
        source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
        _CLI_BIN="${stubBin}"
        _CLI_PATH=""
        show_usage_notice() { :; }
        info() { :; }
        warn() { :; }
        error() { printf 'ERROR: %s\\n' "$*" >&2; exit 1; }
        run_onboard
      `;
      const result = spawnSync("bash", ["-c", snippet], {
        encoding: "utf-8",
        env: {
          ...process.env,
          FRESH: "",
          HOME: home,
          NEMOCLAW_FRESH: "",
          NEMOCLAW_STATION_EXPRESS_RECEIPT_GENERATION: receiptGeneration,
          NON_INTERACTIVE: "1",
        },
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status, output).toBe(1);
      expect(output).toContain("belongs to a different installer receipt");
      expect(fs.existsSync(argvLog)).toBe(false);
      expect(fs.readFileSync(receipt, "utf8")).toBe(receiptText);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "sandbox name without completed sandbox step",
      session: {
        version: 1,
        status: "in_progress",
        resumable: true,
        sandboxName: "phantom-box",
        steps: { sandbox: { status: "pending" } },
      },
    },
    {
      name: "completed sandbox step without sandbox name",
      session: {
        version: 1,
        status: "in_progress",
        resumable: true,
        sandboxName: null,
        steps: { sandbox: { status: "complete" } },
      },
    },
  ])("starts fresh for $name", ({ session }) => {
    const argv = runOnboardWithSession({ NON_INTERACTIVE: "1" }, session);
    expect(argv).toContain("--fresh");
    expect(argv).not.toContain("--resume");
  });

  it("does not resume or reset a completed session", () => {
    const argv = runOnboardWithSession(
      { NON_INTERACTIVE: "1" },
      {
        version: 1,
        status: "complete",
        resumable: false,
        sandboxName: "my-assistant",
      },
    );
    expect(argv).toContain("onboard");
    expect(argv).not.toContain("--resume");
    expect(argv).not.toContain("--fresh");
  });

  it("runs onboarding for a new Station receipt despite an older completed session", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-complete-receipt-"));
    const home = path.join(tmp, "home");
    const stateDir = path.join(home, ".nemoclaw");
    const receipt = path.join(stateDir, "station-express-resume");
    const argvLog = path.join(tmp, "argv.txt");
    const stubBin = path.join(tmp, "stub-cli");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(stateDir, "onboard-session.json"),
      JSON.stringify({ version: 1, status: "complete", resumable: false }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      receipt,
      "revision=0123456789012345678901234567890123456789\nmodel=nemotron-3-ultra-550b-a55b\ngeneration=0123456789abcdef0123456789abcdef\n",
      { mode: 0o600 },
    );
    fs.writeFileSync(stubBin, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\n`, {
      mode: 0o755,
    });
    const snippet = `
      set -e
      source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true
      _CLI_BIN="${stubBin}"
      _STATION_EXPRESS_RESUME_LOADED=1
      NON_INTERACTIVE=1
      show_usage_notice() { :; }
      info() { :; }
      warn() { :; }
      error() { printf 'ERROR: %s\\n' "$*" >&2; exit 1; }
      run_onboard
    `;

    const result = spawnSync("bash", ["-c", snippet], {
      encoding: "utf-8",
      env: { ...process.env, HOME: home, NEMOCLAW_GATEWAY_PORT: "8080" },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(receipt)).toBe(true);
    expect(fs.readFileSync(argvLog, "utf8").split("\n")).toContain("onboard");
  });
});

describe("install.sh run_onboard — failed-session recovery", () => {
  it.each([
    {
      mode: "unreadable-tty",
      name: "no prompt TTY is readable",
      error: "no TTY",
    },
    {
      mode: "read-failure",
      name: "reading prompt input fails",
      error: "Could not read",
    },
  ] as const)("shows both recovery commands when $name", ({ mode, error }) => {
    const { argvLog, output, status } = runFailedSessionRecovery(mode);
    expect(status).not.toBe(0);
    expect(output).toContain(error);
    expect(output).toContain("curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash -s -- --fresh");
    expect(output).toContain("nemoclaw onboard --resume");
    expect(fs.existsSync(argvLog)).toBe(false);
  });

  it.each([
    {
      agent: "hermes",
      cliName: "nemohermes",
      freshCommand:
        "curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_AGENT=hermes bash -s -- --fresh",
    },
    {
      agent: "langchain-deepagents-code",
      cliName: "nemo-deepagents",
      freshCommand:
        "curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_AGENT=langchain-deepagents-code bash -s -- --fresh",
    },
  ] as const)("preserves $agent in the fresh and resume commands", (testCase) => {
    const { argvLog, output, status } = runFailedSessionRecovery("non-interactive", testCase.agent);
    expect(status).not.toBe(0);
    expect(output).toContain(testCase.freshCommand);
    expect(output).toContain(`${testCase.cliName} onboard --resume`);
    expect(fs.existsSync(argvLog)).toBe(false);
  });
});

describe("install.sh run_onboard", () => {
  it("forwards --yes to nemoclaw onboard in non-interactive mode", () => {
    const argv = runOnboardWithMockCli({ NON_INTERACTIVE: "1" });
    expect(argv).toContain("onboard");
    expect(argv).toContain("--non-interactive");
    expect(argv).toContain("--yes");
  });

  it("forwards --yes-i-accept-third-party-software when the env opt-in is set", () => {
    const argv = runOnboardWithMockCli({
      NON_INTERACTIVE: "1",
      ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    });
    expect(argv).toContain("--yes-i-accept-third-party-software");
    expect(argv).toContain("--yes");
  });

  it("forwards the portable profile to the actual onboard command", () => {
    const argv = runOnboardWithMockCli({
      NON_INTERACTIVE: "1",
      NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
    });
    expect(argv).toEqual(expect.arrayContaining(["onboard", "--experimental-profile", "portable"]));
  });
});

describe("install.sh run_onboard — _CLI_PATH precedence (#3276)", () => {
  it("invokes via _CLI_PATH (absolute path) when set, ignoring _CLI_BIN", () => {
    // Repro: stale PATH cache. _CLI_BIN does not resolve by name, but
    // _CLI_PATH points at the real binary on disk. The fallback
    // `"${_CLI_PATH:-$_CLI_BIN}"` must pick _CLI_PATH so auto-onboarding
    // doesn't silently skip.
    const { argv, argvLog } = runOnboardWithStubAtPath(
      { NON_INTERACTIVE: "1" },
      "nemoclaw-not-on-path",
    );
    expect(fs.existsSync(argvLog)).toBe(true);
    expect(argv).toContain("onboard");
    expect(argv).toContain("--non-interactive");
    expect(argv).toContain("--yes");
  });

  it("falls back to _CLI_BIN when _CLI_PATH is empty (pin the fallback)", () => {
    // Explicit empty _CLI_PATH must route through _CLI_BIN so a future
    // refactor cannot silently drop the `"${_CLI_PATH:-$_CLI_BIN}"` form.
    const argv = runOnboardWithMockCli({ NON_INTERACTIVE: "1" }, { cliPath: "" });
    expect(argv).toContain("onboard");
    expect(argv).toContain("--non-interactive");
    expect(argv).toContain("--yes");
  });
});

type DeferredOnboardingMainOptions = {
  agent?: string;
  deferEnv?: boolean;
  deferFlag?: boolean;
  inferenceKey?: string;
  nvidiaApiKey?: string;
  onboardStatus?: number;
  provider?: string;
  providerKey?: string;
  registeredSandboxCount?: number;
};

function runDeferredOnboardingMain(options: DeferredOnboardingMainOptions = {}) {
  const registeredSandboxCount = options.registeredSandboxCount ?? 0;
  const result = runInstallerSourcedBody(
    `
set -e
record() { printf '%s\n' "$1" >>"$HOME/calls.log"; }
load_station_vllm_conflict_helpers() { :; }
consume_station_local_vllm_resume() { return 1; }
resolve_nemoclaw_gateway_port() { printf '8080'; }
preflight_explicit_express_flags() { :; }
print_banner() { :; }
preflight_usage_notice_prompt() { :; }
prepare_installer_host() { record prepare-installer-host; }
bash() { :; }
step() { record "step-$1-$2"; }
install_nodejs() { :; }
ensure_supported_runtime() { :; }
resolve_pending_express_wsl_provider() { :; }
ensure_station_express_pair() { :; }
fix_npm_permissions() { :; }
preinstall_backup_and_retire_legacy_gateway() { :; }
install_nemoclaw() { record install-nemoclaw; }
verify_nemoclaw() {
  _CLI_PATH="/usr/bin/true"
  NEMOCLAW_READY_NOW=true
}
require_reportable_openshell_version() { :; }
registered_sandbox_count() { printf '%s\n' "$REGISTERED_SANDBOX_COUNT"; }
run_installer_host_preflight() { record host-preflight; return 0; }
recover_preexisting_sandboxes_before_onboard() {
  record recover-preexisting
  if [[ "$REGISTERED_SANDBOX_COUNT" != "0" ]]; then
    _PREEXISTING_SANDBOX_RECOVERY_RAN=true
  fi
  return 0
}
run_onboard() {
  record onboard
  printf '%s\n' "$*" >"$HOME/onboard-args.log"
  return "$ONBOARD_STATUS"
}
restore_onboard_forward_after_post_checks() { record restore-forward; return 0; }
needs_shell_reload() { return 1; }
detect_shell_profile() { printf '%s' "$HOME/.profile"; }
clear_station_resume_after_completed_onboarding() { :; }
main --non-interactive --yes-i-accept-third-party-software ${options.deferFlag ? "--defer-onboarding" : ""}
`,
    {
      extraEnv: {
        NEMOCLAW_AGENT: options.agent ?? "hermes",
        NEMOCLAW_DEFER_ONBOARDING: options.deferEnv ? "1" : "",
        NVIDIA_INFERENCE_API_KEY: options.inferenceKey ?? "",
        NVIDIA_API_KEY: options.nvidiaApiKey ?? "",
        NEMOCLAW_PROVIDER: options.provider ?? "",
        NEMOCLAW_PROVIDER_KEY: options.providerKey ?? "",
        ONBOARD_STATUS: String(options.onboardStatus ?? 0),
        REGISTERED_SANDBOX_COUNT: String(registeredSandboxCount),
      },
      includeNodeOnPath: true,
      timeoutMs: 15_000,
    },
  );
  onTestFinished(result.remove);

  const callsPath = path.join(result.home, "calls.log");
  const calls = fs.existsSync(callsPath)
    ? fs.readFileSync(callsPath, "utf-8").trim().split(/\r?\n/).filter(Boolean)
    : [];
  return {
    ...result,
    calls,
  };
}

describe("Hermes deferred onboarding", () => {
  it("lists the installer option and environment setting (#10288)", () => {
    const result = runInstallerSourcedBody("usage", {
      extraEnv: { NEMOCLAW_AGENT: "hermes" },
    });
    onTestFinished(result.remove);

    expect(result.result.status, result.output).toBe(0);
    expect(result.output).toContain("--defer-onboarding");
    expect(result.output).toContain("NEMOCLAW_DEFER_ONBOARDING=1");
    expect(result.output.match(/NEMOCLAW_AGENT=hermes/g)).toHaveLength(2);
    expect(result.output.match(/no registered sandboxes/g)).toHaveLength(2);
    expect(result.output.match(/no local model profile/g)).toHaveLength(2);
    expect(result.output.match(/build, cloud, or routed NVIDIA hosted provider/g)).toHaveLength(2);
  });

  it.each([
    ["installer option", { deferFlag: true }],
    ["environment setting", { deferEnv: true }],
  ])(
    "installs without onboarding when credentials are absent through the %s (#10288)",
    (_name, input) => {
      const result = runDeferredOnboardingMain(input);

      expect(result.result.status, result.output).toBe(0);
      expect(result.calls).toContain("install-nemoclaw");
      expect(result.calls).not.toContain("host-preflight");
      expect(result.calls).not.toContain("onboard");
      expect(result.output).toContain("NVIDIA inference credentials are absent");
      expect(result.output).toContain("Onboarding did not run");
      expect(result.output).toContain("nemohermes onboard");
    },
  );

  it.each(["build", "routed", "custom"])(
    "treats the %s provider key as a selector when credentials are absent (#10288)",
    (providerKey) => {
      const result = runDeferredOnboardingMain({ deferFlag: true, providerKey });

      expect(result.result.status, result.output).toBe(0);
      expect(result.calls).toContain("install-nemoclaw");
      expect(result.calls).not.toContain("host-preflight");
      expect(result.calls).not.toContain("onboard");
      expect(result.output).toContain("NVIDIA inference credentials are absent");
      expect(result.output).toContain("Onboarding did not run");
      expect(result.output).toContain("nemohermes onboard");
    },
  );

  it.each([
    ["NVIDIA_INFERENCE_API_KEY", { inferenceKey: "nvapi-primary-runtime-test" }],
    ["NVIDIA_API_KEY", { nvidiaApiKey: "nvapi-alias-runtime-test" }],
    ["NEMOCLAW_PROVIDER_KEY", { providerKey: "nvapi-bridge-runtime-test" }],
  ])("runs normal onboarding when %s supplies a credential (#10288)", (_name, input) => {
    const credential = Object.values(input)[0];
    const result = runDeferredOnboardingMain({ deferFlag: true, ...input });

    expect(result.result.status, result.output).toBe(0);
    expect(result.calls).toContain("host-preflight");
    expect(result.calls).toContain("onboard");
    expect(result.calls).toContain("restore-forward");
    expect(result.output).not.toContain(credential);
    expect(fs.readFileSync(path.join(result.home, "onboard-args.log"), "utf-8")).not.toContain(
      credential,
    );
  });

  it("propagates the onboarding failure when a credential is provided (#10288)", () => {
    const invalidKey = "invalid-runtime-test-value";
    const result = runDeferredOnboardingMain({
      deferFlag: true,
      inferenceKey: invalidKey,
      onboardStatus: 1,
    });

    expect(result.result.status).toBe(1);
    expect(result.calls).toContain("host-preflight");
    expect(result.calls).toContain("onboard");
    expect(result.output).toContain("Onboarding did not complete successfully");
    expect(result.output).not.toContain(invalidKey);
  });

  it("keeps the missing-credential failure when deferred onboarding is not enabled (#10288)", () => {
    const result = runDeferredOnboardingMain({ onboardStatus: 1 });

    expect(result.result.status).toBe(1);
    expect(result.calls).toContain("onboard");
    expect(result.output).toContain("Onboarding did not complete successfully");
  });

  it("keeps existing sandbox recovery on the normal installer path (#10288)", () => {
    const result = runDeferredOnboardingMain({ deferFlag: true, registeredSandboxCount: 1 });

    expect(result.result.status, result.output).toBe(0);
    expect(result.calls).toContain("host-preflight");
    expect(result.calls).toContain("recover-preexisting");
    expect(result.calls).not.toContain("onboard");
  });

  it.each([
    ["OpenClaw", { agent: "openclaw" }, "NEMOCLAW_AGENT=hermes"],
    ["a non-NVIDIA provider", { provider: "openai" }, "NVIDIA hosted inference only"],
  ])(
    "rejects deferred Hermes onboarding for %s before installation (#10288)",
    (_name, input, expected) => {
      const result = runDeferredOnboardingMain({ deferFlag: true, ...input });

      expect(result.result.status).toBe(1);
      expect(result.output).toContain(expected);
      expect(result.calls).not.toContain("prepare-installer-host");
      expect(result.calls).not.toContain("install-nemoclaw");
      expect(result.calls).not.toContain("onboard");
    },
  );
});
