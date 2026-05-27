// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory fs shared with the mocked module.
const store = new Map<string, string>();
const mtimes = new Map<string, number>();
const sizes = new Map<string, number>();
let nextMtime = 1;
let existsCalls: string[] = [];
let statCalls: string[] = [];
let nowMs = 1_000;

vi.spyOn(Date, "now").mockImplementation(() => nowMs);

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    existsSync: (p: string) => {
      existsCalls.push(p);
      return store.has(p);
    },
    readFileSync: (p: string) => {
      const content = store.get(p);
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return content;
    },
    statSync: (p: string) => {
      statCalls.push(p);
      const mtimeMs = mtimes.get(p);
      if (mtimeMs === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return { mtimeMs, size: sizes.get(p) ?? 0 } as fs.Stats;
    },
  };
});

const { getNetworkEntries, getPrivateNetworks, isPrivateHostname, resetCache } = await import(
  "./private-networks.js"
);

const VALID_YAML = `
ipv4:
  - address: 10.0.0.0
    prefix: 8
    purpose: Private network
  - address: 127.0.0.0
    prefix: 8
    purpose: Loopback
ipv6:
  - address: "::1"
    prefix: 128
    purpose: Loopback
  - address: "fe80::"
    prefix: 10
    purpose: Link-local
names:
  - name: localhost
    purpose: Loopback special-use name
`;

function seedYaml(path: string, body: string): void {
  store.set(path, body);
  mtimes.set(path, nextMtime);
  sizes.set(path, body.length);
  nextMtime += 1;
}

function replaceYamlKeepingMtime(path: string, body: string): void {
  const mtimeMs = mtimes.get(path);
  if (mtimeMs === undefined) throw new Error(`missing seeded mtime for ${path}`);
  store.set(path, body);
  mtimes.set(path, mtimeMs);
  sizes.set(path, body.length);
}

function advanceStatInterval(): void {
  nowMs += 1_000;
}

describe("private-networks loader", () => {
  beforeEach(() => {
    store.clear();
    mtimes.clear();
    sizes.clear();
    nextMtime = 1;
    existsCalls = [];
    statCalls = [];
    nowMs = 1_000;
    delete process.env.NEMOCLAW_BLUEPRINT_PATH;
    resetCache();
  });

  describe("resolveBlueprintPath", () => {
    it("honours NEMOCLAW_BLUEPRINT_PATH when set", () => {
      process.env.NEMOCLAW_BLUEPRINT_PATH = "/custom/path";
      seedYaml("/custom/path/private-networks.yaml", VALID_YAML);
      const entries = getNetworkEntries();
      expect(entries.ipv4).toHaveLength(2);
      // resolveBlueprintPath's dev-guess probe is skipped when the env var is set.
      expect(existsCalls).toEqual([]);
    });

    it("throws a descriptive error when the YAML is missing", () => {
      process.env.NEMOCLAW_BLUEPRINT_PATH = "/missing/path";
      expect(() => getNetworkEntries()).toThrow(
        /private-networks\.yaml not found at \/missing\/path\/private-networks\.yaml.*NEMOCLAW_BLUEPRINT_PATH/s,
      );
    });

    it("throws the descriptive error when the YAML disappears between stat and read", () => {
      process.env.NEMOCLAW_BLUEPRINT_PATH = "/blueprint";
      seedYaml("/blueprint/private-networks.yaml", VALID_YAML);
      store.delete("/blueprint/private-networks.yaml");

      expect(() => getNetworkEntries()).toThrow(
        /private-networks\.yaml not found at \/blueprint\/private-networks\.yaml.*NEMOCLAW_BLUEPRINT_PATH/s,
      );
    });

    it("falls back to current directory when no env var and no dev guess", () => {
      seedYaml("private-networks.yaml", VALID_YAML);
      const entries = getNetworkEntries();
      expect(entries.ipv6).toHaveLength(2);
    });

    it("prefers the dev-checkout guess over cwd when the yaml is present", () => {
      // existsSync returns true iff the path is in the store. The
      // loader probes <devGuess>/private-networks.yaml — seed only
      // cwd first to learn that probe path, then re-seed with the
      // probe path populated so the loader prefers it over cwd.
      seedYaml(
        "private-networks.yaml",
        "ipv4:\n  - address: 8.8.8.0\n    prefix: 24\n    purpose: cwd sentinel\nipv6: []\nnames: []\n",
      );
      getNetworkEntries();
      const probedFile = existsCalls[0];
      expect(probedFile).toBeDefined();
      expect(probedFile.endsWith("/private-networks.yaml")).toBe(true);

      store.clear();
      resetCache();
      existsCalls = [];
      seedYaml(
        "private-networks.yaml",
        "ipv4:\n  - address: 8.8.8.0\n    prefix: 24\n    purpose: cwd sentinel\nipv6: []\nnames: []\n",
      );
      seedYaml(probedFile, VALID_YAML);
      const entries = getNetworkEntries();
      expect(entries.ipv4[0].address).toBe("10.0.0.0");
    });

    it("falls back to cwd when the dev-guess yaml is missing", () => {
      // A stale dev checkout (directory present, yaml absent) must not
      // be selected — otherwise load() fails on readFileSync instead
      // of falling through to cwd.
      seedYaml(
        "private-networks.yaml",
        "ipv4:\n  - address: 8.8.8.0\n    prefix: 24\n    purpose: cwd fallback\nipv6: []\nnames: []\n",
      );
      const entries = getNetworkEntries();
      expect(entries.ipv4[0].address).toBe("8.8.8.0");
    });
  });

  describe("schema validation", () => {
    beforeEach(() => {
      process.env.NEMOCLAW_BLUEPRINT_PATH = "/blueprint";
    });

    it("rejects a document missing the ipv4 array", () => {
      seedYaml("/blueprint/private-networks.yaml", "ipv6: []\nnames: []\n");
      expect(() => getNetworkEntries()).toThrow(
        /expected top-level 'ipv4', 'ipv6', and 'names' arrays/,
      );
    });

    it("rejects a document where ipv4 is not an array", () => {
      seedYaml("/blueprint/private-networks.yaml", "ipv4: notanarray\nipv6: []\nnames: []\n");
      expect(() => getNetworkEntries()).toThrow(
        /expected top-level 'ipv4', 'ipv6', and 'names' arrays/,
      );
    });

    it("rejects a document missing the names array", () => {
      seedYaml("/blueprint/private-networks.yaml", "ipv4: []\nipv6: []\n");
      expect(() => getNetworkEntries()).toThrow(
        /expected top-level 'ipv4', 'ipv6', and 'names' arrays/,
      );
    });

    it("rejects an ipv4 entry that is not an object", () => {
      seedYaml("/blueprint/private-networks.yaml", "ipv4:\n  - 42\nipv6: []\nnames: []\n");
      expect(() => getNetworkEntries()).toThrow(/expected an object/);
    });

    it("rejects an ipv4 entry missing address", () => {
      seedYaml(
        "/blueprint/private-networks.yaml",
        "ipv4:\n  - prefix: 8\n    purpose: orphan\nipv6: []\nnames: []\n",
      );
      expect(() => getNetworkEntries()).toThrow(/missing or empty 'address'/);
    });

    it("rejects an ipv4 entry with non-integer prefix", () => {
      seedYaml(
        "/blueprint/private-networks.yaml",
        "ipv4:\n  - address: 10.0.0.0\n    prefix: 8.5\n    purpose: fractional\nipv6: []\nnames: []\n",
      );
      expect(() => getNetworkEntries()).toThrow(/'prefix' must be an integer in \[0, 32\]/);
    });

    it("rejects an ipv4 entry with a negative prefix", () => {
      seedYaml(
        "/blueprint/private-networks.yaml",
        "ipv4:\n  - address: 10.0.0.0\n    prefix: -1\n    purpose: negative\nipv6: []\nnames: []\n",
      );
      expect(() => getNetworkEntries()).toThrow(/'prefix' must be an integer in \[0, 32\]/);
    });

    it("rejects an ipv4 entry with prefix above 32", () => {
      seedYaml(
        "/blueprint/private-networks.yaml",
        "ipv4:\n  - address: 10.0.0.0\n    prefix: 33\n    purpose: too-wide\nipv6: []\nnames: []\n",
      );
      expect(() => getNetworkEntries()).toThrow(/'prefix' must be an integer in \[0, 32\]/);
    });

    it("rejects an ipv6 entry with prefix above 128", () => {
      seedYaml(
        "/blueprint/private-networks.yaml",
        'ipv4: []\nipv6:\n  - address: "::1"\n    prefix: 129\n    purpose: too-wide\nnames: []\n',
      );
      expect(() => getNetworkEntries()).toThrow(/'prefix' must be an integer in \[0, 128\]/);
    });

    it("rejects an ipv4 entry whose address parses as ipv6", () => {
      seedYaml(
        "/blueprint/private-networks.yaml",
        'ipv4:\n  - address: "::1"\n    prefix: 8\n    purpose: wrong-family\nipv6: []\nnames: []\n',
      );
      expect(() => getNetworkEntries()).toThrow(/'address' must be a valid ipv4 literal/);
    });

    it("rejects an ipv6 entry whose address parses as ipv4", () => {
      seedYaml(
        "/blueprint/private-networks.yaml",
        "ipv4: []\nipv6:\n  - address: 10.0.0.0\n    prefix: 8\n    purpose: wrong-family\nnames: []\n",
      );
      expect(() => getNetworkEntries()).toThrow(/'address' must be a valid ipv6 literal/);
    });

    it("rejects an entry whose address is not a valid IP literal", () => {
      seedYaml(
        "/blueprint/private-networks.yaml",
        "ipv4:\n  - address: not-an-ip\n    prefix: 8\n    purpose: malformed\nipv6: []\nnames: []\n",
      );
      expect(() => getNetworkEntries()).toThrow(/'address' must be a valid ipv4 literal/);
    });

    it("rejects an ipv4 entry with an empty purpose", () => {
      seedYaml(
        "/blueprint/private-networks.yaml",
        'ipv4:\n  - address: 10.0.0.0\n    prefix: 8\n    purpose: "   "\nipv6: []\nnames: []\n',
      );
      expect(() => getNetworkEntries()).toThrow(/'purpose' must be a non-empty string/);
    });

    it("rejects a names entry missing the name field", () => {
      seedYaml(
        "/blueprint/private-networks.yaml",
        "ipv4: []\nipv6: []\nnames:\n  - purpose: orphan\n",
      );
      expect(() => getNetworkEntries()).toThrow(/missing or empty 'name'/);
    });

    it("rejects a names entry with empty purpose", () => {
      seedYaml(
        "/blueprint/private-networks.yaml",
        'ipv4: []\nipv6: []\nnames:\n  - name: localhost\n    purpose: ""\n',
      );
      expect(() => getNetworkEntries()).toThrow(/'purpose' must be a non-empty string/);
    });
  });

  describe("getPrivateNetworks and isPrivateHostname", () => {
    beforeEach(() => {
      process.env.NEMOCLAW_BLUEPRINT_PATH = "/blueprint";
      seedYaml("/blueprint/private-networks.yaml", VALID_YAML);
    });

    it("caches the BlockList across calls", () => {
      const first = getPrivateNetworks();
      const second = getPrivateNetworks();
      expect(first).toBe(second);
    });

    it("skips file metadata checks within the stat interval", () => {
      const first = getPrivateNetworks();
      const statCount = statCalls.length;
      seedYaml(
        "/blueprint/private-networks.yaml",
        "ipv4:\n  - address: 8.8.8.0\n    prefix: 24\n    purpose: inside stat interval\nipv6: []\nnames: []\n",
      );

      const second = getPrivateNetworks();

      expect(second).toBe(first);
      expect(statCalls).toHaveLength(statCount);
      expect(isPrivateHostname("8.8.8.1")).toBe(false);
    });

    it("resetCache forces a reload", () => {
      const before = getPrivateNetworks();
      resetCache();
      // Change the YAML so a reload can be detected through isPrivateHostname.
      seedYaml(
        "/blueprint/private-networks.yaml",
        "ipv4:\n  - address: 8.8.8.0\n    prefix: 24\n    purpose: after reset\nipv6: []\nnames: []\n",
      );
      const after = getPrivateNetworks();
      expect(after).not.toBe(before);
      expect(isPrivateHostname("8.8.8.1")).toBe(true);
      expect(isPrivateHostname("10.0.0.1")).toBe(false);
    });

    it("reloads when private-networks.yaml mtime changes", () => {
      const before = getPrivateNetworks();
      seedYaml(
        "/blueprint/private-networks.yaml",
        "ipv4:\n  - address: 8.8.8.0\n    prefix: 24\n    purpose: after mtime change\nipv6: []\nnames: []\n",
      );
      advanceStatInterval();

      const after = getPrivateNetworks();

      expect(after).not.toBe(before);
      expect(isPrivateHostname("8.8.8.1")).toBe(true);
      expect(isPrivateHostname("10.0.0.1")).toBe(false);
    });

    it("reloads when private-networks.yaml size changes without an mtime change", () => {
      const before = getPrivateNetworks();
      replaceYamlKeepingMtime(
        "/blueprint/private-networks.yaml",
        "ipv4:\n  - address: 8.8.8.0\n    prefix: 24\n    purpose: after size-only change with same mtime\nipv6: []\nnames: []\n",
      );
      advanceStatInterval();

      const after = getPrivateNetworks();

      expect(after).not.toBe(before);
      expect(isPrivateHostname("8.8.8.1")).toBe(true);
      expect(isPrivateHostname("10.0.0.1")).toBe(false);
    });

    it("returns true for localhost as a hostname", () => {
      expect(isPrivateHostname("localhost")).toBe(true);
    });

    it("strips IPv6 brackets before matching", () => {
      expect(isPrivateHostname("[::1]")).toBe(true);
      expect(isPrivateHostname("[fe80::1]")).toBe(true);
      expect(isPrivateHostname("[2606:4700::1]")).toBe(false);
    });

    it("returns false for a bare DNS name", () => {
      expect(isPrivateHostname("example.com")).toBe(false);
    });

    it("returns false for garbage input", () => {
      expect(isPrivateHostname("not-an-ip")).toBe(false);
      expect(isPrivateHostname("")).toBe(false);
    });
  });
});
