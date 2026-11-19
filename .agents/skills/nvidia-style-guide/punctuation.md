<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Punctuation and Symbols

Part of the [NVIDIA style guidelines](SKILL.md), which list the sources and the changes made to them.
Related: [Numbers, Dates, and Units](numbers-dates-and-units.md), [Formatting, Links, Lists, and Tables](formatting.md), [Technical Documentation Writing Guide](technical-documentation.md).

## Punctuation

### Ampersand (&)

Do not use an ampersand in place of “and” except when referring to names and titles that contain one.

- ✅ **Correct:** Tips and tricks
- ❌ **Incorrect:** Tips & tricks

### Apostrophe (‘)

Use an apostrophe to form the possessive case of nouns. For singular nouns, add an apostrophe and an s, even if the noun ends in s, x, or z. To form the possessive of plural nouns that end in s, add only an apostrophe.

- ✅ **Correct:** the CSS's flexibility
- ❌ **Incorrect:** the CSS’ flexibility

Avoid using the apostrophe for the possessive form of “it,” with a possessive pronoun, or to form the plural of a singular noun.

- ✅ **Correct:** Replace a formula with its calculated value.
- ❌ **Incorrect:** Replace a formula with it’s calculated value.

### Brackets and braces

There are three kinds of brackets: angle brackets, curly braces, and square brackets.

#### Angle brackets ( < and > )

Use angle brackets as a placeholder for variables you want the user to enter.

- ✅ **Correct:** Type your user-specified domain in this format: `https://<user-specified domain>.com`.
- ❌ **Incorrect:** Type your user-specified domain in this format: `https://[user-specified domain].com`.

You can also use angle brackets to indicate navigation or a series of menu item clicks.

- ✅ **Correct:** Select **Save As** > **Saved Search** > **Close**.
- ❌ **Incorrect:** Select **Save As** -> **Saved Search** -> **Close**.

#### Curly braces ( { and } )

Use curly braces only when they are part of a code sample or other string literal.

#### Square brackets ( [ and ] )

Use square brackets around a .conf file stanza name or within code.

- ✅ **Correct:** Edit the `[clevertap]` stanza. Specify a sub search that starts with this search command: `tag=dns query [search tag=malware]`.
- ❌ **Incorrect:** Type your user-specified domain in this format: `https://[user-specified domain].nvidia.com`.

### Colons (:)

Use colons in lists and to elaborate on a statement. Include a colon at the end of a phrase that directly introduces a list. For example:

> You can create a backup of all sorts of things to make the transition easier, including:
>
> - The apps you've installed on your phone, along with high scores and progress from participating apps.
> - The passwords for your accounts.
> - Your call history.

Colons can also introduce a direct quotation.

Most of the time, two sentences are more readable so avoid using colons to join two independent clauses. When you do use a colon in a sentence, lowercase the word that follows it unless it is a complete sentence.

### Commas

Use a comma before the conjunction in a list of three or more items. The comma that comes before the conjunction is known as the Oxford comma or serial comma.

If a series contains more than three items or the items are long, consider a bulleted list to improve readability.

- ✅ **Correct:** Google includes Mail, Calendar, People, and Tasks.
- ❌ **Incorrect:** Google includes Mail, Calendar, People and Tasks.

Commas also follow an introductory phrase. If the sentence is long or complex, consider rewriting as two sentences.

Use commas to separate thousands, millions, billions, and so on.

- ✅ **Correct:** 1,397
- ❌ **Incorrect:** 1397

### Dashes and hyphens (-)

Dashes and hyphens include em dashes, en dashes, and hyphens.

#### Em dash (—)

Use an em dash (—) to set off a parenthetical phrase with more emphasis than parentheses provide. Don’t add spaces around an em dash and don’t capitalize the first word after an em dash unless the word is a proper noun.

Use one em dash on each side of a phrase embedded in a sentence or to set off a phrase at the end of a sentence.

- ✅ **Correct:** The information in your spreadsheet—numbers, formulas, and text—is stored in cells.
- ❌ **Incorrect:** The information in your spreadsheet — numbers, formulas, and text — is stored in cells.

Avoid using an em dash in place of a bullet character in a list or to indicate an empty cell in a table.

*(Technical Documentation Writing Guide)* In technical documentation, use commas or parentheses instead of em dashes. Refer to [Technical documentation conventions](SKILL.md#technical-documentation-conventions).

#### En dash (–)

Use an en dash (–) to indicate a range of numbers, such as inclusive values, dates, or pages.

Don’t use spaces on either side of an en dash unless it's used as a minus sign in an equation or in a timestamp appearing in UI.

- ✅ **Correct:** 2015–2017
- ❌ **Incorrect:** 2015-2017

In text, don’t use an en dash in a range of times unless space is constrained. Use ‘to’ instead: 10:00 a.m to 2:00 p.m. In a schedule or listing, use an en dash with no spaces around it: 10:00 AM–2:00 PM.

The exception is in a date range that includes two times and two dates, add spaces around the en dash. For example:

- 2:15 AM‒4:45 PM 4/1/16 (time range on a single day)
- 2:15 PM 12/1/17 ‒ 4:45 PM 4/1/18 (range includes both time and date)

#### Hyphen (-)

Hyphenate two or more words that precede and modify a noun as a unit if confusion might result without the hyphen.

- ✅ **Correct:** built-in drive, left-aligned text, real-time scenario
- ❌ **Incorrect:** builtin drive, left aligned text, real time scenario

### Exclamation mark (!)

Avoid using exclamation marks.

### Parentheses ( )

Use parentheses sparingly in body copy. Consider using an em dash (—) instead.

Do not use them in headlines or subheads.

### Period (.)

End all sentences with a period, even if there are only two words. Put one space, not two, after a period.

Avoid using terminal periods in the following cases:

- Headlines, headings, or subheadings
- UI titles or UI text
- Simple list items (three or fewer words per item)
- Table items

Be consistent. If one or more list or table elements is a complete sentence, use a period after every element in the same list or column, even if any other element contains three or fewer words.

### Quotation marks (“)

In most content, use double quotation marks ("), not single quotation marks ('). Use to set off quotes from people. Avoid using quotation marks for titles or new terms.

Place closing quotation marks:

- Outside commas and periods
- Inside other punctuation

If the punctuation is a part of the quoted material, place it inside the quotation marks, except when a parenthetical reference follows or it is a part of a code string.

- ✅ **Correct:** He said, “I may forget your name, but I never forget a face.”
- ❌ **Incorrect:** He said, ‘I may forget your name, but I never forget a face.’
- ✅ **Correct:** In Java, a string is a sequence of characters. For example, “hello” is a string containing a sequence of characters ‘h’, ‘e’, ‘l’, ‘l’, and ‘o’.

### Semicolons (;)

Semicolons are used between two independent clauses that aren't joined by a conjunction. Sentences that contain semicolons are often complex. Try to simplify the sentence and break it into multiple sentences or a list to eliminate the semicolon.

- ✅ **Correct:** Select the required **Option** and then select **Automatic backups**.
- ❌ **Incorrect:** Select the required **Option**; then select **Automatic backups**.

When semicolons are used to separate items in a series that contains commas or other punctuation, break content out into a list instead.

### Slashes

There are two kinds of slashes: the backslash and the forward slash.

#### Backslash (\\)

Windows operating systems use backslashes in URL and URI paths. Backslashes are also used in code.

#### Forward slash (/)

Avoid using for exclusive or inclusive ‘or’ constructions. Okay to use for industry-standard terms, such as read/write, and GitHub repositories and Linux directory paths

- ✅ **Correct:** Cuda-gdb doesn't break or step into kernels.
- ❌ **Incorrect:** Cuda-gdb doesn't break and/or step into kernels.

## Symbols

See also [Equations and formulas](technical-content.md#equations-and-formulas).

| Symbol | Usage | Example |
|---|---|---|
| x | Use in place of ‘times.’ | 2x the speed<br>Avoid when discussing quantities. |
| + | Spell out as ‘plus’ in text.<br>Okay for tables or charts with limited space. | When width-pruned plus distilled, the model…<br>width-pruned + distilled |
| o | Use in place of ‘degrees’ in text. | Earth was 1.1⁰ Celsius warmer.<br>1.1⁰ C |
| ~ | Use to indicate an approximation. | ~5x faster |
| % | Use to indicate percent in text and tables. | An 80% increase |
