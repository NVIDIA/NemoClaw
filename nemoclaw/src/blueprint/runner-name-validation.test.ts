// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Integration tests for the runner's fail-closed name validation. Kept in a
// focused file so runner.test.ts stays under the test-file-size budget. The
// mocks mirror runner.test.ts so these exercise the real apply/rollback paths.

import type fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FsEntry {
  type: "file" | "dir";
  content?: string;
}

/** Throw from an expression position so the fake fs stays branch-free. */
function raise(message: string): never {
  throw new Error(message);
}

const store = new Map<string, FsEntry>();

function addFile(p: string, content: string): void {
  store.set(p, { type: "file", content });
}

function addDir(p: string): void {
  store.set(p, { type: "dir" });
}

const FAKE_HOME = "/fakehome";

vi.mock("node:os", () => ({
  homedir: () => FAKE_HOME,
}));

vi.mock("node:crypto", () => ({
  randomUUID: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    existsSync: (p: string) => store.has(p),
    mkdirSync: vi.fn((p: string) => {
      addDir(p);
    }),
    readFileSync: (p: string) => {
      const entry = store.get(p);
      return entry?.type === "file" ? (entry.content ?? "") : raise(`ENOENT: ${p}`);
    },
    writeFileSync: vi.fn((p: string, data: string) => {
      store.set(p, { type: "file", content: data });
    }),
    readdirSync: (p: string) => {
      const prefix = p.endsWith("/") ? p : `${p}/`;
      const entries = new Set(
        [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length).split("/")[0])
          .filter((first): first is string => Boolean(first)),
      );
      return entries.size === 0 && !store.has(p) ? raise(`ENOENT: ${p}`) : [...entries].sort();
    },
  };
});

const mockExeca = vi.fn();
vi.mock("execa", () => ({
  execa: (...args: unknown[]) => mockExeca(...args),
}));

vi.mock("./ssrf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ssrf.js")>();
  return {
    ...actual,
    validateEndpointUrl: vi.fn(async (url: string) => ({
      url,
      pinnedUrl: url,
      protocol: url.startsWith("http:") ? "http:" : "https:",
      hostname: new URL(url).hostname,
      dnsResolved: false,
    })),
  };
});

const { actionApply, actionRollback } = await import("./runner.js");

const stdoutChunks: string[] = [];

function captureStdout(): void {
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
}

function minimalBlueprint(): Record<string, unknown> {
  return {
    version: "1.0",
    components: {
      inference: {
        profiles: {
          default: {
            provider_type: "openai",
            provider_name: "my-provider",
            endpoint: "https://api.example.com/v1",
            model: "gpt-4",
            credential_env: "MY_API_KEY",
          },
        },
      },
      sandbox: {
        image: "openclaw",
        name: "test-sandbox",
        forward_ports: [18789],
      },
      policy: { additions: {} },
    },
  };
}

function createCalls(): unknown[] {
  return mockExeca.mock.calls.filter(
    (c) => Array.isArray(c[1]) && c[1][0] === "sandbox" && c[1][1] === "create",
  );
}

type BlueprintComponents = {
  sandbox: { name: string };
  inference: { profiles: { default: { provider_name: string } } };
};

/** Each case corrupts one identifier so the table stays branch-free. */
const INVALID_NAME_CASES: ReadonlyArray<
  readonly [string, (components: BlueprintComponents) => void, RegExp]
> = [
  [
    "sandbox name",
    // "--help" would be consumed as a flag by `openshell sandbox create`.
    (components) => {
      components.sandbox.name = "--help";
    },
    /Invalid sandbox name/,
  ],
  [
    "provider name",
    (components) => {
      components.inference.profiles.default.provider_name = "$(id)";
    },
    /Invalid provider name/,
  ],
  [
    "provider name containing a line feed",
    (components) => {
      components.inference.profiles.default.provider_name = "provider\n::error::forged";
    },
    /Invalid provider name/,
  ],
  [
    "over-length provider name",
    (components) => {
      components.inference.profiles.default.provider_name = `a${"b".repeat(128)}`;
    },
    /Invalid provider name/,
  ],
];

const VALID_PROVIDER_NAMES = ["Provider_1.prod", `a${"b".repeat(127)}`] as const;

describe("blueprint name validation (fail-closed integration)", () => {
  const RUNS_DIR = `${FAKE_HOME}/.nemoclaw/state/runs`;

  beforeEach(() => {
    store.clear();
    stdoutChunks.length = 0;
    vi.clearAllMocks();
    captureStdout();
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(
    INVALID_NAME_CASES,
  )("apply rejects a malformed %s and creates no sandbox", async (_label, corrupt, expected) => {
    const bp = minimalBlueprint();
    corrupt(bp.components as BlueprintComponents);

    await expect(actionApply("default", bp)).rejects.toThrow(expected);
    // Validation runs before any command, so no provider or sandbox command
    // may have executed — not merely no sandbox create.
    expect(mockExeca).not.toHaveBeenCalled();
    expect(createCalls()).toEqual([]);
  });

  it.each(
    VALID_PROVIDER_NAMES,
  )("apply accepts the supported provider name '%s'", async (providerName) => {
    const bp = minimalBlueprint();
    const components = bp.components as BlueprintComponents;
    components.inference.profiles.default.provider_name = providerName;

    await expect(actionApply("default", bp)).resolves.toBeUndefined();
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      expect.arrayContaining(["provider", "create", "--name", providerName]),
      expect.any(Object),
    );
  });

  it("rollback rejects a plan whose sandbox_name is not an RFC 1035 label", async () => {
    const runDir = `${RUNS_DIR}/nc-run-1`;
    addDir(runDir);
    // "--rm" would be consumed as a flag by `openshell sandbox stop/remove`.
    addFile(`${runDir}/plan.json`, JSON.stringify({ sandbox_name: "--rm" }));

    await expect(actionRollback("nc-run-1")).rejects.toThrow(/Invalid sandbox name/);
    expect(mockExeca).not.toHaveBeenCalled();
    expect(store.has(`${runDir}/rolled_back`)).toBe(false);
  });
});
