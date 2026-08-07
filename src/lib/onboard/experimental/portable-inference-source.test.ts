// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parsePortableInferenceDescriptor,
  readPortableInferenceBootstrapFile,
  readPortableInferenceDescriptorFromS3,
  resolvePortableInferenceSource,
} from "./portable-inference-source";

function descriptor(fields: Record<string, unknown>): Buffer {
  return Buffer.from(Buffer.from(JSON.stringify(fields)).toString("base64"));
}

const VALID_FIELDS = {
  apiKey: "test-credential-value-1234",
  url: "https://inference.example.test/v1",
  model: "example/model-1",
};
const TEST_ACCESS_KEY_ID = "AKIAABCDEFGHIJKLMNOP";
const TEST_SECRET_ACCESS_KEY = "s".repeat(40);
const TEST_BOOTSTRAP = `${TEST_ACCESS_KEY_ID}:${TEST_SECRET_ACCESS_KEY}`;

const tempDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("portable hosted inference source", () => {
  it("does not read object storage when the bootstrap credential is missing", () => {
    const readObject = vi.fn();

    expect(resolvePortableInferenceSource({}, () => null, readObject)).toBeNull();
    expect(readObject).not.toHaveBeenCalled();
  });

  it("reads an owner-only bootstrap credential without removing it", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "portable-inference-test-"));
    tempDirectories.push(directory);
    const filePath = path.join(directory, "portable-bootstrap");
    writeFileSync(filePath, TEST_BOOTSTRAP, { mode: 0o600 });
    chmodSync(filePath, 0o600);

    expect(readPortableInferenceBootstrapFile(filePath)).toEqual(Buffer.from(TEST_BOOTSTRAP));
    expect(existsSync(filePath)).toBe(true);
  });

  it("finds infrakey.txt on the desktop and immediately restricts its permissions", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "portable-inference-test-"));
    tempDirectories.push(directory);
    const desktop = path.join(directory, "Desktop");
    const filePath = path.join(desktop, "infrakey.txt");
    mkdirSync(desktop);
    writeFileSync(filePath, `${TEST_ACCESS_KEY_ID}\n${TEST_SECRET_ACCESS_KEY}\n`, { mode: 0o644 });
    chmodSync(filePath, 0o644);
    vi.stubEnv("HOME", directory);

    const raw = readPortableInferenceBootstrapFile();

    expect(raw).toEqual(Buffer.from(`${TEST_ACCESS_KEY_ID}\n${TEST_SECRET_ACCESS_KEY}\n`));
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(existsSync(filePath)).toBe(true);
  });

  it("rejects a group-readable bootstrap credential without consuming it", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "portable-inference-test-"));
    tempDirectories.push(directory);
    const filePath = path.join(directory, "portable-bootstrap");
    writeFileSync(filePath, TEST_BOOTSTRAP, { mode: 0o640 });
    chmodSync(filePath, 0o640);

    expect(() => readPortableInferenceBootstrapFile(filePath)).toThrow("mode 0600");
    expect(existsSync(filePath)).toBe(true);
  });

  it("rejects a symlinked bootstrap credential", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "portable-inference-test-"));
    tempDirectories.push(directory);
    const targetPath = path.join(directory, "target");
    const linkPath = path.join(directory, "portable-bootstrap");
    writeFileSync(targetPath, TEST_BOOTSTRAP, { mode: 0o600 });
    chmodSync(targetPath, 0o600);
    symlinkSync(targetPath, linkPath);

    expect(() => readPortableInferenceBootstrapFile(linkPath)).toThrow(
      "could not read its bootstrap credential",
    );
  });

  it("fetches and validates the descriptor from the fixed object source", () => {
    const rawBootstrap = Buffer.from(TEST_BOOTSTRAP);
    const readObject = vi.fn(() => descriptor(VALID_FIELDS));

    expect(resolvePortableInferenceSource({}, () => rawBootstrap, readObject)).toEqual({
      apiKey: VALID_FIELDS.apiKey,
      baseUrl: VALID_FIELDS.url,
      model: VALID_FIELDS.model,
    });
    expect(readObject).toHaveBeenCalledWith({
      accessKeyId: TEST_ACCESS_KEY_ID,
      secretAccessKey: TEST_SECRET_ACCESS_KEY,
    });
    expect(rawBootstrap.every((byte) => byte === 0)).toBe(true);
  });

  it("accepts desktop-friendly credentials on two separate lines", () => {
    const rawBootstrap = Buffer.from(`${TEST_ACCESS_KEY_ID}\n${TEST_SECRET_ACCESS_KEY}\n`);
    expect(
      resolvePortableInferenceSource(
        {},
        () => rawBootstrap,
        () => descriptor(VALID_FIELDS),
      ),
    ).toEqual({
      apiKey: VALID_FIELDS.apiKey,
      baseUrl: VALID_FIELDS.url,
      model: VALID_FIELDS.model,
    });
    expect(rawBootstrap.every((byte) => byte === 0)).toBe(true);
  });

  it("keeps the long-term bootstrap secret out of the curl process boundary", () => {
    const rawDescriptor = descriptor(VALID_FIELDS);
    const runCurl = vi.fn(() => ({
      pid: 1,
      output: [null, rawDescriptor, Buffer.alloc(0)],
      stdout: rawDescriptor,
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    })) as unknown as typeof import("node:child_process").spawnSync;

    expect(
      readPortableInferenceDescriptorFromS3(
        {
          accessKeyId: TEST_ACCESS_KEY_ID,
          secretAccessKey: TEST_SECRET_ACCESS_KEY,
        },
        runCurl,
        new Date("2026-08-07T18:00:00.000Z"),
      ),
    ).toEqual(rawDescriptor);

    expect(runCurl).toHaveBeenCalledOnce();
    const [command, args, options] = (runCurl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(command).toBe("curl");
    expect(args).toEqual(["--config", "-"]);
    expect(JSON.stringify(args)).not.toContain(TEST_ACCESS_KEY_ID);
    expect(JSON.stringify(args)).not.toContain(TEST_SECRET_ACCESS_KEY);
    expect(JSON.stringify(options.env ?? {})).not.toContain(TEST_ACCESS_KEY_ID);
    expect(JSON.stringify(options.env ?? {})).not.toContain(TEST_SECRET_ACCESS_KEY);
    expect(String(options.input)).toContain("Authorization: AWS4-HMAC-SHA256");
    expect(String(options.input)).not.toContain(TEST_SECRET_ACCESS_KEY);
    expect(options).toMatchObject({
      maxBuffer: 65_537,
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
  });

  it("redacts bootstrap and object-reader errors that can contain credentials", () => {
    const bootstrapSecret = "bootstrap-secret-value";
    const descriptorSecret = "descriptor-secret-value";

    expect(() =>
      resolvePortableInferenceSource(
        {},
        () => {
          throw new Error(bootstrapSecret);
        },
        vi.fn(),
      ),
    ).toThrow("could not read its bootstrap credential");
    try {
      resolvePortableInferenceSource(
        {},
        () => Buffer.from(TEST_BOOTSTRAP),
        () => {
          throw new Error(descriptorSecret);
        },
      );
    } catch (error) {
      expect(String(error)).toContain("could not read its credential descriptor");
      expect(String(error)).not.toContain(descriptorSecret);
    }
  });

  it.each([
    [Buffer.from("missing-separator"), "invalid bootstrap credential"],
    [Buffer.from(`short:${TEST_SECRET_ACCESS_KEY}`), "invalid bootstrap credential"],
    [Buffer.from(`${TEST_ACCESS_KEY_ID}:short`), "invalid bootstrap credential"],
  ])("rejects an invalid bootstrap credential", (raw, message) => {
    expect(() => resolvePortableInferenceSource({}, () => raw, vi.fn())).toThrow(message);
    expect(raw.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    [Buffer.from("not base64"), "invalid base64"],
    [Buffer.from(Buffer.from("not JSON").toString("base64")), "not valid JSON"],
    [descriptor({ ...VALID_FIELDS, apiKey: "short" }), "no usable credential"],
    [descriptor({ ...VALID_FIELDS, url: "http://127.0.0.1/v1" }), "HTTPS URL"],
    [descriptor({ ...VALID_FIELDS, url: "https://name:secret@example.test/v1" }), "HTTPS URL"],
    [descriptor({ ...VALID_FIELDS, url: "https://example.test/v1?key=secret" }), "HTTPS URL"],
    [descriptor({ ...VALID_FIELDS, model: "model with spaces" }), "no usable model ID"],
    [
      descriptor({ ...VALID_FIELDS, api_key: "different-test-credential-5678" }),
      "conflicting credential fields",
    ],
  ])("rejects an unsafe descriptor before onboarding", (raw, message) => {
    expect(() => parsePortableInferenceDescriptor(raw)).toThrow(message);
  });
});
