// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  parsePortableInferenceDescriptor,
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

describe("portable hosted inference source", () => {
  it("does not read object storage when the portable source is not configured", () => {
    const readObject = vi.fn();

    expect(resolvePortableInferenceSource({}, readObject)).toBeNull();
    expect(readObject).not.toHaveBeenCalled();
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
