// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  makeNetworkSimulatingFixture,
  makeWrapperFixture,
  runWrapper,
} from "./helpers/langchain-deepagents-code-image.ts";
import { CANONICAL_SECRET_POSITIVE_VECTORS } from "./helpers/langchain-deepagents-code-secret-patterns.ts";

function fakePrivateKeyBlock(type = "", newline = "\\n"): string {
  const label = type ? `${type} PRIVATE KEY-----` : "PRIVATE KEY-----";
  return `-----BEGIN ${label} ${newline}opaque-test-body${newline}-----END ${label}`;
}

describe("LangChain Deep Agents Code image credential boundary", () => {
  it("rejects runtime-injected secret-shaped env vars before dcode runs", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);

    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    const result = runWrapper(wrapperPath, ["-n", "hi"], { OPENAI_API_KEY: fakeSecret });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).not.toContain(fakeSecret);
    expect(result.stderr).toContain("nemoclaw credentials");
    expect(result.stdout).not.toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects secret-shaped values written to the deepagents env file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    const envFileBefore = `OPENAI_API_KEY=${fakeSecret}\n`;
    fs.writeFileSync(envFile, envFileBefore, "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).toContain(envFile);
    expect(result.stderr).not.toContain(fakeSecret);
    expect(result.stderr).toContain("nemoclaw credentials");
    expect(result.stdout).not.toContain("dcode-stub-ran");
    expect(fs.readFileSync(envFile, "utf8")).toBe(envFileBefore);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("allows only exact same-name OpenShell env placeholders in runtime and dotenv inputs", () => {
    const name = "GITHUB_MCP_TOKEN";
    const validPlaceholders = [
      `openshell:resolve:env:${name}`,
      `openshell:resolve:env:v0_${name}`,
      `openshell:resolve:env:v1442987827285932589_${name}`,
    ];

    for (const [index, placeholder] of validPlaceholders.entries()) {
      const runtimeDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `nemoclaw-dcode-placeholder-runtime-${index}-`),
      );
      const runtimeFixture = makeWrapperFixture(runtimeDir);
      const runtimeResult = runWrapper(runtimeFixture.wrapperPath, ["-n", "hi"], {
        [name]: placeholder,
      });
      expect(runtimeResult.status, placeholder).toBe(0);
      expect(runtimeResult.stdout).toContain("dcode-stub-ran");
      expect(fs.existsSync(runtimeFixture.ranMarker)).toBe(true);

      const dotenvDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `nemoclaw-dcode-placeholder-dotenv-${index}-`),
      );
      const dotenvFixture = makeWrapperFixture(dotenvDir);
      fs.writeFileSync(dotenvFixture.envFile, `${name}="${placeholder}"\n`, "utf8");
      const dotenvResult = runWrapper(dotenvFixture.wrapperPath, ["-n", "hi"], {});
      expect(dotenvResult.status, placeholder).toBe(0);
      expect(dotenvResult.stdout).toContain("dcode-stub-ran");
      expect(fs.existsSync(dotenvFixture.ranMarker)).toBe(true);
    }
  });

  it("rejects mismatched, malformed, wrapped, and raw credential placeholders", () => {
    const invalidCases = [
      { name: "MODEL_NAME", value: "openshell:resolve:env:OTHER_NAME" },
      { name: "MODEL_NAME", value: "openshell:resolve:env:v12_OTHER_NAME" },
      { name: "MODEL_NAME", value: "openshell:resolve:env:v_MODEL_NAME" },
      { name: "MODEL_NAME", value: "openshell:resolve:env:v12x_MODEL_NAME" },
      { name: "MODEL_NAME", value: "openshell:resolve:env:v12__MODEL_NAME" },
      { name: "MODEL_NAME", value: "Bearer openshell:resolve:env:MODEL_NAME" },
      { name: "MODEL_NAME", value: "openshell:resolve:env:MODEL_NAME:suffix" },
      { name: "MODEL-NAME", value: "openshell:resolve:env:MODEL-NAME" },
      { name: "OPENSHELL_TLS_KEY", value: "openshell:resolve:env:OPENSHELL_TLS_KEY" },
      { name: "OPENSHELL_TLS_KEY", value: "openshell:resolve:env:v12_OPENSHELL_TLS_KEY" },
      { name: "GITHUB_MCP_TOKEN", value: "opaqueRawCredentialValue12345" },
    ];

    for (const [index, { name, value }] of invalidCases.entries()) {
      const runtimeDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `nemoclaw-dcode-placeholder-invalid-runtime-${index}-`),
      );
      const runtimeFixture = makeWrapperFixture(runtimeDir);
      const runtimeResult = runWrapper(runtimeFixture.wrapperPath, ["-n", "hi"], {
        [name]: value,
      });
      expect(runtimeResult.status, `runtime accepted ${value}`).not.toBe(0);
      expect(runtimeResult.stderr).toContain(name);
      expect(runtimeResult.stderr).not.toContain(value);
      expect(fs.existsSync(runtimeFixture.ranMarker)).toBe(false);

      const dotenvDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `nemoclaw-dcode-placeholder-invalid-dotenv-${index}-`),
      );
      const dotenvFixture = makeWrapperFixture(dotenvDir);
      fs.writeFileSync(dotenvFixture.envFile, `${name}=${value}\n`, "utf8");
      const dotenvResult = runWrapper(dotenvFixture.wrapperPath, ["-n", "hi"], {});
      expect(dotenvResult.status, `dotenv accepted ${value}`).not.toBe(0);
      expect(dotenvResult.stderr).toContain(name);
      expect(dotenvResult.stderr).not.toContain(value);
      expect(fs.existsSync(dotenvFixture.ranMarker)).toBe(false);
    }
  });

  it("allows nemoclaw-managed messaging tokens whose values are intentionally credential-shaped", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);

    const result = runWrapper(wrapperPath, ["-n", "hi"], {
      SLACK_BOT_TOKEN: ["xoxb", "1234567890", "abcdefghij"].join("-"),
      SLACK_APP_TOKEN: ["xapp", "1", "A1B2C3", "1234567890", "abcdefghij"].join("-"),
      TELEGRAM_BOT_TOKEN: "123456789:AbcDefGhiJklMnoPqrStuVwxYz012345678",
      DISCORD_BOT_TOKEN: "ABCDEFGHIJKLMNOPQRSTUVWX.Abcdef.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(true);
  });

  it("rejects managed Slack runtime env vars that wrap non-Slack secret values", () => {
    const cases: Array<{ name: string; value: string }> = [
      { name: "SLACK_BOT_TOKEN", value: "xoxb-sk-abcdefghijklmnopqrstuvwx" },
      { name: "SLACK_APP_TOKEN", value: "xapp-ghp_abcdefghijklmnopqr" },
      { name: "SLACK_BOT_TOKEN", value: "xoxb-API_KEY=opaquevalue12345" },
      { name: "SLACK_APP_TOKEN", value: "xapp-TOKEN:opaquevalue12345" },
      { name: "SLACK_BOT_TOKEN", value: `xoxb-lsv2_pt_${"a".repeat(36)}_${"b".repeat(10)}` },
      { name: "SLACK_APP_TOKEN", value: `xapp-${fakePrivateKeyBlock()}` },
    ];

    for (const { name, value } of cases) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-slack-wrap-"));
      const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
      const result = runWrapper(wrapperPath, ["-n", "hi"], { [name]: value });

      expect(result.status, `${name} wrapping non-Slack secret not rejected`).not.toBe(0);
      expect(result.stderr).toContain(name);
      expect(result.stderr).not.toContain(value);
      expect(fs.existsSync(ranMarker)).toBe(false);
    }
  });

  it("rejects managed Slack env-file values that wrap non-Slack secret values", () => {
    const cases: Array<{ name: string; value: string }> = [
      { name: "SLACK_BOT_TOKEN", value: "xoxb-nvapi-abcdefghijklmnop" },
      { name: "SLACK_APP_TOKEN", value: "xapp-pypi-abcdefghijklmnop" },
      { name: "SLACK_BOT_TOKEN", value: "xoxb-PASSWORD opaquevalue12345" },
      { name: "SLACK_APP_TOKEN", value: "xapp-CREDENTIAL=opaquevalue12345" },
      { name: "SLACK_APP_TOKEN", value: `xapp-lsv2_sk_${"a".repeat(36)}_${"b".repeat(10)}` },
      { name: "SLACK_BOT_TOKEN", value: `xoxb-${fakePrivateKeyBlock("RSA")}` },
    ];

    for (const { name, value } of cases) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-slack-wrap-file-"));
      const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
      fs.writeFileSync(envFile, `${name}=${value}\n`, "utf8");
      const result = runWrapper(wrapperPath, ["-n", "hi"], {});

      expect(result.status, `${name} wrapping non-Slack secret not rejected`).not.toBe(0);
      expect(result.stderr).toContain(name);
      expect(result.stderr).toContain(envFile);
      expect(result.stderr).not.toContain(value);
      expect(fs.existsSync(ranMarker)).toBe(false);
    }
  });

  it.each([
    {
      label: "Telegram",
      name: "STRAY_TG_TOKEN",
      token: "987654321:AbcDefGhiJklMnoPqrStuVwxYz012345678",
    },
    {
      label: "Discord",
      name: "STRAY_DISCORD",
      token: "ABCDEFGHIJKLMNOPQRSTUVWX.Abcdef.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
    },
  ])("rejects unmanaged runtime env vars holding $label-shaped bot tokens", ({ name, token }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
    const result = runWrapper(wrapperPath, ["-n", "hi"], { [name]: token });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name);
    expect(result.stderr).not.toContain(token);
    expect(result.stdout).not.toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it.each([
    {
      label: "Telegram",
      name: "OTHER_BOT",
      token: "111222333:AbcDefGhiJklMnoPqrStuVwxYz012345678",
    },
    {
      label: "Discord",
      name: "STRAY_DISCORD_FILE",
      token: "ABCDEFGHIJKLMNOPQRSTUVWX.Abcdef.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
    },
  ])("rejects $label-shaped tokens written to the deepagents env file", ({ name, token }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    fs.writeFileSync(envFile, `${name}=${token}\n`, "utf8");
    const result = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name);
    expect(result.stderr).toContain(envFile);
    expect(result.stderr).not.toContain(token);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("does not bypass classification when env-file values have surrounding whitespace", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    fs.writeFileSync(envFile, `  OPENAI_API_KEY   =   ${fakeSecret}   \n`, "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).not.toContain(fakeSecret);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("recovers after the secret-bearing line is removed from the same env file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    const secretLine = `OPENAI_API_KEY=${fakeSecret}`;
    const cleanLine = "DISCORD_ALLOWED_USERS=alice,bob";
    fs.writeFileSync(envFile, [secretLine, cleanLine].join("\n") + "\n", "utf8");

    const rejected = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(rejected.status).not.toBe(0);
    expect(fs.existsSync(ranMarker)).toBe(false);

    const remaining = fs
      .readFileSync(envFile, "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("OPENAI_API_KEY="))
      .join("\n");
    fs.writeFileSync(envFile, remaining, "utf8");

    const recovered = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(recovered.status).toBe(0);
    expect(recovered.stdout).toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(true);
  });

  it("prevents the dcode entry path from running when a runtime secret is rejected", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);

    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    const result = runWrapper(wrapperPath, ["-n", "hi"], { OPENAI_API_KEY: fakeSecret });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(false);
    expect(fs.readFileSync(envFile, "utf8")).toBe("");
  });

  it("rejects a caller-supplied DEEPAGENTS_ENV_FILE override and scans only the hardcoded path", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    fs.writeFileSync(envFile, `OPENAI_API_KEY=${fakeSecret}\n`, "utf8");
    const decoy = path.join(tempDir, "decoy.env");
    fs.writeFileSync(decoy, "", "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], { DEEPAGENTS_ENV_FILE: decoy });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).toContain(envFile);
    expect(result.stderr).not.toContain(decoy);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("passes through when no secret-shaped value is present in env, env file, or auth store", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
    const { wrapperPath, ranMarker, envFile, authFile } = makeWrapperFixture(tempDir);
    fs.writeFileSync(
      envFile,
      ["# comment", "DISCORD_ALLOWED_USERS=alice,bob", "MODEL_NAME=gpt-4"].join("\n"),
      "utf8",
    );
    fs.writeFileSync(authFile, JSON.stringify({ version: 1, credentials: {} }), "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(true);
  });

  it("rejects stored Deep Agents Code credentials before dcode runs", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-auth-store-"));
    const { wrapperPath, ranMarker, authFile } = makeWrapperFixture(tempDir);
    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        version: 1,
        credentials: {
          langsmith: { type: "api_key", key: fakeSecret, added_at: "2026-06-30T00:00:00Z" },
        },
      }),
      "utf8",
    );

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("auth.json");
    expect(result.stderr).toContain("stored Deep Agents Code credentials");
    expect(result.stderr).not.toContain(fakeSecret);
    expect(result.stdout).not.toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it.each([
    { label: "malformed JSON", content: "{not valid json at all" },
    { label: "present but unreadable", content: '{"credentials": null}', unreadable: true },
  ])("refuses to launch when auth.json is $label (fail-closed)", ({ content, unreadable }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-auth-edge-"));
    const { wrapperPath, ranMarker, authFile } = makeWrapperFixture(tempDir);
    fs.writeFileSync(authFile, content, "utf8");
    fs.chmodSync(authFile, unreadable ? 0o000 : 0o644);
    const result = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("auth.json");
    expect(result.stderr).toContain("stored Deep Agents Code credentials");
    expect(result.stdout).not.toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(false);
    fs.chmodSync(authFile, 0o644);
  });

  it("allows launch when auth.json is absent (fresh sandbox)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-auth-absent-"));
    const { wrapperPath, ranMarker, authFile } = makeWrapperFixture(tempDir);
    expect(fs.existsSync(authFile)).toBe(false);
    const result = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(true);
  });

  it("rejects the separate ChatGPT OAuth token store before dcode runs", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-codex-auth-"));
    const { wrapperPath, ranMarker, codexAuthFile } = makeWrapperFixture(tempDir);
    fs.writeFileSync(codexAuthFile, "{}", "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("chatgpt-auth.json");
    expect(result.stderr).toContain("stored Deep Agents Code credentials");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it.each([
    { args: ["update"], posture: "dependency update posture" },
    { args: ["install", "anthropic"], posture: "dependency update posture" },
    { args: ["auth", "set", "langsmith"], posture: "credential posture" },
    { args: ["tools", "install"], posture: "managed tool set posture" },
    { args: ["tools", "add"], posture: "managed tool set posture" },
    { args: ["mcp"], posture: "MCP posture" },
  ])("rejects upstream managed-mutation command $args", ({ args, posture }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-command-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);

    const result = runWrapper(wrapperPath, args, {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(posture);
    expect(result.stdout).not.toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it.each([
    ["--update"],
    ["--upd"],
    ["--auto-update"],
    ["--auto-upd"],
    ["--install", "nvidia"],
    ["--install=nvidia"],
    ["--inst", "nvidia"],
    ["--install", "provider-package", "--package", "--yes"],
  ])("rejects upstream global mutation flags before dcode runs: %s", (...args) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-global-flag-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);

    const result = runWrapper(wrapperPath, args, {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("dependency update posture");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it.each([
    { args: ["tools", "list"] },
    { args: ["tools", "--help"] },
    { args: ["tools"] },
  ])("passes through read-only tools subcommand $args", ({ args }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-tools-readonly-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);

    const result = runWrapper(wrapperPath, args, {});

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dcode-stub-ran");
    expect(fs.existsSync(ranMarker)).toBe(true);
  });

  it("rejects non-messaging secret shapes carried by managed runtime env names", () => {
    const cases: Array<{ name: string; sample: string }> = [
      { name: "SLACK_BOT_TOKEN", sample: "sk-abcdefghijklmnopqrstuvwx" },
      { name: "SLACK_APP_TOKEN", sample: "ghp_abcdefghijklmnopqr" },
      { name: "TELEGRAM_BOT_TOKEN", sample: "ghp_abcdefghijklmnopqr" },
      { name: "DISCORD_BOT_TOKEN", sample: ["AK", "IAABCDEFGHIJKLMNOP"].join("") },
    ];
    for (const { name, sample } of cases) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-mgmix-"));
      const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
      const result = runWrapper(wrapperPath, ["-n", "hi"], { [name]: sample });
      expect(result.status, `${name} carrying non-platform secret not rejected`).not.toBe(0);
      expect(result.stderr).toContain(name);
      expect(result.stderr).not.toContain(sample);
      expect(fs.existsSync(ranMarker)).toBe(false);
    }
  });

  it("rejects non-messaging secret shapes carried by managed env-file names", () => {
    const cases: Array<{ name: string; sample: string }> = [
      { name: "SLACK_BOT_TOKEN", sample: "sk-abcdefghijklmnopqrstuvwx" },
      { name: "TELEGRAM_BOT_TOKEN", sample: "nvapi-abcdefghijklmnop" },
      { name: "DISCORD_BOT_TOKEN", sample: "hf_abcdefghijklmnopq" },
    ];
    for (const { name, sample } of cases) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-mgfile-"));
      const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
      fs.writeFileSync(envFile, `${name}=${sample}\n`, "utf8");
      const result = runWrapper(wrapperPath, ["-n", "hi"], {});
      expect(result.status, `${name} carrying non-platform secret not rejected`).not.toBe(0);
      expect(result.stderr).toContain(name);
      expect(result.stderr).toContain(envFile);
      expect(result.stderr).not.toContain(sample);
      expect(fs.existsSync(ranMarker)).toBe(false);
    }
  });

  it("emits no NET:OPEN, inference.local, or pypi.org log entries when a runtime secret triggers rejection", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-netlog-"));
    const { wrapperPath, networkLog } = makeNetworkSimulatingFixture(tempDir);
    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    const result = runWrapper(wrapperPath, ["-n", "hi"], { OPENAI_API_KEY: fakeSecret });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(networkLog)).toBe(false);
    expect(result.stderr).not.toContain("NET:OPEN");
    expect(result.stderr).not.toContain("inference.local");
    expect(result.stderr).not.toContain("pypi.org");
  });

  it("emits no NET:OPEN, inference.local, or pypi.org log entries when an env-file secret triggers rejection", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-netlog-env-"));
    const { wrapperPath, networkLog, envFile } = makeNetworkSimulatingFixture(tempDir);
    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";
    fs.writeFileSync(envFile, `OPENAI_API_KEY=${fakeSecret}\n`, "utf8");
    const result = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(networkLog)).toBe(false);
    expect(result.stderr).not.toContain("NET:OPEN");
    expect(result.stderr).not.toContain("inference.local");
    expect(result.stderr).not.toContain("pypi.org");
  });

  it("rejects bearer-wrapped opaque secret values without a recognized token prefix", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-bearer-opaque-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
    const opaque = "opaqueRandomSessionTokenZ1234567890";

    const result = runWrapper(wrapperPath, ["-n", "hi"], {
      CUSTOM_HEADER: `Bearer ${opaque}`,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CUSTOM_HEADER");
    expect(result.stderr).not.toContain(opaque);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects credential-name-context runtime env values with opaque payloads", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-namectx-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
    const opaque = "opaqueOpenAiCustomKeyMarker12345";

    const result = runWrapper(wrapperPath, ["-n", "hi"], {
      OPENAI_API_KEY: opaque,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).not.toContain(opaque);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects credential-name-context env-file entries with opaque payloads", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-namectx-file-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    const opaque = "opaqueOpenAiCustomKeyMarker12345";
    fs.writeFileSync(envFile, `OPENAI_API_KEY=${opaque}\n`, "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).toContain(envFile);
    expect(result.stderr).not.toContain(opaque);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it.each([
    { label: "opaque credential-name", value: "opaqueCredentialPayloadZ1234567890" },
    { label: "token-prefix", value: "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000" },
  ])("rejects export-prefixed env-file entries that carry $label secrets", ({ value }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-export-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    fs.writeFileSync(envFile, `export OPENAI_API_KEY=${value}\n`, "utf8");
    const result = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI_API_KEY");
    expect(result.stderr).toContain(envFile);
    expect(result.stderr).not.toContain(value);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects lower-case credential-name-context env vars to mirror canonical case-insensitive matching", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-namectx-lower-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
    const opaque = "opaqueLowerCasedCredentialPayload";

    const result = runWrapper(wrapperPath, ["-n", "hi"], {
      openai_api_key: opaque,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("openai_api_key");
    expect(result.stderr).not.toContain(opaque);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects mixed-case credential-name-context env-file entries", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-namectx-file-case-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    const opaque = "opaqueMixedCaseCredentialMarker12345";
    fs.writeFileSync(envFile, `LangSmith_Token=${opaque}\n`, "utf8");

    const result = runWrapper(wrapperPath, ["-n", "hi"], {});

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LangSmith_Token");
    expect(result.stderr).toContain(envFile);
    expect(result.stderr).not.toContain(opaque);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects exact canonical credential names KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL with opaque payloads", () => {
    const cases: string[] = ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "API_KEY"];
    const opaque = "opaqueCredentialPayloadZ1234567890";
    for (const name of cases) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-dcode-exactctx-${name}-`));
      const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
      const result = runWrapper(wrapperPath, ["-n", "hi"], { [name]: opaque });
      expect(result.status, `${name} with opaque value not rejected`).not.toBe(0);
      expect(result.stderr).toContain(name);
      expect(result.stderr).not.toContain(opaque);
      expect(fs.existsSync(ranMarker)).toBe(false);
    }
  });

  it.each([
    { label: "variable expansion", content: "MY_CRED=$OTHER_SECRET" },
    { label: "command substitution", content: "MY_CRED=$(whoami)" },
    { label: "backtick substitution", content: "MY_CRED=`whoami`" },
  ])("rejects dotenv $label in env-file entries", ({ content }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-dynamic-"));
    const { wrapperPath, ranMarker, envFile } = makeWrapperFixture(tempDir);
    fs.writeFileSync(envFile, `${content}\n`, "utf8");
    const result = runWrapper(wrapperPath, ["-n", "hi"], {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MY_CRED");
    expect(result.stderr).toContain("dynamic value");
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it.each([
    { label: "bearer-wrapped", name: "CUSTOM_HEADER", value: (s: string) => `Bearer ${s}` },
    { label: "embedded", name: "EMBEDDED_HOST_HEADER", value: (s: string) => `prefix-${s}` },
  ])("rejects $label secret values carried in runtime env vars", ({ name, value }) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-secret-wrap-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
    const fakeSecret = "sk-abcdefghijklmnopqrstuvwx";
    const result = runWrapper(wrapperPath, ["-n", "hi"], { [name]: value(fakeSecret) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name);
    expect(result.stderr).not.toContain(fakeSecret);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects secret-shaped runtime env values whose names are not valid shell identifiers", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-rawenv-"));
    const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
    const fakeSecret = "sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000";

    const result = spawnSync(
      "env",
      [
        "-i",
        `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
        `OPENAI-API-KEY=${fakeSecret}`,
        "bash",
        wrapperPath,
        "-n",
        "hi",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENAI-API-KEY");
    expect(result.stderr).not.toContain(fakeSecret);
    expect(fs.existsSync(ranMarker)).toBe(false);
  });

  it("rejects the canonical positive secret corpus before dcode starts (#6195)", () => {
    for (const { label, value } of CANONICAL_SECRET_POSITIVE_VECTORS) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-dcode-parity-${label}-`));
      try {
        const { wrapperPath, ranMarker } = makeWrapperFixture(tempDir);
        const varName = `NEMOCLAW_PARITY_${label.toUpperCase()}`;
        const result = runWrapper(wrapperPath, ["-n", "hi"], { [varName]: value });
        expect(result.status, `${label} via runtime env not rejected`).not.toBe(0);
        expect(result.stderr).toContain(varName);
        expect(result.stderr).not.toContain(value);
        expect(fs.existsSync(ranMarker)).toBe(false);
      } finally {
        fs.rmSync(tempDir, { force: true, recursive: true });
      }
    }
  });
});
