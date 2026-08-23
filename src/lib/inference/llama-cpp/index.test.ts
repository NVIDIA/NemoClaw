// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { validateCurlProbeArgs } from "../../adapters/http/curl-args";
import type { CurlProbeOptions, CurlProbeResult } from "../../adapters/http/probe";
import { isSafeLlamaCppServedModelAlias, probeLlamaCppAttachment } from "./index";

function response(httpStatus: number, body: string): CurlProbeResult {
  return {
    ok: httpStatus >= 200 && httpStatus < 300,
    httpStatus,
    curlStatus: 0,
    body,
    stderr: "",
    message: `HTTP ${httpStatus}`,
  } as CurlProbeResult;
}

function curlFailure(curlStatus: number): CurlProbeResult {
  return {
    ok: false,
    httpStatus: 0,
    curlStatus,
    body: "",
    stderr: "bounded probe failure",
    message: "bounded probe failure",
  };
}

function nativeModel(id = "team/model-alias") {
  return {
    id,
    object: "model",
    owned_by: "llamacpp",
    meta: { n_vocab: 128000, n_ctx: 8192, n_ctx_train: 32768, n_embd: 4096 },
  };
}

function nativeResponses(model = "team/model-alias"): CurlProbeResult[] {
  return [
    response(401, '{"error":"unauthorized"}'),
    response(200, JSON.stringify({ data: [nativeModel(model)] })),
    response(200, '{"status":"ok"}'),
    response(
      200,
      JSON.stringify({
        model_alias: model,
        model_path: "/models/model.gguf",
        total_slots: 2,
        default_generation_settings: { params: {} },
      }),
    ),
    response(200, "# TYPE llamacpp:requests_processing gauge\nllamacpp:requests_processing 0\n"),
  ];
}

function scriptedProbe(responses: CurlProbeResult[]) {
  let index = 0;
  return vi.fn((argv: string[], options?: CurlProbeOptions) => {
    expect(() => validateCurlProbeArgs(argv, options)).not.toThrow();
    const current = responses[index];
    index += 1;
    expect(current, `unexpected probe ${index}`).toBeDefined();
    return current!;
  });
}

describe("isSafeLlamaCppServedModelAlias", () => {
  it("accepts a served model alias at the 256-byte boundary (#8161)", () => {
    expect(isSafeLlamaCppServedModelAlias("a".repeat(256))).toBe(true);
  });

  it("rejects a served model alias beyond the 256-byte boundary (#8161)", () => {
    expect(isSafeLlamaCppServedModelAlias("a".repeat(257))).toBe(false);
  });
});

describe("probeLlamaCppAttachment", () => {
  it("requires an operator-supplied native API key (#8161)", () => {
    expect(probeLlamaCppAttachment("  ")).toMatchObject({
      ok: false,
      reason: "authentication-required",
    });
  });

  it.each(["http://127.0.0.1:8082", "http://192.0.2.10:8081"])(
    "rejects attachment endpoint %s outside fixed loopback port 8081 (#8161)",
    (baseUrl) => {
      const probe = vi.fn();
      expect(
        probeLlamaCppAttachment("secret-token", { baseUrl, runCurlProbeImpl: probe }),
      ).toMatchObject({ ok: false, reason: "invalid-endpoint" });
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it("accepts a bounded authenticated native llama.cpp fingerprint (#8161)", () => {
    const probe = scriptedProbe(nativeResponses());

    expect(probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: probe })).toEqual({
      ok: true,
      model: "team/model-alias",
    });
    expect(probe).toHaveBeenCalledTimes(5);
    probe.mock.calls.forEach(([argv, options]) => {
      expect(argv).toEqual(expect.arrayContaining(["--max-time", "5", "--max-filesize", "262144"]));
      expect(options).toEqual(expect.objectContaining({ maxResponseBytes: 262144 }));
    });
  });

  it("falls back to unscoped read-only probes when model queries are unavailable (#9592)", () => {
    const native = nativeResponses();
    const probe = scriptedProbe([
      native[0]!,
      native[1]!,
      native[2]!,
      response(
        404,
        '{"error":{"code":"route_not_available","type":"invalid_request_error"}}',
      ),
      native[3]!,
      response(
        404,
        '{"error":{"code":"route_not_available","type":"invalid_request_error"}}',
      ),
      native[4]!,
    ]);

    expect(probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: probe })).toEqual({
      ok: true,
      model: "team/model-alias",
    });
    expect(probe.mock.calls.map(([argv]) => argv.at(-1))).toEqual([
      "http://127.0.0.1:8081/v1/models",
      "http://127.0.0.1:8081/v1/models",
      "http://127.0.0.1:8081/health",
      "http://127.0.0.1:8081/props?model=team%2Fmodel-alias",
      "http://127.0.0.1:8081/props",
      "http://127.0.0.1:8081/metrics?model=team%2Fmodel-alias",
      "http://127.0.0.1:8081/metrics",
    ]);
  });

  it("accepts llama.cpp's native metrics-disabled response (#8161)", () => {
    const responses = nativeResponses();
    responses[4] = response(
      501,
      '{"error":{"code":501,"message":"metrics endpoint is disabled","type":"not_supported_error"}}',
    );

    expect(
      probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: scriptedProbe(responses) }),
    ).toMatchObject({ ok: true });
  });

  it("accepts non-conflicting health metadata from llama.cpp (#8161)", () => {
    const responses = nativeResponses();
    responses[2] = response(200, '{"status":"ok","slots_idle":2}');

    expect(
      probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: scriptedProbe(responses) }),
    ).toMatchObject({ ok: true });
  });

  it("requires an exact operator-supplied alias when multiple models are served (#8161)", () => {
    const responses = nativeResponses("second/model");
    responses[1] = response(
      200,
      JSON.stringify({ data: [nativeModel("first/model"), nativeModel("second/model")] }),
    );

    const result = probeLlamaCppAttachment("secret-token", {
      requestedModel: "second/model",
      runCurlProbeImpl: scriptedProbe(responses),
    });

    expect(result).toEqual({ ok: true, model: "second/model" });
  });

  it("does not use an unscoped fallback when multiple models are served (#9592)", () => {
    const responses = nativeResponses("second/model");
    responses[1] = response(
      200,
      JSON.stringify({ data: [nativeModel("first/model"), nativeModel("second/model")] }),
    );
    responses[3] = response(
      404,
      '{"error":{"code":"route_not_available","type":"invalid_request_error"}}',
    );
    const probe = scriptedProbe(responses);

    expect(
      probeLlamaCppAttachment("secret-token", {
        requestedModel: "second/model",
        runCurlProbeImpl: probe,
      }),
    ).toMatchObject({ ok: false, reason: "conflicting-fingerprint" });
    expect(probe).toHaveBeenCalledTimes(5);
  });

  it("rejects mixed llama.cpp and vLLM model metadata when the requested entry is native llama.cpp (#8161)", () => {
    const responses = nativeResponses();
    responses[1] = response(
      200,
      JSON.stringify({
        data: [nativeModel(), { id: "other/model", object: "model", owned_by: "vllm" }],
      }),
    );
    const probe = scriptedProbe(responses);

    expect(
      probeLlamaCppAttachment("secret-token", {
        requestedModel: "team/model-alias",
        runCurlProbeImpl: probe,
      }),
    ).toMatchObject({ ok: false, reason: "conflicting-fingerprint" });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("rejects an ambiguous multi-model catalog instead of guessing (#8161)", () => {
    const responses = nativeResponses();
    responses[1] = response(
      200,
      JSON.stringify({ data: [nativeModel("first/model"), nativeModel("second/model")] }),
    );

    expect(
      probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: scriptedProbe(responses) }),
    ).toMatchObject({ ok: false, reason: "ambiguous-model" });
  });

  it("accepts a llama.cpp fingerprint with a public /v1/models endpoint (#8302)", () => {
    const responses: CurlProbeResult[] = [
      response(200, '{"data":[]}'),
      response(401, '{"error":"unauthorized"}'),
      response(200, JSON.stringify({ data: [nativeModel()] })),
      response(200, '{"status":"ok"}'),
      response(
        200,
        JSON.stringify({
          model_alias: "team/model-alias",
          model_path: "/models/model.gguf",
          total_slots: 2,
          default_generation_settings: { params: {} },
        }),
      ),
      response(200, "# TYPE llamacpp:requests_processing gauge\nllamacpp:requests_processing 0\n"),
    ];
    expect(
      probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: scriptedProbe(responses) }),
    ).toEqual({ ok: true, model: "team/model-alias" });
  });

  it("rejects a non-llama.cpp server with public /v1/models (#8302)", () => {
    const result = probeLlamaCppAttachment("secret-token", {
      runCurlProbeImpl: scriptedProbe([
        response(200, '{"data":[]}'),
        response(401, '{"error":"unauthorized"}'),
        response(
          200,
          JSON.stringify({ data: [{ id: "model", object: "model", owned_by: "vllm" }] }),
        ),
      ]),
    });
    expect(result).toMatchObject({ ok: false, reason: "not-llama-cpp" });
  });

  it("rejects a server with public /v1/models that leaves /props unprotected (#8302)", () => {
    const probe = scriptedProbe([
      response(200, '{"data":[]}'),
      response(
        200,
        JSON.stringify({
          model_alias: "team/model-alias",
          model_path: "/models/model.gguf",
          total_slots: 2,
          default_generation_settings: { params: {} },
        }),
      ),
    ]);

    expect(probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: probe })).toMatchObject({
      ok: false,
      reason: "authentication-required",
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("classifies a missing protected /props endpoint as not llama.cpp (#8302)", () => {
    const probe = scriptedProbe([
      response(200, '{"data":[]}'),
      response(404, '{"error":"not found"}'),
    ]);

    expect(probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: probe })).toMatchObject({
      ok: false,
      reason: "not-llama-cpp",
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("reports a timeout when anonymous /props does not respond (#8302)", () => {
    const probe = scriptedProbe([response(200, '{"data":[]}'), curlFailure(28)]);

    expect(probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: probe })).toMatchObject({
      ok: false,
      reason: "probe-timeout",
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("rejects an oversized anonymous /props response (#8302)", () => {
    const probe = scriptedProbe([response(200, '{"data":[]}'), curlFailure(63)]);

    expect(probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: probe })).toMatchObject({
      ok: false,
      reason: "oversized-response",
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("rejects a vLLM model catalog (#8161)", () => {
    const result = probeLlamaCppAttachment("secret-token", {
      runCurlProbeImpl: scriptedProbe([
        response(401, '{"error":"unauthorized"}'),
        response(
          200,
          JSON.stringify({ data: [{ id: "model", object: "model", owned_by: "vllm" }] }),
        ),
      ]),
    });

    expect(result).toMatchObject({ ok: false, reason: "not-llama-cpp" });
  });

  it.each([401, 403])(
    "rejects an authenticated model catalog response with HTTP %s (#8161)",
    (status) => {
      const result = probeLlamaCppAttachment("secret-token", {
        runCurlProbeImpl: scriptedProbe([
          response(401, '{"error":"unauthorized"}'),
          response(status, '{"error":"unauthorized"}'),
        ]),
      });

      expect(result).toMatchObject({ ok: false, reason: "authentication-rejected" });
    },
  );

  it("rejects an oversized fingerprint response (#8161)", () => {
    const result = probeLlamaCppAttachment("secret-token", {
      runCurlProbeImpl: scriptedProbe([response(401, '{"error":"unauthorized"}'), curlFailure(63)]),
    });

    expect(result).toMatchObject({ ok: false, reason: "oversized-response" });
  });

  it("rejects a timed-out fingerprint probe (#8161)", () => {
    const result = probeLlamaCppAttachment("secret-token", {
      runCurlProbeImpl: scriptedProbe([curlFailure(28)]),
    });

    expect(result).toMatchObject({ ok: false, reason: "probe-timeout" });
  });

  it("rejects a malformed authenticated fingerprint (#8161)", () => {
    const result = probeLlamaCppAttachment("secret-token", {
      runCurlProbeImpl: scriptedProbe([
        response(401, '{"error":"unauthorized"}'),
        response(200, "not-json"),
      ]),
    });

    expect(result).toMatchObject({ ok: false, reason: "malformed-fingerprint" });
  });

  it("rejects a spoofed catalog without corroborating native endpoints (#8161)", () => {
    const responses = nativeResponses();
    responses[3] = response(404, '{"error":"not found"}');
    const probe = scriptedProbe(responses);

    expect(
      probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: probe }),
    ).toMatchObject({ ok: false, reason: "conflicting-fingerprint" });
    expect(probe).toHaveBeenCalledTimes(5);
  });

  it("rejects conflicting model identity across native endpoints (#8161)", () => {
    const responses = nativeResponses();
    responses[3] = response(
      200,
      JSON.stringify({
        model_alias: "different/model",
        model_path: "/models/model.gguf",
        total_slots: 2,
        default_generation_settings: { params: {} },
      }),
    );

    expect(
      probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: scriptedProbe(responses) }),
    ).toMatchObject({ ok: false, reason: "conflicting-fingerprint" });
  });

  it("attaches a native server whose properties omit the served model alias (#9603)", () => {
    const responses = nativeResponses();
    responses[3] = response(
      200,
      JSON.stringify({
        model_path: "/models/model.gguf",
        total_slots: 2,
        default_generation_settings: { params: {} },
      }),
    );

    expect(
      probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: scriptedProbe(responses) }),
    ).toEqual({ ok: true, model: "team/model-alias" });
  });

  it("rejects properties that report a null served model alias (#9603)", () => {
    const responses = nativeResponses();
    responses[3] = response(
      200,
      JSON.stringify({
        model_alias: null,
        model_path: "/models/model.gguf",
        total_slots: 2,
        default_generation_settings: { params: {} },
      }),
    );

    expect(
      probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: scriptedProbe(responses) }),
    ).toMatchObject({ ok: false, reason: "conflicting-fingerprint" });
  });

  it("names the health endpoint when the server reports a loading model (#9603)", () => {
    const responses = nativeResponses();
    responses[2] = response(200, '{"status":"loading model"}');

    expect(
      probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: scriptedProbe(responses) }),
    ).toMatchObject({
      ok: false,
      reason: "conflicting-fingerprint",
      message: expect.stringContaining("health endpoint"),
    });
  });

  it("names the properties endpoint when model_alias differs from the served model alias (#9603)", () => {
    const responses = nativeResponses();
    responses[3] = response(
      200,
      JSON.stringify({
        model_alias: "different/model",
        model_path: "/models/model.gguf",
        total_slots: 2,
        default_generation_settings: { params: {} },
      }),
    );

    expect(
      probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: scriptedProbe(responses) }),
    ).toMatchObject({
      ok: false,
      reason: "conflicting-fingerprint",
      message: expect.stringContaining("properties endpoint"),
    });
  });

  it("names the metrics endpoint when the response has no llama.cpp metrics (#9603)", () => {
    const responses = nativeResponses();
    responses[4] = response(200, "# TYPE go_gc_duration_seconds summary\ngo_goroutines 12\n");

    expect(
      probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: scriptedProbe(responses) }),
    ).toMatchObject({
      ok: false,
      reason: "conflicting-fingerprint",
      message: expect.stringContaining("metrics endpoint"),
    });
  });

  it.each([
    "/models/model.gguf",
    "C:\\models\\model.gguf",
    "../model.gguf",
    "model.gguf",
    "models/../secret",
    "foo/./bar",
  ])("rejects path-like served model alias %s (#8161)", (model) => {
    const responses = nativeResponses(model);
    expect(
      probeLlamaCppAttachment("secret-token", { runCurlProbeImpl: scriptedProbe(responses) }),
    ).toMatchObject({ ok: false, reason: "unsafe-model-alias" });
  });

  it("keeps the credential out of curl arguments and returned diagnostics (#8161)", () => {
    const token = "llama-secret-credential";
    const responses = nativeResponses();
    const configModes: number[] = [];
    let index = 0;
    const probe = vi.fn((argv: string[], options?: CurlProbeOptions) => {
      (options?.trustedConfigFiles ?? []).forEach((configPath) => {
        configModes.push(fs.statSync(configPath).mode & 0o777);
      });
      const current = responses[index++];
      expect(current, `unexpected probe ${index}`).toBeDefined();
      return current!;
    });

    const result = probeLlamaCppAttachment(token, { runCurlProbeImpl: probe });

    expect(JSON.stringify(result)).not.toContain(token);
    probe.mock.calls.forEach(([argv, options]) => {
      expect(JSON.stringify(argv)).not.toContain(token);
      expect((options?.trustedConfigFiles ?? []).every((configPath) =>
          Object.is(fs.existsSync(configPath), false))).toBe(true);
    });
    expect(configModes).toEqual([0o600, 0o600, 0o600, 0o600]);
  });
});
