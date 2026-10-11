// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createCliOpenShellProviderAdapter, type RunProviderCommand } from "./provider-adapter-cli";
import { namedOpenShellGateway } from "./sandbox-observer";

const PROFILE = {
  id: "test-profile",
  credentials: [
    {
      name: "token",
      env_vars: ["TEST_TOKEN"],
      required: true,
      auth_style: "header",
      header_name: "Authorization",
      query_param: "",
    },
  ],
  endpoints: [],
  binaries: [],
  inference_capable: false,
};
const PROFILE_YAML = `
id: test-profile
credentials:
  - name: token
    env_vars: [TEST_TOKEN]
    required: true
    auth_style: header
    header_name: Authorization
    query_param: ''
endpoints: []
binaries: []
inference_capable: false
`;
const TARGET = namedOpenShellGateway("nemoclaw");
const SECRET = "credential-value";
const PROFILE_EXPORT_ARGS = [
  "provider",
  "profile",
  "-g",
  "nemoclaw",
  "export",
  PROFILE.id,
  "--output",
  "json",
];

function captured(status: number | null, stdout = "", stderr = "", error?: Error) {
  return { status, stdout, stderr, ...(error ? { error } : {}) };
}

function createProviderRequest() {
  return {
    target: TARGET,
    name: "test-provider",
    type: PROFILE.id,
    credentials: [{ name: "TEST_TOKEN", value: SECRET }],
    config: [],
    fromExisting: false,
  };
}

describe("provider profile warnings after a binding mutation (#12940)", () => {
  it("warns on post-create drift without changing a successful result", async () => {
    const warn = vi.fn();
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(captured(0, JSON.stringify(PROFILE)))
      .mockReturnValueOnce(captured(0))
      .mockReturnValueOnce(captured(0, JSON.stringify({ ...PROFILE, binaries: ["/tmp/widened"] })));
    const adapter = createCliOpenShellProviderAdapter({
      run,
      warn,
      readProfileFile: () => PROFILE_YAML,
    });

    expect(
      adapter.importProviderProfile({ target: TARGET, profilePath: "/repo/profile.yaml" }),
    ).toEqual({ ok: true });
    await expect(adapter.createProvider(createProviderRequest())).resolves.toEqual({ ok: true });
    expect(run.mock.calls.map(([args]) => args[1])).toEqual(["profile", "create", "profile"]);
    expect(run.mock.calls[2]?.[0]).toEqual(PROFILE_EXPORT_ARGS);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain(
      "cannot confirm which definition was used at bind time",
    );
    expect(warn.mock.calls[0]?.[0]).not.toContain(SECRET);
  });

  it("does not warn when the post-create export matches the verified profile", async () => {
    const warn = vi.fn();
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(captured(0, JSON.stringify(PROFILE)))
      .mockReturnValueOnce(captured(0))
      .mockReturnValueOnce(captured(0, JSON.stringify(PROFILE)));
    const adapter = createCliOpenShellProviderAdapter({
      run,
      warn,
      readProfileFile: () => PROFILE_YAML,
    });

    expect(
      adapter.importProviderProfile({ target: TARGET, profilePath: "/repo/profile.yaml" }),
    ).toEqual({ ok: true });
    await expect(adapter.createProvider(createProviderRequest())).resolves.toEqual({ ok: true });
    expect(run.mock.calls[2]?.[0]).toEqual(PROFILE_EXPORT_ARGS);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when post-create export times out without changing a successful result", async () => {
    const warn = vi.fn();
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(captured(0, JSON.stringify(PROFILE)))
      .mockReturnValueOnce(captured(0))
      .mockReturnValueOnce(
        captured(null, "", SECRET, Object.assign(new Error(), { code: "ETIMEDOUT" })),
      );
    const adapter = createCliOpenShellProviderAdapter({
      run,
      warn,
      readProfileFile: () => PROFILE_YAML,
    });

    expect(
      adapter.importProviderProfile({ target: TARGET, profilePath: "/repo/profile.yaml" }),
    ).toEqual({ ok: true });
    await expect(adapter.createProvider(createProviderRequest())).resolves.toEqual({ ok: true });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("gateway operator");
    expect(warn.mock.calls[0]?.[0]).not.toContain(SECRET);
  });

  it("re-exports the verified profile after attach and warns on export failure", async () => {
    const warn = vi.fn();
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(captured(0, JSON.stringify(PROFILE)))
      .mockReturnValueOnce(captured(0))
      .mockReturnValueOnce(
        captured(
          0,
          "Name: test-provider\nType: test-profile\nCredential keys: TEST_TOKEN\nConfig keys: <none>",
        ),
      )
      .mockReturnValueOnce(captured(1, "", SECRET));
    const adapter = createCliOpenShellProviderAdapter({
      run,
      warn,
      readProfileFile: () => PROFILE_YAML,
    });

    expect(
      adapter.importProviderProfile({ target: TARGET, profilePath: "/repo/profile.yaml" }),
    ).toEqual({ ok: true });
    await expect(
      adapter.attachProvider({
        target: TARGET,
        sandboxName: "alpha",
        providerName: "test-provider",
      }),
    ).resolves.toEqual({ ok: true });
    expect(run.mock.calls.map(([args]) => args[0])).toEqual([
      "provider",
      "sandbox",
      "provider",
      "provider",
    ]);
    expect(run.mock.calls[3]?.[0]).toEqual(PROFILE_EXPORT_ARGS);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("gateway operator");
    expect(warn.mock.calls[0]?.[0]).not.toContain(SECRET);
  });

  it("does not warn when an attached generic provider has no verified profile", async () => {
    const warn = vi.fn();
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(captured(0, JSON.stringify(PROFILE)))
      .mockReturnValueOnce(captured(0))
      .mockReturnValueOnce(
        captured(
          0,
          "Name: test-provider\nType: generic\nCredential keys: TEST_TOKEN\nConfig keys: <none>",
        ),
      );
    const adapter = createCliOpenShellProviderAdapter({
      run,
      warn,
      readProfileFile: () => PROFILE_YAML,
    });

    expect(
      adapter.importProviderProfile({ target: TARGET, profilePath: "/repo/profile.yaml" }),
    ).toEqual({ ok: true });
    await expect(
      adapter.attachProvider({
        target: TARGET,
        sandboxName: "alpha",
        providerName: "test-provider",
      }),
    ).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when the attached provider cannot be inspected after a verified import", async () => {
    const warn = vi.fn();
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(captured(0, JSON.stringify(PROFILE)))
      .mockReturnValueOnce(captured(0))
      .mockReturnValueOnce(captured(1, "", SECRET));
    const adapter = createCliOpenShellProviderAdapter({
      run,
      warn,
      readProfileFile: () => PROFILE_YAML,
    });

    expect(
      adapter.importProviderProfile({ target: TARGET, profilePath: "/repo/profile.yaml" }),
    ).toEqual({ ok: true });
    await expect(
      adapter.attachProvider({
        target: TARGET,
        sandboxName: "alpha",
        providerName: "test-provider",
      }),
    ).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("did not complete");
    expect(warn.mock.calls[0]?.[0]).not.toContain(SECRET);
  });

  it("does not inspect or warn after attaching without a prior verified profile", async () => {
    const warn = vi.fn();
    const run = vi.fn<RunProviderCommand>().mockReturnValueOnce(captured(0));
    const adapter = createCliOpenShellProviderAdapter({ run, warn });

    await expect(
      adapter.attachProvider({
        target: TARGET,
        sandboxName: "alpha",
        providerName: "test-provider",
      }),
    ).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });
});
