// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

/**
 * Shared mock mechanics for the blueprint runner test suites. Data builders
 * for blueprints live in runner-test-fixtures.ts; this module owns the
 * in-memory filesystem, stdout capture, and endpoint-validation shapes the
 * suites previously each declared inline. Helpers return fresh state per call
 * and never import vitest: tests pass their own spy wrapper where call
 * tracking is asserted.
 */

/** One entry in the in-memory filesystem store. */
export interface RunnerFsEntry {
  type: "file" | "dir";
  content?: string;
}

/** The home directory every runner suite mocks os.homedir() to. */
export const FAKE_HOME = "/fakehome";

/** The deterministic UUID every runner suite mocks crypto.randomUUID() to. */
export const FIXED_RUN_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** An in-memory filesystem store with its seeding helpers. */
export interface RunnerFsStore {
  store: Map<string, RunnerFsEntry>;
  addFile: (path: string, content: string) => void;
  addDir: (path: string) => void;
}

/** Creates a fresh in-memory filesystem store for one suite. */
export function createRunnerFsStore(): RunnerFsStore {
  const store = new Map<string, RunnerFsEntry>();
  return {
    store,
    addFile: (path, content) => void store.set(path, { type: "file", content }),
    addDir: (path) => void store.set(path, { type: "dir" }),
  };
}

function missingEntry(path: string): never {
  throw new Error(`ENOENT: ${path}`);
}

/** Behavior options for inMemoryFsMethods. */
export interface InMemoryFsOptions {
  /** Canonical-path overrides consulted by realpathSync before the store. */
  realpaths?: Map<string, string>;
  /** Wrapper applied to mutating methods so tests can track calls (pass vi.fn). */
  spy?: <T extends (...args: never[]) => unknown>(fn: T) => T;
}

/**
 * The full in-memory method set backed by store. Suites spread only the
 * methods they previously overrode, so untouched fs behavior stays real.
 */
export function inMemoryFsMethods(store: Map<string, RunnerFsEntry>, options?: InMemoryFsOptions) {
  const spy = options?.spy ?? (<T>(fn: T): T => fn);
  return {
    existsSync: (p: string) => store.has(p),
    mkdirSync: spy((p: string) => void store.set(p, { type: "dir" })),
    readFileSync: (p: string) => {
      const entry = store.get(p);
      return entry?.type === "file" ? (entry.content ?? "") : missingEntry(p);
    },
    writeFileSync: spy((p: string, data: string) => {
      store.set(p, { type: "file", content: String(data) });
    }),
    renameSync: spy((source: string, destination: string) => {
      const entry = store.get(source);
      if (!entry) return missingEntry(source);
      store.set(destination, entry);
      store.delete(source);
    }),
    readdirSync: (p: string) => {
      const prefix = p.endsWith("/") ? p : `${p}/`;
      const entries = new Set(
        [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length).split("/")[0])
          .filter((first): first is string => Boolean(first)),
      );
      return entries.size === 0 && !store.has(p) ? missingEntry(p) : [...entries].sort();
    },
    realpathSync: (p: string) => {
      const resolved = resolve(p);
      const mapped = options?.realpaths?.get(resolved);
      return mapped ?? (store.has(resolved) ? resolved : missingEntry(resolved));
    },
    statSync: (p: string) => ({
      isFile: () => store.get(resolve(p))?.type === "file",
    }),
  };
}

/** The resolution shape the runner's endpoint validator produces for url. */
export function resolvedEndpointFor(url: string) {
  return {
    url,
    pinnedUrl: url,
    protocol: url.startsWith("http:") ? ("http:" as const) : ("https:" as const),
    hostname: new URL(url).hostname,
    dnsResolved: false,
  };
}

/**
 * Collects process.stdout writes. The test owns the spy:
 * vi.spyOn(process.stdout, "write").mockImplementation(capture.write).
 */
export interface StdoutCapture {
  write: (chunk: string | Uint8Array) => boolean;
  text: () => string;
  /** Parsed JSON payload with RUN_ID: and PROGRESS: progress lines removed. */
  jsonOutput: <T = unknown>() => T;
  reset: () => void;
}

/** Creates a fresh stdout capture for one suite. */
export function createStdoutCapture(): StdoutCapture {
  const chunks: string[] = [];
  const text = (): string => chunks.join("");
  return {
    write: (chunk) => {
      chunks.push(String(chunk));
      return true;
    },
    text,
    jsonOutput: <T>(): T => {
      const json = text()
        .split("\n")
        .filter((line) => line && !line.startsWith("RUN_ID:") && !line.startsWith("PROGRESS:"))
        .join("\n");
      return JSON.parse(json) as T;
    },
    reset: () => {
      chunks.length = 0;
    },
  };
}
