# Deep Agent Orchestration Workflow

For complex tasks, decompose the work into sub-problems and solve them with specialized agents. This approach is inspired by [KernelFalcon](https://pytorch.org/blog/kernelfalcon-autonomous-gpu-kernel-generation-via-deep-agents/) - the key insight is that LLMs succeed more reliably when given precise, well-scoped sub-tasks rather than a single large task.

For the full orchestration reference, see **[overview.md](overview.md)**.

**IMPORTANT: When using orchestration, the main agent is an orchestrator, NOT a coder.** Do NOT read cuTile reference files, TileGym examples, or translation guides yourself. Sub-agents (Kernel Agents) will read the references they need. The main agent's only jobs are:
1. Invoke `/torch-learner` if needed (Step O-0)
2. Spawn Analyzer, Kernel, and Composer agents (Steps O-1 through O-3)
3. Execute and debug the composed program (Step O-4)

**All steps O-0 through O-4 must be completed without stopping.** After each step finishes, immediately proceed to the next step in the same conversation. Do NOT pause and wait for user input between orchestration steps — the user asked for the complete result, not a status update.

Reading reference files in the main agent wastes context window and risks hitting token limits.

## Pipeline Overview

```
User Request (complex task)
    |
    v
[0. Op Tracer (torch-learner)] - Trace PyTorch op internals (when needed)
    |
    v
[1. Analyzer Agent] - Decomposes into kernel specs (uses trace context)
    |
    v
[2. Kernel Agents]  - Generate individual kernels (parallel when independent)
    |
    v
[3. Composer Agent]  - Combines into final solution with end-to-end validation
    |
    v
[Main Agent: Execute and verify]
```

## Step O-0: Trace PyTorch Ops (When Needed)

**When to use**: The user's request involves PyTorch ops whose internal implementation is non-obvious - ops that go through C++/CUDA layers and can't be decomposed just from the Python API. Examples:

| Use Op Tracer | Skip Op Tracer |
|---------------|----------------|
| `nn.LSTM`, `nn.GRU` (complex gate logic, cuDNN paths) | `F.relu`, `F.gelu` (simple element-wise) |
| `F.multi_head_attention_forward` (fused internals) | `torch.matmul` (well-understood) |
| Custom fused ops (`torch.ops.aten.*`) | `F.layer_norm` (standard formula) |
| Ops with non-obvious backward passes | Ops the user already provides math for |

**How to trace (inline — do NOT use the Skill tool):**

1. **Read** `torch-learner/tracing_workflow.md` (in this skill's directory).
2. **Follow** the Core Tracing Workflow (Steps 1–7) directly in the main agent context.
3. **Use** `torch-learner/references/` and `torch-learner/examples/lstm_trace.md` as needed.

**This step is synchronous** — complete the trace before moving to Step O-1. The trace provides the Analyzer with ground-truth implementation details instead of relying on potentially imprecise LLM knowledge.

> The tracing workflow file ends with a mandatory continuation note reminding you to proceed
> to Step O-1. Your next tool call after the trace is the **Task tool** for the Analyzer Agent.

---

## Step O-1: Spawn Analyzer Agent

> **Continuation note**: You are here because torch-learner just completed in Step O-0. Your next
> tool call is the Task tool below. Do not output anything to the user until Step O-4 is done.

Use the **Task tool** with `subagent_type="general-purpose"` to spawn an Analyzer Agent.

**Prompt template (without trace context):**
```
You are a Task Decomposition Specialist for cuTile GPU kernel development.
Read the instructions in <skill_dir>/orchestration/analyzer_agent.md, then analyze the
following user request and produce structured kernel specifications.

Skill directory (for reading references/examples/orchestration files): <skill_dir>

User request:
<paste the user's request here>
```

**Prompt template (with trace context from Step O-0):**
```
You are a Task Decomposition Specialist for cuTile GPU kernel development.
Read the instructions in <skill_dir>/orchestration/analyzer_agent.md, then analyze the
following user request and produce structured kernel specifications.

Skill directory (for reading references/examples/orchestration files): <skill_dir>

User request:
<paste the user's request here>

PyTorch Implementation Trace (from torch-learner):
<paste the trace output here>

Use the trace to understand the exact mathematical operations, memory layouts,
and backend behavior. Base your kernel decomposition on what the op actually
computes, not on assumptions.
```

The Analyzer will return a decomposition with:
- A list of kernel specs (inputs, outputs, operations, dependencies)
- PyTorch reference implementations for each kernel
- Composition notes explaining data flow

For the full Analyzer prompt and output format, see **[analyzer_agent.md](analyzer_agent.md)**.

## Step O-2: Spawn Kernel Agents (Parallel, Code Generation Only)

For each kernel spec from the Analyzer, spawn a Kernel Agent using the **Task tool**. Kernel Agents **only generate code** - they do not execute or validate.

**Important**: Launch agents for **all independent kernels in parallel** (multiple Task calls in one message).

**Prompt template:**
```
You are a cuTile Kernel Code Generator.
Read the instructions in <skill_dir>/orchestration/kernel_agent.md, then generate
cuTile kernel code for the following specification.
Do NOT execute or validate the code - just generate it.

Skill directory (for reading references/examples): <skill_dir>

Kernel Spec:
<paste one kernel spec here>
```

Each Kernel Agent will:
1. Read relevant cuTile references
2. Search TileGym and fallback examples
3. Design and generate the kernel code
4. Return the `@ct.kernel` function + `launch_` wrapper

For the full Kernel Agent prompt and patterns, see **[kernel_agent.md](kernel_agent.md)**.

## Step O-3: Spawn Composer Agent (Code Generation Only)

After all Kernel Agents return their code, spawn a Composer Agent to combine everything into a single file. The Composer **only generates the composed file** - it does not execute.

**Prompt template:**
```
You are a Kernel Composition Specialist for cuTile GPU kernel development.
Read the instructions in <skill_dir>/orchestration/composer_agent.md, then compose
the following kernels into a single .py file with end-to-end validation.
Do NOT execute the code - just generate the complete file.

Skill directory (for reading composer_agent.md): <skill_dir>

Original user request:
<paste original request>

Kernel Specs (from Analyzer):
<paste the full decomposition>

Kernel Implementations:
<paste each kernel agent's code output>
```

The Composer will return a complete `.py` file containing:
1. All kernels organized by dependency order
2. Glue code and intermediate tensor allocation
3. A `composed_function()` that chains all kernels
4. A `pytorch_reference()` for validation
5. An `if __name__ == "__main__":` block with end-to-end test

For the full Composer prompt and patterns, see **[composer_agent.md](composer_agent.md)**.

## Step O-4: Validate and Debug (Main Agent)

**This is the ONLY step where code is executed.** The main agent owns all execution and debugging.

1. **Write** the Composer's output to a `.py` file in the **current working directory** (run `pwd` if unsure — write to that path, never under `<skill_dir>`)
2. **Run** it: `python <filename>.py`
3. **Debug directly on the whole program**:
   - If compilation error → fix the relevant kernel code in the file
   - If runtime error → fix grid dims, tensor shapes, or memory access
   - If validation FAIL → fix algorithm, check intermediate values
4. **Iterate** until PASS (max 3 attempts)

This approach is faster than validating kernels individually because:
- Only one execution environment to manage
- Errors from kernel interactions are caught immediately
- The main agent has full tool access for debugging
- No sub-agent permission issues

## Error Handling

- **Compilation/runtime error in one kernel**: Fix it directly in the composed file - no need to re-run sub-agents
- **Persistent failure in one kernel**: If direct fixing isn't working, re-spawn that Kernel Agent with the error message as additional context, then re-compose
- **Analyzer produces bad specs**: If the composed program fundamentally doesn't work, re-run the Analyzer with feedback about what went wrong

## Orchestration Reference Files

| File | Purpose |
|------|---------|
| [overview.md](overview.md) | When to use orchestration, agent hierarchy, communication format |
| [analyzer_agent.md](analyzer_agent.md) | Analyzer Agent: decomposes tasks into kernel specs |
| [kernel_agent.md](kernel_agent.md) | Kernel Agent: implements individual cuTile kernels |
| [composer_agent.md](composer_agent.md) | Composer Agent: combines kernels into final solution |

**Tracing workflow (inline):**

| File | Purpose in Pipeline |
|------|-------------------|
| **torch-learner/tracing_workflow.md** | Step O-0: Follow this directly to trace PyTorch op internals (math, memory layout, backends). Do NOT invoke it via the Skill tool. |
