# Deep Agent Orchestration for cuTile

## Purpose

When a user request involves complex logic with multiple operations, user-defined functions, or multi-kernel composition, the single-agent linear workflow may struggle. The deep agent orchestration approach decomposes these complex tasks into smaller sub-problems, solves them in parallel, and composes the results.

## Pure cuTile Forward Path

The orchestration pipeline must produce a solution where `forward()`/`composed_function()` routes ALL compute through `@ct.kernel` + `ct.launch`. No `nn.*`/`F.*` compute calls (e.g., `self.conv(x)`, `F.conv2d(x, w)`) in the forward path. Using `nn.Conv2d` etc. in `__init__` for weight initialization is fine — as long as `forward()` extracts weights and passes them to cuTile kernels.

- **Analyzer**: Must produce a kernel spec for every compute op — no ops left to PyTorch
- **Kernel Agents**: Must implement each spec as a real cuTile kernel
- **Composer**: Must verify the composed forward path is pure cuTile (Step 5 self-check)

## When to Use Orchestration

Use the orchestrated multi-agent workflow when **ANY** of these apply:

| Trigger | Example |
|---------|---------|
| **3+ distinct operations** that need separate kernels | "Implement a transformer block with attention, FFN, and layer norm" |
| **Multiple user-defined functions** in the input | User provides code with `custom_activation()`, `custom_norm()`, etc. |
| **Inter-kernel data dependencies** | Output of kernel A feeds into kernel B |
| **PyTorch nn.Module** with multiple layers | `class MyModel(nn.Module)` with complex `forward()` |
| **Explicit decomposition request** | "Break this into fused kernels" |

**Use the simple linear workflow** (existing) when:
- Single kernel task (ReLU, softmax, one matmul)
- Bug fix or optimization of existing kernel
- API question or example adaptation
- Clear, single-operation request

## Agent Hierarchy

```
User Request (complex task)
    |
    v
[Main Agent: Complexity Assessment]
    |-- Simple? --> Existing linear workflow (SKILL.md Steps 0-6)
    |-- Complex? --> Orchestration mode:
    v
[0. Op Tracer (torch-learner)] -- OPTIONAL: when op internals are non-obvious
    Input:  PyTorch op name (e.g., nn.LSTM, F.multi_head_attention_forward)
    Output: Implementation trace (math, memory layout, backends, backward formulas)
    |
    v
[1. Analyzer Agent]
    Input:  User's code/description + trace context (if available)
    Output: Decomposition plan with kernel specs
    |
    v
[2. Kernel Agents] (launched in PARALLEL for independent specs)
    Input:  One kernel spec each
    Output: Validated kernel code per spec
    |
    v
[3. Composer Agent]
    Input:  All validated kernels + original request
    Output: Single composed .py file with end-to-end validation
    |
    v
[Main Agent: Final Execution]
    Run the composed file, verify PASS
```

## Step 0: Op Tracing with torch-learner (Optional)

When the user's request involves PyTorch ops whose internals are non-obvious (e.g., `nn.LSTM`, `nn.GRU`, fused attention), trace the op inline before running the Analyzer. This grounds the decomposition in the actual implementation rather than relying on potentially imprecise LLM knowledge.

**CRITICAL**: This step runs in the **main agent context**, NOT as a sub-agent. Do NOT invoke torch-learner via the Skill tool — follow the tracing workflow inline:
1. Read `torch-learner/tracing_workflow.md` (in the tilegym-cutile-python skill directory)
2. Follow the Core Tracing Workflow (Steps 1–7) directly
3. Pass the trace output to Step 1 (Analyzer Agent) as context

### When to Trace

| Trace | Don't Trace |
|-------|-------------|
| `nn.LSTM`, `nn.GRU`, `nn.Transformer` | `F.relu`, `F.gelu`, `F.sigmoid` |
| `F.multi_head_attention_forward` | `torch.matmul`, `torch.add` |
| `F.scaled_dot_product_attention` | `F.layer_norm` (standard formula) |
| Custom/composite ops with C++ backends | Ops where user provides the math |
| Any op where you're unsure about internal structure | Well-known ops from cuTile examples |

### What the Trace Provides

The torch-learner trace uncovers details that directly inform kernel decomposition:

| Trace Output | How Analyzer Uses It |
|-------------|---------------------|
| **Gate computations** (e.g., LSTM i/f/g/o gates) | Identifies fusion opportunity: all gates as one matmul |
| **Memory layout** (batch-first vs time-first) | Sets correct tensor shapes in kernel specs |
| **Backend selection** (cuDNN, custom CUDA) | Reveals which sub-operations are fused in hardware |
| **Backward formulas** | Enables backward kernel generation if needed |
| **Edge cases** (dropout, bidirectional) | Ensures specs handle all code paths |

### Trace Output Format

The trace produces a structured report that should be passed to the Analyzer:

```
## Trace: <op_name>

### Call Chain
User code -> Python Module -> C++ Entry -> CUDA Implementation

### Forward Pass Math
<mathematical operations with variable names>

### Memory Layout
<tensor shapes, strides, allocation patterns>

### Backend Details
<which library/kernel is actually used>

### Backward Formulas
<gradient computations>

### Summary Table
| Layer | File | Key Function |
|-------|------|-------------|
| ...   | ...  | ...         |
```

## Inter-Agent Communication: Kernel Specs

Agents communicate through structured kernel specifications. The Analyzer produces these, Kernel Agents consume them.

### Kernel Spec Format

```
KERNEL SPEC: <kernel_id>
Description: <what this kernel computes>
Operations: <list of fused operations>

Inputs:
  - <name>: shape=<shape>, dtype=<dtype>

Outputs:
  - <name>: shape=<shape>, dtype=<dtype>

Dependencies: <list of kernel_ids that must complete first, or "none">

PyTorch Reference:
```python
def reference_<kernel_id>(<inputs>):
    <pytorch implementation for validation>
    return <outputs>
```

Notes: <any special considerations - memory layout, precision, etc.>
```

### Example Decomposition

User request: "Write cuTile kernels for a simple transformer FFN: linear1 -> GELU -> linear2 -> residual add + layer norm"

Analyzer output:
```
KERNEL SPEC: ffn_linear_gelu
Description: Fused linear projection + GELU activation
Operations: [matmul, gelu]
Inputs:
  - x: shape=(B, S, D), dtype=float16
  - W1: shape=(D, D_ff), dtype=float16
  - b1: shape=(D_ff,), dtype=float16
Outputs:
  - y: shape=(B, S, D_ff), dtype=float16
Dependencies: none

KERNEL SPEC: ffn_linear2
Description: Second linear projection
Operations: [matmul]
Inputs:
  - x: shape=(B, S, D_ff), dtype=float16
  - W2: shape=(D_ff, D), dtype=float16
  - b2: shape=(D,), dtype=float16
Outputs:
  - y: shape=(B, S, D), dtype=float16
Dependencies: [ffn_linear_gelu]

KERNEL SPEC: residual_layernorm
Description: Residual addition + layer normalization
Operations: [add, layer_norm]
Inputs:
  - x: shape=(B, S, D), dtype=float16 (output of ffn_linear2)
  - residual: shape=(B, S, D), dtype=float16 (original input)
  - gamma: shape=(D,), dtype=float16
  - beta: shape=(D,), dtype=float16
Outputs:
  - y: shape=(B, S, D), dtype=float16
Dependencies: [ffn_linear2]
```

## How to Spawn Agents

Use the coding assistant's sub-agent or task-delegation mechanism for each agent, when available. In Claude Code, this is the Task tool with `subagent_type="general-purpose"`. In Codex, use the available agent delegation workflow. The prompt for each agent should include:

1. The agent's role instructions (from `orchestration/<agent>_agent.md`)
2. The specific input for that invocation
3. The working directory path for accessing references

**Key principles:**
- **Sub-agents generate code only.** The main agent handles ALL execution and debugging.
- **The main agent does NOT read cuTile reference files, TileGym examples, or translation guides.** Sub-agents read what they need. The main agent's context should stay lean for orchestration and debugging.

### Parallel Execution

When kernel specs have no dependencies between them, launch their Kernel Agents in **parallel** using multiple Task tool calls in a single message. This is the key performance advantage.

Example: If specs A, B, C are all independent:
- Launch all three Kernel Agents in parallel (one Task call each, same message)
- All return code simultaneously

### Execution Order

1. **Op Tracer (main agent, inline)** - if needed, read `torch-learner/tracing_workflow.md` and follow it directly; runs synchronously before anything else
2. **Analyzer Agent (Task tool)** - receives trace context if available, returns specs
3. **Kernel Agents (Task tool, parallel)** - all independent specs run concurrently, return code
4. **Composer Agent (Task tool)** - receives all kernel code, returns composed `.py` file
5. **Main Agent: validate and debug** - executes the composed file, fixes errors directly

**Key constraints**:
- Step 0 (Op Tracer) runs inline in the main agent — do NOT use the Skill tool
- Steps 1-4 (Analyzer, Kernel, Composer) generate code only - no execution in sub-agents
- Step 5 (validate/debug) runs only in the main agent with full tool access

## Error Handling

All debugging happens in the main agent on the complete composed program:

### Compilation/Runtime Error
1. Read the error message from `python <file>.py`
2. Fix the relevant code directly in the composed file
3. Re-run and check

### Numerical Validation Failure
1. Add debug prints between kernel launches to isolate which kernel diverges
2. Fix the problematic kernel directly in the file
3. Re-run and check

### Persistent Kernel Failure
If direct fixing isn't working after 2-3 attempts:
1. Re-spawn that specific Kernel Agent with the error message as additional context
2. Get new code, update the composed file
3. Re-run

### Analyzer Spec Issues
If the composed program fundamentally doesn't work (wrong decomposition):
1. Re-run the Analyzer with feedback about what went wrong
2. Re-generate kernels and re-compose
