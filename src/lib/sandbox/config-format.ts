// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import JSON5 from "json5";
import type { ParseOptions, ScalarTag, Tags } from "yaml";

import { assertSafeConfigStructure } from "../security/config-structure.js";

type ConfigObject = import("../security/credential-filter").ConfigObject;

const MIN_SAFE_CONFIG_INTEGER = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_CONFIG_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function preserveUnsafeYamlIntegers(tags: Tags): Tags {
  return tags.map((tag) => {
    if (
      typeof tag === "string" ||
      tag.tag !== "tag:yaml.org,2002:int" ||
      typeof tag.resolve !== "function"
    ) {
      return tag;
    }
    const integerTag = tag as ScalarTag;
    return {
      ...integerTag,
      resolve(value: string, onError: (message: string) => void, options: ParseOptions) {
        const parsed = integerTag.resolve(value, onError, { ...options, intAsBigInt: true });
        if (typeof parsed !== "bigint") return parsed;
        return parsed < MIN_SAFE_CONFIG_INTEGER || parsed > MAX_SAFE_CONFIG_INTEGER
          ? parsed.toString()
          : Number(parsed);
      },
    };
  });
}

/** Parse raw agent configuration according to its manifest-declared format. */
export function parseConfig(raw: string, format: string): ConfigObject {
  let parsed: unknown;
  if (format === "yaml") {
    const YAML = require("yaml") as typeof import("yaml");
    try {
      parsed = YAML.parse(raw, { customTags: preserveUnsafeYamlIntegers });
    } catch {
      throw new Error("Invalid YAML configuration syntax.");
    }
  } else if (format === "toml") {
    const TOML = require("smol-toml") as {
      parse: (text: string) => unknown;
    };
    try {
      parsed = TOML.parse(raw);
    } catch {
      throw new Error("Invalid TOML configuration syntax.");
    }
  } else if (format === "json5") {
    try {
      parsed = JSON5.parse(raw);
    } catch {
      throw new Error("Invalid JSON5 configuration syntax.");
    }
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Invalid JSON configuration syntax.");
    }
  }
  assertSafeConfigStructure(parsed);
  return parsed as ConfigObject;
}

/** Serialize mutable agent configuration without corrupting TOML inputs. */
export function serializeConfig(config: ConfigObject, format: string): string {
  if (format === "yaml") {
    return require("yaml").stringify(config);
  }
  if (format === "toml") {
    throw new Error("config set is not supported for TOML-format agents.");
  }
  return JSON.stringify(config, null, 2);
}
