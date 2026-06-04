// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Issue #3751: `nemoclaw onboard` ignored the host's stopped Ollama and silently
// restarted it. These tests cover the new --no-ollama-autostart gate that lets
// QA (and offline reproductions) reach the "fall back to default" path without
// the wizard resurrecting the daemon.

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { testTimeout } from "./helpers/timeouts";

const OLLAMA_AUTOSTART_TEST_TIMEOUT_MS = testTimeout(60_000);

type ScenarioOptions = {
  ollamaRunning: boolean;
  // When set, exported as NEMOCLAW_OLLAMA_NO_AUTOSTART=1.
  noAutostartEnv?: boolean;
  // When true, the test forces non-interactive mode via env. The wizard would
  // normally process.exit(1) on a waitForHttp timeout — Scenario D asserts the
  // gate path does NOT call process.exit.
  nonInteractive?: boolean;
  // When true, stub waitForHttp to return false. Only used to verify that the
  // gated path does not even reach waitForHttp.
  waitForHttpReturnsFalse?: boolean;
  // When true, allow the wizard to reach selectAndValidateOllamaModel by
  // stubbing startOllamaAuthProxy to a no-op success rather than the bail-out
  // sentinel. Used by the #4365 runner-crash escape scenarios.
  proceedToModelSelection?: boolean;
  // Body returned by the fake curl for `/api/generate` probes (used by
  // validateOllamaModel). Defaults to a healthy response. Set to a runner-
  // crash payload to drive the #4365 daemonFailure escape path.
  ollamaGenerateBody?: string;
  // Bound the subprocess wall-clock. Defaults to the scenario timeout. A
  // pre-fix runner-crash loop would never exit — assert against this to catch
  // regressions.
  subprocessTimeoutMs?: number;
  // Override the NEMOCLAW_PROVIDER env value. Default is the literal `ollama`
  // (pinned). Use a casing variant ("OLLAMA", " ollama ") to exercise the
  // isOllamaProviderPinned normalization path. (#4365)
  providerEnv?: string;
};

type WizardResult = {
  result: {
    provider: string;
    model: string;
    preferredInferenceApi: string | null;
    endpointUrl: string | null;
    credentialEnv: string | null;
  } | null;
  lines: string[];
  shellCommands: string[];
  waitForHttpCalls: string[];
  processExitCalled: number;
  selectAndValidateOllamaModelCalled: boolean;
  sentinelTripped: boolean;
};

function runOllamaAutostartScenario(opts: ScenarioOptions): WizardResult {
  const repoRoot = path.join(import.meta.dirname, "..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-ollama-autostart-"));
  const fakeBin = path.join(tmpDir, "bin");
  const scriptPath = path.join(tmpDir, "onboard-ollama-autostart-check.js");
  const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
  const credentialsPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "credentials", "store.js"),
  );
  const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
  const platformPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "platform.js"));
  const waitPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "core", "wait.js"));
  const localInferencePath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "inference", "local.js"),
  );
  const proxyPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "inference", "ollama", "proxy.js"),
  );

  fs.mkdirSync(fakeBin, { recursive: true });
  // Curl stub: respond with an OpenAI-compatible chat-completions tool-call
  // body for any request (validation in selectAndValidateOllamaModel requires
  // a successful tool-call response). The /api/tags response is shaped like
  // ollama's daemon and is consulted by validation helpers in inference/local.
  // For the "stopped" case, the runner.runCapture stub returns "" for tags,
  // which is what gates the wizard — the curl stub itself stays permissive.
  const toolCallBody =
    '{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"type":"function","function":{"name":"emit_ok","arguments":"{\\"ok\\":true}"}}]}}]}';
  // /api/generate body — validateOllamaModel parses this and looks for an
  // `error` key. A healthy default; #4365 scenarios override with a runner-
  // crash payload to drive the daemonFailure path.
  const generateBody = opts.ollamaGenerateBody ?? '{"response":"hello"}';
  // /api/tags body. local.ts destructures `runCapture` at module load time,
  // BEFORE the test mutates runner.runCapture — so `getOllamaModelOptions`
  // (in local.ts) still calls through to the real spawnSync and lands on
  // this fake curl. Returning a tag matching the bootstrap fallback
  // (smallest registry entry) keeps the menu deterministic with gpu=null
  // and ensures the picked model is already-installed (no pull prompt).
  const tagsBody = '{"models":[{"name":"qwen3.5:9b"}]}';
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
url=""
for arg in "$@"; do
  case "$arg" in
    http://*|https://*) url="$arg" ;;
  esac
done
case "$url" in
  *api/generate*)
    printf '%s' '${generateBody.replace(/'/g, "'\\''")}'
    exit 0
    ;;
  *api/tags*)
    printf '%s' '${tagsBody.replace(/'/g, "'\\''")}'
    exit 0
    ;;
esac
body='${toolCallBody}'
status="200"
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$outfile" ]; then printf '%s' "$body" > "$outfile"; fi
printf '%s' "$status"
`,
    { mode: 0o755 },
  );
  // ollama binary stub — only matters for hostCommandExists("ollama").
  fs.writeFileSync(path.join(fakeBin, "ollama"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const scenarioEnv: Record<string, string> = {
    HOME: tmpDir,
    PATH: `${fakeBin}:${process.env.PATH || ""}`,
    // Pin provider selection so the test deterministically enters the Ollama
    // branch of the wizard regardless of menu ordering changes elsewhere.
    NEMOCLAW_PROVIDER: opts.providerEnv ?? "ollama",
  };
  if (opts.noAutostartEnv) scenarioEnv.NEMOCLAW_OLLAMA_NO_AUTOSTART = "1";
  if (opts.nonInteractive) scenarioEnv.NEMOCLAW_NON_INTERACTIVE = "1";

  const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const platform = require(${platformPath});
const wait = require(${waitPath});
const localInference = require(${localInferencePath});
const child_process = require("child_process");

// Background process spawn: never let a real ollama serve fork off in the
// test harness (defense in depth — the spawn path uses runShell, not spawn).
child_process.spawn = () => ({ pid: 99999, unref() {}, on() {} });
const originalSpawnSync = child_process.spawnSync;
child_process.spawnSync = (cmd, args, opts) => {
  if (cmd === "nc" && args && args.includes("11435")) {
    return { status: 0, stdout: "", stderr: "", signal: null };
  }
  if (cmd === "ps") {
    return { status: 0, stdout: "node ollama-auth-proxy.js", stderr: "", signal: null };
  }
  return originalSpawnSync(cmd, args, opts);
};

const ollamaRunning = ${JSON.stringify(opts.ollamaRunning)};
const shellCommands = [];
const waitForHttpCalls = [];
const lines = [];
let processExitCalled = 0;
let selectAndValidateOllamaModelCalled = false;

// Force Linux + non-WSL to deterministically reach the "ollama" menu key
// rather than Windows-host paths.
Object.defineProperty(process, "platform", { value: "linux" });
platform.isWsl = () => false;

// Menu answers: "1" picks the first option whenever a prompt asks. The
// Ollama option is always offered when the binary is present (or running).
const answers = ${JSON.stringify(opts.nonInteractive ? [] : ["1"])};
credentials.prompt = async () => {
  return answers.shift() || "";
};
credentials.ensureApiKey = async () => {};

runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  // Order matters: the systemd unit probe is a sh -c snippet that contains
  // BOTH "command -v systemctl" and "ollama.service" — it must NOT be
  // mistaken for "command -v ollama". Check the systemd probe first and
  // return empty so ensureOllamaLoopbackSystemdOverride takes the
  // "not-applicable" branch.
  if (cmd.includes("systemctl list-unit-files ollama.service")) return "";
  if (cmd.includes("command -v") && cmd.includes("\"$1\"")) {
    // hostCommandExists uses: sh -c 'command -v "$1"' -- <name>. The argv
    // contains the literal '"$1"' marker.
    return cmd.includes("ollama") ? "/usr/bin/ollama" : "";
  }
  if (cmd.includes("127.0.0.1:11434/api/tags")) {
    return ollamaRunning ? JSON.stringify({ models: [{ name: "nemotron-3-nano:30b" }] }) : "";
  }
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("ollama list")) {
    return ollamaRunning ? "nemotron-3-nano:30b  abc  24 GB  now" : "";
  }
  if (cmd.includes("api/generate")) return '{"response":"hello"}';
  if (cmd.includes("ps")) return "node ollama-auth-proxy.js";
  return "";
};
runner.run = () => ({ status: 0 });
runner.runShell = (command) => {
  shellCommands.push(command);
  return { status: 0 };
};

wait.sleepSeconds = () => {};
const originalWaitForHttp = wait.waitForHttp;
wait.waitForHttp = (url, tries) => {
  waitForHttpCalls.push(String(url));
  if (${JSON.stringify(opts.waitForHttpReturnsFalse === true)}) return false;
  return true;
};

// Pre-loaded by onboard.ts at import time — reset so the test scenario's
// runCapture stub decides reachability fresh.
localInference.resetOllamaHostCache();
// Stub the *exported* findReachableOllamaHost. onboard.ts destructures this
// reference at its require time, so the stub MUST be installed before the
// onboard require() below.
localInference.findReachableOllamaHost = () => (ollamaRunning ? "127.0.0.1" : null);

// Sentinel: startOllamaAuthProxy is called downstream of the Ollama branch
// (after either the spawn path or the "already running" path). Throwing a
// sentinel here bails out of the wizard once it has done everything that
// matters for the gated-vs-spawn assertions. The fallback branch breaks out
// of selectionLoop BEFORE this is reached, so Scenarios A and D never see
// the sentinel — only B and C do. The #4365 scenarios opt out so the wizard
// can reach selectAndValidateOllamaModel.
const proxy = require(${proxyPath});
class OllamaAutostartSentinel extends Error {}
const proceedToModelSelection = ${JSON.stringify(opts.proceedToModelSelection === true)};
if (proceedToModelSelection) {
  proxy.startOllamaAuthProxy = () => true;
} else {
  proxy.startOllamaAuthProxy = () => {
    throw new OllamaAutostartSentinel("ollama-autostart-test-sentinel");
  };
}

// Wrap selectAndValidateOllamaModel to record whether the wizard reached it.
// Access via the dist module's exported function (it's local in source, but
// the local function in onboard.ts uses runCapture/localInference; we observe
// the side-effect via "Loading Ollama model" log lines).
const onboard = require(${onboardPath});

// Wrap process.exit to count invocations rather than terminate the test.
const originalExit = process.exit;
process.exit = (code) => {
  processExitCalled++;
  throw new Error("process.exit:" + (code ?? 0));
};

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => {
    const line = args.join(" ");
    lines.push(line);
    if (line.includes("Loading Ollama model")) {
      selectAndValidateOllamaModelCalled = true;
    }
  };
  console.error = (...args) => lines.push(args.join(" "));
  let result = null;
  let sentinelTripped = false;
  try {
    result = await onboard.setupNim(null);
  } catch (error) {
    const msg = String(error && error.message);
    if (error instanceof OllamaAutostartSentinel || msg.includes("ollama-autostart-test-sentinel")) {
      sentinelTripped = true;
    } else if (!msg.startsWith("process.exit:")) {
      console.error = originalError;
      console.log = originalLog;
      process.exit = originalExit;
      throw error;
    }
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.exit = originalExit;
  }
  originalLog(JSON.stringify({
    result,
    lines,
    shellCommands,
    waitForHttpCalls,
    processExitCalled,
    selectAndValidateOllamaModelCalled,
    sentinelTripped,
  }));
})().catch((error) => {
  console.error(error);
  originalExit(2);
});
`;
  fs.writeFileSync(scriptPath, script);

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      ...scenarioEnv,
      // Force loopback-only path to avoid systemd / install branches.
      NEMOCLAW_OLLAMA_INSTALL_MODE: "system",
      // Clear any inherited overrides from the parent test runner. NEMOCLAW_PROVIDER
      // is set above in scenarioEnv to route the wizard into the Ollama branch.
      NEMOCLAW_MODEL: "",
      NEMOCLAW_YES: "",
    },
    // Bound the subprocess so a pre-fix runner-crash loop cannot wedge
    // the test runner. (#4365)
    timeout: opts.subprocessTimeoutMs ?? OLLAMA_AUTOSTART_TEST_TIMEOUT_MS,
  });

  assert.equal(result.status, 0, `subprocess stderr:\n${result.stderr}\n\nstdout:\n${result.stdout}`);
  const lastBraceLine = result.stdout
    .trim()
    .split("\n")
    .reverse()
    .find((line) => line.startsWith("{"));
  if (!lastBraceLine) {
    throw new Error(`no JSON payload in subprocess stdout:\n${result.stdout}`);
  }
  return JSON.parse(lastBraceLine);
}

describe("nemoclaw onboard --no-ollama-autostart (issue #3751)", () => {
  it(
    "Scenario A: stopped Ollama + flag set → no spawn, warning, falls back to DEFAULT_OLLAMA_MODEL",
    { timeout: OLLAMA_AUTOSTART_TEST_TIMEOUT_MS },
    () => {
      const payload = runOllamaAutostartScenario({
        ollamaRunning: false,
        noAutostartEnv: true,
      });

      // No ollama serve spawn, no waitForHttp probe to :11434.
      assert.ok(
        !payload.shellCommands.some((cmd) => cmd.includes("ollama serve")),
        `runShell must not be invoked with 'ollama serve' when the gate is set; got: ${JSON.stringify(payload.shellCommands)}`,
      );
      assert.ok(
        !payload.waitForHttpCalls.some((url) => url.includes("127.0.0.1:11434")),
        `waitForHttp must not probe :11434 when the gate is set; got: ${JSON.stringify(payload.waitForHttpCalls)}`,
      );
      // Exact warning string from the architect contract.
      assert.ok(
        payload.lines.some((line) =>
          line.includes(
            "⚠ Ollama is not running on localhost:11434 and --no-ollama-autostart is set; skipping auto-start and falling back to the default model.",
          ),
        ),
        `expected the gated warning line; got lines:\n${payload.lines.join("\n")}`,
      );
      // Should not have printed the success "Using Ollama on …" line.
      assert.ok(
        !payload.lines.some((line) => line.includes("✓ Using Ollama")),
        "fallback branch must not log the ✓ Using Ollama line",
      );
      assert.ok(payload.result, "wizard should have completed");
      assert.equal(payload.result!.provider, "ollama-local");
      // Hard-asserted against the architect contract, but the constant is the
      // single source of truth. Read it from the dist module the wizard uses.
      const { DEFAULT_OLLAMA_MODEL } = require(
        path.join(import.meta.dirname, "..", "dist", "lib", "inference", "local.js"),
      );
      assert.equal(payload.result!.model, DEFAULT_OLLAMA_MODEL);
      assert.equal(payload.result!.preferredInferenceApi, "openai-completions");
      assert.equal(payload.result!.credentialEnv, null);
      assert.ok(
        payload.result!.endpointUrl && payload.result!.endpointUrl.length > 0,
        "fallback branch must populate endpointUrl from getLocalProviderBaseUrl",
      );
      // selectAndValidateOllamaModel is intentionally bypassed.
      assert.equal(payload.selectAndValidateOllamaModelCalled, false);
      // The fallback `break` exits selectionLoop BEFORE startOllamaAuthProxy is
      // reached — sentinel must not have tripped.
      assert.equal(
        payload.sentinelTripped,
        false,
        "gated fallback must not reach startOllamaAuthProxy",
      );
    },
  );

  it(
    "Scenario B: stopped Ollama + flag NOT set → existing spawn path preserved",
    { timeout: OLLAMA_AUTOSTART_TEST_TIMEOUT_MS },
    () => {
      const payload = runOllamaAutostartScenario({
        ollamaRunning: false,
        noAutostartEnv: false,
      });

      assert.ok(
        payload.shellCommands.some(
          (cmd) => cmd.includes("OLLAMA_HOST=127.0.0.1:") && cmd.includes("ollama serve"),
        ),
        `expected the legacy spawn to fire; got: ${JSON.stringify(payload.shellCommands)}`,
      );
      assert.ok(
        payload.lines.some((line) => line.includes("Starting Ollama...")),
        `expected the "Starting Ollama..." log; got lines:\n${payload.lines.join("\n")}`,
      );
      // The gated warning string must NOT be emitted on this path.
      assert.ok(
        !payload.lines.some((line) =>
          line.includes("--no-ollama-autostart is set"),
        ),
        "gate warning must not fire when the flag is unset",
      );
      // Sentinel tripped — proves the wizard exited the !ollamaReady block via
      // the spawn-then-proxy path (i.e. moved on to startOllamaAuthProxy), NOT
      // via the gated `break` that fallback uses.
      assert.equal(
        payload.sentinelTripped,
        true,
        `expected wizard to reach the post-spawn proxy step; lines:\n${payload.lines.join("\n")}`,
      );
    },
  );

  it(
    "Scenario C (flag unset): Ollama already running → behavior unchanged, no spawn, no warning",
    { timeout: OLLAMA_AUTOSTART_TEST_TIMEOUT_MS },
    () => {
      const payload = runOllamaAutostartScenario({
        ollamaRunning: true,
        noAutostartEnv: false,
      });

      assert.ok(
        !payload.shellCommands.some((cmd) => cmd.includes("ollama serve")),
        "no spawn expected when Ollama is already reachable",
      );
      assert.ok(
        !payload.waitForHttpCalls.some((url) => url.includes("127.0.0.1:11434")),
        "no startup probe expected when Ollama is already reachable",
      );
      assert.ok(
        !payload.lines.some((line) => line.includes("Starting Ollama...")),
        "no 'Starting Ollama...' line expected when daemon is already up",
      );
      assert.ok(
        !payload.lines.some((line) => line.includes("--no-ollama-autostart is set")),
        "gate warning must not fire when daemon is already up",
      );
      // Wizard should have reached the proxy step (post-readiness), not the
      // gated `break` path.
      assert.equal(payload.sentinelTripped, true);
    },
  );

  it(
    "Scenario C (flag set): Ollama already running + flag set → no warning, no spawn",
    { timeout: OLLAMA_AUTOSTART_TEST_TIMEOUT_MS },
    () => {
      const payload = runOllamaAutostartScenario({
        ollamaRunning: true,
        noAutostartEnv: true,
      });

      assert.ok(
        !payload.shellCommands.some((cmd) => cmd.includes("ollama serve")),
        "no spawn expected when Ollama is already reachable, regardless of flag",
      );
      assert.ok(
        !payload.lines.some((line) => line.includes("--no-ollama-autostart is set")),
        "gate warning must not fire when daemon is already up — flag is orthogonal",
      );
      // Flag is irrelevant here: the wizard still proceeds via the proxy path,
      // not the fallback break.
      assert.equal(payload.sentinelTripped, true);
    },
  );

  it(
    "Scenario D: non-interactive + flag set → no process.exit, warning, model = DEFAULT_OLLAMA_MODEL",
    { timeout: OLLAMA_AUTOSTART_TEST_TIMEOUT_MS },
    () => {
      const payload = runOllamaAutostartScenario({
        ollamaRunning: false,
        noAutostartEnv: true,
        nonInteractive: true,
        // Hard-fail waitForHttp so the test would observe a non-interactive
        // process.exit(1) if the gate did not fire. With the gate set, this
        // stub must not even be reached.
        waitForHttpReturnsFalse: true,
      });

      assert.equal(
        payload.processExitCalled,
        0,
        `non-interactive must not exit when the gate is honored; lines:\n${payload.lines.join("\n")}`,
      );
      assert.ok(
        payload.lines.some((line) =>
          line.includes(
            "⚠ Ollama is not running on localhost:11434 and --no-ollama-autostart is set; skipping auto-start and falling back to the default model.",
          ),
        ),
        `expected gated warning in non-interactive mode; lines:\n${payload.lines.join("\n")}`,
      );
      assert.ok(
        !payload.shellCommands.some((cmd) => cmd.includes("ollama serve")),
        "no spawn expected with the gate set, even in non-interactive mode",
      );
      assert.ok(payload.result, "non-interactive wizard should still produce a result");
      const { DEFAULT_OLLAMA_MODEL } = require(
        path.join(import.meta.dirname, "..", "dist", "lib", "inference", "local.js"),
      );
      assert.equal(payload.result!.model, DEFAULT_OLLAMA_MODEL);
      assert.equal(payload.result!.provider, "ollama-local");
      // Non-interactive gate path must not reach the proxy stage either.
      assert.equal(payload.sentinelTripped, false);
    },
  );

  it(
    "Scenario G (#4365): pinned-provider runner crash exits instead of looping on Ollama model selection",
    { timeout: OLLAMA_AUTOSTART_TEST_TIMEOUT_MS },
    () => {
      // Reporter's second-step: Ollama responds, user reaches model selection,
      // but the model runner has unexpectedly stopped. Pre-fix the wizard would
      // re-prompt for another Ollama model forever (or until the user finds
      // "back"). With the fix, daemonFailure is detected and the wizard exits
      // when NEMOCLAW_PROVIDER=ollama is pinned. The bounded subprocess
      // timeout catches a regression: a pre-fix subprocess would loop until
      // SIGTERM and result.status would be null.
      const payload = runOllamaAutostartScenario({
        ollamaRunning: true,
        noAutostartEnv: false,
        proceedToModelSelection: true,
        ollamaGenerateBody: JSON.stringify({
          error: "model runner has unexpectedly stopped, this may be due to resource limitations or an internal error",
        }),
        subprocessTimeoutMs: 20_000,
      });

      assert.ok(
        payload.lines.some((line) =>
          line.includes("model runner has unexpectedly stopped"),
        ),
        `expected the runner-crash error in lines; got:\n${payload.lines.join("\n")}`,
      );
      assert.ok(
        payload.lines.some((line) =>
          line.includes(
            "NEMOCLAW_PROVIDER pins onboarding to Ollama but the Ollama model runner is unhealthy",
          ),
        ),
        `expected the pinned-provider runner-crash abort message; lines:\n${payload.lines.join("\n")}`,
      );
      assert.ok(
        payload.processExitCalled >= 1,
        `expected process.exit on runner crash with pinned provider; lines:\n${payload.lines.join("\n")}`,
      );
    },
  );

  it(
    "Scenario H (#4365): pinned-provider runner crash also exits when NEMOCLAW_PROVIDER uses a casing variant",
    { timeout: OLLAMA_AUTOSTART_TEST_TIMEOUT_MS },
    () => {
      // NEMOCLAW_PROVIDER=OLLAMA is accepted by getNonInteractiveProvider's
      // .trim().toLowerCase() normalization. The runner-crash escape must
      // recognize the same variants — otherwise the wizard would return
      // `back-to-selection`, re-pin Ollama on the next iteration, and loop.
      const payload = runOllamaAutostartScenario({
        ollamaRunning: true,
        noAutostartEnv: false,
        proceedToModelSelection: true,
        providerEnv: " OLLAMA ",
        ollamaGenerateBody: JSON.stringify({
          error: "model runner has unexpectedly stopped",
        }),
        subprocessTimeoutMs: 20_000,
      });

      assert.ok(
        payload.lines.some((line) =>
          line.includes(
            "NEMOCLAW_PROVIDER pins onboarding to Ollama but the Ollama model runner is unhealthy",
          ),
        ),
        `expected the pinned-provider runner-crash abort even with a casing variant; lines:\n${payload.lines.join("\n")}`,
      );
      assert.ok(
        payload.processExitCalled >= 1,
        `expected process.exit on runner crash with casing-variant pinned provider; lines:\n${payload.lines.join("\n")}`,
      );
    },
  );

  it(
    "Scenario E: stopped Ollama + flag NOT set + NEMOCLAW_PROVIDER=ollama + waitForHttp timeout → process.exit, no selectionLoop re-entry",
    { timeout: OLLAMA_AUTOSTART_TEST_TIMEOUT_MS },
    () => {
      // Reporter scenario: provider pinned via env, gate not set, Ollama
      // unreachable, spawn-then-wait fails. Previously `continue selectionLoop`
      // would immediately re-enter the same Ollama branch because
      // NEMOCLAW_PROVIDER=ollama forces the menu to keep selecting Ollama.
      // The fix surfaces a failure (process.exit) instead of looping.
      const payload = runOllamaAutostartScenario({
        ollamaRunning: false,
        noAutostartEnv: false,
        nonInteractive: false,
        waitForHttpReturnsFalse: true,
      });

      assert.ok(
        payload.processExitCalled >= 1,
        `expected process.exit to be called when provider is pinned and Ollama is unreachable; lines:\n${payload.lines.join("\n")}`,
      );
      assert.ok(
        payload.lines.some((line) =>
          line.includes("NEMOCLAW_PROVIDER pins onboarding to Ollama but Ollama is unreachable"),
        ),
        `expected pinned-provider abort message; lines:\n${payload.lines.join("\n")}`,
      );
      // Sentinel guards the post-spawn proxy step. If selectionLoop had looped
      // and a future iteration reached the proxy, the sentinel would have
      // tripped. With the fix, we exit before that.
      assert.equal(
        payload.sentinelTripped,
        false,
        "abort must happen before reaching the proxy stage",
      );
    },
  );
});
