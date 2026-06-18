## Description: <br>
Use this skill to bring any vision model from HuggingFace or NVIDIA NGC into an NVIDIA DeepStream pipeline with end-to-end automation: ONNX download, SafeTensors export, TRT engine build, custom nvinfer bbox parser, multi-stream benchmark, and PDF report. <br>

This skill is ready for commercial/non-commercial use. <br>

## Owner
NVIDIA <br>

### License/Terms of Use: <br>
CC-BY-4.0 AND Apache-2.0 <br>
## Use Case: <br>
Developers and engineers who need to import vision models from HuggingFace or NVIDIA NGC into NVIDIA DeepStream pipelines for object detection, including automated engine building, benchmarking, and performance report generation. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: Review before execution as proposals could introduce incorrect or misleading guidance into skills. <br>
Mitigation: Review and scan skill before deployment. <br>

## Reference(s): <br>
- [engine-build.md](references/engine-build.md) <br>
- [model-acquire.md](references/model-acquire.md) <br>
- [pipeline-run.md](references/pipeline-run.md) <br>
- [report-generation.md](references/report-generation.md) <br>
- [NVIDIA DeepStream SDK](https://developer.nvidia.com/deepstream-sdk) <br>
- [NVIDIA NGC DeepStream Container](https://catalog.ngc.nvidia.com/orgs/nvidia/containers/deepstream) <br>


## Skill Output: <br>
**Output Type(s):** [Shell commands, Configuration files, Code, Files] <br>
**Output Format:** [Markdown with inline bash code blocks] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Generates TensorRT engines, nvinfer configs, custom bbox parser C++ source, benchmark logs, and PDF reports] <br>

## Evaluation Agents Used: <br>
- Claude Code (`claude-code`) <br>
- Codex (`codex`) <br>



## Evaluation Tasks: <br>
Evaluated against 5 evaluation tasks (3 positive skill-activation, 2 negative) with 2 attempts per task via NVSkills-Eval external profile. <br>

## Evaluation Metrics Used: <br>
Reported benchmark dimensions: <br>
- Security: Checks whether skill-assisted execution avoids unsafe behavior such as secret leakage, destructive commands, or unauthorized access. <br>
- Correctness: Checks whether the agent follows the expected workflow and produces the correct final output. <br>
- Discoverability: Checks whether the agent loads the skill when relevant and avoids using it when irrelevant. <br>
- Effectiveness: Checks whether the agent performs measurably better with the skill than without it. <br>
- Efficiency: Checks whether the agent uses fewer tokens and avoids redundant work. <br>

Underlying evaluation signals used in this run: <br>
- `skill_execution`: Verifies that the agent loaded the expected skill and workflow. <br>
- `skill_efficiency`: Checks routing quality, decoy avoidance, and redundant tool usage. <br>
- `accuracy`: Grades final-answer correctness against the reference answer. <br>
- `goal_accuracy`: Checks whether the overall user task completed successfully. <br>
- `behavior_check`: Verifies expected behavior steps, including safety expectations. <br>
- `token_efficiency`: Compares token usage with and without the skill. <br>



## Evaluation Results: <br>
| Dimension | Num | `claude-code` | `codex` |
|---|---:|---:|---:|
| Security | 8 | 68% (+13%) | 72% (+18%) |
| Correctness | 8 | 83% (-2%) | 89% (+13%) |
| Discoverability | 8 | 61% (+0%) | 80% (+1%) |
| Effectiveness | 8 | 80% (+2%) | 81% (+17%) |
| Efficiency | 8 | 52% (+2%) | 70% (+2%) |

## Skill Version(s): <br>
1.2.1 (source: frontmatter) <br>

## Ethical Considerations: <br>
NVIDIA believes Trustworthy AI is a shared responsibility and we have established policies and practices to enable development for a wide array of AI applications. When downloaded or used in accordance with our terms of service, developers should work with their internal team to ensure this skill meets requirements for the relevant industry and use case and addresses unforeseen product misuse. <br>

(For Release on NVIDIA Platforms Only) <br>
Please report quality, risk, security vulnerabilities or NVIDIA AI Concerns [here](https://app.intigriti.com/programs/nvidia/nvidiavdp/detail). <br>
