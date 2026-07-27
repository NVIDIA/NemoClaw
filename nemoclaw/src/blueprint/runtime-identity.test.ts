// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attachRuntimeIdentity,
  buildRuntimeIdentityPlan,
  compensateRuntimeIdentityApply,
  isRuntimeIdentityConfig,
  isRuntimeIdentityReceipt,
  parseRuntimeIdentityProviderMetadata,
  prepareRuntimeIdentity,
  removeRuntimeIdentity,
  resolveRuntimeIdentityProfilePath,
  type RuntimeIdentityCommandResult,
  type RuntimeIdentityConfig,
  type RuntimeIdentityDeps,
  type RuntimeIdentityReceipt,
} from "./runtime-identity.js";

const success: RuntimeIdentityCommandResult = { exitCode: 0, stdout: "", stderr: "" };
const missingProvider: RuntimeIdentityCommandResult = {
  exitCode: 1,
  stdout: "",
  stderr: "provider not found",
};
const matchingProvider = [
  "Name: acme-okta-runtime",
  "Type: okta-runtime-v1",
  "Credential keys: OKTA_ACCESS_TOKEN",
  "Config keys: <none>",
  "",
].join("\n");
const matchingProviderResult: RuntimeIdentityCommandResult = {
  exitCode: 0,
  stdout: matchingProvider,
  stderr: "",
};

const config: RuntimeIdentityConfig = {
  profile_path: "provider-profiles/okta-runtime-v1.yaml",
  provider_type: "okta-runtime-v1",
  provider_name: "acme-okta-runtime",
  credential_key: "OKTA_ACCESS_TOKEN",
  client_id_env: "OKTA_CLIENT_ID",
  refresh_token_env: "OKTA_REFRESH_TOKEN",
  client_secret_env: "OKTA_CLIENT_SECRET",
};

const createdReceipt: RuntimeIdentityReceipt = {
  provider_type: config.provider_type,
  provider_name: config.provider_name,
  credential_key: config.credential_key,
  provider_created: true,
  attachment_created: false,
};

function commandKey(args: string[]): string {
  return args.slice(1).join(" ");
}

describe("runtime identity contract", () => {
  let root: string;
  let profilePath: string;
  let calls: Array<{ args: string[]; env?: Record<string, string> }>;
  let responses: Map<string, RuntimeIdentityCommandResult[]>;
  let environment: NodeJS.ProcessEnv;
  let deps: RuntimeIdentityDeps;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nemoclaw-runtime-identity-"));
    mkdirSync(join(root, "provider-profiles"));
    profilePath = join(root, config.profile_path);
    writeFileSync(profilePath, "name: okta-runtime-v1\n");
    profilePath = realpathSync(profilePath);
    calls = [];
    responses = new Map();
    environment = {
      OKTA_CLIENT_ID: "client-id",
      OKTA_REFRESH_TOKEN: "refresh-secret",
      OKTA_CLIENT_SECRET: "client-secret",
    };
    deps = {
      run: async (args, options) => {
        calls.push({ args, env: options?.env });
        return responses.get(commandKey(args))?.shift() ?? success;
      },
      formatError: (output, secretValues = []) =>
        secretValues.reduce(
          (redacted, secret) => redacted.replaceAll(secret, secret.length > 0 ? "<redacted>" : ""),
          output,
        ),
      blueprintPath: root,
      env: environment,
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts a provider-neutral config and builds a non-secret plan", () => {
    expect(isRuntimeIdentityConfig(config)).toBe(true);
    expect(buildRuntimeIdentityPlan(config)).toEqual({
      provider_type: "okta-runtime-v1",
      provider_name: "acme-okta-runtime",
      credential_key: "OKTA_ACCESS_TOKEN",
    });
    expect(JSON.stringify(buildRuntimeIdentityPlan(config))).not.toContain("OKTA_CLIENT");
  });

  it.each([
    null,
    {},
    { ...config, okta: {} },
    { ...config, profile_path: "" },
    { ...config, provider_type: "Okta Runtime" },
    { ...config, provider_name: "../provider" },
    { ...config, credential_key: "lowercase" },
    { ...config, client_id_env: "1INVALID" },
    { ...config, refresh_token_env: config.client_id_env },
    { ...config, client_secret_env: config.refresh_token_env },
    { ...config, refresh_token_env: "NODE_OPTIONS" },
    { ...config, refresh_token_env: "MYTOKEN" },
    { ...config, client_secret_env: "OPENSHELL_CONFIG" },
  ])("rejects an invalid provider-neutral config: %j", (value) => {
    expect(isRuntimeIdentityConfig(value)).toBe(false);
  });

  it("validates exact ownership receipts", () => {
    expect(isRuntimeIdentityReceipt(createdReceipt)).toBe(true);
    expect(isRuntimeIdentityReceipt({ ...createdReceipt, provider_created: "yes" })).toBe(false);
    expect(isRuntimeIdentityReceipt({ ...createdReceipt, attachment_created: "yes" })).toBe(false);
    expect(isRuntimeIdentityReceipt({ ...createdReceipt, profile_path: config.profile_path })).toBe(
      false,
    );
  });

  it("parses bounded, ANSI-decorated provider metadata", () => {
    expect(
      parseRuntimeIdentityProviderMetadata(
        [
          "\u001b[32mName:\u001b[0m acme-okta-runtime",
          "Type: okta-runtime-v1",
          "Credential keys: OKTA_ACCESS_TOKEN",
          "Config keys: <none>",
        ].join("\n"),
      ),
    ).toEqual({
      name: "acme-okta-runtime",
      type: "okta-runtime-v1",
      credentialKeys: ["OKTA_ACCESS_TOKEN"],
      configKeys: [],
    });
  });

  it.each([
    "",
    `Name: ${"a".repeat(17 * 1024)}`,
    `${matchingProvider}Name: duplicate`,
    matchingProvider.replace("Name:", "Name:\u0001"),
    matchingProvider.replace("Type: okta-runtime-v1", "Type: INVALID TYPE"),
    matchingProvider.replace("Credential keys: OKTA_ACCESS_TOKEN", "Credential keys: bad"),
    matchingProvider.replace(
      "Credential keys: OKTA_ACCESS_TOKEN",
      "Credential keys: OKTA_ACCESS_TOKEN, OKTA_ACCESS_TOKEN",
    ),
    matchingProvider.replace("Config keys: <none>", "Config keys: BAD-KEY"),
  ])("rejects malformed provider metadata", (output) => {
    expect(parseRuntimeIdentityProviderMetadata(output)).toBeNull();
  });

  it("resolves a regular profile within the blueprint root", () => {
    expect(resolveRuntimeIdentityProfilePath(config.profile_path, root)).toBe(profilePath);
  });

  it.each([
    "/absolute-profile.yaml",
    "../outside-profile.yaml",
    "missing-profile.yaml",
  ])("rejects an unsafe or missing profile path: %s", (candidate) => {
    expect(() => resolveRuntimeIdentityProfilePath(candidate, root)).toThrow(
      /must (?:be relative|stay inside|name an existing file)/,
    );
  });

  it("rejects a directory and an outward symlink as profiles", () => {
    mkdirSync(join(root, "provider-profiles", "directory"));
    const outside = join(tmpdir(), `nemoclaw-outside-${Date.now()}.yaml`);
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(root, "provider-profiles", "outside.yaml"));

    expect(() => resolveRuntimeIdentityProfilePath("provider-profiles/directory", root)).toThrow(
      /regular file/,
    );
    expect(() => resolveRuntimeIdentityProfilePath("provider-profiles/outside.yaml", root)).toThrow(
      /stay inside/,
    );

    rmSync(outside, { force: true });
  });

  it("creates and configures a new provider without putting secrets in argv", async () => {
    responses.set("provider get acme-okta-runtime", [missingProvider]);

    await expect(prepareRuntimeIdentity(config, deps)).resolves.toEqual(createdReceipt);

    expect(calls.map(({ args }) => commandKey(args))).toEqual([
      `provider profile import --file ${profilePath}`,
      "provider get acme-okta-runtime",
      "provider create --name acme-okta-runtime --type okta-runtime-v1 --runtime-credentials",
      "provider refresh configure acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN --strategy oauth2-refresh-token --material client_id=client-id --secret-material-env refresh_token=OKTA_REFRESH_TOKEN --secret-material-env client_secret=OKTA_CLIENT_SECRET",
      "provider refresh rotate acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN",
    ]);
    expect(calls.flatMap(({ args }) => args)).not.toContain("refresh-secret");
    expect(calls.flatMap(({ args }) => args)).not.toContain("client-secret");
    expect(calls[3].env).toEqual({
      OKTA_REFRESH_TOKEN: "refresh-secret",
      OKTA_CLIENT_SECRET: "client-secret",
    });
  });

  it("reuses only an exactly matching non-secret provider binding", async () => {
    responses.set("provider get acme-okta-runtime", [matchingProviderResult]);

    await expect(prepareRuntimeIdentity(config, deps)).resolves.toEqual({
      ...createdReceipt,
      provider_created: false,
    });
    expect(calls.map(({ args }) => commandKey(args))).not.toContain(
      "provider create --name acme-okta-runtime --type okta-runtime-v1 --runtime-credentials",
    );
  });

  it("accepts an already imported profile", async () => {
    responses.set("provider profile import --file", []);
    responses.set(`provider profile import --file ${profilePath}`, [
      { exitCode: 1, stdout: "", stderr: "profile already exists" },
    ]);
    responses.set("provider get acme-okta-runtime", [matchingProviderResult]);

    await expect(prepareRuntimeIdentity(config, deps)).resolves.toMatchObject({
      provider_created: false,
    });
  });

  it("supports refresh without a client secret", async () => {
    const configWithoutSecret = { ...config, client_secret_env: undefined };
    responses.set("provider get acme-okta-runtime", [matchingProviderResult]);

    await expect(prepareRuntimeIdentity(configWithoutSecret, deps)).resolves.toMatchObject({
      provider_created: false,
    });
    expect(calls.at(-2)?.env).toEqual({ OKTA_REFRESH_TOKEN: "refresh-secret" });
  });

  it("fails when profile import is rejected", async () => {
    responses.set(`provider profile import --file ${profilePath}`, [
      { exitCode: 1, stdout: "", stderr: "invalid profile" },
    ]);

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(/invalid profile/);
    expect(calls).toHaveLength(1);
  });

  it("fails when a missing provider cannot be created", async () => {
    responses.set("provider get acme-okta-runtime", [missingProvider]);
    responses.set(
      "provider create --name acme-okta-runtime --type okta-runtime-v1 --runtime-credentials",
      [{ exitCode: 1, stdout: "", stderr: "create denied" }],
    );

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(/create denied/);
    expect(calls.map(({ args }) => commandKey(args))).not.toContain(
      expect.stringContaining("refresh configure"),
    );
  });

  it("fails before mutation when required local material is absent", async () => {
    delete environment.OKTA_REFRESH_TOKEN;

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(/OKTA_REFRESH_TOKEN/);
    expect(calls).toEqual([]);
  });

  it("revalidates typed configuration before spawning a child process", async () => {
    await expect(
      prepareRuntimeIdentity({ ...config, refresh_token_env: "NODE_OPTIONS" }, deps),
    ).rejects.toThrow(/configuration is invalid/);
    expect(calls).toEqual([]);
  });

  it("rejects an incompatible same-name provider before refresh", async () => {
    responses.set("provider get acme-okta-runtime", [
      {
        exitCode: 0,
        stdout: matchingProvider.replace("Type: okta-runtime-v1", "Type: different-type"),
        stderr: "",
      },
    ]);

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(/incompatible/);
    expect(calls.map(({ args }) => commandKey(args))).not.toContain(
      expect.stringContaining("refresh configure"),
    );
  });

  it("reports an unexpected inspection failure", async () => {
    responses.set("provider get acme-okta-runtime", [
      { exitCode: 2, stdout: "", stderr: "daemon unavailable" },
    ]);

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(
      /Failed to inspect runtime identity provider/,
    );
  });

  it("does not delete a reused provider when refresh fails", async () => {
    responses.set("provider get acme-okta-runtime", [matchingProviderResult]);
    responses.set(
      "provider refresh configure acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN --strategy oauth2-refresh-token --material client_id=client-id --secret-material-env refresh_token=OKTA_REFRESH_TOKEN --secret-material-env client_secret=OKTA_CLIENT_SECRET",
      [{ exitCode: 1, stdout: "", stderr: "rejected refresh-secret" }],
    );

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(/rejected <redacted>/);
    expect(calls.map(({ args }) => commandKey(args))).not.toContain(
      "provider delete acme-okta-runtime",
    );
  });

  it.each([
    [
      "provider refresh configure acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN --strategy oauth2-refresh-token --material client_id=client-id --secret-material-env refresh_token=OKTA_REFRESH_TOKEN --secret-material-env client_secret=OKTA_CLIENT_SECRET",
      "configure failed",
    ],
    [
      "provider refresh rotate acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN",
      "rotate failed",
    ],
  ])("deletes a newly created provider after %s fails", async (failedCommand, message) => {
    responses.set("provider get acme-okta-runtime", [missingProvider, matchingProviderResult]);
    responses.set(failedCommand, [{ exitCode: 1, stdout: "", stderr: message }]);

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(message);
    expect(calls.map(({ args }) => commandKey(args))).toContain(
      "provider delete acme-okta-runtime",
    );
  });

  it("reports cleanup failure after preparation fails", async () => {
    responses.set("provider get acme-okta-runtime", [missingProvider, matchingProviderResult]);
    responses.set("provider refresh rotate acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN", [
      { exitCode: 1, stdout: "", stderr: "rotate failed" },
    ]);
    responses.set("provider delete acme-okta-runtime", [
      { exitCode: 1, stdout: "", stderr: "delete failed" },
    ]);

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(
      /rotate failed[\s\S]*cleanup failed[\s\S]*delete failed/,
    );
  });

  it("does not delete a newly created provider when its binding changes before compensation", async () => {
    responses.set("provider get acme-okta-runtime", [
      missingProvider,
      {
        exitCode: 0,
        stdout: matchingProvider.replace(
          "Credential keys: OKTA_ACCESS_TOKEN",
          "Credential keys: DIFFERENT_TOKEN",
        ),
        stderr: "",
      },
    ]);
    responses.set("provider refresh rotate acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN", [
      { exitCode: 1, stdout: "", stderr: "rotate failed" },
    ]);

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(
      /cleanup failed[\s\S]*incompatible non-secret binding/,
    );
    expect(calls.map(({ args }) => commandKey(args))).not.toContain(
      "provider delete acme-okta-runtime",
    );
  });

  it("revalidates provider binding before attaching it", async () => {
    responses.set("provider get acme-okta-runtime", [matchingProviderResult]);

    await expect(attachRuntimeIdentity(createdReceipt, "sandbox", deps)).resolves.toBe(true);
    expect(calls.map(({ args }) => commandKey(args))).toEqual([
      "provider get acme-okta-runtime",
      "sandbox provider attach sandbox acme-okta-runtime",
    ]);
  });

  it("treats an existing attachment as reused", async () => {
    responses.set("provider get acme-okta-runtime", [matchingProviderResult]);
    responses.set("sandbox provider attach sandbox acme-okta-runtime", [
      { exitCode: 1, stdout: "", stderr: "already attached" },
    ]);

    await expect(attachRuntimeIdentity(createdReceipt, "sandbox", deps)).resolves.toBe(false);
  });

  it.each([
    [missingProvider, /disappeared before attach/],
    [
      {
        exitCode: 0,
        stdout: matchingProvider.replace(
          "Credential keys: OKTA_ACCESS_TOKEN",
          "Credential keys: OTHER",
        ),
        stderr: "",
      },
      /incompatible/,
    ],
  ])("refuses to attach an absent or rebound provider", async (providerResult, message) => {
    responses.set("provider get acme-okta-runtime", [providerResult]);

    await expect(attachRuntimeIdentity(createdReceipt, "sandbox", deps)).rejects.toThrow(message);
    expect(calls.map(({ args }) => commandKey(args))).not.toContain(
      "sandbox provider attach sandbox acme-okta-runtime",
    );
  });

  it("reports attach failures", async () => {
    responses.set("provider get acme-okta-runtime", [matchingProviderResult]);
    responses.set("sandbox provider attach sandbox acme-okta-runtime", [
      { exitCode: 1, stdout: "", stderr: "attach denied" },
    ]);

    await expect(attachRuntimeIdentity(createdReceipt, "sandbox", deps)).rejects.toThrow(
      /attach denied/,
    );
  });

  it("compensates only resources acquired by apply", async () => {
    responses.set("provider get acme-okta-runtime", [
      matchingProviderResult,
      matchingProviderResult,
    ]);

    await compensateRuntimeIdentityApply(
      { ...createdReceipt, attachment_created: true },
      "sandbox",
      deps,
    );
    expect(calls.map(({ args }) => commandKey(args))).toEqual([
      "provider get acme-okta-runtime",
      "sandbox provider detach sandbox acme-okta-runtime",
      "provider get acme-okta-runtime",
      "provider delete acme-okta-runtime",
    ]);
  });

  it("leaves reused attachment and provider ownership untouched during compensation", async () => {
    await compensateRuntimeIdentityApply(
      { ...createdReceipt, provider_created: false },
      "sandbox",
      deps,
    );

    expect(calls).toEqual([]);
  });

  it("detaches but does not delete a reused provider during explicit removal", async () => {
    responses.set("provider get acme-okta-runtime", [matchingProviderResult]);

    await removeRuntimeIdentity(
      { ...createdReceipt, provider_created: false, attachment_created: true },
      "sandbox",
      deps,
    );
    expect(calls.map(({ args }) => commandKey(args))).toEqual([
      "provider get acme-okta-runtime",
      "sandbox provider detach sandbox acme-okta-runtime",
    ]);
  });

  it("leaves a pre-existing attachment and provider untouched during explicit removal", async () => {
    await removeRuntimeIdentity(
      { ...createdReceipt, provider_created: false, attachment_created: false },
      "sandbox",
      deps,
    );

    expect(calls).toEqual([]);
  });

  it("tolerates an absent provider during explicit removal", async () => {
    responses.set("provider get acme-okta-runtime", [missingProvider, missingProvider]);

    await removeRuntimeIdentity({ ...createdReceipt, attachment_created: true }, "sandbox", deps);
    expect(calls.map(({ args }) => commandKey(args))).toEqual([
      "provider get acme-okta-runtime",
      "provider get acme-okta-runtime",
    ]);
  });

  it.each([
    ["sandbox provider detach sandbox acme-okta-runtime", "detach denied"],
    ["provider delete acme-okta-runtime", "delete denied"],
  ])("fails closed when cleanup command %s fails", async (failedCommand, message) => {
    responses.set("provider get acme-okta-runtime", [
      matchingProviderResult,
      matchingProviderResult,
    ]);
    responses.set(failedCommand, [{ exitCode: 1, stdout: "", stderr: message }]);

    await expect(
      removeRuntimeIdentity({ ...createdReceipt, attachment_created: true }, "sandbox", deps),
    ).rejects.toThrow(message);
  });
});
