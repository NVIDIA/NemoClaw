// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

type Metadata = Record<string, unknown>;
type DirectiveComponent = {
  name: string;
  title: string;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.join(repoRoot, "docs");

const skipFiles = new Set<string>(["CONTRIBUTING.md", "index.md"]);
const skipDirs = new Set<string>();

const esc = (value: unknown): string => JSON.stringify(String(value ?? ""));
const scalar = (value: unknown): string =>
  typeof value === "number" || typeof value === "boolean" ? String(value) : esc(value);
const inlineList = (values: unknown[]): string =>
  `[${values.map((value) => esc(value)).join(", ")}]`;

function isRecord(value: unknown): value is Metadata {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nestedValue(metadata: Metadata, key: string, nestedKey: string): unknown {
  const value = metadata[key];
  return isRecord(value) ? value[nestedKey] : undefined;
}

function firstPresent(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(fullPath);
    }
    return [fullPath];
  });
}

function splitFrontmatter(text: string): [Metadata, string] {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) {
    return [{}, text];
  }
  const parsed = parse(match[1]) ?? {};
  return [isRecord(parsed) ? parsed : {}, text.slice(match[0].length)];
}

function titleFromBody(body: string, fallback: string): string {
  const heading = body.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : fallback;
}

function frontmatterFor(sourcePath: string, metadata: Metadata, body: string): string {
  const titleMetadata = metadata.title;
  const title = firstPresent(
    isRecord(titleMetadata) ? titleMetadata.page : titleMetadata,
    titleFromBody(body, path.basename(sourcePath, ".md")),
  );
  const sidebarTitle = firstPresent(
    nestedValue(metadata, "title", "nav"),
    metadata["sidebar-title"],
  );
  const description = firstPresent(
    nestedValue(metadata, "description", "main"),
    metadata.description,
    "",
  );
  const descriptionAgent = firstPresent(
    nestedValue(metadata, "description", "agent"),
    metadata["description-agent"],
    metadata.description_agent,
    "",
  );
  const keywords = metadata.keywords;
  const contentType = firstPresent(nestedValue(metadata, "content", "type"), "");
  const skillPriority = firstPresent(
    nestedValue(metadata, "skill", "priority"),
    metadata.skill_priority,
    "",
  );

  const lines = [
    "---",
    "# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
    "# SPDX-License-Identifier: Apache-2.0",
    `title: ${esc(title)}`,
  ];
  if (sidebarTitle) {
    lines.push(`sidebar-title: ${esc(sidebarTitle)}`);
  }
  if (description) {
    lines.push(`description: ${esc(description)}`);
  }
  if (descriptionAgent) {
    lines.push(`description-agent: ${esc(descriptionAgent)}`);
  }
  if (keywords) {
    lines.push(`keywords: ${Array.isArray(keywords) ? inlineList(keywords) : esc(keywords)}`);
  }
  if (contentType) {
    lines.push("content:", `  type: ${esc(contentType)}`);
  }
  if (skillPriority !== "") {
    lines.push("skill:", `  priority: ${scalar(skillPriority)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function stripInitialH1(body: string): string {
  const lines = body.split("\n");
  const index = lines.findIndex((line) => line.trim() !== "");
  if (index >= 0 && /^#\s+/.test(lines[index])) {
    lines.splice(index, 1);
    if (lines[index]?.trim() === "") {
      lines.splice(index, 1);
    }
  }
  return lines.join("\n");
}

function stripSpdxComment(body: string): string {
  return body.replace(
    /^\s*<!--\s*\n\s*SPDX-FileCopyrightText:[\s\S]*?SPDX-License-Identifier:[\s\S]*?-->\s*\n?/,
    "",
  );
}

function convertHtmlComments(body: string): string {
  return body.replace(
    /<!--([\s\S]*?)-->/g,
    (_match: string, comment: string) => `{/*${comment}*/}`,
  );
}

function resolveInclude(sourcePath: string, includeTarget: string, optionsText: string): string {
  const sourceDir = path.dirname(sourcePath);
  const includePath = path.resolve(sourceDir, includeTarget.trim());
  let content = fs.readFileSync(includePath, "utf8");

  const start = optionsText.match(/:start-after:\s*(.+)/)?.[1]?.trim();
  const end = optionsText.match(/:end-before:\s*(.+)/)?.[1]?.trim();
  if (start) {
    const index = content.indexOf(start);
    if (index >= 0) {
      content = content.slice(index + start.length);
    }
  }
  if (end) {
    const index = content.indexOf(end);
    if (index >= 0) {
      content = content.slice(0, index);
    }
  }

  return content.trim();
}

function convertFencedDirectives(sourcePath: string, body: string): string {
  let converted = body;

  converted = converted.replace(/```\{toctree\}[\s\S]*?```/g, "");
  converted = converted.replace(/```\{mermaid\}/g, "```mermaid");

  converted = converted.replace(
    /```\{include\}\s+([^\n]+)\n([\s\S]*?)```/g,
    (_match: string, includeTarget: string, optionsText: string) =>
      resolveInclude(sourcePath, includeTarget, optionsText),
  );

  converted = converted.replace(
    /```\{figure\}\s+([^\n]+)\n([\s\S]*?)```/g,
    (_match: string, imageTarget: string, block: string) => {
      const alt = block.match(/:alt:\s*(.+)/)?.[1]?.trim();
      const caption = block
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith(":"))
        .join(" ");
      const text = alt || caption || "Image";
      return `![${text}](${imageTarget.trim()})${caption ? `\n\n_${caption}_` : ""}`;
    },
  );

  converted = converted.replace(
    /```\{admonition\}\s*([^\n]*)\n([\s\S]*?)```/g,
    (_match: string, title: string, block: string) => {
      const content = block
        .split("\n")
        .filter((line) => !line.trim().startsWith(":"))
        .join("\n")
        .trim();
      return `<Warning${title.trim() ? ` title=${esc(title.trim())}` : ""}>\n${content}\n</Warning>`;
    },
  );

  return converted;
}

function directiveComponent(kind: string, title: string): DirectiveComponent {
  switch (kind) {
    case "tip":
      return { name: "Tip", title: title.trim() };
    case "warning":
    case "caution":
      return { name: "Warning", title: title.trim() };
    case "dropdown":
      return { name: "Accordion", title: title.trim() || "Details" };
    case "admonition":
      return { name: "Warning", title: title.trim() };
    case "seealso":
    case "note":
    default:
      return { name: "Note", title: title.trim() };
  }
}

function parseListTable(block: string): string {
  const rows: string[][] = [];
  let currentRow: string[] | null = null;
  let currentCell: number | null = null;

  for (const rawLine of block.split("\n")) {
    if (!rawLine.trim() || rawLine.trim().startsWith(":")) {
      continue;
    }
    const rowMatch = rawLine.match(/^\s*\*\s+-\s*(.*)$/);
    if (rowMatch) {
      currentRow = [rowMatch[1].trim()];
      rows.push(currentRow);
      currentCell = 0;
      continue;
    }
    const cellMatch = rawLine.match(/^\s+-\s*(.*)$/);
    if (cellMatch && currentRow) {
      currentRow.push(cellMatch[1].trim());
      currentCell = currentRow.length - 1;
      continue;
    }
    if (currentRow && currentCell !== null) {
      currentRow[currentCell] = `${currentRow[currentCell]} ${rawLine.trim()}`.trim();
    }
  }

  if (rows.length === 0) {
    return "";
  }
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array<string>(width - row.length).fill("")]);
  const header = normalized[0];
  const separator = Array<string>(width).fill("---");
  return [header, separator, ...normalized.slice(1)]
    .map((row) => `| ${row.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`)
    .join("\n");
}

function convertColonDirectives(body: string): string {
  const lines = body.split("\n");
  const output: string[] = [];
  const stack: string[] = [];
  let skipOptions = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const listTable = line.match(/^:{3,}\{list-table\}/);
    if (listTable) {
      const block: string[] = [];
      index += 1;
      while (index < lines.length && !/^:{3,}\s*$/.test(lines[index])) {
        block.push(lines[index]);
        index += 1;
      }
      output.push(parseListTable(block.join("\n")));
      continue;
    }

    const open = line.match(/^:{3,}\{([A-Za-z-]+)\}\s*(.*)$/);
    if (open) {
      const component = directiveComponent(open[1], open[2]);
      if (component.title) {
        output.push(`<${component.name} title=${esc(component.title)}>`);
      } else {
        output.push(`<${component.name}>`);
      }
      stack.push(component.name);
      skipOptions = true;
      continue;
    }

    if (/^:{3,}\s*$/.test(line) && stack.length > 0) {
      output.push(`</${stack.pop()}>`);
      skipOptions = false;
      continue;
    }

    if (skipOptions && /^:\w[\w-]*:/.test(line.trim())) {
      continue;
    }
    if (skipOptions && line.trim() === "") {
      skipOptions = false;
      output.push("");
      continue;
    }

    output.push(line);
  }

  while (stack.length > 0) {
    output.push(`</${stack.pop()}>`);
  }

  return output.join("\n");
}

function routeForLink(sourcePath: string, target: string): string {
  const [withoutFragment, fragment = ""] = target.split("#", 2);
  const [withoutQuery, query = ""] = withoutFragment.split("?", 2);
  if (!withoutQuery.endsWith(".md")) {
    return target;
  }
  const resolved = path.resolve(path.dirname(sourcePath), withoutQuery);
  const relative = path.relative(docsRoot, resolved).replaceAll(path.sep, "/");
  if (relative.startsWith("..")) {
    return target;
  }
  let route = `/${relative.replace(/\.md$/, "")}`;
  route = route.replace(/\/index$/, "");
  return `${route}${query ? `?${query}` : ""}${fragment ? `#${fragment}` : ""}`;
}

function convertLinks(sourcePath: string, body: string): string {
  return body.replace(
    /(!?)\[([^\]]*)\]\(([^)\s]+)(\s+["'][^)"']*["'])?\)/g,
    (match: string, bang: string, label: string, target: string, title: string | undefined) => {
      if (
        bang ||
        target.startsWith("http://") ||
        target.startsWith("https://") ||
        target.startsWith("mailto:") ||
        target.startsWith("#")
      ) {
        return match;
      }
      return `[${label}](${routeForLink(sourcePath, target)})${title ?? ""}`;
    },
  );
}

function convert(sourcePath: string): string {
  const text = fs.readFileSync(sourcePath, "utf8");
  const [metadata, rawBody] = splitFrontmatter(text);
  let body = stripSpdxComment(rawBody);
  body = stripInitialH1(body);
  body = convertFencedDirectives(sourcePath, body);
  body = convertColonDirectives(body);
  body = convertLinks(sourcePath, body);
  body = convertHtmlComments(body);
  body = body.replace(/^\(([A-Za-z0-9_-]+)\)=\s*$/gm, '<a id="$1"></a>');
  body = body.replace(/\n{3,}/g, "\n\n").trimEnd();
  return `${frontmatterFor(sourcePath, metadata, rawBody)}${body}\n`;
}

const files = walk(docsRoot).filter((file) => {
  const relative = path.relative(docsRoot, file).replaceAll(path.sep, "/");
  const [top] = relative.split("/");
  return file.endsWith(".md") && !skipFiles.has(relative) && !skipDirs.has(top);
});

for (const file of files) {
  const target = file.replace(/\.md$/, ".mdx");
  fs.writeFileSync(target, convert(file));
  console.log(path.relative(repoRoot, target));
}
