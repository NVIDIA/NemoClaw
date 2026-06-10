// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { testTimeout } from "./helpers/timeouts";

const PROVIDER_SELECTION_TEST_TIMEOUT_MS = testTimeout(60_000);

describe("onboard provider selection vLLM UX", {
  timeout: PROVIDER_SELECTION_TEST_TIMEOUT_MS,
}, () => {
  it("offers detected running vLLM without requiring a rerun", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-vllm-running-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "vllm-running-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "credentials", "store.js"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"id":"ok"}'
status="200"
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
      { mode: 0o755 },
    );
    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

const messages = [];
const lines = [];
const originalLog = console.log;

function findRunningVllmChoice() {
  const option = lines.find((line) =>
    /^\s*\d+\) Local vLLM \[experimental\] \(localhost:8000\) — running \(suggested\)/.test(line)
  );
  const match = option && option.match(/^\s*(\d+)\)/);
  if (!match) {
    throw new Error("Could not find running vLLM option in menu:\\n" + lines.join("\\n"));
  }
  return match[1];
}

credentials.prompt = async (message) => {
  messages.push(message);
  if (/Choose \[/.test(message)) return findRunningVllmChoice();
  return "";
};
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) {
    return JSON.stringify({
      data: [{ id: "meta-llama/Llama-3.3-70B-Instruct", max_model_len: 65536 }],
    });
  }
  if (cmd.includes("docker images")) return "";
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim({ type: "nvidia" }, null);
    originalLog(
      JSON.stringify({
        result,
        messages,
        lines,
        contextWindow: process.env.NEMOCLAW_CONTEXT_WINDOW,
      }),
    );
  } finally {
    console.log = originalLog;
  }
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
        NEMOCLAW_EXPERIMENTAL: "",
        NEMOCLAW_PROVIDER: "",
        NEMOCLAW_CONTEXT_WINDOW: "",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.result.provider, "vllm-local");
    assert.equal(payload.result.model, "meta-llama/Llama-3.3-70B-Instruct");
    assert.equal(payload.result.preferredInferenceApi, "openai-completions");
    assert.equal(payload.contextWindow, "65536");
    assert.equal(payload.messages.filter((message: string) => /Choose \[/.test(message)).length, 1);
    assert.ok(
      payload.lines.some((line: string) => line.includes("Detected local inference option: vLLM")),
    );
    assert.ok(
      payload.lines.some((line: string) => line.includes("Using vLLM max_model_len: 65536")),
    );
    assert.ok(
      payload.lines.some((line: string) =>
        /^\s*\d+\) Local vLLM \[experimental\] \(localhost:8000\) — running \(suggested\)/.test(
          line,
        ),
      ),
    );
    assert.ok(!payload.lines.some((line: string) => line.includes("rerun the same command")));
  });

  it("does not apply detected vLLM max_model_len when validation returns to provider selection", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-vllm-validation-"));
    const scriptPath = path.join(tmpDir, "vllm-validation-context-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "credentials", "store.js"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const validationPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "onboard", "inference-selection-validation.js"),
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const validationHelpers = require(${validationPath});

class StopAfterValidationBackout extends Error {}

const messages = [];
const lines = [];
const originalLog = console.log;
let chooseCount = 0;

function findRunningVllmChoice() {
  const option = lines.find((line) =>
    /^\s*\d+\) Local vLLM \[experimental\] \(localhost:8000\) — running \(suggested\)/.test(line)
  );
  const match = option && option.match(/^\s*(\d+)\)/);
  if (!match) {
    throw new Error("Could not find running vLLM option in menu:\\n" + lines.join("\\n"));
  }
  return match[1];
}

credentials.prompt = async (message) => {
  messages.push(message);
  if (/Choose \[/.test(message)) {
    chooseCount += 1;
    if (chooseCount === 1) return findRunningVllmChoice();
    throw new StopAfterValidationBackout("validation returned to provider selection");
  }
  return "";
};
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) {
    return JSON.stringify({
      data: [{ id: "meta-llama/Llama-3.3-70B-Instruct", max_model_len: 65536 }],
    });
  }
  if (cmd.includes("docker images")) return "";
  return "";
};
validationHelpers.createInferenceSelectionValidationHelpers = () => ({
  validateOpenAiLikeSelection: async () => ({ ok: false, retry: "selection" }),
  validateAnthropicSelectionWithRetryMessage: async () => ({ ok: false, retry: "selection" }),
  validateCustomOpenAiLikeSelection: async () => ({ ok: false, retry: "selection" }),
  validateCustomAnthropicSelection: async () => ({ ok: false, retry: "selection" }),
});

const { setupNim } = require(${onboardPath});

(async () => {
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await setupNim({ type: "nvidia" }, null);
    throw new Error("setupNim unexpectedly completed");
  } catch (error) {
    if (!(error instanceof StopAfterValidationBackout)) throw error;
    originalLog(
      JSON.stringify({
        messages,
        lines,
        contextWindow: process.env.NEMOCLAW_CONTEXT_WINDOW || null,
      }),
    );
  } finally {
    console.log = originalLog;
  }
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
        NEMOCLAW_EXPERIMENTAL: "",
        NEMOCLAW_PROVIDER: "",
        NEMOCLAW_CONTEXT_WINDOW: "",
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
    const payload = JSON.parse(result.stdout.trim());
    assert.equal(payload.contextWindow, null);
    assert.equal(payload.messages.filter((message: string) => /Choose \[/.test(message)).length, 2);
    assert.ok(
      payload.lines.some((line: string) =>
        line.includes("Detected model: meta-llama/Llama-3.3-70B-Instruct"),
      ),
    );
    assert.ok(
      !payload.lines.some((line: string) => line.includes("Using vLLM max_model_len: 65536")),
    );
  });

  it("does not turn non-interactive NEMOCLAW_PROVIDER=vllm into managed install-vllm", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-vllm-no-install-"));
    const scriptPath = path.join(tmpDir, "vllm-no-install-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "credentials", "store.js"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const vllmPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "inference", "vllm.js"));

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const vllm = require(${vllmPath});

credentials.prompt = async () => {
  throw new Error("Unexpected prompt in non-interactive test");
};
credentials.ensureApiKey = async () => {
  throw new Error("Unexpected ensureApiKey call in non-interactive test");
};
vllm.installVllm = async () => {
  console.error("INSTALL_VLLM_CALLED");
  return { ok: false };
};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("docker images")) return "";
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  await setupNim({ type: "nvidia" }, null);
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "vllm",
        NEMOCLAW_EXPERIMENTAL: "",
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Requested provider 'vllm' is not available/);
    assert.doesNotMatch(result.stderr, /INSTALL_VLLM_CALLED/);
  });

  it("surfaces managed vLLM by default on DGX Spark and Station only", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-vllm-platform-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "vllm-platform-menu-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "credentials", "store.js"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const dockerRunPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "adapters", "docker", "run.js"),
    );
    type VllmPlatformScenario =
      | {
          name: string;
          gpu: { type: string; platform: string };
          vllmExpected: true;
          platformLabel: string;
        }
      | {
          name: string;
          gpu: { type: string; platform: string };
          vllmExpected: false;
        };
    const scenarios: VllmPlatformScenario[] = [
      {
        name: "spark",
        gpu: { type: "nvidia", platform: "spark" },
        vllmExpected: true,
        platformLabel: "DGX Spark",
      },
      {
        name: "station",
        gpu: { type: "nvidia", platform: "station" },
        vllmExpected: true,
        platformLabel: "DGX Station",
      },
      {
        name: "linux",
        gpu: { type: "nvidia", platform: "linux" },
        vllmExpected: false,
      },
    ];

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
body='{"id":"ok"}'
status="200"
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$body" > "$outfile"
printf '%s' "$status"
`,
      { mode: 0o755 },
    );

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const dockerRun = require(${dockerRunPath});

process.env.NEMOCLAW_NON_INTERACTIVE = "";
process.env.NEMOCLAW_EXPERIMENTAL = "";
process.env.NEMOCLAW_PROVIDER = "";
process.env.NEMOCLAW_MODEL = "";

credentials.ensureApiKey = async () => {
  process.env.NVIDIA_API_KEY = "nvapi-good";
};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("docker images")) return "";
  return "";
};
dockerRun.dockerCapture = () => "";

const scenarios = ${JSON.stringify(scenarios)};

async function runScenario(scenario) {
  const messages = [];
  const lines = [];
  credentials.prompt = async (message) => {
    messages.push(message);
    if (/Choose \[/.test(message)) return "1";
    return "";
  };
  process.env.NEMOCLAW_PROVIDER = "";
  process.env.NEMOCLAW_MODEL = "";
  process.env.NVIDIA_API_KEY = "";
  delete require.cache[require.resolve(${onboardPath})];
  const { setupNim } = require(${onboardPath});
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(scenario.gpu, null);
    return { name: scenario.name, result, messages, lines };
  } finally {
    console.log = originalLog;
  }
}

(async () => {
  const results = [];
  // These scenarios intentionally run serially in one process. The regression
  // varies only the gpu.platform argument passed into setupNim(), while the
  // expensive module graph and mocks are shared to keep this integration test
  // lightweight.
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }
  console.log(JSON.stringify({ results }));
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
        NEMOCLAW_NON_INTERACTIVE: "",
        NEMOCLAW_EXPERIMENTAL: "",
        NEMOCLAW_PROVIDER: "",
        NEMOCLAW_MODEL: "",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(result.stdout.trim(), "");
    const payload = JSON.parse(result.stdout.trim());

    for (const scenario of scenarios) {
      const scenarioResult = payload.results.find(
        (entry: { name: string }) => entry.name === scenario.name,
      );
      assert.ok(scenarioResult, scenario.name);
      const menuOutput = scenarioResult.lines.join("\n");
      assert.ok(
        scenarioResult.messages.some((message: string) => /Choose \[/.test(message)),
        scenario.name,
      );
      assert.ok(menuOutput.length > 0, `${scenario.name}: empty menu output`);

      if (scenario.vllmExpected) {
        assert.ok(
          menuOutput.includes(`Install vLLM (${scenario.platformLabel})`) ||
            menuOutput.includes(`Start vLLM (${scenario.platformLabel})`),
          scenario.name,
        );
      } else {
        assert.doesNotMatch(menuOutput, /Install vLLM \(/);
        assert.doesNotMatch(menuOutput, /Start vLLM \(/);
      }
    }
  });

  it("surfaces a precise error when NEMOCLAW_PROVIDER=install-vllm but no vLLM profile is detected (#3765)", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-onboard-install-vllm-no-profile-"),
    );
    const scriptPath = path.join(tmpDir, "install-vllm-no-profile-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "credentials", "store.js"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
    const vllmPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "inference", "vllm.js"));

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const vllm = require(${vllmPath});

credentials.prompt = async () => {
  throw new Error("Unexpected prompt in non-interactive test");
};
credentials.ensureApiKey = async () => {
  throw new Error("Unexpected ensureApiKey call in non-interactive test");
};
vllm.installVllm = async () => {
  console.error("INSTALL_VLLM_CALLED");
  return { ok: false };
};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return "";
  if (cmd.includes("127.0.0.1:8000/v1/models")) return "";
  if (cmd.includes("docker images")) return "";
  return "";
};

const { setupNim } = require(${onboardPath});

// gpu=null forces detectVllmProfile to return null, the scenario the bug
// reports: explicit env-var opt-in with no profile detected.
(async () => {
  await setupNim(null, null);
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
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "install-vllm",
        NEMOCLAW_EXPERIMENTAL: "1",
      },
    });

    assert.equal(result.status, 1);
    // The fix routes the explicit opt-in through the install-vllm dispatcher,
    // which emits a precise message instead of the generic "Requested provider
    // 'install-vllm' is not available in this environment." that hid the cause.
    assert.match(result.stderr, /No vLLM install profile available for this host\./);
    assert.doesNotMatch(result.stderr, /Requested provider 'install-vllm' is not available/);
    assert.doesNotMatch(result.stderr, /INSTALL_VLLM_CALLED/);
  });

  it("logs a note when NEMOCLAW_PROVIDER=install-vllm is overridden by a running vLLM server (#3765)", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-install-vllm-running-"));
    const scriptPath = path.join(tmpDir, "install-vllm-running-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "dist", "lib", "credentials", "store.js"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});

credentials.prompt = async () => {
  throw new Error("Unexpected prompt in non-interactive test");
};
credentials.ensureApiKey = async () => {
  throw new Error("Unexpected ensureApiKey call in non-interactive test");
};
runner.runCapture = (command) => {
  const cmd = Array.isArray(command) ? command.join(" ") : command;
  if (cmd.includes("command -v ollama")) return "";
  if (cmd.includes("127.0.0.1:11434/api/tags")) return "";
  // vLLM probe succeeds → vllmRunning becomes true.
  if (cmd.includes("127.0.0.1:8000/v1/models")) return '{"data":[]}';
  if (cmd.includes("docker images")) return "";
  return "";
};

const { setupNim } = require(${onboardPath});

(async () => {
  try {
    await setupNim({ type: "nvidia" }, null);
  } catch (e) {
    // Downstream paths (model probe, gateway, etc.) are not mocked here; we
    // only care about the menu-build log emitted before any failure.
  }
})();
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_PROVIDER: "install-vllm",
        NEMOCLAW_EXPERIMENTAL: "1",
      },
    });

    assert.match(
      result.stdout,
      /NEMOCLAW_PROVIDER=install-vllm requested, but vLLM is already running on localhost:8000 — selecting the running instance\./,
    );
  });
});
