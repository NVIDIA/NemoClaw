// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(test)]
mod tests {
    use crate::authoring::{
        Answers, ApiChoice, Capabilities, DirectInputs, HarnessChoice, Session,
    };
    use nemoclaw_sdk::config::{Document, MAX_DOCUMENT_BYTES};
    use serde_json::{Value, json};
    use std::collections::HashSet;

    const V0_SOURCE_REVISION: &str = "d9c33770772f06264b3a45b52fe9efc6d83aa34f";
    const V0_SOURCE_DATE: &str = "2026-09-17";
    const UID: &str = "12345678-1234-4234-9234-123456789abc";
    const ISSUE_12022: &str = "https://github.com/NVIDIA/NemoClaw/issues/12022";
    const ISSUE_12029: &str = "https://github.com/NVIDIA/NemoClaw/issues/12029";
    const ISSUE_12032: &str = "https://github.com/NVIDIA/NemoClaw/issues/12032";
    const ISSUE_12034: &str = "https://github.com/NVIDIA/NemoClaw/issues/12034";
    const ISSUE_12035: &str = "https://github.com/NVIDIA/NemoClaw/issues/12035";
    const ISSUE_12036: &str = "https://github.com/NVIDIA/NemoClaw/issues/12036";
    const ISSUE_12037: &str = "https://github.com/NVIDIA/NemoClaw/issues/12037";
    const ISSUE_12038: &str = "https://github.com/NVIDIA/NemoClaw/issues/12038";
    const ISSUE_12040: &str = "https://github.com/NVIDIA/NemoClaw/issues/12040";
    const ISSUE_12042: &str = "https://github.com/NVIDIA/NemoClaw/issues/12042";

    // Independent source catalogs keep the coverage assertion from merely
    // comparing the scenario table with itself. Public flags come from
    // src/lib/onboard/command-support.ts at V0_SOURCE_REVISION. Environment
    // controls are the user-facing selectors read by onboarding and named in
    // the pinned quickstart/command documentation; internal test, build, and
    // timing knobs are deliberately outside this user-intent inventory.
    const V0_PUBLIC_FLAGS: &[&str] = &[
        "--agent",
        "--agents",
        "--apf-interceptor",
        "--control-ui-port",
        "--events=jsonl",
        "--fresh",
        "--from",
        "--gpu",
        "--host-mount",
        "--name",
        "--no-gpu",
        "--no-observability",
        "--no-ollama-autostart",
        "--no-sandbox-gpu",
        "--non-interactive",
        "--observability",
        "--profile",
        "--recreate-sandbox",
        "--resume",
        "--sandbox-gpu",
        "--sandbox-gpu-device",
        "--tool-disclosure",
        "--vllm-gpu-device",
        "--yes",
        "--yes-i-accept-third-party-software",
    ];
    const V0_USER_ENVIRONMENT: &[&str] = &[
        "ANTHROPIC_API_KEY",
        "BRAVE_API_KEY",
        "CHAT_UI_URL",
        "COMPATIBLE_ANTHROPIC_API_KEY",
        "COMPATIBLE_API_KEY",
        "DISCORD_BOT_TOKEN",
        "DISCORD_REQUIRE_MENTION",
        "DISCORD_SERVER_ID",
        "GEMINI_API_KEY",
        "HF_TOKEN",
        "HUGGING_FACE_HUB_TOKEN",
        "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
        "NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE",
        "NEMOCLAW_AGENT",
        "NEMOCLAW_AGENT_HEARTBEAT_EVERY",
        "NEMOCLAW_AGENT_TIMEOUT",
        "NEMOCLAW_AUTO_FIX_FIREWALL",
        "NEMOCLAW_COMPATIBLE_AUTH_MODE",
        "NEMOCLAW_CONTEXT_WINDOW",
        "NEMOCLAW_CPU",
        "NEMOCLAW_DEFER_ONBOARDING",
        "NEMOCLAW_DASHBOARD_PORT",
        "NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE",
        "NEMOCLAW_ENDPOINT_URL",
        "NEMOCLAW_EXTRA_PLACEHOLDER_KEYS",
        "NEMOCLAW_FROM_DOCKERFILE",
        "NEMOCLAW_GATEWAY_RUNTIME",
        "NEMOCLAW_GATEWAY_PORT",
        "NEMOCLAW_HERMES_API_PORT",
        "NEMOCLAW_HERMES_AUTH",
        "NEMOCLAW_HERMES_AUTH_METHOD",
        "NEMOCLAW_HERMES_DASHBOARD_TUI",
        "NEMOCLAW_HERMES_TOOL_GATEWAYS",
        "NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS",
        "NEMOCLAW_INFERENCE_BASE_URL",
        "NEMOCLAW_INFERENCE_INPUTS",
        "NEMOCLAW_LLAMACPP_RECIPE",
        "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
        "NEMOCLAW_LOCAL_INFERENCE_TIMEOUT",
        "NEMOCLAW_LOCAL_MODEL_RUNTIME",
        "NEMOCLAW_MANAGED_CLUSTER_PEERS",
        "NEMOCLAW_MAX_TOKENS",
        "NEMOCLAW_MODEL",
        "NEMOCLAW_MODEL_ROUTER_PYTHON",
        "NEMOCLAW_NON_INTERACTIVE",
        "NEMOCLAW_NOUS_AUTH_METHOD",
        "NEMOCLAW_NO_EXPRESS",
        "NEMOCLAW_OBSERVABILITY",
        "NEMOCLAW_OLLAMA_INSTALL_MODE",
        "NEMOCLAW_OLLAMA_PROXY_PORT",
        "NEMOCLAW_OLLAMA_REQUIRE_TOOLS",
        "NEMOCLAW_OPENCLAW_OTEL",
        "NEMOCLAW_OPENCLAW_OTEL_ENDPOINT",
        "NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE",
        "NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME",
        "NEMOCLAW_POLICY_TIER",
        "NEMOCLAW_POLICY_MODE",
        "NEMOCLAW_POLICY_PRESETS",
        "NEMOCLAW_PREFERRED_API",
        "NEMOCLAW_PROVIDER",
        "NEMOCLAW_PROVIDER_KEY",
        "NEMOCLAW_PROVIDER_MODEL",
        "NEMOCLAW_PROXY_HOST",
        "NEMOCLAW_PROXY_PORT",
        "NEMOCLAW_RAM",
        "NEMOCLAW_REASONING",
        "NEMOCLAW_REASONING_EFFORT",
        "NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE",
        "NEMOCLAW_RECREATE_SANDBOX",
        "NEMOCLAW_RECREATE_WITHOUT_BACKUP",
        "NEMOCLAW_RESOURCE_PROFILE",
        "NEMOCLAW_SANDBOX_BASE_IMAGE_REFRESH",
        "NEMOCLAW_SANDBOX_GPU",
        "NEMOCLAW_SANDBOX_GPU_DEVICE",
        "NEMOCLAW_SANDBOX",
        "NEMOCLAW_SANDBOX_NAME",
        "NEMOCLAW_SANDBOX_READY_TIMEOUT",
        "NEMOCLAW_SERVING_PRESET",
        "NEMOCLAW_SINGLE_SESSION",
        "NEMOCLAW_TOOL_DISCLOSURE",
        "NEMOCLAW_TRUSTED_PRIVATE_HOSTS",
        "NEMOCLAW_TRUSTED_PRIVATE_INFERENCE_HOSTS",
        "NEMOCLAW_VLLM_EXTRA_ARGS_JSON",
        "NEMOCLAW_VLLM_GPU_DEVICE",
        "NEMOCLAW_VLLM_MODEL",
        "NEMOCLAW_VLLM_PORT",
        "NEMOCLAW_WEB_SEARCH_PROVIDER",
        "NEMOCLAW_YES",
        "NVIDIA_INFERENCE_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "MSTEAMS_APP_ID",
        "MSTEAMS_APP_PASSWORD",
        "MSTEAMS_TENANT_ID",
        "SLACK_ALLOWED_CHANNELS",
        "SLACK_ALLOWED_USERS",
        "SLACK_APP_TOKEN",
        "SLACK_BOT_TOKEN",
        "TAVILY_API_KEY",
        "TELEGRAM_ALLOWED_IDS",
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_GROUP_POLICY",
        "TELEGRAM_REQUIRE_MENTION",
        "SANDBOX_NAME",
        "WECHAT_BOT_TOKEN",
    ];

    // Maintained workflows without a flag or environment spelling are also
    // cataloged independently from the scenario rows.
    const V0_WORKFLOW_FAMILIES: &[&str] = &[
        "agent-selection",
        "credentials",
        "external-component",
        "inference",
        "interfaces",
        "messaging",
        "model-router",
        "naming-defaults",
        "policy-selection",
        "profiles",
        "recovery",
        "runtime-resources",
        "web-search",
    ];

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    enum DispositionKind {
        Representable,
        ParseRejected,
        ProposedShapeRejected,
        ParsedDownstream,
        IntentionallyNotTargeted,
        ScopeDecision,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Boundary {
        Authoring,
        DocumentParse,
        CredentialFulfillment,
        PlanRuntimeQualification,
        ProductScope,
    }

    #[derive(Clone, Copy)]
    struct Gap {
        id: &'static str,
        boundary: Boundary,
        owner: &'static str,
        reason: &'static str,
    }

    #[derive(Clone, Copy)]
    enum AuthoringCase {
        OpenClawCompletions,
        OpenClawResponses,
        HermesCompletions,
    }

    #[derive(Clone, Copy)]
    enum Mutation {
        GeminiProvider,
        GpuIntent,
        HermesProviderTools,
        InferenceInputs,
        InvalidSandboxName,
        LlamaCppService,
        ModelRouter,
        SandboxResources,
        ServingProfileProvenance,
        HostMounts,
        MessagingChannels,
        TavilyWebSearch,
        TrustedPrivateHosts,
    }

    #[derive(Clone, Copy)]
    enum Evidence {
        Authoring(AuthoringCase),
        Fixture(FixtureCase),
        QualifiedFixture(FixtureCase, Qualification),
        Mutation(Mutation),
        None,
    }

    #[derive(Clone, Copy)]
    enum Qualification {
        DashboardLifecycle,
        GatewayEndpointLifecycle,
        HermesInterfacesLifecycle,
        PodmanRuntime,
        ProxyPolicyLifecycle,
        ToolsObservabilityLifecycle,
        WebSearchLifecycle,
    }

    #[derive(Clone, Copy)]
    enum FixtureCase {
        Anthropic,
        AnthropicCompatible,
        Compatible,
        Dashboard,
        DeepAgents,
        FullFeatured,
        ManagedOllama,
        ManagedVllm,
        OllamaProxy,
        OpenAi,
        OpenRouter,
        Pi,
        Podman,
        WebSearch,
        HermesInterfaces,
    }

    struct Scenario {
        id: &'static str,
        catalog_family: &'static str,
        family: &'static str,
        v0_source: &'static str,
        v0_inputs: &'static [&'static str],
        v0_behavior: &'static str,
        disposition: DispositionKind,
        gap: Option<Gap>,
        evidence: Evidence,
    }

    fn gap(
        id: &'static str,
        boundary: Boundary,
        owner: &'static str,
        reason: &'static str,
    ) -> Option<Gap> {
        Some(Gap {
            id,
            boundary,
            owner,
            reason,
        })
    }

    fn maintained_v0_inventory() -> Vec<Scenario> {
        vec![
            Scenario {
                id: "V0-CORE-OPENCLAW",
                catalog_family: "inference",
                family: "OpenClaw NVIDIA inference defaults",
                v0_source: "src/lib/onboard/command-support.ts; docs/get-started/quickstart.mdx",
                v0_inputs: &[],
                v0_behavior: "OpenClaw defaults to hosted NVIDIA inference with an OpenAI-compatible completions route",
                disposition: DispositionKind::Representable,
                gap: None,
                evidence: Evidence::Authoring(AuthoringCase::OpenClawCompletions),
            },
            Scenario {
                id: "V0-NAMING-IDENTITY",
                catalog_family: "naming-defaults",
                family: "sandbox name and default identity",
                v0_source: "src/lib/onboard/command-support.ts --name; src/lib/onboard/context.ts",
                v0_inputs: &[
                    "--name",
                    "NEMOCLAW_SANDBOX",
                    "NEMOCLAW_SANDBOX_NAME",
                    "SANDBOX_NAME",
                ],
                v0_behavior: "name the sandbox, defaulting to my-assistant, without introducing a separate deployment identity",
                disposition: DispositionKind::ScopeDecision,
                gap: gap(
                    "GAP-V0-NAMING-IDENTITY",
                    Boundary::ProductScope,
                    ISSUE_12032,
                    "V1 separates deployment and sandbox names and defaults the authored sandbox to assistant, so the V0 name cannot be projected without a product mapping decision",
                ),
                evidence: Evidence::None,
            },
            Scenario {
                id: "V0-NAMING-VALIDATION",
                catalog_family: "naming-defaults",
                family: "sandbox name validation",
                v0_source: "src/lib/onboard/context.ts sandbox-name validation",
                v0_inputs: &[],
                v0_behavior: "reject a sandbox name outside the maintained DNS-label grammar",
                disposition: DispositionKind::ParseRejected,
                gap: gap(
                    "GAP-V0-NAMING-VALIDATION",
                    Boundary::DocumentParse,
                    ISSUE_12034,
                    "the V1 parser correctly rejects the same invalid sandbox-name class; an accepted identity mapping remains separately owned",
                ),
                evidence: Evidence::Mutation(Mutation::InvalidSandboxName),
            },
            Scenario {
                id: "V0-WORKFLOW-UNATTENDED",
                catalog_family: "recovery",
                family: "non-interactive confirmations and third-party notice",
                v0_source: "src/lib/onboard/command-support.ts; src/lib/onboard/usage-notice.ts",
                v0_inputs: &[
                    "--non-interactive",
                    "--yes",
                    "--yes-i-accept-third-party-software",
                    "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
                    "NEMOCLAW_NON_INTERACTIVE",
                    "NEMOCLAW_YES",
                ],
                v0_behavior: "run unattended only after explicit acceptance and auto-confirm only prompts declared safe",
                disposition: DispositionKind::ScopeDecision,
                gap: gap(
                    "GAP-V0-WORKFLOW-UNATTENDED",
                    Boundary::ProductScope,
                    ISSUE_12032,
                    "V1 authoring is non-mutating and the composed apply journey must define confirmation and notice ownership",
                ),
                evidence: Evidence::None,
            },
            Scenario {
                id: "V0-INFERENCE-RESPONSES",
                catalog_family: "inference",
                family: "OpenAI Responses API selection",
                v0_source: "docs/inference/learn-and-choose/choose-inference-provider.mdx",
                v0_inputs: &[],
                v0_behavior: "an OpenClaw route can select a Responses-compatible API and model",
                disposition: DispositionKind::Representable,
                gap: None,
                evidence: Evidence::Authoring(AuthoringCase::OpenClawResponses),
            },
            Scenario {
                id: "V0-AGENT-HERMES",
                catalog_family: "agent-selection",
                family: "Hermes agent selection",
                v0_source: "agents/hermes/manifest.yaml; src/lib/onboard/agent-selection.ts",
                v0_inputs: &["--agent", "NEMOCLAW_AGENT"],
                v0_behavior: "Hermes is selectable directly or through the interactive agent picker",
                disposition: DispositionKind::Representable,
                gap: None,
                evidence: Evidence::Authoring(AuthoringCase::HermesCompletions),
            },
            Scenario {
                id: "V0-AGENT-DEEPAGENTS",
                catalog_family: "agent-selection",
                family: "Deep Agents Code selection",
                v0_source: "agents/langchain-deepagents-code/manifest.yaml",
                v0_inputs: &[],
                v0_behavior: "select the Deep Agents Code terminal harness",
                disposition: DispositionKind::ParsedDownstream,
                gap: gap(
                    "GAP-V0-AGENT-DEEPAGENTS",
                    Boundary::Authoring,
                    ISSUE_12034,
                    "V1 parses Deep Agents intent but onboarding does not author this harness or V0 agent-manifest workflow",
                ),
                evidence: Evidence::Fixture(FixtureCase::DeepAgents),
            },
            Scenario {
                id: "V0-OPENCLAW-AGENT-MANIFEST",
                catalog_family: "agent-selection",
                family: "OpenClaw secondary-agent manifest",
                v0_source: "src/lib/onboard/command-support.ts --agents; src/lib/onboard/command.ts",
                v0_inputs: &["--agents"],
                v0_behavior: "resolve declared secondary agents, defaults, and per-agent overrides into explicit normalized OpenClaw agent intent",
                disposition: DispositionKind::ParsedDownstream,
                gap: gap(
                    "GAP-V0-OPENCLAW-AGENT-MANIFEST",
                    Boundary::Authoring,
                    ISSUE_12034,
                    "V1 parses multiple OpenClaw agents but onboarding does not author the V0 manifest workflow",
                ),
                evidence: Evidence::Fixture(FixtureCase::FullFeatured),
            },
            Scenario {
                id: "V0-AGENT-PI",
                catalog_family: "agent-selection",
                family: "Pi agent selection and native model metadata",
                v0_source: "agents/pi/manifest.yaml",
                v0_inputs: &[],
                v0_behavior: "select Pi with its native OpenAI-compatible model metadata",
                disposition: DispositionKind::ParsedDownstream,
                gap: gap(
                    "GAP-V0-AGENT-PI",
                    Boundary::Authoring,
                    ISSUE_12034,
                    "V1 parses Pi intent but onboarding does not author its native model shape",
                ),
                evidence: Evidence::Fixture(FixtureCase::Pi),
            },
            Scenario {
                id: "V0-INFERENCE-ANTHROPIC",
                catalog_family: "inference",
                family: "Anthropic hosted endpoint",
                v0_source: "docs/get-started/quickstart.mdx inference provider list",
                v0_inputs: &["NEMOCLAW_PROVIDER", "ANTHROPIC_API_KEY"],
                v0_behavior: "select Anthropic Messages with a matching Claude harness and credential",
                disposition: DispositionKind::ParsedDownstream,
                gap: gap(
                    "GAP-V0-INFERENCE-ANTHROPIC",
                    Boundary::PlanRuntimeQualification,
                    ISSUE_12038,
                    "the shape parses but standalone generated lifecycle qualification is pending",
                ),
                evidence: Evidence::Fixture(FixtureCase::Anthropic),
            },
            Scenario {
                id: "V0-INFERENCE-ANTHROPIC-COMPATIBLE",
                catalog_family: "inference",
                family: "Anthropic-compatible external endpoint",
                v0_source: "docs/get-started/quickstart.mdx inference provider list",
                v0_inputs: &["COMPATIBLE_ANTHROPIC_API_KEY"],
                v0_behavior: "select an Anthropic-compatible endpoint with Claude harness and an external credential reference",
                disposition: DispositionKind::ParsedDownstream,
                gap: gap(
                    "GAP-V0-INFERENCE-ANTHROPIC-COMPATIBLE",
                    Boundary::PlanRuntimeQualification,
                    ISSUE_12038,
                    "the credential-bearing compatible shape parses but generated lifecycle qualification is pending",
                ),
                evidence: Evidence::Fixture(FixtureCase::AnthropicCompatible),
            },
            Scenario {
                id: "V0-INFERENCE-COMPATIBLE",
                catalog_family: "inference",
                family: "generic OpenAI-compatible external endpoint",
                v0_source: "docs/get-started/quickstart.mdx inference provider list",
                v0_inputs: &[
                    "NEMOCLAW_ENDPOINT_URL",
                    "NEMOCLAW_INFERENCE_BASE_URL",
                    "NEMOCLAW_COMPATIBLE_AUTH_MODE",
                    "NEMOCLAW_CONTEXT_WINDOW",
                    "NEMOCLAW_PREFERRED_API",
                    "NEMOCLAW_PROVIDER_KEY",
                    "NEMOCLAW_PROVIDER_MODEL",
                    "NEMOCLAW_MODEL",
                    "NEMOCLAW_MAX_TOKENS",
                    "NEMOCLAW_REASONING",
                    "NEMOCLAW_REASONING_EFFORT",
                    "COMPATIBLE_API_KEY",
                ],
                v0_behavior: "select an external compatible endpoint, API family, model, and tuning",
                disposition: DispositionKind::ParsedDownstream,
                gap: gap(
                    "GAP-V0-INFERENCE-COMPATIBLE",
                    Boundary::PlanRuntimeQualification,
                    ISSUE_12038,
                    "the generic external-provider shape parses but generated lifecycle qualification is pending",
                ),
                evidence: Evidence::Fixture(FixtureCase::Compatible),
            },
            Scenario {
                id: "V0-INFERENCE-INPUT-MODALITIES",
                catalog_family: "inference",
                family: "OpenClaw inference input modalities",
                v0_source: "docs/reference/commands.mdx NEMOCLAW_INFERENCE_INPUTS",
                v0_inputs: &["NEMOCLAW_INFERENCE_INPUTS"],
                v0_behavior: "declare text and image input modalities for an OpenClaw model",
                disposition: DispositionKind::ProposedShapeRejected,
                gap: gap(
                    "GAP-V0-INFERENCE-INPUT-MODALITIES",
                    Boundary::DocumentParse,
                    ISSUE_12035,
                    "the illustrative OpenClaw input-modality override is not accepted by the V1 route schema",
                ),
                evidence: Evidence::Mutation(Mutation::InferenceInputs),
            },
            Scenario {
                id: "V0-INFERENCE-OPENAI",
                catalog_family: "inference",
                family: "OpenAI hosted endpoint",
                v0_source: "docs/get-started/quickstart.mdx inference provider list",
                v0_inputs: &["OPENAI_API_KEY"],
                v0_behavior: "select the OpenAI endpoint with an OpenAI credential reference",
                disposition: DispositionKind::ParsedDownstream,
                gap: gap(
                    "GAP-V0-INFERENCE-OPENAI",
                    Boundary::PlanRuntimeQualification,
                    ISSUE_12038,
                    "the credential-bearing OpenAI shape parses but generated lifecycle qualification is pending",
                ),
                evidence: Evidence::Fixture(FixtureCase::OpenAi),
            },
            Scenario {
                id: "V0-INFERENCE-OPENROUTER",
                catalog_family: "inference",
                family: "OpenRouter hosted endpoint",
                v0_source: "docs/get-started/quickstart.mdx inference provider list",
                v0_inputs: &["OPENROUTER_API_KEY"],
                v0_behavior: "select the OpenRouter endpoint with an OpenRouter credential reference",
                disposition: DispositionKind::ParsedDownstream,
                gap: gap(
                    "GAP-V0-INFERENCE-OPENROUTER",
                    Boundary::PlanRuntimeQualification,
                    ISSUE_12038,
                    "the credential-bearing OpenRouter shape parses but generated lifecycle qualification is pending",
                ),
                evidence: Evidence::Fixture(FixtureCase::OpenRouter),
            },
            Scenario {
                id: "V0-INFERENCE-OLLAMA",
                catalog_family: "inference",
                family: "local Ollama ownership and routing",
                v0_source: "docs/get-started/quickstart.mdx inference provider list",
                v0_inputs: &[
                    "--no-ollama-autostart",
                    "NEMOCLAW_LOCAL_INFERENCE_TIMEOUT",
                    "NEMOCLAW_OLLAMA_INSTALL_MODE",
                    "NEMOCLAW_OLLAMA_REQUIRE_TOOLS",
                ],
                v0_behavior: "select a managed Ollama service while retaining an explicit model route",
                disposition: DispositionKind::ParsedDownstream,
                gap: gap(
                    "GAP-V0-INFERENCE-OLLAMA",
                    Boundary::PlanRuntimeQualification,
                    ISSUE_12038,
                    "managed Ollama parses but generated standalone lifecycle qualification is pending",
                ),
                evidence: Evidence::Fixture(FixtureCase::ManagedOllama),
            },
            Scenario {
                id: "V0-INFERENCE-VLLM",
                catalog_family: "profiles",
                family: "managed vLLM profiles, GPU placement, and model recipes",
                v0_source: "src/lib/onboard/command-support.ts; docs/reference/commands.mdx --profile",
                v0_inputs: &[
                    "--profile",
                    "--vllm-gpu-device",
                    "HF_TOKEN",
                    "HUGGING_FACE_HUB_TOKEN",
                    "NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE",
                    "NEMOCLAW_LOCAL_MODEL_RUNTIME",
                    "NEMOCLAW_MANAGED_CLUSTER_PEERS",
                    "NEMOCLAW_SERVING_PRESET",
                    "NEMOCLAW_VLLM_EXTRA_ARGS_JSON",
                    "NEMOCLAW_VLLM_GPU_DEVICE",
                    "NEMOCLAW_VLLM_MODEL",
                    "NEMOCLAW_VLLM_PORT",
                ],
                v0_behavior: "resolve a fixed serving profile and place a managed GPU-backed inference service",
                disposition: DispositionKind::ParsedDownstream,
                gap: gap(
                    "GAP-V0-INFERENCE-VLLM",
                    Boundary::PlanRuntimeQualification,
                    ISSUE_12038,
                    "the service graph parses but generated profile selection and live qualification are pending",
                ),
                evidence: Evidence::Fixture(FixtureCase::ManagedVllm),
            },
            Scenario {
                id: "V0-INFERENCE-LLAMACPP",
                catalog_family: "profiles",
                family: "managed llama.cpp serving profiles",
                v0_source: "docs/reference/commands.mdx --profile; NEMOCLAW_LLAMACPP_RECIPE",
                v0_inputs: &["NEMOCLAW_LLAMACPP_RECIPE", "NEMOCLAW_LLAMACPP_LOCAL_TOKEN"],
                v0_behavior: "select a catalog-backed managed llama.cpp recipe without projecting it as vLLM",
                disposition: DispositionKind::ProposedShapeRejected,
                gap: gap(
                    "GAP-V0-INFERENCE-LLAMACPP",
                    Boundary::DocumentParse,
                    ISSUE_12035,
                    "the illustrative llama.cpp service backend is not accepted by the V1 provider schema",
                ),
                evidence: Evidence::Mutation(Mutation::LlamaCppService),
            },
            Scenario {
                id: "V0-INFERENCE-CREDENTIALS",
                catalog_family: "credentials",
                family: "credential environment discovery and fulfillment",
                v0_source: "src/lib/onboard/credential-env.ts; docs/get-started/quickstart.mdx",
                v0_inputs: &["NVIDIA_INFERENCE_API_KEY"],
                v0_behavior: "discover or prompt for credential values after selecting the provider while keeping values secret",
                disposition: DispositionKind::ParsedDownstream,
                gap: gap(
                    "GAP-V0-INFERENCE-CREDENTIALS",
                    Boundary::CredentialFulfillment,
                    ISSUE_12029,
                    "V1 authors credential references but standalone commands do not yet fulfill them",
                ),
                evidence: Evidence::Authoring(AuthoringCase::OpenClawCompletions),
            },
            Scenario {
                id: "V0-INFERENCE-GEMINI",
                catalog_family: "inference",
                family: "Google Gemini provider",
                v0_source: "docs/get-started/quickstart.mdx inference provider list",
                v0_inputs: &["GEMINI_API_KEY"],
                v0_behavior: "select the maintained Gemini provider family",
                disposition: DispositionKind::ProposedShapeRejected,
                gap: gap(
                    "GAP-V0-INFERENCE-GEMINI",
                    Boundary::DocumentParse,
                    ISSUE_12035,
                    "the illustrative Gemini provider shape is a proposal and is rejected by the V1 parser",
                ),
                evidence: Evidence::Mutation(Mutation::GeminiProvider),
            },
            Scenario {
                id: "V0-PROFILE-PROVENANCE",
                catalog_family: "profiles",
                family: "serving-profile catalog provenance and compatibility",
                v0_source: "docs/reference/commands.mdx --profile",
                v0_inputs: &[],
                v0_behavior: "retain catalog, preset, recipe, support, and download provenance across review and resume",
                disposition: DispositionKind::ProposedShapeRejected,
                gap: gap(
                    "GAP-V0-PROFILE-PROVENANCE",
                    Boundary::DocumentParse,
                    ISSUE_12035,
                    "the proposed servingProfile field is not accepted V1 schema",
                ),
                evidence: Evidence::Mutation(Mutation::ServingProfileProvenance),
            },
            Scenario {
                id: "V0-INFERENCE-MODEL-ROUTER",
                catalog_family: "model-router",
                family: "model-router profile",
                v0_source: "docs/get-started/quickstart.mdx model router; src/lib/onboard/model-router.ts",
                v0_inputs: &["NEMOCLAW_MODEL_ROUTER_PYTHON"],
                v0_behavior: "select the maintained model-router profile and preserve its routing configuration",
                disposition: DispositionKind::ProposedShapeRejected,
                gap: gap(
                    "GAP-V0-INFERENCE-MODEL-ROUTER",
                    Boundary::DocumentParse,
                    ISSUE_12035,
                    "the illustrative modelRouter declaration is not an accepted V1 schema shape",
                ),
                evidence: Evidence::Mutation(Mutation::ModelRouter),
            },
            Scenario {
                id: "V0-RUNTIME-PODMAN",
                catalog_family: "runtime-resources",
                family: "gateway and sandbox runtime provider",
                v0_source: "src/lib/onboard/command-support.ts; docs/get-started/quickstart.mdx runtime section",
                v0_inputs: &["NEMOCLAW_GATEWAY_RUNTIME"],
                v0_behavior: "select Docker or native Podman for managed gateway and sandbox execution",
                disposition: DispositionKind::Representable,
                gap: None,
                evidence: Evidence::QualifiedFixture(
                    FixtureCase::Podman,
                    Qualification::PodmanRuntime,
                ),
            },
            Scenario {
                id: "V0-RUNTIME-GPU-CONTROLS",
                catalog_family: "runtime-resources",
                family: "gateway and sandbox GPU controls",
                v0_source: "src/lib/onboard/command-support.ts GPU flags; docs/get-started/quickstart.mdx",
                v0_inputs: &[
                    "--gpu",
                    "--no-gpu",
                    "--sandbox-gpu",
                    "--no-sandbox-gpu",
                    "--sandbox-gpu-device",
                    "NEMOCLAW_SANDBOX_GPU",
                    "NEMOCLAW_SANDBOX_GPU_DEVICE",
                ],
                v0_behavior: "require or disable direct GPU passthrough and select a sandbox GPU device",
                disposition: DispositionKind::ProposedShapeRejected,
                gap: gap(
                    "GAP-V0-RUNTIME-GPU-CONTROLS",
                    Boundary::DocumentParse,
                    ISSUE_12036,
                    "the illustrative sandbox runtime GPU declaration is not accepted V1 schema; managed inference-service hardware is not equivalent",
                ),
                evidence: Evidence::Mutation(Mutation::GpuIntent),
            },
            Scenario {
                id: "V0-RUNTIME-RESOURCE-SIZING",
                catalog_family: "runtime-resources",
                family: "sandbox CPU and RAM resource profiles",
                v0_source: "docs/reference/commands.mdx onboarding resource configuration",
                v0_inputs: &["NEMOCLAW_RESOURCE_PROFILE", "NEMOCLAW_CPU", "NEMOCLAW_RAM"],
                v0_behavior: "select a resource profile and override sandbox CPU or memory sizing",
                disposition: DispositionKind::ProposedShapeRejected,
                gap: gap(
                    "GAP-V0-RUNTIME-RESOURCE-SIZING",
                    Boundary::DocumentParse,
                    ISSUE_12036,
                    "the illustrative sandbox resource declaration is not accepted V1 schema",
                ),
                evidence: Evidence::Mutation(Mutation::SandboxResources),
            },
            Scenario {
                id: "V0-INFERENCE-OLLAMA-PROXY-PORT",
                catalog_family: "interfaces",
                family: "authenticated Ollama proxy port",
                v0_source: "docs/reference/commands.mdx NEMOCLAW_OLLAMA_PROXY_PORT",
                v0_inputs: &["NEMOCLAW_OLLAMA_PROXY_PORT"],
                v0_behavior: "choose the host port of the authenticated Ollama proxy",
                disposition: DispositionKind::ParsedDownstream,
                gap: gap(
                    "GAP-V0-INFERENCE-OLLAMA-PROXY-PORT",
                    Boundary::PlanRuntimeQualification,
                    ISSUE_12038,
                    "V1 parses the selected port in ollamaProxy.endpoint but V0-to-V1 authoring and generated lifecycle qualification are pending",
                ),
                evidence: Evidence::Fixture(FixtureCase::OllamaProxy),
            },
            Scenario {
                id: "V0-RUNTIME-GATEWAY-PORT",
                catalog_family: "interfaces",
                family: "gateway endpoint port selection",
                v0_source: "src/lib/onboard/context.ts gateway port environment controls",
                v0_inputs: &["NEMOCLAW_GATEWAY_PORT"],
                v0_behavior: "choose the local gateway endpoint port",
                disposition: DispositionKind::Representable,
                gap: None,
                evidence: Evidence::QualifiedFixture(
                    FixtureCase::Podman,
                    Qualification::GatewayEndpointLifecycle,
                ),
            },
            Scenario {
                id: "V0-HOST-MOUNTS",
                catalog_family: "runtime-resources",
                family: "read-only host mounts",
                v0_source: "src/lib/onboard/command-support.ts --host-mount",
                v0_inputs: &["--host-mount"],
                v0_behavior: "mount an absolute host directory read-only below /sandbox",
                disposition: DispositionKind::ProposedShapeRejected,
                gap: gap(
                    "GAP-V0-HOST-MOUNTS",
                    Boundary::DocumentParse,
                    ISSUE_12036,
                    "the proposed runtime.hostMounts field is not accepted V1 schema",
                ),
                evidence: Evidence::Mutation(Mutation::HostMounts),
            },
            Scenario {
                id: "V0-TOOLS-OBSERVABILITY",
                catalog_family: "policy-selection",
                family: "multiple agents, tool disclosure, policy tiers, and observability",
                v0_source: "src/lib/onboard/command-support.ts; docs/reference/commands.mdx tool disclosure and observability",
                v0_inputs: &[
                    "--observability",
                    "--no-observability",
                    "--tool-disclosure",
                    "NEMOCLAW_AGENT_HEARTBEAT_EVERY",
                    "NEMOCLAW_AGENT_TIMEOUT",
                    "NEMOCLAW_OBSERVABILITY",
                    "NEMOCLAW_OPENCLAW_OTEL",
                    "NEMOCLAW_OPENCLAW_OTEL_ENDPOINT",
                    "NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE",
                    "NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME",
                    "NEMOCLAW_POLICY_TIER",
                    "NEMOCLAW_POLICY_MODE",
                    "NEMOCLAW_POLICY_PRESETS",
                    "NEMOCLAW_TOOL_DISCLOSURE",
                ],
                v0_behavior: "preserve multi-agent model choices, explicit policy, tool presentation, and trace export",
                disposition: DispositionKind::Representable,
                gap: None,
                evidence: Evidence::QualifiedFixture(
                    FixtureCase::FullFeatured,
                    Qualification::ToolsObservabilityLifecycle,
                ),
            },
            Scenario {
                id: "V0-HERMES-PROVIDER-TOOLS",
                catalog_family: "agent-selection",
                family: "Hermes provider authentication, managed tools, and credential placeholders",
                v0_source: "docs/reference/commands.mdx Hermes onboarding configuration",
                v0_inputs: &[
                    "NEMOCLAW_HERMES_AUTH",
                    "NEMOCLAW_HERMES_AUTH_METHOD",
                    "NEMOCLAW_HERMES_TOOL_GATEWAYS",
                    "NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS",
                    "NEMOCLAW_NOUS_AUTH_METHOD",
                    "NEMOCLAW_EXTRA_PLACEHOLDER_KEYS",
                ],
                v0_behavior: "select Hermes provider authentication and managed tool gateways while retaining out-of-process credential placeholders",
                disposition: DispositionKind::ProposedShapeRejected,
                gap: gap(
                    "GAP-V0-HERMES-PROVIDER-TOOLS",
                    Boundary::DocumentParse,
                    ISSUE_12042,
                    "the illustrative Hermes authentication, tool-gateway, and placeholder intent is not accepted V1 schema",
                ),
                evidence: Evidence::Mutation(Mutation::HermesProviderTools),
            },
            Scenario {
                id: "V0-INTERFACES-DASHBOARD",
                catalog_family: "interfaces",
                family: "dashboard and control interfaces",
                v0_source: "src/lib/onboard/command-support.ts --control-ui-port",
                v0_inputs: &[
                    "--control-ui-port",
                    "CHAT_UI_URL",
                    "NEMOCLAW_DASHBOARD_PORT",
                ],
                v0_behavior: "publish the agent dashboard or control UI on an explicit host port",
                disposition: DispositionKind::Representable,
                gap: None,
                evidence: Evidence::QualifiedFixture(
                    FixtureCase::Dashboard,
                    Qualification::DashboardLifecycle,
                ),
            },
            Scenario {
                id: "V0-INTERFACES-HERMES-API",
                catalog_family: "interfaces",
                family: "Hermes API port",
                v0_source: "docs/reference/commands.mdx Hermes interface ports",
                v0_inputs: &["NEMOCLAW_HERMES_API_PORT", "NEMOCLAW_HERMES_DASHBOARD_TUI"],
                v0_behavior: "publish the Hermes OpenAI-compatible API on an explicit reserved port",
                disposition: DispositionKind::Representable,
                gap: None,
                evidence: Evidence::QualifiedFixture(
                    FixtureCase::HermesInterfaces,
                    Qualification::HermesInterfacesLifecycle,
                ),
            },
            Scenario {
                id: "V0-NETWORK-PROXY-TRUST",
                catalog_family: "runtime-resources",
                family: "outbound proxy and trusted private destinations",
                v0_source: "docs/reference/commands.mdx onboarding configuration",
                v0_inputs: &["NEMOCLAW_PROXY_HOST", "NEMOCLAW_PROXY_PORT"],
                v0_behavior: "preserve an explicit sandbox proxy while requiring policy review for private destinations",
                disposition: DispositionKind::Representable,
                gap: None,
                evidence: Evidence::QualifiedFixture(
                    FixtureCase::FullFeatured,
                    Qualification::ProxyPolicyLifecycle,
                ),
            },
            Scenario {
                id: "V0-NETWORK-TRUSTED-PRIVATE-HOSTS",
                catalog_family: "runtime-resources",
                family: "trusted private destination allowlist",
                v0_source: "docs/reference/commands.mdx onboarding configuration",
                v0_inputs: &[
                    "NEMOCLAW_TRUSTED_PRIVATE_HOSTS",
                    "NEMOCLAW_TRUSTED_PRIVATE_INFERENCE_HOSTS",
                ],
                v0_behavior: "allow exact operator-owned private inference destinations while retaining DNS and address pinning",
                disposition: DispositionKind::ProposedShapeRejected,
                gap: gap(
                    "GAP-V0-NETWORK-TRUSTED-PRIVATE-HOSTS",
                    Boundary::DocumentParse,
                    ISSUE_12036,
                    "the illustrative trusted-private-host allowlist is not accepted V1 network schema and cannot be reduced to an ordinary public endpoint rule",
                ),
                evidence: Evidence::Mutation(Mutation::TrustedPrivateHosts),
            },
            Scenario {
                id: "V0-INTEGRATION-WEB-SEARCH",
                catalog_family: "web-search",
                family: "web search integrations",
                v0_source: "docs/get-started/quickstart.mdx optional integrations",
                v0_inputs: &["NEMOCLAW_WEB_SEARCH_PROVIDER", "BRAVE_API_KEY"],
                v0_behavior: "attach a credentialed web-search provider to selected agents",
                disposition: DispositionKind::Representable,
                gap: None,
                evidence: Evidence::QualifiedFixture(
                    FixtureCase::WebSearch,
                    Qualification::WebSearchLifecycle,
                ),
            },
            Scenario {
                id: "V0-INTEGRATION-TAVILY",
                catalog_family: "web-search",
                family: "Tavily web search integration",
                v0_source: "docs/reference/commands.mdx OpenClaw and Hermes web search",
                v0_inputs: &["TAVILY_API_KEY"],
                v0_behavior: "attach Tavily search with an out-of-process credential reference",
                disposition: DispositionKind::ProposedShapeRejected,
                gap: gap(
                    "GAP-V0-INTEGRATION-TAVILY",
                    Boundary::DocumentParse,
                    ISSUE_12040,
                    "the illustrative Tavily integration is rejected because the accepted V1 provider enum contains only Brave",
                ),
                evidence: Evidence::Mutation(Mutation::TavilyWebSearch),
            },
            Scenario {
                id: "V0-INTEGRATION-MESSAGING",
                catalog_family: "messaging",
                family: "messaging-channel enrollment",
                v0_source: "docs/get-started/quickstart.mdx optional integrations; docs/manage-sandboxes/messaging-channels",
                v0_inputs: &[
                    "DISCORD_BOT_TOKEN",
                    "DISCORD_REQUIRE_MENTION",
                    "DISCORD_SERVER_ID",
                    "MSTEAMS_APP_ID",
                    "MSTEAMS_APP_PASSWORD",
                    "MSTEAMS_TENANT_ID",
                    "SLACK_ALLOWED_CHANNELS",
                    "SLACK_ALLOWED_USERS",
                    "SLACK_APP_TOKEN",
                    "SLACK_BOT_TOKEN",
                    "TELEGRAM_ALLOWED_IDS",
                    "TELEGRAM_BOT_TOKEN",
                    "TELEGRAM_GROUP_POLICY",
                    "TELEGRAM_REQUIRE_MENTION",
                    "WECHAT_BOT_TOKEN",
                ],
                v0_behavior: "enroll Slack, Telegram, Discord, WhatsApp, or another maintained channel",
                disposition: DispositionKind::ProposedShapeRejected,
                gap: gap(
                    "GAP-V0-INTEGRATION-MESSAGING",
                    Boundary::DocumentParse,
                    ISSUE_12037,
                    "the proposed sandbox.channels field is not accepted V1 schema",
                ),
                evidence: Evidence::Mutation(Mutation::MessagingChannels),
            },
            Scenario {
                id: "V0-WORKFLOW-RECOVERY",
                catalog_family: "recovery",
                family: "resume, fresh start, replacement, and image refresh",
                v0_source: "src/lib/onboard/command-support.ts; docs/reference/commands.mdx resume and fresh",
                v0_inputs: &[
                    "--fresh",
                    "--recreate-sandbox",
                    "--resume",
                    "NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE",
                    "NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE",
                    "NEMOCLAW_RECREATE_SANDBOX",
                    "NEMOCLAW_RECREATE_WITHOUT_BACKUP",
                    "NEMOCLAW_SANDBOX_BASE_IMAGE_REFRESH",
                    "NEMOCLAW_SANDBOX_READY_TIMEOUT",
                    "NEMOCLAW_SINGLE_SESSION",
                ],
                v0_behavior: "resume checkpoints or explicitly replace an existing sandbox without silently changing selections",
                disposition: DispositionKind::ScopeDecision,
                gap: gap(
                    "GAP-V0-WORKFLOW-RECOVERY",
                    Boundary::ProductScope,
                    ISSUE_12032,
                    "the complete V1 onboarding journey must decide how desired-state apply recovery surfaces in onboarding",
                ),
                evidence: Evidence::None,
            },
            Scenario {
                id: "V0-WORKFLOW-DEFER-ONBOARDING",
                catalog_family: "recovery",
                family: "deferred Hermes onboarding",
                v0_source: "docs/reference/commands.mdx --defer-onboarding",
                v0_inputs: &["NEMOCLAW_DEFER_ONBOARDING"],
                v0_behavior: "install Hermes without starting onboarding when its guarded credential and state preconditions hold",
                disposition: DispositionKind::ScopeDecision,
                gap: gap(
                    "GAP-V0-WORKFLOW-DEFER-ONBOARDING",
                    Boundary::ProductScope,
                    ISSUE_12032,
                    "the composed V1 installation and onboarding journey must decide whether deferred authoring is a supported workflow",
                ),
                evidence: Evidence::None,
            },
            Scenario {
                id: "V0-WORKFLOW-EXPRESS-OPT-OUT",
                catalog_family: "profiles",
                family: "Express and Deferred profile opt-out",
                v0_source: "docs/reference/commands.mdx NEMOCLAW_NO_EXPRESS",
                v0_inputs: &["NEMOCLAW_NO_EXPRESS"],
                v0_behavior: "opt out of installer-selected Express or Deferred hardware profiles",
                disposition: DispositionKind::ScopeDecision,
                gap: gap(
                    "GAP-V0-WORKFLOW-EXPRESS-OPT-OUT",
                    Boundary::ProductScope,
                    ISSUE_12032,
                    "V1 onboarding must decide whether installer admission profiles belong in desired-state authoring",
                ),
                evidence: Evidence::None,
            },
            Scenario {
                id: "V0-DEFAULTS-POLICY-TOOLS-OBSERVABILITY",
                catalog_family: "policy-selection",
                family: "policy, tool, and observability defaults",
                v0_source: "docs/reference/commands.mdx onboarding defaults",
                v0_inputs: &[],
                v0_behavior: "default to balanced policy tier, suggested policy mode, progressive tool disclosure, and observability disabled",
                disposition: DispositionKind::ScopeDecision,
                gap: gap(
                    "GAP-V0-DEFAULTS-POLICY-TOOLS-OBSERVABILITY",
                    Boundary::ProductScope,
                    ISSUE_12032,
                    "V1 explicit policy and authoring defaults do not currently define a lossless mapping for the V0 balanced and suggested defaults",
                ),
                evidence: Evidence::None,
            },
            Scenario {
                id: "V0-WORKFLOW-FIREWALL-REPAIR",
                catalog_family: "runtime-resources",
                family: "host firewall repair during admission",
                v0_source: "docs/reference/commands.mdx host preflight and firewall recovery",
                v0_inputs: &["NEMOCLAW_AUTO_FIX_FIREWALL"],
                v0_behavior: "explicitly allow onboarding to repair supported host firewall rules during preflight",
                disposition: DispositionKind::IntentionallyNotTargeted,
                gap: gap(
                    "GAP-V0-WORKFLOW-FIREWALL-REPAIR",
                    Boundary::ProductScope,
                    ISSUE_12022,
                    "V1 desired-state authoring is host-read-only and does not own mutation of host firewall policy",
                ),
                evidence: Evidence::None,
            },
            Scenario {
                id: "V0-WORKFLOW-EVENTS",
                catalog_family: "recovery",
                family: "JSONL onboarding event observation",
                v0_source: "src/lib/onboard/command-support.ts --events=jsonl",
                v0_inputs: &["--events=jsonl"],
                v0_behavior: "observe versioned redacted progress events without controlling the onboarding state machine",
                disposition: DispositionKind::ScopeDecision,
                gap: gap(
                    "GAP-V0-WORKFLOW-EVENTS",
                    Boundary::ProductScope,
                    ISSUE_12032,
                    "the composed V1 journey has not accepted an onboarding event protocol",
                ),
                evidence: Evidence::None,
            },
            Scenario {
                id: "V0-WORKFLOW-EXTERNAL-COMPONENT",
                catalog_family: "external-component",
                family: "external component onboarding commands",
                v0_source: "docs/get-started/quickstart.mdx external component onboarding",
                v0_inputs: &[],
                v0_behavior: "onboard, inspect, and revoke an external component against the gateway",
                disposition: DispositionKind::IntentionallyNotTargeted,
                gap: gap(
                    "GAP-V0-WORKFLOW-EXTERNAL-COMPONENT",
                    Boundary::ProductScope,
                    ISSUE_12022,
                    "external component enrollment is an imperative gateway workflow rather than deployment authoring intent",
                ),
                evidence: Evidence::None,
            },
            Scenario {
                id: "V0-CUSTOM-IMAGE",
                catalog_family: "runtime-resources",
                family: "custom Dockerfile build context",
                v0_source: "src/lib/onboard/command-support.ts --from",
                v0_inputs: &["--from", "NEMOCLAW_FROM_DOCKERFILE"],
                v0_behavior: "build an explicit caller Dockerfile as the sandbox image source",
                disposition: DispositionKind::IntentionallyNotTargeted,
                gap: gap(
                    "GAP-V0-CUSTOM-IMAGE",
                    Boundary::ProductScope,
                    ISSUE_12022,
                    "V1 authors desired state and consumes qualified immutable images; onboarding does not own arbitrary image builds",
                ),
                evidence: Evidence::None,
            },
            Scenario {
                id: "V0-APF-INTERCEPTOR",
                catalog_family: "policy-selection",
                family: "providerless APF interceptor policy injection",
                v0_source: "src/lib/onboard/command-support.ts --apf-interceptor",
                v0_inputs: &["--apf-interceptor"],
                v0_behavior: "create without caller policy and verify a separately injected sandbox policy",
                disposition: DispositionKind::IntentionallyNotTargeted,
                gap: gap(
                    "GAP-V0-APF-INTERCEPTOR",
                    Boundary::ProductScope,
                    ISSUE_12022,
                    "V1 desired state requires declared policy intent and does not claim external policy provenance",
                ),
                evidence: Evidence::None,
            },
            Scenario {
                id: "V0-AGENT-NEMOCUA",
                catalog_family: "agent-selection",
                family: "candidate Computer Use agent",
                v0_source: "agents/nemocua/manifest.yaml; src/lib/agent/defs.ts candidate gate",
                v0_inputs: &[],
                v0_behavior: "select the environment-gated candidate Computer Use runtime",
                disposition: DispositionKind::ScopeDecision,
                gap: gap(
                    "GAP-V0-AGENT-NEMOCUA",
                    Boundary::ProductScope,
                    ISSUE_12022,
                    "candidate Computer Use support requires a separate accepted V1 scope decision",
                ),
                evidence: Evidence::None,
            },
        ]
    }

    fn authored(case: AuthoringCase) -> crate::authoring::AuthoredDocument {
        let inputs = match case {
            AuthoringCase::OpenClawCompletions => DirectInputs::default(),
            AuthoringCase::OpenClawResponses => DirectInputs {
                deployment_name: Some("openclaw-responses".into()),
                api: Some(ApiChoice::OpenAiResponses),
                credential_env: Some("NVIDIA_RESPONSES_API_KEY".into()),
                ..DirectInputs::default()
            },
            AuthoringCase::HermesCompletions => DirectInputs {
                deployment_name: Some("hermes-nvidia-hosted".into()),
                harness: Some(HarnessChoice::Hermes),
                ..DirectInputs::default()
            },
        };
        Session::with_uid(UID)
            .unwrap()
            .project(
                &Capabilities::available(),
                &Answers::from_direct(Answers::first_slice(), inputs),
            )
            .unwrap()
    }

    fn mutated_yaml(mutation: Mutation) -> String {
        let source = match mutation {
            Mutation::LlamaCppService => fixture(FixtureCase::ManagedVllm).to_vec(),
            Mutation::TavilyWebSearch => fixture(FixtureCase::WebSearch).to_vec(),
            _ => authored(AuthoringCase::OpenClawCompletions)
                .yaml()
                .as_bytes()
                .to_vec(),
        };
        let mut value: Value = serde_saphyr::from_slice(&source).unwrap();
        match mutation {
            Mutation::GeminiProvider => {
                value["spec"]["inferenceProviders"][0]["provider"] = json!("google");
                value["spec"]["inferenceProviders"][0]["api"] = json!("gemini-generate");
            }
            Mutation::GpuIntent => {
                value["spec"]["sandboxes"][0]["runtime"]["gpu"] =
                    json!({"required": true, "device": "nvidia.com/gpu=0"});
            }
            Mutation::HermesProviderTools => {
                value["spec"]["sandboxes"][0]["harness"]["providerAuthentication"] =
                    json!({"method": "oauth"});
                value["spec"]["sandboxes"][0]["harness"]["toolGateways"] = json!(["nous-web"]);
                value["spec"]["sandboxes"][0]["credentialPlaceholderExtensions"] =
                    json!(["TELEGRAM_BOT_TOKEN_AGENT_A"]);
            }
            Mutation::InferenceInputs => {
                value["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0]["overrides"]
                    ["input"] = json!(["text", "image"]);
            }
            Mutation::InvalidSandboxName => {
                value["spec"]["sandboxes"][0]["name"] = json!("Not A DNS Label");
            }
            Mutation::LlamaCppService => {
                value["spec"]["inferenceProviders"][0]["service"]["backend"] = json!("llamacpp");
            }
            Mutation::ModelRouter => {
                value["spec"]["modelRouter"] =
                    json!({"profile": "balanced", "routes": ["hosted", "local"]});
            }
            Mutation::SandboxResources => {
                value["spec"]["sandboxes"][0]["resources"] = json!({"cpu": "4", "memory": "16Gi"});
            }
            Mutation::ServingProfileProvenance => {
                value["spec"]["servingProfile"] =
                    json!({"id": "vllm.dgx-spark.example", "catalogDigest": "sha256:proposal"})
            }
            Mutation::HostMounts => {
                value["spec"]["sandboxes"][0]["runtime"]["hostMounts"] = json!([{"source": "/home/user/project", "target": "/sandbox/project", "readOnly": true}])
            }
            Mutation::MessagingChannels => {
                value["spec"]["sandboxes"][0]["channels"] =
                    json!([{"kind": "slack", "credential": {"env": "SLACK_BOT_TOKEN"}}])
            }
            Mutation::TavilyWebSearch => {
                value["spec"]["integrations"]["search"]["provider"] = json!("tavily");
                value["spec"]["integrations"]["search"]["credential"]["env"] =
                    json!("TAVILY_API_KEY");
            }
            Mutation::TrustedPrivateHosts => {
                value["spec"]["sandboxes"][0]["network"]["trustedPrivateHosts"] =
                    json!(["10.10.0.12", "inference.corp.example"]);
            }
        }
        serde_saphyr::to_string(&value).unwrap()
    }

    fn fixture(case: FixtureCase) -> Vec<u8> {
        let (source, credential): (&[u8], Option<&str>) = match case {
            FixtureCase::Anthropic => (
                include_bytes!("../../../examples/fabric-claude.yaml"),
                Some("ANTHROPIC_API_KEY"),
            ),
            FixtureCase::AnthropicCompatible => (
                include_bytes!("../../../examples/fabric-claude.yaml"),
                Some("COMPATIBLE_ANTHROPIC_API_KEY"),
            ),
            FixtureCase::Compatible => (
                include_bytes!("../../../examples/inference-tuning.yaml"),
                Some("COMPATIBLE_API_KEY"),
            ),
            FixtureCase::OpenAi => (
                include_bytes!("../../../examples/inference-tuning.yaml"),
                Some("OPENAI_API_KEY"),
            ),
            FixtureCase::OpenRouter => (
                include_bytes!("../../../examples/inference-tuning.yaml"),
                Some("OPENROUTER_API_KEY"),
            ),
            FixtureCase::Dashboard => (
                include_bytes!("../../../examples/openclaw-dashboard.yaml"),
                None,
            ),
            FixtureCase::DeepAgents => (include_bytes!("../../../examples/fabric.yaml"), None),
            FixtureCase::FullFeatured => (
                include_bytes!("../../../examples/full-featured-openclaw.yaml"),
                None,
            ),
            FixtureCase::ManagedOllama => (
                include_bytes!("../../../examples/managed-ollama.yaml"),
                None,
            ),
            FixtureCase::ManagedVllm => (
                include_bytes!("../../../examples/nemotron-amd64.yaml"),
                None,
            ),
            FixtureCase::OllamaProxy => (
                include_bytes!("../../../examples/managed-ollama.yaml"),
                None,
            ),
            FixtureCase::Pi => (include_bytes!("../../../examples/fabric-pi.yaml"), None),
            FixtureCase::Podman => (
                include_bytes!("../../../examples/managed-podman.yaml"),
                None,
            ),
            FixtureCase::WebSearch => (
                include_bytes!("../../../examples/openclaw-web-search.yaml"),
                None,
            ),
            FixtureCase::HermesInterfaces => (
                include_bytes!("../../../examples/hermes-interfaces.yaml"),
                None,
            ),
        };
        if matches!(case, FixtureCase::OllamaProxy) {
            let mut value: Value = serde_saphyr::from_slice(source).unwrap();
            let provider = &mut value["spec"]["inferenceProviders"][0];
            provider.as_object_mut().unwrap().remove("ollama");
            provider["management"] = json!("external");
            provider["endpoint"] = json!("http://127.0.0.1:11434/v1");
            provider["ollamaProxy"] = json!({
                "engine": "unix:///var/run/docker.sock",
                "image": format!("nc-ollama-proxy@sha256:{}", "a".repeat(64)),
                "endpoint": "http://172.20.0.1:11435/v1",
                "model": {"digest": "a".repeat(64)}
            });
            return serde_saphyr::to_string(&value).unwrap().into_bytes();
        }
        if matches!(case, FixtureCase::Podman) {
            let mut value: Value = serde_saphyr::from_slice(source).unwrap();
            value["spec"]["gateway"]["endpoint"] = json!("http://127.0.0.1:17891");
            return serde_saphyr::to_string(&value).unwrap().into_bytes();
        }
        let Some(credential) = credential else {
            return source.to_vec();
        };
        let mut value: Value = serde_saphyr::from_slice(source).unwrap();
        value["spec"]["inferenceProviders"][0]["credential"] = json!({"env": credential});
        if matches!(case, FixtureCase::Anthropic) {
            value["spec"]["inferenceProviders"][0]["endpoint"] =
                json!("https://api.anthropic.com/v1");
        }
        if matches!(case, FixtureCase::AnthropicCompatible) {
            value["spec"]["inferenceProviders"][0]["endpoint"] =
                json!("https://anthropic.example.com/v1");
        }
        if matches!(case, FixtureCase::OpenAi) {
            value["spec"]["inferenceProviders"][0]["endpoint"] = json!("https://api.openai.com/v1");
        }
        if matches!(case, FixtureCase::OpenRouter) {
            value["spec"]["inferenceProviders"][0]["endpoint"] =
                json!("https://openrouter.ai/api/v1");
        }
        serde_saphyr::to_string(&value).unwrap().into_bytes()
    }

    fn normalized(document: &Document) -> Value {
        serde_json::to_value(document).unwrap()
    }

    fn assert_authoring(case: AuthoringCase, document: &Document) {
        let value = normalized(document);
        let harness = &value["spec"]["sandboxes"][0]["harness"]["kind"];
        let provider = &value["spec"]["inferenceProviders"][0];
        let api = &provider["api"];
        assert_eq!(provider["provider"], "openai");
        assert_eq!(provider["endpoint"], "https://integrate.api.nvidia.com/v1");
        assert_eq!(
            value["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0]["overrides"]["model"],
            "nvidia/nemotron-3-super-120b-a12b"
        );
        assert_eq!(
            value["spec"]["sandboxes"][0]["runtime"]["provider"],
            "docker"
        );
        let credential = provider["credential"].as_object().unwrap();
        assert_eq!(
            credential.len(),
            1,
            "credential intent must contain only an env reference"
        );
        match case {
            AuthoringCase::OpenClawCompletions => {
                assert_eq!(harness, "openclaw");
                assert_eq!(api, "openai-completions");
                assert_eq!(credential["env"], "NVIDIA_INFERENCE_API_KEY");
            }
            AuthoringCase::OpenClawResponses => {
                assert_eq!(harness, "openclaw");
                assert_eq!(api, "openai-responses");
                assert_eq!(
                    value["spec"]["inferenceProviders"][0]["credential"]["env"],
                    "NVIDIA_RESPONSES_API_KEY"
                );
            }
            AuthoringCase::HermesCompletions => {
                assert_eq!(harness, "hermes");
                assert_eq!(api, "openai-completions");
                assert_eq!(credential["env"], "NVIDIA_INFERENCE_API_KEY");
            }
        }
    }

    fn assert_fixture(case: FixtureCase, document: &Document) {
        let value = normalized(document);
        match case {
            FixtureCase::Anthropic | FixtureCase::AnthropicCompatible => {
                assert_eq!(
                    value["spec"]["inferenceProviders"][0]["provider"],
                    "anthropic"
                );
                assert_eq!(value["spec"]["sandboxes"][0]["harness"]["kind"], "claude");
                let (endpoint, expected) = match case {
                    FixtureCase::Anthropic => ("https://api.anthropic.com/v1", "ANTHROPIC_API_KEY"),
                    FixtureCase::AnthropicCompatible => (
                        "https://anthropic.example.com/v1",
                        "COMPATIBLE_ANTHROPIC_API_KEY",
                    ),
                    _ => unreachable!(),
                };
                assert_eq!(value["spec"]["inferenceProviders"][0]["endpoint"], endpoint);
                assert_eq!(
                    value["spec"]["inferenceProviders"][0]["credential"]["env"],
                    expected
                );
            }
            FixtureCase::Compatible | FixtureCase::OpenAi | FixtureCase::OpenRouter => {
                assert_eq!(
                    value["spec"]["inferenceProviders"][0]["api"],
                    "openai-responses"
                );
                let (endpoint, credential) = match case {
                    FixtureCase::Compatible => {
                        ("https://inference.example.com/v1", "COMPATIBLE_API_KEY")
                    }
                    FixtureCase::OpenAi => ("https://api.openai.com/v1", "OPENAI_API_KEY"),
                    FixtureCase::OpenRouter => {
                        ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY")
                    }
                    _ => unreachable!(),
                };
                assert_eq!(value["spec"]["inferenceProviders"][0]["endpoint"], endpoint);
                assert_eq!(
                    value["spec"]["inferenceProviders"][0]["credential"]["env"],
                    credential
                );
                assert_eq!(
                    value["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0]["overrides"]
                        ["reasoningEffort"],
                    "high"
                );
                assert_eq!(
                    value["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0]["overrides"]
                        ["contextWindow"],
                    65536
                );
                assert_eq!(
                    value["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0]["overrides"]
                        ["maxTokens"],
                    8192
                );
                assert_eq!(
                    value["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0]["overrides"]
                        ["reasoning"],
                    true
                );
            }
            FixtureCase::Dashboard => {
                assert_eq!(
                    value["spec"]["sandboxes"][0]["harness"]["interfaces"]["dashboard"]["port"],
                    18800
                );
            }
            FixtureCase::DeepAgents => {
                assert_eq!(
                    value["spec"]["sandboxes"][0]["harness"]["kind"],
                    "deepagents"
                );
            }
            FixtureCase::FullFeatured => {
                let agents = value["spec"]["sandboxes"][0]["agents"].as_array().unwrap();
                assert_eq!(agents.len(), 3);
                assert_eq!(agents[0]["name"], "researcher");
                assert_eq!(agents[1]["name"], "writer");
                assert_eq!(agents[2]["name"], "reader");
                assert_eq!(agents[2]["tools"]["allow"], json!(["read"]));
                assert!(agents.iter().all(
                    |agent| agent["inference"]["routes"][0]["overrides"]["model"]
                        == "nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4"
                ));
                assert_eq!(
                    value["spec"]["sandboxes"][0]["network"]["policy"]["explicit"]["version"],
                    1
                );
                assert_eq!(
                    value["spec"]["sandboxes"][0]["network"]["policy"]["explicit"]["network_policies"]
                        ["documentation"]["endpoints"][0]["host"],
                    "docs.example.com"
                );
                assert_eq!(
                    value["spec"]["sandboxes"][0]["network"]["policy"]["explicit"]["filesystem_policy"]
                        ["include_workdir"],
                    false
                );
                assert_eq!(
                    value["spec"]["harnesses"]["assistant"]["observability"]["otlp"]["enabled"],
                    true
                );
                assert_eq!(
                    value["spec"]["harnesses"]["assistant"]["observability"]["otlp"]["endpoint"],
                    "http://host.openshell.internal:4318"
                );
                assert_eq!(
                    value["spec"]["harnesses"]["assistant"]["observability"]["otlp"]["serviceName"],
                    "research-team"
                );
                assert_eq!(
                    value["spec"]["harnesses"]["assistant"]["observability"]["otlp"]["sampleRate"],
                    0.5
                );
                assert_eq!(
                    value["spec"]["harnesses"]["assistant"]["execution"]["timeoutSeconds"],
                    900
                );
                assert_eq!(
                    value["spec"]["harnesses"]["assistant"]["execution"]["heartbeatEvery"],
                    "30m"
                );
                assert_eq!(
                    value["spec"]["sandboxes"][0]["network"]["proxy"]["host"],
                    "10.200.0.1"
                );
                assert_eq!(
                    value["spec"]["sandboxes"][0]["network"]["proxy"]["management"],
                    "external"
                );
                assert_eq!(
                    value["spec"]["sandboxes"][0]["network"]["proxy"]["port"],
                    3128
                );
                assert_eq!(agents[0]["tools"]["disclosure"], "progressive");
            }
            FixtureCase::ManagedOllama => {
                assert!(value["spec"]["inferenceProviders"][0]["ollama"].is_object());
            }
            FixtureCase::OllamaProxy => {
                assert_eq!(
                    value["spec"]["inferenceProviders"][0]["endpoint"],
                    "http://127.0.0.1:11434/v1"
                );
                assert_eq!(
                    value["spec"]["inferenceProviders"][0]["ollamaProxy"]["endpoint"],
                    "http://172.20.0.1:11435/v1"
                );
            }
            FixtureCase::ManagedVllm => {
                assert_eq!(
                    value["spec"]["inferenceProviders"][0]["service"]["backend"],
                    "vllm"
                );
                assert_eq!(
                    value["spec"]["inferenceProviders"][0]["service"]["hardware"]["minComputeCapability"],
                    90
                );
            }
            FixtureCase::Pi => {
                assert_eq!(value["spec"]["sandboxes"][0]["harness"]["kind"], "pi");
                assert_eq!(
                    value["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0]["overrides"]
                        ["piModel"]["api"],
                    "openai-completions"
                );
            }
            FixtureCase::Podman => {
                assert_eq!(value["spec"]["gateway"]["management"], "managed");
                assert_eq!(
                    value["spec"]["gateway"]["engine"],
                    "unix:///run/user/1000/podman/podman.sock"
                );
                assert_eq!(
                    value["spec"]["sandboxes"][0]["runtime"]["provider"],
                    "podman"
                );
                assert_eq!(
                    value["spec"]["gateway"]["endpoint"],
                    "http://127.0.0.1:17891"
                );
            }
            FixtureCase::WebSearch => {
                assert_eq!(value["spec"]["integrations"]["search"]["kind"], "webSearch");
                assert_eq!(
                    value["spec"]["integrations"]["search"]["credential"]["env"],
                    "BRAVE_API_KEY"
                );
                assert_eq!(document.credential_names(), ["BRAVE_API_KEY"]);
            }
            FixtureCase::HermesInterfaces => {
                assert_eq!(value["spec"]["sandboxes"][0]["harness"]["kind"], "hermes");
                assert_eq!(
                    value["spec"]["sandboxes"][0]["harness"]["interfaces"]["api"]["port"],
                    8643
                );
                assert_eq!(
                    value["spec"]["sandboxes"][0]["harness"]["interfaces"]["dashboard"]["enabled"],
                    true
                );
                assert_eq!(
                    value["spec"]["sandboxes"][0]["harness"]["interfaces"]["dashboard"]["port"],
                    18800
                );
                assert_eq!(
                    value["spec"]["sandboxes"][0]["harness"]["interfaces"]["dashboard"]["internalPort"],
                    19120
                );
                assert_eq!(
                    value["spec"]["sandboxes"][0]["harness"]["interfaces"]["dashboard"]["tui"]["enabled"],
                    true
                );
            }
        }
    }

    fn assert_qualification(qualification: Qualification) {
        let deployment = include_str!("../../nemoclaw-e2e/tests/deployment.rs");
        match qualification {
            Qualification::DashboardLifecycle => assert!(deployment.contains(
                "async fn openclaw_interfaces_sdk_lifecycle_preserves_intent_and_rejects_drift"
            )),
            Qualification::GatewayEndpointLifecycle => {
                assert!(deployment.contains(
                    "async fn sdk_apply_cli_export_sdk_reapply_and_cli_destroy_share_state"
                ));
                assert!(
                    deployment
                        .contains("document.spec.gateway.endpoint = fixture.endpoint.clone()")
                );
                assert!(deployment.contains("assert_eq!(exported, document)"));
            }
            Qualification::HermesInterfacesLifecycle => {
                assert!(
                    deployment.contains("async fn hermes_interfaces_sdk_export_reapply_and_drift")
                );
                assert!(
                    include_str!("../../nemoclaw-sdk/tests/interfaces.rs").contains(
                        "fn hermes_native_interfaces_preserve_explicit_enablement_and_reject_collisions"
                    )
                );
            }
            Qualification::PodmanRuntime => {
                assert!(
                    include_str!("../../nemoclaw-sdk/tests/managed_podman.rs").contains(
                        "fn managed_podman_selects_one_driver_and_mounts_the_declared_socket"
                    )
                );
                assert!(
                    include_str!("../../nemoclaw-e2e/tests/remote_service.rs").contains(
                        "async fn managed_pi_model_lifecycle_preserves_data_without_generation"
                    )
                );
            }
            Qualification::ProxyPolicyLifecycle => {
                assert!(deployment.contains(
                    "async fn explicit_network_sdk_apply_cli_export_reapply_and_destroy_preserve_intent"
                ));
                assert!(
                    include_str!("../../nemoclaw-sdk/tests/network_config.rs")
                        .contains("fn explicit_policy_and_proxy_survive_yaml_and_compilation")
                );
                assert!(
                    include_str!("../../nemoclaw-e2e/tests/openshell.rs").contains(
                        "async fn explicit_policy_and_proxy_reach_the_gateway_and_detect_drift"
                    )
                );
            }
            Qualification::ToolsObservabilityLifecycle => {
                for test in [
                    "async fn explicit_network_sdk_apply_cli_export_reapply_and_destroy_preserve_intent",
                    "async fn execution_settings_cli_export_reapply_and_drift",
                    "async fn multiple_agents_cli_export_reapply_and_policy_drift",
                    "async fn tool_disclosure_cli_export_reapply_and_drift",
                    "async fn observability_cli_export_reapply_and_drift",
                ] {
                    assert!(deployment.contains(test), "missing qualification {test}");
                }
            }
            Qualification::WebSearchLifecycle => {
                assert!(deployment.contains("async fn web_search_cli_export_reapply_and_destroy"));
                assert!(
                    include_str!("../../nemoclaw-e2e/tests/web_search.rs").contains(
                        "async fn search_owns_profile_and_provider_preserves_secret_custody_and_rejects_profile_drift"
                    )
                );
            }
        }
    }

    #[test]
    fn maintained_v0_onboarding_inventory_is_executable_and_countable() {
        assert_eq!(V0_SOURCE_REVISION.len(), 40);
        assert_eq!(V0_SOURCE_DATE, "2026-09-17");
        assert_eq!(
            V0_PUBLIC_FLAGS.len(),
            V0_PUBLIC_FLAGS
                .iter()
                .copied()
                .collect::<HashSet<_>>()
                .len(),
            "the pinned public flag catalog contains duplicates"
        );
        assert_eq!(
            V0_USER_ENVIRONMENT.len(),
            V0_USER_ENVIRONMENT
                .iter()
                .copied()
                .collect::<HashSet<_>>()
                .len(),
            "the pinned environment catalog contains duplicates"
        );
        assert_eq!(
            V0_WORKFLOW_FAMILIES.len(),
            V0_WORKFLOW_FAMILIES
                .iter()
                .copied()
                .collect::<HashSet<_>>()
                .len(),
            "the pinned workflow-family catalog contains duplicates"
        );
        let inventory = maintained_v0_inventory();
        let mut ids = HashSet::new();
        let mut gaps = HashSet::new();
        let mut dispositions = HashSet::new();
        let mut covered_inputs = HashSet::new();
        let mut covered_families = HashSet::new();

        for scenario in &inventory {
            assert!(
                ids.insert(scenario.id),
                "duplicate scenario {}",
                scenario.id
            );
            assert!(!scenario.family.is_empty());
            covered_families.insert(scenario.catalog_family);
            assert!(!scenario.v0_source.is_empty());
            assert!(!scenario.v0_behavior.is_empty());
            dispositions.insert(scenario.disposition);
            covered_inputs.extend(scenario.v0_inputs.iter().copied());
            match (scenario.disposition, scenario.gap) {
                (DispositionKind::Representable, None) => {}
                (DispositionKind::Representable, Some(_)) => {
                    panic!("{} is representable but has a gap", scenario.id)
                }
                (_, Some(gap)) => {
                    assert!(gaps.insert(gap.id), "duplicate gap {}", gap.id);
                    assert!(
                        gap.owner
                            .starts_with("https://github.com/NVIDIA/NemoClaw/issues/")
                    );
                    assert!(!gap.reason.is_empty());
                    match scenario.disposition {
                        DispositionKind::ParseRejected | DispositionKind::ProposedShapeRejected => {
                            assert_eq!(gap.boundary, Boundary::DocumentParse)
                        }
                        DispositionKind::ParsedDownstream => assert!(matches!(
                            gap.boundary,
                            Boundary::Authoring
                                | Boundary::CredentialFulfillment
                                | Boundary::PlanRuntimeQualification
                        )),
                        DispositionKind::IntentionallyNotTargeted
                        | DispositionKind::ScopeDecision => {
                            assert_eq!(gap.boundary, Boundary::ProductScope)
                        }
                        DispositionKind::Representable => unreachable!(),
                    }
                }
                (_, None) => panic!("{} requires a stable owned gap", scenario.id),
            }
            match (scenario.disposition, scenario.evidence) {
                (DispositionKind::Representable, Evidence::Authoring(case))
                | (DispositionKind::ParsedDownstream, Evidence::Authoring(case)) => {
                    let output = authored(case);
                    assert!(output.yaml().len() as u64 <= MAX_DOCUMENT_BYTES);
                    let reparsed = Document::parse(output.yaml().as_bytes()).unwrap();
                    assert_eq!(&reparsed, output.document(), "{}", scenario.id);
                    assert_authoring(case, &reparsed);
                }
                (DispositionKind::ParsedDownstream, Evidence::Fixture(case)) => {
                    let bytes = fixture(case);
                    let document = Document::parse(bytes.as_slice()).unwrap_or_else(|error| {
                        panic!("{} must remain parser-accepted: {error}", scenario.id)
                    });
                    assert_fixture(case, &document);
                }
                (
                    DispositionKind::Representable,
                    Evidence::QualifiedFixture(case, qualification),
                ) => {
                    let bytes = fixture(case);
                    let document = Document::parse(bytes.as_slice()).unwrap_or_else(|error| {
                        panic!("{} must remain parser-accepted: {error}", scenario.id)
                    });
                    assert_fixture(case, &document);
                    assert_qualification(qualification);
                }
                (
                    DispositionKind::ParseRejected | DispositionKind::ProposedShapeRejected,
                    Evidence::Mutation(mutation),
                ) => {
                    let yaml = mutated_yaml(mutation);
                    assert!(
                        Document::parse(yaml.as_bytes()).is_err(),
                        "{} proposal unexpectedly crossed Document::parse",
                        scenario.id
                    );
                }
                (
                    DispositionKind::IntentionallyNotTargeted | DispositionKind::ScopeDecision,
                    Evidence::None,
                ) => {}
                _ => panic!(
                    "{} has evidence inconsistent with its disposition",
                    scenario.id
                ),
            }
        }

        assert_eq!(
            dispositions,
            HashSet::from([
                DispositionKind::Representable,
                DispositionKind::ParseRejected,
                DispositionKind::ProposedShapeRejected,
                DispositionKind::ParsedDownstream,
                DispositionKind::IntentionallyNotTargeted,
                DispositionKind::ScopeDecision
            ])
        );
        assert_eq!(
            covered_inputs,
            V0_PUBLIC_FLAGS
                .iter()
                .chain(V0_USER_ENVIRONMENT)
                .copied()
                .collect(),
            "a revision-pinned public flag or user-facing environment input is missing or invented"
        );
        assert_eq!(
            covered_families,
            V0_WORKFLOW_FAMILIES.iter().copied().collect(),
            "a maintained V0 workflow family is missing or invented"
        );
        assert_eq!(inventory.len(), 47);
        assert_eq!(
            inventory
                .iter()
                .filter(|scenario| scenario.disposition == DispositionKind::Representable)
                .count(),
            10
        );
        assert_eq!(gaps.len(), 37);
    }
}
