<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Writing with AI

Part of the [NVIDIA style guidelines](SKILL.md), which list the sources and the changes made to them.
Related: [Technical Documentation Writing Guide](technical-documentation.md), [Technical Content](technical-content.md).

*(Content Engineering guide: General guidance on using AI in technical writing and editing)* The source addresses technical writers who use AI assistants.

Our primary responsibility as technical writers is to create new and original content.
While you should leverage all available AI tools, you remain accountable for writing and finalizing all new information.

AI tools can significantly boost your output and cut down on the time it takes to complete specific tasks.
However, even with these capabilities, human judgment, insight, and contextual decision-making are still essential for producing high-quality, original documentation.

## Using AI for Technical Writing

Use AI assistants for the following tasks.

### Mechanical Tasks

The following are examples of mechanical tasks that can be repetitive and time-consuming.
AI can reduce the time required to complete these tasks by more than half compared to what it would take if done manually without an AI assistant.

- Generating tables and lists.
- Converting between lists and tables.
- Converting markup languages from one language to another.
- Generating lists in a specific format.
- Converting a paragraph into a procedure as an ordered list.
- Generating docstrings.
- Generating descriptions for code samples and images.
- Replacing product names with expansion variables.
- Unifying formatting, such as a section structure that you need to apply across many doc pages and files.
- Achieving consistency across API/SDK documentation, such as descriptions for APIs, functions, and parameters.

### Generative Tasks

Prompts that ask AI to do more generative tasks might alter the meaning or context of the content.
This will be the case when you are working on revisions interactively with AI.
Always use your judgment and thoroughly review the generated content before accepting and applying the AI-generated suggestions, and further refine them with additional edits or prompts.
The following are some examples of more generative prompts.

- Generate an introduction or a summary of a page.
- Write a high-level concept section without code, based on the following detailed documentation.
- Rewrite in an active voice.
- Improve the following content.
- Run grammar and spell checks.
- Run style checks and make edits per the [NVIDIA style guidelines](SKILL.md).
- Create an initial draft when you have some existing yet scattered information. Be sure to provide sufficient context, including internal documents and code samples.

### More Technical Tasks

- Ask AI to generate a script to help automate specific tasks.
- Ask AI to take a first stab at creating a folder and file structure based on the instructions you provide.
- Use tool calling and MCP technologies to enhance the AI agents.

## What’s Not a Good Use of AI for Writing Technical Content

Do not use AI to generate large amounts of information with vague prompts or minimal context.
Without sufficient context, it can lead to hallucinations and plagiarism.
By leveraging the patterns it has learned in human language and programming languages, we utilize its ability to find patterns in our writing and code bases to assist in improving the content.
Writers are responsible for ensuring the originality, usability, and quality of the final content.
Providing ample context is important to help the AI assistant perform effectively and to control the output it generates.

## Best Practices for Writing with AI

1. **Prompt engineering is a skill.**
   Compose prompts for what you want to achieve.
   To standardize and achieve consistency in technical content, compose prompts using the [NVIDIA style guidelines](SKILL.md).
   Best practices for prompt engineering are covered in the following resources:
   - [Prompt engineering best practices](https://claude.com/blog/best-practices-for-prompt-engineering) blog from Anthropic, with the [prompt engineering documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview) in the Claude Docs website for a deeper dive, and the newer concept of [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) on the Anthropic Engineering website.
   - [Best practices for prompt engineering](https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api) from OpenAI.
2. **Run revisions iteratively with an AI assistant.**
   Iterative prompt techniques, such as multi-shot learning, prompting with context, iterative prompts, and chain of thoughts, improve the output.
   Don’t stop at the first shot; prompt a few more times with follow-up prompts.
   Longer prompts with too many instructions might not always work.
   The output from LLMs improves after a few attempts with follow-up prompts.
3. **Learn about the tools and select the most suitable option for your task.**
   When using web applications such as PerfLab Chat, NVChat, and Gemini, compose prompts with instructions first, and then provide the content you want to revise and improve.
   Working on long content broken down into several chunks might also be a good strategy, and it can outperform dropping in lengthy content.
   Additionally, several iterations of shorter prompts can help AI generate content that is closer to what we want.
   The Cursor IDE supports tools that read across multiple files or the entire codebase, using them as context, and writing to folders and files.
   Cursor also supports rules to set up various system messages.
   You may iterate several times until you get the desired output.
4. **Keep prompts straight and concise, with everything you want to achieve.**
   Be direct when you provide prompts.
   You don’t need to add extra words, such as “please” or “would you.”
   Break down the instructions in a prompt into clear and concise sentences or as a list of instructions.
5. **Use its ability to read patterns fully.**
   LLMs are trained to learn the patterns in human languages and programming languages.
   When the output does not seem to meet your expectations, provide a short example.
   LLMs catch the pattern from the example and generate improved outputs.
   This is useful when you need to maintain multiple pages with similar content, such as API references, tables, or lists of parameters, or user guides that should follow similar patterns in titling, sectioning, and introducing sentences or paragraphs.
6. **Maintain a human touch.**
   Technical writing often requires a nuanced understanding of the subject matter and the audience.
   While AI can assist in many ways, it's important to maintain a human touch to ensure that the content is original, engaging, and relevant.
7. **Understand the limitations.**
   While AI tools can be incredibly helpful, they are not infallible.
   It's essential to understand their limitations and not rely solely on them for critical tasks.
   AI runs based on probability, so it can always misplace words and phrases.
   With little to no context in prompts, system messages, or reference materials (RAG), AI relies solely on its training dataset.
   The output can be misleading due to hallucinations.
   Human oversight is crucial to ensure the accuracy and quality of the content.

## Agent-Assisted Authoring Loop

*(Content Engineering guide: Template Library and Skill Library)* The authoring process is a guided generation-and-validation loop.
Agents can draft and revise, but the writer steers source interpretation, human guardrails, review readiness, and publishing quality:

1. **Scope and plan:** While the agents validate the code to identify any gaps, writers review any existing product requirement documents and documentation request tickets to gather the necessary source material.
2. **Generate a draft:** Agents author the documentation changes based on the available source material, repository maps, and skills.
3. **Submit a merge request for the documentation changes:** Either the agent or writer commits the merge request and triggers the validation checks in the corresponding Git platform, such as GitLab.
4. **Validate the documentation changes:** Skills, hooks, and bots such as CodeRabbit flag issues before the documentation changes are published.
5. **Manage the guardrails:** Writers incorporate additional documentation updates with the agent’s assistance based on the feedback that the subject matter experts (SMEs) have provided.
6. **Preview and publish:** Writers preview and output the documentation changes to HTML using tools such as Fern.
7. **Observe patterns:** Repeated findings become maps, hooks, templates, and skills for agents and writers to notate as learnings for future documentation updates.

Evidence-based audits support this loop: they extract the claims a page makes, search the source files, and return confidence-scored findings with file references, so documentation claims can be checked against code, configuration, APIs, CLI behavior, and tests.
