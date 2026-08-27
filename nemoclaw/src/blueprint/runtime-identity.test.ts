// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attachRuntimeIdentity,
  buildRuntimeIdentityPlan,
  compensateRuntimeIdentityApply,
  isRuntimeIdentityConfig,
  isRuntimeIdentityReceipt,
  mintRuntimeIdentityCredential,
  parseRuntimeIdentityProviderMetadata,
  prepareRuntimeIdentity,
  type RuntimeIdentityCommandResult,
  type RuntimeIdentityConfig,
  type RuntimeIdentityDeps,
  type RuntimeIdentityReceipt,
  removeRuntimeIdentity,
  resolveRuntimeIdentityProfilePath,
} from "./runtime-identity.js";

const success: RuntimeIdentityCommandResult = { exitCode: 0, stdout: "", stderr: "" };
const providersV2Enabled: RuntimeIdentityCommandResult = {
  exitCode: 0,
  stdout: JSON.stringify({
    scope: "global",
    settings_revision: 1,
    settings: { providers_v2_enabled: "true" },
  }),
  stderr: "",
};
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
const configuredProviderResult: RuntimeIdentityCommandResult = {
  exitCode: 0,
  stdout: matchingProvider.replace("Credential keys: OKTA_ACCESS_TOKEN", "Credential keys: <none>"),
  stderr: "",
};
const configuredRefreshResult: RuntimeIdentityCommandResult = {
  exitCode: 0,
  stdout: [
    "PROVIDER                  CREDENTIAL_KEY                STRATEGY                      STATUS",
    "acme-okta-runtime        OKTA_ACCESS_TOKEN             oauth2_refresh_token          configured",
    "",
  ].join("\n"),
  stderr: "",
};
const profileDocument = [
  "id: okta-runtime-v1",
  "display_name: Okta Runtime Credentials v1",
  "description: Gateway-managed Okta access-token refresh for an attached sandbox",
  "category: agent",
  "credentials:",
  "  - name: OKTA_ACCESS_TOKEN",
  "    description: Short-lived Okta API access token",
  "    env_vars:",
  "      - OKTA_ACCESS_TOKEN",
  "    required: true",
  "    auth_style: bearer",
  "    header_name: authorization",
  "    refresh:",
  "      strategy: oauth2_refresh_token",
  "      token_url: https://example.okta.com/oauth2/default/v1/token",
  "      refresh_before_seconds: 300",
  "      max_lifetime_seconds: 3600",
  "      material:",
  "        - name: client_id",
  "          required: true",
  "        - name: refresh_token",
  "          required: true",
  "          secret: true",
  "        - name: client_secret",
  "          required: false",
  "          secret: true",
  "endpoints:",
  "  - host: api.example.okta.com",
  "    port: 443",
  "    protocol: rest",
  "    enforcement: enforce",
  "    rules:",
  '      - allow: { method: GET, path: "/**" }',
  "binaries:",
  "  - /usr/local/bin/node",
  "  - /usr/bin/node",
  "  - /usr/local/bin/curl",
  "  - /usr/bin/curl",
  "inference_capable: false",
  "",
].join("\n");
const entraProfileDocument = readFileSync(
  new URL("../../../nemoclaw-blueprint/provider-profiles/entra-runtime-v1.yaml", import.meta.url),
  "utf8",
);

const config: RuntimeIdentityConfig = {
  profile_path: "provider-profiles/okta-runtime-v1.yaml",
  provider_type: "okta-runtime-v1",
  provider_name: "acme-okta-runtime",
  credential_key: "OKTA_ACCESS_TOKEN",
  client_id_env: "OKTA_CLIENT_ID",
  refresh_token_env: "OKTA_REFRESH_TOKEN",
  client_secret_env: "OKTA_CLIENT_SECRET",
};
const entraConfig: RuntimeIdentityConfig = {
  profile_path: "provider-profiles/entra-runtime-v1.yaml",
  provider_type: "entra-runtime-v1",
  provider_name: "acme-entra-runtime",
  credential_key: "ENTRA_ACCESS_TOKEN",
  client_id_env: "ENTRA_CLIENT_ID",
  refresh_token_env: "ENTRA_REFRESH_TOKEN",
  client_secret_env: "ENTRA_CLIENT_SECRET",
};

const createdReceipt: RuntimeIdentityReceipt = {
  provider_type: config.provider_type,
  provider_name: config.provider_name,
  credential_key: config.credential_key,
  provider_created: true,
  attachment_created: false,
};

function commandKey(args: string[]): string {
  return args
    .slice(1)
    .join(" ")
    .replace(/^provider profile import --file .+$/u, "provider profile import --file");
}

describe("runtime identity contract", () => {
  let root: string;
  let profilePath: string;
  let calls: Array<{ args: string[]; env?: Record<string, string> }>;
  let responses: Map<string, RuntimeIdentityCommandResult[]>;
  let environment: NodeJS.ProcessEnv;
  let deps: RuntimeIdentityDeps;
  let validatedDestinations: string[];
  let persistedReceipts: RuntimeIdentityReceipt[];
  let importedProfilePaths: string[];
  let importedProfileSources: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nemoclaw-runtime-identity-"));
    mkdirSync(join(root, "provider-profiles"));
    profilePath = join(root, config.profile_path);
    writeFileSync(profilePath, profileDocument);
    profilePath = realpathSync(profilePath);
    calls = [];
    responses = new Map();
    responses.set("settings get --global --json", [providersV2Enabled]);
    validatedDestinations = [];
    persistedReceipts = [];
    importedProfilePaths = [];
    importedProfileSources = [];
    environment = {
      OKTA_CLIENT_ID: "client-id",
      OKTA_REFRESH_TOKEN: "refresh-secret",
      OKTA_CLIENT_SECRET: "client-secret",
    };
    deps = {
      run: async (args, options) => {
        calls.push({ args, env: options?.env });
        const captureCommand: Partial<Record<string, () => void>> = {
          "provider profile import --file": () => {
            importedProfilePaths.push(args[5]);
            importedProfileSources.push(readFileSync(args[5], "utf8"));
          },
        };
        captureCommand[commandKey(args)]?.();
        return responses.get(commandKey(args))?.shift() ?? success;
      },
      formatError: (output, secretValues = []) =>
        secretValues.reduce(
          (redacted, secret) => redacted.replaceAll(secret, secret.length > 0 ? "<redacted>" : ""),
          output,
        ),
      validateEndpointUrl: async (url) => {
        validatedDestinations.push(url);
        return { dnsResolved: false };
      },
      persistReceipt: (receipt) => {
        persistedReceipts.push({ ...receipt });
      },
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
    { ...config, client_id_env: "OTHER_ID" },
    { ...config, client_id_env: "AWS_SECRET_ACCESS_KEY" },
    { ...config, refresh_token_env: config.client_id_env },
    { ...config, client_secret_env: config.refresh_token_env },
    { ...config, refresh_token_env: "NODE_OPTIONS" },
    { ...config, refresh_token_env: "OPENSHELL_TOKEN" },
    { ...config, client_id_env: "XDG_CLIENT_ID" },
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

  it.each(["/absolute-profile.yaml", "../outside-profile.yaml", "missing-profile.yaml"])(
    "rejects an unsafe or missing profile path: %s",
    (candidate) => {
      expect(() => resolveRuntimeIdentityProfilePath(candidate, root)).toThrow(
        /must (?:be relative|stay inside|name an existing file)/,
      );
    },
  );

  it("rejects a directory and an outward symlink as profiles", () => {
    mkdirSync(join(root, "provider-profiles", "directory"));
    const outsideDir = mkdtempSync(join(tmpdir(), "nemoclaw-outside-"));
    const outside = join(outsideDir, "profile.yaml");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(root, "provider-profiles", "outside.yaml"));

    expect(() => resolveRuntimeIdentityProfilePath("provider-profiles/directory", root)).toThrow(
      /regular file/,
    );
    expect(() => resolveRuntimeIdentityProfilePath("provider-profiles/outside.yaml", root)).toThrow(
      /stay inside/,
    );

    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("creates and configures a new provider without putting secrets in argv", async () => {
    responses.set("provider get acme-okta-runtime", [missingProvider]);

    await expect(prepareRuntimeIdentity(config, deps)).resolves.toEqual(createdReceipt);

    expect(calls.map(({ args }) => commandKey(args))).toEqual([
      "settings get --global --json",
      "provider get acme-okta-runtime",
      "provider profile import --file",
      "provider create --name acme-okta-runtime --type okta-runtime-v1 --runtime-credentials",
      "provider refresh configure acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN --strategy oauth2-refresh-token --material client_id=client-id --secret-material-env refresh_token=OKTA_REFRESH_TOKEN --secret-material-env client_secret=OKTA_CLIENT_SECRET",
    ]);
    expect(calls.flatMap(({ args }) => args)).not.toContain("refresh-secret");
    expect(calls.flatMap(({ args }) => args)).not.toContain("client-secret");
    expect(
      calls.find(({ args }) => commandKey(args).startsWith("provider refresh configure"))?.env,
    ).toEqual({
      OKTA_REFRESH_TOKEN: "refresh-secret",
      OKTA_CLIENT_SECRET: "client-secret",
    });
    expect(validatedDestinations).toEqual([
      "https://example.okta.com/oauth2/default/v1/token",
      "https://api.example.okta.com/",
    ]);
    expect(importedProfileSources).toEqual([profileDocument]);
    expect(importedProfilePaths[0]).not.toBe(profilePath);
    expect(existsSync(importedProfilePaths[0])).toBe(false);
  });

  it("fails before identity mutation when provider-derived policy is disabled", async () => {
    responses.set("settings get --global --json", [
      {
        exitCode: 0,
        stdout: JSON.stringify({
          scope: "global",
          settings_revision: 0,
          settings: { providers_v2_enabled: "<unset>" },
        }),
        stderr: "",
      },
    ]);

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(
      /requires OpenShell global setting 'providers_v2_enabled=true'/,
    );
    expect(calls.map(({ args }) => commandKey(args))).toEqual(["settings get --global --json"]);
  });

  it("rejects a matching pre-existing provider before any mutable refresh operation", async () => {
    responses.set("provider get acme-okta-runtime", [matchingProviderResult]);

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(
      /cannot be safely reused.*prior refresh configuration cannot be restored/,
    );
    expect(calls.map(({ args }) => commandKey(args))).toEqual([
      "settings get --global --json",
      "provider get acme-okta-runtime",
    ]);
  });

  it("accepts an already imported profile", async () => {
    responses.set("provider get acme-okta-runtime", [missingProvider]);
    responses.set("provider profile import --file", [
      { exitCode: 1, stdout: "", stderr: "profile already exists" },
    ]);
    responses.set("provider profile export okta-runtime-v1 --output yaml", [
      { exitCode: 0, stdout: profileDocument, stderr: "" },
    ]);

    await expect(prepareRuntimeIdentity(config, deps)).resolves.toEqual(createdReceipt);
  });

  it("rejects an incompatible existing profile", async () => {
    responses.set("provider get acme-okta-runtime", [missingProvider]);
    responses.set("provider profile import --file", [
      { exitCode: 1, stdout: "", stderr: "profile already exists" },
    ]);
    responses.set("provider profile export okta-runtime-v1 --output yaml", [
      {
        exitCode: 0,
        stdout: profileDocument.replace("OKTA_ACCESS_TOKEN", "DIFFERENT_TOKEN"),
        stderr: "",
      },
    ]);

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(
      /profile 'okta-runtime-v1' exists with an incompatible binding/,
    );
    expect(calls.map(({ args }) => commandKey(args))).toContain("provider get acme-okta-runtime");
  });

  it("reports a failure to export an existing profile", async () => {
    responses.set("provider get acme-okta-runtime", [missingProvider]);
    responses.set("provider profile import --file", [
      { exitCode: 1, stdout: "", stderr: "profile already exists" },
    ]);
    responses.set("provider profile export okta-runtime-v1 --output yaml", [
      { exitCode: 1, stdout: "", stderr: "export denied" },
    ]);

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(/export denied/);
  });

  it.each([
    [profileDocument.replace("id: okta-runtime-v1", "id: another-profile"), /must declare id/],
    [
      profileDocument.replace("name: OKTA_ACCESS_TOKEN", "name: DIFFERENT_TOKEN"),
      /exactly one credential/,
    ],
    ["not: [valid", /not valid YAML/],
  ])("rejects an incompatible local profile", async (profile, message) => {
    writeFileSync(profilePath, profile);

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it.each([
    [
      profileDocument.replace("  - /usr/bin/curl\n", "  - /usr/bin/curl\n  - /bin/sh\n"),
      /reviewed executable allowlist/,
    ],
    [
      profileDocument.replace("    auth_style: bearer", "    auth_style: query"),
      /credential presentation policy/,
    ],
    [
      profileDocument.replace(
        '      - allow: { method: GET, path: "/**" }',
        '      - allow: { method: POST, path: "/admin/**" }',
      ),
      /credential-delivery policy/,
    ],
    [
      profileDocument.replace(
        "          secret: true\nendpoints:",
        "          secret: true\n        - name: audience\n          required: false\nendpoints:",
      ),
      /refresh material/,
    ],
    [
      `${profileDocument.trimEnd()}\ncredential_passthrough: true\n`,
      /unsupported top-level fields/,
    ],
  ])("rejects unreviewed credential-delivery policy before import", async (profile, message) => {
    writeFileSync(profilePath, profile);

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it("rejects a non-HTTPS refresh destination before import", async () => {
    writeFileSync(
      profilePath,
      profileDocument.replace("https://example.okta.com", "http://example.okta.com"),
    );

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(/must use HTTPS/);
    expect(calls).toEqual([]);
  });

  it("accepts DNS-backed destinations only after public-address validation", async () => {
    responses.set("provider get acme-okta-runtime", [missingProvider]);
    deps.validateEndpointUrl = async (url) => {
      validatedDestinations.push(url);
      return { dnsResolved: true };
    };

    await expect(prepareRuntimeIdentity(config, deps)).resolves.toEqual(createdReceipt);
    expect(validatedDestinations).toEqual([
      "https://example.okta.com/oauth2/default/v1/token",
      "https://api.example.okta.com/",
    ]);
    expect(calls.map(({ args }) => commandKey(args))).toContain("provider profile import --file");
  });

  it("accepts the bundled Entra profile and scopes bearer delivery to Graph me", async () => {
    writeFileSync(join(root, entraConfig.profile_path), entraProfileDocument);
    environment.ENTRA_CLIENT_ID = "entra-client-id";
    environment.ENTRA_REFRESH_TOKEN = "entra-refresh-secret";
    environment.ENTRA_CLIENT_SECRET = "entra-client-secret";
    responses.set("provider get acme-entra-runtime", [missingProvider]);

    await expect(prepareRuntimeIdentity(entraConfig, deps)).resolves.toMatchObject({
      provider_type: "entra-runtime-v1",
      provider_name: "acme-entra-runtime",
      credential_key: "ENTRA_ACCESS_TOKEN",
      provider_created: true,
    });

    expect(validatedDestinations).toEqual([
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
      "https://graph.microsoft.com/",
    ]);
    expect(calls.map(({ args }) => commandKey(args))).toContain(
      "provider refresh configure acme-entra-runtime --credential-key ENTRA_ACCESS_TOKEN " +
        "--strategy oauth2-refresh-token --material client_id=entra-client-id " +
        "--secret-material-env refresh_token=ENTRA_REFRESH_TOKEN " +
        "--secret-material-env client_secret=ENTRA_CLIENT_SECRET",
    );
    expect(importedProfilePaths).toHaveLength(1);
    expect(existsSync(importedProfilePaths[0])).toBe(false);
  });

  it.each([
    [
      "credential-delivery path",
      entraProfileDocument.replace(
        '      - allow: { method: GET, path: "/v1.0/me" }',
        '      - allow: { method: GET, path: "/**" }',
      ),
      /REST GET \/v1\.0\/me credential-delivery policy/,
    ],
    [
      "credential-delivery host",
      entraProfileDocument.replace("host: graph.microsoft.com", "host: login.microsoftonline.com"),
      /credential delivery host 'login\.microsoftonline\.com' is outside/,
    ],
    [
      "credential-delivery hostname suffix",
      entraProfileDocument.replace("graph.microsoft.com", "graph.microsoft.com.attacker.example"),
      /outside the trusted destination policy/,
    ],
    [
      "token-issuer host",
      entraProfileDocument.replace("login.microsoftonline.com", "graph.microsoft.com"),
      /refresh token_url host 'graph\.microsoft\.com' is outside/,
    ],
  ])(
    "rejects an Entra profile that changes the reviewed %s",
    async (_boundary, profile, message) => {
      writeFileSync(join(root, entraConfig.profile_path), profile);
      environment.ENTRA_CLIENT_ID = "entra-client-id";
      environment.ENTRA_REFRESH_TOKEN = "entra-refresh-secret";
      environment.ENTRA_CLIENT_SECRET = "entra-client-secret";

      await expect(prepareRuntimeIdentity(entraConfig, deps)).rejects.toThrow(message);
      expect(calls).toEqual([]);
    },
  );

  it("rejects DNS-backed destinations unless the reviewed profile policy owns DNS", async () => {
    deps.validateEndpointUrl = async () => ({ dnsResolved: true });

    await expect(
      prepareRuntimeIdentity(config, {
        ...deps,
        profilePolicy: {
          providerType: "okta-runtime-v1",
          clientIdEnvironmentName: "OKTA_CLIENT_ID",
          dnsResolution: "reject",
          tokenIssuer: {
            trustedHostnames: [],
            trustedHostSuffixes: ["okta.com"],
          },
          credentialDelivery: {
            method: "GET",
            path: "/**",
            trustedHostnames: [],
            trustedHostSuffixes: ["okta.com"],
          },
          trustedBinaries: [
            "/usr/local/bin/node",
            "/usr/bin/node",
            "/usr/local/bin/curl",
            "/usr/bin/curl",
          ],
        },
      }),
    ).rejects.toThrow(/outside the reviewed DNS policy/);
    expect(calls).toEqual([]);
  });

  it("admits the OAuth conformance profile only through an exact-host test policy", async () => {
    const conformanceConfig: RuntimeIdentityConfig = {
      ...config,
      profile_path: "provider-profiles/oauth2-runtime-conformance-v1.yaml",
      provider_type: "oauth2-runtime-conformance-v1",
      provider_name: "e2e-oauth-runtime",
      credential_key: "E2E_ACCESS_TOKEN",
      client_id_env: "E2E_CLIENT_ID",
      refresh_token_env: "E2E_REFRESH_TOKEN",
      client_secret_env: "E2E_CLIENT_SECRET",
    };
    const conformanceProfile = profileDocument
      .replace("id: okta-runtime-v1", "id: oauth2-runtime-conformance-v1")
      .replaceAll("OKTA_ACCESS_TOKEN", "E2E_ACCESS_TOKEN")
      .replace(
        "https://example.okta.com/oauth2/default/v1/token",
        "https://identity-fixture.trycloudflare.com/oauth/token",
      )
      .replace("api.example.okta.com", "identity-fixture.trycloudflare.com");
    writeFileSync(join(root, conformanceConfig.profile_path), conformanceProfile);
    environment.E2E_CLIENT_ID = "client-id";
    environment.E2E_REFRESH_TOKEN = "refresh-secret";
    environment.E2E_CLIENT_SECRET = "client-secret";
    responses.set("provider get e2e-oauth-runtime", [missingProvider]);

    await expect(prepareRuntimeIdentity(conformanceConfig, deps)).rejects.toThrow(
      /has no reviewed trust policy/,
    );
    expect(calls).toEqual([]);

    await expect(
      prepareRuntimeIdentity(conformanceConfig, {
        ...deps,
        profilePolicy: {
          providerType: "oauth2-runtime-conformance-v1",
          clientIdEnvironmentName: "E2E_CLIENT_ID",
          dnsResolution: "identity-platform-controlled",
          tokenIssuer: {
            trustedHostnames: ["identity-fixture.trycloudflare.com"],
            trustedHostSuffixes: [],
          },
          credentialDelivery: {
            method: "GET",
            path: "/**",
            trustedHostnames: ["identity-fixture.trycloudflare.com"],
            trustedHostSuffixes: [],
          },
          trustedBinaries: [
            "/usr/local/bin/node",
            "/usr/bin/node",
            "/usr/local/bin/curl",
            "/usr/bin/curl",
          ],
        },
      }),
    ).resolves.toMatchObject({
      provider_type: "oauth2-runtime-conformance-v1",
      provider_name: "e2e-oauth-runtime",
      credential_key: "E2E_ACCESS_TOKEN",
    });
    expect(validatedDestinations).toEqual([
      "https://identity-fixture.trycloudflare.com/oauth/token",
      "https://identity-fixture.trycloudflare.com/",
    ]);
  });

  it.each([
    ["loopback.example.okta.com", "loopback"],
    ["link-local.example.okta.com", "link-local"],
    ["private.example.okta.com", "private"],
    ["unresolved.example.okta.com", "unresolved"],
  ])("rejects an unsafe profile endpoint before import: %s", async (host, reason) => {
    writeFileSync(profilePath, profileDocument.replace("api.example.okta.com", host));
    deps.validateEndpointUrl = async (url) => {
      validatedDestinations.push(url);
      return url.includes(host)
        ? Promise.reject(new Error(`${reason} destination rejected`))
        : Promise.resolve({ dnsResolved: false });
    };

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(reason);
    expect(calls).toEqual([]);
  });

  it("rejects a profile destination outside the provider trust policy", async () => {
    writeFileSync(
      profilePath,
      profileDocument.replace("api.example.okta.com", "api.attacker.example"),
    );

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(
      /outside the trusted destination policy/,
    );
    expect(validatedDestinations).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([
    [
      profileDocument.replace(
        "token_url: https://example.okta.com/oauth2/default/v1/token",
        "token_url: https://user:password@example.okta.com/token",
      ),
      /must not include URL credentials/,
    ],
    [profileDocument.replace("    refresh:", "    no_refresh:"), /exactly one credential/],
    [
      profileDocument.replace(
        [
          "endpoints:",
          "  - host: api.example.okta.com",
          "    port: 443",
          "    protocol: rest",
          "    enforcement: enforce",
          "    rules:",
          '      - allow: { method: GET, path: "/**" }',
        ].join("\n"),
        "endpoints: []",
      ),
      /between 1 and 32 endpoints/,
    ],
    [
      profileDocument.replace(
        [
          "  - host: api.example.okta.com",
          "    port: 443",
          "    protocol: rest",
          "    enforcement: enforce",
          "    rules:",
          '      - allow: { method: GET, path: "/**" }',
        ].join("\n"),
        "  - invalid-endpoint",
      ),
      /endpoint 1 must be a mapping/,
    ],
    [profileDocument.replace("api.example.okta.com", "api.example.okta.com/path"), /valid host/],
    [profileDocument.replace("port: 443", "port: 0"), /valid port/],
    [
      profileDocument.replace("host: api.example.okta.com", 'host: "[api.example.okta.com"'),
      /valid host/,
    ],
  ])("rejects a malformed profile destination shape", async (profile, message) => {
    writeFileSync(profilePath, profile);

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it("supports refresh without a client secret", async () => {
    const configWithoutSecret = { ...config, client_secret_env: undefined };
    responses.set("provider get acme-okta-runtime", [missingProvider]);

    await expect(prepareRuntimeIdentity(configWithoutSecret, deps)).resolves.toEqual(
      createdReceipt,
    );
    expect(calls.at(-1)?.env).toEqual({ OKTA_REFRESH_TOKEN: "refresh-secret" });
  });

  it("imports the validated bytes when the original profile is replaced before import", async () => {
    responses.set("provider get acme-okta-runtime", [missingProvider]);
    const replacement = profileDocument.replace(
      "  - /usr/bin/curl\n",
      "  - /usr/bin/curl\n  - /bin/sh\n",
    );
    deps.validateEndpointUrl = async () => {
      writeFileSync(profilePath, replacement);
      return { dnsResolved: false };
    };

    await expect(prepareRuntimeIdentity(config, deps)).resolves.toEqual(createdReceipt);

    expect(readFileSync(profilePath, "utf8")).toBe(replacement);
    expect(importedProfileSources).toEqual([profileDocument]);
    expect(importedProfilePaths[0]).not.toBe(profilePath);
    expect(existsSync(importedProfilePaths[0])).toBe(false);
  });

  it("fails when profile import is rejected", async () => {
    responses.set("provider get acme-okta-runtime", [missingProvider]);
    responses.set("provider profile import --file", [
      { exitCode: 1, stdout: "", stderr: "invalid profile" },
    ]);

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(/invalid profile/);
    expect(calls.map(({ args }) => commandKey(args))).toEqual([
      "settings get --global --json",
      "provider get acme-okta-runtime",
      "provider profile import --file",
    ]);
  });

  it("fails when a missing provider cannot be created", async () => {
    responses.set("provider get acme-okta-runtime", [missingProvider]);
    responses.set(
      "provider create --name acme-okta-runtime --type okta-runtime-v1 --runtime-credentials",
      [{ exitCode: 1, stdout: "", stderr: "create denied" }],
    );

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(/create denied/);
    expect(calls.map(({ args }) => commandKey(args)).join("\n")).not.toContain("refresh configure");
  });

  it("fails before mutation when required local material is absent", async () => {
    delete environment.OKTA_REFRESH_TOKEN;

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(/OKTA_REFRESH_TOKEN/);
    expect(calls).toEqual([]);
  });

  it("rejects a client ID environment alias outside the reviewed profile policy", async () => {
    environment.AWS_CLIENT_ID = "selected-host-secret";

    await expect(
      prepareRuntimeIdentity({ ...config, client_id_env: "AWS_CLIENT_ID" }, deps),
    ).rejects.toThrow(/must be the reviewed non-secret name 'OKTA_CLIENT_ID'/);
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
    expect(calls.map(({ args }) => commandKey(args)).join("\n")).not.toContain("refresh configure");
  });

  it("reports an unexpected inspection failure", async () => {
    responses.set("provider get acme-okta-runtime", [
      { exitCode: 2, stdout: "", stderr: "daemon unavailable" },
    ]);

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(
      /Failed to inspect runtime identity provider/,
    );
  });

  it("leaves a matching pre-existing provider unchanged when apply preparation is rejected", async () => {
    responses.set("provider get acme-okta-runtime", [matchingProviderResult]);

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(/cannot be safely reused/);
    expect(calls.map(({ args }) => commandKey(args))).toEqual([
      "settings get --global --json",
      "provider get acme-okta-runtime",
    ]);
  });

  it("deletes a newly created provider after refresh configuration fails", async () => {
    responses.set("provider get acme-okta-runtime", [missingProvider, matchingProviderResult]);
    responses.set(
      "provider refresh configure acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN --strategy oauth2-refresh-token --material client_id=client-id --secret-material-env refresh_token=OKTA_REFRESH_TOKEN --secret-material-env client_secret=OKTA_CLIENT_SECRET",
      [{ exitCode: 1, stdout: "", stderr: "configure failed" }],
    );

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow("configure failed");
    expect(calls.map(({ args }) => commandKey(args))).toContain(
      "provider delete acme-okta-runtime",
    );
  });

  it("preserves a created provider when its ownership receipt is not durable (#9833)", async () => {
    responses.set("provider get acme-okta-runtime", [missingProvider]);
    deps.persistReceipt = () => {
      throw new Error("receipt persistence failed");
    };

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(
      "receipt persistence failed",
    );
    const commands = calls.map(({ args }) => commandKey(args));
    expect(commands).not.toContain("provider delete acme-okta-runtime");
    expect(commands.join("\n")).not.toContain("provider refresh configure");
  });

  it("redacts client ID and secret material from refresh configuration errors", async () => {
    responses.set("provider get acme-okta-runtime", [missingProvider, matchingProviderResult]);
    responses.set(
      "provider refresh configure acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN --strategy oauth2-refresh-token --material client_id=client-id --secret-material-env refresh_token=OKTA_REFRESH_TOKEN --secret-material-env client_secret=OKTA_CLIENT_SECRET",
      [
        {
          exitCode: 1,
          stdout: "",
          stderr: "configure failed for client-id refresh-secret client-secret",
        },
      ],
    );

    const error = await prepareRuntimeIdentity(config, deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "configure failed for <redacted> <redacted> <redacted>",
    );
    expect((error as Error).message).not.toMatch(/client-id|refresh-secret|client-secret/);
  });

  it("reports cleanup failure after preparation fails", async () => {
    responses.set("provider get acme-okta-runtime", [missingProvider, matchingProviderResult]);
    responses.set(
      "provider refresh configure acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN --strategy oauth2-refresh-token --material client_id=client-id --secret-material-env refresh_token=OKTA_REFRESH_TOKEN --secret-material-env client_secret=OKTA_CLIENT_SECRET",
      [{ exitCode: 1, stdout: "", stderr: "configure failed" }],
    );
    responses.set("provider delete acme-okta-runtime", [
      { exitCode: 1, stdout: "", stderr: "delete failed" },
    ]);

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(
      /configure failed[\s\S]*cleanup failed[\s\S]*delete failed/,
    );
    expect(persistedReceipts).toEqual([createdReceipt]);
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
    responses.set(
      "provider refresh configure acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN --strategy oauth2-refresh-token --material client_id=client-id --secret-material-env refresh_token=OKTA_REFRESH_TOKEN --secret-material-env client_secret=OKTA_CLIENT_SECRET",
      [{ exitCode: 1, stdout: "", stderr: "configure failed" }],
    );

    await expect(prepareRuntimeIdentity(config, deps)).rejects.toThrow(
      /cleanup failed[\s\S]*incompatible non-secret binding/,
    );
    expect(calls.map(({ args }) => commandKey(args))).not.toContain(
      "provider delete acme-okta-runtime",
    );
  });

  it("runs the initial runtime identity credential mint", async () => {
    await expect(mintRuntimeIdentityCredential(createdReceipt, deps)).resolves.toBeUndefined();

    expect(calls.map(({ args }) => commandKey(args))).toEqual([
      "provider refresh rotate acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN",
    ]);
  });

  it("reports an initial credential mint failure", async () => {
    responses.set("provider refresh rotate acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN", [
      { exitCode: 1, stdout: "", stderr: "rotate failed" },
    ]);

    await expect(mintRuntimeIdentityCredential(createdReceipt, deps)).rejects.toThrow(
      /Failed to mint runtime identity credential:\s+rotate failed/,
    );
  });

  it("revalidates provider binding before attaching it", async () => {
    responses.set("provider get acme-okta-runtime", [matchingProviderResult]);

    await expect(attachRuntimeIdentity(createdReceipt, "sandbox", deps)).resolves.toBe(true);
    expect(calls.map(({ args }) => commandKey(args))).toEqual([
      "settings get --global --json",
      "provider get acme-okta-runtime",
      "sandbox provider attach sandbox acme-okta-runtime",
    ]);
  });

  it("attaches a provider whose refresh is configured before its first mint", async () => {
    responses.set("provider get acme-okta-runtime", [configuredProviderResult]);
    responses.set("provider refresh status acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN", [
      configuredRefreshResult,
    ]);

    await expect(attachRuntimeIdentity(createdReceipt, "sandbox", deps)).resolves.toBe(true);
    expect(calls.map(({ args }) => commandKey(args))).toEqual([
      "settings get --global --json",
      "provider get acme-okta-runtime",
      "provider refresh status acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN",
      "sandbox provider attach sandbox acme-okta-runtime",
    ]);
  });

  it("rejects an empty provider without its configured refresh binding", async () => {
    responses.set("provider get acme-okta-runtime", [configuredProviderResult]);

    await expect(attachRuntimeIdentity(createdReceipt, "sandbox", deps)).rejects.toThrow(
      /incompatible non-secret refresh binding/,
    );
    expect(calls.map(({ args }) => commandKey(args))).not.toContain(
      "sandbox provider attach sandbox acme-okta-runtime",
    );
  });

  it("fails before attachment when provider-derived policy was disabled after preparation", async () => {
    responses.set("settings get --global --json", [
      {
        exitCode: 0,
        stdout: JSON.stringify({
          scope: "global",
          settings_revision: 2,
          settings: { providers_v2_enabled: "false" },
        }),
        stderr: "",
      },
    ]);

    await expect(attachRuntimeIdentity(createdReceipt, "sandbox", deps)).rejects.toThrow(
      /requires OpenShell global setting 'providers_v2_enabled=true'/,
    );
    expect(calls.map(({ args }) => commandKey(args))).toEqual(["settings get --global --json"]);
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
