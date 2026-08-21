// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../../manifest";

// Google Chat is an inbound-webhook channel. Unlike Microsoft Teams (which runs
// its own bot web server on a separate port and needs a host forward), the
// Google Chat webhook is served by the OpenClaw gateway on the shared dashboard
// port (18789) at `/googlechat`. There is no `hostForward`; the tunnel/audience
// enroll hook publishes only that route through a dedicated loopback proxy and
// cloudflared process rather than exposing the full dashboard origin.
export const googlechatManifest = {
  schemaVersion: 1,
  id: "googlechat",
  displayName: "Google Chat",
  description: "Google Chat (Chat API) bot messaging (experimental)",
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "token-paste",
  },
  inputs: [
    {
      id: "serviceAccount",
      kind: "secret",
      required: true,
      envKey: "GOOGLECHAT_SERVICE_ACCOUNT",
      // Cap the mask — a ~2 KB SA JSON would otherwise echo thousands of stars.
      maskCap: 40,
      // Validate the paste now (token-paste hook re-prompts, then skips the
      // channel) so a bad key never reaches token-minting and aborts onboarding.
      // The googlechat.tokenPaste hook parses the paste as JSON; a truncated or
      // malformed paste is re-prompted here instead of failing later at minting.
      formatHint:
        "Paste the entire service-account JSON key on one line (minified) — the whole downloaded JSON file.",
      // Re-prompt on a bad paste — an SA JSON is long and easy to truncate.
      maxTokenAttempts: 3,
      prompt: {
        label: "Google Chat service account JSON",
        help: [
          "┃  GOOGLE CHAT — service account key",
          "┃",
          "┃  Google Cloud Console → IAM & Admin → Service Accounts",
          "┃    → your bot's SA → Keys → Add key → Create new key → JSON",
          "┃",
          "┃  A .json file downloads. Paste its contents below as ONE line (minified).",
          "",
        ].join("\n"),
      },
    },
    {
      id: "audienceType",
      kind: "config",
      required: false,
      envKey: "GOOGLECHAT_AUDIENCE_TYPE",
      statePath: "googlechatConfig.audienceType",
      validValues: ["app-url", "project-number"],
      defaultValue: "app-url",
    },
    {
      id: "audience",
      kind: "config",
      required: false,
      envKey: "GOOGLECHAT_AUDIENCE",
      statePath: "googlechatConfig.audience",
      prompt: {
        label: "Google Chat webhook audience",
        help: "Usually filled automatically from the public tunnel URL. For audienceType 'project-number', enter your GCP project number instead.",
        emptyValueMessage: "inbound webhook verification will be unconfigured",
      },
    },
    {
      id: "appPrincipal",
      kind: "config",
      required: false,
      envKey: "GOOGLECHAT_APP_PRINCIPAL",
      statePath: "googlechatConfig.appPrincipal",
      formatPattern: "^[0-9]{6,32}$",
      formatHint:
        "appPrincipal is the add-on's numeric OAuth client ID (uniqueId, ~21 digits), not an email.",
      prompt: {
        label: "Google Chat appPrincipal",
        help: [
          "  Workspace account   → leave blank, done.",
          "  Personal Gmail      → needs the add-on's ~21-digit ID (not an email), stable across rebuilds.",
          "",
          "  If you already know it, paste it at the prompt and you're done.",
          "  If not, leave it blank — the first DM reveals it once the sandbox is live:",
          "",
          "    1.  Watch the gateway log:",
          '          nemoclaw <sandbox> logs --follow | grep "unexpected add-on principal"',
          "    2.  DM the bot once — it won't reply yet, that's expected. The log prints:",
          "          unexpected add-on principal: <N>",
          "    3.  Save that <N> and rebuild:",
          "          GOOGLECHAT_APP_PRINCIPAL=<N> nemoclaw <sandbox> channels add googlechat",
          "          nemoclaw <sandbox> rebuild --yes",
        ].join("\n"),
        emptyValueMessage: "Workspace accounts do not need it; personal accounts must set it later",
      },
    },
    {
      id: "allowFrom",
      kind: "config",
      required: false,
      envKey: "GOOGLECHAT_ALLOWED_USERS",
      statePath: "allowedIds.googlechat",
      prompt: {
        label: "Google Chat DM allowlist (comma-separated)",
        help: [
          "Optional: restrict who can DM the bot.",
          "    OpenClaw:  users/NNN   (emails ignored)",
          "    Hermes:    email       (users/NNN ignored)",
          "    Blank:     pairing mode (recommended) — OpenClaw's pairing reply shows your users/NNN",
          "  Filling this switches DM policy to allowlist — a wrong-form entry is dropped silently, with no pairing code.",
        ].join("\n"),
        emptyValueMessage: "bot will require manual pairing",
      },
    },
    // ── Hermes-only Pub/Sub pull config ──
    // Hermes supports a webhook too, but NemoClaw pulls instead, so it needs the
    // project and subscription. OpenClaw ignores both. Rendered only into
    // ~/.hermes/.env.
    {
      id: "projectId",
      kind: "config",
      required: false,
      envKey: "GOOGLE_CHAT_PROJECT_ID",
      statePath: "googlechatConfig.projectId",
      prompt: {
        label: "Google Chat GCP project ID (Hermes Pub/Sub pull)",
        help: "The Google Cloud project that owns the Pub/Sub subscription Hermes pulls Chat events from. OpenClaw ignores this.",
        emptyValueMessage: "required for the Hermes Google Chat channel",
      },
    },
    {
      id: "subscriptionName",
      kind: "config",
      required: false,
      envKey: "GOOGLE_CHAT_SUBSCRIPTION_NAME",
      statePath: "googlechatConfig.subscriptionName",
      prompt: {
        label: "Google Chat Pub/Sub subscription (projects/<p>/subscriptions/<s>)",
        help: [
          "The pull subscription bound to the Chat events topic. Hermes pulls from it over the Pub/Sub REST API; the gateway-minted token is scoped to both chat.bot and pubsub.",
          "    Its topic must grant roles/pubsub.publisher to the app's push account:",
          "      Interactive features   service-<projectNumber>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
          "      Classic bot            chat-api-push@system.gserviceaccount.com",
          "      Shown at               Chat API → Configuration → Connection settings",
          "      Missing it             channel connects, no event arrives, Chat says the bot is not responding",
        ].join("\n"),
        emptyValueMessage: "required for the Hermes Google Chat channel",
      },
    },
  ],
  // Outbound auth is gateway-minted: the OpenShell `google-service-account-jwt`
  // refresh provider mints the Google Chat bot token from the pasted service
  // account, and the L7 proxy injects it as `Authorization: Bearer` on
  // chat.googleapis.com. The service-account private key stays gateway-side and
  // never enters the sandbox. The bridge provider + refresh are wired in
  // src/lib/onboard/messaging-bridge-provider.ts; the googlechat-outbound-auth
  // runtime preload makes the plugin send the injected bearer instead of signing
  // in-process. No credentials/secretFiles here — the pasted serviceAccount is
  // consumed only as gateway-side refresh material, never delivered into the sandbox.
  // (The `serviceAccountFile` in `render` below is a start-gate marker only, not a
  // delivered file — see the comment there.)
  // On `channels remove` this gateway-side material is torn down by
  // applyChannelRemoveToGatewayAndRegistry via bridgeProviderNamesForChannel (which
  // deletes the bridge provider from the gateway), not by clearChannelTokens — that
  // clears only per-channel sandbox tokens and is intentionally a no-op for a bridge
  // channel, so an empty `credentials` does not leave the service account behind.
  credentials: [],
  policyPresets: [
    {
      name: "googlechat",
      policyKeys: ["googlechat"],
      // Pub/Sub REST pull + Chat REST reply is a different egress shape from
      // OpenClaw's inbound webhook, so it resolves its own policy key.
      agentPolicyKeys: {
        hermes: ["googlechat_hermes"],
      },
    },
  ],
  render: [
    {
      id: "googlechat-openclaw-channel",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "channels.googlechat",
        value: {
          enabled: true,
          // Start-gate SENTINEL — a deliberately synthetic, non-existent path, NOT a
          // real credential location. OpenClaw's channel-start gate only requires some
          // serviceAccount* to be set (isConfigured: credentialSource !== "none") to
          // start the webhook; it accepts any non-empty string here and does not read
          // the file at start. The token is gateway-minted and proxy-injected, and the
          // googlechat-outbound-auth preload short-circuits the token producer before
          // this path could be read, so no service-account key is ever delivered into
          // the sandbox. (Clean fix is upstream: a non-SA "configured"/accessToken
          // credential source in @openclaw/googlechat — tracked follow-up.)
          serviceAccountFile: "/nonexistent/googlechat-gateway-minted-no-service-account-file",
          audienceType: "{{googlechatConfig.audienceType}}",
          audience: "{{googlechatConfig.audience}}",
          appPrincipal: "{{googlechatConfig.appPrincipal}}",
          webhookPath: "/googlechat",
          healthMonitor: {
            enabled: false,
          },
          dm: {
            policy: "{{allowedIds.googlechat.dmPolicy}}",
            allowFrom: "{{allowedIds.googlechat.values}}",
          },
        },
      },
    },
    {
      id: "googlechat-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.googlechat",
        value: {
          enabled: true,
        },
      },
    },
    {
      // ── Workaround Analysis ──
      // 1. What:  render gateway.reload.mode=off into the sandbox's openclaw.json.
      // 2. Why:   ~60s after boot OpenClaw rewrites its OWN config (adds default
      //           provider-plugin entries); with hot-reload ON it reloads plugins,
      //           rebuilds the HTTP route table and DROPS the Google Chat webhook
      //           route → inbound 404s, bot goes silent ~60s after every start.
      // 3. Alts:  none in-sandbox — the self-write is OpenClaw's; a periodic restart
      //           only resets the timer. Real fix is upstream (5).
      // 4. Risk:  low — the sandbox openclaw.json is build-time-sealed (0600 +
      //           integrity hash), so nothing legitimately reloads it at runtime;
      //           NemoClaw still restarts the gateway explicitly on rebuild/restart.
      // 5. Exit:  upstream reload re-mounts channels (not just plugins) on config
      //           reload → drop this fragment.
      id: "googlechat-openclaw-gateway-reload-off",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "gateway.reload",
        value: {
          mode: "off",
        },
      },
    },
    // ── Hermes render ──
    // Non-secret pull config and the allowlist only: no SA JSON or token reaches
    // the sandbox, which sends the placeholder the L7 proxy swaps.
    {
      id: "googlechat-hermes-env",
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
      lines: [
        "GOOGLE_CHAT_PROJECT_ID={{googlechatConfig.projectId}}",
        "GOOGLE_CHAT_SUBSCRIPTION_NAME={{googlechatConfig.subscriptionName}}",
        "GOOGLE_CHAT_ALLOWED_USERS={{allowedIds.googlechat.csv}}",
      ],
    },
    {
      id: "googlechat-hermes-platform",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "platforms.google_chat",
        value: {
          enabled: true,
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      channelName: "googlechat",
      visibility: {
        configKeys: ["googlechat"],
        logPatterns: ["googlechat"],
      },
      // Interim sandbox-DNS workaround: the sandbox netns is DNS-less (all
      // resolution goes through the L7 proxy), but OpenClaw's Google Chat fetches
      // default to STRICT SSRF mode, which does a LOCAL getaddrinfo first and
      // fails with EAI_AGAIN. This boot preload rewrites the plugin's googleapis
      // fetches (inbound cert verify + all outbound sends) to the guard's
      // first-class `trusted_env_proxy` mode, so they skip the local resolve and
      // route by hostname through the L7 proxy (which resolves + enforces policy).
      // No sentinel IP. It replaces the older googlechat-dns-resolve.ts sentinel
      // shim, and is exactly the upstream OpenClaw fix (trusted-env-proxy fetch,
      // like web_fetch openclaw#50650) applied in the plugin bundle; remove once
      // that lands upstream. See runtime/googlechat-trusted-proxy-fetch.ts.
      //
      // Second boot preload: move OUTBOUND auth off the in-sandbox SA key. By
      // default @openclaw/googlechat signs an auth JWT with the SA private key
      // in-process, which forces the key to live in the sandbox. This preload
      // rewrites the plugin's single token producer to return the OpenShell
      // gateway-minted credential placeholder (GOOGLE_CHAT_ACCESS_TOKEN) so the
      // L7 proxy injects the real bearer outbound and the key never enters the
      // sandbox. See runtime/googlechat-outbound-auth.ts.
      nodePreloads: [
        {
          module: "googlechat-trusted-proxy-fetch",
          injectInto: ["boot"],
          optional: false,
          installMessage:
            "[channels] Installing Google Chat trusted-proxy-fetch patch (route googleapis via trusted env proxy)",
          installedMessage:
            "[channels] Google Chat trusted-proxy-fetch patch installed (NODE_OPTIONS updated)",
        },
        {
          module: "googlechat-outbound-auth",
          injectInto: ["boot"],
          optional: false,
          installMessage:
            "[channels] Installing Google Chat outbound-auth patch (gateway-minted bearer)",
          installedMessage:
            "[channels] Google Chat outbound-auth patch installed (NODE_OPTIONS updated)",
        },
      ],
      secretScans: [
        {
          path: "/sandbox/.openclaw/openclaw.json",
          pattern: "-----BEGIN (?:RSA )?PRIVATE KEY-----",
          message:
            "[SECURITY] Google Chat service account private key leaked into {path} - refusing to serve",
          exitCode: 78,
        },
      ],
    },
  },
  agentPackages: [
    {
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "openclaw-plugin",
      spec: "npm:@openclaw/googlechat@{{openclaw.version}}",
      pin: true,
      integrityByVersion: {
        "2026.7.1":
          "sha512-Dv0xOmcxAThEr6hoK+ioofHNu18hfbIceQrEHX3AHZPpOUiTJvToVpA5eX87NQINewwfSJf0gVhE6kSbSk2Aew==",
      },
      tarballUrlByVersion: {
        "2026.7.1": "https://registry.npmjs.org/@openclaw/googlechat/-/googlechat-2026.7.1.tgz",
      },
      required: true,
    },
    // The base image ships aiohttp but not the google-* SDKs, which the inherited
    // connect() and reply path both need.
    {
      id: "hermesGooglePubsubPackage",
      agent: "hermes",
      manager: "hermes-uv-pip",
      spec: "google-cloud-pubsub==2.39.0",
      required: true,
    },
    {
      id: "hermesGoogleApiClientPackage",
      agent: "hermes",
      manager: "hermes-uv-pip",
      spec: "google-api-python-client==2.194.0",
      required: true,
    },
    {
      id: "hermesGoogleAuthPackage",
      agent: "hermes",
      manager: "hermes-uv-pip",
      spec: "google-auth==2.55.1",
      required: true,
    },
  ],
  hooks: [
    {
      // OpenClaw-only: gates the inbound webhook audience. Hermes pull mode
      // serves no webhook, and running this gate would skip the channel and drop
      // its policy preset.
      id: "googlechat-tunnel-audience-gate",
      phase: "enroll",
      handler: "googlechat.tunnelAudienceGate",
      agents: ["openclaw"],
      inputs: ["audienceType", "audience"],
      outputs: [
        {
          id: "audience",
          kind: "config",
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "googlechat-service-account",
      phase: "enroll",
      handler: "googlechat.tokenPaste",
      outputs: [
        {
          id: "serviceAccount",
          kind: "secret",
          required: true,
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "googlechat-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      outputs: [
        {
          id: "allowFrom",
          kind: "config",
        },
      ],
    },
    {
      // OpenClaw-only: appPrincipal is the add-on's OAuth principal for inbound
      // webhook verification — meaningless to Hermes pull mode.
      id: "googlechat-openclaw-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      agents: ["openclaw"],
      outputs: [
        {
          id: "appPrincipal",
          kind: "config",
        },
      ],
    },
    {
      // Hermes-only: collect the Pub/Sub project + subscription for pull mode.
      id: "googlechat-hermes-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      agents: ["hermes"],
      outputs: [
        {
          id: "projectId",
          kind: "config",
        },
        {
          id: "subscriptionName",
          kind: "config",
        },
      ],
    },
  ],
} as const satisfies ChannelManifest;
