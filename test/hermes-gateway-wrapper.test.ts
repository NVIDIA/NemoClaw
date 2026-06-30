// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Coverage for the hermes CLI wrapper (agents/hermes/hermes-wrapper.sh), which
// closes the #4975 bypass: `docker exec ... hermes gateway run` must enforce the
// same runtime-env secret boundary as the nemoclaw-start entrypoint, refusing
// raw secret-shaped env vars and never reaching the real gateway.
//
// Linux + python3 gated: the wrapper uses bash `exec` and invokes python3 (the
// shared validator). CI runs on Linux with python3 available, so the suite
// runs every PR; the gate exists so a maintainer cloning on macOS or Windows
// does not see a spurious red on `npm test`. See `.github/workflows/` for the
// canonical CI runner image.

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildHermesConfig } from "../agents/hermes/config/hermes-config.ts";
import { buildOpenshellExecArgs } from "../src/lib/actions/sandbox/exec.ts";

const WRAPPER = path.join(import.meta.dirname, "..", "agents", "hermes", "hermes-wrapper.sh");
const VALIDATOR = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "validate-env-secret-boundary.py",
);

function python3Available(): boolean {
  try {
    return spawnSync("python3", ["--version"], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}
const canRun = process.platform === "linux" && python3Available();
// Surface a hard error in CI when the prerequisites are missing instead of
// silently skipping — a green CI run that never executed any wrapper test
// would mask regressions in the security boundary.
assert(
  !process.env.CI || canRun,
  "Hermes wrapper integration tests require Linux + python3; CI environment did not meet both prerequisites",
);

type WrapperRun = {
  status: number | null;
  stdout: string;
  stderr: string;
  realInvoked: boolean;
  realArgs: string;
};

type StubBehaviour = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

// Run the wrapper against a temp install: a copy of the wrapper alongside the
// real validator and a `hermes.real` stub. The wrapper's dev fallback resolves
// both from its own directory because the /usr/local install paths are absent.
// The stub records the args it was exec'd with so we can prove pass-through vs.
// refusal. `env` fully replaces the process env so CI-injected secret-shaped
// vars (e.g. GITHUB_TOKEN) cannot perturb the validator.
function runWrapper(
  args: string[],
  env: Record<string, string>,
  opts: {
    shadowPython?: boolean;
    shadowHelpers?: Record<string, string>;
    stub?: StubBehaviour;
    validatorScript?: string;
  } = {},
): WrapperRun {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-"));
  try {
    fs.copyFileSync(WRAPPER, path.join(dir, "hermes"));
    const validatorContent = opts.validatorScript ?? fs.readFileSync(VALIDATOR, "utf-8");
    fs.writeFileSync(path.join(dir, "validate-env-secret-boundary.py"), validatorContent, {
      mode: 0o755,
    });
    fs.chmodSync(path.join(dir, "hermes"), 0o755);

    const marker = path.join(dir, "real-invoked.txt");
    const stubStdout = opts.stub?.stdout ?? "";
    const stubStderr = opts.stub?.stderr ?? "";
    const stubExit = opts.stub?.exitCode ?? 0;
    const stubScript = [
      "#!/usr/bin/env bash",
      `printf '%s' "$*" > ${JSON.stringify(marker)}`,
      stubStdout ? `cat <<'__NEMOCLAW_STUB_EOF__'\n${stubStdout}\n__NEMOCLAW_STUB_EOF__` : "",
      stubStderr
        ? `cat <<'__NEMOCLAW_STUB_ERR_EOF__' >&2\n${stubStderr}\n__NEMOCLAW_STUB_ERR_EOF__`
        : "",
      `exit ${stubExit}`,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "hermes.real"), stubScript, { mode: 0o755 });

    // Optionally plant malicious helpers earlier on PATH that would subvert the
    // wrapper. The wrapper must ignore them and resolve each helper from a
    // trusted absolute path. `shadowPython` covers the python3 interpreter;
    // `shadowHelpers` lets a test plant arbitrary scripts (e.g. mktemp / rm).
    const planted: Record<string, string> = {
      ...(opts.shadowHelpers ?? {}),
      ...(opts.shadowPython ? { python3: "#!/usr/bin/env bash\nexit 0\n" } : {}),
    };
    let pathPrefix = "";
    if (Object.keys(planted).length > 0) {
      const evilBin = path.join(dir, "evil-bin");
      fs.mkdirSync(evilBin);
      for (const [name, script] of Object.entries(planted)) {
        fs.writeFileSync(path.join(evilBin, name), script, { mode: 0o755 });
      }
      pathPrefix = `${evilBin}${path.delimiter}`;
    }

    const result = spawnSync("bash", [path.join(dir, "hermes"), ...args], {
      encoding: "utf-8",
      timeout: 10000,
      env: { PATH: `${pathPrefix}${process.env.PATH ?? ""}`, HOME: dir, ...env },
    });

    const realInvoked = fs.existsSync(marker);
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      realInvoked,
      realArgs: realInvoked ? fs.readFileSync(marker, "utf-8") : "",
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!canRun)("agents/hermes/hermes-wrapper.sh", () => {
  it("refuses `gateway` with a raw secret-shaped env var and never starts the gateway (#4975)", () => {
    const run = runWrapper(["gateway", "run"], { SLACK_BOT_TOKEN: "xoxb-real-1234567890" });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("[SECURITY]");
    expect(run.stderr).toContain("process environment");
    expect(run.stderr).toContain("SLACK_BOT_TOKEN");
    expect(run.stderr).not.toContain("xoxb-real-1234567890");
    expect(run.realInvoked).toBe(false);
  });

  it("cannot be bypassed by shadowing python3 on PATH after review (#4981)", () => {
    // PATH is part of the untrusted env; a planted python3 that exits 0 must not
    // let the gateway start with a raw secret. The wrapper uses a trusted
    // absolute interpreter, so the guard still refuses.
    const run = runWrapper(
      ["gateway", "run"],
      { SLACK_BOT_TOKEN: "xoxb-real-1234567890" },
      { shadowPython: true },
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("[SECURITY]");
    expect(run.realInvoked).toBe(false);
  });

  it("allows `gateway` when only resolver placeholders / allow-listed keys are present", () => {
    const run = runWrapper(["gateway", "run"], {
      SLACK_BOT_TOKEN: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
      TELEGRAM_BOT_TOKEN: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
      OPENCLAW_GATEWAY_TOKEN: "raw-gateway-token",
    });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("gateway run");
  });

  it("passes non-gateway subcommands straight through, even with raw secrets present", () => {
    // The guard scopes to gateway startup; other subcommands must not be blocked.
    const run = runWrapper(["dashboard"], { SLACK_BOT_TOKEN: "xoxb-real-1234567890" });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("dashboard");
  });

  it("passes --version through (build assertion path) without invoking the guard", () => {
    const run = runWrapper(["--version"], { SLACK_BOT_TOKEN: "xoxb-real-1234567890" });

    expect(run.status).toBe(0);
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("--version");
  });

  it("masks api_key values in `config show` Python dict output", () => {
    const fixture = [
      "◆ Model",
      "  Model:        {'default': 'meta/llama-3.1-8b-instruct', 'provider': 'custom',",
      "                 'base_url': 'https://inference.local/v1',",
      "                 'api_key': 'sk-OPENSHELL-PROXY-REWRITE'}",
      "  Max turns:    60",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.realInvoked).toBe(true);
    expect(run.realArgs).toBe("config show");
    expect(run.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    expect(run.stdout).toContain("'api_key': 'sk-****'");
    expect(run.stdout).toContain("'default': 'meta/llama-3.1-8b-instruct'");
    expect(run.stdout).toContain("'base_url': 'https://inference.local/v1'");
    expect(run.stdout).toContain("Max turns:    60");
  });

  it("masks api_key values in `config show` JSON and YAML output", () => {
    const fixture = [
      '{"providers": {"nemoclaw-inference": {"api_key": "sk-OPENSHELL-PROXY-REWRITE"}}}',
      "providers:",
      "  nemoclaw-inference:",
      "    api_key: sk-OPENSHELL-PROXY-REWRITE",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    expect(run.stdout).toContain('"api_key": "sk-****"');
    expect(run.stdout).toContain("api_key: sk-****");
  });

  it("propagates the real binary's non-zero exit through the `config show` pipe", () => {
    const run = runWrapper(
      ["config", "show"],
      {},
      { stub: { stdout: "api_key: sk-fake-value", exitCode: 7 } },
    );

    expect(run.status).toBe(7);
    expect(run.stdout).toContain("api_key: sk-****");
  });

  it("leaves non-`config show` output untouched even when api_key shapes appear", () => {
    const fixture = "providers:\n  nemoclaw-inference:\n    api_key: sk-OPENSHELL-PROXY-REWRITE";
    const run = runWrapper(["config", "list"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("sk-OPENSHELL-PROXY-REWRITE");
  });

  it("masks non-sk- value shapes (nvapi-, plain) on api_key fields", () => {
    const fixture = [
      "{'api_key': 'nvapi-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'}",
      '{"api_key": "raw-secret-no-prefix-value"}',
      "api_key: nvapi-zzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("nvapi-aaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(run.stdout).not.toContain("nvapi-zzzzzzzzzzzzzzzzzzzzzzzzzzzz");
    expect(run.stdout).not.toContain("raw-secret-no-prefix-value");
    expect(run.stdout).toContain("'api_key': 'sk-****'");
    expect(run.stdout).toContain('"api_key": "sk-****"');
    expect(run.stdout).toContain("api_key: sk-****");
  });

  it("masks other secret-shaped fields beyond api_key (access_token, secret, password, token)", () => {
    const fixture = [
      "{'access_token': 'leaked-access-token-12345', 'secret_key': 'leaked-secret-key-12345'}",
      '{"client_secret": "leaked-client-secret-12345"}',
      "token: leaked-bearer-token-12345",
      "password: leaked-password-12345",
      "bearer: leaked-bearer-12345",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("leaked-access-token-12345");
    expect(run.stdout).not.toContain("leaked-secret-key-12345");
    expect(run.stdout).not.toContain("leaked-client-secret-12345");
    expect(run.stdout).not.toContain("leaked-bearer-token-12345");
    expect(run.stdout).not.toContain("leaked-password-12345");
    expect(run.stdout).not.toContain("leaked-bearer-12345");
    expect(run.stdout).toContain("'access_token': 'sk-****'");
    expect(run.stdout).toContain("'secret_key': 'sk-****'");
    expect(run.stdout).toContain('"client_secret": "sk-****"');
    expect(run.stdout).toContain("token: sk-****");
    expect(run.stdout).toContain("password: sk-****");
    expect(run.stdout).toContain("bearer: sk-****");
  });

  it("leaves non-secret fields untouched even when their values look credential-shaped", () => {
    const fixture = [
      "{'provider': 'sk-could-be-mistaken'}",
      '{"base_url": "https://api.example.com/sk-not-a-secret"}',
      "default: meta/llama-3.1-8b-instruct",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("sk-could-be-mistaken");
    expect(run.stdout).toContain("https://api.example.com/sk-not-a-secret");
    expect(run.stdout).toContain("default: meta/llama-3.1-8b-instruct");
  });

  it("masks hyphenated quoted secret-key fields (api-key, access-token)", () => {
    const fixture = [
      "{'api-key': 'sk-OPENSHELL-PROXY-REWRITE'}",
      '{"access-token": "leaked-access-token-12345"}',
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    expect(run.stdout).not.toContain("leaked-access-token-12345");
    expect(run.stdout).toContain("'api-key': 'sk-****'");
    expect(run.stdout).toContain('"access-token": "sk-****"');
  });

  it("masks credential-shaped values that hermes emits on stderr", () => {
    const run = runWrapper(
      ["config", "show"],
      {},
      {
        stub: {
          stdout: "api_key: ok",
          stderr: "api_key: sk-stderr-leaked-secret-12345",
          exitCode: 0,
        },
      },
    );

    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("sk-stderr-leaked-secret-12345");
    expect(run.stderr).toContain("api_key: sk-****");
  });

  it("fails closed when the stderr masker exits non-zero while hermes writes credential-shaped diagnostics", () => {
    const stderrOnlyFailValidator = [
      "#!/usr/bin/env python3",
      "import sys",
      "data = sys.stdin.read()",
      'if "FAIL-MARKER" in data:',
      '    sys.stderr.write("stderr masker boom\\n")',
      "    sys.exit(3)",
      "sys.stdout.write(data)",
      "",
    ].join("\n");
    const run = runWrapper(
      ["config", "show"],
      {},
      {
        stub: {
          stdout: "api_key: ok",
          stderr: "FAIL-MARKER api_key: sk-stderr-only-leak-12345",
          exitCode: 0,
        },
        validatorScript: stderrOnlyFailValidator,
      },
    );

    expect(run.status).toBe(3);
    expect(run.stderr).toContain("output masker failed (stderr)");
    expect(run.stderr).not.toContain("sk-stderr-only-leak-12345");
  });

  it("masks camelCase variants (apiKey, accessToken, clientSecret, authToken)", () => {
    const fixture = [
      "{'apiKey': 'leaked-camel-api-12345', 'accessToken': 'leaked-camel-access-12345'}",
      '{"clientSecret": "leaked-camel-client-12345"}',
      "authToken: leaked-camel-auth-12345",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("leaked-camel-api-12345");
    expect(run.stdout).not.toContain("leaked-camel-access-12345");
    expect(run.stdout).not.toContain("leaked-camel-client-12345");
    expect(run.stdout).not.toContain("leaked-camel-auth-12345");
    expect(run.stdout).toContain("'apiKey': 'sk-****'");
    expect(run.stdout).toContain("'accessToken': 'sk-****'");
    expect(run.stdout).toContain('"clientSecret": "sk-****"');
    expect(run.stdout).toContain("authToken: sk-****");
  });

  it("masks api_secret and auth_token fields beyond the explicit api_key/access_token shapes", () => {
    const fixture = [
      "{'api_secret': 'leaked-api-secret-12345', 'auth_token': 'leaked-auth-token-12345'}",
      '{"api_secret": "leaked-api-secret-67890"}',
      "auth_token: leaked-auth-token-67890",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("leaked-api-secret-12345");
    expect(run.stdout).not.toContain("leaked-auth-token-12345");
    expect(run.stdout).not.toContain("leaked-api-secret-67890");
    expect(run.stdout).not.toContain("leaked-auth-token-67890");
    expect(run.stdout).toContain("'api_secret': 'sk-****'");
    expect(run.stdout).toContain("'auth_token': 'sk-****'");
    expect(run.stdout).toContain('"api_secret": "sk-****"');
    expect(run.stdout).toContain("auth_token: sk-****");
  });

  it("masks every api_key emitted by the generated Hermes config (model, providers, custom_providers) on combined stdout and stderr", () => {
    const fixture = [
      "◆ Model",
      "  Model:        {'default': 'meta/llama-3.1-8b-instruct', 'provider': 'custom',",
      "                 'base_url': 'https://inference.local/v1',",
      "                 'api_key': 'sk-OPENSHELL-PROXY-REWRITE'}",
      "  Providers:    {'nemoclaw-inference': {'name': 'nemoclaw-inference',",
      "                  'api': 'https://inference.local/v1',",
      "                  'api_key': 'sk-OPENSHELL-PROXY-REWRITE',",
      "                  'default_model': 'meta/llama-3.1-8b-instruct',",
      "                  'discover_models': True}}",
      "  Custom providers: [{'name': 'nemoclaw-inference',",
      "                  'base_url': 'https://inference.local/v1',",
      "                  'api_key': 'sk-OPENSHELL-PROXY-REWRITE',",
      "                  'discover_models': True}]",
    ].join("\n");
    const run = runWrapper(
      ["config", "show"],
      {},
      {
        stub: {
          stdout: fixture,
          stderr: "api_key: sk-OPENSHELL-PROXY-REWRITE",
          exitCode: 0,
        },
      },
    );

    expect(run.status).toBe(0);
    const combined = `${run.stdout}\n${run.stderr}`;
    expect(combined).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    expect(run.stdout).toContain("'api_key': 'sk-****'");
    expect(run.stdout).toContain("'default': 'meta/llama-3.1-8b-instruct'");
    expect(run.stdout).toContain("'base_url': 'https://inference.local/v1'");
    expect(run.stdout).toContain("'discover_models': True");
    expect(run.stderr).toContain("api_key: sk-****");
  });

  it("fails closed when the masker exits non-zero even though hermes succeeded", () => {
    const failingValidator = [
      "#!/usr/bin/env python3",
      "import sys",
      'sys.stderr.write("masker boom\\n")',
      "sys.exit(2)",
      "",
    ].join("\n");
    const run = runWrapper(
      ["config", "show"],
      {},
      {
        stub: { stdout: "api_key: sk-OPENSHELL-PROXY-REWRITE", exitCode: 0 },
        validatorScript: failingValidator,
      },
    );

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("output masker failed");
    expect(run.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
  });

  it("masks YAML block-scalar secrets across continuation lines", () => {
    const fixture = [
      "providers:",
      "  nemoclaw-inference:",
      "    api_key: |",
      "      sk-OPENSHELL-PROXY-REWRITE",
      "      additional-secret-line",
      "    base_url: https://inference.local/v1",
      "  fallback:",
      "    secret: >",
      "      multi",
      "      line",
      "      bearer-token",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    expect(run.stdout).not.toContain("additional-secret-line");
    expect(run.stdout).not.toContain("bearer-token");
    expect(run.stdout).toContain("api_key: |");
    expect(run.stdout).toContain("secret: >");
    expect(run.stdout).toContain("base_url: https://inference.local/v1");
  });

  it("masks quoted secrets even when values contain escaped delimiters", () => {
    const fixture = [
      "{'api_key': 'sk-leak\\'ed-secret-12345'}",
      '{"api_key": "sk-quoted\\"leak-secret-12345"}',
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("sk-leak\\'ed-secret-12345");
    expect(run.stdout).not.toContain('sk-quoted\\"leak-secret-12345');
    expect(run.stdout).toContain("'api_key': 'sk-****'");
    expect(run.stdout).toContain('"api_key": "sk-****"');
  });

  it("preserves inline trailing comments on YAML secret lines", () => {
    const fixture = "api_key: sk-OPENSHELL-PROXY-REWRITE  # routed via OpenShell";
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    expect(run.stdout).toContain("api_key: sk-****");
    expect(run.stdout).toContain("# routed via OpenShell");
  });

  it("does not mask api_key mentions inside YAML comments", () => {
    const fixture = [
      "# example: api_key: leave-this-alone-in-comment",
      "api_key: sk-OPENSHELL-PROXY-REWRITE",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("# example: api_key: leave-this-alone-in-comment");
    expect(run.stdout).toContain("api_key: sk-****");
    expect(run.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
  });

  it("ignores PATH-shadowed external helpers so the stderr buffer cannot be redirected to an attacker path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-pathshadow-"));
    try {
      fs.copyFileSync(WRAPPER, path.join(dir, "hermes"));
      fs.copyFileSync(VALIDATOR, path.join(dir, "validate-env-secret-boundary.py"));
      fs.chmodSync(path.join(dir, "hermes"), 0o755);
      const stubScript = [
        "#!/usr/bin/env bash",
        "printf 'ok: 1\\n'",
        "printf 'api_key: sk-PATH-SHADOW-STDERR-LEAK-12345\\n' >&2",
        "exit 0",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(dir, "hermes.real"), stubScript, { mode: 0o755 });
      const evilBin = path.join(dir, "evil-bin");
      fs.mkdirSync(evilBin);
      const evilMktempLeak = path.join(dir, "evil-mktemp-leak.txt");
      const evilRmMarker = path.join(dir, "evil-rm-called.txt");
      const evilDirnameMarker = path.join(dir, "evil-dirname-called.txt");
      const writeEvil = (name: string, body: string) =>
        fs.writeFileSync(path.join(evilBin, name), body, { mode: 0o755 });
      writeEvil(
        "mktemp",
        [
          "#!/usr/bin/env bash",
          `out=${JSON.stringify(evilMktempLeak)}`,
          ': > "$out"',
          'echo "$out"',
          "",
        ].join("\n"),
      );
      writeEvil(
        "rm",
        [
          "#!/usr/bin/env bash",
          `printf 'evil-rm called with %s\\n' "$*" > ${JSON.stringify(evilRmMarker)}`,
          "",
        ].join("\n"),
      );
      writeEvil(
        "dirname",
        [
          "#!/usr/bin/env bash",
          `printf 'evil-dirname called with %s\\n' "$*" > ${JSON.stringify(evilDirnameMarker)}`,
          'echo "/evil/path"',
          "",
        ].join("\n"),
      );

      const result = spawnSync("bash", [path.join(dir, "hermes"), "config", "show"], {
        encoding: "utf-8",
        timeout: 10_000,
        env: { PATH: `${evilBin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: dir },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("sk-PATH-SHADOW-STDERR-LEAK-12345");
      expect(result.stderr).toContain("api_key: sk-****");
      expect(fs.existsSync(evilMktempLeak)).toBe(false);
      expect(fs.existsSync(evilRmMarker)).toBe(false);
      expect(fs.existsSync(evilDirnameMarker)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not crash on malformed input and still masks recognised secret fields", () => {
    const fixture = [
      "}}}}{{{{ bogus prefix line",
      'api_key: "unclosed quote then garbage rest',
      "api_key: sk-real-after-bogus-12345",
      "garbage line with no colons at all",
      "api_key: |",
      "  sk-real-block-leak-12345",
      "  more secret block content",
      "next: not-a-secret-value",
      "{garbage} { nested stuff } { api_key: should-not-match",
      "api_key:   sk-real-trailing-spaces-12345   ",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("sk-real-after-bogus-12345");
    expect(run.stdout).not.toContain("sk-real-block-leak-12345");
    expect(run.stdout).not.toContain("more secret block content");
    expect(run.stdout).not.toContain("sk-real-trailing-spaces-12345");
    expect(run.stdout).toContain("api_key: sk-****");
    expect(run.stdout).toContain("garbage line with no colons at all");
    expect(run.stdout).toContain("next: not-a-secret-value");
  });

  it("composes the openshell dispatch argv built by buildOpenshellExecArgs with the wrapper so `nemoclaw <name> exec -- hermes config show` masks Model api_key (#5981)", () => {
    const dispatchArgv = buildOpenshellExecArgs("hermes-sandbox", ["hermes", "config", "show"]);
    expect(dispatchArgv).toEqual([
      "sandbox",
      "exec",
      "--name",
      "hermes-sandbox",
      "--",
      "hermes",
      "config",
      "show",
    ]);
    const innerCommand = dispatchArgv.slice(dispatchArgv.indexOf("--") + 1);
    expect(innerCommand).toEqual(["hermes", "config", "show"]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-dispatch-"));
    try {
      fs.copyFileSync(WRAPPER, path.join(dir, "hermes"));
      fs.copyFileSync(VALIDATOR, path.join(dir, "validate-env-secret-boundary.py"));
      fs.chmodSync(path.join(dir, "hermes"), 0o755);
      const fixture = [
        "◆ Model",
        "  Model:        {'default': 'meta/llama-3.1-8b-instruct', 'provider': 'custom',",
        "                 'base_url': 'https://inference.local/v1',",
        "                 'api_key': 'sk-OPENSHELL-PROXY-REWRITE'}",
      ].join("\n");
      const stubScript = [
        "#!/usr/bin/env bash",
        `cat <<'__NEMOCLAW_STUB_EOF__'\n${fixture}\n__NEMOCLAW_STUB_EOF__`,
        `printf 'api_key: sk-OPENSHELL-PROXY-REWRITE\\n' >&2`,
        "exit 0",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(dir, "hermes.real"), stubScript, { mode: 0o755 });
      const openshellStubPath = path.join(dir, "openshell");
      fs.writeFileSync(
        openshellStubPath,
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
          "  shift 2",
          '  while [ "$1" != "--" ]; do shift; done',
          "  shift",
          '  shift  # drop the program name (e.g. "hermes") so the wrapper receives only its args',
          `  exec ${JSON.stringify(path.join(dir, "hermes"))} "$@"`,
          "fi",
          "exit 2",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const result = spawnSync(openshellStubPath, dispatchArgv, {
        encoding: "utf-8",
        timeout: 10_000,
        env: { PATH: process.env.PATH ?? "", HOME: dir },
      });

      expect(result.status).toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
      expect(result.stdout).toContain("'api_key': 'sk-****'");
      expect(result.stderr).toContain("api_key: sk-****");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reproduces the public `nemoclaw hermes exec -- hermes config show` dispatch path with masked output (#5981)", () => {
    // `nemoclaw hermes exec -- <argv>` resolves to `openshell sandbox exec
    // --name <sandbox> -- <argv>`, which runs `<argv>` inside the sandbox
    // container with `argv[0]` resolved against the in-sandbox PATH. Inside
    // the Hermes sandbox image (see `agents/hermes/Dockerfile`),
    // `/usr/local/bin/hermes` is the wrapper script tested here; the real
    // binary is at `/usr/local/bin/hermes.real`. The dispatcher adds no
    // masking layer of its own, so invoking the wrapper directly through
    // `bash <wrapper> config show` is behaviourally equivalent to the public
    // command for the masking contract. The fixture mirrors the issue's
    // exact `◆ Model` shape on stdout and an api_key-shaped diagnostic on
    // stderr; both must reach the user masked.
    const fixture = [
      "◆ Model",
      "  Model:        {'default': 'meta/llama-3.1-8b-instruct', 'provider': 'custom',",
      "                 'base_url': 'https://inference.local/v1',",
      "                 'api_key': 'sk-OPENSHELL-PROXY-REWRITE'}",
    ].join("\n");
    const run = runWrapper(
      ["config", "show"],
      {},
      {
        stub: {
          stdout: fixture,
          stderr: "api_key: sk-OPENSHELL-PROXY-REWRITE",
          exitCode: 0,
        },
      },
    );

    expect(run.status).toBe(0);
    const combined = `${run.stdout}\n${run.stderr}`;
    expect(combined).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    expect(run.stdout).toContain("'api_key': 'sk-****'");
    expect(run.stderr).toContain("api_key: sk-****");
  });

  it("documents the narrower contract: unlabelled free-form credential diagnostics pass through unmasked (out of scope)", () => {
    const fixture = [
      "Warning: using sk-freeform-leak-12345 for connection",
      "Traceback at line 42 with token bearer-freeform-67890 in stack",
      "Plain prose with no field structure 'sk-prose-only-leak' here",
    ].join("\n");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("sk-freeform-leak-12345");
    expect(run.stdout).toContain("bearer-freeform-67890");
    expect(run.stdout).toContain("sk-prose-only-leak");
  });

  it("uses the installed-layout paths (/usr/local/bin/hermes.real, /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py) before the dev fallback", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-installed-"));
    try {
      const installBin = path.join(dir, "fake-install/usr/local/bin");
      const installLib = path.join(dir, "fake-install/usr/local/lib/nemoclaw");
      fs.mkdirSync(installBin, { recursive: true });
      fs.mkdirSync(installLib, { recursive: true });
      fs.writeFileSync(
        path.join(installBin, "hermes.real"),
        [
          "#!/usr/bin/env bash",
          "printf 'installed-real-invoked\\n'",
          "printf 'api_key: sk-OPENSHELL-PROXY-REWRITE\\n'",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.copyFileSync(VALIDATOR, path.join(installLib, "validate-hermes-env-secret-boundary.py"));
      const wrapperBody = fs
        .readFileSync(WRAPPER, "utf-8")
        .replace(/\/usr\/local\/bin\/hermes\.real/g, path.join(installBin, "hermes.real"))
        .replace(
          /\/usr\/local\/lib\/nemoclaw\/validate-hermes-env-secret-boundary\.py/g,
          path.join(installLib, "validate-hermes-env-secret-boundary.py"),
        );
      const wrapperPath = path.join(dir, "hermes");
      fs.writeFileSync(wrapperPath, wrapperBody, { mode: 0o755 });
      const decoyDir = path.join(dir, "decoy");
      fs.mkdirSync(decoyDir);
      fs.writeFileSync(
        path.join(decoyDir, "hermes.real"),
        "#!/usr/bin/env bash\nprintf 'decoy-real-invoked\\n'\nexit 99\n",
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(decoyDir, "validate-env-secret-boundary.py"),
        "#!/usr/bin/env python3\nimport sys\nsys.exit(99)\n",
        { mode: 0o755 },
      );
      fs.copyFileSync(wrapperPath, path.join(decoyDir, "hermes"));

      const result = spawnSync("bash", [path.join(decoyDir, "hermes"), "config", "show"], {
        encoding: "utf-8",
        timeout: 10_000,
        env: { PATH: process.env.PATH ?? "", HOME: dir },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("installed-real-invoked");
      expect(result.stdout).not.toContain("decoy-real-invoked");
      expect(result.stdout).toContain("api_key: sk-****");
      expect(result.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("masks every api_key emitted by buildHermesConfig so the generated config cannot leak through `config show`", () => {
    const settings = {
      model: "meta/llama-3.1-8b-instruct",
      baseUrl: "https://inference.local/v1",
      providerKey: "custom",
      upstreamProvider: "nemoclaw-inference",
      inferenceApi: "",
      messagingCredentialPlaceholders: [],
      managedToolGateways: { brokerEnabled: false, presets: [] },
    };
    const generated = buildHermesConfig(settings);
    const fixture = JSON.stringify(generated, null, 2);
    expect(fixture).toContain("sk-OPENSHELL-PROXY-REWRITE");
    const run = runWrapper(["config", "show"], {}, { stub: { stdout: fixture, exitCode: 0 } });

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
    expect(run.stdout).toContain('"api_key": "sk-****"');
    expect(run.stdout).toContain('"default": "meta/llama-3.1-8b-instruct"');
    expect(run.stdout).toContain('"base_url": "https://inference.local/v1"');
  });

  it("masks api_key on the installed `/usr/local/bin/hermes` layout (REAL_HERMES and GUARD resolved from absolute install paths)", () => {
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-wrapper-install-"));
    try {
      const binDir = path.join(prefix, "usr", "local", "bin");
      const libDir = path.join(prefix, "usr", "local", "lib", "nemoclaw");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(libDir, { recursive: true });
      const installedReal = path.join(binDir, "hermes.real");
      const installedGuard = path.join(libDir, "validate-hermes-env-secret-boundary.py");
      const wrapperContent = fs
        .readFileSync(WRAPPER, "utf-8")
        .replace(
          'REAL_HERMES="/usr/local/bin/hermes.real"',
          `REAL_HERMES=${JSON.stringify(installedReal)}`,
        )
        .replace(
          'GUARD="/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py"',
          `GUARD=${JSON.stringify(installedGuard)}`,
        );
      const installedWrapper = path.join(binDir, "hermes");
      fs.writeFileSync(installedWrapper, wrapperContent, { mode: 0o755 });
      fs.copyFileSync(VALIDATOR, installedGuard);
      fs.chmodSync(installedGuard, 0o755);

      const settings = {
        model: "meta/llama-3.1-8b-instruct",
        baseUrl: "https://inference.local/v1",
        providerKey: "custom",
        upstreamProvider: "nemoclaw-inference",
        inferenceApi: "",
        messagingCredentialPlaceholders: [],
        managedToolGateways: { brokerEnabled: false, presets: [] },
      };
      const generated = buildHermesConfig(settings);
      const fixture = JSON.stringify(generated, null, 2);
      const stubScript = [
        "#!/usr/bin/env bash",
        `cat <<'__NEMOCLAW_STUB_EOF__'\n${fixture}\n__NEMOCLAW_STUB_EOF__`,
        "exit 0",
        "",
      ].join("\n");
      fs.writeFileSync(installedReal, stubScript, { mode: 0o755 });

      const result = spawnSync("bash", [installedWrapper, "config", "show"], {
        encoding: "utf-8",
        timeout: 10_000,
        env: { PATH: process.env.PATH ?? "", HOME: prefix },
      });

      expect(result.status).toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).not.toContain("sk-OPENSHELL-PROXY-REWRITE");
      expect(result.stdout).toContain('"api_key": "sk-****"');
    } finally {
      fs.rmSync(prefix, { recursive: true, force: true });
    }
  });
});
