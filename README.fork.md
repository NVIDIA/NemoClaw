# NemoClaw (maggiezha fork)

Personal fork of [NVIDIA/NemoClaw](https://github.com/NVIDIA/NemoClaw) with **Tavily Web Search**, **Nemotron Ultra via NVIDIA Inference Hub**, **Telegram** messaging, and **split API credentials** (`nvapi-*` vs `sk-*`).

- **Fork:** https://github.com/maggiezha/NemoClaw  
- **Branch:** `2026-05-27-0hlj`  
- **Upstream docs:** https://docs.nvidia.com/nemoclaw/latest/

> This document describes **this fork only**. For the standard NemoClaw install, prerequisites, and architecture, see **[README.md](README.md)** in this repo (same as [NVIDIA/NemoClaw](https://github.com/NVIDIA/NemoClaw)) and the [NVIDIA documentation](https://docs.nvidia.com/nemoclaw/latest/).

---

## What this fork adds

| Feature | Summary |
|--------|---------|
| **Tavily Web Search** | Choose Tavily during onboard; `tavily` network preset; OpenClaw `plugins.entries.tavily` + `tools.web.search.provider=tavily` |
| **Nemotron Ultra** | First-class cloud model on **Inference Hub** 
| **Telegram plugin fix** | Enables `plugins.entries.telegram` when Telegram is in messaging channels (OpenClaw 2026.5.x) |

---

## Quick start (this fork)

### 1. Clone and build

```bash
git clone https://github.com/maggiezha/NemoClaw.git
cd NemoClaw
git checkout 2026-05-27-0hlj
npm install --ignore-scripts
npm run build:cli
```

Use the repo CLI (not an old global install):

```bash
export PATH="$PWD:$PATH"   # or: alias nemoclaw='node bin/nemoclaw.js'
node bin/nemoclaw.js --version
```

### 2. API keys (`~/.nemoclaw/secrets.env`)

```bash
node bin/nemoclaw.js credentials init-secrets
# Edit ~/.nemoclaw/secrets.env — never commit real keys
```

| Variable | Format | Used for |
|----------|--------|----------|
| `NVIDIA_INFERENCE_HUB_API_KEY` | `sk-...` | **Nemotron Ultra** |
| `NVIDIA_API_KEY` | `nvapi-...` | Nemotron Super / Build models → `https://integrate.api.nvidia.com/v1` |
| `TAVILY_API_KEY` | `tvly-...` | Tavily web search |
| `TELEGRAM_BOT_TOKEN` | from @BotFather | Telegram bot |

Get keys:

- Inference Hub
- NVIDIA Build: https://build.nvidia.com/settings/api-keys  
- Tavily: https://tavily.com  
- Telegram: [@BotFather](https://t.me/BotFather) → `/newbot`

### 3. Onboard

```bash
set -a && source ~/.nemoclaw/secrets.env && set +a
node bin/nemoclaw.js onboard
```

During onboard:

1. **Inference** → NVIDIA Endpoints → **Nemotron Ultra 253B** (uses Inference Hub key).  
2. **Web search** → **Yes** → **2) Tavily Search** → paste `TAVILY_API_KEY`.  
3. **Messaging** → enable **Telegram** (or add later with `channels add telegram`).

Non-interactive resume (example):

```bash
export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_SANDBOX_NAME=my-assistant
export TELEGRAM_ALLOWED_IDS=<your_telegram_user_id>
export TELEGRAM_REQUIRE_MENTION=1
node bin/nemoclaw.js onboard --resume
```

### 4. Telegram bot token (if not done in onboard)

On your Mac/phone (not on the VM): create bot with @BotFather, copy token.

On the VM:

```bash
node bin/nemoclaw.js my-assistant channels add telegram
# Paste TELEGRAM_BOT_TOKEN when prompted; confirm rebuild
```

---

## Steps taken to add Tavily Web Search

1. **Policy** — Added `nemoclaw-blueprint/policies/presets/tavily.yaml` (egress to `api.tavily.com`).  
2. **Onboard flow** — Extended `src/lib/onboard/web-search-flow.ts`: prompt “Brave vs Tavily”, validate Tavily key, save `TAVILY_API_KEY`, set `NEMOCLAW_WEB_SEARCH_PROVIDER=tavily`.  
3. **Types / env** — `src/lib/inference/web-search.ts`: `WebSearchProvider`, `TAVILY_API_KEY_ENV`, `resolveWebSearchProvider()`.  
4. **Sandbox build** — `src/lib/onboard/dockerfile-patch.ts` patches `NEMOCLAW_WEB_SEARCH_ENABLED` and `NEMOCLAW_WEB_SEARCH_PROVIDER`.  
5. **OpenClaw config** — `scripts/generate-openclaw-config.py`:  
   - `tools.web.search` with `provider: tavily`  
   - `plugins.entries.tavily.config.webSearch.apiKey` (OpenClaw 2026.5+; legacy `tools.web.search.tavily.*` stripped)  
6. **Credentials in sandbox** — `src/lib/onboard.ts`: register `*-tavily-search` OpenShell provider; fail fast if key missing before recreate (#3626).  
7. **Resume / rebuild** — `src/lib/onboard/machine/handlers/sandbox.ts`: revalidate Tavily (not Brave) when provider is Tavily.  
8. **Verification** — `src/lib/onboard/web-search-verify.ts` + post-onboard probe in finalization.  
9. **Agent hint** — Workspace instruction: reply **“Tavily Web Search is used”** when search runs.  
10. **Helpers** — `scripts/setup-tavily-search.sh`, `scripts/test-tavily-flow.sh` for pre-commit smoke checks.

**Enable Tavily on an existing sandbox:**

```bash
./scripts/setup-tavily-search.sh my-assistant
```
<img width="2186" height="1716" alt="Screenshot 2026-05-27 at 2 53 37 PM" src="https://github.com/user-attachments/assets/0f99486c-fd26-43ab-9a72-d827d627667d" />


---

## Steps taken to add Nemotron Ultra (Inference Hub)

1. **Routing** — `src/lib/inference/config.ts`:  
   - `resolveNvidiaCloudModelRoute()` sends Ultra to `inference-api.nvidia.com` with `NVIDIA_INFERENCE_HUB_API_KEY`  
   - Super / other catalog models stay on `integrate.api.nvidia.com` with `NVIDIA_API_KEY`  
   - Ultra uses OpenAI-compatible provider type (`openai`), not legacy `nvidia` → integrate  
2. **Cloud model list** — `nemoclaw/src/index.ts`: Nemotron Ultra 253B under **NVIDIA Endpoints → Cloud models**.  
3. **Onboard** — Pick model first → set `endpointUrl` + `credentialEnv` → `ensureNvidiaEndpointCredential()`.  
4. **Validation** — `src/lib/validation.ts`: strict key shapes (`sk-*` only on Inference Hub env, `nvapi-*` on Build env).  
5. **Credentials** — `src/lib/credentials/store.ts` + `secrets-env.ts`: load `~/.nemoclaw/secrets.env`; `nemoclaw credentials init-secrets`.  
6. **Resume repair** — `provider-inference.ts` fixes `credentialEnv` / `endpointUrl` for `nvidia-prod` from selected model.  
7. **Reference client** — `scripts/examples/nemotron-ultra-inference.py` (uses `NVIDIA_INFERENCE_HUB_API_KEY`).


<img width="2186" height="1716" alt="Screenshot 2026-05-27 at 2 53 37 PM" src="https://github.com/user-attachments/assets/3ad8a05d-4f5a-4443-aff3-24d8feadfe1f" />


---

## Steps taken for Telegram

1. Create bot via [@BotFather](https://t.me/BotFather) (`/newbot`) on Mac/phone — copy token.  
2. `node bin/nemoclaw.js <sandbox> channels add telegram` — paste token; rebuild sandbox.  
3. Store `TELEGRAM_BOT_TOKEN` in `~/.nemoclaw/secrets.env` for non-interactive runs.  
4. Network policy preset `telegram` → `api.telegram.org`.  
5. DM allowlist: `TELEGRAM_ALLOWED_IDS` (your numeric user ID).  
6. Groups: `TELEGRAM_REQUIRE_MENTION=1` — bot only answers when @mentioned.  
7. **Plugin fix** — `generate-openclaw-config.py` sets `plugins.entries.telegram.enabled: true` when Telegram is configured (otherwise gateway has config but no polling).

**Get your Telegram user ID:** message [@userinfobot](https://t.me/userinfobot) or inspect gateway logs after you DM the bot (`Inbound message telegram:<id>`).

---

## Telegram test questions

Use **DM** first (simplest). In a **group**, **@mention** the bot on every message.

### 1. Basic reply (Nemotron Ultra only)

Confirms inference works end-to-end.

- `Hello — are you there? Reply in one sentence.`
- `What is 17 × 23? Show the answer only.`
- `In one paragraph, what is NVIDIA Nemotron?`


### 2. Tavily / web search

<img width="1642" height="732" alt="Screenshot 2026-05-27 at 5 41 04 PM" src="https://github.com/user-attachments/assets/277409c2-fc2f-4712-a27b-617d2547a05d" />


Ask for **current** or **live** info so the agent should call Tavily.

- `Use web search: what is today's date and one major tech headline from today?`
- `Search the web for the latest news about NVIDIA Nemotron Ultra and summarize in 3 bullets.`
- `Use Tavily to find the current price of Bitcoin and cite the source URL.`
- `Web search: who won the most recent Super Bowl? Include the year.`

### 3. Search + reasoning

- `Search the web for NVIDIA's latest earnings or product news, then explain in 2 sentences why it matters for AI developers.`
- `Find today's weather in San Francisco using web search, then suggest what to wear.`

### 4. Follow-up (same chat thread)

Send after a successful answer:

- `Summarize what you just told me in one sentence.`
- `What source did you use for that?` (after a web-search answer)

### 5. Negative / edge cases

- `Do not use web search: what is the capital of France?` (should answer without browsing)
- `Search the web for xyznonexistenttopic12345zzz` (weak or empty results)

### 6. Group chat

Format:

- `@YourBotName Use web search: what happened in AI news this week?`

Also set BotFather **Group Privacy** to **Disabled** if the bot must see all group messages (otherwise only commands/@mentions reach it).

### What “good” looks like

| Test | Good sign |
|------|-----------|
| Basic | Fast text reply |
| Web search | Recent info, links/snippets, or **“Tavily Web Search is used”** |
| No search | Answers without claiming it browsed the web |
| Follow-up | Stays on topic in the same thread |

**Recommended order:** run **§1** then **§2** (`Use web search: what is today's date...`) to confirm Ultra + Tavily quickly.

### If something fails

| Symptom | What to check |
|---------|----------------|
| No reply in DM | `node bin/nemoclaw.js my-assistant logs --follow` |
| No reply in group | @mention the bot; BotFather privacy **Disabled** |
| Reply but no web | Say: `You must use web search for this.` |
| Silent bot, logs show `HTTP 404` / `model_not_found` | Ultra must use **Inference Hub** (`sk-*`, `inference-api.nvidia.com`), not integrate.api — re-onboard or fix `nvidia-prod` provider |
| Rebuild wiped Telegram | Confirm `plugins.entries.telegram.enabled` in sandbox `openclaw.json` |

**Avoid** `channels stop telegram` if it triggers a full rebuild you did not intend — prefer `recover` or gateway restart when possible.

---

## Useful commands

```bash
# Status
node bin/nemoclaw.js my-assistant status

# Logs (while testing Telegram)
node bin/nemoclaw.js my-assistant logs --follow

# Tavily smoke (no full sandbox)
npm run build:cli && ./scripts/test-tavily-flow.sh

# Non-interactive resume
NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_SANDBOX_NAME=my-assistant \
  node bin/nemoclaw.js onboard --resume
```

---

## Git workflow (fork only)

Work on a feature branch — **do not** put custom commits on `main`:

```bash
git checkout 2026-05-27-0hlj
git push fork 2026-05-27-0hlj
```

`main` on this fork tracks [NVIDIA/NemoClaw main](https://github.com/NVIDIA/NemoClaw); upstream is unchanged unless you open a PR there.

---

## Key files (fork diff)

| Area | Files |
|------|--------|
| Inference Hub / Ultra | `src/lib/inference/config.ts`, `nemoclaw/src/index.ts`, `src/lib/credentials/*`, `src/lib/validation.ts` |
| Tavily | `src/lib/onboard/web-search-flow.ts`, `scripts/generate-openclaw-config.py`, `nemoclaw-blueprint/policies/presets/tavily.yaml` |
| Telegram plugin | `scripts/generate-openclaw-config.py` |
| Secrets | `secrets.env.example`, `src/lib/credentials/secrets-env.ts` |
| Tests | `test/generate-openclaw-config.test.ts`, `src/lib/onboard/web-search-verify.test.ts`, `src/lib/inference/config.test.ts` |

---

## License

Same as upstream: **Apache-2.0**. See [LICENSE](LICENSE).
