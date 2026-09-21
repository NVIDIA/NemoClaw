// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  downloadLocalModelAssets,
  NATIVE_LOCAL_MODELS,
  selectLocalModel,
  validateLocalModel,
  downloadedModelArguments,
  localModelIdentityMatches,
} from "./native-local-models.mts";
import {
  guardedNativeChat,
  nativeEligibility,
  nativeServerArguments,
  requireFullCudaOffload,
} from "./native-inference-manifest.mts";
import { n1xGpuCount } from "./native-inference-host.mts";

test("native eligibility rejects an older N1X driver before model download", () => {
  const hardware = {
    platform: "win32",
    arch: "arm64",
    product: "NVIDIA RTX Spark N1X",
    totalMemoryBytes: 64 * 1024 ** 3,
    availableMemoryBytes: 64 * 1024 ** 3,
    availableStorageBytes: 64 * 1024 ** 3,
    driverVersion: "616.52",
    cudaVersion: "13.4",
    gpuCount: 1,
  };
  assert.deepEqual(nativeEligibility(hardware), []);
  assert.match(nativeEligibility({ ...hardware, driverVersion: "616.40" })[0], /616\.41/u);
});

test("N1X hardware discovery ignores the companion NVIDIA NPU", () => {
  assert.equal(
    n1xGpuCount(`
<attached_gpus>2</attached_gpus>
<gpu><product_name>NVIDIA RTX Spark N1X (6144-core Blackwell RTX GPU)</product_name></gpu>
<gpu><product_name>NVIDIA NPU</product_name></gpu>`),
    1,
  );
});

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-model-data-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const revision = "a".repeat(40);
  const contents = {
    "weights.gguf": "fixture model bytes",
    "projector.gguf": "fixture vision bytes",
  };
  const asset = (name: keyof typeof contents) => ({
    name,
    bytes: Buffer.byteLength(contents[name]),
    sha256: createHash("sha256").update(contents[name]).digest("hex"),
    url: `https://huggingface.co/fixture/model/resolve/${revision}/${name}`,
  });
  const model = {
    id: "fixture",
    displayName: "Fixture",
    repository: "fixture/model",
    revision,
    quantization: "fixture",
    weights: asset("weights.gguf"),
    visionProjector: asset("projector.gguf"),
  };
  const requests: string[] = [];
  const request: typeof fetch = async (input) => {
    const name = new URL(String(input)).pathname.split("/").at(-1)! as keyof typeof contents;
    requests.push(name);
    assert.ok(name in contents);
    return new Response(contents[name]);
  };
  let held = true;
  const lease = {
    stateRoot: root,
    assertHeld() {
      if (!held) throw new Error("lease lost");
    },
  };
  return {
    root,
    model,
    requests,
    request,
    lease,
    loseLease() {
      held = false;
    },
    cache: path.join(root, `model-fixture-${revision}`),
  };
}

test("the catalog selects only explicit known models and never substitutes the alternative", () => {
  const model = selectLocalModel(NATIVE_LOCAL_MODELS.defaultModel);
  assert.equal(model.id, "qwen3.8-27b");
  assert.equal(selectLocalModel(NATIVE_LOCAL_MODELS.fallbackModel).id, "qwen3.6-35b-a3b");
  assert.throws(() => selectLocalModel("unknown"), /installed local model catalog/u);
  assert.ok(Object.isFrozen(model.weights));
});

test("each downloaded model binds its own alias and keeps a loopback-only server", () => {
  for (const model of NATIVE_LOCAL_MODELS.models) {
    const args = downloadedModelArguments(model, "weights.gguf", 12345, "CUDA0");
    assert.equal(args[args.indexOf("--alias") + 1], model.id);
    assert.equal(args[args.indexOf("--host") + 1], "127.0.0.1");
    assert.equal(args[args.indexOf("--n-gpu-layers") + 1], "all");
    assert.equal(args.includes("--mmproj"), false);
    assert.equal(args[args.indexOf("--log-verbosity") + 1], "4");
    assert.ok(args.includes("--no-webui"));
    assert.ok(localModelIdentityMatches(model.id, model.id));
    assert.equal(localModelIdentityMatches(model.id, "foreign"), false);
    assert.throws(() => downloadedModelArguments(model, "weights", 0, "CUDA0"));
    assert.throws(() => downloadedModelArguments(model, "weights", 12345, "CPU"));
  }
});

test("both native recipes retain the trace-level full-offload proof", () => {
  const args = nativeServerArguments("weights.gguf", 12345, "CUDA0");
  assert.equal(args[args.indexOf("--log-verbosity") + 1], "4");
  assert.deepEqual(
    requireFullCudaOffload(`
0.03 I load_tensors: offloaded 66/66 layers to GPU
0.03 I load_tensors: CUDA0 model buffer size = 14674.45 MiB
`),
    { offloadedLayers: 66, totalLayers: 66 },
  );
  assert.throws(
    () => requireFullCudaOffload("model loaded without an offload summary"),
    /full CUDA offload/u,
  );
});

test("new model aliases do not bypass the existing inference request restrictions", () => {
  for (const model of NATIVE_LOCAL_MODELS.models) {
    const request = {
      model: model.id,
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 16,
    };
    const fast = guardedNativeChat(request, model.id);
    assert.equal(fast.model, model.id);
    assert.equal(fast.reasoning_effort, "none");
    assert.equal(
      guardedNativeChat({ ...request, reasoning_effort: "high" }, model.id).reasoning_effort,
      "high",
    );
    assert.throws(
      () => guardedNativeChat({ ...request, reasoning_effort: "extreme" }, model.id),
      /supported local reasoning level/u,
    );
    assert.throws(() => guardedNativeChat({ ...request, model: "foreign" }, model.id));
    assert.throws(() =>
      guardedNativeChat(
        {
          ...request,
          messages: [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: "file:///private" } }],
            },
          ],
        },
        model.id,
      ),
    );
  }
});

test("local tool schemas omit unsupported patterns at the llama.cpp boundary", () => {
  const request = {
    model: NATIVE_LOCAL_MODELS.defaultModel,
    messages: [{ role: "user", content: "Use a tool" }],
    tools: [
      {
        type: "function",
        function: {
          name: "fixture",
          parameters: {
            type: "object",
            properties: {
              anywhere: { type: "string", pattern: "foo|bar" },
              start: { type: "string", pattern: "^prefix" },
              end: { type: "string", pattern: "suffix$" },
              exact: { type: "string", pattern: "^[a-z]+$" },
              literal: { type: "object", default: { pattern: "do-not-rewrite" } },
            },
          },
        },
      },
    ],
  };
  const guarded = guardedNativeChat(request, request.model) as typeof request;
  const properties = guarded.tools[0].function.parameters.properties;
  assert.equal(properties.anywhere.pattern, undefined);
  assert.equal(properties.start.pattern, undefined);
  assert.equal(properties.end.pattern, undefined);
  assert.equal(properties.exact.pattern, undefined);
  assert.equal(properties.literal.default.pattern, "do-not-rewrite");
  assert.equal(request.tools[0].function.parameters.properties.anywhere.pattern, "foo|bar");
});

test("downloads only the text weights and reuses verified cached bytes", async (t) => {
  const f = fixture(t);
  const signal = new AbortController().signal;
  const result = await downloadLocalModelAssets(f.model, f.lease, signal, () => {}, f.request);
  assert.equal(result.model, f.model.id);
  assert.deepEqual(f.requests, ["weights.gguf"]);
  assert.equal(fs.readFileSync(result.weights, "utf8"), "fixture model bytes");
  await downloadLocalModelAssets(
    f.model,
    f.lease,
    signal,
    () => {},
    async () => {
      throw new Error("cached assets must not cause a download");
    },
  );
});

test("an unused vision projector is not downloaded", async (t) => {
  const f = fixture(t);
  f.model.visionProjector.sha256 = "0".repeat(64);
  await downloadLocalModelAssets(
    f.model,
    f.lease,
    new AbortController().signal,
    () => {},
    f.request,
  );
  assert.deepEqual(fs.readdirSync(f.cache), ["weights.gguf"]);
});

test("cancelled selection does not create model state or send requests", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    downloadLocalModelAssets(f.model, f.lease, controller.signal, () => {}, f.request),
    { name: "AbortError" },
  );
  assert.deepEqual(fs.readdirSync(f.root), []);
  assert.deepEqual(f.requests, []);
});

test("lost state ownership aborts before either asset is downloaded", async (t) => {
  const f = fixture(t);
  f.loseLease();
  await assert.rejects(
    downloadLocalModelAssets(f.model, f.lease, new AbortController().signal, () => {}, f.request),
    /lease lost/u,
  );
  assert.deepEqual(f.requests, []);
});

test("losing ownership during streamed progress aborts cleanly without starting the next asset", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    downloadLocalModelAssets(
      f.model,
      f.lease,
      new AbortController().signal,
      (event) => {
        if (event.phase === "downloading") {
          f.loseLease();
          f.lease.assertHeld();
        }
      },
      f.request,
    ),
    /lease lost/u,
  );
  assert.deepEqual(f.requests, ["weights.gguf"]);
  assert.deepEqual(fs.readdirSync(f.cache), []);
});

test("a cancelled cache verification never renames valid model data as corrupt", async (t) => {
  const f = fixture(t);
  const signal = new AbortController().signal;
  await downloadLocalModelAssets(f.model, f.lease, signal, () => {}, f.request);
  const before = fs.readdirSync(f.cache).sort();
  await assert.rejects(
    downloadLocalModelAssets(
      f.model,
      f.lease,
      signal,
      () => {
        throw new Error("progress failed");
      },
      f.request,
    ),
    /progress failed/u,
  );
  assert.deepEqual(fs.readdirSync(f.cache).sort(), before);
  assert.equal(f.requests.length, 1);
});

test("floating revisions and untrusted download hosts are rejected before download", (t) => {
  const f = fixture(t);
  assert.throws(() => validateLocalModel({ ...f.model, revision: "main" }), /identity/u);
  assert.throws(
    () =>
      validateLocalModel({
        ...f.model,
        weights: { ...f.model.weights, url: "https://example.org/weights.gguf" },
      }),
    /approved HTTPS hosts/u,
  );
  assert.throws(
    () =>
      validateLocalModel({
        ...f.model,
        weights: {
          ...f.model.weights,
          url: "https://huggingface.co/fixture/model/resolve/main/weights.gguf",
        },
      }),
    /immutable/u,
  );
});
