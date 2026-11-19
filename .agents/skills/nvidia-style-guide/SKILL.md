---
name: nvidia-style-guide
description: NVIDIA's house style for voice and tone, capitalization, punctuation, numbers, dates, units, links, lists, tables, trademarks, and technical content. Use when writing or reviewing prose that WRITING.md covers.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NVIDIA Style Guidelines

Adapted from the [NVIDIA Style Guidelines](https://nvidia.sharepoint.com/sites/NVIDIAStyleGuide/SitePages/NVIDIA-Style-Guidelines.aspx) SharePoint page, last modified 2026-09-16 and retrieved 2026-11-19.
Changes from the source: converted to Markdown, with hyperlinks taken from the rendered page; text in the page's three images (the Voice and Tone comparison, the PACE table, and the annotated headings diagram) transcribed and marked as such; monospace applied to code-like examples in the Formatting table and punctuation examples, following the page's own rules.
The wording is otherwise the source's.
[WRITING.md](../../../WRITING.md) adds the rules specific to this repository.

## At-a-Glance

- Always spell NVIDIA in all caps.
- Write copy with PACE (Professional, Active, Conversational, Engaging) as a guideline.

It's essential that our voice is consistent and unified across our brand communications, but it’s also important we sound natural. We are, after all, human, and so is our audience.

The words we choose and the tone we adopt give our audience an immediate impression of who we are. Using a consistent voice to engage with our audience builds trust in the NVIDIA brand.

## Table of Contents

- [What’s New](#whats-new)
- [Resources](#resources)
- [Voice and Tone](#voice-and-tone)
- [Write with PACE](#write-with-pace)
- [Topics A-Z](#topics-a-z)
  - [Abbreviations and Acronyms](#abbreviations-and-acronyms)
  - [Accessibility](#accessibility)
  - [Active vs. Passive Voice](#active-vs-passive-voice)
  - [Capitalization](#capitalization)
  - [Contractions](#contractions)
  - [Dates and Time](#dates-and-time)
  - [Formatting](#formatting)
  - [Inclusivity](#inclusivity)
  - [Latinisms](#latinisms)
  - [Legal](#legal)
  - [Links](#links)
  - [Lists](#lists)
  - [Names](#names)
  - [Numbers](#numbers)
  - [NVIDIA](#nvidia)
  - [Plain English](#plain-english)
  - [Product names](#product-names)
  - [Punctuation](#punctuation)
  - [SEO](#seo)
  - [Social Media](#social-media)
  - [Symbols](#symbols)
  - [Tables](#tables)
  - [Titles](#titles)
  - [Technical Content](#technical-content)
    - [Code elements or examples](#code-elements-or-examples)
    - [Equations and formulas](#equations-and-formulas)
    - [File name extensions](#file-name-extensions)
    - [Footnotes](#footnotes)
    - [GitHub repositories](#github-repositories)
    - [Leading sentences](#leading-sentences)
    - [Marketing claims](#marketing-claims)
    - [Model names](#model-names)
    - [Procedures](#procedures)
    - [Readability](#readability)
    - [Synonyms](#synonyms)
    - [UI text](#ui-text)
  - [Trademarks](#trademarks)
  - [Units of Measurement](#units-of-measurement)

## What’s New

**April 2025:** Reordered sections alphabetically and revised extensively. New sections:

- Accessibility
- Contractions
- Formatting
- Inclusivity
- Latinisms
- Links
- Numbers
- Plain English
- SEO
- Social Media
- Technical Content
- Titles
- Trademarks
- Units of Measurement

Sections merged with others: And vs. Ampersand (&), E.g. vs. Ex., Job Titles, Miscellaneous

## Resources

Our house style is outlined here to help guide you. For anything not already covered, use the following resources in priority order:

1. **Spelling, parts of speech:** [Merriam-Webster online dictionary](https://www.merriam-webster.com/)
2. **Grammar, abbreviations, punctuation, and other language issues for enterprise content:** AP Stylebook
3. **Grammar, abbreviations, punctuation, and other language issues for technical content:** Chicago Manual of Style
4. **Technical terms, UI formatting, and other issues:** [Microsoft Style Guide](https://learn.microsoft.com/en-us/style-guide)

Formal industry standards should be followed as appropriate, for example, the [International System of Units](https://en.wikipedia.org/wiki/International_System_of_Units#General_rules).

Teams might have guidelines and best practices for their own authoring environments, publication processes, roles, or platforms.

- **Corporate Blog:** [Style Guide: NVIDIA Blog](https://docs.google.com/document/d/1ZRaFGCd94bMl35OhowSC7CYhtWDQZyDGiOQoyK6d6V8/edit?usp=sharing)
- **Technical Blog:** [NVIDIA Technical Blog Writing and Style Guide](https://docs.google.com/document/d/19D30i6V4QtMySrqItVc0BB_HhRf6LW_aLBPDuKGlrEY/edit) (available to external authors)
- **Software Documentation:** [Technical Documentation Writing Guide](https://confluence.nvidia.com/display/SWDOCS/Technical+Documentation+Writing+Guide)
- **Hardware Documentation:** [NVIDIA Style Guide for Technical Publication](https://nvidia.sharepoint.com/sites/nvinfo/brand/Documents/NVIDIA-Style-Guide-Technical-Publication.pdf)

NVIDIA has access to the following tools for content quality checking, each of which uses the NVIDIA terminology list:

- **Writer.com:** Integrations for Microsoft Office products and a browser app.
- **Vale ([Z Redeaux](mailto:zredeaux@nvidia.com)):** Open-source linter in a GitHub repo for command-line use or scripting.
- **Cursor AI ([Z Redeaux](mailto:zredeaux@nvidia.com)):** Creates and edits markdown files with AI assistance.

## Voice and Tone

We use straightforward language and a natural, conversational voice when writing copy. We speak directly and clearly, with respect for our audience’s intelligence.

Use active, present-tense language and contractions like “it’s” rather than “it is” to increase the conversational tone.

Remember, our audiences are always asking themselves: what’s in it for me? Communicate persuasively and demonstrate that we understand their unique challenges and perspectives. And lead them to the appropriate action—whether it’s to buy or to get more information.

In general, follow these main style guidelines:

- Keep words and sentences simple.
- Use an active voice and plain language.
- Make it easy for readers to scan the main points.
- Be bold, brief, and clear. If you can leave a word out, leave it out. If you can use a simpler word, use the simpler word.
- Use more periods. Period.
- No swearing, blasphemy, profanity, threats, or insults—ever.
- Consider your word choice and how it affects tone. For instance, using the word “leverage” as a synonym for “use” could sound pretentious.

*(Transcribed from an image on the page.)*

| More Like This | Less Like This |
|---|---|
| Conversational | Complicated |
| Aspirational | Grandiose |
| Confident | Arrogant |
| Clever | Silly |
| Intelligent | Condescending |

| Along These Lines | Not Like This |
|---|---|
| Take your next design to the edge with 16GB of memory, up to 21 TOPS at 15W, and a rich set of AI tools—all in a compact form factor that’s smaller than a credit card. | 16GB of memory, 14 TOPS at 10W or 21 TOPS at 15W, a small form factor, and a rich set of AI tools give developers edge performance that destroys the “competition”. |

If you're unsure about something, try saying it out loud to the person next to you. If it's not how you would speak in real life, it's not how we say it at NVIDIA.

We’re serious. Actually try this.

It’s tough to gauge or judge tone and voice, but it helps to remember the following:

- **Our voice** is the steady personality seen throughout all touchpoints of our communication. It’s the sum of the whole, so no one line or one image has to convey it all, but together with other visual and copy elements, it completes the picture.
- **Our tone** is the varying moods and attitudes we convey depending on the subject matter, product, or type of communication. Consider, for example, the channel, medium, and audience you’re writing for, and adjust accordingly.

## Write with PACE

Besides implying energy and rhythm, PACE can serve as a useful acronym prompt for all your writing.

*(Transcribed from an image on the page.)*

| | | |
|---|---|---|
| **P** | **Professional** | NVIDIA is experienced, credible, and proven experts in everything we do. |
| **A** | **Active** | Use verbs in your copy (e.g. discover, game, create), not passive phrases. |
| **C** | **Conversational** | Write to your audience like you would talk to them—clearly and naturally. |
| **E** | **Engaging** | Make it exciting and personal (e.g. you vs. gamers) and provide clear direction about how they can take the next step. |

## Topics A-Z

When maintaining a unified brand, the little things really do matter: spelling, punctuation, capitalization, and more.

A mishmash of styles can make our brand look disorganized and sloppy.

### Abbreviations and Acronyms

- Do not abbreviate on first use in text (as a rule). Follow the abbreviation within parentheses, as in “high-resolution anti-aliasing (HRAA).”
- In subsequent usage, use the abbreviation or acronym unless the document is long and the reader must be reminded.
- Common abbreviations and acronyms (such as PC) that are widely used don’t need to be spelled out. For a list of acronyms, refer to Appendix A in the [*NVIDIA Style Guide for Technical Publications*](https://nvidia.sharepoint.com/sites/nvinfo/brand/Documents/NVIDIA-Style-Guide-Technical-Publication.pdf).
- **Plural form:** Add an s, but no apostrophe (such as GPUs).
- **Within headings:** When you use a common acronym in a title, don’t spell it out. Spell it in the body copy in the first or second sentence, and use the acronym in parentheses.

### Accessibility

The [Web Content Accessibility Guidelines](https://www.w3.org/WAI/standards-guidelines/wcag/) (WCAG) provide international standards for making web content more accessible to people with disabilities. Common practices include:

- Descriptive alt text for images and buttons
- Descriptive anchor text for links
- Correct color contrast between background and foreground colors (minimum recommended contrast ratio is 4.5:1)
- Shorter sentences and paragraphs
- Proper HTML heading structures
- Even spacing between text

### Active vs. Passive Voice

Use the active voice whenever possible, stressing who or what is performing an action.

Avoid using the passive voice unless the subject is unknown or when the action—rather than the doer—needs emphasis. The passive voice is also acceptable in programmer documentation.

### Capitalization

These guidelines apply to all areas of NVIDIA except GeForce, which can vary. Contact the senior GeForce copywriter over Slack with any questions.

For guidance on media or professional titles, refer to [Titles](https://docs.google.com/document/d/1FwioYaRjvuHd8reo2q2XQnNuzcoYWuAHi63qWzXBH2U/edit#heading=h.bjvqnrr7qzb0).

In general, follow standard guidelines for capitalization at the beginning of sentences, names and proper nouns, time zones, full quotes, and time periods. Avoid capitalizing compound words and seasons. For more information, refer to [Capitalization](https://confluence.nvidia.com/display/SWDOCS/Capitalization).

*(Transcribed from an image on the page: an annotated screenshot of an NVIDIA “Solutions for the Data Center” web page with numbered callouts identifying each type of heading.)*

1. Heading (also called Headline or Title)
2. Subhead (also known as Subheading or Subtitle)
3. CTA Button
4. In-Page Navigation Items
5. Section Heading (also called Section Title)
6. Content Heading
7. CTA Button
8. Tab Headings (also known as Tab Labels)
9. *(No label is given for callout 9 in the image; it points to the hero image.)*

#### Headings and subheadings

This includes headlines, page titles, section headings, category headings, table headings, tab headings, and document titles.

Capitalization varies with the particular style used on the content platform, title case or sentence case, AP Style or CMOS. When in doubt, use the [Headline Capitalization tool](https://headlinecapitalization.com/) to check that capitalization rules are properly applied.

Avoid using quotes (“example”), inverted commas (‘example’), ampersands (&), and exclamation marks (!).

#### CTA Button

CTAs are written in title case (Learn More, Register Now, Read Blog, and so on) and "Labels" (Features, Benefits, Resources, Tips and Tricks, and so on) should be written in title case with no punctuation.

#### Compound Words

When writing titles in mixed or title case, always capitalize the second word in a compound word that’s part of a title. Example: NVIDIA Multi-Display Technology.

#### Conjunctions

When writing in mixed or title case, do not capitalize conjunctions (and, as, but).

#### Footers

Use title case.

#### Industries

Don’t capitalize the names of industries. Do capitalize as abbreviations. Example: media and entertainment compared to M&E.

#### Prepositions

When writing in mixed or title case, do not capitalize prepositions of three letters or less. When in doubt, use the [Headline Capitalization tool](https://headlinecapitalization.com/).

#### Proper Nouns

The names of products, events, research, and whitepapers must always be in title case.

For more information about correct product names and symbols, refer to [Trademarks and Usage](https://docs.google.com/spreadsheets/d/1JiplcwjItzFAusB0-Oh8eO1e_Yfb8kXWShmyDBkYXN8/edit).

#### Tables

Use mixed or title case for copy in tables.

### Contractions

Use contractions to increase the conversational tone.

- ✅ **Correct:** It’s important to understand how it works in the context of generative AI.
- ❌ **Incorrect:** It is important to understand how it works in the context of generative AI.

### Dates and Time

See also [Numbers](#numbers).

#### Dates

Abbreviate the month when it appears in tables and banners or anywhere there is a character limit. Avoid abbreviating when the month appears in body copy.

If a month must be abbreviated, use the following:

- January (Jan.)
- February (Feb.)
- August (Aug.)
- September (Sept.)
- October (Oct.)
- November (Nov.)
- December (Dec.)

The other months (March, April, May, June, July) are still spelled out, even with a specific date. If space is constrained, such as in a table, you can remove the terminal period on month abbreviations if the meaning remains clear.

Use the following format for month, day, year, time: Month DD, YYYY TT a.m/p.m. unless regional content requires a different format. To avoid confusion, always spell out the name of the month. The positions of the month and day vary by country. For example, 6/12/2025 might be June 12, 2025, or December 6, 2025.

Capitalize the days of the week. Don't use abbreviations unless space is extremely limited.

Don't include a period with the abbreviations: Sun, Mon, Tue, Wed, Thu, Fri, and Sat.

##### Ordinal dates

- ✅ **Correct:** August 12
- ❌ **Incorrect:** August 12th

##### Including the year

If the date for an event, session, broadcast, and so on, is in the same year as publication, do not include the year.

#### Time

- Use a 12-hour format unless regional content requires a different format. Also, use a space and periods after “a.m.” or “p.m.” Example: 12:45 p.m. PT.
- Don't use “24/7”. Use all day, every day, always, or something similar.
- Use ET and PT for Eastern Time and Pacific Time, respectively. Use other time zone abbreviations as appropriate.
- Do not use an en dash in a time range unless space is constrained. Use “from” and “to” instead. To indicate a time range in a schedule or listing, use an en dash (no spaces). Do not use “from” with an en dash.

- ✅ **Correct:** 12:30–1:00 p.m.
- ✅ **Correct:** from 12:30 to 1:00 p.m.
- ❌ **Incorrect:** from 12:30–1:00 p.m.

### Formatting

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

### Inclusivity

Writing should be inclusive of a broad readership. Avoid using expressions that could potentially alienate readers from different backgrounds, languages, cultures, beliefs, and lifestyles. Avoid using gender-specific pronouns when possible.

### Latinisms

To help simplify content for a global audience, avoid using Latin phrases that have simpler equivalents. Formal, academic content can be an exception or where space is constrained.

- ✅ **Correct:** RTX is incredibly useful in creative applications, such as applying effects or rendering video projects.
- ❌ **Incorrect:** RTX is incredibly useful in creative applications, e.g., applying effects or rendering video projects.

- **e.g.:** Use “for example” or “such as.”
- **etc.:** Use “and so on.”
- **i.e.:** Use “that is.”
- **versus (vs.):** Use “compared to.”
- **via:** Use “by” or “through.”
- **vice versa:** Use “conversely.”

#### Exceptions

The phrases *in silico*, *in vitro*, and *in vivo* are exceptions because they are industry-standard terms with less-well-known substitutions. Italicize in running text.

### Legal

For a complete and up-to-date list of all our trademarks, refer to Legal's NVINFO page or the [Trademark list](https://nvidia.sharepoint.com/sites/nvinfo/trademarks).

If your platform is required to use trademarks, attribute an NVIDIA trademark in the first use. Use the ™ (trademark), ® (registered trademark), or ℠ (service mark) symbol the first time you refer to one of NVIDIA’s trademarked products or services in an external document. Be sure to superscript these marks in all cases.

You can drop the trademark in subsequent uses but should reiterate it periodically in longer documents (every couple of pages, front and back of a box, and so on.)

Precede trademarked product names with “NVIDIA®”. On the first use of most product names, precede the name with “NVIDIA®” (NVIDIA® nView® multi-display technology).

If the addition of NVIDIA® makes a headline too long, use it in the next mention (subhead or body text). After that, you can refer to the product more simply, such as nView.

#### Legal copy

Include the year at the beginning, all trademarked products in alphabetical order, and at the end the WorkFront job number followed by the month and year again.

> © 2025 NVIDIA Corporation and affiliates. All rights reserved. NVIDIA, the NVIDIA logo, NIM, Omniverse, Isaac, and RTX are trademarks and/or registered trademarks of NVIDIA Corporation and affiliates in the U.S. and other countries. Other company and product names may be trademarks of the respective owners with which they are associated. WF#####. MMMYY

### Links

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
- It’s okay to link on one full short sentence, but avoid linking on long sentences or more than one sentence.
- Try to limit the number of inline links within one paragraph to prevent search engine optimization (SEO) ineffectiveness and poor readability.
- Use a forward slash and a repository name for GitHub links.
  - ✅ **Correct:** the [NVIDIA/NeMo](https://github.com/NVIDIA/NeMo) GitHub repo
  - ❌ **Incorrect:** the [GitHub repo](https://github.com/NVIDIA/NeMo)

### Lists

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

#### Bulleted lists

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

#### Definition lists

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

#### Numbered lists

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

### Names

See also [Titles, Professional](#professional).

Use FirstName LastName on first use. For internal and casual content, use FirstName on second use. For more formal content, use LastName on second use.

### Numbers

Be consistent. When you write about numbers used in examples or UI, duplicate them exactly as they appear in the UI. If one item requires a numeral, use numerals for all the other items of that type.

#### Currency

Place the currency symbol before the numerical value with no space between the symbol and the number.

- ✅ **Correct:** $100
- ✅ **Correct:** €50

When not using the currency symbol, be consistent in either spelling out the full name with lowercase letters or using the abbreviation. Precede such instances with numerals.

- ✅ **Correct:** USD
- ✅ **Correct:** euros
- ✅ **Correct:** 1,000 yen

#### Numerals

In body text, main headings, and subheadings, spell out whole numbers from zero through nine, and use numerals for 10 or greater. Use numerals for time and preceding million, billion, trillion. Use the “thousands-separator” comma.

- ✅ **Correct:** 1,397
- ❌ **Incorrect:** 1397

Do not begin a sentence or a title with a numeral--spell it out or add a modifier before the number. It's OK to start list items with numerals.

- ✅ **Correct:** Four Ways to Accelerate AI Model Training and Inference
- ❌ **Incorrect:** 4 Ways to Accelerate AI Model Training and Inference

It's OK to use numerals for zero through nine when you have limited space, such as in tables and UI. When two numbers that refer to different things must appear together, use a numeral for one and spell out the other.

- ✅ **Correct:** 10 screen savers, five databases, 7 days, fifteen 20-page articles
- ❌ **Incorrect:** ten screen savers, 5 databases, seven days, 15 20-page articles

#### Ordinals

Always spell out ordinals.

- ✅ **Correct:** tenth
- ❌ **Incorrect:** 10th

#### Common numerical terms

See also [Dates and Time](#dates-and-time).

- **2D, 3D:** Abbreviations for two-dimensional and three-dimensional, respectively.
- **4G, 5G, 6G:** Fourth-generation wireless network, fifth-generation, and so on.
- **4K, 8K:** Screen resolution.
- **24/7:** Do not use. Alternatives include “without downtime” or “24 hours a day, every day of the week.”
- **350x350 pixels (px):** Image size.

### NVIDIA

Always use all caps to spell NVIDIA. Do not lowercase or use abbreviations like 'NV’.

Do not use the register mark (®) after NVIDIA if referring to the company, only in product references.

NVIDIA is preceded with “an” versus “a” as it features the “en” sound.

- ✅ **Correct:** an NVIDIA graphics card
- ❌ **Incorrect:** a NVIDIA graphics card
- ❌ **Incorrect:** nVidia, nVIDIA, nvidia, or any other variation
- ✅ **Correct:** Count on NVIDIA® GeForce®-powered laptops for great gaming.
- ❌ **Incorrect:** NVIDIA® provides industry-leading GPUs.

For more information, refer to [NVIDIA Trademark and Copyright Guidelines](https://nvidia.sharepoint.com/sites/nvinfo/legal/Documents/TrademarkCopyrightGuidelines.pdf).

### Plain English

Writing should be optimized for non-native speakers of English and translators (human and machine), as well as native English speakers. This is also known as Global or International English.

Best practices:

- Active voice
- Lists
- Short sentences
- Straightforward language

Avoid:

- Culture-specific idioms, colloquialisms, and humor (especially puns)
- Unnecessary abbreviations
- Complex grammar
- Ambiguity

### Product names

Use correct branding for all NVIDIA product names, including capitalization, spacing, hyphenation, and so on. As a general rule, precede the product name with “NVIDIA” on first mention and include a link, if available.

For more information about all correct product names and symbols, refer to [Trademarks and Usage](https://docs.google.com/spreadsheets/d/1JiplcwjItzFAusB0-Oh8eO1e_Yfb8kXWShmyDBkYXN8/edit).

For more information about general trademark usage, refer to [NVIDIA Trademark and Copyright Guidelines](https://nvidia.sharepoint.com/sites/nvinfo/legal/Documents/TrademarkCopyrightGuidelines.pdf).

### Punctuation

#### Ampersand (&)

Do not use an ampersand in place of “and” except when referring to names and titles that contain one.

- ✅ **Correct:** Tips and tricks
- ❌ **Incorrect:** Tips & tricks

#### Apostrophe (‘)

Use an apostrophe to form the possessive case of nouns. For singular nouns, add an apostrophe and an s, even if the noun ends in s, x, or z. To form the possessive of plural nouns that end in s, add only an apostrophe.

- ✅ **Correct:** the CSS's flexibility
- ❌ **Incorrect:** the CSS’ flexibility

Avoid using the apostrophe for the possessive form of “it,” with a possessive pronoun, or to form the plural of a singular noun.

- ✅ **Correct:** Replace a formula with its calculated value.
- ❌ **Incorrect:** Replace a formula with it’s calculated value.

#### Brackets and braces

There are three kinds of brackets: angle brackets, curly braces, and square brackets.

##### Angle brackets ( < and > )

Use angle brackets as a placeholder for variables you want the user to enter.

- ✅ **Correct:** Type your user-specified domain in this format: `https://<user-specified domain>.com`.
- ❌ **Incorrect:** Type your user-specified domain in this format: `https://[user-specified domain].com`.

You can also use angle brackets to indicate navigation or a series of menu item clicks.

- ✅ **Correct:** Select **Save As** > **Saved Search** > **Close**.
- ❌ **Incorrect:** Select **Save As** -> **Saved Search** -> **Close**.

##### Curly braces ( { and } )

Use curly braces only when they are part of a code sample or other string literal.

##### Square brackets ( [ and ] )

Use square brackets around a .conf file stanza name or within code.

- ✅ **Correct:** Edit the `[clevertap]` stanza. Specify a sub search that starts with this search command: `tag=dns query [search tag=malware]`.
- ❌ **Incorrect:** Type your user-specified domain in this format: `https://[user-specified domain].nvidia.com`.

#### Colons (:)

Use colons in lists and to elaborate on a statement. Include a colon at the end of a phrase that directly introduces a list. For example:

> You can create a backup of all sorts of things to make the transition easier, including:
>
> - The apps you've installed on your phone, along with high scores and progress from participating apps.
> - The passwords for your accounts.
> - Your call history.

Colons can also introduce a direct quotation.

Most of the time, two sentences are more readable so avoid using colons to join two independent clauses. When you do use a colon in a sentence, lowercase the word that follows it unless it is a complete sentence.

#### Commas

Use a comma before the conjunction in a list of three or more items. The comma that comes before the conjunction is known as the Oxford comma or serial comma.

If a series contains more than three items or the items are long, consider a bulleted list to improve readability.

- ✅ **Correct:** Google includes Mail, Calendar, People, and Tasks.
- ❌ **Incorrect:** Google includes Mail, Calendar, People and Tasks.

Commas also follow an introductory phrase. If the sentence is long or complex, consider rewriting as two sentences.

Use commas to separate thousands, millions, billions, and so on.

- ✅ **Correct:** 1,397
- ❌ **Incorrect:** 1397

#### Dashes and hyphens (-)

Dashes and hyphens include em dashes, en dashes, and hyphens.

##### Em dash (—)

Use an em dash (—) to set off a parenthetical phrase with more emphasis than parentheses provide. Don’t add spaces around an em dash and don’t capitalize the first word after an em dash unless the word is a proper noun.

Use one em dash on each side of a phrase embedded in a sentence or to set off a phrase at the end of a sentence.

- ✅ **Correct:** The information in your spreadsheet—numbers, formulas, and text—is stored in cells.
- ❌ **Incorrect:** The information in your spreadsheet — numbers, formulas, and text — is stored in cells.

Avoid using an em dash in place of a bullet character in a list or to indicate an empty cell in a table.

##### En dash (–)

Use an en dash (–) to indicate a range of numbers, such as inclusive values, dates, or pages.

Don’t use spaces on either side of an en dash unless it's used as a minus sign in an equation or in a timestamp appearing in UI.

- ✅ **Correct:** 2015–2017
- ❌ **Incorrect:** 2015-2017

In text, don’t use an en dash in a range of times unless space is constrained. Use ‘to’ instead: 10:00 a.m to 2:00 p.m. In a schedule or listing, use an en dash with no spaces around it: 10:00 AM–2:00 PM.

The exception is in a date range that includes two times and two dates, add spaces around the en dash. For example:

- 2:15 AM‒4:45 PM 4/1/16 (time range on a single day)
- 2:15 PM 12/1/17 ‒ 4:45 PM 4/1/18 (range includes both time and date)

##### Hyphen (-)

Hyphenate two or more words that precede and modify a noun as a unit if confusion might result without the hyphen.

- ✅ **Correct:** built-in drive, left-aligned text, real-time scenario
- ❌ **Incorrect:** builtin drive, left aligned text, real time scenario

#### Exclamation mark (!)

Avoid using exclamation marks.

#### Parentheses ( )

Use parentheses sparingly in body copy. Consider using an em dash (—) instead.

Do not use them in headlines or subheads.

#### Period (.)

End all sentences with a period, even if there are only two words. Put one space, not two, after a period.

Avoid using terminal periods in the following cases:

- Headlines, headings, or subheadings
- UI titles or UI text
- Simple list items (three or fewer words per item)
- Table items

Be consistent. If one or more list or table elements is a complete sentence, use a period after every element in the same list or column, even if any other element contains three or fewer words.

#### Quotation marks (“)

In most content, use double quotation marks ("), not single quotation marks ('). Use to set off quotes from people. Avoid using quotation marks for titles or new terms.

Place closing quotation marks:

- Outside commas and periods
- Inside other punctuation

If the punctuation is a part of the quoted material, place it inside the quotation marks, except when a parenthetical reference follows or it is a part of a code string.

- ✅ **Correct:** He said, “I may forget your name, but I never forget a face.”
- ❌ **Incorrect:** He said, ‘I may forget your name, but I never forget a face.’
- ✅ **Correct:** In Java, a string is a sequence of characters. For example, “hello” is a string containing a sequence of characters ‘h’, ‘e’, ‘l’, ‘l’, and ‘o’.

#### Semicolons (;)

Semicolons are used between two independent clauses that aren't joined by a conjunction. Sentences that contain semicolons are often complex. Try to simplify the sentence and break it into multiple sentences or a list to eliminate the semicolon.

- ✅ **Correct:** Select the required **Option** and then select **Automatic backups**.
- ❌ **Incorrect:** Select the required **Option**; then select **Automatic backups**.

When semicolons are used to separate items in a series that contains commas or other punctuation, break content out into a list instead.

#### Slashes

There are two kinds of slashes: the backslash and the forward slash.

##### Backslash (\\)

Windows operating systems use backslashes in URL and URI paths. Backslashes are also used in code.

##### Forward slash (/)

Avoid using for exclusive or inclusive ‘or’ constructions. Okay to use for industry-standard terms, such as read/write, and GitHub repositories and Linux directory paths

- ✅ **Correct:** Cuda-gdb doesn't break or step into kernels.
- ❌ **Incorrect:** Cuda-gdb doesn't break and/or step into kernels.

### SEO

Search engine optimization (SEO) is the process of improving discoverability by matching content keywords with popular searches. One of the most important SEO best practices is to focus on high-quality, user-centric content. This means creating content that is helpful, reliable, and unique, thoroughly addressing the user's search intent.

Here are a few practices to help achieve your goal:

- Use the customers’ language.
  - Think about how a user would search (Google, Bing, ChatGPT, or Perplexity) for the page that you have created.
  - To determine which keywords will improve your search analytics, you can use tools like Google Keyword Planner and [Answer the Public](https://answerthepublic.com/) (free).
- Think of keywords in terms of buckets or themes.
  - You should group keywords and consider their synonyms rather than focusing on a single keyword.
  - For example: language model, large language models, language models, LLM, LLMs, models for generating language, models for language.
- Reach out to partners and resellers to get inbound links from high value domains.
- Build-in crosslinks to your page from NV.com owned content.
- Use clear language:
  - 8th grade writing level.
  - Avoid jargon and colloquialisms.
  - Use useful next steps and call to actions (CTAs).
  - Avoid repetitive language.
- Ensure that your tag structure supports your keywords and customers’ language.
- Avoid thin content.
  - Avoid creating pages with minimal content. If the page you are working on has minimal content, consider adding it as a section to an existing page. Use the NVIDIA Cosmos Dataset Search Blueprint as an example:
    - The Experience tab has minimal content on it: <https://build.nvidia.com/nvidia/cosmos-dataset-search>
    - The Blueprint Card tab provides a lot more detail and content compared to the Experience tab: <https://build.nvidia.com/nvidia/cosmos-dataset-search/blueprintcard>. In this example, it would make sense to combine the pages.
  - Detailed, well-structured content that uses nested heading tags and answers potential users’ questions tends to rank well.
- Elevate your most important content.
- Check your search rankings and competitors often.

Contact Linda Caplinger for help with SEO.

### Social Media

Here are some best practices for writing for social media platforms. For platform-specific guidance, ask your team specialist.

- **Hook:** Begin with a hook or the action you’d like the audience to take.
- **POV:** Refer to NVIDIA using "us" or "our," avoiding third-person references.
- **Punctuation:** No exclamation points. Use emojis instead.
- **Case:** Don’t use Title Case (too formal) or ALL CAPS (comes off as shouting).
- **Use conversational language:** Write in a natural, conversational voice. Speak directly and clearly, respecting the audience’s intelligence.
- **Tense:** Use active, present-tense language and contractions like “it’s” rather than “it is” to enhance the conversational tone.
- **Clarity:** Avoid jargon. Use words that are quickly and clearly understood. On social media, sounding human is more important than sounding smart. Simple, direct language works best.
- **Avoid redundancies:** Consider all text in your post, including the message, link title, link description, and text on the image.
- **No trademark symbols:** Trademark symbols are too formal and not conversational, so remove from social copy.
- **Hashtags:** Include 1–3 discoverable or branded hashtags per post. Check with your social PIC for the most important.

### Symbols

See also [Equations and formulas](#equations-and-formulas).

| Symbol | Usage | Example |
|---|---|---|
| x | Use in place of ‘times.’ | 2x the speed<br>Avoid when discussing quantities. |
| + | Spell out as ‘plus’ in text.<br>Okay for tables or charts with limited space. | When width-pruned plus distilled, the model…<br>width-pruned + distilled |
| o | Use in place of ‘degrees’ in text. | Earth was 1.1⁰ Celsius warmer.<br>1.1⁰ C |
| ~ | Use to indicate an approximation. | ~5x faster |
| % | Use to indicate percent in text and tables. | An 80% increase |

### Tables

Use tables for reference information, decision support, compatibility matrices, and choices that a user has.

Here are a few guidelines for working with tables in your content:

- In general, introduce tables with a full sentence and a colon and include a caption.
- Don't create a table with only one row.
- For headers, use title case.
- Avoid leaving table cells empty. If you need to keep a cell blank, use a nonbreaking space to make a cell appear blank.
- Avoid including links in tables, unless the purpose of the table is to help users find information.
- Use code samples sparingly in tables.
- Every table must have a title or caption.

### Titles

See also [Capitalization](#capitalization), [SEO](#seo).

#### Content (films, video games, blog posts, articles)

Use title case for titles of articles and blog posts. Do not italicize. Link to source content on the full title.

Use title case and italics for titles of books, films, television shows, and video games.

- ✅ **Correct:** To learn more about our research, refer to the paper, [Analyzing and Improving the Training Dynamics of Diffusion Models](https://arxiv.org/abs/2312.02696).
- ✅ **Correct:** Developed by Mojang Studios, *Minecraft* was originally released in 2011.

#### Professional

When writing job titles, use the following format for listings or when accompanying photographs:

> FirstName LastName, Job Title, Department, Company

When writing titles in sentences, use title case for the title when it precedes the person's name, but lower case if it follows their name.

- "NVIDIA Vice President Jane Doe said..."
- "And according to Jane Doe, vice president of marketing at NVIDIA..."

### Technical Content

Technical content is usually more complex than marketing content. This section details some of the ways that technical content differs from the main NVIDIA Writing Guide or describes elements that non-technical content does not usually contain.

Individual teams might have style guides specific to an authoring environment or role.

- **Technical Blog:** [NVIDIA Technical Blog Writing and Style Guide](https://docs.google.com/document/d/19D30i6V4QtMySrqItVc0BB_HhRf6LW_aLBPDuKGlrEY/edit) (available externally)
- **Software Documentation:** [Technical Documentation Writing Guide](https://confluence.nvidia.com/display/SWDOCS/Technical+Documentation+Writing+Guide)

#### Code elements or examples

Code elements can be referenced within a sentence or longer code examples given separately. Introduce code examples with full sentences. Avoid using the term *snippet*. Inline references to methods may remove empty parentheses.

Use a monospace font and syntax highlighting.

#### Equations and formulas

Use LaTeX or MathML for math equations, whether it’s inline or on a separate line.

#### File name extensions

- Use a period and lower case when referring to a file name extension. Example: a .tgz file
- Use upper case and no period when referring to the type of file. Example: a TGZ file

#### Footnotes

Use your team-specific guidelines. In the absence of specific guidelines for your content platform, use sparingly except in research papers. For more casual content platforms (like the Technical Blog), integrate the information into the body of the text as appropriate.

#### GitHub repositories

Use a forward slash and a repository name for GitHub links.

- ✅ **Correct:** the [NVIDIA/NeMo](https://github.com/NVIDIA/NeMo) GitHub repo
- ❌ **Incorrect:** the [GitHub repo](https://github.com/NVIDIA/NeMo)

#### Leading sentences

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

#### Marketing claims

Avoid flowery language or comparisons with third-party products.

- ✅ **Correct:** NVIDIA today announced it has updated their accelerated computing platform with the introduction of the NVIDIA HGX™ H200 GPU.
- ❌ **Incorrect:** NVIDIA today announced it has supercharged the world’s leading AI computing platform with the introduction of the NVIDIA HGX™ H200.

#### Model names

For consistency, follow NVIDIA naming conventions for [NVIDIA models](https://build.nvidia.com/explore/discover) and third-party naming conventions for other models where appropriate. Include the company name and qualifier on first use.

- ✅ **Correct:** the Microsoft Kosmos-2 model
- ✅ **Correct:** the NVIDIA Nemotron-3-8B-QA-4k model, Nemotron-3 family
- ❌ **Incorrect:** Kosmos, NeMoTron-3

#### Procedures

Technical content often offers consecutive steps that must be followed to complete one or more tasks.

- **Numbering:** Numbering steps is optional, especially when steps will be separated by code blocks, images, or supplemental information.
  - When using numbered steps, keep the total number of steps under 5-7 for readability.
- **Subtasks:** Break up long procedures or nested steps into smaller tasks.
- **Navigation:** Use subheadings to separate procedures.
- **Addressing the reader:** Use primarily imperative sentences ("Do this. Next, do that."), with declarative sentences as needed for explanation ("You can choose option A.").

#### Readability

Aim for sentences of fewer than 30 words wherever possible.

Use academic or formal conjunctive adverbs sparingly:

- Additionally
- Consequently
- Furthermore
- Hence
- Moreover
- Thus
- Undoubtedly
- Whilst

#### Synonyms

For clarity, use the same term throughout a piece of technical writing. Include synonyms only to connect industry-standard terms with NVIDIA-specific or more relevant terms.

#### UI text

Use bold text when referencing the user interface (UI):

- Buttons
- Menus
- Field labels

When referring to multiple UI elements in a process, use angle brackets (>) to indicate consecutive steps.

For more information about guidelines for UI strings, refer to the [Describing UI Interactions](https://learn.microsoft.com/en-us/style-guide/procedures-instructions/describing-interactions-with-ui) and [Formatting Text in Instructions](https://learn.microsoft.com/en-us/style-guide/procedures-instructions/formatting-text-in-instructions) topics in the Microsoft Style Guide.

### Trademarks

Use of product trademarks for both NVIDIA and third-party products varies. In general, for content primarily focused on PR and sales (product landing pages, press releases, and so on), use TMs on first mention of a product.

Do not use TMs for content that is primarily focused on learning (Technical Blog post, GTC session, and so on).

For up-to-date guidelines, refer to [NVIDIA Trademark and Copyright Guidelines](https://nvidia.sharepoint.com/sites/nvinfo/legal/Documents/TrademarkCopyrightGuidelines.pdf).

### Units of Measurement

Avoid mixing abbreviated and spelled-out units. Be consistent.

- ✅ **Correct:** 200 GB/s
- ✅ **Correct:** 200 gigabytes per second
- ❌ **Incorrect:** 200 GBps
- ❌ **Incorrect:** 40 GB/second

Include a space between the number and unit of measurement (40 GB, 30 mm, and so on). Use a non-breaking space as needed.

| Unit | Unit symbol or abbreviation | Definition |
|---|---|---|
| ampere | A | electrical charge |
| baud | Bd | speed of communication over data channel |
| bit | bit | size of data |
| bits per second | bit/s | speed of data transmission |
| byte | B | size of data; one B equals eight bits |
| decibel | dB | intensity of sound |
| degree | ° | temperature |
| dots per inch | dpi | resolution |
| electron volt | eV | energy |
| FLOP | FLOP | floating-point operations per second<br>Use lowercase for associated terms, including exaflop, gigaflop, petaflop, teraflop, and so on. |
| foot | ft. | length |
| gibibyte | GiB | computer memory / unit of storage capacity |
| gigabit | Gbit | computer memory / unit of storage capacity |
| gigabits per second | Gbit/s | speed of data transmission |
| gigabyte | GB | computer memory / unit of storage capacity |
| gigabytes per second | GB/s | speed of data transmission |
| gigahertz | GHz | frequency |
| hertz | Hz | frequency in cycles per second |
| inch | in. | length |
| kilobit | kbit | computer memory; one kbit equals 1,000 bits |
| kilobits per second | kbit/s | speed of data transmission |
| kilobyte | KB | computer memory; one KB equals 1,024 bytes |
| kilobytes per second | KB/s | speed of data transmission |
| kilohertz | kHz | frequency |
| kilowatt-hour | kWh | energy |
| megabit | Mbit | computer memory |
| megabits per second | Mbit/s | speed of data transmission |
| megabyte | MB | computer memory |
| megabytes per second | MB/s | speed of data transmission |
| megahertz | MHz | frequency |
| megapixel | MP | resolution |
| meters per second | m/s | velocity |
| micrometer, or micron | μm | length |
| millisecond | ms | time |
| pixel | px | smallest unit of an image |
| pixels per inch | ppi | quantifies pixel density |
| terabit | Tbit | computer memory |
| terabits per second | Tbit/s | speed of data transmission |
| terabyte | TB | computer memory |
| terabytes per second | TB/s | speed of data transmission |
| teraherz | THz | frequency; one THz equals 1 trillion cycles per second |
| watt | W | the unit of power or radiant flux, equal to 1 joule per second |
