// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "../../..",
  "scripts",
  "nemoclaw-start.sh",
);

describe("runtime model override (#759)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  function extractShellFunction(name: string): string {
    return extractShellFunctionFromSource(src, name);
  }

  function runApplyModelOverride(env: Record<string, string> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-model-override-"));
    const openclawDir = path.join(root, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({
        agents: { defaults: { model: { primary: "old-model" } } },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: [
                {
                  id: "old-model",
                  name: "old-model",
                  contextWindow: 1024,
                  maxTokens: 128,
                  reasoning: false,
                },
              ],
            },
          },
        },
      }),
    );
    const configPath = path.join(openclawDir, "openclaw.json");
    const hashPath = path.join(openclawDir, ".config-hash");
    fs.writeFileSync(hashPath, "oldhash\n");
    fs.chmodSync(openclawDir, 0o2770);
    fs.chmodSync(configPath, 0o660);
    fs.chmodSync(hashPath, 0o660);

    const helperFns = [extractShellFunction("openclaw_config_dir_owner")]
      .join("\n")
      .replaceAll("/sandbox", root);
    const fn = extractShellFunction("apply_model_override").replaceAll("/sandbox", root);
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "id() { echo 0; }",
      "normalize_mutable_config_perms() { :; }",
      'run_openclaw_config_as_owner() { "$@"; }',
      `ensure_mutable_openclaw_config_hash() { (cd ${JSON.stringify(openclawDir)} && sha256sum openclaw.json >.config-hash); }`,
      `stat() { if [ "$1" = "-c" ] && [ "$2" = "%U" ] && [ "$3" = ${JSON.stringify(openclawDir)} ]; then echo sandbox; return 0; fi; command stat "$@"; }`,
      helperFns,
      fn,
      "apply_model_override",
    ].join("\n");
    const script = path.join(root, "run.sh");
    fs.writeFileSync(script, wrapper, { mode: 0o700 });
    const result = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
    });
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const hash = fs.readFileSync(hashPath, "utf-8");
    const modes = {
      dir: fs.statSync(openclawDir).mode & 0o7777,
      config: fs.statSync(configPath).mode & 0o777,
      hash: fs.statSync(hashPath).mode & 0o777,
    };
    fs.rmSync(root, { recursive: true, force: true });
    return { result, config, hash, modes };
  }

  it("applies model, API, context, max-token, and reasoning overrides and recomputes the hash", () => {
    const { result, config, hash } = runApplyModelOverride({
      NEMOCLAW_MODEL_OVERRIDE: "new-model",
      NEMOCLAW_INFERENCE_API_OVERRIDE: "anthropic-messages",
      NEMOCLAW_CONTEXT_WINDOW: "4096",
      NEMOCLAW_MAX_TOKENS: "512",
      NEMOCLAW_REASONING: "true",
    });

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("new-model");
    const provider = config.models.providers.inference;
    expect(provider.api).toBe("anthropic-messages");
    expect(provider.models[0]).toMatchObject({
      id: "new-model",
      name: "new-model",
      contextWindow: 4096,
      maxTokens: 512,
      reasoning: true,
    });
    expect(hash).toContain("openclaw.json");
  });

  it("restores mutable config permissions after successful overrides", () => {
    const { result, modes } = runApplyModelOverride({
      NEMOCLAW_MODEL_OVERRIDE: "new-model",
    });

    expect(result.status).toBe(0);
    expect(modes.dir).toBe(0o2770);
    expect(modes.config).toBe(0o660);
    expect(modes.hash).toBe(0o660);
  });

  it.each([
    {
      env: { NEMOCLAW_CONTEXT_WINDOW: "not-a-number" },
      message: "NEMOCLAW_CONTEXT_WINDOW must be a positive integer",
    },
    {
      env: { NEMOCLAW_CONTEXT_WINDOW: "0" },
      message: "NEMOCLAW_CONTEXT_WINDOW must be a positive integer",
    },
    {
      env: { NEMOCLAW_MAX_TOKENS: "not-a-number" },
      message: "NEMOCLAW_MAX_TOKENS must be a positive integer",
    },
    {
      env: { NEMOCLAW_MAX_TOKENS: "0" },
      message: "NEMOCLAW_MAX_TOKENS must be a positive integer",
    },
    {
      env: { NEMOCLAW_REASONING: "maybe" },
      message: 'NEMOCLAW_REASONING must be "true" or "false"',
    },
    {
      env: { NEMOCLAW_INFERENCE_API_OVERRIDE: "unexpected-api" },
      message: 'must be "openai-completions" or "anthropic-messages"',
    },
  ])("treats invalid supplemental overrides as atomic no-ops [case %#]", ({ env, message }) => {
    const { result, config, hash } = runApplyModelOverride({
      NEMOCLAW_MODEL_OVERRIDE: "new-model",
      ...env,
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(message);
    expect(config.agents.defaults.model.primary).toBe("old-model");
    expect(config.models.providers.inference.api).toBe("openai-completions");
    expect(config.models.providers.inference.models[0]).toMatchObject({
      id: "old-model",
      name: "old-model",
      contextWindow: 1024,
      maxTokens: 128,
      reasoning: false,
    });
    expect(hash).toBe("oldhash\n");
  });
});

describe("root OpenClaw config I/O authority", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("drops the root environment before invoking an absolute sandbox-owned writer", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-writer-env-"));
    const script = path.join(root, "run.sh");
    const handoff = path.join(root, "handoff");
    const rawSecret = "SENTINEL_ROOT_ONLY_PROVIDER_SECRET";
    fs.writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "id() { printf '0\\n'; }",
        `STEP_DOWN_PREFIX_SANDBOX=(bash -c 'printf "used\\n" >${JSON.stringify(handoff)}; exec "$@"' sandbox-step-down)`,
        extractShellFunctionFromSource(src, "run_openclaw_config_as_owner"),
        `export ROOT_ONLY_SECRET=${JSON.stringify(rawSecret)}`,
        'run_openclaw_config_as_owner /usr/bin/env SAFE_INPUT=reviewed /usr/bin/python3 -I -c \'import os; print(os.environ.get("SAFE_INPUT", "")); print(os.environ.get("ROOT_ONLY_SECRET", "absent")); print(os.environ.get("HOME", ""))\'',
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual(["reviewed", "absent", "/sandbox"]);
      expect(fs.readFileSync(handoff, "utf-8")).toBe("used\n");
      expect(result.stdout).not.toContain(rawSecret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not invoke privileged pathname metadata tools around owner config I/O", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-writer-authority-"));
    const openclawDir = path.join(root, ".openclaw");
    const configPath = path.join(openclawDir, "openclaw.json");
    const metadataLog = path.join(root, "metadata.log");
    const script = path.join(root, "run.sh");
    fs.mkdirSync(openclawDir);
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { controlUi: { allowedOrigins: [] } } }),
    );
    fs.writeFileSync(path.join(openclawDir, ".config-hash"), "oldhash\n");
    const applyCors = extractShellFunctionFromSource(src, "apply_cors_override").replaceAll(
      "/sandbox/.openclaw",
      openclawDir,
    );
    fs.writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "id() { printf '0\\n'; }",
        `chown() { printf 'chown\\n' >>${JSON.stringify(metadataLog)}; return 97; }`,
        `chmod() { printf 'chmod\\n' >>${JSON.stringify(metadataLog)}; return 98; }`,
        "normalize_mutable_config_perms() { :; }",
        'run_openclaw_config_as_owner() { "$@"; }',
        `ensure_mutable_openclaw_config_hash() { (cd ${JSON.stringify(openclawDir)} && sha256sum openclaw.json >.config-hash); }`,
        applyCors,
        "export NEMOCLAW_CORS_ORIGIN=https://owner-io.example.test",
        "apply_cors_override",
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(fs.existsSync(metadataLog)).toBe(false);
      expect(JSON.parse(fs.readFileSync(configPath, "utf-8"))).toMatchObject({
        gateway: { controlUi: { allowedOrigins: ["https://owner-io.example.test"] } },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a mutable-directory replacement race before any writer runs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-writer-race-"));
    const configDir = path.join(root, ".openclaw");
    const racedDir = path.join(root, ".openclaw-raced");
    const checkpoint = path.join(configDir, "000-checkpoint");
    const normalizer = path.join(
      import.meta.dirname,
      "../../../..",
      "scripts",
      "lib",
      "normalize_mutable_config_perms.py",
    );
    fs.mkdirSync(configDir, { mode: 0o700 });
    fs.writeFileSync(path.join(configDir, "openclaw.json"), "{}\n", { mode: 0o600 });
    fs.writeFileSync(path.join(configDir, ".config-hash"), "hash\n", { mode: 0o600 });
    fs.writeFileSync(checkpoint, "checkpoint\n", { mode: 0o600 });
    Array.from({ length: 64 }, (_, directoryIndex) => {
      const directory = path.join(configDir, `100-bulk-${String(directoryIndex).padStart(3, "0")}`);
      fs.mkdirSync(directory, { mode: 0o700 });
      Array.from({ length: 64 }, (_, fileIndex) =>
        path.join(directory, `entry-${String(fileIndex).padStart(3, "0")}`),
      ).forEach((file) => fs.writeFileSync(file, "fixture\n", { mode: 0o600 }));
    });

    const child = spawn(
      "/usr/bin/python3",
      [normalizer, configDir, String(process.getuid?.()), String(process.getgid?.())],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 20_000, killSignal: "SIGKILL" },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    try {
      await vi.waitFor(() => expect(fs.statSync(checkpoint).mode & 0o777).toBe(0o660), {
        interval: 1,
        timeout: 10_000,
      });
      fs.renameSync(configDir, racedDir);
      fs.mkdirSync(configDir, { mode: 0o700 });
      fs.writeFileSync(path.join(configDir, "replacement"), "untouched\n", { mode: 0o600 });

      const result = await exit;
      expect(result.code, stderr).not.toBe(0);
      expect(result.signal, stderr).toBeNull();
      expect(fs.readFileSync(path.join(configDir, "replacement"), "utf-8")).toBe("untouched\n");
      expect(fs.existsSync(racedDir)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("runtime CORS origin override (#719)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  function extractShellFunction(name: string): string {
    return extractShellFunctionFromSource(src, name);
  }

  function runApplyCorsOverride(origin: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cors-override-"));
    const openclawDir = path.join(root, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({
        gateway: { controlUi: { allowedOrigins: ["http://127.0.0.1:18789"] } },
      }),
    );
    const configPath = path.join(openclawDir, "openclaw.json");
    const hashPath = path.join(openclawDir, ".config-hash");
    fs.writeFileSync(hashPath, "oldhash\n");
    fs.chmodSync(openclawDir, 0o2770);
    fs.chmodSync(configPath, 0o660);
    fs.chmodSync(hashPath, 0o660);

    const helperFns = [extractShellFunction("openclaw_config_dir_owner")]
      .join("\n")
      .replaceAll("/sandbox", root);
    const fn = extractShellFunction("apply_cors_override").replaceAll("/sandbox", root);
    const script = path.join(root, "run.sh");
    fs.writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "id() { echo 0; }",
        "normalize_mutable_config_perms() { :; }",
        'run_openclaw_config_as_owner() { "$@"; }',
        `ensure_mutable_openclaw_config_hash() { (cd ${JSON.stringify(openclawDir)} && sha256sum openclaw.json >.config-hash); }`,
        `stat() { if [ "$1" = "-c" ] && [ "$2" = "%U" ] && [ "$3" = ${JSON.stringify(openclawDir)} ]; then echo sandbox; return 0; fi; command stat "$@"; }`,
        helperFns,
        fn,
        "apply_cors_override",
      ].join("\n"),
      { mode: 0o700 },
    );
    const result = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: { ...process.env, NEMOCLAW_CORS_ORIGIN: origin },
    });
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const hash = fs.readFileSync(hashPath, "utf-8");
    fs.rmSync(root, { recursive: true, force: true });
    return { result, config, hash };
  }

  it("adds valid CORS origins and recomputes the config hash", () => {
    const { result, config, hash } = runApplyCorsOverride("https://chat.example.test");
    expect(result.status).toBe(0);
    expect(config.gateway.controlUi.allowedOrigins).toContain("https://chat.example.test");
    expect(hash).toContain("openclaw.json");
  });

  it("rejects invalid CORS origins without mutating config", () => {
    const { result, config } = runApplyCorsOverride("javascript:alert(1)");
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("must start with http:// or https://");
    expect(config.gateway.controlUi.allowedOrigins).toEqual(["http://127.0.0.1:18789"]);
  });
});
