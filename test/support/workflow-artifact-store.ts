// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

/** In-memory immutable artifact service for exercising workflow handoffs. */
export class WorkflowArtifactStore {
  private readonly artifacts = new Map<string, string>();

  publish(name: string, body: string, overwrite: boolean): void {
    if (this.artifacts.has(name) && !overwrite) {
      throw new Error("Immutable artifact already exists");
    }
    this.artifacts.set(name, body);
  }

  materialize(name: string, file: string): void {
    // A missing download cannot leave an older report available to the consumer.
    fs.rmSync(file, { force: true });
    const body = this.artifacts.get(name);
    if (body !== undefined) fs.writeFileSync(file, body);
  }

  get size(): number {
    return this.artifacts.size;
  }
}
