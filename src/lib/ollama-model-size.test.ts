// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildManifestUrl,
  formatBytes,
  formatModelSize,
  getOllamaModelSize,
  probeRegistrySize,
} from "../../dist/lib/ollama-model-size";

const MANIFEST = JSON.stringify({
  layers: [{ size: 1_000_000_000 }, { size: 200_000_000 }, { size: 25_000 }],
});

const captureReturning =
  (body: string) =>
  (_cmd: readonly string[]): string =>
    body;

function recordingCapture(body: string) {
  const calls: string[][] = [];
  return {
    calls,
    capture: (cmd: readonly string[]): string => {
      calls.push([...cmd]);
      return body;
    },
  };
}

describe("buildManifestUrl", () => {
  it("defaults the namespace to library/ and the tag to latest", () => {
    expect(buildManifestUrl("qwen2.5")).toBe(
      "https://registry.ollama.ai/v2/library/qwen2.5/manifests/latest",
    );
  });

  it("preserves an explicit namespace and tag", () => {
    expect(buildManifestUrl("acme/foo:7b")).toBe(
      "https://registry.ollama.ai/v2/acme/foo/manifests/7b",
    );
  });

  it("rejects model references with an empty tag", () => {
    expect(buildManifestUrl("foo:")).toBeNull();
  });

  it("rejects empty model references", () => {
    expect(buildManifestUrl("")).toBeNull();
  });
});

describe("probeRegistrySize", () => {
  it("sums layer sizes from a manifest body", () => {
    expect(probeRegistrySize("qwen2.5:7b", captureReturning(MANIFEST))).toBe(1_200_025_000);
  });

  it("invokes curl with the resolved manifest URL", () => {
    const recorder = recordingCapture(MANIFEST);
    probeRegistrySize("qwen2.5:7b", recorder.capture);
    const [argv] = recorder.calls;
    expect(argv[0]).toBe("curl");
    expect(argv[argv.length - 1]).toBe(
      "https://registry.ollama.ai/v2/library/qwen2.5/manifests/7b",
    );
  });

  it("returns null when the registry returns an empty body", () => {
    expect(probeRegistrySize("qwen2.5:7b", captureReturning(""))).toBeNull();
  });

  it("returns null when the body is not valid JSON", () => {
    expect(probeRegistrySize("qwen2.5:7b", captureReturning("not-json"))).toBeNull();
  });

  it("returns null when the manifest has no layers array", () => {
    expect(probeRegistrySize("qwen2.5:7b", captureReturning("{}"))).toBeNull();
  });

  it("returns null when a layer has a non-numeric size", () => {
    const bad = JSON.stringify({ layers: [{ size: "huge" }] });
    expect(probeRegistrySize("qwen2.5:7b", captureReturning(bad))).toBeNull();
  });

  it("returns null when a layer entry is null or not an object", () => {
    expect(
      probeRegistrySize("qwen2.5:7b", captureReturning(JSON.stringify({ layers: [null] }))),
    ).toBeNull();
    expect(
      probeRegistrySize("qwen2.5:7b", captureReturning(JSON.stringify({ layers: [42] }))),
    ).toBeNull();
  });
});

describe("getOllamaModelSize", () => {
  it("prefers the registry probe over the fallback table", () => {
    const lookup = getOllamaModelSize("qwen2.5:7b", captureReturning(MANIFEST));
    expect(lookup).toEqual({ bytes: 1_200_025_000, source: "registry" });
  });

  it("falls back to the bundled table when the probe fails", () => {
    const lookup = getOllamaModelSize("qwen2.5:7b", captureReturning(""));
    expect(lookup?.source).toBe("fallback");
    expect(lookup?.bytes).toBeGreaterThan(0);
  });

  it("returns null for unknown models when the probe fails", () => {
    expect(getOllamaModelSize("custom/whatever:abc", captureReturning(""))).toBeNull();
  });
});

describe("formatBytes", () => {
  it("renders bytes for small values", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("renders GB for multi-gigabyte values", () => {
    expect(formatBytes(4_683_073_184)).toBe("4.36 GB");
  });

  it("returns the unknown sentinel for negative values", () => {
    expect(formatBytes(-1)).toBe("size unknown");
  });
});

describe("formatModelSize", () => {
  it("returns the unknown sentinel when the lookup is null", () => {
    expect(formatModelSize(null)).toBe("size unknown");
  });

  it("renders registry-sourced sizes without a qualifier", () => {
    expect(formatModelSize({ bytes: 1_200_025_000, source: "registry" })).toBe("1.12 GB");
  });

  it("tags fallback-sourced sizes as estimated", () => {
    expect(formatModelSize({ bytes: 4_683_073_184, source: "fallback" })).toBe(
      "4.36 GB (estimated)",
    );
  });
});
