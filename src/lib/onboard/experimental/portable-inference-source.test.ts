// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parsePortableInferenceDescriptor,
  readPortableInferenceActivationFile,
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

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("portable hosted inference source", () => {
  it("does not read object storage when the portable source is not configured", () => {
    const readObject = vi.fn();

    expect(resolvePortableInferenceSource({}, readObject)).toBeNull();
    expect(readObject).not.toHaveBeenCalled();
  });

  it("prefers an activated descriptor over configured object storage", () => {
    const readObject = vi.fn();
    const readActivatedDescriptor = vi.fn(() => descriptor(VALID_FIELDS));

    expect(
      resolvePortableInferenceSource(
        { S3_BUCKET: "portable-inference", S3_KEY: "path/credential.b64" },
        readObject,
        readActivatedDescriptor,
      ),
    ).toEqual({
      apiKey: VALID_FIELDS.apiKey,
      baseUrl: VALID_FIELDS.url,
      model: VALID_FIELDS.model,
    });
    expect(readActivatedDescriptor).toHaveBeenCalledOnce();
    expect(readObject).not.toHaveBeenCalled();
  });

  it("redacts unexpected activated-descriptor reader errors", () => {
    const readActivatedDescriptor = vi.fn(() => {
      throw new Error("reader output contained test-credential-value-1234");
    });

    expect(() => resolvePortableInferenceSource({}, vi.fn(), readActivatedDescriptor)).toThrow(
      "could not read its activated credential descriptor",
    );
    try {
      resolvePortableInferenceSource({}, vi.fn(), readActivatedDescriptor);
    } catch (error) {
      expect(String(error)).not.toContain("test-credential-value-1234");
    }
  });

  it("reads an owner-only activated descriptor file", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "portable-inference-test-"));
    tempDirectories.push(directory);
    const filePath = path.join(directory, "descriptor.b64");
    const raw = descriptor(VALID_FIELDS);
    writeFileSync(filePath, raw, { mode: 0o600 });
    chmodSync(filePath, 0o600);

    expect(readPortableInferenceActivationFile(filePath)).toEqual(raw);
  });

  it("rejects a group-readable activated descriptor file", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "portable-inference-test-"));
    tempDirectories.push(directory);
    const filePath = path.join(directory, "descriptor.b64");
    writeFileSync(filePath, descriptor(VALID_FIELDS), { mode: 0o640 });
    chmodSync(filePath, 0o640);

    expect(() => readPortableInferenceActivationFile(filePath)).toThrow(
      "owned by root or the current user",
    );
  });

  it("rejects a symlinked activated descriptor file", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "portable-inference-test-"));
    tempDirectories.push(directory);
    const targetPath = path.join(directory, "target.b64");
    const linkPath = path.join(directory, "descriptor.b64");
    writeFileSync(targetPath, descriptor(VALID_FIELDS), { mode: 0o600 });
    chmodSync(targetPath, 0o600);
    symlinkSync(targetPath, linkPath);

    expect(() => readPortableInferenceActivationFile(linkPath)).toThrow(
      "could not read its activated credential descriptor",
    );
  });

  it("reads and validates the configured descriptor without writing credential state", () => {
    const readObject = vi.fn(() => descriptor(VALID_FIELDS));
    const env = { S3_BUCKET: "portable-inference", S3_KEY: "/path/credential.b64" };

    expect(resolvePortableInferenceSource(env, readObject)).toEqual({
      apiKey: VALID_FIELDS.apiKey,
      baseUrl: VALID_FIELDS.url,
      model: VALID_FIELDS.model,
    });
    expect(readObject).toHaveBeenCalledWith("s3://portable-inference/path/credential.b64", env);
    expect(env).toEqual({
      S3_BUCKET: "portable-inference",
      S3_KEY: "/path/credential.b64",
    });
  });

  it("resolves the prefix form to the portable credential object", () => {
    const readObject = vi.fn(() =>
      descriptor({
        token: VALID_FIELDS.apiKey,
        base_url: `${VALID_FIELDS.url}/`,
        default_model: VALID_FIELDS.model,
      }),
    );

    expect(
      resolvePortableInferenceSource(
        { S3_BUCKET: "portable-inference", S3_PREFIX: "/tenant/session/" },
        readObject,
      ),
    ).toEqual({
      apiKey: VALID_FIELDS.apiKey,
      baseUrl: VALID_FIELDS.url,
      model: VALID_FIELDS.model,
    });
    expect(readObject).toHaveBeenCalledWith(
      "s3://portable-inference/tenant/session/secrets/nvcf-llm.b64",
      expect.any(Object),
    );
  });

  it("does not expose object-reader errors that can contain credential material", () => {
    const readObject = vi.fn(() => {
      throw new Error("upstream output contained test-credential-value-1234");
    });
    let caught: unknown;
    try {
      resolvePortableInferenceSource(
        { S3_BUCKET: "portable-inference", S3_KEY: "path/credential.b64" },
        readObject,
      );
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain(
      "Portable hosted inference could not read its credential descriptor.",
    );
    expect(String(caught)).not.toContain("test-credential-value-1234");
  });

  it.each([
    [{ S3_BUCKET: "portable-inference" }, "requires S3_BUCKET"],
    [{ S3_KEY: "credential.b64" }, "requires S3_BUCKET"],
    [
      { S3_BUCKET: "portable-inference", S3_KEY: "one", S3_PREFIX: "two" },
      "accepts S3_KEY or S3_PREFIX",
    ],
    [{ S3_BUCKET: "bad/bucket", S3_KEY: "credential.b64" }, "invalid S3_BUCKET"],
    [{ S3_BUCKET: "portable-inference", S3_PREFIX: "/" }, "invalid S3_PREFIX"],
  ])("rejects incomplete or ambiguous source configuration", (env, message) => {
    expect(() => resolvePortableInferenceSource(env, vi.fn())).toThrow(message);
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
