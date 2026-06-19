---
name: nemoclaw-contributor-onboard-messaging-channel
description: Guide NemoClaw contributors through adding or reviewing a new messaging channel in the manifest-first messaging architecture. Use when onboarding a channel for OpenClaw, Hermes, or both; mapping upstream channel docs and source code into NemoClaw manifests; confirming credentials, plugin/package installs, reachability checks, network policy presets, docs, and tests. Trigger keywords - add messaging channel, onboard messaging channel, new channel, messaging integration, channel manifest, OpenClaw channel, Hermes channel, plugin install, reachability check.
---

# Onboard Messaging Channel

Use this skill to add a messaging channel end-to-end without leaking channel-specific logic into core NemoClaw code.

## Intake

Gather inputs progressively. Do not ask the full intake checklist in one message.
Ask exactly one concise clarification at a time, choosing the earliest unresolved blocker:

1. If the channel name is missing, ask for the channel name.
2. If target agents are missing, ask whether the channel should support OpenClaw, Hermes, or both.
3. If upstream references are missing, ask for the official docs link and source-of-truth implementation link or path. Include Telegram as the format example: docs `https://docs.openclaw.ai/channels/telegram`, source `https://github.com/openclaw/openclaw/tree/main/extensions/telegram`.
4. After references are available, read them and the local messaging package before asking about credentials, plugin installs, reachability, or network policy.
5. Ask follow-up questions one by one only for details that remain ambiguous after source analysis.

Use this intake checklist internally while analyzing source:

- Channel name and target agents: OpenClaw, Hermes, or both. Treat unsupported agents as intentionally out of scope unless the user provides source evidence.
- Official channel documentation link and source-of-truth implementation link or path. Prefer upstream extension/runtime code over README prose when they conflict.
- Required credentials and config inputs: token environment variables, bot or app IDs, user IDs, workspace/guild/group IDs, allowlists, app secrets, webhook secrets, socket-mode/app tokens, QR pairing, callback URLs, or proxy settings.
- Plugin or package install requirements: package name, install manager, version pinning, bundled versus external status, extension ID, and whether the package must be installed during image build.
- Reachability or health evidence: endpoint or command, HTTP method, auth semantics, success response, invalid-credential response, transient-network behavior, and whether tests need a skip env var for fake credentials.
- Network reachability: exact hostnames required at runtime, whether they are agent-only or bridge-only, and whether the policy should be opt-in.

When asking a follow-up, include the source-derived fact that made the question necessary. Example: "The upstream extension enables a webhook secret, but I do not see whether NemoClaw should prompt for it. Should this be a required input?"

## Source Analysis

Before editing, read:

- Root `AGENTS.md` and `CONTRIBUTING.md`.
- `src/lib/messaging/AGENTS.md`.
- The closest existing channel manifests and tests under `src/lib/messaging/channels/`.
- The upstream docs and source code supplied by the user.

Compare the new channel to existing patterns:

- Token plus API reachability: Telegram-style.
- Multiple credentials, socket mode, or channel-owned conflicts: Slack-style.
- Allowlists or scoped IDs: Discord-style.
- QR or pairing flow with runtime status: WeChat or WhatsApp-style.
- Agent-specific plugin install and config render: channels that require external agent extensions.

When docs and source disagree, implement from source code and note the inference in the final handoff.

## Implementation Workflow

Start with the manifest. Add core code only when the manifest vocabulary cannot express a reusable concept.

1. Add `src/lib/messaging/channels/<channel>/manifest.ts` with `auth`, `inputs`, `credentials`, `policyPresets`, `render`, `runtime`, `agentPackages`, `state`, and `hooks` as needed.
2. Add `channels/<channel>/template-resolver.ts` only for derived render values, such as allowlist normalization, booleans, proxy URLs, or agent-specific schema differences.
3. Add hooks under `channels/<channel>/hooks/` only for enrollment, external reachability checks, QR capture, conflict checks, runtime status, or health probes that cannot be static manifest data.
4. Register the manifest in `channels/built-ins.ts`, template resolver in `channels/template-resolver.ts`, and hook handlers in `hooks/builtins.ts`.
5. Add `nemoclaw-blueprint/policies/presets/<channel>.yaml` when the manifest declares a policy preset. Keep messaging-specific egress opt-in unless the project policy says otherwise.
6. Update `agents/openclaw/manifest.yaml` and/or `agents/hermes/manifest.yaml` so supported platforms match the manifest `supportedAgents`.
7. Add agent package install metadata when the channel needs an external agent plugin. For OpenClaw plugin packages, use this shape unless source evidence says otherwise:

   ```ts
   agentPackages: [
     {
       id: "openclawPluginPackage",
       agent: "openclaw",
       manager: "openclaw-plugin",
       spec: "npm:@openclaw/<channel>@{{openclaw.version}}",
       pin: true,
       required: true,
     },
   ],
   ```

8. Update docs for user-facing behavior, usually `docs/manage-sandboxes/messaging-channels.mdx`, command references, network policy references, and troubleshooting.

## Quality Gates

- Validate the runtime config schema from upstream code. Do not copy another channel's nested config shape blindly without source evidence.
- If `render` enables a plugin entry, confirm the install source exists or document why it is bundled.
- Keep Hermes unsupported when only OpenClaw source support exists, and vice versa.
- Keep channel-specific conditionals out of onboard, rebuild, compiler, applier, and generated-config entrypoints unless the change is a general manifest capability.
- Persist only non-secret state. Plans may contain placeholders, availability flags, and hashes, never raw tokens.
- Mock external APIs in tests. Unit tests must not call real messaging providers.
- Use a skip env var for live reachability hooks when fake credentials are valid for local tests.
- Make policy hostnames exact and scoped to the channel preset.

## Verification

Use the narrowest tests that cover the changed behavior:

```bash
npm run build:cli
npm run typecheck:cli
npx vitest run src/lib/messaging/channels/manifests.test.ts src/lib/messaging/channels/metadata.test.ts src/lib/messaging/compiler/manifest-compiler.test.ts
npx vitest run src/lib/messaging/channels/<channel>/hooks
npx vitest run test/messaging-build-applier.test.ts
```

Add channel-specific config render, hook, policy, and channel add/remove tests when those surfaces change.
Run `npm run docs` for documentation changes and `npx prek run --files <changed files>` before handoff. If broad hooks expose unrelated failures, report the failure with the targeted passing evidence.
