<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# UI Elements and Interactions

Part of the [NVIDIA style guidelines](SKILL.md), which list the sources and the changes made to them.
Related: [Technical Content](technical-content.md), [Formatting, Links, Lists, and Tables](formatting.md), [Voice, Tone, and Accessibility](voice-and-tone.md).

*(Content Engineering guide: UI Element Terminology and Interaction Guidelines)* UI interaction guidelines enhance consistency and improve usability and accessibility across our products.
These guidelines are based on conventions from industry leaders like Google and Microsoft.
The source's column of NVIDIA Kaizen design system components and its empty table of NGC-specific components are omitted.

When referencing UI elements, keep in mind:

- Focus instructions on what the user needs to get done instead of the specific widgets (“button”) or gestures (“click,” “swipe”).
- Users may interact with the products using different input methods: keyboard, mouse, touch, voice, etc.
- Avoid directional language for accessibility.
- When a label is all uppercase, use sentence case. Avoid upper case as they can be read by screen readers one character at a time.
- Use modern and inclusive language; refer to [Inclusivity](voice-and-tone.md#inclusivity).

## Basic UI Components

The Microsoft and Google columns give each style guide's examples and guidance.

| UI element | Term | Verb | Microsoft | Google |
| --- | --- | --- | --- | --- |
| Button | (button) | Select or Click | Select **Save as** (*not* Select **Save as…** or Select the **Save as** button).<br>Refer to a button by its label only without using the word *button*. | Click **OK**. |
| Checkbox | checkbox | Select/Clear | For **Alignment**, select **Left**.<br>Clear the **Header** row checkbox. | Select the **Automatically check for updates** checkbox.<br>Clear the **Bookmarks** checkbox. |
| Dialog | (dialog or dialog box) | Close the dialog. | Select **Upload**, and then select a file to upload.<br>When you need to refer to the UI element, use *dialog*. Don't use *pop-up window*, *dialog box*, or *dialogue box*. | In the **Welcome** dialog, click **OK**. |
| Links | (link) | Select or Click | Select the **LinkName** link.<br>Use *go to* to describe the process of going to another document, place, or webpage. Don't use *click* or *click on*. | Click the **Edit** link. Or Click **Edit**. |
| List box, combo box, spin box | (list, box) | Select (list or box)<br>Enter (text box in combo or spin box) | In the **Background** list, select **Coffee Bean**. | In the **Item** list, select **Desktop**.<br>In the **Font** box, type or select the font that you want to use. For combo box, use the verbs *type or select* or *enter*. |
| Menu | (menu) | Select | Go to **File**, and then select **Close**.<br>Go to **Search**, enter the word settings, and then select **Settings**. | In the **File** menu, select **Open**.<br>To refer to an item in a menu, use the term command, not choice, menu item, or option. |
| Menu bar | (menu) |  |  | Appears at the top of the window or screen. In the **File** menu, select **Open**. |
| Navigation menu, navigation bar | navigation menu | In the navigation menu, select **Organizations**. |  | The user can click to go to pages in an application or website.<br>Don't use the terms *navigation bar*, *navigation pane*, *navigation panel*, or *navigation window*. |
| Page | page | Open, Leave, Go to | Select **Submit** to complete the survey and leave this page.<br>Use *page* or *webpage* to describe one of a collection of web documents that make up a website. Use *page* to refer to the page the reader is on or to a specific page, such as the home page or start page.<br>In a wizard, use *page* instead of *screen* to refer to an individual screen. | In the Google Cloud console, go to the **Deployments** page. |
| Pane, panel, section, area | pane |  | Use only to refer to the separate areas of a split or single window.<br>Use the preposition *on* when referring to the contents of a pane. | Rectangular region of a window<br>In the **Create service account** pane, click **New**.<br>Do not use terms such as *panel*, *section*, *area*, or *column* to refer to a pane. |
| Radio buttons | (option)<br>Use the radio button's label, or refer to the group of buttons by its label. | Select | Capitalize the label text as it appears in the UI, but don't capitalize the word *option*. | Select **Do not remember passwords**.<br>For **Startup mode**, choose an option. |
| Scroll |  | Move through, go to | Avoid. Use a verb phrase such as *move through* instead, if the context is clear.<br>Move through the folder until you see the file you want. | OK to use *scroll* as a verb, but if possible, instead use a term that isn't specific to implementation. For example, write *go to the section*, instead of *scroll to the section*. If you use *scroll*, don't use directional language like *scroll up*. |
| Slider | (slider) |  | In content for a general audience, it's OK to use *slider* when you need to describe the UI element used to set a value on a continuous range of possible values, such as screen brightness, mouse-click speed, or volume.<br>Move the slider downward to decrease the volume. |  |
| Tab | tab | Go to, Click | Go to the **Deploy** tab.<br>Don't use as a verb.<br>Use the **Tab** key to move through a dialog box.<br>Set a tab stop on the ruler.<br>On the **View** tab … | Select **Tools > Options**, and then click the **Edit** tab.<br>When referring to the sub-pages of a [console](https://developers.google.com/style/word-list#console), use *page* instead of *tab*. |
| Text box (entering text in general) | (box) | Enter, Type | In the **Deployment script name** box, enter a name for this script.<br>Enter or update an email address for **Work email**. | In the **Owner** box, enter your name. (Some parts of Google use “field.”) |
| Tile | tile | Move, Drag | Move the tile to a new section. |  |
| Toast | notification |  | Don't use to refer to a notification triggered by an app or the operating system that's displayed in a pop-up notification. Use *notification* instead. |  |
| Toggle | toggle | Turn on, Turn off, Switch, Click | To make text and apps easier to see, turn on the toggle under **Turn on high contrast**.<br>To switch between **Normal**, **Outline**, and **Slide Sorter** views, use the buttons on the **View** tab. | To turn on the setting, click the **Wi-Fi** toggle. In **Settings**, click the **Magic mode** toggle to the on position. |
| Website or webpage | (page) | Go to, leave, visit, navigate (navigate marked with a question icon) | Go to [example.com](http://example.com) to register.<br>Select **Submit** to complete the survey and leave this page. | Not *webpage*. But where possible, avoid both by using *page*. |
| Window | window | Move, drag |  | A *window* is the entire application window in a desktop environment.<br>In the **MyApp** window, click **Edit**. |
| Wizard |  |  | In general, don't use the term *wizard* unless it appears in the UI.<br>In a wizard, use *page* instead of *screen* to refer to an individual screen. |  |

## References

- [Microsoft Style Guide: Describing interactions with UI](https://learn.microsoft.com/en-us/style-guide/procedures-instructions/describing-interactions-with-ui)
- [Microsoft Style Guide: A–Z word list](https://learn.microsoft.com/en-us/style-guide/a-z-word-list-term-collections/w/wizard)
- [Google developer documentation style guide: UI elements and interaction](https://developers.google.com/style/ui-elements)
- [Apple Style Guide](https://support.apple.com/guide/applestyleguide/welcome/web)
- [Red Hat supplementary style guide: Graphical interfaces](https://redhat-documentation.github.io/supplementary-style-guide/#graphical-interfaces)
- [IBM Carbon Design System: Content guidelines](https://carbondesignsystem.com/guidelines/content/overview/)
