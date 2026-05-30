// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stageOptimizedSandboxBuildContext } from "../dist/lib/sandbox/build-context.js";
import { testTimeoutOptions } from "./helpers/timeouts";

type ShimScalar = string | number | boolean | null | undefined;
type ShimCallable = (...args: readonly string[]) => ShimValue;
type ShimValue = ShimScalar | { [key: string]: ShimValue } | ShimValue[] | ShimCallable;
type ShimFn<TReturn = void> = (...args: ShimValue[]) => TReturn;
type CommandEntry = {
  command: string;
  env?: Record<string, string | undefined>;
  policyContent?: string;
  policyReadError?: string;
  dockerfileContent?: string;
  dockerfileReadError?: string;
};
type ResumeConflict = { field: string; requested: string | null; recorded: string | null };

type OnboardTestInternals = {
  getNavigationChoice: (value?: string | null) => string | null;
  getFutureShellPathHint: (binDir: string, pathValue?: string) => string | null;
  getRequestedModelHint: ShimFn<string | null>;
  getRequestedProviderHint: ShimFn<string | null>;
  getRequestedSandboxNameHint: ShimFn<string | null>;
  getResumeConfigConflicts: ShimFn<ResumeConflict[]>;
  getResumeSandboxConflict: ShimFn<{
    requestedSandboxName: string;
    recordedSandboxName: string;
  } | null>;
  clearAgentScopedResumeState: <T extends Record<string, unknown>>(
    session: T,
    selectedAgentName: string,
  ) => T;
  pullAndResolveBaseImageDigest: () => { digest: string | null; ref: string } | null;
  SANDBOX_BASE_IMAGE: string;
};

function parseStdoutJson<T>(stdout: string): T {
  const line = stdout.trim().split("\n").pop();
  assert.ok(line, `expected JSON payload in stdout:\n${stdout}`);
  return JSON.parse(line);
}

function stripMessagingEnv(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const env = { ...source } as Record<string, string | undefined>;
  for (const key of Object.keys(env)) {
    if (key.startsWith("DISCORD_") || key.startsWith("TELEGRAM_")) {
      delete env[key];
    }
  }
  return env;
}

type OnboardTestInternalsCandidate = Partial<OnboardTestInternals> | null;

function isOnboardTestInternals(
  value: OnboardTestInternalsCandidate,
): value is OnboardTestInternals {
  return value !== null && typeof value.getNavigationChoice === "function";
}

const loadedOnboardInternals = require("../dist/lib/onboard");
const onboardTestInternals =
  typeof loadedOnboardInternals === "object" && loadedOnboardInternals !== null
    ? loadedOnboardInternals
    : null;
if (!isOnboardTestInternals(onboardTestInternals)) {
  throw new Error("Expected onboard test internals to expose helper functions");
}

const {
  getNavigationChoice,
  getFutureShellPathHint,
  getRequestedModelHint,
  getRequestedProviderHint,
  getRequestedSandboxNameHint,
  getResumeConfigConflicts,
  getResumeSandboxConflict,
  clearAgentScopedResumeState,
  SANDBOX_BASE_IMAGE,
} = onboardTestInternals;

const repoRoot = path.join(import.meta.dirname, "..");
const onboardScriptMocksPath = JSON.stringify(
  path.join(repoRoot, "test", "helpers", "onboard-script-mocks.cjs"),
);

describe("onboard helpers", () => {
  it("prints doctor logs automatically when gateway fails to start (#1605)", testTimeoutOptions(20_000), () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-diag-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "gateway-diag.cjs");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    // Fake openshell:
    //   gateway start  — emits ANSI color codes + \r\n (mirrors real gateway output), exits 1
    //   doctor logs    — emits ANSI sequences, an OOMKilled message, and a fake nvapi- credential
    //                    to exercise ANSI stripping and redaction in the doctor-log path
    fs.writeFileSync(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [[ "$*" == *"doctor"*"logs"* ]]; then
  printf "\\033[31mERROR\\033[0m k3s cluster crashed: OOMKilled\\r\\n"
  printf "  Container nemoclaw_k3s ran out of memory\\r\\n"
  printf "  Gateway auth token: nvapi-fakecredential-9999\\r\\n"
  exit 0
fi
if [[ "$*" == "gateway --help" ]]; then
  printf "Commands: start destroy\\n"
  exit 0
fi
if [[ "$*" == *"gateway"*"start"* ]]; then
  printf "\\033[33mDeploying\\033[0m gateway nemoclaw...\\r\\n"
  printf "\\r\\nWaiting for gateway health...\\r\\n"
  exit 1
fi
exit 1
`,
      { mode: 0o755 },
    );

    // Script runs in a child process: patching p-retry to be immediate avoids the
    // 10 s + 30 s minTimeout delays, and NEMOCLAW_HEALTH_POLL_COUNT=0 skips the
    // health-poll loop so the function throws "Gateway failed to start" on the
    // first attempt. With exitOnFailure:true the catch block should auto-print
    // doctor logs to stderr and then call process.exit(1).
    const script = `
const mod = require("module");
const origLoad = mod._load;
mod._load = function(req, parent, isMain) {
  if (req === "p-retry") {
    return async (fn, opts) => {
      try {
        return await fn({ attemptNumber: 1, retriesLeft: 0 });
      } catch (e) {
        if (opts && opts.onFailedAttempt) {
          opts.onFailedAttempt(Object.assign(e, { attemptNumber: 1, retriesLeft: 0 }));
        }
        throw e;
      }
    };
  }
  return origLoad.call(this, req, parent, isMain);
};
Object.defineProperty(process, "platform", { value: "freebsd" });
const { startGateway } = require(${onboardPath});
startGateway(null).catch(() => {});
`;
    fs.writeFileSync(scriptPath, script);

    const nodeExec = process.execPath;
    const result = spawnSync(nodeExec, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_HEALTH_POLL_COUNT: "0",
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    // The process exits 1 because startGateway calls process.exit(1) on failure.
    assert.equal(result.status, 1, `unexpected exit code; stderr:\n${result.stderr}`);

    // Fix 3: doctor logs are auto-printed to stderr.
    assert.ok(
      result.stderr.includes("Gateway logs:"),
      `expected "Gateway logs:" header in stderr:\n${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes("OOMKilled"),
      `expected doctor log output in stderr:\n${result.stderr}`,
    );

    // ANSI sequences must be stripped from both stdout (gateway start output) and
    // stderr (doctor logs). A raw \x1b in the output means the regex failed.
    assert.ok(
      !result.stdout.includes("\x1b"),
      `unexpected ANSI escape in stdout:\n${result.stdout}`,
    );
    assert.ok(
      !result.stderr.includes("\x1b"),
      `unexpected ANSI escape in stderr:\n${result.stderr}`,
    );

    // Credentials in doctor logs must be redacted, never printed verbatim.
    assert.ok(
      !result.stderr.includes("nvapi-fakecredential-9999"),
      `credential leaked verbatim in stderr:\n${result.stderr}`,
    );

    // Fix 2: the \r\n -> \naiting rendering artifact must not appear.
    assert.ok(
      !result.stdout.includes("\naiting"),
      `\\naiting artifact present in stdout:\n${result.stdout}`,
    );

    // Fix 1: gateway start output is printed per-line under the header, not as
    // one collapsed blob. "Deploying" and "Waiting" must appear on separate lines.
    const gatewayLines = result.stdout
      .split("\n")
      .filter((l) => l.includes("Deploying") || l.includes("Waiting"));
    assert.ok(
      gatewayLines.length >= 2,
      `expected "Deploying" and "Waiting" on separate lines in stdout:\n${result.stdout}`,
    );
  });

  it("normalizes sandbox name hints from the environment", () => {
    const previous = process.env.NEMOCLAW_SANDBOX_NAME;
    process.env.NEMOCLAW_SANDBOX_NAME = "  My-Assistant  ";
    try {
      expect(getRequestedSandboxNameHint()).toBe("my-assistant");
    } finally {
      if (previous === undefined) {
        delete process.env.NEMOCLAW_SANDBOX_NAME;
      } else {
        process.env.NEMOCLAW_SANDBOX_NAME = previous;
      }
    }
  });

  it("prefers the explicit --name option over NEMOCLAW_SANDBOX_NAME", () => {
    const previous = process.env.NEMOCLAW_SANDBOX_NAME;
    process.env.NEMOCLAW_SANDBOX_NAME = "from-env";
    try {
      expect(getRequestedSandboxNameHint({ sandboxName: "From-Flag" })).toBe("from-flag");
    } finally {
      if (previous === undefined) {
        delete process.env.NEMOCLAW_SANDBOX_NAME;
      } else {
        process.env.NEMOCLAW_SANDBOX_NAME = previous;
      }
    }
  });

  it("detects resume conflicts when --name does not match the recorded sandbox", () => {
    expect(
      getResumeConfigConflicts(
        { sandboxName: "my-assistant", steps: { sandbox: { status: "complete" } } },
        { sandboxName: "second-assistant" },
      ),
    ).toEqual([
      {
        field: "sandbox",
        requested: "second-assistant",
        recorded: "my-assistant",
      },
    ]);
  });

  it("detects resume conflicts when a different sandbox is requested", () => {
    expect(
      getResumeSandboxConflict(
        { sandboxName: "my-assistant", steps: { sandbox: { status: "complete" } } },
        { sandboxName: "other-sandbox" },
      ),
    ).toEqual({
      requestedSandboxName: "other-sandbox",
      recordedSandboxName: "my-assistant",
    });
    expect(
      getResumeSandboxConflict(
        { sandboxName: "other-sandbox", steps: { sandbox: { status: "complete" } } },
        { sandboxName: "other-sandbox" },
      ),
    ).toBe(null);
  });

  it("does not fire a resume conflict from NEMOCLAW_SANDBOX_NAME alone", () => {
    // Interactive resume runs never consult the env var (sandbox creation
    // is already complete in the session, so promptOrDefault is skipped).
    // Reading it here would surface a spurious conflict whenever a user
    // happens to export NEMOCLAW_SANDBOX_NAME in their shell rc.
    const previous = process.env.NEMOCLAW_SANDBOX_NAME;
    process.env.NEMOCLAW_SANDBOX_NAME = "other-sandbox";
    try {
      expect(
        getResumeSandboxConflict({
          sandboxName: "my-assistant",
          steps: { sandbox: { status: "complete" } },
        }),
      ).toBe(null);
    } finally {
      if (previous === undefined) {
        delete process.env.NEMOCLAW_SANDBOX_NAME;
      } else {
        process.env.NEMOCLAW_SANDBOX_NAME = previous;
      }
    }
  });

  it("#2753: ignores an incomplete session sandbox name when checking resume conflicts", () => {
    // A pre-fix on-disk session may carry sandboxName even though the
    // sandbox step never completed. Treating that as a conflict source
    // would block users from running `--resume --name <new>` to recover.
    expect(
      getResumeSandboxConflict(
        { sandboxName: "interrupt-test", steps: { sandbox: { status: "pending" } } },
        { sandboxName: "fresh-name" },
      ),
    ).toBe(null);
    expect(
      getResumeConfigConflicts(
        { sandboxName: "interrupt-test", steps: { sandbox: { status: "pending" } } },
        { sandboxName: "fresh-name" },
      ),
    ).toEqual([]);
  });

  it("returns provider and model hints only for non-interactive runs", () => {
    const previousProvider = process.env.NEMOCLAW_PROVIDER;
    const previousModel = process.env.NEMOCLAW_MODEL;
    process.env.NEMOCLAW_PROVIDER = "cloud";
    process.env.NEMOCLAW_MODEL = "nvidia/test-model";
    try {
      expect(getRequestedProviderHint(true)).toBe("build");
      expect(getRequestedModelHint(true)).toBe("nvidia/test-model");
      expect(getRequestedProviderHint(false)).toBe(null);
      expect(getRequestedModelHint(false)).toBe(null);
    } finally {
      if (previousProvider === undefined) {
        delete process.env.NEMOCLAW_PROVIDER;
      } else {
        process.env.NEMOCLAW_PROVIDER = previousProvider;
      }
      if (previousModel === undefined) {
        delete process.env.NEMOCLAW_MODEL;
      } else {
        process.env.NEMOCLAW_MODEL = previousModel;
      }
    }
  });

  it("detects resume conflicts for explicit provider and model changes", () => {
    const previousProvider = process.env.NEMOCLAW_PROVIDER;
    const previousModel = process.env.NEMOCLAW_MODEL;
    process.env.NEMOCLAW_PROVIDER = "cloud";
    process.env.NEMOCLAW_MODEL = "nvidia/other-model";
    try {
      // Provider conflict uses a two-stage alias chain in non-interactive mode:
      // "cloud" first resolves to the requested hint, then that hint resolves
      // to the effective provider name "nvidia-prod" for conflict comparison.
      expect(
        getResumeConfigConflicts(
          {
            sandboxName: "my-assistant",
            provider: "nvidia-nim",
            model: "nvidia/nemotron-3-super-120b-a12b",
          },
          { nonInteractive: true },
        ),
      ).toEqual([
        {
          field: "provider",
          requested: "nvidia-prod",
          recorded: "nvidia-nim",
        },
        {
          field: "model",
          requested: "nvidia/other-model",
          recorded: "nvidia/nemotron-3-super-120b-a12b",
        },
      ]);
    } finally {
      if (previousProvider === undefined) {
        delete process.env.NEMOCLAW_PROVIDER;
      } else {
        process.env.NEMOCLAW_PROVIDER = previousProvider;
      }
      if (previousModel === undefined) {
        delete process.env.NEMOCLAW_MODEL;
      } else {
        process.env.NEMOCLAW_MODEL = previousModel;
      }
    }
  });

  it("does not treat a requested agent change as a hard resume conflict", () => {
    expect(
      getResumeConfigConflicts(
        {
          sandboxName: "my-assistant",
          agent: "openclaw",
        },
        { agent: "hermes" },
      ),
    ).toEqual([]);
  });

  it("allows resume when requested agent matches recorded agent", () => {
    expect(
      getResumeConfigConflicts(
        {
          sandboxName: "my-assistant",
          agent: "hermes",
        },
        { agent: "hermes" },
      ),
    ).toEqual([]);
  });

  it("clears agent-scoped provider state when a resume switches from Hermes to OpenClaw", () => {
    const completeStep = {
      status: "complete",
      startedAt: "2026-05-19T00:00:00.000Z",
      completedAt: "2026-05-19T00:01:00.000Z",
      error: null,
    };
    const session = {
      agent: "hermes",
      provider: "hermes-provider",
      model: "moonshotai/kimi-k2.6",
      endpointUrl: "https://inference-api.nousresearch.com/v1",
      credentialEnv: "NOUS_API_KEY",
      hermesAuthMethod: "oauth",
      hermesToolGateways: ["nous-web"],
      preferredInferenceApi: "openai-completions",
      nimContainer: "nim-hermes",
      routerPid: 123,
      routerCredentialHash: "hash",
      policyPresets: ["nous-web", "brave"],
      lastCompletedStep: "policies",
      lastStepStarted: "policies",
      steps: {
        preflight: { ...completeStep },
        gateway: { ...completeStep },
        provider_selection: { ...completeStep },
        inference: { ...completeStep },
        sandbox: { ...completeStep },
        openclaw: { ...completeStep },
        agent_setup: { ...completeStep },
        policies: { ...completeStep },
      },
    };

    const cleared = clearAgentScopedResumeState(session, "openclaw") as typeof session;

    expect(cleared.agent).toBeNull();
    expect(cleared.provider).toBeNull();
    expect(cleared.model).toBeNull();
    expect(cleared.endpointUrl).toBeNull();
    expect(cleared.credentialEnv).toBeNull();
    expect(cleared.hermesAuthMethod).toBeNull();
    expect(cleared.hermesToolGateways).toBeNull();
    expect(cleared.preferredInferenceApi).toBeNull();
    expect(cleared.nimContainer).toBeNull();
    expect(cleared.routerPid).toBeNull();
    expect(cleared.routerCredentialHash).toBeNull();
    expect(cleared.policyPresets).toBeNull();
    expect(cleared.steps.gateway.status).toBe("complete");
    expect(cleared.steps.provider_selection.status).toBe("pending");
    expect(cleared.steps.sandbox.status).toBe("pending");
    expect(cleared.steps.policies.status).toBe("pending");
    expect(cleared.lastCompletedStep).toBe("gateway");
    expect(cleared.lastStepStarted).toBeNull();
  });

  it("returns a future-shell PATH hint for user-local openshell installs", () => {
    expect(getFutureShellPathHint("/home/test/.local/bin", "/usr/local/bin:/usr/bin")).toBe(
      'export PATH="/home/test/.local/bin:$PATH"',
    );
  });

  it("skips the future-shell PATH hint when the bin dir is already on PATH", () => {
    expect(
      getFutureShellPathHint(
        "/home/test/.local/bin",
        "/home/test/.local/bin:/usr/local/bin:/usr/bin",
      ),
    ).toBe(null);
  });

  it("stages only the files required to build the sandbox image", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-context-"));

    try {
      const { buildCtx, stagedDockerfile } = stageOptimizedSandboxBuildContext(repoRoot, tmpDir);

      expect(stagedDockerfile).toBe(path.join(buildCtx, "Dockerfile"));
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw", "package-lock.json"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw", "src"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw-blueprint", ".venv"))).toBe(false);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "nemoclaw-start.sh"))).toBe(true);
      expect(fs.existsSync(path.join(buildCtx, "scripts", "patch-openclaw-tool-catalog.js"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(buildCtx, "scripts", "setup.sh"))).toBe(false);
      expect(fs.existsSync(path.join(buildCtx, "nemoclaw", "node_modules"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("getNavigationChoice recognizes back and exit commands case-insensitively", () => {
    expect(getNavigationChoice("back")).toBe("back");
    expect(getNavigationChoice("BACK")).toBe("back");
    expect(getNavigationChoice("  Back  ")).toBe("back");
    expect(getNavigationChoice("exit")).toBe("exit");
    expect(getNavigationChoice("quit")).toBe("exit");
    expect(getNavigationChoice("QUIT")).toBe("exit");
    expect(getNavigationChoice("")).toBeNull();
    expect(getNavigationChoice("something")).toBeNull();
    expect(getNavigationChoice(null)).toBeNull();
  });

  it("rejects sandbox names starting with a digit", () => {
    // The validation regex must require names to start with a letter,
    // not a digit — Kubernetes rejects digit-prefixed names downstream.
    const SANDBOX_NAME_REGEX = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

    expect(SANDBOX_NAME_REGEX.test("my-assistant")).toBe(true);
    expect(SANDBOX_NAME_REGEX.test("a")).toBe(true);
    expect(SANDBOX_NAME_REGEX.test("agent-1")).toBe(true);
    expect(SANDBOX_NAME_REGEX.test("test-sandbox-v2")).toBe(true);

    expect(SANDBOX_NAME_REGEX.test("7racii")).toBe(false);
    expect(SANDBOX_NAME_REGEX.test("1sandbox")).toBe(false);
    expect(SANDBOX_NAME_REGEX.test("123")).toBe(false);
    expect(SANDBOX_NAME_REGEX.test("-start-hyphen")).toBe(false);
    expect(SANDBOX_NAME_REGEX.test("end-hyphen-")).toBe(false);
    expect(SANDBOX_NAME_REGEX.test("")).toBe(false);
  });

  it("passes credential names to openshell without embedding secret values in argv", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-inference-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-inference-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "state", "registry.js"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: nvidia-nim",
      "  Model: nvidia/nemotron-3-super-120b-a12b",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.NVIDIA_API_KEY = "nvapi-secret-value";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "nvidia/nemotron-3-super-120b-a12b", "nvidia-nim");
  console.log(JSON.stringify({ commands, nvidiaApiKey: process.env.NVIDIA_API_KEY || null }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    expect(result.status).toBe(0);
    const payload = parseStdoutJson<{ commands: CommandEntry[]; nvidiaApiKey: string | null }>(
      result.stdout,
    );
    const commands = payload.commands;
    assert.equal(commands.length, 4);
    assert.match(commands[0].command, /gateway select nemoclaw/);
    assert.match(commands[1].command, /provider get/);
    assert.match(commands[2].command, /--credential NVIDIA_API_KEY/);
    assert.doesNotMatch(commands[2].command, /nvapi-secret-value/);
    assert.match(commands[2].command, /provider update/);
    assert.match(commands[3].command, /inference set/);
    assert.equal(payload.nvidiaApiKey, "nvapi-secret-value");
  });

  it("reuses a registered Hermes Provider without re-collecting host credentials", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-hermes-reuse-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-hermes-reuse-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  const normalized = _n(command);
  commands.push({ command: normalized, env: opts.env || null });
  if (normalized.includes("provider get hermes-provider")) {
    return { status: 0, stdout: "Provider: hermes-provider", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: hermes-provider",
      "  Model: moonshotai/kimi-k2.6",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.NOUS_API_KEY = "nous-host-secret";
process.env.OPENAI_API_KEY = "openai-host-secret";
process.env.NEMOCLAW_NON_INTERACTIVE = "1";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "moonshotai/kimi-k2.6", "hermes-provider", "https://inference-api.nousresearch.com/v1", "OPENAI_API_KEY", "oauth");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    expect(result.status).toBe(0);
    const commands = parseStdoutJson<CommandEntry[]>(result.stdout);
    assert.equal(commands.length, 4);
    assert.match(commands[0].command, /gateway select nemoclaw/);
    assert.match(commands[1].command, /provider list/);
    assert.match(commands[2].command, /provider get hermes-provider/);
    assert.match(commands[3].command, /inference set --no-verify --provider hermes-provider/);
    assert.ok(!commands.some((entry) => /provider (create|update)/.test(entry.command)));
    assert.ok(!commands.some((entry) => entry.env?.NOUS_API_KEY || entry.env?.OPENAI_API_KEY));
    assert.ok(
      !commands.some((entry) => /nous-host-secret|openai-host-secret/.test(entry.command)),
      "host credential values must not appear in argv",
    );
  });

  it("routes Bedrock Runtime custom Anthropic endpoints through the hidden OpenAI adapter", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-bedrock-runtime-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-bedrock-runtime-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const adapterPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "inference", "bedrock-runtime-adapter.js"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const adapter = require(${adapterPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");

const commands = [];
runner.run = (command, opts = {}) => {
  const normalized = _n(command);
  commands.push({ command: normalized, env: opts.env || null });
  if (normalized.includes("provider get compatible-anthropic-endpoint")) {
    return { status: 1, stdout: "", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: compatible-anthropic-endpoint",
      "  Model: anthropic.claude-3-5-sonnet-20240620-v1:0",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;
adapter.ensureBedrockRuntimeAdapter = async ({ classification, compatibleCredential }) => ({
  baseUrl: "http://host.openshell.internal:11436/v1",
  localBaseUrl: "http://127.0.0.1:11436/v1",
  credentialEnv: "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN",
  token: "adapter-token",
  region: classification.region,
  compatibleCredential,
});

process.env.COMPATIBLE_ANTHROPIC_API_KEY = "bedrock-bearer";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference(
    "test-box",
    "anthropic.claude-3-5-sonnet-20240620-v1:0",
    "compatible-anthropic-endpoint",
    "https://bedrock-runtime.us-east-1.amazonaws.com",
    "COMPATIBLE_ANTHROPIC_API_KEY",
  );
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    expect(result.status).toBe(0);
    const commands = parseStdoutJson<CommandEntry[]>(result.stdout);
    const providerCommand = commands.find((entry) => /provider create/.test(entry.command));
    assert.ok(providerCommand, "expected hidden adapter provider registration");
    assert.match(providerCommand.command, /--name compatible-anthropic-endpoint/);
    assert.match(providerCommand.command, /--type openai/);
    assert.match(providerCommand.command, /--credential NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN/);
    assert.match(
      providerCommand.command,
      /OPENAI_BASE_URL=http:\/\/host\.openshell\.internal:11436\/v1/,
    );
    assert.equal(providerCommand.env?.NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN, "adapter-token");
    assert.ok(
      !JSON.stringify(commands).includes("bedrock-bearer"),
      "Bedrock bearer token must not appear in OpenShell argv or env",
    );
    const sandboxCommands = commands.filter((entry) => /\bsandbox\b/.test(entry.command));
    assert.ok(
      !sandboxCommands.some((entry) =>
        JSON.stringify(entry).includes("NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN"),
      ),
      "adapter credential env must not be passed to sandbox commands",
    );
    assert.ok(
      !sandboxCommands.some((entry) => JSON.stringify(entry).includes("adapter-token")),
      "adapter token must not be passed to sandbox commands",
    );
    assert.ok(
      !result.stderr.includes("bedrock-bearer") && !result.stderr.includes("adapter-token"),
      "Bedrock tokens must not appear in onboarding stderr",
    );
    assert.match(
      commands.at(-1)?.command || "",
      /inference set --no-verify --provider compatible-anthropic-endpoint --model anthropic\.claude-3-5-sonnet-20240620-v1:0/,
    );
  });

  it("resolves a sandbox name before reconciling Hermes Provider on resume", { timeout: 60_000 }, () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-hermes-resume-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "hermes-resume-sandbox-name-check.js");
    const openshellPath = JSON.stringify(path.join(fakeBin, "openshell"));
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const sessionPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "state", "onboard-session.js"),
    );
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));
    const nimPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "inference", "nim.js"));
    const gatewayStatePath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "gateway.js"));
    const dockerDriverPlatformPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "onboard", "docker-driver-platform.js"),
    );
    const gatewayGpuPassthroughPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "onboard", "gateway-gpu-passthrough.js"),
    );
    const onboardProbesPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "inference", "onboard-probes.js"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const onboardSession = require(${sessionPath});
const credentials = require(${credentialsPath});
const nim = require(${nimPath});
const gatewayState = require(${gatewayStatePath});
const dockerDriverPlatform = require(${dockerDriverPlatformPath});
const gatewayGpuPassthrough = require(${gatewayGpuPassthroughPath});
const onboardProbes = require(${onboardProbesPath});

const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const commands = [];
const prompts = [];
const registryUpdates = [];
const done = new Error("INFERENCE_STEP_DONE");
let inferenceSessionSnapshot = null;

delete process.env.NEMOCLAW_NON_INTERACTIVE;
delete process.env.NEMOCLAW_SANDBOX_NAME;
delete process.env.NOUS_API_KEY;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("DISCORD_") || key.startsWith("TELEGRAM_")) {
    delete process.env[key];
  }
}
process.env.NEMOCLAW_OPENSHELL_BIN = ${openshellPath};
process.env.OPENSHELL_GATEWAY = "nemoclaw";

try {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
} catch {
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
}

runner.run = (command, opts = {}) => {
  const normalized = _n(command);
  commands.push({ command: normalized, env: opts.env || null });
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  const normalized = _n(command);
  if (normalized.includes("inference get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: hermes-provider",
      "  Model: moonshotai/kimi-k2.6",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};

registry.getSandbox = (name) =>
  name === "hermes-resume"
    ? {
        name,
        gpuEnabled: false,
        provider: "hermes-provider",
        model: "moonshotai/kimi-k2.6",
        hermesToolGateways: [],
        messagingChannels: [],
        policies: ["nous-web"],
      }
    : null;
registry.updateSandbox = (name, updates) => {
  registryUpdates.push({ name, updates });
  return true;
};
registry.setDefault = () => true;
registry.removeSandbox = () => true;

credentials.prompt = async (question) => {
  prompts.push(String(question));
  if (String(question).includes("Sandbox name")) return "hermes-resume";
  return "yes";
};

nim.detectGpu = () => null;
gatewayState.getGatewayReuseState = () => "healthy";
gatewayState.shouldSelectNamedGatewayForReuse = () => false;
gatewayState.getSandboxStateFromOutputs = () => "ready";
gatewayState.isGatewayHealthy = () => true;
dockerDriverPlatform.isLinuxDockerDriverGatewayEnabled = () => false;
gatewayGpuPassthrough.reconcileGatewayGpuReuseForGpuIntent = ({ gatewayReuseState }) => gatewayReuseState;
onboardProbes.verifyOnboardInferenceSmoke = () => {};

const complete = () => ({
  status: "complete",
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  error: null,
});
onboardSession.saveSession(
  onboardSession.createSession({
    mode: "interactive",
    agent: "hermes",
    sandboxName: null,
    provider: "hermes-provider",
    model: "moonshotai/kimi-k2.6",
    endpointUrl: "https://inference-api.nousresearch.com/v1",
    credentialEnv: "NOUS_API_KEY",
    hermesAuthMethod: "api_key",
    hermesToolGateways: [],
    policyPresets: ["nous-web"],
    metadata: { gatewayName: "nemoclaw", fromDockerfile: null },
    steps: {
      preflight: complete(),
      gateway: complete(),
      provider_selection: complete(),
    },
  }),
);

const originalMarkStepComplete = onboardSession.markStepComplete;
onboardSession.markStepComplete = (stepName, updates = {}) => {
  const result = originalMarkStepComplete(stepName, updates);
  if (stepName === "inference") {
    inferenceSessionSnapshot = result;
    throw done;
  }
  return result;
};

const { onboard } = require(${onboardPath});

(async () => {
  try {
    await onboard({ resume: true, agent: "hermes", acceptThirdPartySoftware: true, noGpu: true });
    throw new Error("Expected onboarding to reach the inference step");
  } catch (error) {
    if (error === done || error?.message === done.message) {
      console.log(JSON.stringify({
        commands,
        prompts,
        registryUpdates,
        inferenceSessionSandboxName: inferenceSessionSnapshot?.sandboxName ?? null,
      }));
      return;
    }
    console.error(error);
    process.exit(1);
  }
})();
`;
    fs.writeFileSync(scriptPath, script);

    const env: Record<string, string | undefined> = {
      ...stripMessagingEnv(process.env),
      HOME: tmpDir,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      NEMOCLAW_OPENSHELL_BIN: path.join(fakeBin, "openshell"),
    };
    delete env.NEMOCLAW_NON_INTERACTIVE;
    delete env.NEMOCLAW_SANDBOX_NAME;
    delete env.NOUS_API_KEY;

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(
      `${result.stderr}\n${result.stdout}`,
      /Hermes Provider requires a sandbox name/,
    );
    const payload = parseStdoutJson<{
      commands: CommandEntry[];
      prompts: string[];
      registryUpdates: Array<{ name: string; updates: Record<string, unknown> }>;
      inferenceSessionSandboxName: string | null;
    }>(result.stdout);

    assert.ok(
      payload.prompts.some((question) => question.includes("Sandbox name")),
      "resume should prompt for the missing sandbox name before Hermes inference reconciliation",
    );
    assert.ok(
      payload.commands.some((entry) =>
        /inference set --no-verify --provider hermes-provider/.test(entry.command),
      ),
      "resume should reach openshell inference set",
    );
    assert.ok(!payload.commands.some((entry) => /provider (create|update)/.test(entry.command)));
    assert.equal(
      payload.inferenceSessionSandboxName,
      null,
      "resume inference must not persist sandboxName before sandbox creation",
    );
    assert.ok(
      payload.registryUpdates.some(
        (call) =>
          call.name === "hermes-resume" &&
          call.updates.provider === "hermes-provider" &&
          call.updates.model === "moonshotai/kimi-k2.6",
      ),
      "Hermes setup should reconcile inference against the resolved sandbox name",
    );
  });

  it("reconciles a registered Hermes Provider when a fresh shell Nous key is selected", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-hermes-update-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-hermes-update-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  const normalized = _n(command);
  commands.push({ command: normalized, env: opts.env || null });
  if (normalized.includes("provider get hermes-provider")) {
    return { status: 0, stdout: "Provider: hermes-provider", stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: hermes-provider",
      "  Model: moonshotai/kimi-k2.6",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.NOUS_API_KEY = "nous-host-secret";
delete process.env.OPENAI_API_KEY;
process.env.NEMOCLAW_NON_INTERACTIVE = "1";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference(
    "test-box",
    "moonshotai/kimi-k2.6",
    "hermes-provider",
    "https://inference-api.nousresearch.com/v1",
    "NOUS_API_KEY",
    "api_key",
  );
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    expect(result.status).toBe(0);
    const commands = parseStdoutJson<CommandEntry[]>(result.stdout);
    const update = commands.find((entry) => /provider update hermes-provider/.test(entry.command));
    assert.ok(update);
    assert.match(update.command, /--credential NOUS_API_KEY/);
    assert.equal(update.env?.NOUS_API_KEY, "nous-host-secret");
    assert.ok(
      !commands.some((entry) => /nous-host-secret/.test(entry.command)),
      "shell credential value must not appear in argv",
    );
    assert.match(
      commands.at(-1)?.command || "",
      /inference set --no-verify --provider hermes-provider/,
    );
  });

  it("does not delete saved OpenAI credentials when configuring local vLLM", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-local-vllm-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-local-vllm-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));
    const localInferencePath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "inference", "local.js"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const credentials = require(${credentialsPath});
const localInference = require(${localInferencePath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");

const commands = [];
runner.run = (command, opts = {}) => {
  const cmd = _n(command);
  commands.push({ command: cmd, env: opts.env || null });
  if (cmd.includes("provider get")) return { status: 1, stdout: "", stderr: "" };
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  const cmd = _n(command);
  if (cmd.includes("inference") && cmd.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: vllm-local",
      "  Model: meta-llama",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;
localInference.validateLocalProvider = () => ({ ok: true });
localInference.getLocalProviderBaseUrl = () => "http://host.openshell.internal:8000/v1";

credentials.saveCredential("OPENAI_API_KEY", "sk-existing");

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "meta-llama", "vllm-local");
  console.log(JSON.stringify({
    commands,
    savedOpenAiKey: credentials.getCredential("OPENAI_API_KEY"),
  }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    expect(result.status).toBe(0);
    const payload = parseStdoutJson<{ commands: CommandEntry[]; savedOpenAiKey: string }>(
      result.stdout,
    );
    const providerCommand = payload.commands.find((entry) =>
      entry.command.includes("provider create"),
    );
    assert.ok(providerCommand, "expected local vLLM provider create command");
    assert.match(providerCommand.command, /--credential NEMOCLAW_VLLM_LOCAL_TOKEN/);
    assert.doesNotMatch(providerCommand.command, /--credential OPENAI_API_KEY/);
    assert.equal(providerCommand.env?.NEMOCLAW_VLLM_LOCAL_TOKEN, "dummy");
    assert.equal(payload.savedOpenAiKey, "sk-existing");
  });

  it("recovers the Ollama auth proxy on WSL when the sandbox needs proxy fronting", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-ollama-wsl-proxy-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-ollama-wsl-proxy-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const platformPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "platform.js"));
    const localInferencePath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "inference", "local.js"),
    );
    const proxyPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "inference", "ollama", "proxy.js"),
    );
    const topologyPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "onboard", "local-inference-topology.js"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const platform = require(${platformPath});
const localInference = require(${localInferencePath});
const proxy = require(${proxyPath});
const topology = require(${topologyPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");

const commands = [];
const proxyCalls = [];
runner.run = (command, opts = {}) => {
  const cmd = _n(command);
  commands.push({ command: cmd, env: opts.env || null });
  if (cmd.includes("provider get")) return { status: 1, stdout: "", stderr: "" };
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  const cmd = _n(command);
  if (cmd.includes("inference") && cmd.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: ollama-local",
      "  Model: qwen2.5:7b",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;
platform.isWsl = () => true;
topology.shouldFrontOllamaWithProxy = () => true;
localInference.validateLocalProvider = () => ({
  ok: false,
  message: "container cannot reach Ollama",
  diagnostic: "simulated WSL native Docker reachability failure",
});
localInference.getLocalProviderBaseUrl = () => "http://host.openshell.internal:11435/v1";
localInference.getOllamaWarmupCommand = () => ["true"];
localInference.validateOllamaModel = () => ({ ok: true });
localInference.validateOllamaModelWithToolsOverride = () => ({ ok: true });
proxy.ensureOllamaAuthProxy = () => {
  proxyCalls.push("ensure");
};
proxy.isProxyHealthy = () => {
  proxyCalls.push("healthy");
  return true;
};
proxy.getOllamaProxyToken = () => "proxy-token";
proxy.persistAndProbeOllamaProxy = async (token) => {
  proxyCalls.push("persist:" + token);
};

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "qwen2.5:7b", "ollama-local");
  console.log(JSON.stringify({ commands, proxyCalls }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = parseStdoutJson<{ commands: CommandEntry[]; proxyCalls: string[] }>(
      result.stdout,
    );
    assert.deepEqual(payload.proxyCalls, ["ensure", "healthy", "persist:proxy-token"]);
    const providerCommand = payload.commands.find(
      (entry) => entry.command.includes("provider create") && entry.command.includes("ollama-local"),
    );
    assert.ok(providerCommand, "expected ollama-local provider create command");
    assert.match(providerCommand.command, /--credential NEMOCLAW_OLLAMA_PROXY_TOKEN/);
    assert.equal(providerCommand.env?.NEMOCLAW_OLLAMA_PROXY_TOKEN, "proxy-token");
    assert.doesNotMatch(providerCommand.command, /proxy-token/);
    assert.ok(
      payload.commands.some((entry) =>
        entry.command.includes("inference set --no-verify --provider ollama-local"),
      ),
      "expected ollama-local inference route to be selected",
    );
  });

  it("surfaces a contextual error and exits when ollama-local inference set fails after the proxy-ready warning (#4257)", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-ollama-set-fail-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "ollama-set-fail.cjs");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const platformPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "platform.js"));
    const localInferencePath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "inference", "local.js"),
    );
    const proxyPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "inference", "ollama", "proxy.js"),
    );
    const topologyPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "onboard", "local-inference-topology.js"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const platform = require(${platformPath});
const localInference = require(${localInferencePath});
const proxy = require(${proxyPath});
const topology = require(${topologyPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");

let exitCode = null;
const realExit = process.exit;
process.exit = (code) => {
  if (exitCode === null) exitCode = code;
  const err = new Error("EXIT_CALLED:" + code);
  err.__exit = true;
  throw err;
};

const errLog = [];
const origErr = console.error;
console.error = (...args) => {
  errLog.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  origErr.apply(console, args);
};

const commands = [];
runner.run = (command, opts = {}) => {
  const cmd = _n(command);
  commands.push({ command: cmd, ignoreError: !!opts.ignoreError });
  if (cmd.includes("provider get")) return { status: 1, stdout: "", stderr: "" };
  if (cmd.includes("inference set") && cmd.includes("ollama-local")) {
    return { status: 7, stdout: "", stderr: "openshell: route apply failed" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  const cmd = _n(command);
  if (cmd.includes("inference") && cmd.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: ollama-local",
      "  Model: qwen2.5:7b",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;
platform.isWsl = () => true;
topology.shouldFrontOllamaWithProxy = () => true;
localInference.validateLocalProvider = () => ({
  ok: false,
  message: "container cannot reach Ollama",
  diagnostic: "simulated WSL native Docker reachability failure",
});
localInference.getLocalProviderBaseUrl = () => "http://host.openshell.internal:11435/v1";
localInference.getOllamaWarmupCommand = () => ["true"];
localInference.validateOllamaModel = () => ({ ok: true });
proxy.ensureOllamaAuthProxy = () => {};
proxy.isProxyHealthy = () => true;
proxy.getOllamaProxyToken = () => "proxy-token";
proxy.persistAndProbeOllamaProxy = async () => {};

const { setupInference } = require(${onboardPath});

(async () => {
  try {
    await setupInference("test-box", "qwen2.5:7b", "ollama-local");
  } catch (err) {
    if (!err || !err.__exit) {
      origErr("[TEST] outer error:", err && err.message);
      process.stdout.write(JSON.stringify({ commands, errLog, exitCode, error: String(err && err.message) }) + "\n");
      realExit.call(process, 99);
    }
  }
  process.stdout.write(JSON.stringify({ commands, errLog, exitCode }) + "\n");
  realExit.call(process, 0);
})();
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        // Force the non-interactive branch so the bug surfaces as a hard exit
        // rather than a recovery prompt that would hang in CI.
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    // Exit 0 because we override process.exit and end with realExit(0) after
    // catching the simulated exit. Test asserts on the captured payload instead.
    expect(result.status).toBe(0);
    const payload = parseStdoutJson<{
      commands: { command: string; ignoreError: boolean }[];
      errLog: string[];
      exitCode: number | null;
    }>(result.stdout);

    // Pre-fix, runOpenshell was called without ignoreError, so the runtime
    // wrapper exited before we could attach context. Post-fix, the local
    // path must use ignoreError + a contextual error message.
    const setCmd = payload.commands.find((entry) =>
      entry.command.includes("inference set --no-verify --provider ollama-local"),
    );
    assert.ok(setCmd, "expected ollama-local inference set command to be issued");
    assert.equal(setCmd.ignoreError, true, "ollama-local inference set must use ignoreError so onboard can recover");

    // The user must see the no-sandbox / resume-onboard guidance, not a silent stop.
    const combinedErr = payload.errLog.join("\n");
    assert.match(combinedErr, /No sandbox was created/);
    assert.match(combinedErr, /nemoclaw onboard --resume/);

    // And the process should still propagate the nonzero status from openshell,
    // not exit 0.
    assert.equal(payload.exitCode, 7, "non-interactive onboard must exit with the openshell status");
  });

  it("surfaces a contextual error and exits when vllm-local inference set fails (#4257)", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-vllm-set-fail-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "vllm-set-fail.cjs");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const localInferencePath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "inference", "local.js"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const localInference = require(${localInferencePath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");

let exitCode = null;
const realExit = process.exit;
process.exit = (code) => {
  if (exitCode === null) exitCode = code;
  const err = new Error("EXIT_CALLED:" + code);
  err.__exit = true;
  throw err;
};

const errLog = [];
const origErr = console.error;
console.error = (...args) => {
  errLog.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  origErr.apply(console, args);
};

const commands = [];
runner.run = (command, opts = {}) => {
  const cmd = _n(command);
  commands.push({ command: cmd, ignoreError: !!opts.ignoreError });
  if (cmd.includes("provider get")) return { status: 1, stdout: "", stderr: "" };
  if (cmd.includes("inference set") && cmd.includes("vllm-local")) {
    return { status: 13, stdout: "", stderr: "openshell: vllm route apply failed" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = () => "";
registry.updateSandbox = () => true;
localInference.validateLocalProvider = () => ({ ok: true });
localInference.getLocalProviderBaseUrl = () => "http://host.openshell.internal:8000/v1";

const { setupInference } = require(${onboardPath});

(async () => {
  try {
    await setupInference("test-box", "meta-llama", "vllm-local");
  } catch (err) {
    if (!err || !err.__exit) {
      origErr("[TEST] outer error:", err && err.message);
      process.stdout.write(JSON.stringify({ commands, errLog, exitCode, error: String(err && err.message) }) + "\n");
      realExit.call(process, 99);
    }
  }
  process.stdout.write(JSON.stringify({ commands, errLog, exitCode }) + "\n");
  realExit.call(process, 0);
})();
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    expect(result.status).toBe(0);
    const payload = parseStdoutJson<{
      commands: { command: string; ignoreError: boolean }[];
      errLog: string[];
      exitCode: number | null;
    }>(result.stdout);

    const setCmd = payload.commands.find((entry) =>
      entry.command.includes("inference set --no-verify --provider vllm-local"),
    );
    assert.ok(setCmd, "expected vllm-local inference set command to be issued");
    assert.equal(setCmd.ignoreError, true, "vllm-local inference set must use ignoreError so onboard can recover");

    const combinedErr = payload.errLog.join("\n");
    assert.match(combinedErr, /No sandbox was created/);
    assert.match(combinedErr, /nemoclaw onboard --resume/);

    assert.equal(payload.exitCode, 13, "non-interactive onboard must exit with the openshell status");
  });

  it("detects when the live inference route already matches the requested provider and model", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-inference-ready-"));
    const fakeOpenshell = path.join(tmpDir, "openshell");
    const scriptPath = path.join(tmpDir, "inference-ready-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

    fs.writeFileSync(
      fakeOpenshell,
      `#!/usr/bin/env bash
if [ "$1" = "inference" ] && [ "$2" = "get" ]; then
  cat <<'EOF'
Gateway inference:

  Route: inference.local
  Provider: nvidia-prod
  Model: nvidia/nemotron-3-super-120b-a12b
  Version: 1
EOF
  exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );

    fs.writeFileSync(
      scriptPath,
      `
const { isInferenceRouteReady } = require(${onboardPath});
console.log(JSON.stringify({
  same: isInferenceRouteReady("nvidia-prod", "nvidia/nemotron-3-super-120b-a12b"),
  otherModel: isInferenceRouteReady("nvidia-prod", "nvidia/other-model"),
  otherProvider: isInferenceRouteReady("openai-api", "nvidia/nemotron-3-super-120b-a12b"),
}));
`,
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${tmpDir}:${process.env.PATH || ""}`,
      },
    });

    try {
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        same: true,
        otherModel: false,
        otherProvider: false,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects when OpenClaw is already configured inside the sandbox", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-ready-"));
    const fakeOpenshell = path.join(tmpDir, "openshell");
    const scriptPath = path.join(tmpDir, "openclaw-ready-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

    fs.writeFileSync(
      fakeOpenshell,
      `#!/usr/bin/env bash
if [ "$1" = "sandbox" ] && [ "$2" = "download" ]; then
  dest="\${@: -1}"
  mkdir -p "$dest/sandbox/.openclaw"
  cat > "$dest/sandbox/.openclaw/openclaw.json" <<'EOF'
{"gateway":{"auth":{"token":"test-token"}}}
EOF
  exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );

    fs.writeFileSync(
      scriptPath,
      `
const { isOpenclawReady } = require(${onboardPath});
console.log(JSON.stringify({
  ready: isOpenclawReady("my-assistant"),
}));
`,
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${tmpDir}:${process.env.PATH || ""}`,
      },
    });

    try {
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ ready: true });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects when recorded policy presets are already applied", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-ready-"));
    const registryDir = path.join(tmpDir, ".nemoclaw");
    const registryFile = path.join(registryDir, "sandboxes.json");
    const scriptPath = path.join(tmpDir, "policy-ready-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));

    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      registryFile,
      JSON.stringify(
        {
          sandboxes: {
            "my-assistant": {
              name: "my-assistant",
              policies: ["pypi", "npm"],
            },
          },
          defaultSandbox: "my-assistant",
        },
        null,
        2,
      ),
    );

    fs.writeFileSync(
      scriptPath,
      `
const { arePolicyPresetsApplied } = require(${onboardPath});
console.log(JSON.stringify({
  ready: arePolicyPresetsApplied("my-assistant", ["pypi", "npm"]),
  missing: arePolicyPresetsApplied("my-assistant", ["pypi", "slack"]),
  empty: arePolicyPresetsApplied("my-assistant", []),
}));
`,
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
      },
    });

    try {
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout.trim());
      expect(payload).toEqual({
        ready: true,
        missing: false,
        empty: false,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses native Anthropic provider creation without embedding the secret in argv", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-anthropic-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-anthropic-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  // provider-get returns not-found so we exercise the create path
  if (_n(command).includes("provider get")) return { status: 1 };
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: anthropic-prod",
      "  Model: claude-sonnet-4-5",
      "  Version: 1",
    ].join("\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.ANTHROPIC_API_KEY = "sk-ant-secret-value";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "claude-sonnet-4-5", "anthropic-prod", "https://api.anthropic.com", "ANTHROPIC_API_KEY");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = parseStdoutJson<CommandEntry[]>(result.stdout);
    assert.equal(commands.length, 4);
    assert.match(commands[0].command, /gateway select nemoclaw/);
    assert.match(commands[1].command, /provider get/);
    assert.match(commands[2].command, /--type anthropic/);
    assert.match(commands[2].command, /--credential ANTHROPIC_API_KEY/);
    assert.doesNotMatch(commands[2].command, /sk-ant-secret-value/);
    assert.match(commands[3].command, /--provider anthropic-prod/);
  });

  it("updates OpenAI-compatible providers without passing an unsupported --type flag", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-openai-update-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-openai-update-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
    ].join("\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.OPENAI_API_KEY = "sk-secret-value";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = parseStdoutJson<CommandEntry[]>(result.stdout);
    assert.equal(commands.length, 4);
    assert.match(commands[0].command, /gateway select nemoclaw/);
    assert.match(commands[1].command, /provider get/);
    assert.match(commands[2].command, /provider update openai-api/);
    assert.doesNotMatch(commands[2].command, /--type/);
    assert.match(commands[3].command, /inference set --no-verify/);
  });

  it("re-prompts for credentials when openshell inference set fails with authorization errors", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-apply-auth-retry-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-inference-auth-retry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const credentials = require(${credentialsPath});

const commands = [];
const answers = ["retry", "sk-good"];
let inferenceSetCalls = 0;

credentials.prompt = async () => answers.shift() || "";
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  if (_n(command).includes("inference set")) {
    inferenceSetCalls += 1;
    if (inferenceSetCalls === 1) {
      return { status: 1, stdout: "", stderr: "HTTP 403: forbidden" };
    }
  }
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.OPENAI_API_KEY = "sk-bad";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify({ commands, key: process.env.OPENAI_API_KEY, inferenceSetCalls }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      key: string;
      inferenceSetCalls: number;
      commands: CommandEntry[];
    }>(result.stdout);
    assert.equal(payload.key, "sk-good");
    assert.equal(payload.inferenceSetCalls, 2);
    const providerEnvs = payload.commands
      .filter((entry: CommandEntry) => entry.command.includes("provider"))
      .map((entry: CommandEntry) => entry.env && entry.env.OPENAI_API_KEY)
      .filter(Boolean);
    assert.deepEqual(providerEnvs, ["sk-bad", "sk-good"]);
  });

  it("returns control to provider selection when inference apply recovery chooses back", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-apply-back-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-inference-apply-back-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const credentials = require(${credentialsPath});

const commands = [];
credentials.prompt = async () => "back";
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  if (_n(command).includes("inference set")) {
    return { status: 1, stdout: "", stderr: "HTTP 404: model not found" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCapture = () => "";
registry.updateSandbox = () => true;

process.env.OPENAI_API_KEY = "sk-secret-value";

const { setupInference } = require(${onboardPath});

(async () => {
  const result = await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify({ result, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      result: { retry: "selection" };
      commands: CommandEntry[];
    }>(result.stdout);
    assert.deepEqual(payload.result, { retry: "selection" });
    assert.equal(
      payload.commands.filter((entry: CommandEntry) => entry.command.includes("inference set"))
        .length,
      1,
    );
  });

  it("migrates a legacy credentials.json into env so setupInference can register the provider", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-resume-cred-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-resume-credential-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    // Pre-seed a pre-fix plaintext credentials.json. hydrateCredentialEnv
    // stages it non-destructively into process.env via
    // stageLegacyCredentialsToEnv(); the secure unlink only runs from the
    // post-onboard cleanup gate when the staged values are confirmed
    // migrated, so the legacy file must still exist after this test's
    // setupInference call (asserted further down).
    const legacyDir = path.join(tmpDir, ".nemoclaw");
    fs.mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(legacyDir, "credentials.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-stored-secret" }),
      { mode: 0o600 },
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const legacyFilePath = JSON.stringify(path.join(legacyDir, "credentials.json"));
    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const fs = require("node:fs");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
    ].join("\n");
  }
  return "";
};
registry.updateSandbox = () => true;

delete process.env.OPENAI_API_KEY;

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify({
    commands,
    openai: process.env.OPENAI_API_KEY || null,
    legacyFileGone: !fs.existsSync(${legacyFilePath}),
  }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      openai: string;
      commands: CommandEntry[];
      legacyFileGone: boolean;
    }>(result.stdout);
    assert.equal(payload.openai, "sk-stored-secret");
    // setupInference's hydrateCredentialEnv only stages the legacy file
    // (non-destructive). The secure unlink runs only after a full successful
    // onboard, so an interrupted run can be retried without losing the
    // user's only copy of their credentials.
    assert.equal(
      payload.legacyFileGone,
      false,
      "legacy credentials.json must survive the staging-only hydrate path",
    );
    // commands[0]=gateway select, [1]=provider get, [2]=provider update
    const providerUpdate = payload.commands[2];
    assert.ok(providerUpdate, "expected provider update command");
    assert.equal(providerUpdate.env?.OPENAI_API_KEY, "sk-stored-secret");
    assert.doesNotMatch(providerUpdate.command, /sk-stored-secret/);
  });

  it("drops stale local sandbox registry entries when the live sandbox is gone", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-stale-sandbox-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "stale-sandbox-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const registry = require(${registryPath});
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
runner.runCapture = (command) => (_n(command).includes("sandbox get my-assistant") ? "" : "");

registry.registerSandbox({ name: "my-assistant" });

const { pruneStaleSandboxEntry } = require(${onboardPath});

const liveExists = pruneStaleSandboxEntry("my-assistant");
console.log(JSON.stringify({ liveExists, sandbox: registry.getSandbox("my-assistant") }));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payloadLine = result.stdout
      .trim()
      .split("\n")
      .slice()
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));
    assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
    const payload = JSON.parse(payloadLine);
    assert.equal(payload.liveExists, false);
    assert.equal(payload.sandbox, null);
  });

  it(
    "builds the sandbox without uploading an external OpenClaw config file",
    { timeout: 90_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-create-sandbox-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "create-sandbox-check.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
const registerCalls = [];
const updateCalls = [];
const defaultCalls = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command);
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.registerSandbox = (entry) => {
  registerCalls.push(entry);
  return true;
};
registry.updateSandbox = (name, updates) => {
  updateCalls.push({ name, updates });
  return true;
};
registry.setDefault = (name) => {
  defaultCalls.push(name);
  return true;
};
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4");
  console.log(JSON.stringify({ sandboxName, commands, registerCalls, updateCalls, defaultCalls }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);
      assert.equal(payload.sandboxName, "my-assistant");
      assert.deepEqual(payload.defaultCalls, ["my-assistant"]);
      assert.ok(
        payload.registerCalls.some(
          (entry: Record<string, unknown>) =>
            entry.name === "my-assistant" &&
            entry.model === "gpt-5.4" &&
            Object.prototype.hasOwnProperty.call(entry, "agentVersion"),
        ),
        "expected registry metadata for created sandbox",
      );
      assert.ok(
        payload.updateCalls.every(
          (call: { name: string; updates: Record<string, unknown> }) =>
            call.name === "my-assistant" && call.updates,
        ),
        "expected any registry metadata updates to target the created sandbox",
      );
      const createCommand = payload.commands.find((entry: CommandEntry) =>
        entry.command.includes("sandbox create"),
      );
      assert.ok(createCommand, "expected sandbox create command");
      assert.match(createCommand.command, /nemoclaw-start/);
      assert.doesNotMatch(createCommand.command, /--upload/);
      assert.doesNotMatch(createCommand.command, /OPENCLAW_CONFIG_PATH/);
      assert.doesNotMatch(createCommand.command, /NVIDIA_API_KEY=/);
      assert.doesNotMatch(createCommand.command, /DISCORD_BOT_TOKEN=/);
      assert.doesNotMatch(createCommand.command, /SLACK_BOT_TOKEN=/);
      assert.ok(
        payload.commands.some(
          (entry: CommandEntry) =>
            entry.command.includes("forward start --background 18789 my-assistant") ||
            entry.command.includes("forward start --background 0.0.0.0:18789 my-assistant"),
        ),
        "expected dashboard forward (loopback or WSL 0.0.0.0)",
      );
    },
  );

  it("skips OpenClaw sandbox-base resolution for agent-staged Dockerfiles", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-base-skip-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "agent-base-skip.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));
    const agentOnboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "agent", "onboard.js"));
    const sandboxBaseImagePath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "sandbox-base-image.js"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const agentOnboard = require(${agentOnboardPath});
const sandboxBaseImage = require(${sandboxBaseImagePath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
const logs = [];
const warnings = [];
const baseResolutionCalls = [];
const originalLog = console.log;
const originalWarn = console.warn;
console.log = (...args) => {
  logs.push(args.join(" "));
  originalLog(...args);
};
console.warn = (...args) => {
  warnings.push(args.join(" "));
  originalWarn(...args);
};

sandboxBaseImage.resolveSandboxBaseImage = (options) => {
  baseResolutionCalls.push(options);
  return {
    ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source: "latest",
    glibcVersion: "2.39",
  };
};

agentOnboard.createAgentSandbox = () => {
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-build-"));
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  fs.writeFileSync(
    stagedDockerfile,
    [
      "ARG BASE_IMAGE=nemoclaw-hermes-sandbox-base-local:test",
      "FROM \${BASE_IMAGE}",
      "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
      "ARG NEMOCLAW_PROVIDER_KEY=custom",
      "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
      "ARG CHAT_UI_URL=http://127.0.0.1:8642",
      "ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1",
      "ARG NEMOCLAW_INFERENCE_API=openai-completions",
      "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
      "ARG NEMOCLAW_MESSAGING_CHANNELS_B64=W10=",
      "ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=e30=",
      "ARG NEMOCLAW_DISCORD_GUILDS_B64=e30=",
      "ARG NEMOCLAW_TELEGRAM_CONFIG_B64=e30=",
      "ARG NEMOCLAW_WECHAT_CONFIG_B64=e30=",
      "ARG NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=0",
      "ARG NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64=W10=",
      "ARG NEMOCLAW_BUILD_ID=default",
      "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
      "CMD [\"/bin/bash\"]",
    ].join("\\n"),
  );
  return { buildCtx, stagedDockerfile };
};

runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runFile = (file, args = [], opts = {}) => {
  commands.push({ command: _n([file, ...args]), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get hermes-sandbox")) return "";
  if (_n(command).includes("sandbox list")) return "hermes-sandbox Ready";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command);
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  if (_n(command).includes("forward list")) return "hermes-sandbox 127.0.0.1 8642 12345 running";
  return "";
};
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
registry.getSandbox = () => null;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: hermes-sandbox\\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const agent = {
    name: "hermes",
    displayName: "Hermes Agent",
    forwardPort: 8642,
    expectedVersion: "2026.4.23",
    policyAdditionsPath: null,
  };
  await createSandbox(
    null,
    "gpt-5.4",
    "nvidia-prod",
    null,
    "hermes-sandbox",
    null,
    [],
    null,
    agent,
  );
  console.log(JSON.stringify({ commands, logs, warnings, baseResolutionCalls }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...stripMessagingEnv(process.env),
        HOME: tmpDir,
        NEMOCLAW_HOME: path.join(tmpDir, ".nemoclaw"),
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      logs: string[];
      warnings: string[];
      baseResolutionCalls: unknown[];
    }>(result.stdout);
    assert.equal(payload.baseResolutionCalls.length, 0);
    assert.ok(
      !payload.logs.some((line) => line.includes("Using sandbox base image")),
      "Hermes agent Dockerfile path should not log OpenClaw sandbox-base usage",
    );
    assert.ok(
      !payload.warnings.some((line) => line.includes("base image")),
      "Hermes agent Dockerfile path should not warn about OpenClaw sandbox-base availability",
    );
  });

  it("keeps resolving the OpenClaw sandbox base image on the default Dockerfile path", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-base-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "openclaw-base-resolve.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));
    const buildContextPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "sandbox", "build-context.js"),
    );
    const sandboxBaseImagePath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "sandbox-base-image.js"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const buildContext = require(${buildContextPath});
const sandboxBaseImage = require(${sandboxBaseImagePath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
const logs = [];
const baseResolutionCalls = [];
const originalLog = console.log;
console.log = (...args) => {
  logs.push(args.join(" "));
  originalLog(...args);
};

sandboxBaseImage.resolveSandboxBaseImage = (options) => {
  baseResolutionCalls.push(options);
  return {
    ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    source: "latest",
    glibcVersion: "2.39",
  };
};
buildContext.stageOptimizedSandboxBuildContext = () => {
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-build-"));
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  fs.writeFileSync(
    stagedDockerfile,
    [
      "ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
      "FROM \${BASE_IMAGE}",
      "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
      "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
      "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
      "ARG CHAT_UI_URL=http://127.0.0.1:18789",
      "ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1",
      "ARG NEMOCLAW_INFERENCE_API=openai-completions",
      "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
      "ARG NEMOCLAW_MESSAGING_CHANNELS_B64=W10=",
      "ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=e30=",
      "ARG NEMOCLAW_DISCORD_GUILDS_B64=e30=",
      "ARG NEMOCLAW_TELEGRAM_CONFIG_B64=e30=",
      "ARG NEMOCLAW_WECHAT_CONFIG_B64=e30=",
      "ARG NEMOCLAW_BUILD_ID=default",
      "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
      "CMD [\"/bin/bash\"]",
    ].join("\\n"),
  );
  return { buildCtx, stagedDockerfile };
};

runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runFile = (file, args = [], opts = {}) => {
  commands.push({ command: _n([file, ...args]), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command);
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
registry.getSandbox = () => null;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ commands, logs, baseResolutionCalls }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...stripMessagingEnv(process.env),
        HOME: tmpDir,
        NEMOCLAW_HOME: path.join(tmpDir, ".nemoclaw"),
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      logs: string[];
      baseResolutionCalls: Array<{ imageName?: string }>;
    }>(result.stdout);
    assert.equal(payload.baseResolutionCalls.length, 1);
    assert.equal(
      payload.baseResolutionCalls[0]?.imageName,
      "ghcr.io/nvidia/nemoclaw/sandbox-base",
    );
    assert.ok(
      payload.logs.some((line) => line.includes("Pinning base image to sha256:bbbbbbbbbbbb")),
      "default OpenClaw path should still log base-image pinning",
    );
  });

  it("binds the dashboard forward to 0.0.0.0 when CHAT_UI_URL points to a remote host", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-remote-forward-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-remote-forward.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command);
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.CHAT_UI_URL = "https://chat.example.com";
  await createSandbox(null, "gpt-5.4");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = parseStdoutJson<CommandEntry[]>(result.stdout);
    assert.ok(
      commands.some((entry: CommandEntry) =>
        entry.command.includes("forward start --background 0.0.0.0:18789 my-assistant"),
      ),
      "expected remote dashboard forward target",
    );
  });

  it("injects NEMOCLAW_DASHBOARD_PORT into sandbox create envArgs when set (#1925)", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dashboard-port-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "dashboard-port-envargs.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runFile = (file, args = [], opts = {}) => {
  commands.push({ command: _n([file, ...args]), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  // Custom port: dashboard readiness curl uses 19000 (DASHBOARD_PORT from env)
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command);
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 19000 12345 running";
  return "";
};
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    // Strip CHAT_UI_URL so createSandbox falls back to http://127.0.0.1:19000.
    // Without this, a CHAT_UI_URL set in the developer's shell or CI would be
    // inherited, causing chatUiUrl to use the wrong port and making the forward
    // command assertion below fail spuriously.
    const { CHAT_UI_URL: _stripped, ...inheritedEnv } = process.env;
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...inheritedEnv,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_DASHBOARD_PORT: "19000",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payloadLine = result.stdout
      .trim()
      .split("\n")
      .slice()
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));
    assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
    const payload = JSON.parse(payloadLine);
    const createCommand = payload.commands.find((entry: CommandEntry) =>
      entry.command.includes("sandbox create"),
    );
    assert.ok(createCommand, "expected sandbox create command");
    // Part 1 of fix (#1925): NEMOCLAW_DASHBOARD_PORT must be in envArgs so
    // nemoclaw-start.sh can unconditionally override CHAT_UI_URL at runtime,
    // overriding whatever value the Docker image had baked in.
    assert.match(createCommand.command, /NEMOCLAW_DASHBOARD_PORT=19000/);
    // Forward must use same-port mapping (openshell does not support asymmetric)
    assert.ok(
      payload.commands.some(
        (entry: CommandEntry) =>
          entry.command.includes("forward start --background 19000 my-assistant") ||
          entry.command.includes("forward start --background 0.0.0.0:19000 my-assistant"),
      ),
      "expected dashboard forward for port 19000",
    );
    assert.ok(
      !payload.commands.some((entry: CommandEntry) => entry.command.includes("19000:18789")),
      "forward must not use asymmetric 19000:18789 mapping",
    );
    assert.ok(
      !payload.commands.some((entry: CommandEntry) => entry.command.includes("19000:19000")),
      "forward must not use port:port form (openshell does not support it)",
    );
  });

  it(
    "non-interactive exits with error when existing sandbox is not ready",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-noninteractive-notready-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "noninteractive-notready.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const childProcess = require("node:child_process");

runner.run = (command) => {
  if (_n(command).includes("sandbox delete")) {
    throw new Error("unexpected sandbox delete");
  }
  return { status: 0 };
};
runner.runCapture = (command) => {
  // Existing sandbox that is NOT ready
  if (_n(command).includes("sandbox get my-assistant")) return "my-assistant";
  if (_n(command).includes("sandbox list")) return "my-assistant NotReady";
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });
childProcess.spawn = () => {
  throw new Error("unexpected sandbox create");
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log("ERROR_DID_NOT_EXIT");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      };
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      });

      assert.notEqual(result.status, 0, "expected non-zero exit for not-ready sandbox");
      assert.ok(
        !result.stdout.includes("ERROR_DID_NOT_EXIT"),
        "should have exited before reaching sandbox create",
      );
      const output = (result.stdout || "") + (result.stderr || "");
      assert.ok(
        output.includes("--recreate-sandbox") || output.includes("NEMOCLAW_RECREATE_SANDBOX"),
        "should hint about --recreate-sandbox flag",
      );
    },
  );

  it(
    "recreate-sandbox flag forces deletion and recreation of a ready sandbox",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-recreate-flag-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "recreate-flag.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "my-assistant";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command, {
      defaultCurlOutput: "ok",
    });
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;

const preflight = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"))});
preflight.checkPortAvailable = async () => ({ ok: true });

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_RECREATE_SANDBOX = "1";
  process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP = "1";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.ok(
        payload.commands.some((entry: CommandEntry) => entry.command.includes("sandbox delete")),
        "should delete existing sandbox when --recreate-sandbox is set",
      );
      assert.ok(
        payload.commands.some((entry: CommandEntry) => entry.command.includes("sandbox create")),
        "should create a new sandbox when --recreate-sandbox is set",
      );
    },
  );

  it(
    "recreate-sandbox flag backs up and restores workspace state",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-recreate-backup-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "recreate-backup.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const sandboxStatePath = JSON.stringify(
        path.join(repoRoot, "dist", "lib", "state", "sandbox.js"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const sandboxState = require(${sandboxStatePath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const events = [];
runner.run = (command) => {
  events.push({ kind: "run", cmd: _n(command) });
  return { status: 0 };
};
runner.runCapture = (command) => {
  const cmd = _n(command);
  if (cmd.includes("sandbox get my-assistant")) return "my-assistant";
  if (cmd.includes("sandbox list")) return "my-assistant Ready";
  if (cmd.includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command, {
      defaultCurlOutput: "ok",
    });
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;

sandboxState.backupSandboxState = (name) => {
  events.push({ kind: "backup", name });
  return {
    success: true,
    backedUpDirs: ["workspace", "skills"],
    failedDirs: [],
    backedUpFiles: ["UPGRADE_MARKER.md"],
    failedFiles: [],
    manifest: { backupPath: "/tmp/fake-backup-path", timestamp: "2026-05-25T00:00:00Z" },
  };
};
sandboxState.restoreSandboxState = (name, backupPath) => {
  events.push({ kind: "restore", name, backupPath });
  return {
    success: true,
    restoredDirs: ["workspace", "skills"],
    failedDirs: [],
    restoredFiles: ["UPGRADE_MARKER.md"],
    failedFiles: [],
  };
};

const preflight = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"))});
preflight.checkPortAvailable = async () => ({ ok: true });

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4243;
  events.push({ kind: "spawn", cmd: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]) });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_RECREATE_SANDBOX = "1";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, events }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      const events = payload.events as Array<{ kind: string; cmd?: string; name?: string; backupPath?: string }>;
      const backupIndex = events.findIndex((e) => e.kind === "backup");
      const deleteIndex = events.findIndex((e) => e.kind === "run" && (e.cmd || "").includes("sandbox delete"));
      const restoreIndex = events.findIndex((e) => e.kind === "restore");

      assert.ok(backupIndex >= 0, "should call backupSandboxState before delete");
      assert.ok(deleteIndex > backupIndex, "backup must happen before sandbox delete");
      assert.ok(restoreIndex > deleteIndex, "restore must happen after sandbox recreate");
      const backupEvent = events[backupIndex];
      assert.equal(backupEvent?.name, "my-assistant", "backup target must match sandbox name");
      const restoreEvent = events[restoreIndex];
      assert.equal(restoreEvent?.backupPath, "/tmp/fake-backup-path", "restore must use backup path");
    },
  );

  it(
    "recreate-sandbox with NEMOCLAW_RECREATE_WITHOUT_BACKUP=1 skips backup",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-recreate-skip-backup-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "recreate-skip-backup.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const sandboxStatePath = JSON.stringify(
        path.join(repoRoot, "dist", "lib", "state", "sandbox.js"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const sandboxState = require(${sandboxStatePath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const events = [];
runner.run = (command) => {
  events.push({ kind: "run", cmd: _n(command) });
  return { status: 0 };
};
runner.runCapture = (command) => {
  const cmd = _n(command);
  if (cmd.includes("sandbox get my-assistant")) return "my-assistant";
  if (cmd.includes("sandbox list")) return "my-assistant Ready";
  if (cmd.includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command, {
      defaultCurlOutput: "ok",
    });
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;

sandboxState.backupSandboxState = () => {
  events.push({ kind: "backup" });
  return { success: true, backedUpDirs: [], failedDirs: [], backedUpFiles: [], failedFiles: [] };
};
sandboxState.restoreSandboxState = () => {
  events.push({ kind: "restore" });
  return { success: true, restoredDirs: [], failedDirs: [], restoredFiles: [], failedFiles: [] };
};

const preflight = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"))});
preflight.checkPortAvailable = async () => ({ ok: true });

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4244;
  events.push({ kind: "spawn", cmd: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]) });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_RECREATE_SANDBOX = "1";
  process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP = "1";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, events }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);
      const events = payload.events as Array<{ kind: string }>;
      assert.ok(
        !events.some((e) => e.kind === "backup"),
        "should not call backupSandboxState when NEMOCLAW_RECREATE_WITHOUT_BACKUP=1",
      );
      assert.ok(
        !events.some((e) => e.kind === "restore"),
        "should not call restoreSandboxState when no backup occurred",
      );
    },
  );

  it(
    "recreate-sandbox flag backs up and restores when existing sandbox is not ready",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-recreate-notready-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "recreate-notready.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const sandboxStatePath = JSON.stringify(
        path.join(repoRoot, "dist", "lib", "state", "sandbox.js"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const sandboxState = require(${sandboxStatePath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const events = [];
let sandboxDeleted = false;
runner.run = (command) => {
  const cmd = _n(command);
  events.push({ kind: "run", cmd });
  if (cmd.includes("sandbox delete")) sandboxDeleted = true;
  return { status: 0 };
};
runner.runCapture = (command) => {
  const cmd = _n(command);
  if (cmd.includes("sandbox get my-assistant")) return "my-assistant";
  if (cmd.includes("sandbox list")) {
    return sandboxDeleted ? "my-assistant Ready" : "my-assistant NotReady";
  }
  if (cmd.includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command, {
      defaultCurlOutput: "ok",
    });
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;

sandboxState.backupSandboxState = (name) => {
  events.push({ kind: "backup", name });
  return {
    success: true,
    backedUpDirs: ["workspace"],
    failedDirs: [],
    backedUpFiles: ["UPGRADE_MARKER.md"],
    failedFiles: [],
    manifest: { backupPath: "/tmp/fake-backup-notready", timestamp: "2026-05-25T00:00:00Z" },
  };
};
sandboxState.restoreSandboxState = (name, backupPath) => {
  events.push({ kind: "restore", name, backupPath });
  return {
    success: true,
    restoredDirs: ["workspace"],
    failedDirs: [],
    restoredFiles: ["UPGRADE_MARKER.md"],
    failedFiles: [],
  };
};

const preflight = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"))});
preflight.checkPortAvailable = async () => ({ ok: true });

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4245;
  events.push({ kind: "spawn", cmd: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]) });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_RECREATE_SANDBOX = "1";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, events }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      const events = payload.events as Array<{ kind: string; cmd?: string; name?: string; backupPath?: string }>;
      const backupIndex = events.findIndex((e) => e.kind === "backup");
      const deleteIndex = events.findIndex(
        (e) => e.kind === "run" && (e.cmd || "").includes("sandbox delete"),
      );
      const restoreIndex = events.findIndex((e) => e.kind === "restore");

      assert.ok(backupIndex >= 0, "should call backupSandboxState for not-ready sandbox");
      assert.ok(deleteIndex > backupIndex, "backup must happen before sandbox delete");
      assert.ok(restoreIndex > deleteIndex, "restore must happen after sandbox recreate");
    },
  );

  it(
    "recreating a sandbox preserves the user's policy preset selections",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-recreate-preserves-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "recreate-preserves.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const sessionModulePath = JSON.stringify(
        path.join(repoRoot, "dist", "lib", "state", "onboard-session.js"),
      );

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const onboardSession = require(${sessionModulePath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "my-assistant";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command, {
      defaultCurlOutput: "ok",
    });
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  return "";
};

// Existing sandbox has a custom preset selection: only "npm" (not the
// full "balanced" tier). Recreating the sandbox must preserve this
// customisation rather than reverting to the tier defaults.
registry.getSandbox = () => ({
  name: "my-assistant",
  gpuEnabled: false,
  policies: ["npm"],
  policyTier: "balanced",
});
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;

const preflight = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"))});
preflight.checkPortAvailable = async () => ({ ok: true });

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.NEMOCLAW_RECREATE_SANDBOX = "1";
  process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP = "1";
  await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  const session = onboardSession.loadSession();
  console.log(JSON.stringify({ policyPresets: session && session.policyPresets }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.deepEqual(
        payload.policyPresets,
        ["npm"],
        "createSandbox should write the previous sandbox's policy presets to the onboard session before destroying it so they can be reapplied after recreation",
      );
    },
  );

  it(
    "interactive mode prompts before reusing an existing ready sandbox",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-interactive-reuse-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "interactive-reuse.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const commands = [];
runner.run = (command, opts = {}) => {
  const commandString = Array.isArray(command) ? command.join(" ") : String(command);
  if (_n(command).includes("sandbox download")) {
    const parts = commandString.match(/'([^']*)'/g) || [];
    const downloadDir = Array.isArray(command)
      ? String(command[command.length - 1] || "")
      : parts.length
        ? parts[parts.length - 1].slice(1, -1)
        : null;
    if (downloadDir) {
      fs.mkdirSync(downloadDir, { recursive: true });
      fs.writeFileSync(
        path.join(downloadDir, "config.json"),
        JSON.stringify({ provider: "nvidia-prod", model: "gpt-5.4" }),
      );
    }
  }
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runFile = (file, args = [], opts = {}) => {
  commands.push({ type: "runFile", command: _n([file, ...args]), file, args, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "my-assistant";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });

// Mock prompt to return "y" (reuse)
credentials.prompt = async () => "y";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      // Run WITHOUT NEMOCLAW_NON_INTERACTIVE to exercise interactive path
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      };
      delete env["NEMOCLAW_NON_INTERACTIVE"];
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.equal(payload.sandboxName, "my-assistant", "should reuse when user answers y");
      assert.ok(
        payload.commands.every((entry: CommandEntry) => !entry.command.includes("sandbox create")),
        "should NOT recreate sandbox when user chooses to reuse",
      );
      assert.ok(
        payload.commands.every((entry: CommandEntry) => !entry.command.includes("sandbox delete")),
        "should NOT delete sandbox when user chooses to reuse",
      );
      assert.ok(
        result.stdout.includes("already exists"),
        "should show 'already exists' message in interactive mode",
      );
    },
  );

  it(
    "interactive mode deletes and recreates sandbox when user confirms drift recreate",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-interactive-decline-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "interactive-decline.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const commands = [];
runner.run = (command, opts = {}) => {
  const commandString = Array.isArray(command) ? command.join(" ") : String(command);
  if (_n(command).includes("sandbox download")) {
    const parts = commandString.match(/'([^']*)'/g) || [];
    const downloadDir = Array.isArray(command)
      ? String(command[command.length - 1] || "")
      : parts.length
        ? parts[parts.length - 1].slice(1, -1)
        : null;
    if (downloadDir) {
      fs.mkdirSync(downloadDir, { recursive: true });
      fs.writeFileSync(
        path.join(downloadDir, "config.json"),
        JSON.stringify({ provider: "openai-prod", model: "gpt-4o" }),
      );
    }
  }
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runFile = (file, args = [], opts = {}) => {
  commands.push({ type: "runFile", command: _n([file, ...args]), file, args, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "my-assistant";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command, {
      defaultCurlOutput: "ok",
    });
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;

const preflight = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"))});
preflight.checkPortAvailable = async () => ({ ok: true });

// Mock prompt to return "y" (confirm recreate)
credentials.prompt = async () => "y";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      // Run WITHOUT NEMOCLAW_NON_INTERACTIVE to exercise interactive path
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_RECREATE_WITHOUT_BACKUP: "1",
      };
      delete env["NEMOCLAW_NON_INTERACTIVE"];
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.ok(
        payload.commands.some((entry: CommandEntry) =>
          /sandbox.*delete/.test(String(entry.command)),
        ),
        "should delete existing sandbox when user confirms recreate",
      );
      assert.ok(
        payload.commands.some((entry: CommandEntry) =>
          /sandbox.*create/.test(String(entry.command)),
        ),
        "should create a new sandbox when user confirms recreate",
      );
      assert.ok(
        result.stdout.includes("requested inference selection changed"),
        "should show drift warning before prompting",
      );
    },
  );

  it(
    "interactive mode auto-recreates when existing sandbox is not ready",
    { timeout: 60_000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-onboard-interactive-notready-"),
      );
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "interactive-notready.js");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
let sandboxDeleted = false;
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  if (_n(command).includes("sandbox delete")) sandboxDeleted = true;
  return { status: 0 };
};
runner.runCapture = (command) => {
  // Existing sandbox that is NOT ready initially, becomes Ready after recreation
  if (_n(command).includes("sandbox get my-assistant")) return "my-assistant";
  if (_n(command).includes("sandbox list")) {
    return sandboxDeleted ? "my-assistant Ready" : "my-assistant NotReady";
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command, {
      defaultCurlOutput: "ok",
    });
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;

const preflight = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"))});
preflight.checkPortAvailable = async () => ({ ok: true });

// User confirms recreation when prompted
credentials.prompt = async () => "y";

const fakeSpawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};
childProcess.spawn = fakeSpawn;

// Also patch spawn inside the compiled sandbox-create-stream module.
// It imports spawn at load time from "node:child_process", so patching the
// childProcess object above does not reach it. Patch the cached module
// directly so streamSandboxCreate (called by createSandbox) doesn't spawn
// a real bash process that tries to hit a live gateway.
const sandboxCreateStreamMod = require(${JSON.stringify(path.join(repoRoot, "dist", "lib", "sandbox", "create-stream.js"))});
const _origStreamCreate = sandboxCreateStreamMod.streamSandboxCreate;
sandboxCreateStreamMod.streamSandboxCreate = (command, env, options = {}) => {
  return _origStreamCreate(command, env, { ...options, spawnImpl: fakeSpawn });
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      // Run WITHOUT NEMOCLAW_NON_INTERACTIVE to exercise interactive path
      const env: Record<string, string | undefined> = {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_RECREATE_WITHOUT_BACKUP: "1",
      };
      delete env["NEMOCLAW_NON_INTERACTIVE"];
      delete env["NEMOCLAW_RECREATE_SANDBOX"];
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
      });

      assert.equal(result.status, 0, result.stderr);
      const payloadLine = result.stdout
        .trim()
        .split("\n")
        .slice()
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
      const payload = JSON.parse(payloadLine);

      assert.ok(
        payload.commands.some((entry: CommandEntry) => entry.command.includes("sandbox delete")),
        "should delete not-ready sandbox after user confirms",
      );
      assert.ok(
        payload.commands.some((entry: CommandEntry) => entry.command.includes("sandbox create")),
        "should recreate sandbox when existing one is not ready",
      );
      assert.ok(result.stdout.includes("not ready"), "should mention sandbox is not ready");
    },
  );
  it(
    "continues once the sandbox is Ready even if the create stream never closes",
    { timeout: 20000 },
    async () => {
      const repoRoot = path.join(import.meta.dirname, "..");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-create-ready-"));
      const fakeBin = path.join(tmpDir, "bin");
      const scriptPath = path.join(tmpDir, "create-sandbox-ready-check.js");
      const payloadPath = path.join(tmpDir, "payload.json");
      const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
      const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
      const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
      const preflightPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard", "preflight.js"));
      const credentialsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "credentials", "store.js"));

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");

const commands = [];
let sandboxListCalls = 0;
const keepAlive = setInterval(() => {}, 1000);
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) {
    sandboxListCalls += 1;
    return sandboxListCalls >= 2 ? "my-assistant Ready" : "my-assistant Pending";
  }
  {
    const sandboxExecCurl = require(${onboardScriptMocksPath}).mockSandboxExecCurl(command);
    if (sandboxExecCurl !== null) return sandboxExecCurl;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  child.killCalls = [];
  child.unrefCalls = 0;
  child.stdout.destroyCalls = 0;
  child.stderr.destroyCalls = 0;
  child.stdout.destroy = () => {
    child.stdout.destroyCalls += 1;
  };
  child.stderr.destroy = () => {
    child.stderr.destroyCalls += 1;
  };
  child.unref = () => {
    child.unrefCalls += 1;
  };
  child.kill = (signal) => {
    child.killCalls.push(signal);
    process.nextTick(() => child.emit("close", signal === "SIGTERM" ? 0 : 1));
    return true;
  };
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null, child });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4");
  const createCommand = commands.find((entry) => entry.command.includes("sandbox create"));
  fs.writeFileSync(${JSON.stringify(payloadPath)}, JSON.stringify({
    sandboxName,
    sandboxListCalls,
    killCalls: createCommand.child.killCalls,
    unrefCalls: createCommand.child.unrefCalls,
    stdoutDestroyCalls: createCommand.child.stdout.destroyCalls,
    stderrDestroyCalls: createCommand.child.stderr.destroyCalls,
  }));
  clearInterval(keepAlive);
})().catch((error) => {
  clearInterval(keepAlive);
  console.error(error);
  process.exit(1);
});
`;
      fs.writeFileSync(scriptPath, script);

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          NEMOCLAW_NON_INTERACTIVE: "1",
          OPENSHELL_DRIVERS: "docker",
        },
        timeout: 15000,
      });

      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
      assert.equal(payload.sandboxName, "my-assistant");
      assert.ok(payload.sandboxListCalls >= 2);
      assert.deepEqual(payload.killCalls, ["SIGTERM"]);
      assert.equal(payload.unrefCalls, 1);
      assert.equal(payload.stdoutDestroyCalls, 1);
      assert.equal(payload.stderrDestroyCalls, 1);
    },
  );

  it("restores the dashboard forward when onboarding reuses an existing ready sandbox", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-reuse-forward-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "reuse-sandbox-forward.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "my-assistant";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.getSandbox = () => ({ name: "my-assistant", gpuEnabled: false });

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => child.emit("close", 0));
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.CHAT_UI_URL = "https://chat.example.com";
  const sandboxName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      sandboxName: string;
      commands: CommandEntry[];
    }>(result.stdout);
    assert.equal(payload.sandboxName, "my-assistant");
    assert.ok(
      payload.commands.some((entry: CommandEntry) =>
        entry.command.includes("forward start --background 0.0.0.0:18789 my-assistant"),
      ),
      "expected dashboard forward restore on sandbox reuse",
    );
    assert.ok(
      payload.commands.every((entry: CommandEntry) => !entry.command.includes("sandbox create")),
      "did not expect sandbox create when reusing existing sandbox",
    );
  });

  it("accepts gateway inference when system inference is separately not configured", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-inference-get-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "inference-get-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
      "",
      "System inference:",
      "",
      "  Not configured",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;
process.env.OPENAI_API_KEY = "sk-secret-value";
process.env.OPENSHELL_GATEWAY = "nemoclaw";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = parseStdoutJson<string[]>(result.stdout);
    // gateway select + provider get + provider update + inference set
    assert.equal(commands.length, 4);
  });

  it("accepts gateway inference output that omits the Route line", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-inference-route-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "inference-route-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("inference") && _n(command).includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
      "",
      "System inference:",
      "",
      "  Not configured",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;
process.env.OPENAI_API_KEY = "sk-secret-value";
process.env.OPENSHELL_GATEWAY = "nemoclaw";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
  console.log(JSON.stringify(commands));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = parseStdoutJson<string[]>(result.stdout);
    // gateway select + provider get + provider update + inference set
    assert.equal(commands.length, 4);
  });

  it("regression #1904: pullAndResolveBaseImageDigest uses sandbox-base registry", () => {
    // Structural check: verify the constant matches the Dockerfile default
    // and does NOT reference the openshell-community registry.
    assert.ok(
      SANDBOX_BASE_IMAGE.includes("nemoclaw/sandbox-base"),
      `SANDBOX_BASE_IMAGE must reference nemoclaw/sandbox-base, got: ${SANDBOX_BASE_IMAGE}`,
    );
    assert.ok(
      !SANDBOX_BASE_IMAGE.includes("openshell-community"),
      `SANDBOX_BASE_IMAGE must NOT reference openshell-community, got: ${SANDBOX_BASE_IMAGE}`,
    );
  });

  it("aborts createSandbox for missing BRAVE_API_KEY before any sandbox delete (#3626)", () => {
    // Regression: the Brave credential guard previously sat *after* the
    // recreate/sandbox-delete branch ran. A user with Brave enabled and no
    // BRAVE_API_KEY would lose their existing sandbox before seeing the abort.
    // Move it next to the credential lookup and assert no `sandbox delete`
    // command escapes before exit.
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-brave-abort-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "brave-abort-check.js");
    const outputPath = path.join(tmpDir, "outcome.json");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const outputPathLiteral = JSON.stringify(outputPath);

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });

    const script = String.raw`
const fs = require("node:fs");
const runner = require(${runnerPath});

const openshellCalls = [];
runner.runOpenshell = (command) => {
  openshellCalls.push(Array.isArray(command) ? command.join(" ") : String(command));
  return { status: 0, stdout: "", stderr: "" };
};
runner.runCaptureOpenshell = () => "";
runner.run = (command) => {
  openshellCalls.push("run: " + (Array.isArray(command) ? command.join(" ") : String(command)));
  return { status: 0 };
};

const errors = [];
const originalError = console.error;
console.error = (...args) => errors.push(args.join(" "));
const originalExit = process.exit;
process.exit = (code) => {
  fs.writeFileSync(${outputPathLiteral}, JSON.stringify({ exitCode: code, errors, openshellCalls }));
  originalExit(code);
};

// Reproduce the bug scenario: Brave enabled, no key anywhere.
delete process.env.BRAVE_API_KEY;

const { createSandbox } = require(${onboardPath});
(async () => {
  await createSandbox(
    null,           // gpu
    "gpt-5.4",      // model
    "nvidia-prod",  // provider
    null,           // preferredInferenceApi
    "my-assistant", // sandboxNameOverride
    { fetchEnabled: true }, // webSearchConfig
  );
})().catch(() => {});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_RECREATE_SANDBOX: "1",
        BRAVE_API_KEY: "",
      },
    });

    assert.ok(
      fs.existsSync(outputPath),
      `outcome file missing; exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const payload = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as {
      exitCode: number;
      errors: string[];
      openshellCalls: string[];
    };
    expect(payload.exitCode).toBe(1);
    expect(payload.errors.join("\n")).toMatch(/BRAVE_API_KEY is not available/);
    // The abort must run before *any* destructive openshell command —
    // most importantly `sandbox delete`. `forward list` is read-only and
    // happens earlier; only flag mutating commands here.
    const destructive = payload.openshellCalls.filter((c) =>
      /\bsandbox\s+(?:delete|create|rebuild)\b|\bprovider\s+(?:delete|create|update)\b/.test(c),
    );
    expect(destructive).toEqual([]);
  });

});
