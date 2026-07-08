// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testTimeoutOptions } from "../../../test/helpers/timeouts";
import { runCurlProbe } from "../adapters/http/probe";
import { BACK_TO_SELECTION, isBackToSelection } from "./credential-navigation";
import { createWebSearchFlowHelpers } from "./web-search-flow";

vi.mock("../adapters/http/probe", () => ({
  runCurlProbe: vi.fn(() => ({
    ok: true,
    httpStatus: 200,
    curlStatus: 0,
    body: "{}",
    stderr: "",
    message: "ok",
  })),
}));

vi.mock("../runner", () => ({
  ROOT: "/tmp/nemoclaw-web-search-flow-test",
}));

function helpers(overrides: Record<string, unknown> = {}) {
  return createWebSearchFlowHelpers({
    prompt: async () => "",
    note: () => {},
    isNonInteractive: () => true,
    cliName: () => "nemoclaw",
    runCaptureOpenshell: () => null,
    ...overrides,
  });
}

describe("Brave key prompt empty-input escape (#6025)", () => {
  it("surfaces the back/exit hint on empty input and loops instead of dead-ending", async () => {
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      errors.push(String(message));
    });
    const responses = ["", "back"];
    let call = 0;
    const flow = createWebSearchFlowHelpers({
      prompt: async () => responses[call++] ?? "back",
      note: () => {},
      isNonInteractive: () => false,
      cliName: () => "nemoclaw",
      runCaptureOpenshell: () => null,
    });

    const result = await flow.promptBraveSearchApiKey();
    errSpy.mockRestore();

    expect(isBackToSelection(result)).toBe(true);
    expect(call).toBe(2);
    const errorText = errors.join("\n");
    expect(errorText).toContain("Brave Search API key is required.");
    // Assert both escape routes independently so the test fails if either the
    // "back" or the "exit" hint regresses, not just when both disappear (#6025).
    expect(errorText).toContain("back to choose a different option");
    expect(errorText).toContain("exit to quit");
  });
});

describe("web search provider validation", () => {
  beforeEach(() => {
    vi.mocked(runCurlProbe).mockReset();
    vi.mocked(runCurlProbe).mockReturnValue({
      ok: true,
      httpStatus: 200,
      curlStatus: 0,
      body: "{}",
      stderr: "",
      message: "ok",
    });
  });

  it.each([
    ["brave", "LF", "brv-good-prefix\nconfig = injected"],
    ["brave", "CR", "brv-good-prefix\rconfig = injected"],
    ["tavily", "LF", "tvly-good-prefix\nconfig = injected"],
    ["tavily", "CR", "tvly-good-prefix\rconfig = injected"],
  ] as const)(
    "rejects %s keys containing %s before writing a trusted curl config",
    testTimeoutOptions(15_000),
    (provider, _label, apiKey) => {
      const mkdtemp = vi.spyOn(fs, "mkdtempSync");

      try {
        const result = helpers().validateWebSearchApiKey(provider, apiKey);

        expect(result.ok).toBe(false);
        expect(result.message).toContain("must not contain line breaks");
        expect(runCurlProbe).not.toHaveBeenCalled();
        expect(mkdtemp).not.toHaveBeenCalled();
      } finally {
        mkdtemp.mockRestore();
      }
    },
  );

  it.each([
    ["brave", "brv-secret", "X-Subscription-Token: brv-secret"],
    ["tavily", "tvly-secret", "Authorization: Bearer tvly-secret"],
  ] as const)("keeps the %s key out of curl argv in a temporary 0600 config", (provider, apiKey, header) => {
    let configPath = "";
    vi.mocked(runCurlProbe).mockImplementationOnce((args, options) => {
      configPath = String(options?.trustedConfigFiles?.[0] ?? "");
      expect(configPath).not.toBe("");
      expect(args.join(" ")).not.toContain(apiKey);
      expect(args).toContain(configPath);
      const configFd = fs.openSync(
        configPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      try {
        expect(fs.fstatSync(configFd).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(configFd, "utf8")).toContain(header);
      } finally {
        fs.closeSync(configFd);
      }
      return {
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: "{}",
        stderr: "",
        message: "ok",
      };
    });

    expect(helpers().validateWebSearchApiKey(provider, apiKey).ok).toBe(true);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("uses a POST JSON probe for Tavily", () => {
    helpers().validateTavilySearchApiKey("tvly-secret");

    expect(runCurlProbe).toHaveBeenCalledWith(
      expect.arrayContaining([
        "--connect-timeout",
        "10",
        "--max-time",
        "15",
        "-X",
        "POST",
        "--data-raw",
        JSON.stringify({ query: "ping", max_results: 1 }),
        "https://api.tavily.com/search",
      ]),
      expect.objectContaining({ trustedConfigFiles: [expect.any(String)] }),
    );
  });
});

describe("web search provider selection", () => {
  beforeEach(() => {
    vi.mocked(runCurlProbe).mockReset();
    vi.mocked(runCurlProbe).mockReturnValue({
      ok: true,
      httpStatus: 200,
      curlStatus: 0,
      body: "{}",
      stderr: "",
      message: "ok",
    });
  });

  it("honors an explicit provider before implicit credential detection", () => {
    const env = {
      NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
      BRAVE_API_KEY: "brv-key",
      TAVILY_API_KEY: "tvly-key",
    };

    expect(helpers({ env }).resolveNonInteractiveWebSearchProvider()).toBe("tavily");
  });

  it("preserves Brave-first precedence when both credentials are configured implicitly", () => {
    const env = { BRAVE_API_KEY: "brv-key", TAVILY_API_KEY: "tvly-key" };

    expect(helpers({ env }).resolveNonInteractiveWebSearchProvider()).toBe("brave");
  });

  it("selects supported Tavily implicitly for Hermes when both credentials exist", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-web-search-"));
    const dockerfile = path.join(root, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0\nARG NEMOCLAW_WEB_SEARCH_PROVIDER=tavily\n",
    );
    const env = { BRAVE_API_KEY: "brv-unrelated", TAVILY_API_KEY: "tvly-key" };

    try {
      await expect(
        helpers({ env }).configureWebSearch(null, {
          name: "hermes",
          displayName: "Hermes",
          dockerfilePath: dockerfile,
        } as never),
      ).resolves.toEqual({ fetchEnabled: true, provider: "tavily" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips an explicitly unsupported Brave selection for Hermes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-brave-search-"));
    const dockerfile = path.join(root, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0\nARG NEMOCLAW_WEB_SEARCH_PROVIDER=tavily\n",
    );

    try {
      await expect(
        helpers({
          env: {
            NEMOCLAW_WEB_SEARCH_PROVIDER: "brave",
            BRAVE_API_KEY: "brv-key",
          },
        }).configureWebSearch(null, {
          name: "hermes",
          displayName: "Hermes",
          dockerfilePath: dockerfile,
        } as never),
      ).resolves.toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses saved credentials before host env values", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-web-search-config-"));
    const dockerfile = path.join(root, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      "ARG NEMOCLAW_WEB_SEARCH_ENABLED=0\nARG NEMOCLAW_WEB_SEARCH_PROVIDER=brave\n",
    );
    const saveCredential = vi.fn();
    const env = {
      NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
      TAVILY_API_KEY: "tvly-host",
    };
    const flow = helpers({
      env,
      getCredential: (envKey: string) => (envKey === "TAVILY_API_KEY" ? "tvly-saved" : null),
      saveCredential,
    });
    const processEnvValue = process.env.TAVILY_API_KEY;

    try {
      await expect(
        flow.configureWebSearch(null, { name: "openclaw", dockerfilePath: dockerfile } as never),
      ).resolves.toEqual({ fetchEnabled: true, provider: "tavily" });
      expect(saveCredential).toHaveBeenCalledWith("TAVILY_API_KEY", "tvly-saved");
      expect(env.TAVILY_API_KEY).toBe("tvly-saved");
      expect(process.env.TAVILY_API_KEY).toBe(processEnvValue);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("offers Brave and Tavily interactively and returns to the menu from a key prompt", async () => {
    const replies = ["3", "back", "2"];
    const flow = helpers({
      isNonInteractive: () => false,
      prompt: async () => replies.shift() ?? "",
    });

    await expect(flow.promptWebSearchProvider()).resolves.toBe("tavily");
    await expect(flow.promptWebSearchApiKey("tavily")).resolves.toBe(BACK_TO_SELECTION);
    await expect(flow.promptWebSearchProvider()).resolves.toBe("brave");
  });

  it("offers only Tavily when it is the agent's sole supported provider", async () => {
    const flow = helpers({
      isNonInteractive: () => false,
      prompt: async () => "2",
    });

    await expect(flow.promptWebSearchProvider(["tavily"])).resolves.toBe("tavily");
  });
});
