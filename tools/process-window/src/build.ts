// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { type Config, type Mapping, sourceUrl } from "./model.js";
export async function render(config: Config, mapping: Mapping, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const data = {
    origins: config.origins,
    stages: config.stages,
    categories: config.categories,
    branches: config.branches.map((b) => ({
      ...b,
      ...mapping.branches.find((m) => m.id === b.id),
      mechanisms:
        mapping.branches
          .find((m) => m.id === b.id)
          ?.mechanisms?.map((m) => ({
            ...m,
            usages: m.usages.map((u) => ({
              ...u,
              requirements: u.requirements?.map((r) => ({
                ...r,
                url: sourceUrl(config, mapping.branches.find((m) => m.id === b.id)!.revision, r),
              })),
              url: u.source
                ? sourceUrl(config, mapping.branches.find((m) => m.id === b.id)!.revision, {
                    source: u.source,
                  })
                : null,
            })),
          })) ?? [],
      inputs:
        mapping.branches
          .find((m) => m.id === b.id)
          ?.inputs.map((i) => ({
            ...i,
            url: i.unavailable
              ? null
              : sourceUrl(config, mapping.branches.find((m) => m.id === b.id)!.revision, i),
          })) ?? [],
    })),
  };
  // Embedded JSON supports opening index.html directly under file://. Escape HTML delimiters.
  const json = JSON.stringify(data)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./browser.ts", import.meta.url))],
    bundle: true,
    write: false,
    minify: true,
    format: "iife",
    target: "es2022",
  });
  await writeFile(`${directory}/app.js`, result.outputFiles![0]!.text);
  const { readFile } = await import("node:fs/promises");
  await writeFile(
    `${directory}/style.css`,
    await readFile(new URL("./style.css", import.meta.url)),
  );
  await writeFile(
    `${directory}/index.html`,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Process Window · Guidance map</title><link rel="stylesheet" href="style.css"></head><body><header><span class="eyebrow">PROCESS WINDOW</span><h1>Guidance for agentic development</h1><p>What informs decisions at each phase, and how that guidance is used.</p><label for="branch">Tracked branch</label> <select id="branch"></select><p id="revision"></p></header><main><div class="intro"><span class="dot"></span> Explore the lifecycle. Select a source group to see what guides the agent and when. Open a title to read the guidance.</div><nav id="source-filter" aria-label="Filter guidance by source"></nav><div class="overview-heading"><h2>Lifecycle overview</h2><span>Select a group to focus · counts are guidance items</span></div><div id="lifecycle" tabindex="0" aria-label="Lifecycle phases, scroll horizontally on smaller screens"></div></main><footer>This diagram shows configured or explicitly prescribed usage, not inferred relevance alone. Configured and prescribed connections are not observed runtime loading. Counts repeat across phases. Sources open at the analyzed revision.</footer><script id="mapping" type="application/json">${json}</script><script src="app.js"></script></body></html>`,
  );
}
