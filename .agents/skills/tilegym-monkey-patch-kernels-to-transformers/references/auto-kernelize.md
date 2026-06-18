# Auto Kernelize
Autonomously create and integrate TileGym cuTile kernels to `transformers` model.

## Setup
Work with user to prepare experiment environment:
1. Check Git branch status. The previous commit should only contain monkey-patching existing TileGym OPs to the target transformers model. No other unstaged/uncommitted modifications
2. Check GPU available and UUID match; Docker container has been built
3. Study code relating to the target transformers model:
   - modeling/transformers/scripts/benchmark_hf_model.sh: end-to-end benchmark entrance, run PyTorch baseline perf, cuTile kernelize perf, cuTile kernel coverage
   - src/tilegym/transformers/<submodule_name>/modeling_<submodule_name>.py: Target model specific OP adapters and wrappers
   - src/tilegym/transformers/<submodule_name>/kernel_definitions/*.json and kernel_solutions/*.json: Existing reusable kernel inventory
   - src/tilegym/transformers/<submodule_name>/kernels/*.py: Dedicated reusable transformer-local kernel implementations
   - @src/tilegym/transformers/monkey_patch.py: Study apply_tilegym_kernel_to_<submodule_name> to understand how to kernelize
   - @modeling/transformers/src/tilegym_hf_bench/_cli.py: End-to-end benchmark and kernel coverage CLI
   - @modeling/transformers/src/tilegym_hf_bench/tilegym_patch.py: model-id dispatch to TileGym monkey-patch functions
   - @modeling/transformers/src/tilegym_hf_bench/kernel_filters/tilegym_kernel_prefixes.yaml: cuTile kernel coverage filter prefixes
4. Create sandbox/<submodule_name>_results.md to track progress. The first run will write a baseline
5. Confirm and go: Once you get confirmation, kick off the experimentation

## Experimentation
Every experiment must run on an NVIDIA GPU [supported by TileIR](https://docs.nvidia.com/cuda/tile-ir/latest/sections/stability.html#supported-architectures) (currently Ampere, Ada, and Blackwell). Each experiment should be enforced to finish in 15 minutes. Every command should be executed within the experiment Docker container. `cd` to @modeling/transformers/ first, then `bash scripts/benchmark_hf_model.sh --model-key <submodule_name>` to launch one experiment.

Reusable generated kernels must follow the kernel inventory schema linked from `SKILL.md`: start each experiment with a draft FlashInfer Definition, keep verified kernels in dedicated `kernels/<kernel_name>.py` files, and record matching Definition and Solution JSON metadata. The Definition `reference` must begin with `# Source:` comment(s) pointing to precise upstream `transformers` or Hugging Face remote-code regions.

### The goal
- Improve the **core metric**: cuTile kernel coverage percentage in terms of GPU time
- Subject to the **core constraint**: End-to-end throughput shall not drop compared to baseline

### What you can change
- @src/tilegym/transformers/<submodule_name>/modeling_<submodule_name>.py: Model-specific wrappers, patched forward methods, and other patching glue
- @src/tilegym/transformers/<submodule_name>/kernels/<kernel_name>.py: Preferred location for reusable new kernels and thin wrappers
- @src/tilegym/transformers/<submodule_name>/kernel_definitions/<kernel_name>.json: FlashInfer Definition metadata for kept reusable kernels
- @src/tilegym/transformers/<submodule_name>/kernel_solutions/<kernel_name>.json: FlashInfer Solution metadata for kept reusable kernels
- @src/tilegym/transformers/monkey_patch.py: Only change the `apply_tilegym_kernel_to_<submodule name>` function
- @modeling/transformers/src/tilegym_hf_bench/tilegym_patch.py: Only change `apply_tilegym_kernel_to_<submodule name>` dispatch arguments
- @modeling/transformers/src/tilegym_hf_bench/kernel_filters/tilegym_kernel_prefixes.yaml: Only add kernel name substrings for new cuTile kernels after checking current nsys names
- @modeling/transformers/scripts/benchmark_hf_model.sh: Optionally run with `--skip-baseline` to accelerate experiment iterations. Restore full baseline + cuTile + coverage at each experiment end
- @sandbox/: Feel free to add new files or modify files created by you, but don't check to git

### What you can NOT change
- Anything not listed above

### What to expect from experiment outputs
`scripts/benchmark_hf_model.sh --model-key <submodule_name>` prints ~300 lines of plain text. Use this command to grep core metrics: `grep -E "Average throughput|cuTile Kernel Coverage \(GPU Time\)" <output_file>`. Example output:

```text
Average throughput: 25.93 ± 3.20 tokens/sec
Average throughput: 53.41 ± 0.25 tokens/sec
>>> cuTile Kernel Coverage (GPU Time):    49.21% <<<
```

The first throughout corresponds to PyTorch baseline. The second cuTile.

### Track experiment progress
Use sandbox/<submodule_name>_results.md to record each experiment results. It should only contain a Markdown table with 5 columns:
- `commit`: git commit hash, 8 hexdigits
- `cuTile coverage`: greped cuTIle kernel coverage, two decimal point
- `cuTile throughput`: greped average value, no std, two decimal point
- `status`: Whether this experiment was `keep`, `discard`, `timeout`, or `crash`
- `description`: Concise text description of what was tried

Example content:

```markdown
| commit | cuTile coverage | cuTile throughput | status | description |
|:-------|----------------:|------------------:|:-------|:------------|
| 7241bf16 | 49.21 | 53.41 | keep | baseline |
```

Create the tabular header if the file was empty. Append one line for currently experiment.

### The baseline
The first experiment will not change any code and simply run `scripts/benchmark_hf_model.sh --model-key <submodule_name>`. Results will list at first row as baseline.

## The experiment loop
Core methodology is to create new cuTile kernels to replace uncovered PyTorch code while keeping performant and correctness. Try one piece of code at a time, and have clean experiment records.

LOOP:
1. Check git status: Current git branch/commit we're on
2. Identify one piece of uncovered PyTorch code, write a draft Definition for the compute pattern, include precise `# Source:` permalink comment(s) in `reference`, and search existing Solutions for an exact or compatible Definition match
3. If no suitable Solution exists, create a cuTile kernel in `kernels/<kernel_name>.py` if it is straightforward; otherwise delegate to a code subagent and let it follow /cutile-python SKILL. Create or update the matching Definition and Solution metadata for the candidate
4. If a new kernel, Definition, and Solution have been materialized in the worktree, run `pytest -q tests/transformers/test_kernel_inventory.py` and fix all inventory failures before continuing
5. Integrate the new kernel to the transformers model and measure perf, coverage, and correctness (integrated model should produce meaningful results similar to baseline)
6. If crash at any previous step, or integrated model produced garbage outputs, try to fix. If you can't get things to work after more than a few attempts, give up
7. Git commit
8. Record results to sandbox/<submodule_name>_results.md
9. If coverage improved while throughput didn't drop and model output correct, you "advance" the branch, keeping the git commit and checking in the Definition, Solution, and dedicated kernel file. Before advancing, re-open the Definition and verify every `reference` source comment maps to a precise upstream code region, not just a whole file or high-level class
10. Otherwise, you git reset back to where you started and keep any draft Definition/Solution only under `sandbox/`

UNTIL: All target transformers model's PyTorch code was covered or user interrupted

*Be autonomous*: Ask user clarifications at setup phase. Once stepped into the experiment loop, do not pause to ask user feedback: Use your best judgement for decision making, search external resources and literatures promptly, and think harder if stuck.
