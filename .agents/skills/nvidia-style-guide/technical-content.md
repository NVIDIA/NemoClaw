<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Technical Content

Part of the [NVIDIA style guidelines](SKILL.md), which list the sources and the changes made to them.
Related: [Technical Documentation Writing Guide](technical-documentation.md), [Formatting, Links, Lists, and Tables](formatting.md), [Voice, Tone, and Accessibility](voice-and-tone.md).

Technical content is usually more complex than marketing content. This section details some of the ways that technical content differs from the main NVIDIA Writing Guide or describes elements that non-technical content does not usually contain.

Individual teams might have style guides specific to an authoring environment or role.

- **Technical Blog:** NVIDIA Technical Blog Writing and Style Guide (available externally); its writing guidance is included in this section and marked *(Technical Blog guide)*
- **Software Documentation:** Technical Documentation Writing Guide; its conventions are included as [Technical documentation conventions](SKILL.md#technical-documentation-conventions), and the rest of the guide is in [technical-documentation.md](technical-documentation.md)

The Technical Blog guide also recommends [Common Errors in Technical Writing](http://www.ece.ucdavis.edu/~jowens/commonerrors.html) and [Get It Write](https://getitwriteonline.com/blog/).

## API reference comments

*(Content Engineering guide: Doxygen API Documentation Guidelines)* Apply the following edits to API reference comments in source files.
The source states them for Doxygen comments in C and C++ header files.

Level 1 edits:

- Copyright information must be present.
- Trademarks and copyright for products and platforms must be included.
- Basic grammar (for example, articles and avoiding passive voice), spelling, and punctuation (a period ending every sentence).
- Capitalize acronyms.
- Formatting:
  - Leave a blank line between the brief description, the parameters, and the return value (`\brief`, `\param`, and `\return` in Doxygen).
  - Put return values in a list format.

Level 2 edits:

- Correct references: reference the first mention within a function or struct; do not reference subsequent instances.
- Format parameter references consistently; Doxygen uses the `@a` tag.
- Apply a consistent return value pattern across all functions within a single header file, and across all headers under the same grouping.
- Use terminology consistently.

## Code elements or examples

Code elements can be referenced within a sentence or longer code examples given separately. Introduce code examples with full sentences. Avoid using the term *snippet*. Inline references to methods may remove empty parentheses.

Use a monospace font and syntax highlighting.

*(Technical Blog guide)* Avoid any fancy formatting of your code, such as background color or borders, and get the spacing right.

## Equations and formulas

Use LaTeX or MathML for math equations, whether it’s inline or on a separate line.

## Figures and images

*(Technical Blog guide)*

Posts with compelling and informative images maintain reader interest. Early in your writing process, think about what images and diagrams you can include.

Each image should have a caption, and you should usually call out images from the body of the post to give them context. When you refer to images in the body of the post, refer to them by figure number ("Figure 1 shows...") and not by location ("The following figure shows...").

Images are numbered sequentially, using “*Figure X.*” Videos and tables are labeled and numbered separately (*Video 1.*, *Table 1.*). For example, a caption and its alt text:

> *Figure 1. Tensor data layout with extents and blocks. Green is the two-dimensional tensor, and blue shows the blocks that the block size induces.*
>
> ALT text: Image shows a 3x3 square that shows block size compared to extent. Block size accounts for a 1x1 block whereas extent is a large square layered on top of several blocks but does not exceed the full parameter of the 3x3 square.

- If you want multiple images aligned side-by-side, combine them into a single high-resolution image.
- JPEG format is usually best for photos, but PNG is best for images with large areas of constant colors, or images with transparency.
- Don't start the post with an image immediately following the title. Try to put at least a few lines of text first.

## File name extensions

- Use a period and lower case when referring to a file name extension. Example: a .tgz file
- Use upper case and no period when referring to the type of file. Example: a TGZ file

## Footnotes

Use your team-specific guidelines. In the absence of specific guidelines for your content platform, use sparingly except in research papers. For more casual content platforms (like the Technical Blog), integrate the information into the body of the text as appropriate.

## GitHub repositories

Use a forward slash and a repository name for GitHub links.

- ✅ **Correct:** the [NVIDIA/NeMo](https://github.com/NVIDIA/NeMo) GitHub repo
- ❌ **Incorrect:** the [GitHub repo](https://github.com/NVIDIA/NeMo)

## Headings

*(Technical Blog guide)*

- Reserve H1 for the title, for SEO reasons.
- Use only H2, H3, and H4 subheading levels.
- Avoid starting the post with a title and subheading, or stacking two subheadings.
- Avoid custom fonts or formatting (bold or italic) in headings.

## Leading sentences

Code examples, lists, tables, and images are not a part of speech. End your sentence beforehand instead of using them to continue the sentence.

✅ **Correct:**

The following code example shows to implement the function using `sqrt`:

```c
double myFunc() { return sqrt(2.0); }
```

❌ **Incorrect:**

We implement our function as

```c
double myFunc() { return sqrt(2.0); }
```

which uses the `sqrt()` function.

*(Technical Blog guide)* The same applies to images:

- ✅ **Correct:** Figure 3 shows basic ray tracing concepts.
- ❌ **Incorrect:** The following figure shows basic ray tracing concepts:

Imagine a screen reader reading your post out loud to a person with visual disability. Ending your sentence with a colon and an image is confusing.

## Marketing claims

Avoid flowery language or comparisons with third-party products.

- ✅ **Correct:** NVIDIA today announced it has updated their accelerated computing platform with the introduction of the NVIDIA HGX™ H200 GPU.
- ❌ **Incorrect:** NVIDIA today announced it has supercharged the world’s leading AI computing platform with the introduction of the NVIDIA HGX™ H200.

## Model names

For consistency, follow NVIDIA naming conventions for [NVIDIA models](https://build.nvidia.com/explore/discover) and third-party naming conventions for other models where appropriate. Include the company name and qualifier on first use.

- ✅ **Correct:** the Microsoft Kosmos-2 model
- ✅ **Correct:** the NVIDIA Nemotron-3-8B-QA-4k model, Nemotron-3 family
- ❌ **Incorrect:** Kosmos, NeMoTron-3

## Procedures

Technical content often offers consecutive steps that must be followed to complete one or more tasks.

- **Numbering:** Numbering steps is optional, especially when steps will be separated by code blocks, images, or supplemental information.
  - When using numbered steps, keep the total number of steps under 5-7 for readability.
- **Subtasks:** Break up long procedures or nested steps into smaller tasks.
- **Navigation:** Use subheadings to separate procedures.
- **Addressing the reader:** Use primarily imperative sentences ("Do this. Next, do that."), with declarative sentences as needed for explanation ("You can choose option A.").

For the structure of procedural CLI documentation, including prerequisites, steps, example output, and related information, refer to [Procedural CLI Documentation](cli-procedures.md).

## Readability

Aim for sentences of fewer than 30 words wherever possible.

*(Technical Blog guide)* Make sentences direct to avoid unnecessary words.

- ✅ **Correct:** CUDA 6 introduces Unified Memory, which dramatically simplifies memory management for GPU computing.
- ❌ **Incorrect:** With CUDA 6, we have introduced the Unified Memory programming model, which provides a simplified method of dealing with memory allocations between CPU and GPU.

Whenever possible, use verbs rather than nouns to help move the action along. Noun phrases are more difficult to process, and they usually add unnecessary words. For example:

- Give a presentation → Present
- Take measurements → Measure
- Achieve resolution → Resolve
- Perform an analysis → Analyze
- Conduct inspections → Inspect

Use academic or formal conjunctive adverbs sparingly:

- Additionally
- Consequently
- Furthermore
- Hence
- Moreover
- Thus
- Undoubtedly
- Whilst

## Synonyms

For clarity, use the same term throughout a piece of technical writing. Include synonyms only to connect industry-standard terms with NVIDIA-specific or more relevant terms.

## Tone and voice

*(Technical Blog guide)*

The NVIDIA Technical Blog targets developers and IT professionals at various skill levels, including scientists (computer and otherwise), software engineers, students, researchers, and academics. Posts should be friendly and accessible while still being deeply technical.

- Use first person for your recommendations or experiences ("I did this" rather than "This is/was done")—readers relate to this more easily.
  - Avoid using first person plural to include the reader, as they may see it as condescending.
  - If there are multiple authors, then by all means, use “we” to describe what you did.
- Include relevant personal anecdotes and experience where appropriate.
- Avoid jargon that only specialists are likely to understand.
- Explain new terms as you introduce them.
- Don't be afraid to get really technical. Include code excerpts (with appropriate GitHub links), equations, pseudocode, and especially informative diagrams.
- Write for a global audience.

Readers relate well to real-world examples, so don’t be afraid to include them.

The best way to avoid confusing content is to be direct, active, and concise. For conciseness, see [Readability](#readability).

### Address readers directly

Use the imperative form of verbs or use second person (you) to address readers.

- ✅ **Correct:** When you port…
- ✅ **Correct:** Next, download the container.
- ❌ **Incorrect:** When we port a container…
- ❌ **Incorrect:** Next, developers can download the container.

### Use active voice

Use active voice because passive voice reduces clarity and directness in writing.

- ✅ **Correct:** Reduce use of 'to be' to avoid passive voice.
- ✅ **Correct:** We used OpenACC to accelerate…
- ❌ **Incorrect:** Passive voice can be avoided by reducing the use of 'to be'.
- ❌ **Incorrect:** …*was accelerated* using OpenACC.

However, passive voice can be useful at times. Don't go out of your way to avoid it if doing so doesn't simplify or clarify your writing. [This UNC guide covers it well](https://writingcenter.unc.edu/handouts/passive-voice/).

### Avoid the corporate “we”

Frequent use of the editorial or corporate “we” creates a barrier between you and the reader. This feels like an us vs. them dynamic instead of including the reader in a conversation.

Use ‘we’ to refer to multiple authors or on behalf of a specific team making a product or feature announcement.

## UI text

Use bold text when referencing the user interface (UI):

- Buttons
- Menus
- Field labels

When referring to multiple UI elements in a process, use angle brackets (>) to indicate consecutive steps.

For the term and verb to use with each kind of UI element, refer to [UI Elements and Interactions](ui-elements.md).

For more information about guidelines for UI strings, refer to the [Describing UI Interactions](https://learn.microsoft.com/en-us/style-guide/procedures-instructions/describing-interactions-with-ui) and [Formatting Text in Instructions](https://learn.microsoft.com/en-us/style-guide/procedures-instructions/formatting-text-in-instructions) topics in the Microsoft Style Guide.
