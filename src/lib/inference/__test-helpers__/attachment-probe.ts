// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, vi } from "vitest";
import { validateCurlProbeArgs } from "../../adapters/http/curl-args";
import type { CurlProbeOptions, CurlProbeResult } from "../../adapters/http/probe";

export function response(httpStatus: number, body: string): CurlProbeResult {
  const base = { httpStatus, curlStatus: 0, body, stderr: "", message: `HTTP ${httpStatus}` };
  return httpStatus >= 200 && httpStatus < 300 ? { ok: true, ...base } : { ok: false, ...base };
}

export function curlFailure(curlStatus: number): CurlProbeResult {
  return {
    ok: false,
    httpStatus: 0,
    curlStatus,
    body: "",
    stderr: "bounded probe failure",
    message: "bounded probe failure",
  };
}

/** Return the scripted responses in order, validating every curl argv on the way. */
export function scriptedProbe(responses: CurlProbeResult[]) {
  let index = 0;
  return vi.fn((argv: string[], options?: CurlProbeOptions) => {
    expect(() => validateCurlProbeArgs(argv, options)).not.toThrow();
    const current = responses[index];
    index += 1;
    expect(current, `unexpected probe ${index}`).toBeDefined();
    return current!;
  });
}
