---
name: nat
description: "NVIDIA NeMo Agent Toolkit (NAT) — install, create workflows, add tools, run agents, evaluate performance, and publish as A2A/MCP servers. Use when: (1) installing or setting up NAT, (2) creating or editing workflow YAML configs, (3) adding built-in or custom tools/functions, (4) running agents with `nat run`, (5) evaluating or profiling workflows, (6) publishing workflows as A2A or MCP servers, (7) creating custom functions or function groups, (8) integrating with LangChain, LlamaIndex, CrewAI, or other frameworks. Trigger keywords: NAT, NeMo Agent Toolkit, nvidia-nat, nat run, nat workflow, nat eval, nat a2a, nat profiler, workflow.yml, react_agent, tool_calling_agent."
metadata: { "openclaw": { "requires": { "anyBins": ["nat", "pip", "uv"] }, "primaryEnv": "NVIDIA_API_KEY" } }
---

# NVIDIA NeMo Agent Toolkit (NAT)

A flexible library for connecting enterprise agents to data sources and tools across any framework.

- **Repo**: https://github.com/NVIDIA/NeMo-Agent-Toolkit
- **Docs**: https://docs.nvidia.com/nemo/agent-toolkit/latest/

## Installation

```bash
# Core (pick one)
uv pip install nvidia-nat        # recommended
pip install nvidia-nat

# With framework extras
uv pip install "nvidia-nat[langchain]"    # LangChain/LangGraph
uv pip install "nvidia-nat[llama-index]"  # LlamaIndex
uv pip install "nvidia-nat[crewai]"       # CrewAI
uv pip install "nvidia-nat[mcp]"          # MCP
uv pip install "nvidia-nat[a2a]"          # A2A
uv pip install "nvidia-nat[mem0ai]"       # Mem0 memory
uv pip install "nvidia-nat[eval,profiling]"  # Eval + profiling

# Verify
nat --help && nat --version
```

For development install from source, see [references/install-from-source.md](references/install-from-source.md).

## Quick Start

```bash
export NVIDIA_API_KEY=<key_from_build.nvidia.com>
```

Create `workflow.yml`:

```yaml
functions:
  wikipedia_search:
    _type: wiki_search
    max_results: 2

llms:
  nim_llm:
    _type: nim
    model_name: meta/llama-3.1-70b-instruct
    temperature: 0.0

workflow:
  _type: react_agent
  tool_names: [wikipedia_search]
  llm_name: nim_llm
  verbose: true
  parse_agent_response_max_retries: 3
```

```bash
nat run --config_file workflow.yml --input "List five subspecies of Aardvarks"
```

## Workflow Configuration Structure

Four main YAML sections:

| Section | Purpose |
|---|---|
| `functions` | Tools (web search, calculators, custom) |
| `llms` | LLM provider configs (NIM, OpenAI, Azure, Bedrock) |
| `embedders` | Embedding models for vector storage |
| `workflow` | Agent type + wiring of tools and LLMs |

## Agent Types (`_type` in `workflow`)

- `react_agent` — Reasoning and acting
- `reasoning_agent` — Advanced reasoning
- `rewwo_agent` — Reasoning Without Observation
- `responses_api_agent` — OpenAI Responses API
- `tool_calling_agent` — Direct tool calling
- `automatic_memory_wrapper_agent` — Adds memory
- `router_agent` — Routes to different workflows
- `sequential_executor` — Sequential tool execution

## Built-in Tools (`_type` in `functions`)

`wiki_search`, `webpage_query`, `tavily_internet_search`, `arxiv_search`, `current_datetime`, `calculator`, `text_file_ingest`, and many more framework-specific tools.

List all available components:

```bash
nat info components -t function      # Tools
nat info components -t llm_provider  # LLMs
nat info components -t embedder      # Embedders
```

## Common CLI Commands

```bash
# Run workflow
nat run --config_file workflow.yml --input "question"

# Override params without editing YAML
nat run --config_file workflow.yml --input "question" \
  --override llms.nim_llm.temperature 0.7 \
  --override llms.nim_llm.model_name meta/llama-3.3-70b-instruct

# Create new workflow template
nat workflow create --workflow-dir examples my_workflow

# Evaluate
nat eval --config_file eval_config.yml

# Profile
nat profiler --config_file workflow.yml --input "test"

# Red team
nat red-team --config_file workflow.yml

# Workflow management
nat workflow reinstall my_workflow
nat workflow delete my_workflow
```

## Custom Tools and Function Groups

For creating custom tools, function groups, and advanced patterns, see:

- [references/custom-tools.md](references/custom-tools.md) — Writing custom functions, registration, and installation
- [references/function-groups.md](references/function-groups.md) — Shared config, namespacing, include/exclude, access levels

## A2A Server

Publish workflows as A2A agents for discovery and invocation by other A2A clients.

```bash
# Start A2A server
nat a2a serve --config_file workflow.yml

# Discover agent
nat a2a client discover --url http://localhost:10000

# Call agent
nat a2a client call --url http://localhost:10000 --message "What is 42 * 67?"
```

For full A2A configuration (auth, concurrency, Kubernetes), see [references/a2a-server.md](references/a2a-server.md).

## Examples

The repo includes examples organized by category: Getting Started, Agents, Advanced Agents, Control Flow, Frameworks, MCP/A2A, Evaluation, and more. See [references/examples.md](references/examples.md) for the full catalog and how to run them.

```bash
# Run any example
uv pip install -e examples/<example_directory>
nat run --config_file examples/<example_directory>/configs/config.yml --input "test"
```
