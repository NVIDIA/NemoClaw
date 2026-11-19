<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Formatting, Links, Lists, and Tables

Part of the [NVIDIA style guidelines](SKILL.md), which list the sources and the changes made to them.
Related: [Punctuation and Symbols](punctuation.md), [Capitalization](capitalization.md), [Technical Content](technical-content.md).

## Formatting

Use this table for consistent formatting across platforms.

| Item | Formatting | Example |
|---|---|---|
| Code elements, examples | Monospace | You can omit the final `apt-get install` command if you do not require the entire CUDA Toolkit. |
| Directories | Monospace | Surround any changeable variables with angle brackets: `/home/<username>/.login`. |
| Error messages | Quotation marks | If you see an error message such as "Invalid input value," the add-on was unable to generate a certificate with the provided information. |
| Expressions | Monospace | Ensure that `delay > 10` evaluates to `True`. |
| File names, paths | Monospace | Navigate to the `fields.conf` file. |
| Games | Italic | *Call of Duty* |
| Keyboard shortcuts | No formatting | Press Ctrl+Alt+Delete. |
| Links | Blue and underlined (no other formatting even if the link belongs to another category in this table) | [Audio Effects SDK Programming Guide](https://docs.nvidia.com/deeplearning/maxine/audio-effects-sdk/index.html) |
| List terms in term/def style | Bold | **Semaphores**: Useful message passing object to share information and synchronize across different CUDA kernels or between a CUDA kernel and a CPU thread. |
| Menu items | Bold | In the **Name** field, enter your name. |
| New terms | Italic | This programming model uses *system-allocated memory*, which refers to memory that is ultimately allocated by the operating system. |
| Publication titles | Italic | *Audio Effects SDK Programming Guide* |
| Strings | Quotation marks | For example, “hello” is a string containing a sequence of characters ‘h’, ‘e’, ‘l’, ‘l’, and ‘o’. |
| User input and actions | Bold | For the *Destination* field, enter **ca_counties**. |
| Variables within paths or directories | Greater than (>), less than symbols (<) (otherwise known as angle brackets) | Refer to the following example: `/home/<username>/.login`. |

## Links

Links are clickable elements that take users to other webpages or documents. There are four types of links:

- **Text links:** A broader term that includes inline links and links with more visual emphasis that are not part of a sentence.
- **Inline links:** Hyperlinked text embedded within a sentence or paragraph that takes users to another page or document.
- **Image links:** Hyperlinked images that take users to another webpage, file, or location
- **Bookmark links:** Hyperlinks that take users to a specific section within the same page or document, rather than to a different page. (Also called an anchor link or jump link.)

Here are the best link practices:

- Do not use URLs in running text. Instead, use links that match the destination title (webpage or article, for example), to the extent possible.
  - ✅ **Correct:** [Diffusion Models: A Comprehensive Survey of Methods and Applications](https://arxiv.org/abs/2209.00796)
  - ❌ **Incorrect:** https://arxiv.org/abs/2209.0079
- Avoid including links that will unnecessarily detract readers from the material at hand.
- If linking on a term followed by an acronym, include the acronym in the link.
  - ✅ **Correct:** [large language models (LLMs)](https://www.nvidia.com/en-us/glossary/large-language-models/)
  - ❌ **Incorrect:** [large language models](https://www.nvidia.com/en-us/glossary/large-language-models/) (LLMs)
- Avoid generic links, such as “here” and “read more.”
  - *(Technical Blog guide)* Embed the URL with anchor text that uses keywords. Ideally, the anchor text would be the title of the target URL, but it could also be related keywords used inline. Avoid using raw URLs and generic anchor text like “here,” “click here,” or “documentation.”
  - ✅ **Correct:** For more information, see the recent Unified Memory post.
  - ✅ **Correct:** It’s helpful to install the driver before creating your first project.
  - ❌ **Incorrect:** For more information, see the recent Unified Memory post here.
  - ❌ **Incorrect:** To install the driver, click here.
- It’s okay to link on one full short sentence, but avoid linking on long sentences or more than one sentence.
- Try to limit the number of inline links within one paragraph to prevent search engine optimization (SEO) ineffectiveness and poor readability.
- Use a forward slash and a repository name for GitHub links.
  - ✅ **Correct:** the [NVIDIA/NeMo](https://github.com/NVIDIA/NeMo) GitHub repo
  - ❌ **Incorrect:** the [GitHub repo](https://github.com/NVIDIA/NeMo)

## Lists

Lists organize information so that readers can scan content faster. Lists generally fall into the following categories: bulleted, definition, or numbered.

When you include lists in your content, consider these best practices:

- Introduce lists with a complete lead-in sentence.
- Lists must have more than one item.
- Lists can only have two levels.
  - The second level is called a sublist.
  - Sublists must have more than one item.
- Capitalize the first letter of every list item.
- If the list items are complete sentences, include end punctuation.
- Use parallel sentence construction in list items. For example, start all lists items with verbs or end all list items with punctuation.
- Avoid including links that move users away from a list of tasks.
  - If you must include a link, don't hyperlink the entire list item unless it's supertask information or a prerequisite.
- Use lists in tables sparingly.

See also [Tables](#tables).

### Bulleted lists

Use a bulleted list (also known as an unordered list) for a list in which the list item order isn't important, such as a list of options. Choose whether to alphabetize or otherwise apply a sort order to bulleted list items.

Bulleted lists must have the following qualities:

- A complete lead-in sentence punctuated by a colon
- More than one list item
- No more than two levels
- Parallel sentence construction: all list items lead with noun phrases, for example
- One sentence or idea for each list item
- End punctuation if the list items are complete sentences
- If list items begin with a term followed by a colon, capitalize the first word after the colon

Example of a bulleted list (refer to the previous list)

### Definition lists

Use a definition list to define a set of terms, descriptions, explanations, or associations. You can add a paragraph break after each definition if the formatting is tight.

Definition lists must have the following qualities:

- A complete lead-in sentence
- More than one defined term
- Up to two levels: the term, which is in bold unless it is a link, on its own line and the definition, which is at least one full sentence indented on its own line
- Parallel sentence construction
- One action for each list item
- End punctuation in every definition line

Example of a definition list:

> You might have heard of, or even be familiar with these technologies, but for the sake of completeness, here are the basics:
>
> **[Artificial intelligence](https://en.wikipedia.org/wiki/Artificial_intelligence) (AI)**\
> &nbsp;&nbsp;&nbsp;&nbsp;The broad discipline of creating intelligent machines that either match or exceed human-level cognitive abilities.
>
> **[Machine learning](https://en.wikipedia.org/wiki/Machine_learning) (ML)**\
> &nbsp;&nbsp;&nbsp;&nbsp;A subfield of AI that involves creating methods and systems that learn how to carry out specific tasks using past data.
>
> **[Deep learning](https://en.wikipedia.org/wiki/Deep_learning) (DL)**\
> &nbsp;&nbsp;&nbsp;&nbsp;A family of ML methods based on [artificial neural networks](https://en.wikipedia.org/wiki/Artificial_neural_network) with many layers and usually trained with massive amounts of data.

### Numbered lists

Use numbered lists (also known as ordered or task lists) when the order of the list items is important, such as sequential steps.

Numbered lists must have the following qualities:

- A complete lead-in sentence punctuated by a period or a colon
- More than one list item
- No more than two levels
- Parallel sentence construction
- One action for each list item
- End punctuation if the list items are complete sentences

Example of a numbered list:

> Of course, performance is pointless without good accuracy. We’ve developed a simple training workflow that can easily generate a 2:4 structured sparse network matching the accuracy of the dense network:
>
> 1. Start with a dense network. The goal is to start with a known-good model whose weights have converged to give useful results.
> 2. On the dense network, prune the weights to satisfy the 2:4 structured sparsity criteria. Out of every four elements, remove just two.
> 3. Repeat the original training procedure.

## Tables

Use tables for reference information, decision support, compatibility matrices, and choices that a user has.

Here are a few guidelines for working with tables in your content:

- In general, introduce tables with a full sentence and a colon and include a caption.
- Don't create a table with only one row.
- For headers, use title case.
- Avoid leaving table cells empty. If you need to keep a cell blank, use a nonbreaking space to make a cell appear blank.
- Avoid including links in tables, unless the purpose of the table is to help users find information.
- Use code samples sparingly in tables.
- Every table must have a title or caption.
