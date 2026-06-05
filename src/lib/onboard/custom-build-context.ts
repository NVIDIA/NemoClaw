// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import fs from "node:fs";

export const CUSTOM_BUILD_CONTEXT_WARN_BYTES = 100_000_000;

const CUSTOM_BUILD_CONTEXT_IGNORES = new Set([
  "node_modules",
  ".git",
  ".venv",
  "__pycache__",
  ".aws",
  ".credentials",
  ".direnv",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".ssh",
  "credentials.json",
  "key.json",
  "secrets",
  "secrets.json",
  "secrets.yaml",
  "token.json",
]);

type CustomBuildContextFilter = (src: string) => boolean;

type DockerignoreRule = {
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
  hasSlash: boolean;
  matcher: RegExp;
};

function isIgnoredCustomBuildContextName(name: string): boolean {
  const lowerName = name.toLowerCase();
  return (
    CUSTOM_BUILD_CONTEXT_IGNORES.has(lowerName) ||
    lowerName === ".env" ||
    lowerName === ".envrc" ||
    lowerName.startsWith(".env.") ||
    lowerName.endsWith(".key") ||
    lowerName.endsWith(".pem") ||
    lowerName.endsWith(".pfx") ||
    lowerName.endsWith(".p12") ||
    lowerName.endsWith(".jks") ||
    lowerName.endsWith(".keystore") ||
    lowerName.endsWith(".tfvars") ||
    lowerName.endsWith("_ecdsa") ||
    lowerName.endsWith("_ed25519") ||
    lowerName.endsWith("_rsa") ||
    (lowerName.startsWith("service-account") && lowerName.endsWith(".json"))
  );
}

export function shouldIncludeCustomBuildContextPath(src: string): boolean {
  return !isIgnoredCustomBuildContextName(path.basename(src));
}

export function isInsideIgnoredCustomBuildContextPath(src: string): boolean {
  return path
    .normalize(src)
    .split(path.sep)
    .filter(Boolean)
    .some((part: string) => isIgnoredCustomBuildContextName(part));
}

function normalizeRelativePathForDockerignore(buildContextDir: string, src: string): string {
  const relative = path.relative(buildContextDir, src);
  if (!relative || relative === "") return "";
  return relative.split(path.sep).filter(Boolean).join("/");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function dockerignoreGlobToRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function parseDockerignoreRule(rawLine: string): DockerignoreRule | null {
  const line = rawLine.trim();
  if (!line || line === "." || line.startsWith("#")) return null;

  const negated = line.startsWith("!");
  let pattern = negated ? line.slice(1).trim() : line;
  if (!pattern || pattern === ".") return null;

  const directoryOnly = pattern.endsWith("/");
  pattern = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!pattern) return null;

  return {
    pattern,
    negated,
    directoryOnly,
    hasSlash: pattern.includes("/"),
    matcher: dockerignoreGlobToRegex(pattern),
  };
}

function readDockerignoreRules(buildContextDir: string): DockerignoreRule[] {
  const dockerignorePath = path.join(buildContextDir, ".dockerignore");
  if (!fs.existsSync(dockerignorePath)) return [];
  const contents = fs.readFileSync(dockerignorePath, "utf-8");
  return contents
    .split(/\r?\n/)
    .map(parseDockerignoreRule)
    .filter((rule): rule is DockerignoreRule => rule !== null);
}

function matchesDockerignoreRule(relativePath: string, rule: DockerignoreRule): boolean {
  if (!relativePath) return false;

  if (!rule.hasSlash) {
    const segments = relativePath.split("/");
    return segments.some((segment) => rule.matcher.test(segment));
  }

  if (rule.directoryOnly) {
    const parts = relativePath.split("/");
    for (let end = 1; end <= parts.length; end += 1) {
      if (rule.matcher.test(parts.slice(0, end).join("/"))) return true;
    }
    return false;
  }

  return rule.matcher.test(relativePath);
}

function isExcludedByDockerignore(relativePath: string, rules: DockerignoreRule[]): boolean {
  let excluded = false;
  for (const rule of rules) {
    if (matchesDockerignoreRule(relativePath, rule)) {
      excluded = !rule.negated;
    }
  }
  return excluded;
}

function isDeniedByCustomBuildContextSafetyFilter(relativePath: string): boolean {
  return relativePath
    .split("/")
    .filter(Boolean)
    .some((part) => isIgnoredCustomBuildContextName(part));
}

export function createCustomBuildContextFilter(buildContextDir: string): CustomBuildContextFilter {
  const contextRoot = path.resolve(buildContextDir);
  const dockerignoreRules = readDockerignoreRules(contextRoot);
  return (src: string): boolean => {
    const resolved = path.resolve(src);
    const relativePath = normalizeRelativePathForDockerignore(contextRoot, resolved);
    if (!relativePath) return true;
    if (isExcludedByDockerignore(relativePath, dockerignoreRules)) return false;
    return !isDeniedByCustomBuildContextSafetyFilter(relativePath);
  };
}
