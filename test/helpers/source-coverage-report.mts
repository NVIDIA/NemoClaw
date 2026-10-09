// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { V8CoverageProvider } from "@vitest/coverage-v8/dist/provider.js";
import {
  OPTIONS_ENV,
  disableSourceCoverage,
  enableSourceCoverage,
  instrumentSource,
  instrumentSourceForCoverage,
} from "./source-coverage.cts";

// Reuse Vitest's file selection, reporters, security floors and shard transport.
// Only collection changes: original-source counters replace generated V8 ranges.
export class SourceCoverageProvider extends V8CoverageProvider {
  name = "custom";

  initialize(ctx) {
    super.initialize(ctx);
    this.previousOptions = process.env[OPTIONS_ENV];
    this.configureSourceCoverage();
    ctx.onClose(() => {
      if (process.env[OPTIONS_ENV] !== this.serializedOptions) return;
      disableSourceCoverage();
      if (this.previousOptions === undefined) delete process.env[OPTIONS_ENV];
      else process.env[OPTIONS_ENV] = this.previousOptions;
    });
  }

  configureSourceCoverage() {
    this.sourceOptions = {
      roots: this.roots,
      include: this.options.include,
      exclude: this.options.exclude,
      allowExternal: this.options.allowExternal,
      ignoreClassMethods: this.options.ignoreClassMethods,
      changedFiles: this.changedFiles,
    };
    this.serializedOptions = JSON.stringify(this.sourceOptions);
    process.env[OPTIONS_ENV] = this.serializedOptions;
    enableSourceCoverage(this.sourceOptions, () => Boolean(this.ctx.coverageProvider));
  }

  async onTestRunStart() {
    await super.onTestRunStart();
    this.configureSourceCoverage();
    const { compileSourceRequire } = await import("./source-require-compiler.ts");
    // Prepare transforms before per-test timers start. Compilation does not
    // evaluate application modules or initialize their coverage counters.
    for (const filename of await this.getUntestedFiles([])) {
      const source = fs.readFileSync(filename, "utf8");
      instrumentSourceForCoverage(source, filename);
      if (/\.[cm]?tsx?$/.test(filename)) compileSourceRequire(filename, source);
    }
  }

  requiresTransform(id) {
    return this.isIncluded(id);
  }

  onFileTransform() {
    // The pre-transform plugin instruments original source. This hook tells
    // Vitest that enabling coverage changes its persistent transform cache.
    return null;
  }

  onEnabled() {
    this.configureSourceCoverage();
    for (const project of this.ctx.projects) {
      for (const environment of Object.values(project.vite.environments)) {
        environment.moduleGraph.invalidateAll();
      }
    }
  }

  mergeSourceCoverage(map, incoming) {
    for (const [filename, coverage] of Object.entries(incoming)) {
      if (!this.isIncluded(filename)) continue;
      const identity = (value) => {
        if (!value.statementMap || !value.fnMap || !value.branchMap) {
          throw new Error(`Missing original-source coverage maps: ${filename}`);
        }
        return JSON.stringify([value.statementMap, value.fnMap, value.branchMap]);
      };
      const incomingIdentity = identity(coverage);
      if (map.files().includes(filename)) {
        const previous = map.fileCoverageFor(filename).toJSON();
        if (identity(previous) !== incomingIdentity) {
          throw new Error(`Conflicting original-source coverage maps: ${filename}`);
        }
      }
      map.addFileCoverage(coverage);
    }
  }

  async generateCoverage({ allTestsRun }) {
    const map = this.createCoverageMap();
    await this.readCoverageFiles({
      onFileRead: (coverage) => this.mergeSourceCoverage(map, coverage),
      onFinished() {},
      onDebug: Object.assign(() => {}, { enabled: false }),
    });
    if (this.options.include != null && (allTestsRun || !this.options.cleanOnRerun)) {
      for (const filename of await this.getUntestedFiles(map.files())) {
        const source = fs.readFileSync(filename, "utf8");
        const { coverage } = instrumentSource(source, filename, this.sourceOptions);
        map.addFileCoverage(coverage);
      }
    }
    map.filter((filename) => fs.existsSync(filename) && this.isIncluded(filename));
    return map;
  }

  async mergeReports(coverageMaps) {
    const map = this.createCoverageMap();
    for (const coverage of coverageMaps) this.mergeSourceCoverage(map, coverage);
    await this.generateReports(map, true);
  }
}
