<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Writing Guide

Write the shortest text that lets the reader act correctly.

NemoClaw applies the plain-language principles from
[ASD-STE100 Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf)
to software engineering. NemoClaw does not claim full ASD-STE100 compliance.
This guide is the NemoClaw source of truth. Do not copy the ASD-STE100 dictionary or its examples into this repository.

## 1. Apply the Guide

Apply this guide to changed explanatory text in:

- Agent responses, progress updates, and final reports.
- Tool labels and descriptions.
- GitHub issues, PRs, reviews, and comments.
- Code comments and user-visible messages.
- Test titles.
- Changelog entries and Announcements.
- Contributor guidance, agent guidance, and user documentation.

Do not apply word or sentence rules to quoted user or external text.
Do not apply them to code, identifiers, commands, URLs, or generated files.
Preserve the accuracy of that content.

### Agent-Written Text

An agent must apply this guide before it:

- Sends a message.
- Publishes text on GitHub.
- Starts a tool call with a visible label or description.

A visible tool label or description must be a concrete verb phrase that names the object.
If the agent cannot follow the applicable rules, it must not perform the action.

### Audits of Existing Text

Review existing text only when the task explicitly requests it.
During that audit:

- Review unchanged text in the assigned sources.
- Exclude generated files unless the task assigns their source or generator.
- Preserve accurate historical statements.
- Report a historical statement only when it is wrong or can misdirect a current action.
- Group repeated low-impact problems into one writing finding.
- Cite representative evidence.
- Do not edit the audited text unless the task also authorizes edits.

## 2. Write Accurate Text

- Verify commands, defaults, and behavior against checked-in source, tests, or scripts.
- Use documentation, issues, and PRs only to find claims and rationale.
- Verify support claims against an accepted issue or accepted design decision.
- For each credential, name its location, access, lifetime, and removal.
- For each conditional or best-effort control, state the failure or fallback result.

## 3. Write Direct Text

- Name the actor when known. Name the action and its object.
- Use passive voice only when the actor is unknown or does not matter.
- State each condition before the action that depends on it.
- Put one instruction in each sentence. Split actions that occur at different times.
- Use `must` for a requirement and `may` for permission.
- Use `can` for capability and `should` for a recommendation.
- Keep instructions at 20 words or fewer when possible.
- Keep descriptions at 25 words or fewer when possible.
- Use a vertical list for three or more independent items when it helps the reader scan them.
- In a code comment, explain a constraint, invariant, or reason that the code does not show.
- Do not restate the code in a comment.
- Make each test title name the behavior and the condition that triggers it.

Remove text that hides the meaning:

- Noun stacks that hide the actor or action.
- Background, restatement, or implementation detail that delays the reader's task.
- Introductions that announce the text instead of stating the result.
- Qualifiers or contrasts that do not add a condition or technical distinction.
- Lists whose item count or symmetry does not help the reader complete the task.
- Adjacent cases that the reader does not need for the stated task.
- Repeated coverage that adds no action, condition, result, or constraint.

Include technical detail only when it changes the reader's action or explains a relevant constraint.
Accuracy takes priority over a word or sentence target.

## 4. Use Consistent Terms

- Use one term for one concept. Do not use synonyms to add variety.
- Use each term with one meaning in a given context.
- Use the shortest familiar term that preserves the technical meaning.
- Use repository terms, identifiers, API names, and necessary domain terms as technical nouns or technical verbs.
- Replace internal workflow shorthand with terms that readers know.
- Name the object of relative terms such as `current`, `latest`, `previous`, and `next`.
- Replace vague judgments with the condition that makes them true.
- Remove `just`, `simply`, `obviously`, `clearly`, `easy`, and `robust` when they add no meaning.
- Remove `exact` when the noun or operation already defines identity or equality.
- Keep `exact` for cardinality or a stated contrast.
- Replace an ambiguous idiom or phrasal verb with a direct technical term.

Use the [NemoClaw Controlled Word List](.agents/skills/_shared/controlled-words.md) for approved terms and their project meanings.
Preserve literal identifiers, commands, output, API fields, quotations, URLs, and official third-party names.

Use these commit terms:

- `commit under review`: the commit whose diff and evidence the reviewer evaluates.
- `latest PR commit`: the commit to which the PR source branch currently points.
- Literal identifiers such as `headRefOid`: preserve them when the identifier matters.

Do not use `head` as a general synonym for a Git commit.

## 5. Report Writing Findings

Review only text changed by the PR unless the task requests an audit of existing text.
Do not report unrelated writing problems in the current review.
Address known writing problems in a separately scoped change.

For each writing finding:

- State the rule that the text violates.
- Cite representative lines within the requested scope.
- Propose a shorter rewrite that preserves the technical meaning.
- Group locations that share one cause and rewrite.

Treat a writing finding as a suggestion unless the wording can change behavior, security, data safety, test meaning, or release meaning.
A blocking finding must name that effect.

## 6. Rewrite Examples

These examples illustrate the rules. They do not add policy.

| Surface | Avoid | Use |
|---|---|---|
| Code comment | `// Handle edge case.` | `// GitHub omits headRepository after a fork is deleted.` |
| Test title | `handles invalid config correctly` | `rejects a config that has no provider` |
| Review comment | `Make this more robust.` | `Return a typed access error for EACCES. Add a denial-path test.` |
| Tool label | `Inspect exact-head delta` | `Compare the latest PR commit with the commit under review` |
| Procedure | `Refresh and rerun as needed.` | `After the refresh creates a commit, push that commit. Then rerun the PR gate.` |
