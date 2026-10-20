// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readdirSync,
  renameSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildReviewedModelCodeCommand,
  reviewedModelCodeError,
  REVIEWED_MODEL_CODE_BOOTSTRAP,
} from "./reviewed-model-code.js";
import {
  getManagedInferenceRecipeRegistrationError,
  isHostLocalInferenceServingRecipe,
} from "./adapter-registry.js";
import { loadManagedInferenceCatalog } from "./catalog-loader.js";
import type { ReviewedModelCode } from "./types.js";

const REVISION = "a".repeat(40);
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
function policy(config = "{}"): ReviewedModelCode {
  return {
    revision: REVISION,
    files: [
      { path: "config.json", digest: digest(config) },
      {
        path: "model.py",
        digest: digest("raise RuntimeError('must not be imported by verifier')"),
      },
    ],
  };
}

function fixture(run: (root: string, snapshot: string) => void, config = "{}") {
  const root = mkdtempSync(path.join(os.tmpdir(), "reviewed-model-test-"));
  const snapshot = path.join(root, "hub/models--example--model/snapshots", REVISION);
  mkdirSync(snapshot, { recursive: true });
  writeFileSync(path.join(snapshot, "config.json"), config);
  writeFileSync(
    path.join(snapshot, "model.py"),
    "raise RuntimeError('must not be imported by verifier')",
  );
  writeFileSync(path.join(snapshot, "weights.safetensors"), "fixture weights");
  try {
    run(root, snapshot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function probe(
  root: string,
  manifest = policy(),
  outcome:
    | number
    | "spawn-error"
    | "SIGTERM"
    | "SIGINT"
    | "SIGHUP"
    | "terminated"
    | "start-signal"
    | "verify-signal" = 0,
) {
  const server = `
import os, signal, sys
outcome = ${JSON.stringify(outcome)}
if isinstance(outcome, int):
    sys.exit(outcome)
if outcome == 'start-signal':
    signal.pause()
elif outcome == 'terminated':
    os.kill(os.getpid(), signal.SIGTERM)
else:
    signum = getattr(signal, outcome)
    signal.signal(signum, lambda received, frame: sys.exit(23))
    os.kill(os.getppid(), signum)
    signal.pause()
`;
  const interception = `
import subprocess, sys, signal, hashlib
start_process = subprocess.Popen
if ${outcome === "verify-signal" ? "True" : "False"}:
    hashlib.sha256 = lambda data: os.kill(os.getpid(), signal.SIGTERM)
def inspect_start(args, *, env):
    if ${outcome === "spawn-error" ? "True" : "False"}:
        raise OSError('fixture spawn failure')
    if ${outcome === "start-signal" ? "True" : "False"}:
        os.kill(os.getpid(), signal.SIGTERM)
    target = pathlib.Path(args[2])
    source.joinpath('config.json').write_text('changed after verification')
    print(json.dumps({'binary': args[0], 'args': args, 'config': target.joinpath('config.json').read_text(),
        'weight': target.joinpath('weights.safetensors').read_text(), 'offline': env['HF_HUB_OFFLINE'],
        'transformersOffline': env['TRANSFORMERS_OFFLINE'], 'modules': env['HF_MODULES_CACHE']}), flush=True)
    return start_process([sys.executable, '-c', ${JSON.stringify(server)}], env=env)
subprocess.Popen = inspect_start
`;
  return spawnSync(
    "python3",
    [
      "-c",
      "import os, pathlib, json\n" + interception + REVIEWED_MODEL_CODE_BOOTSTRAP,
      "example/model",
      REVISION,
      JSON.stringify(manifest.files),
      "--served-model-name",
      "test-model",
    ],
    { env: { ...process.env, HF_HOME: root, TMPDIR: root }, encoding: "utf8", timeout: 10_000 },
  );
}

describe("reviewed model code", () => {
  it("freezes verified metadata, links weights and starts only the reviewed offline model", () => {
    fixture((root) => {
      const result = probe(root);
      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        binary: "/usr/local/bin/vllm",
        config: "{}",
        weight: "fixture weights",
        offline: "1",
        transformersOffline: "1",
      });
      expect(output.args.slice(3)).toEqual([
        "--trust-remote-code",
        "--code-revision",
        REVISION,
        "--served-model-name",
        "test-model",
      ]);
      expect(output.modules).toContain("nemoclaw-reviewed-model-");
      expect(
        readdirSync(root).filter((name) => name.startsWith("nemoclaw-reviewed-model-")),
      ).toEqual([]);
    });
  });

  it.each([
    {
      kind: "changed code",
      change: (snapshot: string) =>
        writeFileSync(path.join(snapshot, "model.py"), "different code"),
    },
    {
      kind: "unlisted code",
      change: (snapshot: string) => writeFileSync(path.join(snapshot, "extra.py"), "pass"),
    },
    { kind: "missing code", change: (snapshot: string) => rmSync(path.join(snapshot, "model.py")) },
    {
      kind: "escaping symlink",
      change: (snapshot: string, root: string) => {
        rmSync(path.join(snapshot, "model.py"));
        writeFileSync(
          path.join(root, "outside.py"),
          "raise RuntimeError('must not be imported by verifier')",
        );
        symlinkSync(path.join(root, "outside.py"), path.join(snapshot, "model.py"));
      },
    },
    {
      kind: "changed shared metadata",
      change: (snapshot: string, root: string) => {
        const blobs = path.join(root, "hub/blobs");
        mkdirSync(blobs);
        const blob = path.join(blobs, "reviewed-code");
        writeFileSync(blob, "different code");
        rmSync(path.join(snapshot, "model.py"));
        symlinkSync(blob, path.join(snapshot, "model.py"));
      },
    },
    {
      kind: "redirected shared blob directory",
      change: (snapshot: string, root: string) => {
        const outside = path.join(root, "outside-blobs");
        mkdirSync(outside);
        renameSync(path.join(snapshot, "model.py"), path.join(outside, "reviewed-code"));
        const blobs = path.join(root, "hub/blobs");
        symlinkSync(outside, blobs);
        symlinkSync(path.join(blobs, "reviewed-code"), path.join(snapshot, "model.py"));
      },
    },
    {
      kind: "another model's cache",
      change: (snapshot: string, root: string) => {
        const sibling = path.join(root, "hub/models--other--model");
        mkdirSync(sibling);
        const blob = path.join(sibling, "model.py");
        renameSync(path.join(snapshot, "model.py"), blob);
        symlinkSync(blob, path.join(snapshot, "model.py"));
      },
    },
    {
      kind: "nonregular shared weight blob",
      change: (snapshot: string, root: string) => {
        const blob = path.join(root, "hub/blobs/weight-directory");
        mkdirSync(blob, { recursive: true });
        rmSync(path.join(snapshot, "weights.safetensors"));
        symlinkSync(blob, path.join(snapshot, "weights.safetensors"));
      },
    },
    { kind: "directory", change: (snapshot: string) => mkdirSync(path.join(snapshot, "package")) },
  ])("rejects $kind before starting the server", ({ change }) => {
    fixture((root, snapshot) => {
      change(snapshot, root);
      const result = probe(root);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("RuntimeError");
    });
  });

  it.each(["other/repo--module.Class", "unlisted.Class"])(
    "rejects auto_map reference %s",
    (reference) => {
      const config = JSON.stringify({ auto_map: { AutoConfig: reference } });
      fixture((root) => {
        const result = probe(root, policy(config));
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("auto_map references unreviewed code");
      }, config);
    },
  );

  it("accepts reviewed metadata stored as Hugging Face blob symlinks", () => {
    fixture((root, snapshot) => {
      const blobs = path.join(snapshot, "../../blobs");
      mkdirSync(blobs);
      const blob = path.join(blobs, "reviewed-code");
      renameSync(path.join(snapshot, "model.py"), blob);
      symlinkSync(blob, path.join(snapshot, "model.py"));
      const result = probe(root);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).config).toBe("{}");
    });
  });

  it.each(["config.json", "model.py", "weights.safetensors"])(
    "accepts %s through the shared Hugging Face blob cache",
    (name) => {
      fixture((root, snapshot) => {
        const modelBlobs = path.join(snapshot, "../../blobs");
        const sharedBlobs = path.join(root, "hub/blobs/ab");
        mkdirSync(modelBlobs);
        mkdirSync(sharedBlobs, { recursive: true });
        const source = path.join(snapshot, name);
        const sharedBlob = path.join(sharedBlobs, name);
        const modelBlob = path.join(modelBlobs, name);
        renameSync(source, sharedBlob);
        symlinkSync(path.relative(modelBlobs, sharedBlob), modelBlob);
        symlinkSync(path.relative(snapshot, modelBlob), source);
        const result = probe(root);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          config: "{}",
          weight: "fixture weights",
        });
      });
    },
  );

  it.each([
    ["snapshot", "."],
    ["model cache", "../.."],
  ] as const)("rejects a redirected %s directory", (_name, relative) => {
    fixture((root, snapshot) => {
      const source = path.resolve(snapshot, relative);
      renameSync(source, source + "-moved");
      symlinkSync(source + "-moved", source);
      const result = probe(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not a canonical directory");
      expect(result.stdout).toBe("");
    });
  });

  it("removes the verified temporary snapshot when server execution fails", () => {
    fixture((root) => {
      const result = probe(root, policy(), "spawn-error");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("fixture spawn failure");
      expect(
        readdirSync(root).filter((name) => name.startsWith("nemoclaw-reviewed-model-")),
      ).toEqual([]);
    });
  });

  it.each([
    7,
    "SIGTERM",
    "SIGINT",
    "SIGHUP",
    "terminated",
    "start-signal",
    "verify-signal",
  ] as const)("cleans the snapshot and preserves server status after %s", (outcome) => {
    fixture((root) => {
      const result = probe(root, policy(), outcome);
      expect(result.status, result.stderr).toBe(
        typeof outcome === "number"
          ? outcome
          : ["terminated", "start-signal", "verify-signal"].includes(outcome)
            ? 143
            : 23,
      );
      expect(
        readdirSync(root).filter((name) => name.startsWith("nemoclaw-reviewed-model-")),
      ).toEqual([]);
    });
  });

  it("rejects mismatched revisions, duplicate files and traversal", () => {
    expect(reviewedModelCodeError("b".repeat(40), policy())).toContain("revision");
    expect(
      reviewedModelCodeError(REVISION, {
        ...policy(),
        files: [...policy().files, policy().files[0]!],
      }),
    ).toContain("unique");
    expect(
      reviewedModelCodeError(REVISION, {
        ...policy(),
        files: [{ path: "../code.py", digest: digest("") }, policy().files[0]!],
      }),
    ).toContain("invalid");
  });

  it("requires fixed authenticated serving and rejects alternate loading arguments", () => {
    const model = {
      id: "example/model",
      revision: REVISION,
      reviewedCode: policy(),
      fixedServeCommand: true,
      managedBearerAuth: true,
      installFastSafetensors: false,
    };
    expect(() =>
      buildReviewedModelCodeCommand({ ...model, fixedServeCommand: false }, [], JSON.stringify),
    ).toThrow("fixed authenticated");
    expect(() =>
      buildReviewedModelCodeCommand({ ...model, reviewedCode: undefined }, [], JSON.stringify),
    ).toThrow("manifest");
    expect(() =>
      buildReviewedModelCodeCommand(model, ["--tokenizer", "other/model"], JSON.stringify),
    ).toThrow("bypass");
  });

  it("validates reviewed policy through the registered host-local consumer", () => {
    const original = loadManagedInferenceCatalog().recipes.find(isHostLocalInferenceServingRecipe)!;
    const recipe = {
      ...original,
      spec: {
        ...original.spec,
        model: {
          ...original.spec.model,
          revision: REVISION,
          reviewedCode: policy(),
          installFastSafetensors: false,
        },
        runtime: { ...original.spec.runtime, environment: {} },
        serve: {
          ...original.spec.serve,
          directInstall: {
            authentication: "bearer" as const,
            fixedArguments: true,
            catalogReceipt: true,
          },
          arguments: [
            { name: "--max-model-len", value: 8192 },
            { name: "--gpu-memory-utilization", value: 0.8 },
          ],
        },
      },
    };
    expect(getManagedInferenceRecipeRegistrationError(recipe)).toBeUndefined();
    recipe.spec.runtime.environment = { PYTHONPATH: "/unreviewed" };
    expect(getManagedInferenceRecipeRegistrationError(recipe)).toContain("environment overrides");
    recipe.spec.runtime.environment = {};
    recipe.spec.model.installFastSafetensors = true;
    expect(getManagedInferenceRecipeRegistrationError(recipe)).toContain("fixed authenticated");
    recipe.spec.model.installFastSafetensors = false;
    recipe.spec.serve.arguments.push({ name: "--tokenizer", value: 1 });
    expect(getManagedInferenceRecipeRegistrationError(recipe)).toContain(
      "bounded serving arguments",
    );
    recipe.spec.serve.arguments.pop();
    recipe.spec.model.reviewedCode = { ...policy(), revision: "b".repeat(40) };
    expect(getManagedInferenceRecipeRegistrationError(recipe)).toContain("revision");
    recipe.spec.serve.arguments.push({ name: "--trust-remote-code", value: 1 });
    expect(getManagedInferenceRecipeRegistrationError(recipe)).toContain("materializer-owned");
  });
});
