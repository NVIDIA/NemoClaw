<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Procedural CLI Documentation

Part of the [NVIDIA style guidelines](SKILL.md), which list the sources and the changes made to them.
Related: [Technical Content](technical-content.md), [Technical Documentation Writing Guide](technical-documentation.md), [Formatting, Links, Lists, and Tables](formatting.md).

*(Content Engineering guide: Guidelines for Procedural CLI Documentation)* This page provides the guidelines for style and document structure for writing procedural CLI documentation.
Its samples use the NGC CLI.
The source's guidance on the Sphinx `rubric` directive, for procedures in locations that do not support headings, is omitted.

## Topic Heading

Use the gerund form of a verb for the first word in the topic heading like the following examples:

- Configuring the CLI Output Format
- Building a Container
- Creating a Helm Chart for Your Application

## Procedure Prerequisites

If some condition must be met before a customer can begin a procedure, add a heading with the text “Prerequisites” and add a bulleted list of the conditions.
This is an optional section.

For example, you might indicate that a customer must be logged in to a private registry, and provide a link to that task, before starting a procedure that includes pushing a container to a private registry.

Prerequisites sample for Markdown:

~~~markdown
# Configuring the CLI Output Format

## Prerequisites

- You installed the CLI.
  For information about installing the CLI, refer to [some URL](http://www.example.com/cli).
...
~~~

## Procedure Steps

If the procedure steps have prerequisites, add a heading with the text “Procedure.”

In most cases, introduce the steps with a clause that begins with the infinitive form of a verb like “To build and share a container, perform the following steps:”

Use numbered steps unless the procedure is a single step.
For single-step procedures, use a bullet.

Whenever possible, begin each step with the imperative form of a verb such as “Build the container image.”
Depending on the prevailing style of the document, follow the action either with a single colon or with “by entering the following command:”

In most cases, follow the sample command in a step with output.
Add a paragraph with the words “Example Output” in italics and then add a code block with the example output.
Including the example output is helpful for workflows that require using the output from one command as the input to the command in the next step.
If the output is cluttered and a customer might find it difficult to locate the value to use, annotate the output with numbered callouts like `#1`, `#2`, and so on or replace some of the output with ellipses.
If you add numbered callouts, follow the example output with a numbered list that identifies the key information that a customer needs to complete the procedure.

Procedure sample for Markdown:

~~~~markdown
# Configuring the CLI Output Format

## Prerequisites
...

## Procedure

To configure the CLI output format, perform the following steps:

1. Configure the CLI by running the following command:

   ```console
   $ ngc config set
   ```

   The CLI prompts you for information such as your NGC API key, E-mail address, and so on.

   _Example Output_

   ```output
   Enter API key. Choices: [<VALID_APIKEY>, 'no-apikey']:
   Enter CLI output format type [ascii]. Choices: [ascii, csv, json]:
   Enter org [nv-eagledemo]. Choices: ['nv-eagledemo']:
   Enter team [nvtest-repro]. Choices: ['nvtest-repro, 'no-team']:
   Enter ace [nv-eagledemo-ace]. Choices: ['nv-eagledemo-ace', 'no-ace']:
   Successfully saved NGC configuration to C:\Users\jsmith\.ngc\config
   ```

1. Optional: Display your current CLI configuration:

   ```console
   $ ngc config current
   ```

   _Example Output_

   ```output
   +-------------+-----------------------------------------------------+--------------------+
   | key         | value                                               | source             |
   +-------------+-----------------------------------------------------+--------------------+
   | apikey      | *************************************************** | user settings file |
   |             | *****************************M2Iy                   |                    |
   | format_type | ascii                                               | user settings file |
   | org         | nvidian                                             | user settings file |
   | ace         | nv-us-west-2                                        | user settings file |
   +-------------+-----------------------------------------------------+--------------------+
   ```
~~~~

## Related Information

This section is optional.
If it is likely that customers need to adapt the sample commands in the procedure steps, consider adding a bulleted list of links to the syntax reference for each command that is used.

Related information sample for Markdown:

~~~markdown
# Configuring the CLI Output Format

## Prerequisites
...

## Procedure
...

## Related Information

- [ngc config](https://docs.ngc.nvidia.com/cli/cmd_config.html) command reference
~~~

## Syntax Reference Documents

Ideally, the syntax reference documentation is part of the same document as the primary user or administrator documentation.

A CLI syntax reference document describes each command and the required arguments and optional arguments for each command.
The purpose of syntax reference documentation is to provide customers with the information that they need to adapt sample commands in documentation into commands that are situation-specific or site-specific.

For example, a user or administrator guide might include a workflow with a command that shows how to list several types of hardware.
If the customer wants to know if the command can be adapted to list one type of hardware, the syntax reference should describe how to or help the customer recognize that listing one type of hardware is not possible.

## Source Material

- [Microsoft Style Guide: Writing step-by-step instructions](https://learn.microsoft.com/en-us/style-guide/procedures-instructions/writing-step-by-step-instructions)
- [Red Hat modular documentation: Creating procedure modules](https://redhat-documentation.github.io/modular-docs/#con-creating-procedure-modules_writing-mod-docs)
- IBM Style Guide
