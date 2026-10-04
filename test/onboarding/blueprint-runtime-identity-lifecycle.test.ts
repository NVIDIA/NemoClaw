// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attachRuntimeIdentity,
  mintRuntimeIdentityCredential,
  prepareRuntimeIdentity,
  type RuntimeIdentityCommandOptions,
  type RuntimeIdentityCommandResult,
  type RuntimeIdentityDeps,
  type RuntimeIdentityReceipt,
  removeRuntimeIdentity,
} from "../../nemoclaw/src/blueprint/runtime-identity.ts";

interface FakeOpenShellCall {
  args: string[];
  hasClientSecret: boolean;
  hasRefreshToken: boolean;
}

interface FakeOpenShellState {
  attachments: Record<string, string>;
  calls: FakeOpenShellCall[];
  profiles: string[];
  providers: Record<
    string,
    {
      configured: boolean;
      credentialKey: string;
      rotated: boolean;
      type: string;
    }
  >;
}

const CONFIG = {
  profile_path: "provider-profiles/okta-runtime-v1.yaml",
  provider_type: "okta-runtime-v1",
  provider_name: "e2e-okta-runtime",
  credential_key: "OKTA_ACCESS_TOKEN",
  client_id_env: "OKTA_CLIENT_ID",
  refresh_token_env: "OKTA_REFRESH_TOKEN",
  client_secret_env: "OKTA_CLIENT_SECRET",
} as const;

const INITIAL_STATE: FakeOpenShellState = {
  attachments: {},
  calls: [],
  profiles: [],
  providers: {},
};

function writeFakeOpenShell(scriptPath: string, statePath: string): void {
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");

const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "__test-state") {
  process.stdout.write(JSON.stringify(state));
  process.exit(0);
}
state.calls.push({
  args,
  hasClientSecret: Boolean(process.env.OKTA_CLIENT_SECRET),
  hasRefreshToken: Boolean(process.env.OKTA_REFRESH_TOKEN),
});

function save(exitCode, stdout = "", stderr = "") {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

if (args.join(" ") === "settings get --global --json") {
  save(0, JSON.stringify({
    scope: "global",
    settings_revision: 1,
    settings: { providers_v2_enabled: "true" },
  }));
}

if (args[0] === "provider" && args[1] === "get") {
  const name = args[2];
  const provider = state.providers[name];
  if (!provider) save(1, "", "provider not found");
  save(
    0,
    [
      "Name: " + name,
      "Type: " + provider.type,
      "Credential keys: " + provider.credentialKey,
      "Config keys: <none>",
      "",
    ].join("\\n"),
  );
}

if (args.join(" ").startsWith("provider profile import --file ")) {
  state.profiles.push("okta-runtime-v1");
  save(0);
}

if (args[0] === "provider" && args[1] === "create") {
  const name = args[args.indexOf("--name") + 1];
  const type = args[args.indexOf("--type") + 1];
  state.providers[name] = {
    configured: false,
    credentialKey: "OKTA_ACCESS_TOKEN",
    rotated: false,
    type,
  };
  save(0);
}

if (args[0] === "provider" && args[1] === "refresh" && args[2] === "configure") {
  if (!process.env.OKTA_REFRESH_TOKEN || !process.env.OKTA_CLIENT_SECRET) {
    save(2, "", "missing scoped refresh material");
  }
  state.providers[args[3]].configured = true;
  save(0);
}

if (args[0] === "provider" && args[1] === "refresh" && args[2] === "rotate") {
  state.providers[args[3]].rotated = true;
  save(0);
}

if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "attach") {
  state.attachments[args[3]] = args[4];
  save(0);
}

if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach") {
  delete state.attachments[args[3]];
  save(0);
}

if (args[0] === "provider" && args[1] === "delete") {
  delete state.providers[args[2]];
  save(0);
}

save(2, "", "unsupported fake openshell command: " + args.join(" "));
`,
  );
  chmodSync(scriptPath, 0o755);
}

async function readState(fakeOpenShell: string): Promise<FakeOpenShellState> {
  const result = await execa(fakeOpenShell, ["__test-state"]);
  return JSON.parse(result.stdout) as FakeOpenShellState;
}

describe("blueprint runtime identity lifecycle integration", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-identity-lifecycle-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("configures, attaches, mints, and removes only its owned provider through the command boundary", async () => {
    const profileDir = path.join(root, "provider-profiles");
    const profilePath = path.join(profileDir, "okta-runtime-v1.yaml");
    const statePath = path.join(root, "openshell-state.json");
    const fakeOpenShell = path.join(root, "openshell");
    mkdirSync(profileDir);
    copyFileSync(
      path.resolve("nemoclaw-blueprint/provider-profiles/okta-runtime-v1.yaml"),
      profilePath,
    );
    writeFileSync(statePath, JSON.stringify(INITIAL_STATE, null, 2));
    writeFakeOpenShell(fakeOpenShell, statePath);

    const environment = {
      OKTA_CLIENT_ID: "integration-client-id",
      OKTA_REFRESH_TOKEN: "integration-refresh-token",
      OKTA_CLIENT_SECRET: "integration-client-secret",
    };
    const persistedReceipts: RuntimeIdentityReceipt[] = [];
    const run = async (
      args: string[],
      options?: RuntimeIdentityCommandOptions,
    ): Promise<RuntimeIdentityCommandResult> => {
      const result = await execa(fakeOpenShell, args.slice(1), {
        env: {
          PATH: process.env.PATH ?? "",
          ...(options?.env ?? {}),
        },
        extendEnv: false,
        reject: false,
      });
      return {
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    };
    const deps: RuntimeIdentityDeps = {
      blueprintPath: root,
      env: environment,
      formatError: (output, secrets = []) =>
        secrets.reduce((redacted, secret) => redacted.replaceAll(secret, "<redacted>"), output),
      persistReceipt: (receipt) => persistedReceipts.push({ ...receipt }),
      run,
      // This test intentionally bypasses DNS validation and uses a fake OpenShell to isolate lifecycle orchestration.
      // TC-INF-12 separately proves the successful path through a real
      // OpenShell gateway, OAuth refresh exchange, provider attachment,
      // sandbox placeholder, bearer injection, rotation, and rollback.
      // A real-tenant Okta acceptance remains separate from that deterministic
      // standards-conformance proof.
      validateEndpointUrl: async () => ({ dnsResolved: false }),
    };

    const prepared = await prepareRuntimeIdentity(CONFIG, deps);
    const attachmentCreated = await attachRuntimeIdentity(prepared, "identity-sandbox", deps);
    const receipt = { ...prepared, attachment_created: attachmentCreated };
    await mintRuntimeIdentityCredential(receipt, deps);

    let state = await readState(fakeOpenShell);
    expect(receipt).toEqual({
      provider_type: "okta-runtime-v1",
      provider_name: "e2e-okta-runtime",
      credential_key: "OKTA_ACCESS_TOKEN",
      provider_created: true,
      attachment_created: true,
    });
    expect(persistedReceipts).toEqual([{ ...receipt, attachment_created: false }]);
    expect(state.profiles).toEqual(["okta-runtime-v1"]);
    expect(state.providers["e2e-okta-runtime"]).toMatchObject({
      configured: true,
      rotated: true,
      type: "okta-runtime-v1",
    });
    expect(state.attachments).toEqual({
      "identity-sandbox": "e2e-okta-runtime",
    });
    const rotateIndex = state.calls.findIndex(
      ({ args }) => args[0] === "provider" && args[1] === "refresh" && args[2] === "rotate",
    );
    const attachIndex = state.calls.findIndex(
      ({ args }) => args[0] === "sandbox" && args[1] === "provider" && args[2] === "attach",
    );
    expect(attachIndex).toBeGreaterThanOrEqual(0);
    expect(rotateIndex).toBeGreaterThan(attachIndex);

    const configureCall = state.calls.find(
      ({ args }) => args[0] === "provider" && args[1] === "refresh" && args[2] === "configure",
    );
    expect(configureCall).toMatchObject({
      hasClientSecret: true,
      hasRefreshToken: true,
    });
    expect(
      state.calls
        .filter(({ args }) => args[2] !== "configure")
        .every(({ hasClientSecret, hasRefreshToken }) => !hasClientSecret && !hasRefreshToken),
    ).toBe(true);
    expect(JSON.stringify(state.calls)).not.toContain(environment.OKTA_REFRESH_TOKEN);
    expect(JSON.stringify(state.calls)).not.toContain(environment.OKTA_CLIENT_SECRET);

    await removeRuntimeIdentity(receipt, "identity-sandbox", deps);

    state = await readState(fakeOpenShell);
    expect(state.attachments).toEqual({});
    expect(state.providers).toEqual({});
    expect(state.profiles).toEqual(["okta-runtime-v1"]);
  });
});
