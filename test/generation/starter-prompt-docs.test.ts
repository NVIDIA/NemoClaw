// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  extractStarterPromptMarkdown,
  generateStarterPromptSnippet,
  renderStarterPromptSnippet,
  runStarterPromptGenerator,
} from "../../scripts/generate-starter-prompt.mts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

const syntheticPromptSource = `<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Instructions for a Non-Technical User

Use the synthetic prompt payload.
`;

const localCredentialFormSource = path.join(
  repoRoot,
  "docs",
  "resources",
  "local-credential-form.html",
);
const localCredentialCapability = "A".repeat(43);
const localCredentialNetworkControlNames = [
  "ALL_PROXY",
  "AWS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "DENO_CERT",
  "FTP_PROXY",
  "GIT_PROXY_SSL_CAINFO",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "GIT_SSL_NO_VERIFY",
  "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH",
  "GRPC_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_ENV_PROXY",
  "NODE_USE_SYSTEM_CA",
  "NO_PROXY",
  "REQUESTS_CA_BUNDLE",
  "SSLKEYLOGFILE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
];
const localCredentialConfigControlNames = [
  "ALLUSERSPROFILE",
  "APPDATA",
  "CURL_HOME",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "GCONV_PATH",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GLIBC_TUNABLES",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "KUBECONFIG",
  "LOCALAPPDATA",
  "LOCPATH",
  "NETRC",
  "NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL",
  "NEMOCLAW_BOOTSTRAP_PAYLOAD",
  "NEMOCLAW_INSTALL_REF",
  "NEMOCLAW_INSTALL_TAG",
  "NEMOCLAW_INSTALLER_STAGED",
  "NEMOCLAW_INSTALLER_URL",
  "NEMOCLAW_OPENSHELL_BIN",
  "NEMOCLAW_OPENSHELL_CHANNEL",
  "NEMOCLAW_OPENSHELL_GATEWAY_BIN",
  "NEMOCLAW_OPENSHELL_SANDBOX_BIN",
  "NEMOCLAW_REPO_ROOT",
  "NEMOCLAW_SOURCE_ROOT",
  "NVM_DIR",
  "OLDPWD",
  "OPENSSL_CONF",
  "OPENSSL_CONF_INCLUDE",
  "OPENSSL_ENGINES",
  "OPENSSL_MODULES",
  "PROGRAMDATA",
  "PSMODULEPATH",
  "PWD",
  "PYTHONUSERBASE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "VIRTUAL_ENV",
  "XDG_BIN_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_DIRS",
  "XDG_CONFIG_HOME",
  "XDG_DATA_DIRS",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "ZDOTDIR",
];
function withCredentialCapability(url: string, capability = localCredentialCapability): string {
  const parsed = new URL(url);
  parsed.hash = `cap=${capability}`;
  return parsed.href;
}

function fail(message: string): never {
  throw new Error(message);
}

function extractTagContent(content: string, tagName: "script" | "style"): string {
  const match =
    content.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`)) ??
    fail(`Missing <${tagName}> block`);
  return match[1];
}

class FakeClassList {
  readonly values = new Set<string>();

  add(value: string): void {
    this.values.add(value);
  }

  has(value: string): boolean {
    return this.values.has(value);
  }
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<
    string,
    (event: { preventDefault: () => void }) => Promise<void> | void
  >();
  autocomplete = "";
  className = "";
  disabled = false;
  hidden = false;
  id = "";
  name = "";
  readOnly = false;
  required = false;
  spellcheck = true;
  textContent = "";
  type = "";
  value = "";

  constructor(readonly tagName: string) {}

  append(...elements: FakeElement[]): void {
    this.children.push(...elements);
  }

  replaceChildren(...elements: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...elements);
    this.textContent = "";
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(
    name: string,
    listener: (event: { preventDefault: () => void }) => Promise<void> | void,
  ): void {
    this.listeners.set(name, listener);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const result: FakeElement[] = [];
    const visit = (element: FakeElement) => {
      const matchesInput = selector === "input" && element.tagName === "input";
      const matchesSecretInput =
        selector === "input[data-secret='true']" &&
        element.tagName === "input" &&
        element.dataset.secret === "true";
      (matchesInput || matchesSecretInput) && result.push(element);
      for (const child of element.children) {
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  allText(): string {
    return [this.textContent, ...this.children.map((child) => child.allText())].join("");
  }
}

class FakeDocument {
  readonly elements = new Map<string, FakeElement>();

  constructor() {
    for (const [id, tagName] of [
      ["fields", "div"],
      ["credential-form", "form"],
      ["result", "section"],
      ["submit-button", "button"],
      ["edit-button", "button"],
      ["confirm-button", "button"],
      ["origin-notice", "div"],
    ] as const) {
      const element = new FakeElement(tagName);
      element.id = id;
      this.elements.set(id, element);
    }
    this.getElementById("credential-form").append(
      this.getElementById("fields"),
      this.getElementById("submit-button"),
      this.getElementById("edit-button"),
      this.getElementById("confirm-button"),
    );
  }

  getElementById(id: string): FakeElement {
    return this.elements.get(id) ?? fail(`Missing fake element ${id}`);
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

class FakeFormData {
  readonly entriesList: Array<[string, string]> = [];

  constructor(form: FakeElement) {
    const visit = (element: FakeElement) => {
      element.tagName === "input" &&
        element.name &&
        this.entriesList.push([element.name, element.value]);
      for (const child of element.children) {
        visit(child);
      }
    };
    visit(form);
  }

  entries(): ArrayIterator<[string, string]> {
    return this.entriesList.values();
  }
}

function runCredentialForm(
  url: string,
  fetchImpl: (
    target: string,
    init?: unknown,
  ) => Promise<{ ok: boolean; status: number }> = async () => ({ ok: true, status: 202 }),
) {
  const formSource = fs.readFileSync(localCredentialFormSource, "utf8");
  const script = extractTagContent(formSource, "script");
  const parsedUrl = new URL(url);
  const document = new FakeDocument();
  const consoleCalls: unknown[][] = [];
  const fetchCalls: Array<{ url: string; init?: unknown }> = [];
  const historyCalls: string[] = [];
  const context = {
    console: {
      error: (...args: unknown[]) => consoleCalls.push(args),
      log: (...args: unknown[]) => consoleCalls.push(args),
      warn: (...args: unknown[]) => consoleCalls.push(args),
    },
    document,
    Error,
    fetch: async (target: string, init?: unknown) => {
      fetchCalls.push({ url: target, init });
      return fetchImpl(target, init);
    },
    FormData: FakeFormData,
    TextEncoder,
    URLSearchParams,
    window: {
      history: {
        replaceState: (_state: null, _title: string, target: string) => {
          historyCalls.push(target);
        },
      },
      location: {
        hash: parsedUrl.hash,
        hostname: parsedUrl.hostname,
        href: parsedUrl.href,
        pathname: parsedUrl.pathname,
        search: parsedUrl.search,
      },
    },
  };
  vm.runInNewContext(script, context);

  const form = document.getElementById("credential-form");
  const click = async (id: string) => {
    const listener =
      document.getElementById(id).listeners.get("click") ??
      fail(`Missing click listener for ${id}`);
    await listener({ preventDefault: () => undefined });
  };
  return {
    confirm: () => click("confirm-button"),
    confirmButton: document.getElementById("confirm-button"),
    consoleCalls,
    document,
    edit: () => click("edit-button"),
    editButton: document.getElementById("edit-button"),
    fetchCalls,
    fieldsElement: document.getElementById("fields"),
    form,
    historyCalls,
    originNotice: document.getElementById("origin-notice"),
    preview: async () => {
      const listener = form.listeners.get("submit") ?? fail("Missing submit listener");
      await listener({ preventDefault: () => undefined });
    },
    resultElement: document.getElementById("result"),
    submit: async () => {
      const listener = form.listeners.get("submit") ?? fail("Missing submit listener");
      await listener({ preventDefault: () => undefined });
    },
    submitButton: document.getElementById("submit-button"),
  };
}

describe("starter prompt docs CTA", () => {
  it("renders one visible prompt from validated synthetic Markdown", () => {
    const prompt = extractStarterPromptMarkdown(syntheticPromptSource, "synthetic-prompt.md");

    expect(renderStarterPromptSnippet(prompt)).toContain(`>\n${prompt}\n</Prompt>`);
  });

  it("rejects prompt Markdown that cannot generate one stable payload (#5048)", () => {
    expect(() =>
      extractStarterPromptMarkdown(syntheticPromptSource.replace("<!--\n", ""), "fixture.md"),
    ).toThrow("expected the standard Markdown SPDX header");
    expect(() => extractStarterPromptMarkdown(`${syntheticPromptSource}\n`, "fixture.md")).toThrow(
      "prompt must end with exactly one newline",
    );
    expect(() =>
      extractStarterPromptMarkdown(syntheticPromptSource.replaceAll("\n", "\r\n"), "fixture.md"),
    ).toThrow("use LF line endings");
  });

  it("rejects missing or stale generated snippets and accepts the current output (#5048)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-starter-prompt-"));
    const sourcePath = path.join(tempDir, "starter-prompt.md");
    const generatedPath = path.join(tempDir, "StarterPrompt.generated.mdx");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const runCheck = () =>
      runStarterPromptGenerator({
        args: ["--check"],
        sourcePath,
        generatedPath,
        log: (message) => stdout.push(message),
        reportError: (message) => stderr.push(message),
      });

    try {
      fs.writeFileSync(sourcePath, syntheticPromptSource);
      const missing = runCheck();
      expect(missing).toBe(1);
      expect(stderr.at(-1)).toContain("is missing or stale");

      fs.writeFileSync(generatedPath, "stale\n");
      const stale = runCheck();
      expect(stale).toBe(1);
      expect(stderr.at(-1)).toContain("is missing or stale");

      fs.writeFileSync(generatedPath, generateStarterPromptSnippet(sourcePath));
      const current = runCheck();
      expect(current).toBe(0);
      expect(stdout.at(-1)).toBe("Generated Starter Prompt snippet is current.");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects missing, ambiguous, and unsafe credential schemas (#5048)", async () => {
    const missing = runCredentialForm(
      withCredentialCapability("http://127.0.0.1:4123/local-credential-form.html"),
    );
    expect(missing.submitButton.disabled).toBe(true);
    expect(missing.fieldsElement.children).toHaveLength(0);
    expect(missing.resultElement.allText()).toContain("Credential fields are not configured.");

    const invalid = runCredentialForm(
      withCredentialCapability(
        "http://127.0.0.1:4123/local-credential-form.html?fields=bad-name:secret,VALID_NAME:text",
      ),
    );
    expect(invalid.submitButton.disabled).toBe(true);
    expect(invalid.fieldsElement.children.map((child) => child.textContent)).toContain(
      "Valid Name",
    );
    expect(invalid.resultElement.allText()).toContain("Rejected specs: bad-name:secret");
    await invalid.preview();
    expect(invalid.fetchCalls).toHaveLength(0);

    const allInvalid = runCredentialForm(
      withCredentialCapability(
        "http://127.0.0.1:4123/local-credential-form.html?fields=bad-name:secret",
      ),
    );
    expect(allInvalid.submitButton.disabled).toBe(true);
    expect(allInvalid.fieldsElement.children).toHaveLength(0);
    expect(allInvalid.resultElement.allText()).toContain("Rejected specs: bad-name:secret");

    for (const malformedUrl of [
      "http://127.0.0.1:4123/local-credential-form.html?fields=SECRET_TOKEN",
      "http://127.0.0.1:4123/local-credential-form.html?fields=SECRET_TOKEN:unknown",
      "http://127.0.0.1:4123/local-credential-form.html?fields=SECRET_TOKEN:text:extra",
      "http://127.0.0.1:4123/local-credential-form.html?fields=SECRET_TOKEN:secret,SECRET_TOKEN:text",
      "http://127.0.0.1:4123/local-credential-form.html?fields=SECRET_TOKEN:secret,",
      "http://127.0.0.1:4123/local-credential-form.html?fields=SECRET_TOKEN:secret&fields=PUBLIC_ID:text",
      "http://127.0.0.1:4123/local-credential-form.html?field=SECRET_TOKEN:secret&fields=PUBLIC_ID:text",
      "http://127.0.0.1:4123/local-credential-form.html?fields=NVIDIA_INFERENCE_API_KEY:text",
      "http://127.0.0.1:4123/local-credential-form.html?fields=WEBHOOK_URL:text",
      "http://127.0.0.1:4123/local-credential-form.html?fields=PRIVATE:text",
      "http://127.0.0.1:4123/local-credential-form.html?fields=PIN:text",
      "http://127.0.0.1:4123/local-credential-form.html?fields=NODE_OPTIONS:secret",
      "http://127.0.0.1:4123/local-credential-form.html?fields=BASH_FUNC_ECHO:secret",
      "http://127.0.0.1:4123/local-credential-form.html?fields=DOTNET_STARTUP_HOOKS:secret",
      "http://127.0.0.1:4123/local-credential-form.html?fields=GIT_EXEC_PATH:secret",
      "http://127.0.0.1:4123/local-credential-form.html?fields=GIT_EXTERNAL_DIFF:secret",
      "http://127.0.0.1:4123/local-credential-form.html?fields=GIT_PROXY_COMMAND:secret",
      "http://127.0.0.1:4123/local-credential-form.html?fields=GIT_TRACE2_EVENT:secret",
      "http://127.0.0.1:4123/local-credential-form.html?fields=GIT_SSH:secret",
      "http://127.0.0.1:4123/local-credential-form.html?fields=NPM_CONFIG_USERCONFIG:secret",
      "http://127.0.0.1:4123/local-credential-form.html?fields=LD_PRELOAD:secret",
      "http://127.0.0.1:4123/local-credential-form.html?fields=DYLD_INSERT_LIBRARIES:secret",
      "http://127.0.0.1:4123/local-credential-form.html?fields=GIT_CONFIG:secret",
      "http://127.0.0.1:4123/local-credential-form.html?fields=GIT_CONFIG_COUNT:secret",
      ...localCredentialNetworkControlNames.map(
        (name) => `http://127.0.0.1:4123/local-credential-form.html?fields=${name}:text`,
      ),
      ...localCredentialConfigControlNames.map(
        (name) => `http://127.0.0.1:4123/local-credential-form.html?fields=${name}:text`,
      ),
      "http://127.0.0.1:4123/local-credential-form.html?fields=NPM_CONFIG_REGISTRY:text",
      "http://127.0.0.1:4123/local-credential-form.html?fields=OPENSHELL_DOCKER_SUPERVISOR_IMAGE:text",
      "http://127.0.0.1:4123/local-credential-form.html?fields=PIP_INDEX_URL:text",
      "http://127.0.0.1:4123/local-credential-form.html?fields=PUBLIC_ID:text&submit=/capture",
    ]) {
      const malformed = runCredentialForm(withCredentialCapability(malformedUrl));
      expect(malformed.submitButton.disabled, malformedUrl).toBe(true);
      expect(malformed.resultElement.allText(), malformedUrl).toContain("rejected");
      await malformed.preview();
      expect(malformed.fetchCalls, malformedUrl).toHaveLength(0);
    }

    const tooManyFields = Array.from({ length: 17 }, (_, index) => `PUBLIC_ID_${index}:text`);
    const oversizedSchema = runCredentialForm(
      withCredentialCapability(
        `http://127.0.0.1:4123/local-credential-form.html?fields=${tooManyFields.join(",")}`,
      ),
    );
    expect(oversizedSchema.submitButton.disabled).toBe(true);
    expect(oversizedSchema.resultElement.allText()).toContain("too many fields");
    await oversizedSchema.preview();
    expect(oversizedSchema.fetchCalls).toHaveLength(0);
  });

  it("requires and consumes one fragment capability before enabling preview (#5048)", () => {
    const withoutCapability = runCredentialForm(
      "http://127.0.0.1:4123/local-credential-form.html?fields=SECRET_TOKEN:secret",
    );
    expect(withoutCapability.submitButton.disabled).toBe(true);
    expect(withoutCapability.resultElement.allText()).toContain(
      "missing a valid one-time capability",
    );
    expect(withoutCapability.historyCalls).toEqual([
      "/local-credential-form.html?fields=SECRET_TOKEN:secret",
    ]);

    const malformedCapability = runCredentialForm(
      withCredentialCapability(
        "http://127.0.0.1:4123/local-credential-form.html?fields=SECRET_TOKEN:secret",
        "too-short",
      ),
    );
    expect(malformedCapability.submitButton.disabled).toBe(true);
    expect(malformedCapability.resultElement.allText()).toContain(
      "missing a valid one-time capability",
    );

    const validCapability = runCredentialForm(
      withCredentialCapability(
        "http://127.0.0.1:4123/local-credential-form.html?fields=SECRET_TOKEN:secret",
      ),
    );
    expect(validCapability.submitButton.disabled).toBe(false);
    expect(validCapability.historyCalls).toEqual([
      "/local-credential-form.html?fields=SECRET_TOKEN:secret",
    ]);
  });

  it("previews locally then confirms one frozen, authenticated payload (#5048)", async () => {
    const repeated = runCredentialForm(
      withCredentialCapability(
        "http://127.0.0.1:4123/local-credential-form.html?field=SECRET_TOKEN:secret&field=PUBLIC_ID:text",
      ),
    );
    const repeatedInputs = repeated.fieldsElement.children.filter(
      (child) => child.tagName === "input",
    );
    expect(repeatedInputs.map(({ name, type }) => [name, type])).toEqual([
      ["SECRET_TOKEN", "password"],
      ["PUBLIC_ID", "text"],
    ]);
    expect(repeated.submitButton.disabled).toBe(false);

    const rendered = runCredentialForm(
      withCredentialCapability(
        "http://127.0.0.1:4123/local-credential-form.html?fields=SECRET_TOKEN:secret,PUBLIC_ID:text",
      ),
    );
    const inputs = rendered.fieldsElement.children.filter((child) => child.tagName === "input");
    const secretInput = inputs.find((input) => input.name === "SECRET_TOKEN");
    const textInput = inputs.find((input) => input.name === "PUBLIC_ID");
    expect(secretInput?.type).toBe("password");
    expect(textInput?.type).toBe("text");

    secretInput!.value = "super-secret";
    textInput!.value = "public-id";
    await rendered.preview();

    expect(rendered.fetchCalls).toHaveLength(0);
    expect(secretInput?.readOnly).toBe(true);
    expect(textInput?.readOnly).toBe(true);
    expect(secretInput?.value).toBe("");
    expect(textInput?.value).toBe("");
    expect(rendered.submitButton.hidden).toBe(true);
    expect(rendered.editButton.hidden).toBe(false);
    expect(rendered.confirmButton.hidden).toBe(false);
    expect(rendered.resultElement.allText()).toContain("SECRET_TOKEN=********");
    expect(rendered.resultElement.allText()).toContain("PUBLIC_ID=public-id");
    expect(rendered.resultElement.allText()).not.toContain("super-secret");

    secretInput!.value = "changed-after-preview";
    textInput!.value = "changed-public-id";
    await rendered.confirm();

    expect(rendered.fetchCalls).toHaveLength(1);
    expect(rendered.fetchCalls[0]?.url).toBe("/submit");
    const request = rendered.fetchCalls[0]?.init as {
      body: string;
      cache: string;
      credentials: string;
      headers: Record<string, string>;
      method: string;
      redirect: string;
    };
    expect(request.method).toBe("POST");
    expect(request.cache).toBe("no-store");
    expect(request.credentials).toBe("omit");
    expect(request.redirect).toBe("error");
    expect(request.headers).toEqual({
      "Content-Type": "application/json",
      "X-NemoClaw-Capability": localCredentialCapability,
    });
    expect(JSON.parse(request.body)).toEqual({
      values: { PUBLIC_ID: "public-id", SECRET_TOKEN: "super-secret" },
    });
    expect(secretInput?.value).toBe("");
    expect(textInput?.value).toBe("");
    expect(rendered.resultElement.allText()).toContain("SECRET_TOKEN=********");
    expect(rendered.resultElement.allText()).toContain("PUBLIC_ID=public-id");
    expect(rendered.resultElement.allText()).not.toContain("super-secret");
    expect(rendered.submitButton.disabled).toBe(true);
    expect(rendered.confirmButton.disabled).toBe(true);
    await rendered.confirm();
    expect(rendered.fetchCalls).toHaveLength(1);
  });

  it("discards a preview before accepting edited values (#5048)", async () => {
    const rendered = runCredentialForm(
      withCredentialCapability(
        "http://127.0.0.1:4123/local-credential-form.html?fields=SECRET_TOKEN:secret,PUBLIC_ID:text",
      ),
    );
    const inputs = rendered.fieldsElement.children.filter((child) => child.tagName === "input");
    const secretInput = inputs.find((input) => input.name === "SECRET_TOKEN")!;
    const textInput = inputs.find((input) => input.name === "PUBLIC_ID")!;
    secretInput.value = "first-secret";
    textInput.value = "first-id";

    await rendered.preview();
    await rendered.edit();
    expect(rendered.fetchCalls).toHaveLength(0);
    expect(secretInput.readOnly).toBe(false);
    expect(textInput.readOnly).toBe(false);
    expect(secretInput.value).toBe("");
    expect(textInput.value).toBe("");
    expect(rendered.submitButton.hidden).toBe(false);

    secretInput.value = "second-secret";
    textInput.value = "second-id";
    await rendered.preview();
    await rendered.confirm();
    const request = rendered.fetchCalls[0]?.init as { body: string };
    expect(JSON.parse(request.body)).toEqual({
      values: { PUBLIC_ID: "second-id", SECRET_TOKEN: "second-secret" },
    });
  });

  it("disables non-loopback sessions and permanently locks ambiguous outcomes (#5048)", async () => {
    const nonLoopback = runCredentialForm(
      withCredentialCapability(
        "https://example.com/local-credential-form.html?fields=SECRET_TOKEN:secret",
      ),
    );
    expect(nonLoopback.submitButton.disabled).toBe(true);
    expect(nonLoopback.originNotice.classList.has("warning")).toBe(true);
    await nonLoopback.preview();
    expect(nonLoopback.submitButton.disabled).toBe(true);
    expect(nonLoopback.fetchCalls).toHaveLength(0);

    const helperFailure = runCredentialForm(
      withCredentialCapability(
        "http://127.0.0.1:4123/local-credential-form.html?fields=SECRET_TOKEN:secret",
      ),
      async () => ({ ok: false, status: 500 }),
    );
    const failureInput = helperFailure.fieldsElement.children.find(
      (child) => child.tagName === "input",
    )!;
    failureInput.value = "never-log-this";
    await helperFailure.preview();
    await helperFailure.confirm();
    expect(helperFailure.fetchCalls).toHaveLength(1);
    expect(helperFailure.resultElement.allText()).toContain("outcome is unknown");
    expect(helperFailure.resultElement.allText()).toContain("Do not retry or resubmit");
    expect(helperFailure.resultElement.allText()).not.toContain("never-log-this");
    expect(failureInput.value).toBe("");
    expect(helperFailure.submitButton.disabled).toBe(true);
    expect(helperFailure.confirmButton.disabled).toBe(true);
    expect(helperFailure.consoleCalls).toHaveLength(0);
    await helperFailure.preview();
    await helperFailure.confirm();
    expect(helperFailure.fetchCalls).toHaveLength(1);

    const networkFailure = runCredentialForm(
      withCredentialCapability(
        "http://127.0.0.1:4123/local-credential-form.html?fields=SECRET_TOKEN:secret",
      ),
      async () => {
        throw new Error("response lost after acceptance");
      },
    );
    const networkInput = networkFailure.fieldsElement.children.find(
      (child) => child.tagName === "input",
    )!;
    networkInput.value = "also-never-log-this";
    await networkFailure.preview();
    await networkFailure.confirm();
    expect(networkFailure.resultElement.allText()).toContain("outcome is unknown");
    expect(networkFailure.consoleCalls).toHaveLength(0);
    expect(networkInput.value).toBe("");
  });
});
