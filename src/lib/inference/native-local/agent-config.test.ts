// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { NATIVE_LOCAL_AUTH_HEADER_SCRIPT, nativeLocalCredentialReference } from "./agent-config";

const endpoint = "http://host.openshell.internal:43123/team/v1";
const reference = "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN";
const handle = "openshell:resolve:env:v7_NEMOCLAW_LOCAL_INFERENCE_TOKEN";

describe("native local image credential projection", () => {
  it.each([
    { value: undefined, category: "MISSING", status: 2 },
    { value: "", category: "MISSING", status: 2 },
    { value: "raw-secret-canary", category: "INVALID", status: 2 },
    { value: reference, category: "INVALID", status: 2 },
    { value: `${handle}\nraw-secret-canary`, category: "INVALID", status: 2 },
    { value: `${handle}\n`, category: "INVALID", status: 2 },
    { value: "openshell:resolve:env:v7_OPENAI_API_KEY", category: "INVALID", status: 2 },
    { value: handle, category: null, status: 0 },
    {
      value: `openshell:resolve:env:s${"a".repeat(64)}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`,
      category: null,
      status: 0,
    },
  ])(
    "classifies a projected auth header without disclosing its value, case %#",
    ({ value, category, status }) => {
      const result = spawnSync(
        "sh",
        ["-c", `${NATIVE_LOCAL_AUTH_HEADER_SCRIPT}; printf request-ready`],
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            ...(value === undefined ? {} : { NEMOCLAW_LOCAL_INFERENCE_TOKEN: value }),
          },
        },
      );
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status,
        stdout: category ? "" : "request-ready",
        stderr: category ? `NEMOCLAW_NATIVE_PROVIDER_HANDLE_${category}\n` : "",
      });
    },
  );

  it.each([handle, `openshell:resolve:env:s${"a".repeat(64)}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`])(
    "rejects an issued handle for the retired Router: %s",
    (issued) => {
      expect(nativeLocalCredentialReference("team-router", endpoint, undefined, issued)).toBeNull();
    },
  );

  it.each([
    undefined,
    "",
    "raw-key",
    reference,
    "openshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY",
    "openshell:resolve:env:sabc_NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    `${handle}\n`,
    `raw\n${handle}`,
    `${handle}\nraw`,
  ])("does not project a Router credential from an invalid handle: %s", (issued) => {
    expect(nativeLocalCredentialReference("team-router", endpoint, undefined, issued)).toBeNull();
  });

  it.each([
    "http://host.docker.internal:43123/team/v1",
    "http://10.1.2.3:43123/team/v1",
    "http://127.0.0.1:43123/team/v1",
    "http://169.254.169.254:43123/team/v1",
    "https://host.openshell.internal:43123/team/v1",
    "http://host.openshell.internal:80/team/v1",
    `${endpoint}?token=hidden`,
    `${endpoint}#fragment`,
    "http://user:pass@host.openshell.internal:43123/team/v1",
    `${endpoint}%2fadmin`,
  ])("does not use an issued Router handle at another endpoint shape: %s", (url) => {
    expect(nativeLocalCredentialReference("team-router", url, undefined, handle)).toBeNull();
  });

  it.each(["ollama-local", "vllm-local", "llama-cpp-local", "compatible-endpoint"])(
    "preserves the native credential projection for %s",
    (provider) => {
      expect(nativeLocalCredentialReference(provider, endpoint, "openclaw", handle)).toBe(
        reference,
      );
    },
  );
});
