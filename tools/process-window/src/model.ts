// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

const text = z.string().trim().min(1);
const id = text.regex(/^[a-z0-9][a-z0-9_-]*$/);
const sourcePath = text.refine(
  (p) =>
    !p.startsWith("/") && !p.split("/").includes("..") && !p.includes("\\") && !p.includes("\0"),
  "Expected repository-relative path",
);
export const excluded = (p: string) =>
  p.split("/").some((s) => ["acceptance-references", ".git", "node_modules"].includes(s));
const named = z.object({ id, name: text, description: text.optional() }).strict();
export const configSchema = z
  .object({
    repository: z
      .object({ path: text, url: z.string().url(), forge: z.enum(["github", "gitlab"]) })
      .strict(),
    mapping: text,
    output: text,
    excludePaths: z.array(sourcePath).default([]),
    stages: z.array(named).min(1),
    categories: z.array(named).min(1),
    origins: z
      .array(
        z
          .object({
            id: id.refine((v) => v !== "other", "Reserved fallback origin"),
            name: text,
            paths: z.array(sourcePath).min(1),
          })
          .strict(),
      )
      .default([]),
    branches: z
      .array(
        z
          .object({
            id,
            name: text,
            ref: text,
            diffBase: z
              .string()
              .regex(/^[a-f0-9]{40,64}$/)
              .nullable()
              .optional(),
            color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
            refresh: z
              .object({ mode: z.enum(["manual", "branch", "release"]), tags: text.optional() })
              .strict(),
          })
          .strict(),
      )
      .min(1),
    inference: z
      .object({
        provider: z.literal("openai-compatible"),
        api: z.enum(["chat-completions", "responses"]).default("chat-completions"),
        reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
        timeoutSeconds: z.number().int().min(1).max(3600).default(240),
        baseUrl: z.string().url(),
        model: text,
        apiKeyEnv: text.optional(),
        maxTurns: z.number().int().min(2).max(200).default(80),
        maxOutputTokens: z.number().int().positive().default(16000),
      })
      .strict(),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const key of ["stages", "categories", "branches", "origins"] as const)
      if (new Set(c[key].map((x) => x.id)).size !== c[key].length)
        ctx.addIssue({ code: "custom", message: `Duplicate ${key} ids` });
    for (const b of c.branches)
      if (b.refresh.mode === "release" && !b.refresh.tags)
        ctx.addIssue({
          code: "custom",
          message: `Release branch ${b.id} requires an explicit tag selector`,
        });
    const u = new URL(c.repository.url);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash)
      ctx.addIssue({
        code: "custom",
        message: "Repository URL must be credential-free HTTPS without query or fragment",
      });
    const endpoint = new URL(c.inference.baseUrl);
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      (endpoint.protocol !== "https:" &&
        !(
          ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) &&
          endpoint.protocol === "http:"
        ))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Inference endpoint must use HTTPS (HTTP allowed on loopback), without embedded credentials or query",
      });
  });
export const inputSchema = z
  .object({
    id,
    name: text,
    displayName: text.max(80).optional(),
    category: id,
    stages: z.array(id),
    source: z
      .object({
        path: sourcePath.refine((p) => !excluded(p), "Development references are excluded"),
        start: z.number().int().positive(),
        end: z.number().int().positive().optional(),
      })
      .strict(),
    evidence: text,
    note: text.optional(),
    unavailable: z.boolean().optional(),
  })
  .strict();
export const requirementSchema = z
  .object({
    inputIds: z.array(id).min(1),
    level: z.enum(["mandatory", "conditional", "available"]),
    condition: text.optional(),
    evidence: text,
    source: inputSchema.shape.source,
    note: text.optional(),
  })
  .strict();
export type Requirement = z.infer<typeof requirementSchema>;
export const usageSchema = z
  .object({
    stage: id,
    trigger: text,
    inputIds: z.array(id).min(1),
    basis: z.enum(["verified", "prescribed", "unresolved"]),
    evidence: text,
    outcome: text,
    agentUse: text.optional(),
    summary: text
      .max(260)
      .refine((v) => v.split(/\s+/).length <= 35, "Summary must be at most 35 words")
      .optional(),
    lifecycle: z.object({ event: text, source: inputSchema.shape.source }).strict().optional(),
    phaseReason: text.optional(),
    source: inputSchema.shape.source.optional(),
    note: text.optional(),
    requirements: z.array(requirementSchema).optional(),
  })
  .strict();
export const mechanismSchema = z
  .object({ id, name: text, usages: z.array(usageSchema).min(1) })
  .strict();
export const branchSchema = z
  .object({
    id,
    revision: z.string().regex(/^[a-f0-9]{40,64}$/),
    inputs: z.array(inputSchema),
    mechanisms: z.array(mechanismSchema).optional(),
  })
  .strict();
export type Mechanism = z.infer<typeof mechanismSchema>;
export type Usage = z.infer<typeof usageSchema>;

export const mappingSchema = z
  .object({
    version: z.literal(1),
    repository: z.string().url(),
    branches: z.array(branchSchema).min(1),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export type Input = z.infer<typeof inputSchema>;
export type Branch = z.infer<typeof branchSchema>;
export type Mapping = z.infer<typeof mappingSchema>;
export function validateMapping(value: unknown, config: Config): Mapping {
  const m = mappingSchema.parse(value);
  if (m.repository !== config.repository.url)
    throw Error("Mapping belongs to a different repository");
  if (new Set(m.branches.map((b) => b.id)).size !== m.branches.length)
    throw Error("Duplicate mapping branches");
  for (const b of m.branches) {
    if (!config.branches.some((x) => x.id === b.id)) throw Error(`Unconfigured branch ${b.id}`);
    if (new Set(b.inputs.map((i) => i.id)).size !== b.inputs.length)
      throw Error(`Duplicate inputs in ${b.id}`);
    const mechanisms = b.mechanisms ?? [];
    if (new Set(mechanisms.map((m) => m.id)).size !== mechanisms.length)
      throw Error(`Duplicate mechanisms in ${b.id}`);
    for (const mechanism of mechanisms) {
      if (new Set(mechanism.usages.map((u) => u.stage)).size !== mechanism.usages.length)
        throw Error(`Duplicate usage stages for ${mechanism.id}`);
      for (const usage of mechanism.usages) {
        if (!config.stages.some((s) => s.id === usage.stage))
          throw Error(`Unknown usage stage for ${mechanism.id}`);
        if (new Set(usage.inputIds).size !== usage.inputIds.length)
          throw Error(`Duplicate usage input for ${mechanism.id}`);
        if (usage.basis !== "unresolved" && !usage.agentUse)
          throw Error(
            `Supported usage requires an agent/inference consumption explanation: ${mechanism.id}`,
          );
        if (usage.basis !== "unresolved" && !usage.source)
          throw Error(`Supported usage requires source evidence: ${mechanism.id}`);
        if (usage.basis === "unresolved" && !usage.note)
          throw Error(`Unresolved usage requires a note: ${mechanism.id}`);
        if (usage.source?.end && usage.source.end < usage.source.start)
          throw Error(`Reversed usage source range: ${mechanism.id}`);
        if (usage.requirements) {
          const assessed = usage.requirements.flatMap((r) => r.inputIds);
          if (
            new Set(assessed).size !== assessed.length ||
            assessed.length !== usage.inputIds.length ||
            assessed.some((id) => !usage.inputIds.includes(id))
          )
            throw Error(`Requirements must cover each usage input exactly once: ${mechanism.id}`);
          for (const requirement of usage.requirements) {
            if ((requirement.level === "conditional") !== Boolean(requirement.condition))
              throw Error(`Only conditional requirements must have a condition: ${mechanism.id}`);
            if (requirement.source.end && requirement.source.end < requirement.source.start)
              throw Error(`Reversed requirement evidence range: ${mechanism.id}`);
          }
        }
        for (const inputId of usage.inputIds) {
          const input = b.inputs.find((i) => i.id === inputId);
          if (!input || (usage.basis !== "unresolved" && !input.stages.includes(usage.stage)))
            throw Error(`Usage input must exist in its phase: ${mechanism.id}/${inputId}`);
        }
      }
    }
    for (const i of b.inputs) {
      if (
        !config.categories.some((c) => c.id === i.category) ||
        i.stages.some((s) => !config.stages.some((t) => t.id === s))
      )
        throw Error(`Unknown classification for ${i.id}`);
      if (new Set(i.stages).size !== i.stages.length) throw Error(`Duplicate stages for ${i.id}`);
      if (i.source.end && i.source.end < i.source.start)
        throw Error(`Reversed source range for ${i.id}`);
      if (i.unavailable && !i.note)
        throw Error(`Unavailable input ${i.id} requires an unresolved note`);
    }
  }
  return m;
}
export function sourceUrl(config: Config, revision: string, input: Pick<Input, "source">): string {
  const path = input.source.path.split("/").map(encodeURIComponent).join("/");
  const end = input.source.end;
  return `${config.repository.url.replace(/\/$/, "")}/${config.repository.forge === "gitlab" ? "-/blob" : "blob"}/${revision}/${path}#L${input.source.start}${end ? (config.repository.forge === "gitlab" ? `-${end}` : `-L${end}`) : ""}`;
}
// Existing decisions remain authoritative until an ordinary YAML edit resolves conflicts.
export function reconcile(previous: Branch | undefined, proposed: Branch): Branch {
  if (!previous) return proposed;
  const inputs = [...proposed.inputs];
  for (const old of previous.inputs) {
    const index = inputs.findIndex((i) => i.id === old.id);
    if (index < 0) {
      inputs.push({
        ...old,
        note: [
          old.note,
          "Unresolved: inference omitted this existing input; retained for reconciliation.",
        ]
          .filter(Boolean)
          .join("\n"),
      });
      continue;
    }
    const next = inputs[index]!;
    const conflict =
      old.category !== next.category ||
      [...old.stages].sort().join() !== [...next.stages].sort().join() ||
      old.name !== next.name;
    inputs[index] = {
      ...next,
      name: old.name,
      category: old.category,
      stages: old.stages,
      note:
        [
          ...new Set(
            [
              old.note,
              next.note,
              conflict
                ? `Unresolved: inference proposed name "${next.name}", category ${next.category}, stages ${next.stages.join(", ")}. Existing decision retained; review the current evidence.`
                : undefined,
            ].filter((v): v is string => !!v),
          ),
        ].join("\n") || undefined,
    };
  }
  const mechanisms = [...(proposed.mechanisms ?? [])];
  for (const old of previous.mechanisms ?? []) {
    const index = mechanisms.findIndex((m) => m.id === old.id);
    if (index < 0) {
      mechanisms.push({
        ...old,
        usages: old.usages.map((u) => ({
          ...u,
          basis: "unresolved",
          source: undefined,
          note: [
            u.note,
            "Unresolved: inference omitted this mechanism; retained for reconciliation.",
          ]
            .filter(Boolean)
            .join("\n"),
        })),
      });
      continue;
    }
    const next = mechanisms[index]!;
    const usages = [...next.usages];
    for (const oldUsage of old.usages) {
      const at = usages.findIndex((u) => u.stage === oldUsage.stage);
      if (at < 0) {
        usages.push({
          ...oldUsage,
          basis: "unresolved",
          source: undefined,
          note: [
            oldUsage.note,
            "Unresolved: inference omitted this phase usage; retained for reconciliation.",
          ]
            .filter(Boolean)
            .join("\n"),
        });
        continue;
      }
      const proposal = usages[at]!;
      const conflict =
        old.name !== next.name ||
        oldUsage.basis !== proposal.basis ||
        [...oldUsage.inputIds].sort().join() !== [...proposal.inputIds].sort().join() ||
        oldUsage.trigger !== proposal.trigger ||
        oldUsage.outcome !== proposal.outcome;
      const assessedRequirements = proposal.requirements;
      usages[at] = conflict
        ? {
            ...oldUsage,
            basis: "unresolved",
            source: undefined,
            note: [
              oldUsage.note,
              `Unresolved: inference proposed mechanism "${next.name}", ${proposal.basis} usage of ${proposal.inputIds.join(", ")}. Trigger: ${proposal.trigger} Outcome: ${proposal.outcome} Evidence: ${proposal.evidence}${proposal.source ? ` (${proposal.source.path}:${proposal.source.start})` : ""}${proposal.note ? ` Note: ${proposal.note}` : ""} Existing usage decision retained for review.`,
            ]
              .filter(Boolean)
              .join("\n"),
          }
        : {
            ...proposal,
            note:
              [...new Set([oldUsage.note, proposal.note].filter(Boolean))].join("\n") || undefined,
          };
      const retained = usages[at]!;
      // Requirement decisions are independent of the relationship's evidence basis.
      if (!oldUsage.requirements && assessedRequirements && !conflict)
        retained.requirements = assessedRequirements;
      if (oldUsage.requirements) {
        const byInput = (rows: Requirement[] | undefined, id: string) =>
          rows?.find((r) => r.inputIds.includes(id));
        retained.requirements = oldUsage.inputIds.map((id) => {
          const oldRequirement = byInput(oldUsage.requirements, id)!;
          const nextRequirement = byInput(assessedRequirements, id);
          const changed =
            !nextRequirement ||
            oldRequirement.level !== nextRequirement.level ||
            oldRequirement.condition !== nextRequirement.condition;
          return changed
            ? {
                ...oldRequirement,
                inputIds: [id],
                note: [
                  oldRequirement.note,
                  nextRequirement
                    ? `Unresolved requirement change: proposed ${nextRequirement.level}${nextRequirement.condition ? ` when ${nextRequirement.condition}` : ""}. Evidence: ${nextRequirement.evidence} (${nextRequirement.source.path}:${nextRequirement.source.start}). Existing decision retained.`
                    : "Unresolved: inference omitted this requirement decision; retained.",
                ]
                  .filter(Boolean)
                  .join("\n"),
              }
            : {
                ...nextRequirement,
                inputIds: [id],
                note:
                  [...new Set([oldRequirement.note, nextRequirement.note].filter(Boolean))].join(
                    "\n",
                  ) || undefined,
              };
        });
      }
    }
    mechanisms[index] = { ...next, name: old.name, usages };
  }
  for (const mechanism of mechanisms)
    for (const usage of mechanism.usages) {
      const elsewhere = usage.inputIds.filter((id) => {
        const input = inputs.find((i) => i.id === id);
        return input && !input.stages.includes(usage.stage);
      });
      if (elsewhere.length) {
        const conflictNote = `Unresolved: proposed use in ${usage.stage} conflicts with retained phase classifications for ${elsewhere.join(", ")}. Existing content placements remain unchanged; review this relationship against its usage evidence.`;
        if (!usage.note?.includes(conflictNote))
          usage.note = [usage.note, conflictNote].filter(Boolean).join("\n");
        usage.basis = "unresolved";
      }
    }
  return { ...proposed, inputs, mechanisms };
}

// Reassessment is explicitly requested, atomic, and preserves inventory identity.
// Unlike normal reconciliation, it applies source-backed placement corrections.
export function reassessBranch(previous: Branch, proposed: Branch): Branch {
  if (previous.id !== proposed.id || previous.revision !== proposed.revision)
    throw Error("Reassessment requires the same branch and revision");
  const sameIds = (a: { id: string }[], b: { id: string }[]) =>
    a.length === b.length &&
    new Set(b.map((x) => x.id)).size === b.length &&
    a.every((x) => b.some((y) => x.id === y.id));
  if (
    !sameIds(previous.inputs, proposed.inputs) ||
    !sameIds(previous.mechanisms ?? [], proposed.mechanisms ?? [])
  )
    throw Error("Reassessment must preserve every input and mechanism ID");
  for (const input of proposed.inputs)
    if (!input.displayName) throw Error(`Reassessment requires displayName: ${input.id}`);
  for (const mechanism of proposed.mechanisms ?? [])
    for (const usage of mechanism.usages) {
      if (!usage.summary) throw Error(`Reassessment requires summary: ${mechanism.id}`);
      if (usage.basis !== "unresolved" && (!usage.lifecycle || !usage.phaseReason))
        throw Error(`Reassessment requires lifecycle evidence and phaseReason: ${mechanism.id}`);
    }
  return proposed;
}
