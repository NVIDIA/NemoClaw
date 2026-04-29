// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ESLint rule: no-direct-credential-env
 *
 * Flags direct `process.env` access for known provider credential keys
 * in read context.  Use `resolveProviderCredential()` or `getCredential()`
 * instead, which resolve from both env and ~/.nemoclaw/credentials.json.
 *
 * See #2306.
 */

"use strict";

const CREDENTIAL_ENV_KEYS = new Set([
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "COMPATIBLE_API_KEY",
  "COMPATIBLE_ANTHROPIC_API_KEY",
]);

const MESSAGE =
  "Direct process.env access for provider credentials bypasses credentials.json. " +
  "Use resolveProviderCredential() or getCredential() instead. See #2306.";

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct process.env access for known provider credential keys in read context",
    },
    schema: [],
    messages: {
      noDirectCredentialEnv: MESSAGE,
    },
  },

  create(context) {
    return {
      MemberExpression(node) {
        // Only flag reads, not assignments (process.env.KEY = value is OK)
        if (isAssignmentTarget(node)) return;

        // Must be process.env.SOMETHING or process.env[something]
        if (!isProcessEnvAccess(node)) return;

        // Static access: process.env.NVIDIA_API_KEY
        if (!node.computed && node.property.type === "Identifier") {
          if (CREDENTIAL_ENV_KEYS.has(node.property.name)) {
            context.report({ node, messageId: "noDirectCredentialEnv" });
          }
          return;
        }

        // Static computed access: process.env["NVIDIA_API_KEY"]
        if (node.computed && node.property.type === "Literal") {
          if (
            typeof node.property.value === "string" &&
            CREDENTIAL_ENV_KEYS.has(node.property.value)
          ) {
            context.report({ node, messageId: "noDirectCredentialEnv" });
          }
          return;
        }

        // Dynamic access: process.env[credentialEnv]
        if (node.computed && node.property.type === "Identifier") {
          if (/credential/i.test(node.property.name)) {
            context.report({ node, messageId: "noDirectCredentialEnv" });
          }
        }
      },
    };
  },
};

/**
 * Check if this node is in a write context (assignment target or delete operand).
 * e.g. process.env.KEY = value   → true (assignment)
 *      delete process.env.KEY    → true (deletion)
 *      process.env.KEY           → false (read context)
 */
function isAssignmentTarget(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "AssignmentExpression" && parent.left === node) return true;
  if (parent.type === "UnaryExpression" && parent.operator === "delete") return true;
  return false;
}

/**
 * Check if this MemberExpression is accessing process.env
 * (i.e., the object is process.env and we're accessing a property of it).
 */
function isProcessEnvAccess(node) {
  const obj = node.object;
  if (obj.type !== "MemberExpression") return false;
  if (obj.object.type !== "Identifier" || obj.object.name !== "process") return false;
  if (obj.property.type !== "Identifier" || obj.property.name !== "env") return false;
  return true;
}
