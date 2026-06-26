// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression coverage for the hosted Inference Hub compatible-endpoint default.
// The repo-secret endpoint at https://inference-api.nvidia.com/v1 is staged as
// a custom OpenAI-compatible provider and expects provider/namespace/model IDs.
// For NVIDIA-hosted models that means nvidia/nvidia/<model>, which is distinct
// from the official NVIDIA provider catalog IDs used for build.nvidia.com.
// NemoClaw must preserve the provider-accepted ID end-to-end instead of
// normalizing away the leading provider segment.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const providers = require("../dist/lib/onboard/providers.js") as {
  HOSTED_INFERENCE_MODEL: string;
  stageHostedInferenceSourceSecretEnv: () => boolean;
};
const { patchStagedDockerfile } = require("../dist/lib/onboard/dockerfile-patch.js") as {
  patchStagedDockerfile: (
    dockerfilePath: string,
    model: string,
    chatUiUrl: string | null,
    buildId: string,
  ) => void;
};
const { collectSandboxStatusSnapshot } =
  require("../dist/lib/actions/sandbox/status-snapshot.js") as {
    collectSandboxStatusSnapshot: (
      sandboxName: string,
      opts: {
        deps: {
          getSandbox: () => {
            name: string;
            provider: string;
            model: string;
            policies: string[];
            agent: string;
          };
          reconcile: () => Promise<{ state: string; output: string }>;
        };
      },
    ) => Promise<{ currentModel: string; currentProvider: string }>;
  };
const REPO_ROOT = path.join(import.meta.dirname, "..");

// Env keys touched by stageHostedInferenceSourceSecretEnv that we save/restore.
const TOUCHED_ENV = [
  "NVIDIA_INFERENCE_API_KEY",
  "NEMOCLAW_AGENT",
  "NEMOCLAW_PROVIDER_KEY",
  "COMPATIBLE_API_KEY",
  "NEMOCLAW_PROVIDER",
  "NEMOCLAW_ENDPOINT_URL",
  "NEMOCLAW_MODEL",
  "NEMOCLAW_COMPAT_MODEL",
  "NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL",
  "NEMOCLAW_PREFERRED_API",
  "NEMOCLAW_E2E_USE_HOSTED_INFERENCE",
];

function writeOpenAiCompatibleCurl(fakeBin: string): void {
  fs.writeFileSync(
    path.join(fakeBin, "curl"),
    `#!/usr/bin/env bash
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    *) shift ;;
  esac
done
printf '{"choices":[{"message":{"content":"OK"}}]}' > "$outfile"
printf '200'
`,
    { mode: 0o755 },
  );
}

function writeDcodeWrapperFixture(tmpDir: string, home: string): string {
  const wrapperPath = path.join(tmpDir, "dcode-wrapper.sh");
  const wrapper = fs
    .readFileSync(
      path.join(REPO_ROOT, "agents", "langchain-deepagents-code", "dcode-wrapper.sh"),
      "utf8",
    )
    .replace("export HOME=/sandbox", `export HOME=${JSON.stringify(home)}`);
  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  return wrapperPath;
}

function writeFakeDeepAgentsCodeModule(tmpDir: string): string {
  const pythonPath = path.join(tmpDir, "python");
  const packageDir = path.join(pythonPath, "deepagents_code");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "__init__.py"), "", "utf8");
  fs.writeFileSync(
    path.join(packageDir, "__main__.py"),
    [
      "import pathlib",
      "import re",
      "import sys",
      "",
      'config = pathlib.Path.home() / ".deepagents" / "config.toml"',
      'text = config.read_text(encoding="utf-8")',
      'match = re.search(r\'^default = "openai:([^"]+)"\', text, re.MULTILINE)',
      "if not match:",
      '    raise SystemExit("missing default model")',
      'print(f"App: v0.1.12 | Agent: agent (default) | Model: {match.group(1)}")',
      'print("ARGS:" + " ".join(sys.argv[1:]))',
    ].join("\n"),
    "utf8",
  );
  return pythonPath;
}

describe("issue #5667: hosted inference default model namespace", () => {
  // Snapshot the whole environment and restore it wholesale so the teardown
  // stays linear (no per-key conditional): clear every key, then repopulate
  // from the snapshot. Keys added during a test are dropped; original values
  // (all strings) are reinstated exactly.
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = { ...process.env };
    for (const key of TOUCHED_ENV) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
  });

  it("default hosted inference model uses the provider/namespace/model convention", () => {
    expect(providers.HOSTED_INFERENCE_MODEL).toBe("nvidia/nvidia/nemotron-3-ultra");
    expect(providers.HOSTED_INFERENCE_MODEL).not.toContain("nvidia/nvidia/nvidia/");
  });

  it("staging the hosted inference secret without NEMOCLAW_MODEL records the provider-convention model", () => {
    // Reproduce the reported flow: an Inference Hub OpenAI-compatible key with no
    // explicit NEMOCLAW_MODEL, so onboarding falls back to the default model id.
    process.env.NVIDIA_INFERENCE_API_KEY = "sk-test-inference-hub-key";
    process.env.NEMOCLAW_PROVIDER = "custom";

    const staged = providers.stageHostedInferenceSourceSecretEnv();

    expect(staged).toBe(true);
    expect(process.env.NEMOCLAW_MODEL).toBe("nvidia/nvidia/nemotron-3-ultra");
    expect(process.env.NEMOCLAW_MODEL).not.toContain("nvidia/nvidia/nvidia/");
    expect(process.env.NEMOCLAW_COMPAT_MODEL).toBe("nvidia/nvidia/nemotron-3-ultra");
  });

  it("stages the Deep Agents NEMOCLAW_PROVIDER_KEY path with the provider-convention model", () => {
    // Reproduce the issue command: a Deep Agents compatible endpoint key is
    // supplied via the generic provider-key hint, with no explicit model.
    process.env.NEMOCLAW_AGENT = "langchain-deepagents-code";
    process.env.NEMOCLAW_PROVIDER_KEY = "sk-test-inference-hub-key";

    const staged = providers.stageHostedInferenceSourceSecretEnv();

    expect(staged).toBe(true);
    expect(process.env.NEMOCLAW_PROVIDER).toBe("custom");
    expect(process.env.COMPATIBLE_API_KEY).toBe("sk-test-inference-hub-key");
    expect(process.env.NEMOCLAW_MODEL).toBe("nvidia/nvidia/nemotron-3-ultra");
    expect(process.env.NEMOCLAW_MODEL).not.toContain("nvidia/nvidia/nvidia/");
    expect(process.env.NEMOCLAW_COMPAT_MODEL).toBe("nvidia/nvidia/nemotron-3-ultra");
  });

  it("drives setupNim and downstream Deep Agents surfaces with the provider-convention model", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-issue-5667-"));
    const fakeBin = path.join(tmpDir, "bin");
    const home = path.join(tmpDir, "home");
    const scriptPath = path.join(tmpDir, "setup-nim.cjs");
    const onboardPath = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    writeOpenAiCompatibleCurl(fakeBin);
    fs.writeFileSync(
      scriptPath,
      String.raw`
const runner = require(${runnerPath});
runner.runCapture = () => "";

process.env.NEMOCLAW_NON_INTERACTIVE = "1";
process.env.NEMOCLAW_YES = "1";
process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
process.env.NEMOCLAW_AGENT = "langchain-deepagents-code";
process.env.NEMOCLAW_PROVIDER_KEY = "sk-test-inference-hub-key";
delete process.env.NEMOCLAW_MODEL;
delete process.env.NEMOCLAW_COMPAT_MODEL;
delete process.env.NEMOCLAW_PROVIDER;
delete process.env.NVIDIA_INFERENCE_API_KEY;

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim(null, null, null);
    originalLog(JSON.stringify({
      result,
      env: {
        provider: process.env.NEMOCLAW_PROVIDER,
        model: process.env.NEMOCLAW_MODEL,
        compatModel: process.env.NEMOCLAW_COMPAT_MODEL,
        compatibleKey: process.env.COMPATIBLE_API_KEY,
        preferredApi: process.env.NEMOCLAW_PREFERRED_API,
      },
      lines,
    }));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`,
    );

    try {
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          VITEST: "false",
        },
        timeout: 60_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.status, 0, output);
      const payload = JSON.parse(result.stdout.trim());

      expect(payload.result.provider).toBe("compatible-endpoint");
      expect(payload.result.credentialEnv).toBe("COMPATIBLE_API_KEY");
      expect(payload.result.model).toBe("nvidia/nvidia/nemotron-3-ultra");
      expect(payload.result.preferredInferenceApi).toBe("openai-completions");
      expect(payload.env).toMatchObject({
        provider: "custom",
        model: "nvidia/nvidia/nemotron-3-ultra",
        compatModel: "nvidia/nvidia/nemotron-3-ultra",
        compatibleKey: "sk-test-inference-hub-key",
        preferredApi: "openai-completions",
      });
      expect(output).not.toContain("nvidia/nvidia/nvidia/");

      const statusSnapshot = await collectSandboxStatusSnapshot("dcode-test", {
        deps: {
          getSandbox: () => ({
            name: "dcode-test",
            provider: payload.result.provider,
            model: payload.result.model,
            policies: [],
            agent: "langchain-deepagents-code",
          }),
          reconcile: async () => ({ state: "missing", output: "" }),
        },
      });
      const statusModelLine = `    Model:    ${statusSnapshot.currentModel}`;
      expect(statusSnapshot.currentProvider).toBe("compatible-endpoint");
      expect(statusSnapshot.currentModel).toBe("nvidia/nvidia/nemotron-3-ultra");
      expect(statusModelLine).toBe("    Model:    nvidia/nvidia/nemotron-3-ultra");
      expect(statusModelLine).not.toContain("nvidia/nvidia/nvidia/");

      const dockerfilePath = path.join(tmpDir, "Dockerfile");
      fs.writeFileSync(dockerfilePath, "FROM scratch\nARG NEMOCLAW_MODEL=old\n");
      patchStagedDockerfile(
        dockerfilePath,
        payload.result.model,
        null,
        "issue-5667-provider-convention",
      );
      expect(fs.readFileSync(dockerfilePath, "utf8")).toContain(
        "ARG NEMOCLAW_MODEL=nvidia/nvidia/nemotron-3-ultra",
      );

      const configResult = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          path.join(REPO_ROOT, "agents", "langchain-deepagents-code", "generate-config.ts"),
        ],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            NEMOCLAW_MODEL: payload.result.model,
            NEMOCLAW_PROVIDER_KEY: "inference",
            NEMOCLAW_UPSTREAM_PROVIDER: payload.result.provider,
            NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
            NEMOCLAW_INFERENCE_API: payload.result.preferredInferenceApi,
          },
          timeout: 60_000,
        },
      );
      assert.equal(configResult.status, 0, `${configResult.stdout}\n${configResult.stderr}`);
      const config = fs.readFileSync(path.join(home, ".deepagents", "config.toml"), "utf8");
      expect(config).toContain('default = "openai:nvidia/nvidia/nemotron-3-ultra"');
      expect(config).not.toContain("nvidia/nvidia/nvidia/");

      const dcodeWrapperPath = writeDcodeWrapperFixture(tmpDir, home);
      const fakePythonPath = writeFakeDeepAgentsCodeModule(tmpDir);
      const dcodeResult = spawnSync("bash", [dcodeWrapperPath, "-n", "ping"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: home,
          PYTHONPATH: fakePythonPath,
        },
        timeout: 60_000,
      });
      const dcodeOutput = `${dcodeResult.stdout}\n${dcodeResult.stderr}`;
      assert.equal(dcodeResult.status, 0, dcodeOutput);
      expect(dcodeOutput).toContain(
        "App: v0.1.12 | Agent: agent (default) | Model: nvidia/nvidia/nemotron-3-ultra",
      );
      expect(dcodeOutput).toContain("ARGS:--sandbox none --no-mcp -n ping");
      expect(dcodeOutput).not.toContain("nvidia/nvidia/nvidia/");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
