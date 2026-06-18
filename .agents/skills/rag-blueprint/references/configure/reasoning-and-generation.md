# Reasoning, Self-Reflection & Prompt Customization

## When to Use
User wants to enable reasoning/thinking mode, stream or inspect `reasoning_content`, configure self-reflection, customize prompts, adjust generation parameters (max tokens, temperature, citations), or understand thinking budget options.

## Process
1. Detect the deployment mode (Docker / Helm / Library). Docker: edit the active env file. Helm: edit `values.yaml`. Library: edit `notebooks/config.yaml`
2. Read the relevant source doc for the specific feature
3. Apply env vars to the active config or edit prompt files, restart RAG server
4. Prompt changes require `--build` flag (Docker); env var changes only need restart
5. Verify: test with a query and check for reasoning output or changed behavior

## Decision Table

| Goal | Source Doc | Key Action |
|------|-----------|------------|
| Enable reasoning (Nemotron 3 / Nano 30B) | `docs/enable-nemotron-thinking.md` | `LLM_ENABLE_THINKING=true`, optionally `LLM_REASONING_BUDGET`, `LLM_LOW_EFFORT` |
| Enable prompt-directed thinking | `docs/enable-nemotron-thinking.md` | Edit `prompt.yaml`: `/no_think` → `/think`, set temperature/top-p |
| Self-reflection | `docs/self-reflection.md` | `ENABLE_REFLECTION=true`, set thresholds |
| Prompt customization | `docs/prompt-customization.md` | `PROMPT_CONFIG_FILE=/path/to/custom.yaml` or edit prompt.yaml |
| Generation parameters | `docs/llm-params.md` | `LLM_MAX_TOKENS`, `LLM_TEMPERATURE`, `ENABLE_CITATIONS` |
| Per-request overrides | `docs/llm-params.md` | `temperature`, `top_p`, `max_tokens`, `stop` in API payload |

## Agent-Specific Notes

- Prompt changes need `--build` flag on restart; env var changes do not
- Self-reflection: streaming not supported during groundedness checks
- Self-reflection uses same LLM by default; override with `REFLECTION_LLM`, `REFLECTION_LLM_SERVERURL`, `REFLECTION_LLM_APIKEY`
- Helm: only on-premises reflection is supported
- GPU requirements for reflection: see `docs/self-reflection.md` for optimal GPU configurations
- Debug reflection: set `LOGLEVEL=INFO` to observe iteration counts
- `ENABLE_NEMOTRON_3_NANO_THINKING` is deprecated; use `LLM_ENABLE_THINKING`
- With current streaming responses, reasoning is separated from the user-facing answer: `choices[].delta.reasoning_content` carries reasoning while `choices[].delta.content` carries final answer tokens
- `FILTER_THINK_TOKENS=true` keeps final-answer content clean but still preserves reasoning structurally in `reasoning_content` when the server is configured to preserve it
- 18 prompt templates available in `prompt.yaml` — custom file only overrides specified keys

### Reasoning Model Comparison

| Model | Control | Thinking Budget | Output Format |
|-------|---------|-----------------|---------------|
| Nemotron 3 / Nemotron 3 Super | `LLM_ENABLE_THINKING` plus model template args, or prompt `/think` where documented | `LLM_REASONING_BUDGET`, `LLM_LOW_EFFORT` | `reasoning_content` stream or filtered `<think>` blocks |
| Nemotron-3-Nano 9B | System prompt (`/think`) | `min_thinking_tokens` + `max_thinking_tokens` | `reasoning_content` field |
| Nemotron-3-Nano 30B | `LLM_ENABLE_THINKING` env var | `LLM_REASONING_BUDGET` or `max_thinking_tokens` | `reasoning_content` field |

### Thinking Budget Recommendations

| Range | Use Case |
|-------|----------|
| 1024–4096 | Faster responses for simpler questions |
| 8192–16384 | More thorough reasoning for complex queries |

## Notebooks
- `notebooks/retriever_api_usage.ipynb` — end-to-end query examples showing generation behavior

## Source Documentation
- `docs/enable-nemotron-thinking.md` — Reasoning mode for all Nemotron models
- `docs/self-reflection.md` — Self-reflection configuration and thresholds
- `docs/prompt-customization.md` — Prompt template catalog and customization
- `docs/llm-params.md` — Generation parameters (temperature, max tokens, etc.)
