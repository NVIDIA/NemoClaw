## Description: <br>
Integrate a HuggingFace Computer Vision model into the NVIDIA TAO Toolkit ecosystem (tao-core config, tao-pytorch trainer, tao-deploy TensorRT pipeline). <br>

This skill is ready for commercial/non-commercial use. <br>

## Owner
NVIDIA <br>

### License/Terms of Use: <br>
Apache 2.0 <br>
## Use Case: <br>
Developers and ML engineers who need to integrate HuggingFace Computer Vision models into the NVIDIA TAO Toolkit for training, ONNX export, and TensorRT deployment. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: Review before execution as proposals could introduce incorrect or misleading guidance into skills. <br>
Mitigation: Review and scan skill before deployment. <br>

## Reference(s): <br>
- [Phase 0 - Prerequisites](references/phase-0-prereqs.md) <br>
- [Phase 1 - HF Inspection](references/phase-1-inspection.md) <br>
- [Phase 2 - Codebase Exploration](references/phase-2-codebase.md) <br>
- [Phase 3 - Implementation](references/phase-3-implementation.md) <br>
- [Phase 4 - Deploy](references/phase-4-deploy.md) <br>
- [Phase 5 - Packaging](references/phase-5-packaging.md) <br>
- [Phase 6 - Container Tests](references/phase-6-container-tests.md) <br>
- [Phase 7 - Optimization](references/phase-7-optimization.md) <br>
- [TAO Patterns](references/tao-patterns.md) <br>
- [Repo Structure](references/repo-structure.md) <br>
- [Task Type Guide](references/task-type-guide.md) <br>
- [Execution and Debugging](references/execution-and-debugging.md) <br>
- [Docker Patterns](references/docker-patterns.md) <br>
- [HF Inspection Patterns](references/hf-inspection.md) <br>
- [Workflow Consistency](references/workflow-consistency.md) <br>


## Skill Output: <br>
**Output Type(s):** [Code, Files, Shell commands, Configuration instructions] <br>
**Output Format:** [Python source files, YAML configuration, and Markdown with inline bash code blocks] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [None] <br>

## Evaluation Agents Used: <br>
- Claude Code (`claude-code`) <br>
- Codex (`codex`) <br>



## Evaluation Tasks: <br>
Evaluated against 1 evaluation task with 2 attempts per task in the astra-sandbox environment using the external NVSkills-Eval profile. Pass threshold: 50%. <br>

## Evaluation Metrics Used: <br>
Reported benchmark dimensions: <br>
- Security: Checks whether skill-assisted execution avoids unsafe behavior such as secret leakage, destructive commands, or unauthorized access. <br>
- Correctness: Checks whether the agent follows the expected workflow and produces the correct final output. <br>
- Discoverability: Checks whether the agent loads the skill when relevant and avoids using it when irrelevant. <br>
- Effectiveness: Checks whether the agent performs measurably better with the skill than without it. <br>
- Efficiency: Checks whether the agent uses fewer tokens and avoids redundant work. <br>

Underlying evaluation signals used in this run: <br>
- `security`: Checks for unsafe operations, secret leakage, and unauthorized access. <br>
- `skill_execution`: Verifies that the agent loaded the expected skill and workflow. <br>
- `skill_efficiency`: Checks routing quality, decoy avoidance, and redundant tool usage. <br>
- `accuracy`: Grades final-answer correctness against the reference answer. <br>
- `goal_accuracy`: Checks whether the overall user task completed successfully. <br>
- `behavior_check`: Verifies expected behavior steps, including safety expectations. <br>
- `token_efficiency`: Compares token usage with and without the skill. <br>



## Evaluation Results: <br>
| Dimension | Num | `claude-code` | `codex` |
|---|---:|---:|---:|
| Security | 2 | 100% (+0%) | 100% (+0%) |
| Correctness | 2 | 50% (+50%) | 97% (+97%) |
| Discoverability | 2 | 0% (+0%) | 84% (+84%) |
| Effectiveness | 2 | 91% (+77%) | 81% (+71%) |
| Efficiency | 2 | 27% (-0%) | 79% (+50%) |

## Skill Version(s): <br>
0.1.0 (source: frontmatter) <br>

## Ethical Considerations: <br>
NVIDIA believes Trustworthy AI is a shared responsibility and we have established policies and practices to enable development for a wide array of AI applications. When downloaded or used in accordance with our terms of service, developers should work with their internal team to ensure this skill meets requirements for the relevant industry and use case and addresses unforeseen product misuse. <br>

(For Release on NVIDIA Platforms Only) <br>
Please report quality, risk, security vulnerabilities or NVIDIA AI Concerns [here](https://app.intigriti.com/programs/nvidia/nvidiavdp/detail). <br>
