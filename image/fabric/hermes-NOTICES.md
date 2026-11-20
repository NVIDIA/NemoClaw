<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes Frontend Dependency Notices

Original license and notice texts below retain their upstream copyrights and terms.

The following packages publish declarations without a standalone license file in the material inspected: `@nous-research/ui@0.19.1`, `unicode-animations@1.0.3`, `react-remove-scroll-bar@2.3.8`, `@alcalzone/ansi-tokenize@0.1.3`.
Their original package metadata and README are retained below; these do not supply a missing copyright grant or establish font redistribution permission.

## 01949dbb7502b2f1

- file-selector@0.5.0 — package/LICENSE

```text
MIT License

Copyright (c) 2020 Roland Groza

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 05f6ebb5e1e2cf14

- @alcalzone/ansi-tokenize@0.1.3 — package/package.json

```text
{
  "name": "@alcalzone/ansi-tokenize",
  "version": "0.1.3",
  "description": "Efficiently modify strings containing ANSI escape codes",
  "publishConfig": {
    "access": "public"
  },
  "author": {
    "name": "AlCalzone",
    "email": "d.griesel@gmx.net"
  },
  "license": "MIT",
  "type": "module",
  "module": "build/index.js",
  "types": "build/index.d.ts",
  "exports": {
    ".": {
      "types": "./build/index.d.ts",
      "import": "./build/index.js"
    },
    "./package.json": "./package.json"
  },
  "files": [
    "build"
  ],
  "engines": {
    "node": ">=14.13.1"
  },
  "devDependencies": {
    "@alcalzone/release-script": "~3.5.9",
    "@alcalzone/release-script-plugin-license": "~3.5.9",
    "@tsconfig/node14": "^14.1.0",
    "@types/node": "^14.18.54",
    "@typescript-eslint/eslint-plugin": "^5.55.0",
    "@typescript-eslint/parser": "^5.55.0",
    "ava": "^4.3.3",
    "eslint": "^8.36.0",
    "eslint-config-prettier": "^8.7.0",
    "eslint-plugin-prettier": "^4.2.1",
    "prettier": "^2.8.4",
    "source-map-support": "^0.5.21",
    "ts-node": "^10.9.1",
    "tsx": "^3.12.8",
    "typescript": "^5.0.2"
  },
  "dependencies": {
    "ansi-styles": "^6.2.1",
    "is-fullwidth-code-point": "^4.0.0"
  },
  "scripts": {
    "prepare": "tsc -p tsconfig.build.json",
    "build": "tsc -p tsconfig.build.json",
    "test": "NODE_OPTIONS='--loader tsx' ava",
    "lint": "eslint .",
    "release": "release-script"
  },
  "ava": {
    "extensions": {
      "ts": "module"
    }
  },
  "packageManager": "yarn@3.5.0"
}
```

## 0798f37cff4a3f43

- assign-symbols@1.0.0 — package/LICENSE
- is-extendable@0.1.1 — package/LICENSE

```text
The MIT License (MIT)

Copyright (c) 2015, Jon Schlinkert.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 0cb671733c329267

- @alcalzone/ansi-tokenize@0.1.3 — package/README.md

````text
# @alcalzone/ansi-tokenize

> Efficiently modify strings containing [ANSI escape codes](https://en.wikipedia.org/wiki/ANSI_escape_code#Colors_and_Styles)

If you find yourself modifying styled strings repeatedly, alternatives like [`slice-ansi`](https://github.com/chalk/slice-ansi/) may end up doing a lot of unnecessary work by re-parsing the string each time. This module provides a way to parse the string into an array of tokens (characters or ANSI codes), which can then be modified and re-serialized into a styled string.

## Install

```
$ npm install @alcalzone/ansi-tokenize
```

## Usage

### Tokenize a string

```js
import { tokenize } from "@alcalzone/ansi-tokenize";

// red "foo", followed by unstyled "bar"
const str = "\x1B[31mfoo\x1B[39mbar";
const tokens = tokenize(str);

// tokens will now look like this:
[
	{
		type: "ansi",
		code: "\x1B[31m",
		endCode: "\x1B[39m",
	},
	{
		type: "char",
		value: "f",
		fullWidth: false,
	},
	{
		type: "char",
		value: "o",
		fullWidth: false,
	},
	{
		type: "char",
		value: "o",
		fullWidth: false,
	},
	{
		type: "ansi",
		code: "\x1B[39m",
		endCode: "\x1B[39m",
	},
	{
		type: "char",
		value: "b",
		fullWidth: false,
	},
	{
		type: "char",
		value: "a",
		fullWidth: false,
	},
	{
		type: "char",
		value: "r",
		fullWidth: false,
	},
];
```

Each token is either a character

```ts
export interface Char {
	type: "char";
	value: string;
	fullWidth: boolean;
}
```

where

-   `value` is the string representation of the character
-   `fullWidth` is `true` if the character is full width (takes up 2 characters in monospace, like CJK characters)

or an ANSI code

```ts
export interface AnsiCode {
	type: "ansi";
	code: string;
	endCode: string;
}
```

where

-   `code` is the ANSI code that starts the style
-   and `endCode` is the corresponding ANSI code that ends the style.

An `AnsiCode` can also be an end code, in which case `code` and `endCode` will be the same.

### Convert an array of tokens into an array of "styled" chars

This representation is a 1:1 mapping of the original string, but not very useful for modifying the string. The `styledCharsFromTokens` function converts a token array to an array of characters, where each character has an all currently active styles associated with it:

```ts
export interface StyledChar {
	type: "char";
	value: string;
	fullWidth: boolean;
	styles: AnsiCode[];
}
```

Using the above example:

```js
import { tokenize, styledCharsFromTokens } from "@alcalzone/ansi-tokenize";

// red "foo", followed by unstyled "bar"
const str = "\x1B[31mfoo\x1B[39mbar";
const tokens = tokenize(str);

const styledChars = styledCharsFromTokens(tokens);

// styledChars will contain the following:
[
	{
		type: "char",
		value: "f",
		fullWidth: false,
		styles: [
			{
				type: "ansi",
				code: "\x1B[31m",
				endCode: "\x1B[39m",
			},
		],
	},
	{
		type: "char",
		value: "o",
		fullWidth: false,
		styles: [
			{
				type: "ansi",
				code: "\x1B[31m",
				endCode: "\x1B[39m",
			},
		],
	},
	{
		type: "char",
		value: "o",
		fullWidth: false,
		styles: [
			{
				type: "ansi",
				code: "\x1B[31m",
				endCode: "\x1B[39m",
			},
		],
	},
	{
		type: "char",
		value: "b",
		fullWidth: false,
		styles: [],
	},
	{
		type: "char",
		value: "a",
		fullWidth: false,
		styles: [],
	},
	{
		type: "char",
		value: "r",
		fullWidth: false,
		styles: [],
	},
];
```

### Modify an array of styled characters

For modification simply edit the items in the array as necessary, as long as the following rules are followed:

1. The `code` and `endCode` properties must match. You can use the `ansi-styles` module to do this.
2. The `fullWidth` property must be correct. You can use the `is-fullwidth-code-point` module to do this, or if working with multiple strings, turn those into styled char arrays first.

E.g. to make the first `o` blue and bold:

```js
import ansiStyles from "ansi-styles";

// ... include the above code

styledChars[1].styles = [
	{
		type: "ansi",
		code: ansiStyles.blue.open,
		endCode: ansiStyles.blue.close,
	},
	{
		type: "ansi",
		code: ansiStyles.bold.open,
		endCode: ansiStyles.bold.close,
	},
];
```

### Serialize a styled character array back to a string

The `styledCharsToString` function converts a styled character array back to a string:

```js
import { styledCharsToString } from "@alcalzone/ansi-tokenize";

// ... include the above code

const strOut = styledCharsToString(styledChars);

// str will now be '\x1B[31mf\x1B[34m\x1B[1mo\x1B[22m\x1B[31mo\x1B[39mbar'
```

This automatically figures out the least amount of escape codes necessary to achieve the desired result, as long as the `styles` arrays contain no unnecessary styles, e.g. blue + red foreground.

## Changelog

<!--
	Placeholder for next release:
	### __WORK IN PROGRESS__
-->
### 0.1.3 (2023-09-07)

-   Fix: Support links

### 0.1.2 (2023-08-07)

-   Fix: Reduce minimum Node.js version to `14.13.1`

### 0.1.1 (2023-04-05)

-   Fix: Active styles are now correctly reset at the end of the string

### 0.1.0 (2023-03-20)

Initial release
````

## 0ccbf956cffc8dcf

- class-variance-authority@0.7.1 — package/LICENSE

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   Copyright 2022 Joe Bell

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

## 0e4c9a9b6c71019c

- @floating-ui/core@1.8.0 — package/LICENSE
- @floating-ui/dom@1.8.0 — package/LICENSE
- @floating-ui/react-dom@2.1.9 — package/LICENSE
- @floating-ui/utils@0.2.12 — package/LICENSE

```text
MIT License

Copyright (c) 2021-present Floating UI contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## 0e80a2d229d2fd4f

- @radix-ui/primitive@1.1.7 — package/LICENSE
- @radix-ui/react-alert-dialog@1.1.24 — package/LICENSE
- @radix-ui/react-arrow@1.1.16 — package/LICENSE
- @radix-ui/react-checkbox@1.3.12 — package/LICENSE
- @radix-ui/react-compose-refs@1.1.5 — package/LICENSE
- @radix-ui/react-context@1.2.2 — package/LICENSE
- @radix-ui/react-dialog@1.2.0 — package/LICENSE
- @radix-ui/react-dismissable-layer@1.1.20 — package/LICENSE
- @radix-ui/react-focus-guards@1.1.6 — package/LICENSE
- @radix-ui/react-focus-scope@1.2.0 — package/LICENSE
- @radix-ui/react-id@1.1.4 — package/LICENSE
- @radix-ui/react-popper@1.3.8 — package/LICENSE
- @radix-ui/react-portal@1.1.18 — package/LICENSE
- @radix-ui/react-presence@1.1.11 — package/LICENSE
- @radix-ui/react-primitive@2.1.11 — package/LICENSE
- @radix-ui/react-slot@1.4.0 — package/LICENSE
- @radix-ui/react-tooltip@1.3.0 — package/LICENSE
- @radix-ui/react-use-callback-ref@1.1.4 — package/LICENSE
- @radix-ui/react-use-controllable-state@1.2.6 — package/LICENSE
- @radix-ui/react-use-effect-event@0.0.5 — package/LICENSE
- @radix-ui/react-use-layout-effect@1.1.4 — package/LICENSE
- @radix-ui/react-use-size@1.1.5 — package/LICENSE
- @radix-ui/react-visually-hidden@1.2.12 — package/LICENSE

```text
MIT License

Copyright (c) 2022 WorkOS

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 0ead7e8cd8b0bc66

- isobject@3.0.1 — package/LICENSE

```text
The MIT License (MIT)

Copyright (c) 2014-2017, Jon Schlinkert.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 181bc2685f0cea9d

- nanostores@1.4.2 — package/LICENSE

```text
The MIT License (MIT)

Copyright 2020 Andrey Sitnik <andrey@sitnik.es>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## 1e17b5dad50571c2

- unicode-animations@1.0.3 — package/package.json

```text
{
  "name": "unicode-animations",
  "version": "1.0.3",
  "description": "Unicode spinner animations as raw frame data",
  "type": "module",
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    },
    "./braille": {
      "import": {
        "types": "./dist/braille.d.ts",
        "default": "./dist/braille.js"
      },
      "require": {
        "types": "./dist/braille.d.cts",
        "default": "./dist/braille.cjs"
      }
    }
  },
  "bin": {
    "unicode-animations": "./scripts/demo.cjs"
  },
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": [
    "dist",
    "scripts"
  ],
  "sideEffects": false,
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "postinstall": "node scripts/postinstall.cjs",
    "prepublishOnly": "npm run build"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/gunnargray-dev/unicode-animations.git"
  },
  "homepage": "https://github.com/gunnargray-dev/unicode-animations",
  "keywords": [
    "braille",
    "spinner",
    "unicode",
    "animation",
    "loading",
    "cli",
    "terminal"
  ],
  "license": "MIT",
  "devDependencies": {
    "tsup": "^8.4.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  },
  "dependencies": {
    "unicode-animations": "^1.0.1"
  }
}
```

## 210b19e543130388

- tslib@2.8.1 — package/LICENSE.txt

```text
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

## 21b975c39532001d

- @xterm/addon-webgl@0.19.0 — package/LICENSE

```text
Copyright (c) 2018, The xterm.js authors (https://github.com/xtermjs/xterm.js)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 24eefa8efca11bec

- usehooks-ts@3.1.1 — package/LICENSE

```text
The MIT License (MIT)

Copyright (c) 2020 Julien CARON

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```

## 306fa513e39b23a6

- dequal@2.0.3 — package/license

```text
The MIT License (MIT)

Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 30f0cfddf483d112

- aria-hidden@1.2.6 — package/LICENSE
- react-remove-scroll@2.7.2 — package/LICENSE
- react-style-singleton@2.2.3 — package/LICENSE
- use-callback-ref@1.3.3 — package/LICENSE
- use-sidecar@1.1.3 — package/LICENSE

```text
MIT License

Copyright (c) 2017 Anton Korzunov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 3672fb6ef1c21457

- get-value@2.0.6 — package/LICENSE

```text
The MIT License (MIT)

Copyright (c) 2014-2016, Jon Schlinkert.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 40be7e7f17ab0f65

- leva@0.10.1 — package/LICENSE

```text
MIT License

Copyright (c) 2021 Poimandres

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 483acb265f182907

- emoji-regex@10.6.0 — package/LICENSE-MIT.txt

```text
Copyright Mathias Bynens <https://mathiasbynens.be/>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## 486442209236ffa3

- react-remove-scroll-bar@2.3.8 — package/README.md

````text
<h1>react-remove-scroll-bar</h1>

[![npm](https://img.shields.io/npm/v/react-remove-scroll-bar.svg)](https://www.npmjs.com/package/react-remove-scroll-bar)
[![bundle size](https://badgen.net/bundlephobia/minzip/react-remove-scroll-bar)](https://bundlephobia.com/result?p=react-remove-scroll-bar)
[![downloads](https://badgen.net/npm/dm/react-remove-scroll-bar)](https://www.npmtrends.com/react-remove-scroll-bar)

<hr />

> v1+ for React 15, v2+ requires React 16.8+

Removes scroll bar (by setting `overflow: hidden` on body), and preserves the scroll bar "gap".

Read - it just makes scroll bar invisible.

Does nothing if scroll bar does not consume any space.

# Usage

```js
import {RemoveScrollBar} from 'react-remove-scroll-bar';

<RemoveScrollBar /> -> no scroll bar
```

### The Right Border
To prevent content jumps __position:fixed__ elements with `right:0`  should have additional classname applied.
It will just provide a _non-zero_ right, when it needed, to maintain the right "gap".
```js
import {zeroRightClassName,fullWidthClassName, noScrollbarsClassName} from 'react-remove-scroll-bar';

// to set `right:0` on an element
<div className={zeroRightClassName} />

// to set `width:100%` on an element
<div className={fullWidthClassName} />

// to remove scrollbar from an element
<div className={noScrollbarsClassName} />

```

# Size
500b after compression (excluding tslib).

# Scroll-Locky
All code is a result of a [react-scroll-locky](https://github.com/theKashey/react-scroll-locky) refactoring.

# Article
There is a medium article about preventing the body scroll - [How to fight the <body> scroll](https://medium.com/@antonkorzunov/how-to-fight-the-body-scroll-2b00267b37ac)

# License
MIT
````

## 48da2f39e100d408

- escape-string-regexp@2.0.0 — package/license

```text
MIT License

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## 4922620a5741e9d1

- is-extendable@1.0.1 — package/LICENSE

```text
The MIT License (MIT)

Copyright (c) 2015-2017, Jon Schlinkert.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 49810fde850fee86

- convert-to-spaces@2.0.1 — package/license

```text
The MIT License (MIT)

Copyright (c) Vadim Demedes <vdemedes@gmail.com> (https://vadimdemedes.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 49d4d143fed599de

- bidi-js@1.1.0 — package/LICENSE.txt

```text
Copyright (c) 2021 Jason Johnston

MIT License

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## 4bcdc996eb4435db

- lucide-react@0.577.0 — package/dist/esm/icons/copyright.js.map

```text
{"version":3,"file":"copyright.js","sources":["../../../src/icons/copyright.ts"],"sourcesContent":["import createLucideIcon from '../createLucideIcon';\nimport { IconNode } from '../types';\n\nexport const __iconNode: IconNode = [\n  ['circle', { cx: '12', cy: '12', r: '10', key: '1mglay' }],\n  ['path', { d: 'M14.83 14.83a4 4 0 1 1 0-5.66', key: '1i56pz' }],\n];\n\n/**\n * @component @name Copyright\n * @description Lucide SVG icon component, renders SVG Element with children.\n *\n * @preview ![img](data:image/svg+xml;base64,PHN2ZyAgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIgogIHdpZHRoPSIyNCIKICBoZWlnaHQ9IjI0IgogIHZpZXdCb3g9IjAgMCAyNCAyNCIKICBmaWxsPSJub25lIgogIHN0cm9rZT0iIzAwMCIgc3R5bGU9ImJhY2tncm91bmQtY29sb3I6ICNmZmY7IGJvcmRlci1yYWRpdXM6IDJweCIKICBzdHJva2Utd2lkdGg9IjIiCiAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIgogIHN0cm9rZS1saW5lam9pbj0icm91bmQiCj4KICA8Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIgLz4KICA8cGF0aCBkPSJNMTQuODMgMTQuODNhNCA0IDAgMSAxIDAtNS42NiIgLz4KPC9zdmc+Cg==) - https://lucide.dev/icons/copyright\n * @see https://lucide.dev/guide/packages/lucide-react - Documentation\n *\n * @param {Object} props - Lucide icons props and any valid SVG attribute\n * @returns {JSX.Element} JSX Element\n *\n */\nconst Copyright = createLucideIcon('copyright', __iconNode);\n\nexport default Copyright;\n"],"names":[],"mappings":";;;;;;;;;AAGO,CAAA,CAAA,CAAA,CAAA,CAAA,CAAM,UAAA,CAAA,CAAA,CAAuB;AAAA,CAAA,CAClC,CAAC,QAAA,CAAA,CAAU,CAAA,CAAE,EAAA,CAAA,CAAI,CAAA,CAAA,CAAA,CAAA,EAAM,CAAA,CAAA,CAAA,CAAI,IAAA,CAAA,CAAM,CAAA,EAAG,CAAA,CAAA,CAAA,CAAA,CAAA,CAAM,GAAA,CAAA,CAAK,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,EAAU,CAAA;AAAA,CAAA,CACzD,CAAC,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAQ,CAAA,CAAE,GAAG,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAiC,CAAA,CAAA,CAAA,CAAA,CAAK,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,GAAU;AAChE,CAAA;AAaA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAM,SAAA,CAAA,CAAA,CAAY,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAiB,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,EAAa,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAA,CAAU,CAAA;;"}
```

## 4cd903859549d4b2

- is-plain-object@2.0.4 — package/LICENSE

```text
The MIT License (MIT)

Copyright (c) 2014-2017, Jon Schlinkert.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 4ec3d4c66cd87f5c

- semver@7.8.5 — package/LICENSE

```text
The ISC License

Copyright (c) Isaac Z. Schlueter and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## 5c932d88256b4ab9

- ansi-regex@6.4.0 — package/license
- ansi-styles@6.2.3 — package/license
- auto-bind@5.0.1 — package/license
- chalk@5.6.2 — package/license
- cli-boxes@3.0.0 — package/license
- get-east-asian-width@1.7.0 — package/license
- indent-string@5.0.0 — package/license
- is-fullwidth-code-point@4.0.0 — package/license
- string-width@7.2.0 — package/license
- strip-ansi@7.2.0 — package/license
- wrap-ansi@9.0.2 — package/license

```text
MIT License

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## 600a3c22d28e0c5d

- v8n@1.5.1 — package/LICENSE

```text
MIT License

Copyright (c) 2018 Bruno C. Couto

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 668dcc52803480e0

- lucide-react@0.577.0 — package/LICENSE

```text
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2026 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2026.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The MIT License (MIT) (for portions derived from Feather)

Copyright (c) 2013-2026 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 689ceb10716bd7a8

- @xterm/addon-web-links@0.12.0 — package/LICENSE

```text
Copyright (c) 2017, The xterm.js authors (https://github.com/xtermjs/xterm.js)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 7613d4594ee8b616

- colord@2.10.0 — package/LICENSE.md

```text
MIT License

Copyright (c) 2020 Vlad Shilov omgovich@ya.ru

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 77c9ee6a9c5d5782

- react-router@8.4.0 — package/LICENSE.md

```text
MIT License

Copyright (c) React Training LLC 2015-2019
Copyright (c) Remix Software Inc. 2020-2021
Copyright (c) Shopify Inc. 2022-2023

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 7b93b62069ec28d0

- react-dropzone@12.1.0 — package/LICENSE

```text
The MIT License (MIT)

Copyright (c) 2018 Param Aggarwal

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```

## 7d7f35d56cb3d987

- unicode-animations@1.0.3 — package/README.md

````text
# unicode-animations

Unicode spinner animations as raw frame data — no dependencies, works everywhere.

## Demo

See all 18 spinners animating live:

```bash
npx unicode-animations --web     # open browser demo
npx unicode-animations           # cycle through all in terminal
npx unicode-animations helix     # preview a specific spinner
npx unicode-animations --list    # list all spinners
```

## Install

```bash
npm install unicode-animations
```

## Quick start

```js
// ESM
import spinners from 'unicode-animations';

// CJS
const spinners = require('unicode-animations');
```

Each spinner is a `{ frames: string[], interval: number }` object.

## Examples

### CLI tool — spinner during async work

```js
import spinners from 'unicode-animations';

const { frames, interval } = spinners.braille;
let i = 0;

const spinner = setInterval(() => {
  process.stdout.write(`\r\x1B[2K  ${frames[i++ % frames.length]} Deploying to production...`);
}, interval);

await deploy();

clearInterval(spinner);
process.stdout.write('\r\x1B[2K  ✔ Deployed.\n');
```

### Reusable spinner helper

```js
import spinners from 'unicode-animations';

function createSpinner(msg, name = 'braille') {
  const { frames, interval } = spinners[name];
  let i = 0, text = msg;
  const timer = setInterval(() => {
    process.stdout.write(`\r\x1B[2K  ${frames[i++ % frames.length]} ${text}`);
  }, interval);

  return {
    update(msg) { text = msg; },
    stop(msg) { clearInterval(timer); process.stdout.write(`\r\x1B[2K  ✔ ${msg}\n`); },
  };
}

const s = createSpinner('Connecting to database...');
const db = await connect();
s.update(`Running ${migrations.length} migrations...`);
await db.migrate(migrations);
s.stop('Database ready.');
```

### Multi-step pipeline

```js
import spinners from 'unicode-animations';

async function runWithSpinner(label, fn, name = 'braille') {
  const { frames, interval } = spinners[name];
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r\x1B[2K  ${frames[i++ % frames.length]} ${label}`);
  }, interval);
  const result = await fn();
  clearInterval(timer);
  process.stdout.write(`\r\x1B[2K  ✔ ${label}\n`);
  return result;
}

await runWithSpinner('Linting...', lint, 'scan');
await runWithSpinner('Running tests...', test, 'helix');
await runWithSpinner('Building...', build, 'cascade');
await runWithSpinner('Publishing...', publish, 'braille');
```

### React component

```jsx
import { useState, useEffect } from 'react';
import spinners from 'unicode-animations';

function Spinner({ name = 'braille', children }) {
  const [frame, setFrame] = useState(0);
  const s = spinners[name];

  useEffect(() => {
    const timer = setInterval(
      () => setFrame(f => (f + 1) % s.frames.length),
      s.interval
    );
    return () => clearInterval(timer);
  }, [name]);

  return <span style={{ fontFamily: 'monospace' }}>{s.frames[frame]} {children}</span>;
}

// Usage: <Spinner name="helix">Generating response...</Spinner>
```

### Browser — status indicator

```js
import spinners from 'unicode-animations';

const el = document.getElementById('status');
const { frames, interval } = spinners.orbit;
let i = 0;

const spinner = setInterval(() => {
  el.textContent = `${frames[i++ % frames.length]} Syncing...`;
}, interval);

await sync();
clearInterval(spinner);
el.textContent = '✔ Synced';
```

## All spinners

### Classic braille

| Name | Preview | Interval |
|------|---------|----------|
| `braille` | `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏` | 80ms |
| `braillewave` | `⠁⠂⠄⡀` → `⠂⠄⡀⢀` | 100ms |
| `dna` | `⠋⠉⠙⠚` → `⠉⠙⠚⠒` | 80ms |

### Grid animations (braille)

| Name | Frames | Interval |
|------|--------|----------|
| `scan` | 10 | 70ms |
| `rain` | 12 | 100ms |
| `scanline` | 6 | 120ms |
| `pulse` | 5 | 180ms |
| `snake` | 16 | 80ms |
| `sparkle` | 6 | 150ms |
| `cascade` | 12 | 60ms |
| `columns` | 26 | 60ms |
| `orbit` | 8 | 100ms |
| `breathe` | 17 | 100ms |
| `waverows` | 16 | 90ms |
| `checkerboard` | 4 | 250ms |
| `helix` | 16 | 80ms |
| `fillsweep` | 11 | 100ms |
| `diagswipe` | 16 | 60ms |

## Custom spinners

Create your own braille spinners using the grid utilities:

```js
import { gridToBraille, makeGrid } from 'unicode-animations';

// Create a 4-row × 4-col grid
const grid = makeGrid(4, 4);
grid[0][0] = true;
grid[1][1] = true;
grid[2][2] = true;
grid[3][3] = true;

console.log(gridToBraille(grid)); // diagonal braille pattern
```

`makeGrid(rows, cols)` returns a `boolean[][]`. Set cells to `true` to raise dots. `gridToBraille(grid)` converts it to a braille string (2 dot-columns per character).

## API

### `Spinner`

```ts
interface Spinner {
  readonly frames: readonly string[];
  readonly interval: number;
}
```

### Exports from `'unicode-animations'`

| Export | Type |
|--------|------|
| `default` / `spinners` | `Record<BrailleSpinnerName, Spinner>` |
| `gridToBraille(grid)` | `(boolean[][]) => string` |
| `makeGrid(rows, cols)` | `(number, number) => boolean[][]` |
| `Spinner` | TypeScript interface |
| `BrailleSpinnerName` | Union type of all 18 spinner names |

### Exports from `'unicode-animations/braille'`

Same as above — the main entrypoint re-exports everything from the braille module.

## License

MIT
````

## 85c7bafaddedc271

- lucide-react@0.577.0 — package/dist/esm/icons/copyright.js

```text
/**
 * @license lucide-react v0.577.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */

import createLucideIcon from '../createLucideIcon.js';

const __iconNode = [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["path", { d: "M14.83 14.83a4 4 0 1 1 0-5.66", key: "1i56pz" }]
];
const Copyright = createLucideIcon("copyright", __iconNode);

export { __iconNode, Copyright as default };
//# sourceMappingURL=copyright.js.map
```

## 8df47c6ad9ac2c41

- qrcode@1.5.4 — package/license

```text
The MIT License (MIT)

Copyright (c) 2012 Ryan Day

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

```

## 9580cc528a1c38d1

- extend-shallow@3.0.2 — package/LICENSE
- mixin-deep@1.3.2 — package/LICENSE

```text
The MIT License (MIT)

Copyright (c) 2014-2015, 2017, Jon Schlinkert.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 9a9edad7baae5262

- clsx@2.1.1 — package/license

```text
MIT License

Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## 9b08de58a27cb575

- @nous-research/ui@0.19.1 — package/package.json

```text
{
  "name": "@nous-research/ui",
  "version": "0.19.1",
  "type": "module",
  "license": "MIT",
  "sideEffects": [
    "**/*.css"
  ],
  "files": [
    "dist",
    "src",
    "README.md",
    "CHANGELOG.md"
  ],
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./ui/*": {
      "types": "./dist/ui/*.d.ts",
      "import": "./dist/ui/*.js"
    },
    "./utils": {
      "types": "./dist/utils/index.d.ts",
      "import": "./dist/utils/index.js"
    },
    "./utils/*": {
      "types": "./dist/utils/*.d.ts",
      "import": "./dist/utils/*.js"
    },
    "./hooks/*": {
      "types": "./dist/hooks/*.d.ts",
      "import": "./dist/hooks/*.js"
    },
    "./fonts/*": "./dist/fonts/*",
    "./assets/*": "./dist/assets/*",
    "./styles/fonts.css": "./dist/ui/fonts.css",
    "./styles/globals.css": "./dist/ui/globals.css"
  },
  "scripts": {
    "dev": "storybook dev -p 6006",
    "prepublishOnly": "pnpm build",
    "build": "unbuild",
    "build:watch": "unbuild --watch",
    "build-storybook": "storybook build -o storybook-static",
    "test": "pnpm type-check",
    "test-storybook": "vitest --project=storybook",
    "type-check": "tsc -p tsconfig.build.json --noEmit"
  },
  "dependencies": {
    "@nanostores/react": "^1.1.0",
    "radix-ui": "^1.4.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "nanostores": "^1.3.0",
    "sanitize-html": "^2.17.4",
    "tailwind-merge": "^3.6.0",
    "tw-animate-css": "^1.4.0",
    "unicode-animations": "^1.0.3"
  },
  "devDependencies": {
    "@observablehq/plot": "^0.6.17",
    "@react-three/fiber": "^9.6.1",
    "@storybook/addon-a11y": "^10.4.0",
    "@storybook/addon-docs": "^10.4.0",
    "@storybook/addon-vitest": "^10.4.0",
    "@storybook/react-vite": "^10.4.0",
    "@tailwindcss/cli": "^4.3.0",
    "@tailwindcss/vite": "^4.3.0",
    "@types/node": "25.8.0",
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "@types/sanitize-html": "^2.16.1",
    "@types/three": "^0.184.1",
    "@vitejs/plugin-react": "^6.0.2",
    "@vitest/browser-playwright": "^4.1.6",
    "glob": "^13.0.6",
    "gsap": "^3.15.0",
    "leva": "^0.10.1",
    "mockdate": "^3.0.5",
    "motion": "^12.38.0",
    "msw": "^2.14.6",
    "msw-storybook-addon": "^2.0.7",
    "playwright": "^1.60.0",
    "storybook": "^10.4.0",
    "tailwindcss": "^4.3.0",
    "three": "^0.184.0",
    "typescript": "^6.0.3",
    "unbuild": "^3.6.1",
    "vite": "^8.0.13",
    "vite-plugin-static-copy": "^4.1.0",
    "vitest": "^4.1.6"
  },
  "peerDependencies": {
    "@observablehq/plot": "^0.6.17",
    "@react-three/fiber": "^9.4.0",
    "gsap": "^3.13.0",
    "leva": "^0.10.1",
    "motion": "^12.38.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "three": "^0.180.0"
  },
  "peerDependenciesMeta": {
    "three": {
      "optional": true
    },
    "@react-three/fiber": {
      "optional": true
    },
    "@observablehq/plot": {
      "optional": true
    },
    "leva": {
      "optional": true
    },
    "gsap": {
      "optional": true
    }
  },
  "msw": {
    "workerDirectory": [
      "public"
    ]
  }
}
```

## 9b9624d7c0473fd0

- @nanostores/react@1.1.0 — package/LICENSE

```text
The MIT License (MIT)

Copyright 2020 Andrey Sitnik <andrey@sitnik.ru>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## 9be2ec8089dfa405

- stack-utils@2.0.6 — package/LICENSE.md

```text
The MIT License (MIT)

Copyright (c) 2016-2022 Isaac Z. Schlueter <i@izs.me>, James Talmage <james@talmage.io> (github.com/jamestalmage), and Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## a21d6c8d3fc63119

- undici@6.29.0 — package/lib/web/fetch/LICENSE

```text
MIT License

Copyright (c) 2020 Ethan Arrowood

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## a6db8096b2707bc0

- undici@6.29.0 — package/LICENSE

```text
MIT License

Copyright (c) Matteo Collina and Undici contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## acf3b087b348d2f2

- get-nonce@1.0.1 — package/LICENSE

```text
MIT License

Copyright (c) 2020 Anton Korzunov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## af56036bb4101313

- @nous-research/ui@0.19.1 — package/README.md

````text
# nous ui

the shared design system for react ui @ nous. components, hooks, utils, fonts, overlays, etc.

## setup

`npm i @nous-research/ui` or `pnpm i @nous-research/ui`

import the global styles in your app's root css file:

```css
@import 'tailwindcss';
@import '@nous-research/ui/styles/globals.css';
```

`globals.css` includes the design-system tokens, utilities, component styles,
and default `--font-*` variable values, but does not register font files.
Import the optional font stylesheet first if your app wants CSS-managed
`@font-face` declarations:

```css
@import 'tailwindcss';
@import '@nous-research/ui/styles/fonts.css';
@import '@nous-research/ui/styles/globals.css';
```

Next.js apps should prefer `next/font/local` with the exported
`@nous-research/ui/fonts/*` files and map them to the same `--font-*`
variables. Apps can also provide their own `--font-*` variables while keeping
the design-system utilities from `globals.css`.

## usage

everything exports from the top level export:

```tsx
import {
  Button,
  Grid
  // whatever else!
} from '@nous-research/ui'
```

## local development

two ways to preview components while editing:

### storybook (per-component, primary)

```
pnpm storybook        # dev server on http://localhost:6006
pnpm build-storybook  # static build → ./storybook-static
```

stories live in `stories/*.stories.tsx`. the **Overview** story re-renders
the entire `/ds` page, so you always have a kitchen-sink view alongside the
isolated component stories. the **Lens** toolbar above the preview cycles
between the lens presets (`0`, `1`, `2`, `3`, `4`, `5`, `5i`, `6`).

### next.js showcase (kitchen-sink, secondary)

```
pnpm dev              # next dev on http://localhost:3000 → redirects to /ds
```

`app/ds/page.tsx` is the same content the Overview story renders.

## publishing

```
pnpm build     # tsc → dist/ + copies css / fonts / assets
```

releases are published automatically when PRs merge to `main`. the github
workflow bumps the package version from the merged PR labels (`major`, `minor`,
or `patch`), pushes the tag, publishes to npm via trusted publishing, and
creates a [GitHub Release](https://github.com/NousResearch/design-language/releases)
with notes from `CHANGELOG.md`.

before merging:

1. leave `package.json` at the **current published** version on `main` (CI bumps
   it after merge).
2. label the PR so the bump matches your changelog section:

| PR label | bump from `0.15.0` | changelog heading |
| --- | --- | --- |
| `patch` (default) | `0.15.1` | `## 0.15.1` |
| `minor` | `0.16.0` | `## 0.16.0` |
| `major` | `1.0.0` | `## 1.0.0` |

3. add that `## X.Y.Z` section to [`CHANGELOG.md`](./CHANGELOG.md) — release
   notes are pulled from it for npm and GitHub Releases.

the same file is rendered in Storybook under **Docs → Changelog** and shipped in
the npm tarball.

the published tarball ships `dist/`, `src/`, `README.md`, and `CHANGELOG.md`
(see `files` in `package.json`). inline source maps are embedded in `dist/` so
consumers can debug into the TypeScript source.

## deployment

`vercel.json` builds both and serves them on a single Next.js deployment:

- `/` and `/ds` — the Next.js showcase (same as `pnpm dev`)
- `/storybook` — the static Storybook build (copied to `public/storybook/`
  before `next build` so Next serves it like any other static asset)

Want Storybook-only? replace `buildCommand` with `pnpm build-storybook` and
add `"outputDirectory": "storybook-static"`. `app/ds` can stay for local
`pnpm dev` either way — the Overview story renders the same content.
````

## b173e19b9a78df30

- signal-exit@4.1.0 — package/LICENSE.txt

```text
The ISC License

Copyright (c) 2015-2023 Benjamin Coe, Isaac Z. Schlueter, and Contributors

Permission to use, copy, modify, and/or distribute this software
for any purpose with or without fee is hereby granted, provided
that the above copyright notice and this permission notice
appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES
OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE
LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## b53ca5a0db1b0778

- code-excerpt@4.0.0 — package/license

```text
The MIT License (MIT)

Copyright (c) Vadim Demedes <vdemedes@gmail.com> (github.com/vadimdemedes)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## b569f629d00f2626

- @xterm/xterm@6.0.0 — package/LICENSE

```text
Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## b99672ef9af57432

- @use-gesture/core@10.3.1 — package/LICENSE
- @use-gesture/react@10.3.1 — package/LICENSE

```text
Copyright (c) 2018-present Paul Henschel <drcmda@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## c1e6e26656351746

- zustand@3.7.2 — package/LICENSE

```text
MIT License

Copyright (c) 2019 Paul Henschel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## c46324e45a005413

- dijkstrajs@1.0.3 — package/LICENSE.md

````text
```
Dijkstra path-finding functions. Adapted from the Dijkstar Python project.

Copyright (C) 2008
  Wyatt Baldwin <self@wyattbaldwin.com>
  All rights reserved

Licensed under the MIT license.

  http://www.opensource.org/licenses/mit-license.php

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
````

## c779efe5dfb04b7b

- react-colorful@5.8.1 — package/LICENSE

```text
MIT License

Copyright (c) 2020-present Vlad Shilov <omgovich@ya.ru>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## d4c70c7ce38cea87

- tailwind-merge@3.7.0 — package/LICENSE.md

```text
MIT License

Copyright (c) 2021 Dany Castillo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## d75a1dcd72166929

- attr-accept@2.2.5 — package/LICENSE

```text
The MIT License (MIT)

Copyright (c) 2015 Andrey Okonetchnikov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```

## da6d3703ed11cbe4

- react-dom@19.3.0 — package/LICENSE
- react-reconciler@0.33.0 — package/LICENSE
- react@19.3.0 — package/LICENSE
- scheduler@0.27.0 — package/LICENSE
- scheduler@0.28.0 — package/LICENSE

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## daca23d50b0f54d3

- extend-shallow@2.0.1 — package/LICENSE

```text
The MIT License (MIT)

Copyright (c) 2014-2015, Jon Schlinkert.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## e256f01188af527e

- @xterm/addon-fit@0.11.0 — package/LICENSE
- @xterm/addon-unicode11@0.9.0 — package/LICENSE

```text
Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## e372f857ce05f266

- react-remove-scroll-bar@2.3.8 — package/package.json

```text
{
  "name": "react-remove-scroll-bar",
  "version": "2.3.8",
  "description": "Removes body scroll without content _shake_",
  "main": "dist/es5/index.js",
  "jsnext:main": "dist/es2015/index.js",
  "module": "dist/es2015/index.js",
  "types": "dist/es5/index.d.ts",
  "scripts": {
    "dev": "lib-builder dev",
    "test": "jest",
    "test:ci": "jest --runInBand --coverage",
    "build": "lib-builder build && yarn size:report",
    "release": "yarn build && yarn test",
    "size": "yarn size-limit",
    "size:report": "yarn --silent size-limit --json > .size.json",
    "lint": "lib-builder lint",
    "format": "lib-builder format",
    "update": "lib-builder update",
    "prepublish": "yarn build && yarn changelog",
    "changelog": "conventional-changelog -p angular -i CHANGELOG.md -s",
    "changelog:rewrite": "conventional-changelog -p angular -i CHANGELOG.md -s -r 0",
    "storybook": "start-storybook -p 6006"
  },
  "keywords": [
    "scroll"
  ],
  "author": "Anton Korzunov <thekashey@gmail.com>",
  "license": "MIT",
  "devDependencies": {
    "@size-limit/preset-small-lib": "^11.0.2",
    "size-limit": "^11.0.2",
    "@storybook/react": "^6.4.22",
    "@testing-library/react": "^12.1.5",
    "@types/react": "^16.14.56",
    "@theuiteam/lib-builder": "^0.1.4",
    "react": "^16.8.6",
    "react-dom": "^16.8.6"
  },
  "engines": {
    "node": ">=10"
  },
  "peerDependencies": {
    "@types/react": "*",
    "react": "^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0"
  },
  "peerDependenciesMeta": {
    "@types/react": {
      "optional": true
    }
  },
  "files": [
    "dist",
    "constants"
  ],
  "repository": "https://github.com/theKashey/react-remove-scroll-bar",
  "dependencies": {
    "react-style-singleton": "^2.2.2",
    "tslib": "^2.0.0"
  },
  "module:es2019": "dist/es2019/index.js",
  "husky": {
    "hooks": {
      "pre-commit": "lint-staged"
    }
  },
  "lint-staged": {
    "*.{ts,tsx}": [
      "prettier --write",
      "eslint --fix",
      "git add"
    ],
    "*.{js,css,json,md}": [
      "prettier --write",
      "git add"
    ]
  },
  "prettier": {
    "printWidth": 120,
    "trailingComma": "es5",
    "tabWidth": 2,
    "semi": true,
    "singleQuote": true
  }
}
```

## ea48daa7b5303f76

- @stitches/react@1.2.8 — https://raw.githubusercontent.com/stitchesjs/stitches/c268db3938e2cf6bdbaa3d30f3ce7b67c0492a41/LICENSE.md

```text
MIT License

Copyright (c) 2020 Modulz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## f2274cb4b0e7ce5e

- merge-value@1.0.0 — package/LICENSE
- split-string@3.1.0 — package/LICENSE

```text
The MIT License (MIT)

Copyright (c) 2015-2017, Jon Schlinkert.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## f4a48aa8354a2577

- for-in@1.0.2 — package/LICENSE
- set-value@2.0.1 — package/LICENSE

```text
The MIT License (MIT)

Copyright (c) 2014-2017, Jon Schlinkert

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## f657f99d3fb9647d

- prop-types@15.8.1 — package/LICENSE

```text
MIT License

Copyright (c) 2013-present, Facebook, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## f71e8ed126b46346

- lodash-es@4.18.1 — package/LICENSE

```text
Copyright OpenJS Foundation and other contributors <https://openjsf.org/>

Based on Underscore.js, copyright Jeremy Ashkenas,
DocumentCloud and Investigative Reporters & Editors <http://underscorejs.org/>

This software consists of voluntary contributions made by many
individuals. For exact contribution history, see the revision history
available at https://github.com/lodash/lodash

The following license applies to all parts of this software except as
documented below:

====

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

====

Copyright and related rights for sample code are waived via CC0. Sample
code is defined as all source code displayed within the prose of the
documentation.

CC0: http://creativecommons.org/publicdomain/zero/1.0/

====

Files located in the node_modules and vendor directories are externally
maintained libraries used by this software which have their own
licenses; we recommend you read them, as their terms may differ from the
terms above.
```

## ffd8b33b354585f4

- lodash.debounce@4.0.8 — package/LICENSE

```text
Copyright jQuery Foundation and other contributors <https://jquery.org/>

Based on Underscore.js, copyright Jeremy Ashkenas,
DocumentCloud and Investigative Reporters & Editors <http://underscorejs.org/>

This software consists of voluntary contributions made by many
individuals. For exact contribution history, see the revision history
available at https://github.com/lodash/lodash

The following license applies to all parts of this software except as
documented below:

====

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

====

Copyright and related rights for sample code are waived via CC0. Sample
code is defined as all source code displayed within the prose of the
documentation.

CC0: http://creativecommons.org/publicdomain/zero/1.0/

====

Files located in the node_modules and vendor directories are externally
maintained libraries used by this software which have their own
licenses; we recommend you read them, as their terms may differ from the
terms above.
```
