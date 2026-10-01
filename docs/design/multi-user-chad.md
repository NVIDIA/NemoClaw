<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->
# Multi-user Chad — feasibility, tiers, and the upgrade path

**Status:** Tier 0 (stateless) shipping 2026-06-17. Tier 1 (isolated full agents)
designed, not built. **Context:** the operator wants to add more users to the
OpenWebUI Cloudflare Access list without new users polluting the existing
operators' memory (gbrain, lancedb, workspace `USER.md`/`SOUL.md`), and is wary
of running too many heavy instances on a single Mac mini. This doc records the
assessment and the decisions so the limits are known before anyone upgrades a
user to a heavier tier (a likely future **paid tier**).

## The problem

Today Chad serves multiple people through **one** `main` OpenClaw agent. The
shim (`scripts/openwebui/chad-shim.py`) routes by `X-OpenWebUI-User-Email` →
prepends a per-operator identity file (`identities/<slug>.md`) → dispatches one
`openclaw agent --agent main` turn. Consequences:

| Surface | Per-user isolation today |
|---|---|
| OpenWebUI accounts, chat history | ✅ already (per account in `webui.db`) |
| Cloudflare Access | ✅ already (email allowlist; **50-seat** free cap) |
| chad-shim routing | ❌ shared `main` agent (identity prefix only) |
| gbrain | ❌ one file-locked PGLite DB, shared |
| lancedb / wiki / workspace files | ❌ one set, shared |
| autonomy / action-gate | ❌ one policy; a stranger inherits operator gates |

So **two trusted operators is the safe ceiling** for the current design. Adding
strangers to it risks them reading/overwriting tjcooke's training-article memory,
etc. That is the thing to avoid.

## Hardware reality (the budget)

Reference host: **Mac mini M4 Pro (`Mac16,11`), 12 cores, 24 GB RAM.** The live
single Chad pod measures **~2.4 GB** resident (gateway Node + gbrain + shim).

```
24 GB total
 – ~6 GB   macOS + Docker Desktop
 – ~3 GB   OpenWebUI + cloudflared + nvidia-proxy + launchd services
 ───────
 ~15 GB    usable for Chad workloads
```

The real wall is not steady RAM — it's the **local embedding / dream compute**
every full instance runs nightly. That's why "full Chad for everyone" is
infeasible on one mini in any topology, and why a lightweight tier must exist.

## Key insight: multi-agent ≠ multi-pod

OpenClaw **natively runs many fully-isolated agents inside one gateway** — each
with its own `agentDir` (`~/.openclaw/agents/<id>/`), workspace files
(`SOUL.md`/`USER.md`/`AGENTS.md`), session store, and auth profile; inbound
messages route to the right agent via bindings. The shim already passes
`--agent <id>` (`CHAD_SHIM_AGENT`). So per-user isolation is a **provisioning +
routing** change on the existing pod, **not** new infrastructure.

### Limitations of multiple OpenClaw agents in one pod (read before upgrading anyone)

These are the constraints that bound the future "isolated full agent" tier:

1. **Shared crash domain.** One gateway process hosts all agents — an OOM or a
   crash (e.g. the bonjour rejection class) takes *every* agent down at once.
   The host watchdog restarts it, but it's shared fate.
2. **Memory-plugin namespacing is a footgun.** OpenClaw memory plugins can share
   a single `userId` across agents unless you key it by `agentId`; otherwise
   agent A's memories recall for agent B. For Chad specifically:
   - **gbrain** is a single file-locked PGLite DB → isolate via a **per-agent
     `database_path`**. N separate DB files is fine on disk, but N concurrent
     dream/embed passes contend for CPU.
   - **lancedb / wiki** must be **namespaced per agent** or they cross-recall.
3. **N× nightly cron load.** dream / embed / prune / backup run per agent. This,
   not steady RAM, is the scaling ceiling — **stagger them** or they stampede.
4. **No PVC on `/sandbox`.** More agents = more state to back up before any
   pod-recreating operation (the existing ephemeral-sandbox hazard, multiplied).
5. **Shared CPU/RAM/budget.** All agents draw from the same 4 GB gateway heap and
   the same token budget unless budgets are split per agent.

**Practical ceiling on this mini:** ~5–15 *lightly-active* isolated agents in one
gateway (vs ~3–5 full **pods**, which is the heavier alternative). 50 full agents
is not feasible regardless of topology — hence the tiering.

## The options considered

| Option | Isolation | Marginal cost/user | Max on this mini | Effort | Blast radius |
|---|---|---|---|---|---|
| **A. Status quo** (shared agent + identity prefix) | none (shared memory) | ~0 | 2 (trust ceiling) | none | shared |
| **B. Stateless tier** (Nemotron wrapper) | total (no state) | ~0 RAM, tokens only | ~50 | low | isolated |
| **C. Multi-agent, one gateway** | per-agent workspace + memory | disk + N× crons | ~5–15 active | medium | shared gateway |
| **D. Pod per user** | kernel-level | ~2.4–4 GB each | **3–5** | high | independent |

## Decision: a tiered model

1. **Tier 0 — Stateless (Option B), shipping now.** Default for new Cloudflare
   emails. A plain Nemotron Ultra model + generic system prompt, served by
   OpenWebUI. **No OpenClaw agent, no gbrain, no pod state.** Scales to the
   50-seat cap. Memory + web search come from OpenWebUI itself (below).
2. **Tier 1 — Isolated full agent (Option C), future / likely paid.** For users
   who genuinely need memory + tools + autonomy: their own `--agent <id>` with
   isolated workspace, **per-agent gbrain DB**, namespaced lancedb/wiki, and an
   all-`block` action-gate to start. Bounded by the limitations above.
3. **Tier 2 — Dedicated pod (Option D), reserve.** Only for a user needing
   kernel-level isolation (sensitive data). Not a default; doesn't scale.
4. **Promotion path:** a Tier-0 user who needs persistence is provisioned a
   Tier-1 agent. Clean teardown = drop the `agentDir` + gbrain DB.

Cloudflare cliff: seat **51 flips the whole org to $7/user/mo** (no partial
billing). The 50 cap is a real planning boundary — and a natural place to gate a
paid tier.

## Tier 0, in detail — memory + web search without an agent

OpenWebUI 0.9.5 (already deployed, in front of the shim) provides, **per user
account**:

- **Web search** — 15+ providers, per-conversation toggle, works with *any*
  model (RAG-style: searches, injects snippets + citations, model answers).
  Keyless: DuckDuckGo. Recommended: self-hosted **SearXNG** (private, no keys).
- **Memory** — native per-user persistent memories injected into context.
  Lighter than gbrain (no vector+graph), but it *is* cross-chat memory, scoped
  to the account. Optional: an "adaptive memory" Function to auto-populate it.
- **Knowledge (RAG)** — per-user document collections with citations.
- **Tools** — attach Python tools; native tool-calling works (Nemotron Ultra is
  tool-capable, `reasoningSafe`).

So Tier 0 = **a workspace model** (Nemotron Ultra + system prompt + web search +
Memory), isolated by account. Egress for web search is the **OpenWebUI
container's**, so it bypasses the sandbox L7 entirely — fine for a tier with no
sensitive state, and no policy work.

### Sub-options within Tier 0

| | What | New code | Egress / L7 |
|---|---|---|---|
| **0a. OpenWebUI-native** (CHOSEN) | workspace model + OWUI Memory + OWUI web search | ~none | OWUI container (bypasses sandbox L7) |
| 0b. Shim mini tool-loop | ~150-line `ToolLoopAgent` + `web_search` tool + flat `memories/<slug>.md` | medium | inside sandbox → must L7-allowlist the search host for the shim binary |
| 0c. Smithers per-turn workflow | durable workflow per message | high | per agent — overkill for chat latency |

**0b** is the fallback only if Tier 0 must be reachable **outside** OpenWebUI
(raw API clients, another front-end) or needs a tightly controlled tool set.
**0c** is rejected for interactive latency.

## Tier model as of 2026-10-01 (current)

- **Premium = the `chad` model** (full agent + gbrain + tools), gated by the shim
  `CHAD_OPERATOR_ALLOWLIST` (`tantodefi@proton.me`, `tjcooke@protonmail.com`).
  Non-operators selecting `chad` get the polite refusal; the model is visible but
  refused (`BYPASS_MODEL_ACCESS_CONTROL=True`).
- **Free = the `chad-lite` model** → **`nvidia/nemotron-3-nano-4b`** served by
  **LM Studio on the host** (`http://host.docker.internal:1234/v1`, reached from
  the container via `host.docker.internal`, NOT `127.0.0.1`). Native
  tool-calling enabled, public, honest system prompt (no private data / no
  agent). Created via `POST /api/v1/models/create` (base
  `nvidia/nemotron-3-nano-4b`). Verified: completion to `chad-lite` returns from
  the nano.
- The LM Studio OWUI connection (openai index 2) is **filtered to only
  `nvidia/nemotron-3-nano-4b`** (`openai.api_configs["2"].model_ids`) so the
  other, larger LM Studio models (27B bonsai/qwen/gemma) that don't load well are
  never exposed in the dropdown.
- This supersedes the original Tier-0 "Nemotron Ultra via the cloud" idea below
  with a **local, free, tool-capable** small model.

## What shipped (2026-06-17) — Tier 0 / 0a

- **`scripts/openwebui/chad-provision-tier0.sh`** — creates the Tier-0 "Chad
  Lite" model via `chad-webui` (Nemotron Ultra base + a generic, honest system
  prompt that explicitly says it has no private-data access), then prints the
  operator checklist for the non-API steps.
- **`chad-webui models create/update --access-control`** — new passthrough so a
  model's OpenWebUI ACL can be scripted (used to keep the powerful `chad` model
  restricted to operators while the Tier-0 model stays public).

- **SearXNG container** (`docker-compose.yml` + `searxng/settings.yml`) — private,
  keyless, no-rate-limit web search for Tier 0, reached by OpenWebUI at
  `http://searxng:8080` on the stack network (never host/internet exposed). The
  web-search envs (`ENABLE_WEB_SEARCH` / `WEB_SEARCH_ENGINE` / `SEARXNG_QUERY_URL`)
  are OpenWebUI **PersistentConfig** — they seed a *fresh* `webui.db` only; on the
  existing db, set it in admin → Settings → Web Search. New `.env` key:
  `SEARXNG_SECRET` (`openssl rand -hex 32`).

Operator-manual steps (no API; in the checklist the script prints):

1. Enable **web search** (SearXNG container + admin → Settings → Web Search;
   query URL `http://searxng:8080/search?q=<query>&format=json`).
2. **Restrict the `chad` model** to operators so new users can't select it.
3. Add the new emails to **Cloudflare Access** (see account flow below).

Result: new users get Nemotron Ultra + web search + their own memory, with **no**
access to Chad's agent, gbrain, or anyone else's data — and **zero** new pod load.

### Gating the premium `chad` model (2026-06-17)

Goal: Chad Lite users keep the full NVIDIA model dropdown but **cannot use the
premium `chad` agent** (which fronts the shared agent + gbrain).

Why not OpenWebUI model ACLs: the stack runs `BYPASS_MODEL_ACCESS_CONTROL=True`
so the NVIDIA base models show to everyone. Flipping it off to hide `chad` would
*also* hide every NVIDIA base model from regular users — the opposite of what we
want. `chad` and the NVIDIA models are all connection/base models, so OpenWebUI's
single global flag can't separate them.

So the gate is **server-side in the shim**, independent of model visibility:
`chad-shim.py` reads `CHAD_OPERATOR_ALLOWLIST` (env → `credentials.json` fallback;
comma-string or JSON list). When set, only those emails reach the agent; any
other authenticated user who selects `chad` gets a polite "use Chad Lite"
refusal (`DENY_MESSAGE`) and never touches the agent/gbrain. Unset/empty =
allow-all (opt-in, backward-compatible); anonymous callers (direct API/health)
allowed. The list lives in `credentials.json` (pod-local, uncommitted, in the
backup set) so it persists across restarts with no launch-script edits and no
operator emails in the repo.

Net: `BYPASS_MODEL_ACCESS_CONTROL` **stays `True`** (NVIDIA models visible to
all); `chad` is visible-but-refused to non-operators. The protection is the
guarantee; the dropdown name is cosmetic. (Truly hiding only `chad` from the
dropdown while keeping NVIDIA models would require a custom workspace-model per
NVIDIA model + `BYPASS=False` — not worth it.)

## How new accounts work (auth flow)

This deployment runs **trusted-header SSO**, verified on the live container:
`WEBUI_AUTH_TRUSTED_EMAIL_HEADER=Cf-Access-Authenticated-User-Email`,
`DEFAULT_USER_ROLE=user`, `ENABLE_SIGNUP=False`. So:

- **You add a user in the Cloudflare Access policy only.** Cloudflare is the gate
  *and* the identity source. There is **no separate OpenWebUI whitelist** and
  **no email invite** to send.
- **OpenWebUI auto-provisions the account on first login.** After the user
  passes Cloudflare, OpenWebUI reads the `Cf-Access-Authenticated-User-Email`
  header and creates the `webui.db` row automatically. `ENABLE_SIGNUP=False`
  doesn't block this — trusted-header auth bypasses the signup form.
- **Role is set automatically:** `DEFAULT_USER_ROLE=user` → new users are active,
  regular `user` role (not admin, not a pending-approval state). No admin click
  needed. (The very first account ever created is admin; existing operators
  already hold that.)
- **The DB row appears only *after* first login.** Consequence: you can't
  pre-set per-user things (or scope a model by a specific `user_id`) until each
  user has logged in once. Prefer **group-based ACLs**, or simply "restrict the
  `chad` model, leave `chad-lite` public," which needs no per-user ids.

In short: **Cloudflare list = the whitelist.** OpenWebUI fills itself in on first
visit; you never touch the OpenWebUI user table for onboarding.

## Possible improvements (log as they come up)

- **Tier 1 build (the paid tier).** Provisioner `chad-provision-user <email>`:
  create `agentDir`, seed generic workspace files, init a **per-agent gbrain DB**,
  namespace lancedb/wiki by `agentId`, set an all-`block` action-gate, register
  the email→agentId map in the shim. Stagger that agent's nightly crons. Track in
  the todo list (related: [[project_chad_autonomy_roadmap]]).
- **Shim email→tier+agent routing.** Upgrade the shim from `email→identity-prefix`
  to `email→{tier, agentId}`: Tier 0 → direct Nemotron path; Tier 1 → `--agent`.
- **Adaptive-memory Function** for Tier 0 (auto-extract memories per turn).
- ~~SearXNG container for robust private web search~~ — **shipped 2026-06-17**.
- **Per-agent token budgets** so one Tier-1 user can't drain the shared pool.
- **0b shim tool-loop** if Tier 0 ever needs to live outside OpenWebUI.
- **Resource re-measure** before committing a headcount: measure a *second* full
  agent under load — the ~2.4 GB/pod figure is a single-agent baseline.

## Sources

- Cloudflare Zero Trust free plan — 50 seats, then $7/user/mo (no partial
  billing), 24h log retention, 3-location cap:
  <https://www.cloudflare.com/plans/zero-trust-services/>,
  <https://costbench.com/software/business-vpn/cloudflare-zero-trust/free-plan/>
- OpenClaw multi-agent (per-agent `agentDir`, workspace, sessions; routing via
  bindings): <https://docs.openclaw.ai/concepts/multi-agent>,
  <https://lumadock.com/tutorials/openclaw-multi-agent-setup>
- OpenClaw shared-memory-across-agents caveat (key memory by `agentId`):
  <https://hindsight.vectorize.io/guides/2026/04/20/guide-openclaw-shared-memory-across-agents>
- OpenWebUI RAG / web search / memory (15+ providers, per-user, any model):
  <https://docs.openwebui.com/features/chat-conversations/rag/>
