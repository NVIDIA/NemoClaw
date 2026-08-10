// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadPortableInferenceDescriptor,
  PortableInferenceDescriptorError,
} from "./portable-inference-descriptor";

const NOW = Date.parse("2026-08-10T18:00:00Z");
const TEST_API_KEY = "descriptor-test-secret";
const testDirectories: string[] = [];

function createDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-inference-descriptor-"));
  fs.chmodSync(directory, 0o700);
  testDirectories.push(directory);
  return directory;
}

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    apiKey: TEST_API_KEY,
    baseUrl: "https://inference.example.test/v1",
    model: "vendor/model-1",
    expiresAt: "2026-08-10T18:05:00Z",
    ...overrides,
  };
}

function writeDescriptor(directory: string, value: unknown = descriptor(), mode = 0o600): string {
  const filePath = path.join(directory, "portable-inference.json");
  fs.writeFileSync(filePath, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(filePath, mode);
  return filePath;
}

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

afterEach(() => {
  for (const directory of testDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("portable runtime inference descriptor", () => {
  it("returns no activation when the descriptor is absent", async () => {
    const filePath = path.join(createDirectory(), "portable-inference.json");

    await expect(loadPortableInferenceDescriptor({ filePath, now: () => NOW })).resolves.toBeNull();
  });

  it("consumes a descriptor that passes file admission before returning the secret", async () => {
    const filePath = writeDescriptor(createDirectory(), {
      ...descriptor(),
      baseUrl: "https://inference.example.test/v1/chat/completions",
    });

    await expect(
      loadPortableInferenceDescriptor({
        filePath,
        now: () => NOW,
        resolveEndpointHost: publicResolver,
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      apiKey: TEST_API_KEY,
      baseUrl: "https://inference.example.test/v1",
      model: "vendor/model-1",
      expiresAt: "2026-08-10T18:05:00Z",
    });
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it.each([
    ["malformed JSON", "{", /valid UTF-8 JSON/],
    ["an expired value", descriptor({ expiresAt: "2026-08-10T17:59:59Z" }), /expired/],
    [
      "an impossible calendar date",
      descriptor({ expiresAt: "2026-02-30T18:05:00Z" }),
      /ISO 8601 UTC timestamp/,
    ],
    ["an extra field", descriptor({ region: "us-test-1" }), /exactly these fields/],
    ["a surrounding-space API key", descriptor({ apiKey: " secret" }), /apiKey.*format/],
    ["a newline-bearing API key", descriptor({ apiKey: "secret\nheader" }), /apiKey.*format/],
    ["a carriage-return API key", descriptor({ apiKey: "secret\rheader" }), /apiKey.*format/],
    ["a NUL-bearing API key", descriptor({ apiKey: "secret\0tail" }), /apiKey.*format/],
    ["an oversized API key", descriptor({ apiKey: "a".repeat(16 * 1024 + 1) }), /apiKey.*format/],
    [
      "a control character in the model",
      descriptor({ model: "vendor/model\u0001" }),
      /model.*format/,
    ],
    [
      "a query-bearing endpoint",
      descriptor({ baseUrl: "https://example.test/v1?target=x" }),
      /query or fragment/,
    ],
  ])("deletes an admitted descriptor containing %s", async (_label, value, expected) => {
    const directory = createDirectory();
    const filePath = path.join(directory, "portable-inference.json");
    fs.writeFileSync(filePath, typeof value === "string" ? value : JSON.stringify(value), {
      mode: 0o600,
    });
    fs.chmodSync(filePath, 0o600);

    await expect(
      loadPortableInferenceDescriptor({
        filePath,
        now: () => NOW,
        resolveEndpointHost: publicResolver,
      }),
    ).rejects.toThrow(expected);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("deletes an admitted descriptor that exceeds the file-size limit", async () => {
    const directory = createDirectory();
    const filePath = path.join(directory, "portable-inference.json");
    fs.writeFileSync(filePath, "x".repeat(64 * 1024 + 1), { mode: 0o600 });

    await expect(loadPortableInferenceDescriptor({ filePath, now: () => NOW })).rejects.toThrow(
      /65536-byte limit/,
    );
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("rejects a loopback endpoint before any credential-bearing request", async () => {
    const filePath = writeDescriptor(
      createDirectory(),
      descriptor({ baseUrl: "https://127.0.0.1:8443/v1" }),
    );
    let resolverCalled = false;

    await expect(
      loadPortableInferenceDescriptor({
        filePath,
        now: () => NOW,
        resolveEndpointHost: async () => {
          resolverCalled = true;
          return [{ address: "127.0.0.1", family: 4 }];
        },
      }),
    ).rejects.toThrow(/private\/internal address/);
    expect(resolverCalled).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("rejects a public name that resolves to a private address", async () => {
    const filePath = writeDescriptor(createDirectory());

    await expect(
      loadPortableInferenceDescriptor({
        filePath,
        now: () => NOW,
        resolveEndpointHost: async () => [{ address: "10.0.0.8", family: 4 }],
      }),
    ).rejects.toThrow(/private\/internal address/);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("admits a private endpoint for its exact trusted host", async () => {
    const filePath = writeDescriptor(createDirectory());

    await expect(
      loadPortableInferenceDescriptor({
        filePath,
        env: { NEMOCLAW_TRUSTED_PRIVATE_INFERENCE_HOSTS: "inference.example.test" },
        now: () => NOW,
        resolveEndpointHost: async () => [{ address: "10.0.0.8", family: 4 }],
      }),
    ).resolves.toMatchObject({ baseUrl: "https://inference.example.test/v1" });
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("omits the API key from a DNS resolution error", async () => {
    const filePath = writeDescriptor(
      createDirectory(),
      descriptor({ baseUrl: "https://unresolvable.example.test/v1" }),
    );

    let caught: unknown;
    try {
      await loadPortableInferenceDescriptor({
        filePath,
        now: () => NOW,
        resolveEndpointHost: async () => {
          throw new Error("resolver failed");
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PortableInferenceDescriptorError);
    expect(String(caught)).not.toContain(TEST_API_KEY);
  });

  it("leaves a symlink in place without reading or deleting its target", async () => {
    const directory = createDirectory();
    const targetPath = path.join(directory, "target.json");
    const filePath = path.join(directory, "portable-inference.json");
    fs.writeFileSync(targetPath, JSON.stringify(descriptor()), { mode: 0o600 });
    fs.symlinkSync(targetPath, filePath);

    await expect(loadPortableInferenceDescriptor({ filePath, now: () => NOW })).rejects.toThrow(
      /must not be a symbolic link/,
    );
    expect(fs.lstatSync(filePath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(targetPath)).toBe(true);
  });

  it("leaves a FIFO in place without opening it", async () => {
    const filePath = path.join(createDirectory(), "portable-inference.json");
    execFileSync("mkfifo", [filePath]);
    const openSpy = vi.spyOn(fs, "openSync");

    try {
      await expect(loadPortableInferenceDescriptor({ filePath, now: () => NOW })).rejects.toThrow(
        /must be a regular file/,
      );
      expect(openSpy).not.toHaveBeenCalled();
      expect(fs.lstatSync(filePath).isFIFO()).toBe(true);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("leaves a wrong-mode file in place", async () => {
    const filePath = writeDescriptor(createDirectory(), descriptor(), 0o640);

    await expect(loadPortableInferenceDescriptor({ filePath, now: () => NOW })).rejects.toThrow(
      /mode 0600/,
    );
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("leaves a hard-linked descriptor in place", async () => {
    const directory = createDirectory();
    const filePath = writeDescriptor(directory);
    const secondPath = path.join(directory, "second-link.json");
    fs.linkSync(filePath, secondPath);

    await expect(loadPortableInferenceDescriptor({ filePath, now: () => NOW })).rejects.toThrow(
      /exactly one hard link/,
    );
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(secondPath)).toBe(true);
  });

  it("leaves a descriptor inside a group-writable directory in place", async () => {
    const directory = createDirectory();
    const filePath = writeDescriptor(directory);
    fs.chmodSync(directory, 0o770);

    await expect(loadPortableInferenceDescriptor({ filePath, now: () => NOW })).rejects.toThrow(
      /must not be writable by group or others/,
    );
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
