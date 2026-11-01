// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const localFilenamePrompts = [
  "Search main.rs for TODO comments",
  "Search main.go for TODO comments",
  "Search data.csv for missing values",
  "Search kernel.c for TODO comments.",
  "Search service.test.cpp for failing assertions.",
  "Search migration.sql for missing constraints.",
  "Search config.xml for duplicate keys.",
  "Search notebook.ipynb for failing assertions.",
  "Search archive.custom-format for missing values.",
  "Search args.url for TODO comments.",
  "Search for TODO comments in main.rs.",
  'Search "README.md" for TODO comments.',
  "Search 'src/runtime-context.ts' for TODO comments.",
  "Search `./docs/setup.md` for TODO comments.",
  'Search "/sandbox/README.md" for TODO comments.',
  'Search "package.dev.json" for the build script.',
  'Search "my folder/config.json" for duplicate keys.',
  'Search for "./my folder/report.md".',
];

export const quotedExternalResearchPrompts = [
  'Search for "official NemoClaw installation documentation on docs.nvidia.com".',
  "Search for 'official NemoClaw installation documentation on docs.nvidia.com'.",
  "Search for `official NemoClaw installation documentation on docs.nvidia.com`.",
  'Search for "official NemoClaw installation documentation about docs.nvidia.com/setup".',
  'Search for "official installation documentation about vendor/docs".',
  'Search for "official installation documentation in vendor/docs".',
  'Search for "official installation documentation in docs.nvidia.com".',
  'Search for "official NVIDIA\'s installation documentation in vendor/docs".',
  'Search for `official "NVIDIA" installation documentation in vendor/docs`.',
  'Search for "official NemoClaw installation documentation on docs.nvidia.com?".',
  'Search for "official installation documentation about *.md".',
  'Search for "official installation documentation [latest]".',
  'Read README.md. Search for "official NemoClaw installation documentation on docs.nvidia.com".',
];

// A code relationship stays local wherever it looks, including code described by its behavior.
export const localCodeRelationshipPrompts = [
  "Find the function that handles authentication",
  "Find the class which parses config files.",
  "Find the method that validates tokens, please.",
  "Find the unit tests that exercise the login flow.",
  "Find all callers of handleRequest in src",
  "Find all callers of handleRequest in src/",
  "Find all callers of handleRequest inside lib.",
  "Find references to parseConfig within packages/core.",
  "Find the definition of parseConfig in the src directory.",
  "Find where handleRequest is called in src.",
  "Search config.dev.json for the port.",
  "Read Makefile.in and configure.ac.",
];

// URLs coordinated only with each other, or with a local file, keep their grants.
export const suppliedUrlListPrompts = [
  {
    prompt: "Fetch https://a.example/x and https://b.example/y",
    local: false,
    urls: ["https://a.example/x", "https://b.example/y"],
  },
  { prompt: "Read https://a.example/x and README.md", local: true, urls: ["https://a.example/x"] },
];

// A hostname is a web source, and a supplied URL exempts only itself, not a coordinated target.
export const webTargetPrompts = [
  "Get the latest news from docs.nvidia.com",
  "Find the latest release notes on developer.nvidia.com.",
  "Search docs.nvidia.com for installation instructions.",
  "Read the latest updates from www.example.org/blog.",
  "Find all callers of handleRequest in docs.nvidia.com",
  "Search https://example.org and the web for NVIDIA news",
  "Summarize https://example.org and the latest NVIDIA news",
  "Search the web and https://example.org for NVIDIA news",
  "Read https://example.org/guide, and the latest NVIDIA news",
  "Search https://example.org, https://example.net and the web for NVIDIA news",
  "Find all callers of handleRequest in src using Tavily.",
  "Find the function that handles authentication online.",
];
