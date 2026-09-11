// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../../..");
const patcher = path.join(root, "agents", "hermes", "patch-auxiliary-token-limit.py");
const fixtures: string[] = [];

const condition = `        if (
            _is_anthropic_compat_endpoint(provider, _effective_base)
            or _nous_on_messages
            or _is_nvidia_nim
            or _is_moa
            or _is_gemini_native
        ):`;

function moduleSource(target = condition): string {
  return `from urllib.parse import urlparse

def base_url_host_matches(value, expected):
    return (urlparse(value).hostname or "").lower() == expected

def _is_anthropic_compat_endpoint(_provider, _base_url):
    return False

def auxiliary_max_tokens_param(value, *, model):
    return {"max_tokens": value, "model_seen": model}

def build(provider, model, base_url, max_tokens, task="title_generation"):
    kwargs = {}
    _effective_base = base_url
    _provider_norm = provider
    _is_nvidia_nim = False
    _is_moa = task == "moa_reference"
    _is_gemini_native = False
    _nous_on_messages = False
    if max_tokens is not None:
${target}
            kwargs.update(auxiliary_max_tokens_param(max_tokens, model=model))
    return kwargs
`;
}

function fixtureFile(source = moduleSource()): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-aux-limit-"));
  fixtures.push(fixture);
  const file = path.join(fixture, "auxiliary_client.py");
  fs.writeFileSync(file, source);
  return file;
}

function runPatcher(file: string) {
  return spawnSync("python3", ["-I", patcher, file], {
    encoding: "utf8",
    timeout: 5000,
  });
}

function evaluate(file: string, baseUrl: string, task = "title_generation") {
  const source = `
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("fixture", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.build("custom", "qwen3-vl:4b", sys.argv[2], 64, task=sys.argv[3])))
`;
  return spawnSync("python3", ["-I", "-c", source, file, baseUrl, task], {
    encoding: "utf8",
    timeout: 5000,
  });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

describe("Hermes managed auxiliary output limit", () => {
  it("preserves the title limit on inference.local", () => {
    const file = fixtureFile();

    const patchResult = runPatcher(file);
    const request = evaluate(file, "https://inference.local/v1");

    expect(patchResult.status, patchResult.stderr).toBe(0);
    expect(request.status, request.stderr).toBe(0);
    expect(JSON.parse(request.stdout)).toEqual({ max_tokens: 64, model_seen: "qwen3-vl:4b" });
  });

  it("keeps the upstream omission for another custom endpoint", () => {
    const file = fixtureFile();
    expect(runPatcher(file).status).toBe(0);

    const request = evaluate(file, "https://example.test/v1");

    expect(request.status, request.stderr).toBe(0);
    expect(JSON.parse(request.stdout)).toEqual({});
  });

  it("preserves the MoA reference limit on another custom endpoint", () => {
    const file = fixtureFile();
    expect(runPatcher(file).status).toBe(0);

    const request = evaluate(file, "https://example.test/v1", "moa_reference");

    expect(request.status, request.stderr).toBe(0);
    expect(JSON.parse(request.stdout)).toEqual({ max_tokens: 64, model_seen: "qwen3-vl:4b" });
  });

  it("accepts one already-patched module without rewriting it", () => {
    const file = fixtureFile();
    expect(runPatcher(file).status).toBe(0);
    const patched = fs.readFileSync(file, "utf8");

    const result = runPatcher(file);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(patched);
  });

  it.each([
    ["missing", moduleSource(condition.replace("or _is_moa\n", ""))],
    ["duplicate", `${moduleSource()}\n${moduleSource()}`],
  ])("rejects a %s upstream condition", (_name, source) => {
    const file = fixtureFile(source);

    const result = runPatcher(file);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Hermes auxiliary max_tokens condition changed");
    expect(fs.readFileSync(file, "utf8")).toBe(source);
  });
});
