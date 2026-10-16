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

describe("provider profile inspection and binding warnings (#12940, #13343)", () => {
  it.each([
    ["matching export", captured(0, JSON.stringify(PROFILE)), null],
    [
      "changed export",
      captured(0, JSON.stringify({ ...PROFILE, binaries: ["/tmp/widened"] })),
      "cannot confirm which definition was used at bind time",
    ],
    ["failed export", captured(1, "", SECRET), "did not complete"],
    [
      "timed-out export",
      captured(null, "", SECRET, Object.assign(new Error(), { code: "ETIMEDOUT" })),
      "did not complete",
    ],
    ["invalid export", captured(0, "not JSON"), "did not complete"],
  ])("checks a direct sandbox-create attachment after %s", (_case, after, warning) => {
    const warn = vi.fn();
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(captured(0, JSON.stringify(PROFILE)))
      .mockReturnValueOnce(after);
    const adapter = createCliOpenShellProviderAdapter({
      run,
      warn,
      readProfileFile: () => PROFILE_YAML,
    });

    expect(
      adapter.importProviderProfile({ target: TARGET, profilePath: "/repo/profile.yaml" }),
    ).toEqual({
      ok: true,
    });
    expect(() =>
      adapter.warnIfVerifiedProfilesChangedAfterSandboxCreate({ target: TARGET }, [
        PROFILE.id,
        PROFILE.id,
        "unowned-profile",
      ]),
    ).not.toThrow();
    expect(run.mock.calls[1]?.[0]).toEqual(PROFILE_EXPORT_ARGS);
    expect(run).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(warning ? 1 : 0);
    expect(warn.mock.calls[0]?.[0] ?? null).toEqual(
      warning ? expect.stringContaining(warning) : null,
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });

  it("does not claim verification for an unverified profile on sandbox create", () => {
    const warn = vi.fn();
    const run = vi.fn<RunProviderCommand>();
    const adapter = createCliOpenShellProviderAdapter({ run, warn });
    adapter.warnIfVerifiedProfilesChangedAfterSandboxCreate({ target: TARGET }, [PROFILE.id]);
    expect(run).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

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

  it("rejects registration credential names absent from the operator profile (#13343)", async () => {
    const run = vi.fn().mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        id: "custom-profile",
        credentials: [{ env_vars: ["OTHER_TOKEN"] }],
      }),
    });
    const adapter = createCliOpenShellProviderAdapter({ run });

    const result = await adapter.inspectProviderProfile({
      target: namedOpenShellGateway("nemoclaw"),
      profileType: "custom-profile",
      registrationCredentials: ["CUSTOM_TOKEN"],
    });

    expect(result).toMatchObject({ ok: false, error: { reason: "profile_incompatible" } });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toEqual([
      "provider",
      "profile",
      "-g",
      "nemoclaw",
      "export",
      "custom-profile",
      "--output",
      "json",
    ]);
  });

  it.each([
    ["changed", captured(0, JSON.stringify({ ...PROFILE, binaries: ["changed"] }))],
    ["unreadable", captured(1, "", SECRET)],
    ["invalid", captured(0, "not JSON")],
    ["timed out", captured(null, "", SECRET, Object.assign(new Error(), { code: "ETIMEDOUT" }))],
  ])(
    "preserves custom registration when post-create inspection is %s (#13343)",
    async (_case, after) => {
      const warn = vi.fn();
      const run = vi
        .fn<RunProviderCommand>()
        .mockReturnValueOnce(captured(0, JSON.stringify(PROFILE)))
        .mockReturnValueOnce(captured(0))
        .mockReturnValueOnce(after);
      const adapter = createCliOpenShellProviderAdapter({ run, warn });

      await expect(
        adapter.inspectProviderProfile({
          target: TARGET,
          profileType: PROFILE.id,
          registrationCredentials: ["TEST_TOKEN"],
        }),
      ).resolves.toEqual({ ok: true, value: { credentialKeys: ["TEST_TOKEN"] } });
      await expect(adapter.createProvider(createProviderRequest())).resolves.toEqual({ ok: true });
      expect(run.mock.calls.map(([args]) => args[1])).toEqual(["profile", "create", "profile"]);
      expect(run.mock.calls[2]?.[0]).toEqual(PROFILE_EXPORT_ARGS);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain("gateway operator");
      expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    },
  );

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
      defaultTimeoutMs: 120_000,
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
    expect(run.mock.calls[2]?.[1]).toMatchObject({ timeout: 30_000 });
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

  it("uses caller timeout and warns when post-attach lookup fails (#12940)", async () => {
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
      defaultTimeoutMs: 120_000,
    });

    expect(
      adapter.importProviderProfile({ target: TARGET, profilePath: "/repo/profile.yaml" }),
    ).toEqual({ ok: true });
    await expect(
      adapter.attachProvider({
        target: TARGET,
        sandboxName: "alpha",
        providerName: "test-provider",
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[2]?.[1]).toMatchObject({ timeout: 100 });
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
