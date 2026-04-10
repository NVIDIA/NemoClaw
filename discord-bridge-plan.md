# Plan: Build NemoClaw Discord Bridge

## TL;DR

Build a Discord message bridge (`discord-bridge.js`) that forwards messages between a Discord channel and the sandboxed OpenClaw agent, matching full Telegram bridge parity: bridge script, start-services integration, discord-probe diagnostics, CLI wiring, tests, and docs.

**Approach:** HTTP REST polling against Discord's REST API (no new dependencies - uses Node.js built-in `https`, mirroring the Telegram bridge pattern exactly). Polls `GET /channels/{id}/messages?after={last_id}` and responds via `POST /channels/{id}/messages`.

## Why not WebSocket/discord.js?

- The Telegram bridge uses zero external deps (just Node `https`) - consistency matters
- The bridge runs on the host (not sandbox), so the `gateway.discord.gg` CONNECT tunnel in the discord policy is not required for the bridge process itself
- REST polling is sufficient for bridge latency (1-3s poll interval, sub-5s response)
- Avoids adding discord.js or ws dependency

## Phase 1: Discord Bridge Script

### Step 1. Create `scripts/discord-bridge.js`

Mirror `scripts/telegram-bridge.js` structure.

Env vars:

- `DISCORD_BOT_TOKEN`
- `NVIDIA_API_KEY`
- `SANDBOX_NAME`
- `DISCORD_CHANNEL_ID`
- `ALLOWED_USER_IDS`

Key responsibilities:

- Poll channel messages through Discord REST API
- Ignore bot-authored messages
- Add an eyes reaction on receive
- Forward the prompt to the sandboxed OpenClaw agent
- Reply in-thread or directly in-channel with the agent response

## Phase 2: Service Integration

### Step 2. Update `scripts/start-services.sh`

- Start `discord-bridge` when `DISCORD_BOT_TOKEN` is configured
- Track PID and logs alongside the Telegram bridge
- Include it in `status` and `stop`

### Step 3. Update `bin/nemoclaw.js`

- Add `discord-probe`
- Keep `start` / `stop` / `status` behavior unchanged aside from surfacing the new service

## Phase 3: Diagnostics

### Step 4. Create `bin/lib/discord-diagnostics.js`

- Probe DNS, HTTPS, proxy routing, and authenticated bot access for Discord
- Follow the same token resolution order as Telegram diagnostics

## Phase 4: Tests

### Step 5. Add tests

- `test/discord-bridge.test.js`
- `test/discord-diagnostics.test.js`

## Phase 5: Documentation

### Step 6. Add setup docs

- Create a Discord setup guide
- Update the commands reference

## Verification

1. `npx vitest run test/discord-bridge.test.js test/discord-diagnostics.test.js`
2. `npx eslint scripts/discord-bridge.js bin/lib/discord-diagnostics.js`
3. Manual run with `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID`
