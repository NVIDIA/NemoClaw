// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowedDownloadUrl,
  downloadPinnedAsset,
} from "../../packaging/windows/runtime/native-inference-download.mts";
import { createNativeInferenceGuard } from "../../packaging/windows/runtime/native-inference-guard.mts";
import {
  controlProof,
  nativeHostEnvironment,
  recordSignature,
  type NativeOwnerRecord,
} from "../../packaging/windows/runtime/native-inference-host.mts";
import {
  NATIVE_EXPRESS,
  cudaDeviceFromListing,
  guardedNativeChat,
  nativeEligibility,
  nativeServerArguments,
  requireFullCudaOffload,
  type NativeHardware,
  type NativeInferenceProgress,
} from "../../packaging/windows/runtime/native-inference-manifest.mts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
const hardware: NativeHardware = {
  platform: "win32",
  arch: "arm64",
  product: "RTX Spark N1X",
  totalMemoryBytes: 64 * 1024 ** 3,
  availableMemoryBytes: 60 * 1024 ** 3,
  availableStorageBytes: 100 * 1024 ** 3,
  driverVersion: "612.01",
  cudaVersion: "13.4",
  gpuCount: 1,
};
const chat = { model: NATIVE_EXPRESS.model, messages: [{ role: "user", content: "Hello" }] };

describe("native Express eligibility and CUDA contract", () => {
  it("offers the fixed model only when native product, driver and capacity checks pass", () => {
    expect(nativeEligibility(hardware)).toEqual([]);
  });

  it.each([
    { platform: "linux" },
    { arch: "x64" },
    { product: "A different NVIDIA computer" },
    { totalMemoryBytes: Number.NaN },
    { availableMemoryBytes: NATIVE_EXPRESS.memoryBytes - 1 },
    { availableStorageBytes: NATIVE_EXPRESS.storageBytes - 1 },
    { driverVersion: "unknown" },
    { cudaVersion: "13.3" },
    { gpuCount: 0 },
  ])("rejects ineligible native hardware %j", (difference) => {
    expect(nativeEligibility({ ...hardware, ...difference })).not.toEqual([]);
  });

  it("requires a native CUDA device with enough available memory", () => {
    expect(
      cudaDeviceFromListing(
        "Available devices:\n  CUDA0: NVIDIA RTX Spark N1X (65536 MiB, 60000 MiB free)\n",
      ),
    ).toBe("CUDA0");
  });

  it.each([
    "Available devices:\n  (none)",
    "CPU: ARM64 (65536 MiB, 60000 MiB free)",
    "CUDA0: NVIDIA GPU (65536 MiB, 10000 MiB free)",
  ])("rejects an unusable CUDA device listing %s", (text) => {
    expect(() => cudaDeviceFromListing(text)).toThrow();
  });

  it("rejects CPU or partial offload evidence and pins full native GPU arguments", () => {
    expect(
      requireFullCudaOffload(
        "load_tensors: offloaded 41/41 layers to GPU\nload_tensors: CUDA0 model buffer size = 19000 MiB",
      ),
    ).toEqual({ offloadedLayers: 41, totalLayers: 41 });
    const args = nativeServerArguments("C:\\private\\model.gguf", 18081, "CUDA0");
    expect(args[args.indexOf("--device") + 1]).toBe("CUDA0");
    expect(args[args.indexOf("--n-gpu-layers") + 1]).toBe("all");
    expect(args[args.indexOf("--fit") + 1]).toBe("off");
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1");
    expect(args[args.indexOf("--ctx-size") + 1]).toBe("131072");
    expect(args).not.toContain("--api-key");
    expect(() => nativeServerArguments("model.gguf", 8081, "CPU")).toThrow();
  });

  it.each([
    "offloaded 0/41 layers to GPU",
    "offloaded 40/41 layers to GPU\nCUDA0 model buffer size",
    "offloaded 41/41 layers to GPU\nCPU model buffer size",
  ])("rejects incomplete CUDA offload evidence %s", (log) => {
    expect(() => requireFullCudaOffload(log)).toThrow(/CPU fallback/u);
  });

  it("clears inherited inference overrides and provider secrets", () => {
    vi.stubEnv("GGML_CUDA_ENABLE_UNIFIED_MEMORY", "1");
    vi.stubEnv("LLAMA_ARG_N_GPU_LAYERS", "0");
    vi.stubEnv("HF_TOKEN", "private-provider-token");
    const environment = nativeHostEnvironment();
    expect(environment.GGML_CUDA_ENABLE_UNIFIED_MEMORY).toBeUndefined();
    expect(environment.LLAMA_ARG_N_GPU_LAYERS).toBeUndefined();
    expect(environment.HF_TOKEN).toBeUndefined();
  });
});

describe("pinned native inference downloads", () => {
  function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-model-download-"));
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const bytes = Buffer.from("verified native model fixture");
    const asset = {
      name: "fixture.gguf",
      url: "https://huggingface.co/fixed/fixture.gguf",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
    return { directory, bytes, asset };
  }

  it("reports real byte progress, verifies content and reuses only a verified cache entry", async () => {
    const { directory, bytes, asset } = fixture();
    const progress: NativeInferenceProgress[] = [];
    const request = vi.fn<typeof fetch>(async () => new Response(bytes));
    const file = await downloadPinnedAsset(
      asset,
      directory,
      new AbortController().signal,
      (event) => progress.push(event),
      request,
    );
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(
      progress.some(
        (event) => event.completedBytes === bytes.length && event.totalBytes === bytes.length,
      ),
    ).toBe(true);
    await downloadPinnedAsset(
      asset,
      directory,
      new AbortController().signal,
      () => undefined,
      request,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong hashes and removes only its partial download", async () => {
    const { directory, bytes, asset } = fixture();
    fs.writeFileSync(path.join(directory, "user-marker"), "retain me");
    const request = vi.fn<typeof fetch>(async () => new Response(Buffer.alloc(bytes.length)));
    await expect(
      downloadPinnedAsset(asset, directory, new AbortController().signal, () => undefined, request),
    ).rejects.toThrow(/SHA-256/u);
    expect(fs.readdirSync(directory)).toEqual(["user-marker"]);
  });

  it("preserves corrupt cached data before downloading a verified replacement", async () => {
    const { directory, bytes, asset } = fixture();
    fs.writeFileSync(path.join(directory, asset.name), "corrupted old cache");
    await downloadPinnedAsset(
      asset,
      directory,
      new AbortController().signal,
      () => undefined,
      vi.fn<typeof fetch>(async () => new Response(bytes)),
    );
    const preserved = fs.readdirSync(directory).find((name) => name.startsWith("corrupt-"));
    expect(preserved).toBeDefined();
    expect(fs.readFileSync(path.join(directory, preserved!), "utf8")).toBe("corrupted old cache");
  });

  it("cancels an in-flight transfer without publishing a partial model", async () => {
    const { directory, bytes, asset } = fixture();
    const controller = new AbortController();
    await expect(
      downloadPinnedAsset(
        asset,
        directory,
        controller.signal,
        () => controller.abort(),
        vi.fn<typeof fetch>(async () => new Response(bytes)),
      ),
    ).rejects.toThrow();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("rejects redirect authority changes before making another request", async () => {
    const { directory, asset } = fixture();
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
    );
    await expect(
      downloadPinnedAsset(asset, directory, new AbortController().signal, () => undefined, request),
    ).rejects.toThrow(/approved HTTPS/u);
    expect(request).toHaveBeenCalledTimes(1);
    expect(() => allowedDownloadUrl("https://huggingface.co.attacker.invalid/model")).toThrow();
    expect(() => allowedDownloadUrl("https://user:secret@huggingface.co/model")).toThrow();
  });

  it("fails a declared-size mismatch before creating a cache file", async () => {
    const { directory, bytes, asset } = fixture();
    const request = vi.fn<typeof fetch>(
      async () => new Response(bytes, { headers: { "content-length": "1" } }),
    );
    await expect(
      downloadPinnedAsset(asset, directory, new AbortController().signal, () => undefined, request),
    ).rejects.toThrow(/unexpected size/u);
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});

describe("authenticated native inference guard", () => {
  async function listen(server: Server) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return (server.address() as { port: number }).port;
  }
  async function fixture(status: "starting" | "ready" = "ready") {
    const forwarded: Array<{ authorization?: string; body: string }> = [];
    const upstream = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      forwarded.push({ authorization: request.headers.authorization, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: NATIVE_EXPRESS.model }] }));
    });
    const upstreamPort = await listen(upstream);
    const credential = randomBytes(32).toString("base64url");
    const record: NativeOwnerRecord = {
      schemaVersion: 1,
      instance: "7c709b19-f131-456f-b6cf-7f6d033f35b3",
      localModel: NATIVE_EXPRESS.id,
      model: NATIVE_EXPRESS.model,
      port: 1,
      pid: 12,
      launcherPid: 11,
      status,
    };
    const stop = vi.fn();
    const guard = createNativeInferenceGuard({
      record,
      credential,
      upstreamCredential: "upstream-private-key",
      signal: new AbortController().signal,
      upstreamPort: () => upstreamPort,
      onStop: stop,
      assertHeld: () => undefined,
    });
    record.port = await listen(guard);
    return { base: `http://127.0.0.1:${record.port}`, credential, record, forwarded, stop };
  }

  it("proves listener identity without sending or returning the server key", async () => {
    const f = await fixture();
    const nonce = "a".repeat(64);
    const response = await fetch(`${f.base}/identity?nonce=${nonce}`);
    const text = await response.text();
    const identity = JSON.parse(text);
    expect(response.status).toBe(200);
    expect(text).not.toContain(f.credential);
    expect(identity.proof).toBe(controlProof(f.credential, "identity", f.record.instance, nonce));
    expect(identity.record.signature).toBe(recordSignature(f.record, f.credential));
    expect(recordSignature({ ...f.record, port: f.record.port + 1 }, f.credential)).not.toBe(
      identity.record.signature,
    );
  });

  it("requires authentication and denies every unowned API path", async () => {
    const f = await fixture();
    expect((await fetch(`${f.base}/v1/models`)).status).toBe(401);
    expect(
      (await fetch(`${f.base}/v1/models`, { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    expect(f.forwarded).toEqual([]);
  });

  it.each(["/props", "/completion", "/v1/models?redirect=other", "/tools", "/v1/responses"])(
    "denies the unowned local API path %s",
    async (route) => {
      const f = await fixture();
      expect(
        (await fetch(f.base + route, { headers: { authorization: `Bearer ${f.credential}` } }))
          .status,
      ).toBe(404);
      expect(f.forwarded).toEqual([]);
    },
  );

  it("stays unavailable until full GPU readiness and forwards with its private upstream key", async () => {
    const f = await fixture("starting");
    const options = { headers: { authorization: `Bearer ${f.credential}` } };
    expect((await fetch(`${f.base}/v1/models`, options)).status).toBe(503);
    f.record.status = "ready";
    expect((await fetch(`${f.base}/v1/models`, options)).status).toBe(200);
    expect(f.forwarded).toEqual([{ authorization: "Bearer upstream-private-key", body: "" }]);
  });

  it.each([
    { ...chat, model: "another-model" },
    { ...chat, max_tokens: -1 },
    { ...chat, model_path: "C:\\private\\file" },
    {
      ...chat,
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com/media" } }],
        },
      ],
    },
  ])("rejects invalid local inference parameters %j", async (body) => {
    const f = await fixture();
    const response = await fetch(`${f.base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.credential}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(f.forwarded).toEqual([]);
  });

  it("preserves agent tool messages while enforcing model, media and output limits", async () => {
    const f = await fixture();
    const send = (body: unknown) =>
      fetch(`${f.base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${f.credential}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const body = {
      ...chat,
      messages: [
        ...chat.messages,
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call1", type: "function", function: { name: "lookup", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call1", content: "result" },
      ],
    };
    expect((await send(body)).status).toBe(200);
    const forwarded = JSON.parse(f.forwarded[0].body);
    expect(forwarded.messages).toEqual(body.messages);
    expect(forwarded.max_tokens).toBe(4096);
  });

  it("accepts shutdown only with the current instance control proof", async () => {
    const f = await fixture();
    const nonce = "b".repeat(64);
    expect((await fetch(`${f.base}/stop`, { method: "POST" })).status).toBe(401);
    expect(f.stop).not.toHaveBeenCalled();
    expect(
      (
        await fetch(`${f.base}/stop`, {
          method: "POST",
          headers: {
            "x-nemoclaw-nonce": nonce,
            "x-nemoclaw-proof": controlProof(f.credential, "stop", f.record.instance, nonce),
          },
        })
      ).status,
    ).toBe(202);
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it.each(["hermes", "openclaw", "pi", "langchain-deepagents-code", "nemocua"])(
    "accepts %s-style history and tool payloads above 32 KiB with bounded output",
    async (agent) => {
      const f = await fixture();
      // Hermes 0.19's ChatCompletionsTransport preserves OpenAI tool messages;
      // the Pi/OpenClaw and LangChain adapters use the same wire schema. NemoCUA
      // currently supplies textual observation JSON, not a vision attachment.
      // Exercise the actual fields the configured adapters forward, including
      // durable tool results larger than the former 32 KiB request limit.
      const messages =
        agent === "nemocua"
          ? [
              {
                role: "user",
                content: JSON.stringify({
                  task: "Review the page",
                  observation: {
                    visibleText: "Page content. ".repeat(5000),
                    allowedActions: ["click", "type", "finish"],
                  },
                }),
              },
            ]
          : [
              { role: "system", content: "You are a coding assistant. Use the supplied tools." },
              { role: "user", content: "Read the project and explain the next step." },
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "read_project_1",
                    type: "function",
                    function: { name: "read_file", arguments: '{"path":"README.md"}' },
                  },
                ],
              },
              {
                role: "tool",
                tool_call_id: "read_project_1",
                content: "Project documentation. ".repeat(4000),
              },
            ];
      const payload = {
        model: NATIVE_EXPRESS.model,
        messages,
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a workspace file",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
          },
        ],
        tool_choice: "auto",
        parallel_tool_calls: true,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 16_384,
        store: false,
      };
      const body = JSON.stringify(payload);
      expect(Buffer.byteLength(body)).toBeGreaterThan(32 * 1024);
      const response = await fetch(`${f.base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${f.credential}`, "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(200);
      const forwarded = JSON.parse(f.forwarded[0].body);
      expect(forwarded).toMatchObject({
        model: NATIVE_EXPRESS.model,
        messages,
        tools: payload.tools,
        max_tokens: 4096,
        max_completion_tokens: 4096,
        parallel_tool_calls: false,
        stream: true,
      });
      expect(forwarded.store).toBeUndefined();
    },
  );
});

it("bounds both accepted output-token aliases and rejects request-level server overrides", () => {
  expect(guardedNativeChat({ ...chat, max_tokens: 9999, max_completion_tokens: 5 })).toMatchObject({
    max_tokens: 5,
    max_completion_tokens: 5,
  });
  expect(() =>
    guardedNativeChat({ ...chat, chat_template_kwargs: { unsafe: "override" } }),
  ).toThrow();
  expect(
    guardedNativeChat({ ...chat, parallel_tool_calls: true, max_tokens: 16_384 }),
  ).toMatchObject({ parallel_tool_calls: false, max_tokens: 4096 });
});
