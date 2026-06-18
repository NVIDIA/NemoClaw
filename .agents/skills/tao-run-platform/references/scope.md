# What the SDK does NOT do

Read this when the agent is tempted to ask the SDK for something it
intentionally doesn't provide — these are scope guardrails, not bugs.

- It does **not** read or interpret skills. The agent reads `SKILL.md` and `references/skill_info.yaml`; the SDK just submits whatever command the agent constructs.
- It does **not** do hyperparameter optimization by itself. The agent owns the
  model-level AutoML policy: when model metadata has `automl_enabled: true`, use
  `skills/applications/tao-run-automl` (which uses this SDK as a building block) unless the
  workflow passes `automl_policy: off` or the user explicitly asks for a plain
  single training run.
- It does **not** decide what goes in the spec. The agent constructs the spec dict (loading templates, applying overrides) and passes it to `build_entrypoint`, which serializes the spec and inlines the in-container runner that writes it to `{config_path}` at job start. The SDK has no opinion about which keys you set.
- It does **not** select platforms automatically. Pick the SDK matching your target backend explicitly: `LeptonSDK`, `BrevSDK`, `DockerSDK`, `SlurmSDK`, or `KubernetesSDK`.
- It does **not** orchestrate multi-step workflows. The agent chains jobs by polling and constructing the next command.
