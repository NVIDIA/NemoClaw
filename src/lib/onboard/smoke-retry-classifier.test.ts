// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  classifyCurlExit,
  isRetryableHttpStatus,
  isSuccessfulHttpStatus,
  totalRetryBackoffSeconds,
} from "./smoke-retry-classifier";

describe("compatible endpoint smoke retry classifier", () => {
  it.each([6, 7, 28, 52, 55, 56])("classifies curl exit %i as transient", (code) => {
    expect(classifyCurlExit(code)).toBe("transient");
  });

  it.each([0, 1, 2, 22, 35, 60])("classifies curl exit %i as permanent", (code) => {
    expect(classifyCurlExit(code)).toBe("permanent");
  });

  it("retries only HTTP 5xx statuses", () => {
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(599)).toBe(true);
    expect(isRetryableHttpStatus(429)).toBe(false);
    expect(isRetryableHttpStatus(600)).toBe(false);
  });

  it("accepts only HTTP 2xx statuses", () => {
    expect(isSuccessfulHttpStatus(200)).toBe(true);
    expect(isSuccessfulHttpStatus(299)).toBe(true);
    expect(isSuccessfulHttpStatus(199)).toBe(false);
    expect(isSuccessfulHttpStatus(300)).toBe(false);
  });

  it("computes triangular retry backoff", () => {
    expect(totalRetryBackoffSeconds(3, 5)).toBe(15);
    expect(totalRetryBackoffSeconds(4, 5)).toBe(30);
  });
});
