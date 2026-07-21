// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
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
  STARTER_PROMPT_GENERATED_PATH,
} from "../scripts/generate-starter-prompt.mts";
import {
  createGitRunner,
  type GitRunner,
  readPinnedPromptAssetBlob,
  requireExpectedPromptAssetRoutes,
  resolvePromptAssetRevision,
} from "./helpers/starter-prompt-asset-contract";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const starterPromptMarkdownSource = path.join(repoRoot, "docs", "resources", "starter-prompt.md");
// CI resolves this Git commit and byte-compares its prompt-asset blobs with
// the local files. The digests independently assert those same immutable bytes.
const promptAssetRevision = "c718a78c5794574a98fdd885d94466c3b6794153";

type PromptAsset = {
  path: string;
  pinnedSha256: string;
  url: string;
};

function definePromptAsset(assetPath: string, pinnedSha256: string): PromptAsset {
  return {
    path: assetPath,
    pinnedSha256,
    url: `https://raw.githubusercontent.com/NVIDIA/NemoClaw/${promptAssetRevision}/${assetPath}`,
  };
}

const promptAssets = {
  dgxSpark: definePromptAsset(
    "docs/resources/prompt-assets/dgx-spark.md",
    "806e87f2ae7e4a4be731c7ce3b1ecde9ff8be170563d4338a5f79f76ce25e034", // gitleaks:allow -- pinned prompt-asset SHA-256
  ),
  dgxStation: definePromptAsset(
    "docs/resources/prompt-assets/dgx-station.md",
    "f0c61cef93da203cecda2424eb1fc5680d56ffd679a518bfc98d26b2e82be381", // gitleaks:allow -- pinned prompt-asset SHA-256
  ),
  windowsWsl: definePromptAsset(
    "docs/resources/prompt-assets/windows-wsl.md",
    "7719b81e9304ac7cd924a9fe487a154846660557e50a0f1524f2b0dc87e729ab", // gitleaks:allow -- pinned prompt-asset SHA-256
  ),
} as const;
const platformPromptAssetRoutes = [
  { asset: promptAssets.dgxSpark, label: "Confirmed DGX Spark" },
  { asset: promptAssets.dgxStation, label: "Confirmed DGX Station" },
  { asset: promptAssets.windowsWsl, label: "Officially detected Windows WSL" },
] as const;
const runGit = createGitRunner(repoRoot);

const localCredentialFormSource = path.join(
  repoRoot,
  "docs",
  "resources",
  "local-credential-form.html",
);
const localCredentialHelperUrl =
  "https://raw.githubusercontent.com/NVIDIA/NemoClaw/dd61a307d7ddf7be99de8ff1e2678fb8ef42f8e6/scripts/local-credential-helper.mts";
const localCredentialHelperSha256 =
  "1a42bbe8dbc9003cb79d4e641b53760571aacd85293671aee97c09c0746fef33"; // gitleaks:allow -- checked-in SHA-256 fixture
const localCredentialFormUrl =
  "https://raw.githubusercontent.com/NVIDIA/NemoClaw/dd61a307d7ddf7be99de8ff1e2678fb8ef42f8e6/docs/resources/local-credential-form.html";
const localCredentialFormSha256 =
  "5512a256e0ad7c63a26ab82cf4f5924e98652097172ab8a5dc9d9358dd4f6ae8"; // gitleaks:allow -- checked-in SHA-256 fixture
const localCredentialFormScriptCspHash = [
  "'sha256-i3cXmSMU",
  "jTA5LqLSfFQpXe0B",
  "BZRj4cM8t36dJMm3",
  "YJw='",
].join("");
const localCredentialFormStyleCspHash = [
  "'sha256-W4wSJyrm",
  "RXSCgQSjhVRZBhE",
  "msaHh6dbUj9ZlKh",
  "xipME='",
].join("");
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
const starterPromptPages = [
  "docs/index.mdx",
  "docs/get-started/quickstart.mdx",
  "docs/get-started/quickstart-hermes.mdx",
  "docs/get-started/quickstart-langchain-deepagents-code.mdx",
  "docs/resources/agent-skills.mdx",
];

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readStarterPrompt(): string {
  return extractStarterPromptMarkdown(
    fs.readFileSync(starterPromptMarkdownSource, "utf8"),
    "docs/resources/starter-prompt.md",
  );
}

function readPromptAsset(asset: (typeof promptAssets)[keyof typeof promptAssets]): string {
  return read(asset.path);
}

function urlsIn(content: string): URL[] {
  return Array.from(content.matchAll(/https?:\/\/[^\s"'<>;]+/g), ([match]) => new URL(match));
}

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

function sha256Source(content: string): string {
  return `'sha256-${createHash("sha256").update(content).digest("base64")}'`;
}

function cspMetaContent(content: string): string {
  return (
    content.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/)?.[1] ??
    fail("Missing Content-Security-Policy meta content")
  );
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
  it("generates one visible Fern Prompt from the shared Markdown source (#5048)", () => {
    const prompt = readStarterPrompt();
    const generatedSnippet = renderStarterPromptSnippet(prompt);

    expect(prompt).toMatch(/^# NemoClaw Instructions for a Non-Technical User$/m);
    expect(STARTER_PROMPT_GENERATED_PATH).toBe("docs/_build/StarterPrompt.generated.mdx");
    expect(generatedSnippet).toContain(
      '<Prompt\n  title="Install NemoClaw with your coding agent"',
    );
    expect(generatedSnippet).not.toContain("hidePrompt");
    expect(generatedSnippet).not.toContain("actions=");
    expect(generatedSnippet).toContain(`>\n${prompt}\n</Prompt>`);
    expect(generatedSnippet).not.toContain("<!--");
    expect(prompt).not.toMatch(/<https?:\/\//);
    expect(prompt).toContain("Use redacted placeholders such as `<PASTE_YOUR_API_KEY_HERE>`");
    expect(read("docs/index.mdx")).toContain(
      'import { CommandTerminal } from "./_components/CommandTerminal";\n\n<BadgeLinks',
    );

    for (const page of starterPromptPages) {
      const content = read(page);
      expect(content, `${page} includes the generated Fern Prompt`).toContain(
        '<Markdown src="/../docs/_build/StarterPrompt.generated.mdx" />',
      );
      expect(content, `${page} does not use the retired custom components`).not.toMatch(
        /StarterPrompt(?:Button|Fallback)/,
      );
    }
  });

  it("rejects prompt Markdown that cannot generate one stable payload (#5048)", () => {
    const source = fs.readFileSync(starterPromptMarkdownSource, "utf8");

    expect(() => extractStarterPromptMarkdown(source.replace("<!--\n", ""), "fixture.md")).toThrow(
      "expected the standard Markdown SPDX header",
    );
    expect(() => extractStarterPromptMarkdown(`${source}\n`, "fixture.md")).toThrow(
      "prompt must end with exactly one newline",
    );
    expect(() =>
      extractStarterPromptMarkdown(source.replaceAll("\n", "\r\n"), "fixture.md"),
    ).toThrow("use LF line endings");
  });

  it("names non-interactive install controls and scopes sandboxed Docker approval (#7311)", () => {
    const promptSource = readStarterPrompt();
    const quickstartSource = read("docs/get-started/quickstart.mdx");
    const commandsSource = read("docs/reference/commands.mdx");
    const updateSource = read("docs/manage-sandboxes/update-sandboxes.mdx");

    for (const variable of ["NEMOCLAW_AGENT", "NEMOCLAW_PROVIDER", "NEMOCLAW_INSTALL_TAG"]) {
      expect(promptSource, `starter prompt names ${variable}`).toContain(variable);
      expect(quickstartSource, `quickstart names ${variable}`).toContain(variable);
    }

    expect(promptSource).toContain("NEMOCLAW_AGENT=openclaw");
    expect(promptSource).toContain("NEMOCLAW_AGENT=hermes");
    expect(promptSource).toContain("NEMOCLAW_AGENT=langchain-deepagents-code");
    expect(promptSource).toContain(
      "set `NEMOCLAW_AGENT` and `NEMOCLAW_PROVIDER` from my selections",
    );
    expect(quickstartSource).toMatch(/NEMOCLAW_AGENT=openclaw\s*\\\s*NEMOCLAW_PROVIDER=build/);
    expect(promptSource).toContain("NEMOCLAW_INSTALL_TAG=vX.Y.Z");
    expect(promptSource).toContain("clear any inherited `NEMOCLAW_INSTALL_REF`");
    expect(promptSource).toContain(
      "Request permission to rerun only that exact command outside the sandbox",
    );
    expect(promptSource).toContain("`NEMOCLAW_NON_INTERACTIVE=1` removes NemoClaw prompts");
    expect(promptSource).toContain(
      "`NEMOCLAW_NON_INTERACTIVE=1` does not bypass execution-sandbox permissions",
    );
    expect(promptSource).toContain(
      "Do not change Docker socket permissions or request broad host access only to bypass the execution sandbox.",
    );
    expect(promptSource).not.toContain("or another approved host command");
    expect(quickstartSource).toContain(
      "curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_INSTALL_REF= NEMOCLAW_INSTALL_TAG=vX.Y.Z bash",
    );
    expect(quickstartSource).toContain(
      "Approve only the exact Docker-dependent command that the coding agent requests",
    );
    expect(quickstartSource).toContain(
      "Do not change Docker socket permissions or grant broad host access only to bypass the restriction.",
    );
    expect(promptSource).not.toContain("## Codex Execution Sandbox");
    expect(quickstartSource).not.toContain("When Codex reports");
    expect(quickstartSource).not.toContain("NEMOCLAW_INSTALL_TAG=vX.Y.Z curl");
    expect(quickstartSource).not.toContain(
      "https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_INSTALL_TAG=vX.Y.Z bash",
    );
    expect(commandsSource).toContain(
      "A nonempty value takes precedence over `NEMOCLAW_INSTALL_TAG`.",
    );
    expect(commandsSource).toContain("Overridden by the `--install-ref` flag.");
    expect(commandsSource).toContain("Overridden by the `--install-tag` flag.");
    expect(commandsSource).toContain("Defaults to the admin-promoted `lkg` tag when unset.");
    expect(updateSource).toContain(
      "curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_INSTALL_REF= NEMOCLAW_INSTALL_TAG=lkg bash",
    );
    expect(updateSource).not.toContain(
      "https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_INSTALL_TAG=lkg bash",
    );
    expect(promptSource).not.toContain("NEMOCLAW_INSTALL_TAG=<git-ref>");
    expect(quickstartSource).not.toContain("NEMOCLAW_INSTALL_TAG=<git-ref>");
  });

  it("rejects missing or stale generated snippets and accepts the current output (#5048)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-starter-prompt-"));
    const generatedPath = path.join(tempDir, "StarterPrompt.generated.mdx");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const runCheck = () =>
      runStarterPromptGenerator({
        args: ["--check"],
        generatedPath,
        log: (message) => stdout.push(message),
        reportError: (message) => stderr.push(message),
      });

    try {
      const missing = runCheck();
      expect(missing).toBe(1);
      expect(stderr.at(-1)).toContain("is missing or stale");

      fs.writeFileSync(generatedPath, "stale\n");
      const stale = runCheck();
      expect(stale).toBe(1);
      expect(stderr.at(-1)).toContain("is missing or stale");

      fs.writeFileSync(generatedPath, generateStarterPromptSnippet());
      const current = runCheck();
      expect(current).toBe(0);
      expect(stdout.at(-1)).toBe("Generated Starter Prompt snippet is current.");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // source-shape-contract: compatibility -- Docs entry points must generate the Starter Prompt before Fern validation and rendering
  it("prepares the Starter Prompt in every docs build entry point (#5048)", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> })
      .scripts;

    expect(scripts["docs:sync-starter-prompt"]).toBe("tsx scripts/generate-starter-prompt.mts");
    expect(scripts["docs:prepare"]).toBe(
      "npm run docs:sync-starter-prompt && tsx scripts/sync-agent-variant-docs.mts",
    );
    expect(scripts["docs:sync-agent-variants"]).toBe("npm run docs:prepare");
    expect(scripts["docs:validate"]).toContain("npm run docs:check-starter-prompt");
    expect(scripts["docs:strict"]).toBe("npm run docs:prepare && npm run docs:validate");
    expect(scripts["docs:live"]).toMatch(/^npm run docs:prepare &&/);

    for (const workflowPath of [
      ".github/workflows/docs-preview-pr.yaml",
      ".github/workflows/docs-publish-staging.yaml",
      ".github/workflows/docs-publish-public.yaml",
    ]) {
      expect(read(workflowPath), `${workflowPath} prepares generated docs before Fern`).toContain(
        "npm run docs:prepare",
      );
      expect(read(workflowPath), `${workflowPath} validates generated docs before Fern`).toContain(
        "npm run docs:validate",
      );
    }

    for (const workflowPath of [
      ".github/workflows/docs-preview-pr.yaml",
      ".github/workflows/docs-publish-staging.yaml",
    ]) {
      expect(read(workflowPath), `${workflowPath} runs when the generator changes`).toContain(
        '- "scripts/generate-starter-prompt.mts"',
      );
    }
  });

  it("pins local credential capture to the checked-in helper and form (#5048)", () => {
    const promptSource = readStarterPrompt();
    const formSource = fs.readFileSync(localCredentialFormSource, "utf8");

    expect(promptSource).toContain(localCredentialHelperUrl);
    expect(promptSource).toContain(localCredentialHelperSha256);
    expect(promptSource).toContain(localCredentialFormUrl);
    expect(promptSource).toContain(localCredentialFormSha256);
    expect(createHash("sha256").update(formSource).digest("hex")).toBe(localCredentialFormSha256);
    expect(localCredentialHelperUrl).toMatch(/\/[0-9a-f]{40}\//);
    expect(localCredentialHelperUrl).not.toMatch(/\/(?:main|master)\//);
    expect(localCredentialFormUrl).toMatch(/\/[0-9a-f]{40}\//);
    expect(localCredentialFormUrl).not.toMatch(/\/(?:main|master)\//);
    expect(promptSource).toContain("Do not generate, rewrite, or redesign the helper or form.");
    expect(promptSource).toContain(
      "two immutable URL and digest pairs as one reviewed trust boundary",
    );
    expect(promptSource).toContain(
      "before executing the helper, compute the SHA-256 digest of both downloaded files and compare each result with its pinned digest",
    );
    expect(promptSource).toContain(
      "If either digest differs, do not execute the helper; delete both temporary files and stop.",
    );
    expect(promptSource).toContain("exact environment-variable names and exact command argv");
    expect(promptSource).toContain("--field NAME:type");
    expect(promptSource).toContain("--execution-profile isolated");
    expect(promptSource).toContain("--execution-profile account-home --cwd");
    expect(promptSource).toContain("Never put credentials in argv");
    expect(promptSource).toContain("Confirm and Run Approved Command");
    expect(promptSource).toContain("do not retry or resubmit");
    expect(promptSource).toContain("exposure minimization, not guaranteed erasure");
    expect(promptSource).toContain(
      "Keep the helper bound to `http://127.0.0.1`, accept only one valid submission, and run only the already-approved command.",
    );
    expect(promptSource).toContain(
      "Prefer letting an account-persistent command use its own reviewed secure credential prompt when available.",
    );
    expect(promptSource).toContain(
      "use the reviewed helper only with an already-downloaded and verified installer",
    );
    expect(promptSource).toContain("Do not hand-assemble a `curl | bash` wrapper");
    // The slim prompt delegates install-time credential mechanics to the helper and installer;
    // guard against the prose curl | bash wrapper synthesis creeping back into the copied prompt.
    expect(promptSource).not.toContain("<absolute-bash-path> -c");
    expect(promptSource).not.toContain("non-exported shell variable");
    expect(promptSource).not.toContain("unsets the exported credential before starting");
    expect(formSource).toContain("<title>NemoClaw Local Credential Form</title>");
    expect(formSource).toContain("Content-Security-Policy");
    expect(formSource).toContain("connect-src 'self';");
    expect(formSource).not.toContain("'unsafe-inline'");
    expect(formSource).toContain(`script-src ${localCredentialFormScriptCspHash};`);
    expect(formSource).toContain(`style-src ${localCredentialFormStyleCspHash};`);
    expect(formSource).toContain(
      `style-src ${sha256Source(extractTagContent(formSource, "style"))};`,
    );
    expect(formSource).toContain(
      `script-src ${sha256Source(extractTagContent(formSource, "script"))};`,
    );
    expect(cspMetaContent(formSource)).not.toContain("frame-ancestors");
    expect(formSource).toContain('const LOCAL_SUBMIT_PATH = "/submit";');
    expect(formSource).toContain("fetch(LOCAL_SUBMIT_PATH");
    expect(formSource).not.toContain('params.get("submit")');
    for (const url of urlsIn(formSource)) {
      expect(["127.0.0.1", "localhost", "[::1]"], url.href).toContain(url.hostname);
    }
    expect(formSource).not.toContain("localStorage");
    expect(formSource).not.toContain("sessionStorage");
  });

  it("preserves safe remote credentials, administrator access, and Ollama eligibility (#6990)", () => {
    const promptSource = readStarterPrompt();

    expect(promptSource).toContain(
      "Preserve its scheme, host, port, `/local-credential-form.html` path, complete `field=` query string, and `#cap=` fragment exactly.",
    );
    expect(promptSource).toContain("`ssh -N -L <port>:127.0.0.1:<port> <username>@<host>`");
    expect(promptSource).toContain(
      "Require the same port on both sides; do not remap the helper to another local port.",
    );
    expect(promptSource).not.toContain("<local-port>:127.0.0.1:<remote-port>");

    expect(promptSource).toContain("`NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt`");
    expect(promptSource).toContain(
      "If neither passwordless sudo nor a secure password prompt is available, stop before the affected install or system change.",
    );
    expect(promptSource).toContain(
      "Let the real `sudo` program collect the password; never use chat or the API-key form for the computer password.",
    );

    expect(promptSource).toContain(
      "Offer Local Ollama for OpenClaw or Hermes when it is installed, running, or officially installable.",
    );
    expect(promptSource).toContain(
      "Do not offer Local Ollama for Deep Agents unless current official documentation adds support.",
    );
    expect(promptSource).toContain(
      "Do not hide Ollama merely because the computer is not DGX or GB300.",
    );
    expect(promptSource).toContain("OpenRouter: `NEMOCLAW_PROVIDER=openrouter`");
    expect(promptSource).toContain("Existing vLLM: `NEMOCLAW_PROVIDER=vllm`");
  });

  it("keeps local prompt assets byte-aligned with their pinned revision blobs (#6990)", () => {
    resolvePromptAssetRevision(promptAssetRevision, runGit);
    for (const asset of Object.values(promptAssets)) {
      const localBytes = fs.readFileSync(path.join(repoRoot, asset.path));
      const pinnedBytes = readPinnedPromptAssetBlob(promptAssetRevision, asset, runGit);
      const pinnedSha256 = createHash("sha256").update(pinnedBytes).digest("hex");

      expect(asset.pinnedSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(
        localBytes.equals(pinnedBytes),
        `${asset.path} does not byte-match its Git blob at ${promptAssetRevision}; commit the asset content, then repin every platform URL, promptAssetRevision, and digest to that content commit`,
      ).toBe(true);
      expect(pinnedSha256, `${asset.path} has a stale pinned SHA-256`).toBe(asset.pinnedSha256);
    }
  });

  it("fails closed when the immutable prompt asset revision or blobs cannot be resolved (#6990)", () => {
    expect(() => resolvePromptAssetRevision("main", () => fail("git must not run"))).toThrow(
      "promptAssetRevision must be a full lowercase commit SHA",
    );

    const fetchedRevisionResults = [
      { status: 1, stdout: Buffer.alloc(0) },
      { status: 0, stdout: Buffer.alloc(0) },
      { status: 0, stdout: Buffer.from("commit\n") },
    ];
    const fetchedRevision: GitRunner = () =>
      fetchedRevisionResults.shift() ?? fail("unexpected immutable-revision Git command");
    expect(() => resolvePromptAssetRevision(promptAssetRevision, fetchedRevision)).not.toThrow();
    expect(fetchedRevisionResults).toEqual([]);

    const unavailableRevision: GitRunner = (args) => ({
      status: args[0] === "fetch" ? 128 : 1,
      stdout: Buffer.alloc(0),
    });
    expect(() => resolvePromptAssetRevision(promptAssetRevision, unavailableRevision)).toThrow(
      `could not fetch immutable prompt asset revision ${promptAssetRevision}`,
    );

    expect(() =>
      resolvePromptAssetRevision(promptAssetRevision, () => ({
        status: 0,
        stdout: Buffer.from("tree\n"),
      })),
    ).toThrow("promptAssetRevision must resolve to a commit object");

    expect(() =>
      readPinnedPromptAssetBlob(promptAssetRevision, promptAssets.dgxSpark, () => ({
        status: 0,
        stdout: Buffer.alloc(0),
      })),
    ).toThrow("must contain exactly one regular prompt asset blob");

    const malformedBlobOid = "a".repeat(40);
    const malformedBlob: GitRunner = (args) => ({
      status: 0,
      stdout:
        args[0] === "ls-tree"
          ? Buffer.from(`100644 blob ${malformedBlobOid}\t${promptAssets.dgxSpark.path}\0`)
          : Buffer.from("tree\n"),
    });
    expect(() =>
      readPinnedPromptAssetBlob(promptAssetRevision, promptAssets.dgxSpark, malformedBlob),
    ).toThrow("does not resolve to a readable Git blob");
  });

  it("routes platform-only installation instructions to raw prompt assets (#6990)", () => {
    const promptSource = readStarterPrompt();
    const sparkSource = readPromptAsset(promptAssets.dgxSpark);
    const stationSource = readPromptAsset(promptAssets.dgxStation);
    const windowsSource = readPromptAsset(promptAssets.windowsWsl);

    expect(promptAssetRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(requireExpectedPromptAssetRoutes(promptSource, platformPromptAssetRoutes)).toEqual(
      new Map(platformPromptAssetRoutes.map(({ asset, label }) => [label, asset.url])),
    );
    for (const asset of Object.values(promptAssets)) {
      expect(promptSource).toContain(asset.url);
      const assetUrl = new URL(asset.url);
      expect(assetUrl.origin).toBe("https://raw.githubusercontent.com");
      expect(assetUrl.pathname).toMatch(
        /^\/NVIDIA\/NemoClaw\/[0-9a-f]{40}\/docs\/resources\/prompt-assets\/[^/]+\.md$/,
      );
      expect(assetUrl.pathname).toContain(`/${promptAssetRevision}/`);
    }

    expect(promptSource).toContain("load exactly one matching instruction asset");
    expect(promptSource).toContain("Read the matching raw Markdown file completely");
    expect(promptSource).toContain("Do not load a platform asset for any other computer.");
    expect(promptSource).not.toContain("approximately 352 GB");
    expect(promptSource).not.toContain("NEMOCLAW_PROVIDER=install-windows-ollama");
    expect(promptSource).not.toContain(
      "NEMOCLAW_VLLM_MODEL=nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
    );

    expect(sparkSource).toContain("nvidia/Qwen3.6-35B-A3B-NVFP4");
    expect(sparkSource).toContain("Leave `NEMOCLAW_VLLM_MODEL` and `NEMOCLAW_MODEL` unset");
    expect(stationSource).toContain("`nemotron-3-ultra-550b-a55b`");
    expect(stationSource).toContain("`nvidia/nemotron-3-ultra-550b-a55b`");
    expect(stationSource).toContain("`deepseek-v4-flash`");
    expect(stationSource).toContain("`deepseek-ai/DeepSeek-V4-Flash`");
    expect(stationSource).toContain("Nemotron 3 Ultra 550B, the ordinary installer default");
    expect(stationSource).toContain(
      "DeepSeek V4 Flash, the explicit `--station-deepseek` override",
    );
    expect(stationSource).not.toContain("provider-preseeded DeepSeek path");
    expect(stationSource).not.toContain("only supported next step");
    expect(stationSource).toContain("model-cache filesystem and Docker storage");
    expect(stationSource).toContain(
      "Do not run `scripts/prepare-dgx-station-host.sh --check`, `--verify`, or `--apply` separately",
    );
    expect(stationSource).toContain("For Nemotron Ultra, run the ordinary installer without");
    expect(stationSource).toContain("For DeepSeek, pass `--station-deepseek`");
    for (const environmentName of [
      "NEMOCLAW_PROVIDER",
      "NEMOCLAW_VLLM_MODEL",
      "NEMOCLAW_MODEL",
      "NEMOCLAW_NON_INTERACTIVE",
      "NEMOCLAW_YES",
      "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
      "NEMOCLAW_NO_EXPRESS",
    ]) {
      expect(stationSource).toContain(`\`${environmentName}\``);
    }
    expect(stationSource).toContain(
      "Let the installer present its third-party-software notice and complete Express summary.",
    );
    expect(stationSource).toContain("Run the installer only in a secure interactive terminal");
    expect(stationSource).toContain("Keep each official confirmation visible");
    expect(stationSource).toContain("evaluation path with deferred end-to-end validation");
    expect(stationSource).toContain("startup may still fail after readiness checks");
    expect(stationSource).toContain("third-party-software notice");
    expect(windowsSource).toContain("NEMOCLAW_PROVIDER=install-windows-ollama");
    expect(windowsSource).toContain("Do not start a second Ollama service on the same port.");
  });

  it("rejects platform labels whose pinned prompt asset URLs are swapped (#6990)", () => {
    const promptSource = readStarterPrompt();
    const sparkUrlMarker = "__DGX_SPARK_PROMPT_ASSET_URL__";
    const swappedRoutes = promptSource
      .replace(promptAssets.dgxSpark.url, sparkUrlMarker)
      .replace(promptAssets.dgxStation.url, promptAssets.dgxSpark.url)
      .replace(sparkUrlMarker, promptAssets.dgxStation.url);

    expect(() =>
      requireExpectedPromptAssetRoutes(swappedRoutes, platformPromptAssetRoutes),
    ).toThrow(`Confirmed DGX Spark must map to ${promptAssets.dgxSpark.url}`);
  });

  it("uses approved platform defaults without collecting optional onboarding choices (#6990)", () => {
    const promptSource = readStarterPrompt();
    const platformAssets = [
      readPromptAsset(promptAssets.dgxSpark),
      readPromptAsset(promptAssets.windowsWsl),
    ];
    const expressAssets = [
      readPromptAsset(promptAssets.dgxSpark),
      readPromptAsset(promptAssets.windowsWsl),
    ];
    const stationSource = readPromptAsset(promptAssets.dgxStation);

    expect(promptSource).toContain(
      "Next ask which agent I want: OpenClaw, Hermes, or LangChain Deep Agents Code.",
    );
    expect(promptSource).toContain("Skip messaging for Deep Agents.");
    expect(promptSource).toContain(
      "If a loaded platform asset selects its approved install path, follow its policy requirement and skip the policy-tier question.",
    );
    expect(promptSource).toContain(
      "For installation outside an accepted platform-asset path, ask for Balanced, Restricted, or Open policy.",
    );
    expect(promptSource).toContain(
      "When a platform asset delegates consent to the official installer, let the installer present its notice and final Express confirmation instead of pre-accepting them.",
    );
    expect(promptSource).toContain(
      "Ask for final permission before installation outside an accepted platform-asset path.",
    );
    expect(promptSource).not.toContain("\n- Ask for Balanced, Restricted, or Open policy.\n");

    for (const assetSource of platformAssets) {
      expect(assetSource).toContain(
        "`NEMOCLAW_NON_INTERACTIVE=1`, `NEMOCLAW_NON_INTERACTIVE_SUDO_MODE=prompt`, `NEMOCLAW_YES=1`, and `NEMOCLAW_POLICY_MODE=suggested`",
      );
      expect(assetSource).toContain(
        "Set `NEMOCLAW_AGENT` to the agent already selected in the starter prompt.",
      );
      expect(assetSource).toContain(
        "Leave `NEMOCLAW_SANDBOX_NAME`, `NEMOCLAW_POLICY_TIER`, web-search settings, and messaging settings unset",
      );
      expect(assetSource).toContain(
        "Do not ask again for the agent or ask separate questions for model, sandbox name, web search, messaging, policy, download approval, or final installation approval.",
      );
      expect(assetSource).not.toContain("NEMOCLAW_POLICY_TIER=balanced");
    }

    for (const assetSource of expressAssets) {
      expect(assetSource).toContain(
        "Set `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1` when Express is accepted.",
      );
      expect(assetSource).toContain("Treat the Express confirmation as approval");
      const noticeIndex = assetSource.indexOf("Include the third-party-software notice");
      const confirmationIndex = assetSource.indexOf("Choices:");
      const acceptanceIndex = assetSource.indexOf("Set `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1`");
      expect(noticeIndex).toBeGreaterThan(-1);
      expect(confirmationIndex).toBeGreaterThan(noticeIndex);
      expect(acceptanceIndex).toBeGreaterThan(confirmationIndex);
    }

    expect(stationSource).toContain(
      "Use the selected maintained release's official installer as the authority",
    );
    expect(stationSource).toContain(
      "Set `NEMOCLAW_AGENT` to the agent already selected in the starter prompt.",
    );
    expect(stationSource).not.toContain("`NEMOCLAW_NON_INTERACTIVE=1`");
    expect(stationSource).not.toContain("Set `NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1`");
    expect(stationSource).not.toContain("Set `NEMOCLAW_PROVIDER=install-vllm`");

    const stationDisclosureIndex = stationSource.indexOf("On generic Ubuntu, Station Express");
    const stationDockerGroupIndex = stationSource.indexOf(
      "`docker` group, which grants root-equivalent control",
    );
    const stationRebootIndex = stationSource.indexOf("operator-controlled reboot");
    const stationNoticeIndex = stationSource.indexOf(
      "Let the installer present its third-party-software notice",
    );
    const stationConfirmationIndex = stationSource.indexOf("Choices:");
    const stationDefaultIndex = stationSource.indexOf(
      "For Nemotron Ultra, run the ordinary installer without",
    );
    const stationOverrideIndex = stationSource.indexOf("For DeepSeek, pass `--station-deepseek`");
    expect(stationDisclosureIndex).toBeGreaterThan(-1);
    expect(stationDockerGroupIndex).toBeGreaterThan(stationDisclosureIndex);
    expect(stationRebootIndex).toBeGreaterThan(stationDockerGroupIndex);
    expect(stationConfirmationIndex).toBeGreaterThan(stationRebootIndex);
    expect(stationDefaultIndex).toBeGreaterThan(stationConfirmationIndex);
    expect(stationOverrideIndex).toBeGreaterThan(stationDefaultIndex);
    expect(stationNoticeIndex).toBeGreaterThan(stationOverrideIndex);
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

  it("keeps Deep Agents as a selectable starter prompt option (#5048)", () => {
    const promptSource = readStarterPrompt();

    expect(promptSource).toContain("3. LangChain Deep Agents Code.");
    expect(promptSource).toContain("https://docs.nvidia.com/nemoclaw/llms.txt");
    expect(promptSource).toContain(
      "https://docs.nvidia.com/nemoclaw/latest/user-guide/openclaw/get-started/quickstart.md",
    );
    expect(promptSource).toContain(
      "https://docs.nvidia.com/nemoclaw/latest/user-guide/hermes/get-started/quickstart.md",
    );
    expect(promptSource).toContain(
      "https://docs.nvidia.com/nemoclaw/latest/user-guide/deepagents/get-started/quickstart.md",
    );
    expect(promptSource).toContain("NEMOCLAW_AGENT=langchain-deepagents-code");
    expect(promptSource).toContain("nemo-deepagents onboard");
  });
});
