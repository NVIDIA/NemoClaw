// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadServingCatalog } from "../serving/catalog-loader";
import type { LlamaCppServingRecipe } from "../serving/types";
import {
  installManagedLlamaCpp,
  MANAGED_LLAMA_CPP_AUTH_LABEL,
  MANAGED_LLAMA_CPP_CONTAINER_NAME,
  MANAGED_LLAMA_CPP_GENERATION_LABEL,
  MANAGED_LLAMA_CPP_NETWORK_NAME,
  MANAGED_LLAMA_CPP_OWNER_LABEL,
  MANAGED_LLAMA_CPP_OWNER_VALUE,
} from "./managed-installer";

const temporaryDirectories: string[] = [];

type Mutable<T> = { -readonly [Key in keyof T]: Mutable<T[Key]> };

function testRecipe(body: Buffer): LlamaCppServingRecipe {
  const source = loadServingCatalog().recipes.find(
    ({ metadata }) => metadata.id === "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1",
  ) as LlamaCppServingRecipe;
  const recipe = structuredClone(source) as Mutable<LlamaCppServingRecipe>;
  recipe.spec.model.files[0] = {
    ...recipe.spec.model.files[0]!,
    digest: `sha256:${crypto.createHash("sha256").update(body).digest("hex")}`,
    sizeBytes: body.length,
  };
  recipe.spec.model.cache.quotaBytes = 1024;
  recipe.spec.model.cache.stagingHeadroomBytes = 512;
  recipe.spec.readiness.timeoutSeconds = 1;
  return recipe;
}

function dockerHarness() {
  let containerPresent = false;
  let networkPresent = false;
  let generation = "";
  let authFingerprint = "";
  const labelValue = (argv: readonly string[], name: string) =>
    argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
  const runActions: Record<string, (argv: readonly string[]) => void> = {
    "network create": (argv) => {
      networkPresent = true;
      generation = labelValue(argv, MANAGED_LLAMA_CPP_GENERATION_LABEL);
    },
    run: (argv) => {
      containerPresent = true;
      generation = labelValue(argv, MANAGED_LLAMA_CPP_GENERATION_LABEL);
      authFingerprint = labelValue(argv, MANAGED_LLAMA_CPP_AUTH_LABEL);
    },
  };
  const run = vi.fn((argv: readonly string[]) => {
    const key = argv[0] === "network" ? argv.slice(0, 2).join(" ") : (argv[0] ?? "");
    runActions[key]?.(argv);
    return { status: 0 } as never;
  });
  const forceRm = vi.fn(() => {
    containerPresent = false;
    return { status: 0 } as never;
  });
  const capture = vi.fn((argv: readonly string[]) => {
    const containerResult =
      argv[0] === "container" && containerPresent
        ? JSON.stringify([
            {
              Id: "a".repeat(64),
              Name: `/${MANAGED_LLAMA_CPP_CONTAINER_NAME}`,
              Config: {
                Labels: {
                  [MANAGED_LLAMA_CPP_OWNER_LABEL]: MANAGED_LLAMA_CPP_OWNER_VALUE,
                  [MANAGED_LLAMA_CPP_GENERATION_LABEL]: generation,
                  [MANAGED_LLAMA_CPP_AUTH_LABEL]: authFingerprint,
                },
              },
            },
          ])
        : "";
    const networkResult =
      argv[0] === "network" && networkPresent
        ? JSON.stringify([
            {
              Id: "b".repeat(64),
              Name: MANAGED_LLAMA_CPP_NETWORK_NAME,
              Internal: true,
              Driver: "bridge",
              Scope: "local",
              Labels: {
                [MANAGED_LLAMA_CPP_OWNER_LABEL]: MANAGED_LLAMA_CPP_OWNER_VALUE,
                [MANAGED_LLAMA_CPP_GENERATION_LABEL]: generation,
              },
            },
          ])
        : "";
    return containerResult || networkResult;
  });
  return {
    capture,
    forceRm,
    run,
    resetRuntime: () => {
      containerPresent = false;
      networkPresent = false;
      generation = "";
      authFingerprint = "";
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("managed llama.cpp installer", () => {
  it("verifies, receipts, launches, and authenticates one exact GGUF", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-llama-installer-"));
    temporaryDirectories.push(homeDir);
    const body = Buffer.from("catalog-gguf-fixture");
    const docker = dockerHarness();
    const result = await installManagedLlamaCpp(testRecipe(body), {
      homeDir,
      fetchImpl: vi.fn(async () => new Response(body, { status: 200 })),
      dockerCaptureImpl: docker.capture,
      dockerForceRmImpl: vi.fn() as never,
      dockerRunImpl: docker.run,
      dockerPullImpl: vi.fn(async () => ({ status: 0 })) as never,
      probeImpl: vi.fn(() => ({
        ok: true as const,
        model: "nvidia-nemotron-3-nano-30b-a3b",
      })),
      randomBytes: ((size: number) => Buffer.alloc(size, 7)) as typeof crypto.randomBytes,
      sleepImpl: vi.fn(async () => {}),
      log: vi.fn(),
    });

    expect(result).toMatchObject({
      ok: true,
      model: "nvidia-nemotron-3-nano-30b-a3b",
    });
    const launch = docker.run.mock.calls
      .map(([argv]) => argv as string[])
      .find((argv) => argv.includes("nemoclaw-llama-cpp"));
    expect(launch).toContain("127.0.0.1:8081:8081");
    expect(launch).toContain("--read-only");
    expect(launch).toContain("--api-key-file");
    expect(launch).toEqual(
      expect.arrayContaining([expect.stringContaining(`${MANAGED_LLAMA_CPP_AUTH_LABEL}=`)]),
    );
    const receipts = fs
      .readdirSync(path.join(homeDir, ".cache", "nemoclaw", "llama-cpp"), {
        recursive: true,
      })
      .filter((entry) => String(entry).endsWith("receipt.json"));
    expect(receipts).toHaveLength(1);
  });

  it("does not publish a GGUF with the wrong digest", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-llama-installer-"));
    temporaryDirectories.push(homeDir);
    const docker = dockerHarness();
    const result = await installManagedLlamaCpp(testRecipe(Buffer.from("expected")), {
      homeDir,
      fetchImpl: vi.fn(async () => new Response(Buffer.from("tampered"), { status: 200 })),
      dockerCaptureImpl: docker.capture,
      dockerRunImpl: docker.run,
      dockerPullImpl: vi.fn(async () => ({ status: 0 })) as never,
      randomBytes: ((size: number) => Buffer.alloc(size, 8)) as typeof crypto.randomBytes,
      log: vi.fn(),
    });
    expect(result).toEqual({
      ok: false,
      reason: "llama.cpp model download failed size or digest verification.",
    });
  });

  it("reuses a verified cache after uninstallable runtime state is removed", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-llama-installer-"));
    temporaryDirectories.push(homeDir);
    const body = Buffer.from("reusable-catalog-gguf");
    const docker = dockerHarness();
    const common = {
      homeDir,
      dockerCaptureImpl: docker.capture,
      dockerForceRmImpl: vi.fn() as never,
      dockerRunImpl: docker.run,
      dockerPullImpl: vi.fn(async () => ({ status: 0 })) as never,
      probeImpl: vi.fn(() => ({
        ok: true as const,
        model: "nvidia-nemotron-3-nano-30b-a3b",
      })),
      sleepImpl: vi.fn(async () => {}),
      log: vi.fn(),
    };
    const first = await installManagedLlamaCpp(testRecipe(body), {
      ...common,
      fetchImpl: vi.fn(async () => new Response(body, { status: 200 })),
      randomBytes: ((size: number) => Buffer.alloc(size, 3)) as typeof crypto.randomBytes,
    });
    fs.rmSync(path.join(homeDir, ".nemoclaw"), {
      force: true,
      recursive: true,
    });
    docker.resetRuntime();
    const fetchImpl = vi.fn(async () => {
      throw new Error("verified cache should be reused");
    });

    const second = await installManagedLlamaCpp(testRecipe(body), {
      ...common,
      fetchImpl,
      randomBytes: ((size: number) => Buffer.alloc(size, 4)) as typeof crypto.randomBytes,
    });

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("strips the Hugging Face token before following a redirect to another host", async () => {
    vi.stubEnv("HF_TOKEN", "hf_private_test_token");
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-llama-installer-"));
    temporaryDirectories.push(homeDir);
    const body = Buffer.from("redirected-catalog-gguf");
    const docker = dockerHarness();
    const responses = {
      "huggingface.co": () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/model.gguf" },
        }),
      "cdn.example": () => new Response(body, { status: 200 }),
    } as const;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      return responses[new URL(String(url)).hostname as keyof typeof responses]();
    });

    const result = await installManagedLlamaCpp(testRecipe(body), {
      homeDir,
      fetchImpl,
      dockerCaptureImpl: docker.capture,
      dockerForceRmImpl: vi.fn() as never,
      dockerRunImpl: docker.run,
      dockerPullImpl: vi.fn(async () => ({ status: 0 })) as never,
      probeImpl: vi.fn(() => ({
        ok: true as const,
        model: "nvidia-nemotron-3-nano-30b-a3b",
      })),
      randomBytes: ((size: number) => Buffer.alloc(size, 5)) as typeof crypto.randomBytes,
      sleepImpl: vi.fn(async () => {}),
      log: vi.fn(),
    });

    expect(result).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstHeaders = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const secondHeaders = fetchImpl.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(firstHeaders.Authorization).toBe("Bearer hf_private_test_token");
    expect(secondHeaders.Authorization).toBeUndefined();
  });

  it("cleans up a readiness timeout and retries on the owned network", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-llama-installer-"));
    temporaryDirectories.push(homeDir);
    const body = Buffer.from("retryable-catalog-gguf");
    const docker = dockerHarness();
    let clock = 0;
    const ready = vi.fn(() => ({
      ok: true as const,
      model: "nvidia-nemotron-3-nano-30b-a3b",
    }));
    const common = {
      homeDir,
      fetchImpl: vi.fn(async () => new Response(body, { status: 200 })),
      dockerCaptureImpl: docker.capture,
      dockerForceRmImpl: docker.forceRm,
      dockerRunImpl: docker.run,
      dockerPullImpl: vi.fn(async () => ({ status: 0 })) as never,
      randomBytes: ((size: number) => Buffer.alloc(size, 6)) as typeof crypto.randomBytes,
      now: () => clock,
      sleepImpl: vi.fn(async () => {
        clock += 2_000;
      }),
      log: vi.fn(),
    };

    const first = await installManagedLlamaCpp(testRecipe(body), {
      ...common,
      probeImpl: vi.fn(() => ({
        ok: false as const,
        reason: "unreachable" as const,
        message: "not ready",
      })),
    });
    clock = 0;
    const second = await installManagedLlamaCpp(testRecipe(body), {
      ...common,
      probeImpl: ready,
    });

    expect(first).toEqual({
      ok: false,
      reason: "llama.cpp did not satisfy readiness before the timeout",
    });
    expect(second).toMatchObject({ ok: true });
    expect(docker.forceRm).toHaveBeenCalledTimes(1);
    expect(
      docker.run.mock.calls.filter(
        ([argv]) => (argv as string[]).slice(0, 2).join(" ") === "network create",
      ),
    ).toHaveLength(1);
    expect(docker.run.mock.calls.filter(([argv]) => (argv as string[])[0] === "run")).toHaveLength(
      2,
    );
    expect(ready).toHaveBeenCalledTimes(1);
  });
});
