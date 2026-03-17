// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version } = require("./package.json");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DOCS_DIR = path.join(ROOT, "docs");
const BLUEPRINT_DIR = path.join(ROOT, "nemoclaw-blueprint");
const POLICIES_DIR = path.join(BLUEPRINT_DIR, "policies");
const PRESETS_DIR = path.join(POLICIES_DIR, "presets");
const PLUGIN_SRC_DIR = path.join(ROOT, "nemoclaw", "src");
const SCRIPTS_DIR = path.join(ROOT, "scripts");
const BIN_DIR = path.join(ROOT, "bin");

// ── Indexing helpers ────────────────────────────────────────────────────

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stripFrontmatter(content) {
  return content
    .replace(/^---\n[\s\S]*?---\n/, "")
    .replace(/<!--[\s\S]*?-->\n*/g, "")
    .trim();
}

function extractTitle(content) {
  const fmMatch = content.match(/^---\n[\s\S]*?title:\s*\n\s*page:\s*"([^"]+)"/);
  if (fmMatch) return fmMatch[1];
  const h1Match = content.match(/^#\s+(.+)$/m);
  return h1Match ? h1Match[1] : null;
}

function extractDescription(content) {
  const match = content.match(/^description:\s*"([^"]+)"/m);
  return match ? match[1] : "";
}

// ── Index: Documentation ────────────────────────────────────────────────

const docs = [];

function indexDocs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith("_")) {
      indexDocs(fullPath);
    } else if (entry.name.endsWith(".md")) {
      const relPath = path.relative(DOCS_DIR, fullPath);
      const raw = fs.readFileSync(fullPath, "utf-8");
      docs.push({
        path: relPath,
        title: extractTitle(raw) || relPath,
        description: extractDescription(raw),
        content: stripFrontmatter(raw),
      });
    }
  }
}

indexDocs(DOCS_DIR);

// ── Index: Policy presets ───────────────────────────────────────────────

const presets = [];

if (fs.existsSync(PRESETS_DIR)) {
  for (const f of fs.readdirSync(PRESETS_DIR)) {
    if (!f.endsWith(".yaml")) continue;
    const content = fs.readFileSync(path.join(PRESETS_DIR, f), "utf-8");
    const nameMatch = content.match(/^\s*name:\s*(.+)$/m);
    const descMatch = content.match(/^\s*description:\s*"?([^"\n]*)"?$/m);
    const hosts = [];
    const hostRe = /host:\s*([^\s,}]+)/g;
    let m;
    while ((m = hostRe.exec(content)) !== null) hosts.push(m[1]);
    presets.push({
      file: f,
      name: nameMatch ? nameMatch[1].trim() : f.replace(".yaml", ""),
      description: descMatch ? descMatch[1].trim() : "",
      endpoints: hosts,
      content,
    });
  }
}

// ── Index: Source code files ────────────────────────────────────────────

const sourceFiles = [];

function indexSource(dir, category) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      indexSource(fullPath, category);
    } else if (/\.(ts|js|py|sh|yaml|json)$/.test(entry.name) && !entry.name.startsWith(".")) {
      const relPath = path.relative(ROOT, fullPath);
      const content = fs.readFileSync(fullPath, "utf-8");
      let desc = "";
      const jsDocMatch = content.match(/^\/\/\s*(.*?)(?:\n|$)/m);
      const pyDocMatch = content.match(/"""([\s\S]*?)"""/);
      const shDescMatch = content.match(/^#\s*(.*?)(?:\n|$)/m);
      if (jsDocMatch) desc = jsDocMatch[1].replace(/^SPDX.*$/, "").trim();
      if (!desc && pyDocMatch) desc = pyDocMatch[1].split("\n")[0].trim();
      if (!desc && shDescMatch) desc = shDescMatch[1].replace(/^!.*$/, "").trim();
      sourceFiles.push({ path: relPath, category, description: desc, content });
    }
  }
}

indexSource(PLUGIN_SRC_DIR, "plugin");
indexSource(path.join(BLUEPRINT_DIR, "orchestrator"), "blueprint");
indexSource(path.join(BLUEPRINT_DIR, "migrations"), "blueprint");
indexSource(SCRIPTS_DIR, "scripts");
indexSource(BIN_DIR, "cli");

// Add key root config files
for (const [relPath, fullPath] of [
  ["nemoclaw-blueprint/blueprint.yaml", path.join(BLUEPRINT_DIR, "blueprint.yaml")],
  ["Dockerfile", path.join(ROOT, "Dockerfile")],
  ["README.md", path.join(ROOT, "README.md")],
  ["install.sh", path.join(ROOT, "install.sh")],
  ["uninstall.sh", path.join(ROOT, "uninstall.sh")],
]) {
  const content = readIfExists(fullPath);
  if (content) {
    sourceFiles.push({
      path: relPath,
      category: relPath === "nemoclaw-blueprint/blueprint.yaml" ? "blueprint" : "config",
      description: relPath,
      content,
    });
  }
}

// ── Unified search ──────────────────────────────────────────────────────

function search(items, query, maxResults = 5) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return items
    .map((item) => {
      let score = 0;
      for (const term of terms) {
        if ((item.path || "").toLowerCase().includes(term)) score += 8;
        if ((item.title || "").toLowerCase().includes(term)) score += 10;
        if ((item.description || "").toLowerCase().includes(term)) score += 5;
        let idx = 0;
        const content = (item.content || "").toLowerCase();
        while ((idx = content.indexOf(term, idx)) !== -1) {
          score += 1;
          idx += term.length;
        }
      }
      if (score === 0) return null;

      const lines = (item.content || "").split("\n");
      const snippets = [];
      for (let i = 0; i < lines.length && snippets.length < 3; i++) {
        if (terms.some((t) => lines[i].toLowerCase().includes(t))) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length, i + 3);
          snippets.push(lines.slice(start, end).join("\n"));
        }
      }
      return { item, score, snippets };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

// ── MCP Server ──────────────────────────────────────────────────────────

const server = new McpServer({
  name: "nemoclaw-docs",
  version,
});

// ── Tool: list_docs ─────────────────────────────────────────────────────

server.tool("list_docs", "List all NemoClaw documentation pages", {}, async () => {
  const list = docs.map(
    (d) => `- **${d.title}** (\`${d.path}\`)\n  ${d.description}`
  );
  return {
    content: [{ type: "text", text: `# NemoClaw Documentation\n\n${list.join("\n\n")}` }],
  };
});

// ── Tool: read_doc ──────────────────────────────────────────────────────

server.tool(
  "read_doc",
  "Read a specific NemoClaw documentation page by path",
  {
    doc_path: z
      .string()
      .describe("Path relative to docs/, e.g. 'about/overview.md' or 'reference/commands.md'"),
  },
  async ({ doc_path }) => {
    const doc = docs.find((d) => d.path === doc_path);
    if (!doc) {
      return {
        content: [
          {
            type: "text",
            text: `Document not found: ${doc_path}\n\nAvailable:\n${docs.map((d) => `- ${d.path}`).join("\n")}`,
          },
        ],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: `# ${doc.title}\n\n${doc.content}` }] };
  }
);

// ── Tool: search ────────────────────────────────────────────────────────

server.tool(
  "search",
  "Search across ALL NemoClaw knowledge — docs, source code, policies, configs, scripts. Returns ranked results with snippets.",
  {
    query: z.string().describe("Search query (keywords or phrase)"),
    scope: z
      .enum(["all", "docs", "code", "policies", "blueprint", "scripts"])
      .optional()
      .default("all")
      .describe("Limit search scope: all, docs, code (plugin+cli), policies, blueprint, scripts"),
    max_results: z.number().optional().default(8).describe("Max results (default: 8)"),
  },
  async ({ query, scope, max_results }) => {
    let pool = [];
    if (scope === "all" || scope === "docs") pool.push(...docs);
    if (scope === "all" || scope === "code") {
      pool.push(...sourceFiles.filter((s) => s.category === "plugin" || s.category === "cli"));
    }
    if (scope === "all" || scope === "scripts") {
      pool.push(...sourceFiles.filter((s) => s.category === "scripts"));
    }
    if (scope === "all" || scope === "policies") {
      pool.push(
        ...presets.map((p) => ({
          path: `presets/${p.file}`,
          title: `Policy preset: ${p.name}`,
          description: p.description,
          content: p.content,
        }))
      );
      const basePolicy = readIfExists(path.join(POLICIES_DIR, "openclaw-sandbox.yaml"));
      if (basePolicy) {
        pool.push({
          path: "policies/openclaw-sandbox.yaml",
          title: "Baseline sandbox policy",
          description: "Strict deny-by-default network and filesystem policy",
          content: basePolicy,
        });
      }
    }
    if (scope === "all" || scope === "blueprint") {
      pool.push(...sourceFiles.filter((s) => s.category === "blueprint"));
    }
    if (scope === "all") {
      pool.push(...sourceFiles.filter((s) => s.category === "config"));
    }

    const results = search(pool, query, max_results);
    if (results.length === 0) {
      return { content: [{ type: "text", text: `No results for "${query}".` }] };
    }

    const text = results
      .map((r) => {
        const snippetText =
          r.snippets.length > 0
            ? r.snippets.map((s) => "```\n" + s + "\n```").join("\n")
            : "";
        return `## ${r.item.title || r.item.path}\n**Path:** \`${r.item.path}\` | **Score:** ${r.score}\n${r.item.description ? `> ${r.item.description}\n` : ""}\n${snippetText}`;
      })
      .join("\n\n---\n\n");

    return {
      content: [{ type: "text", text: `# Search: "${query}" (scope: ${scope})\n\n${text}` }],
    };
  }
);

// ── Tool: get_blueprint_config ──────────────────────────────────────────

server.tool(
  "get_blueprint_config",
  "Get the NemoClaw blueprint configuration — profiles, sandbox image, inference providers, policy setup",
  {},
  async () => {
    const content = readIfExists(path.join(BLUEPRINT_DIR, "blueprint.yaml"));
    if (!content) {
      return { content: [{ type: "text", text: "blueprint.yaml not found" }], isError: true };
    }
    return {
      content: [
        {
          type: "text",
          text: `# NemoClaw Blueprint Configuration\n\n\`\`\`yaml\n${content}\n\`\`\``,
        },
      ],
    };
  }
);

// ── Tool: get_baseline_policy ───────────────────────────────────────────

server.tool(
  "get_baseline_policy",
  "Get the full baseline sandbox network and filesystem policy (openclaw-sandbox.yaml)",
  {},
  async () => {
    const content = readIfExists(path.join(POLICIES_DIR, "openclaw-sandbox.yaml"));
    if (!content) {
      return { content: [{ type: "text", text: "Baseline policy not found" }], isError: true };
    }
    return {
      content: [
        {
          type: "text",
          text: `# Baseline Sandbox Policy\n\n\`\`\`yaml\n${content}\n\`\`\``,
        },
      ],
    };
  }
);

// ── Tool: list_policy_presets ────────────────────────────────────────────

server.tool(
  "list_policy_presets",
  "List all available network policy presets (Discord, Slack, Docker, npm, PyPI, etc.) with their allowed endpoints",
  {},
  async () => {
    if (presets.length === 0) {
      return { content: [{ type: "text", text: "No policy presets found." }] };
    }
    const rows = presets
      .map(
        (p) =>
          `### ${p.name}\n${p.description}\n- **Endpoints:** ${p.endpoints.join(", ")}\n- **File:** \`presets/${p.file}\``
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `# Network Policy Presets\n\n${presets.length} presets available. Use \`nemoclaw <name> policy-add\` to apply.\n\n${rows}`,
        },
      ],
    };
  }
);

// ── Tool: get_policy_preset ─────────────────────────────────────────────

server.tool(
  "get_policy_preset",
  "Get the full YAML content of a specific network policy preset",
  {
    preset_name: z
      .string()
      .describe(
        "Preset name: discord, slack, docker, npm, pypi, jira, huggingface, outlook, telegram"
      ),
  },
  async ({ preset_name }) => {
    const preset = presets.find(
      (p) => p.name === preset_name || p.file === `${preset_name}.yaml`
    );
    if (!preset) {
      return {
        content: [
          {
            type: "text",
            text: `Preset "${preset_name}" not found.\n\nAvailable: ${presets.map((p) => p.name).join(", ")}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `# Policy Preset: ${preset.name}\n\n${preset.description}\n\n**Endpoints:** ${preset.endpoints.join(", ")}\n\n\`\`\`yaml\n${preset.content}\n\`\`\``,
        },
      ],
    };
  }
);

// ── Tool: get_nim_models ────────────────────────────────────────────────

server.tool(
  "get_nim_models",
  "Get the catalog of NIM container images and models with GPU memory requirements",
  {},
  async () => {
    const nimImagesPath = path.join(BIN_DIR, "lib", "nim-images.json");
    const content = readIfExists(nimImagesPath);
    if (!content) {
      return { content: [{ type: "text", text: "NIM images catalog not found" }], isError: true };
    }
    const catalog = parseJsonSafe(content);
    if (!catalog || !Array.isArray(catalog.models)) {
      return {
        content: [{ type: "text", text: "NIM images catalog has invalid format" }],
        isError: true,
      };
    }
    const rows = catalog.models
      .map(
        (m) =>
          `| \`${m.name || "unknown"}\` | \`${m.image || "unknown"}\` | ${m.minGpuMemoryMB ? (m.minGpuMemoryMB / 1024).toFixed(0) : "?"} GB |`
      )
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: `# NIM Model Catalog\n\n| Model | Container Image | Min GPU Memory |\n|---|---|---|\n${rows}\n\n## Raw JSON\n\n\`\`\`json\n${content}\n\`\`\``,
        },
      ],
    };
  }
);

// ── Tool: read_source_file ──────────────────────────────────────────────

server.tool(
  "read_source_file",
  "Read any NemoClaw source file — plugin code, scripts, blueprint runner, Dockerfile, configs",
  {
    file_path: z
      .string()
      .describe(
        "Path relative to project root, e.g. 'nemoclaw/src/commands/launch.ts', 'scripts/setup.sh', 'bin/nemoclaw.js', 'Dockerfile'"
      ),
  },
  async ({ file_path }) => {
    const src = sourceFiles.find((s) => s.path === file_path);
    if (src) {
      return {
        content: [
          {
            type: "text",
            text: `# ${file_path}\n\n${src.description ? `> ${src.description}\n\n` : ""}\`\`\`\n${src.content}\n\`\`\``,
          },
        ],
      };
    }
    // Fallback: try reading from disk (validate path stays within project root)
    const full = path.resolve(ROOT, file_path);
    if (!full.startsWith(ROOT + path.sep) && full !== ROOT) {
      return {
        content: [{ type: "text", text: `Access denied: path outside project root` }],
        isError: true,
      };
    }
    const content = readIfExists(full);
    if (!content) {
      const available = sourceFiles.map((s) => s.path).join("\n- ");
      return {
        content: [
          { type: "text", text: `File not found: ${file_path}\n\nIndexed files:\n- ${available}` },
        ],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: `# ${file_path}\n\n\`\`\`\n${content}\n\`\`\`` }] };
  }
);

// ── Tool: list_source_files ─────────────────────────────────────────────

server.tool(
  "list_source_files",
  "List all indexed NemoClaw source files by category (plugin, blueprint, scripts, cli, config)",
  {
    category: z
      .enum(["all", "plugin", "blueprint", "scripts", "cli", "config"])
      .optional()
      .default("all")
      .describe("Filter by category (default: all)"),
  },
  async ({ category }) => {
    const filtered =
      category === "all" ? sourceFiles : sourceFiles.filter((s) => s.category === category);

    const grouped = {};
    for (const f of filtered) {
      const cat = f.category;
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(f);
    }

    const text = Object.entries(grouped)
      .map(
        ([cat, files]) =>
          `## ${cat}\n${files.map((f) => `- \`${f.path}\` — ${f.description || "(no description)"}`).join("\n")}`
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `# NemoClaw Source Files (${filtered.length} files)\n\n${text}`,
        },
      ],
    };
  }
);

// ── Tool: get_architecture_overview ─────────────────────────────────────

server.tool(
  "get_architecture_overview",
  "Get a comprehensive overview of NemoClaw architecture — plugin, blueprint, sandbox, CLI, policies, inference, and deployment",
  {},
  async () => {
    // Build dynamic sections from indexed data
    const presetNames = presets.map((p) => p.name).join(", ");

    const nimImagesPath = path.join(BIN_DIR, "lib", "nim-images.json");
    const nimContent = readIfExists(nimImagesPath);
    const nimCatalog = nimContent ? parseJsonSafe(nimContent) : null;
    const nimRows = nimCatalog?.models
      ? nimCatalog.models
          .map((m) => `| \`${m.name}\` | ${(m.minGpuMemoryMB / 1024).toFixed(0)} GB |`)
          .join("\n")
      : "| (catalog unavailable) | |";

    const bpContent = readIfExists(path.join(BLUEPRINT_DIR, "blueprint.yaml"));
    const profileNames = bpContent
      ? (bpContent.match(/profiles:\n([\s\S]*?)(?:\n\S|\n$)/)?.[1] || "")
          .split("\n")
          .map((l) => l.replace(/^\s*-\s*/, "").trim())
          .filter(Boolean)
          .join(", ")
      : "default, ncp, nim-local, vllm";

    const overview = `# NemoClaw Architecture Overview

## Components

### 1. CLI Entrypoint (\`bin/nemoclaw.js\`)
Host-side CLI dispatcher with global commands (onboard, deploy, start/stop/status, list)
and sandbox-scoped commands (<name> connect/status/logs/destroy/policy-add/policy-list).

### 2. Plugin (\`nemoclaw/src/\`)
TypeScript OpenClaw plugin registered under \`openclaw nemoclaw\`. Commands: launch, connect,
status, logs, migrate, eject, onboard. Registers NVIDIA NIM provider with model catalog.

### 3. Blueprint (\`nemoclaw-blueprint/\`)
Versioned Python artifact that orchestrates sandbox lifecycle via OpenShell CLI.
- **blueprint.yaml** — Profiles: ${profileNames}
- **orchestrator/runner.py** — Plan/apply/status/rollback actions
- **migrations/snapshot.py** — Snapshot/restore for host-to-sandbox migration

### 4. Policies (\`nemoclaw-blueprint/policies/\`)
- **openclaw-sandbox.yaml** — Strict baseline: deny-by-default network, filesystem isolation
- **presets/** — ${presets.length} composable policy presets: ${presetNames}

### 5. Sandbox Container (\`Dockerfile\`)
Node 22 + OpenClaw CLI + NemoClaw plugin + blueprint. Runs as \`sandbox\` user.
Inference routed through \`inference.local\` (OpenShell gateway proxy).

### 6. Scripts (\`scripts/\`)
- **setup.sh** — Gateway creation, provider config, sandbox build
- **brev-setup.sh** — Remote GPU VM bootstrap
- **nemoclaw-start.sh** — Sandbox entrypoint (config, auth, gateway startup)
- **start-services.sh** — Telegram bridge, cloudflared tunnel
- **walkthrough.sh** — Interactive demo with split tmux

## NIM Container Models

| Model | Min GPU |
|---|---|
${nimRows}

## Key Flows
1. **Onboard**: nemoclaw onboard → prompt for API key → create gateway → register provider → build sandbox → apply policy
2. **Deploy**: nemoclaw deploy <name> → provision Brev VM → install Docker/OpenShell → run setup → connect
3. **Migrate**: openclaw nemoclaw migrate → snapshot host config → create sandbox → restore into sandbox → cutover
4. **Policy**: nemoclaw <name> policy-add → select preset → merge into running policy via openshell policy set
`;

    return { content: [{ type: "text", text: overview }] };
  }
);

// ── Tool: get_dockerfile ────────────────────────────────────────────────

server.tool(
  "get_dockerfile",
  "Get the NemoClaw sandbox Dockerfile with build steps explanation",
  {},
  async () => {
    const content = readIfExists(path.join(ROOT, "Dockerfile"));
    if (!content) {
      return { content: [{ type: "text", text: "Dockerfile not found" }], isError: true };
    }
    return {
      content: [
        {
          type: "text",
          text: `# NemoClaw Sandbox Dockerfile\n\n\`\`\`dockerfile\n${content}\n\`\`\``,
        },
      ],
    };
  }
);

// ── Start ───────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
