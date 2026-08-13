// SPDX-FileCopyrightText: Copyright (c) 2026 Dillon Mulroy
// SPDX-License-Identifier: MIT

import { defineRule } from "@oxlint/plugins";

/** Disallow every runtime typeof check. */
export const noRuntimeTypeofRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow every runtime `typeof` check.",
    },
    messages: {
      runtimeTypeof:
        "`typeof` is not allowed by this rule. Use the value's domain contract. If the value crosses an I/O boundary, parse it before branching.",
    },
  },
  create(context) {
    return {
      UnaryExpression(node) {
        if (node.operator === "typeof") {
          context.report({ node, messageId: "runtimeTypeof" });
        }
      },
    };
  },
});
