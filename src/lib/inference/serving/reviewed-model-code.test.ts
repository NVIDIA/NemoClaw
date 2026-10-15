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

function probe(root: string, manifest = policy(), failExec = false) {
  const interception = `
def inspect_exec(binary, args, environment):
    if ${failExec ? "True" : "False"}:
        raise OSError('fixture exec failure')
    target = pathlib.Path(args[2])
    source.joinpath('config.json').write_text('changed after verification')
    print(json.dumps({'binary': binary, 'args': args, 'config': target.joinpath('config.json').read_text(),
        'weight': target.joinpath('weights.safetensors').read_text(), 'offline': environment['HF_HUB_OFFLINE'],
        'transformersOffline': environment['TRANSFORMERS_OFFLINE'], 'modules': environment['HF_MODULES_CACHE']}))
    target.chmod(0o700)
os.execve = inspect_exec
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

  it("rejects a snapshot directory replaced by a symlink", () => {
    fixture((root, snapshot) => {
      renameSync(snapshot, snapshot + "-moved");
      symlinkSync(snapshot + "-moved", snapshot);
      const result = probe(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("not a canonical directory");
      expect(result.stdout).toBe("");
    });
  });

  it("removes the verified temporary snapshot when server execution fails", () => {
    fixture((root) => {
      const result = probe(root, policy(), true);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("fixture exec failure");
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
