// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { Server } from "node:net";
import os from "node:os";
import path from "node:path";

import { test as base, describe, expect } from "vitest";

import { ownChildProcess } from "./child-process-lifecycle";

type Cleanup = {
  label: string;
  run: () => Promise<void> | void;
};

export type OwnedTestHome = {
  home: string;
  bin: string;
  environment: (overrides?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

function createServerCleanup(server: Server): () => Promise<void> {
  let hasListened = server.listening;
  let hasClosed = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const onListening = (): void => {
    hasListened = true;
  };
  const onClose = (): void => {
    hasClosed = true;
    server.off("listening", onListening);
    resolveClosed();
  };
  server.on("listening", onListening);
  server.once("close", onClose);

  return async () => {
    if (hasClosed) return;
    if (!server.listening) {
      if (hasListened) await closed;
      else {
        server.off("listening", onListening);
        server.off("close", onClose);
      }
      return;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" || !hasListened)
        throw error;
      await closed;
    }
  };
}

export class OwnedTestResources {
  readonly #cleanups: Cleanup[] = [];

  ownDirectory(directory: string): string {
    this.#cleanups.push({
      label: `temporary directory ${directory}`,
      run: () =>
        fs.rmSync(directory, {
          force: true,
          maxRetries: 3,
          recursive: true,
          retryDelay: 50,
        }),
    });
    return directory;
  }

  temporaryDirectory(prefix: string): string {
    return this.ownDirectory(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  }

  home(prefix = "nemoclaw-test-home-"): OwnedTestHome {
    const home = this.temporaryDirectory(prefix);
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin, { recursive: true });
    return {
      home,
      bin,
      environment: (overrides = {}) => ({
        ...process.env,
        HOME: home,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        ...overrides,
      }),
    };
  }

  ownServer<T extends Server>(server: T): T {
    this.#cleanups.push({
      label: "test server",
      run: createServerCleanup(server),
    });
    return server;
  }

  ownChild<T extends ChildProcess>(child: T): T {
    const owner = ownChildProcess(child);
    this.#cleanups.push({
      label: `child process ${child.pid ?? "<pending>"}`,
      run: owner.terminate,
    });
    return child;
  }

  async cleanup(): Promise<void> {
    const failures: Error[] = [];
    for (const cleanup of this.#cleanups.splice(0).reverse()) {
      try {
        await cleanup.run();
      } catch (error) {
        failures.push(new Error(`Failed to clean up ${cleanup.label}: ${String(error)}`));
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Owned test resource cleanup failed");
  }
}

export type OwnedResourceFixtures = {
  resources: OwnedTestResources;
  testHome: OwnedTestHome;
};

export const test = base.extend<OwnedResourceFixtures>({
  resources: async ({}, use) => {
    const resources = new OwnedTestResources();
    try {
      await use(resources);
    } finally {
      await resources.cleanup();
    }
  },
  testHome: async ({ resources }, use) => {
    await use(resources.home());
  },
});

export { describe, expect };
