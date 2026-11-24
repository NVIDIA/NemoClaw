// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { getNimContextWindow, getNimInferenceEndpoints, getServedModelId } from "./nim";

const capture = vi.hoisted(() => vi.fn());
vi.mock("../runner", () => ({ runCapture: capture }));

it("reads NIM model and context from its bounded unauthenticated loopback endpoint", () => {
  capture.mockReturnValue(JSON.stringify({ data: [{ id: "nim/model", max_model_len: 65536 }] }));
  vi.stubEnv("NGC_API_KEY", "host-ngc-secret");
  expect(getServedModelId()).toBe("nim/model");
  expect(getNimContextWindow("nim/model")).toBe(65536);
  expect(capture).toHaveBeenLastCalledWith(
    [
      "curl",
      "-sf",
      "--connect-timeout",
      "5",
      "--max-time",
      "5",
      `${getNimInferenceEndpoints().validationBaseUrl}/models`,
    ],
    { ignoreError: true },
  );
});

it.each([
  null,
  "not-json",
  JSON.stringify({ data: [] }),
  JSON.stringify({ data: [{ id: "different-model", max_model_len: 262144 }] }),
  JSON.stringify({ data: [{ id: "nim/model" }] }),
])("omits unavailable or mismatched NIM context metadata: %s", (body) => {
  capture.mockReturnValue(body);
  expect(getNimContextWindow("nim/model")).toBeNull();
});
