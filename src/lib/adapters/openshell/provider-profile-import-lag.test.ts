// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createCliOpenShellProviderAdapter, type RunProviderCommand } from "./provider-adapter-cli";
import { selectedOpenShellGateway } from "./sandbox-observer";

function captured(status: number | null, stdout = "", stderr = "", error?: Error) {
  return { status, stdout, stderr, ...(error ? { error } : {}) };
}

// Native hosted inference allowlist shape (mirrors nemoclaw-openai-inference-v1).
// The checked-in boundary requires /usr/bin/curl; an older import on the gateway
// may carry the narrower list below (the lag surface of #13657).
const OPENAI_HOSTED_PROFILE = {
  id: "nemoclaw-openai-inference-v1",
  credentials: [
    {
      name: "api_key",
      env_vars: ["OPENAI_API_KEY"],
      required: true,
      auth_style: "bearer",
      header_name: "authorization",
      query_param: "",
    },
  ],
  endpoints: [
    {
      host: "api.openai.com",
      port: 443,
      protocol: "rest",
      enforcement: "enforce",
      rules: [
        { allow: { method: "GET", path: "/v1/models" } },
        { allow: { method: "POST", path: "/v1/chat/completions" } },
      ],
    },
  ],
  binaries: [
    "/usr/local/bin/node",
    "/usr/bin/node",
    "/usr/bin/python3",
    "/usr/bin/python3.13",
    "/opt/venv/bin/python3",
    "/usr/local/bin/curl",
    "/usr/bin/curl",
  ],
  inference_capable: true,
} as const;

const OPENAI_HOSTED_PROFILE_YAML = `
id: nemoclaw-openai-inference-v1
credentials:
  - name: api_key
    env_vars: [OPENAI_API_KEY]
    required: true
    auth_style: bearer
    header_name: authorization
    query_param: ''
endpoints:
  - host: api.openai.com
    port: 443
    protocol: rest
    enforcement: enforce
    rules:
      - allow: { method: GET, path: /v1/models }
      - allow: { method: POST, path: /v1/chat/completions }
binaries:
  - /usr/local/bin/node
  - /usr/bin/node
  - /usr/bin/python3
  - /usr/bin/python3.13
  - /opt/venv/bin/python3
  - /usr/local/bin/curl
  - /usr/bin/curl
inference_capable: true
`;

// The applied profile that lags the checked-in boundary: identical except it is
// missing the /usr/bin/curl entry the current allowlist requires.
const LAGGING_OPENAI_HOSTED_PROFILE = {
  ...OPENAI_HOSTED_PROFILE,
  binaries: OPENAI_HOSTED_PROFILE.binaries.filter((binary) => binary !== "/usr/bin/curl"),
} as const;

describe("checked-in provider profile import (#13657)", () => {
  it("refreshes an applied profile that lags the checked-in egress allowlist", () => {
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(captured(0, JSON.stringify(LAGGING_OPENAI_HOSTED_PROFILE)))
      .mockReturnValueOnce(captured(0))
      .mockReturnValueOnce(captured(0, JSON.stringify(OPENAI_HOSTED_PROFILE)));
    const adapter = createCliOpenShellProviderAdapter({
      run,
      readProfileFile: () => OPENAI_HOSTED_PROFILE_YAML,
    });

    expect(
      adapter.importProviderProfile({
        target: selectedOpenShellGateway(),
        profilePath: "/repo/nemoclaw-openai-inference-v1.yaml",
      }),
    ).toEqual({ ok: true });
    // The applied profile was missing /usr/bin/curl (the in-sandbox probe
    // binary), so the checked-in profile is re-applied to the gateway instead
    // of failing the import.
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "profile", "export", "nemoclaw-openai-inference-v1", "--output", "json"],
      [
        "provider",
        "profile",
        "update",
        "--file",
        "/repo/nemoclaw-openai-inference-v1.yaml",
        "nemoclaw-openai-inference-v1",
      ],
      ["provider", "profile", "export", "nemoclaw-openai-inference-v1", "--output", "json"],
    ]);
  });

  it("keeps failing closed when refreshing a lagging profile is refused", () => {
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(captured(0, JSON.stringify(LAGGING_OPENAI_HOSTED_PROFILE)))
      .mockReturnValueOnce(captured(1, "", "provider profile update failed"));
    const adapter = createCliOpenShellProviderAdapter({
      run,
      readProfileFile: () => OPENAI_HOSTED_PROFILE_YAML,
    });

    expect(
      adapter.importProviderProfile({
        target: selectedOpenShellGateway(),
        profilePath: "/repo/nemoclaw-openai-inference-v1.yaml",
      }),
    ).toEqual({
      ok: false,
      error: {
        kind: "command",
        reason: "profile_incompatible",
        message:
          "The applied OpenShell provider profile lags the checked-in boundary and its refresh was refused.",
      },
      operation: "verify",
    });
  });
});
