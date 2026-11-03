# Third-party notices

Pi Accanto's original code and companion SVG/derived PNG artwork are covered by
[MIT](LICENSE). Dependencies retain their own licenses. Browser UI shown in
documentation screenshots is not part of the original artwork license.

`npm run build` inventories the packages actually included in both JavaScript
bundles and the locally copied Basecoat/Tailwind CSS distribution. It copies their license/notice files into `dist/third-party/` and writes
an index with versions and declared licenses. Keep that directory, `dist/licenses/`,
this notice and `LICENSE` when distributing the extension. PDF font/CMap license files are
also retained beside those resources.

The current bundles use MIT-licensed Basecoat, Tailwind CSS, Pi packages, TypeBox, partial-json, marked,
quickjs-wasi and Anthropic SDK, Apache-2.0-licensed OpenAI SDK, Google Gen AI SDK
and PDF.js, and DOMPurify under
its offered Apache-2.0 alternative (the package also offers MPL-2.0). PDF.js's
bundled fonts and CMaps carry additional notices; see
`standard_fonts/LICENSE_*` and `cmaps/LICENSE` in `dist`.

**Liberation font exception:** PDF.js bundles unmodified Liberation Sans 1.07.4
under GPL v2 with the Liberation font exception, not the SIL OFL used by newer
Liberation releases. See the [PDF.js font provenance](https://github.com/mozilla/pdf.js/blob/master/external/standard_fonts/README.md).
The build retains the complete supplied license. Before redistributing a
prebuilt extension containing these fonts, satisfy the GPL's corresponding-source
requirements for the font software; a license file or source-project link alone
is not a substitute for those requirements. This preparation does not publish a
prebuilt extension. Building privately from the source repository is separate
from redistributing that bundle. Do not replace the fonts with a newer version
without checking PDF.js's glyph-order/metric compatibility.

Some Pi npm packages omit their MIT license file. Their notice is vendored from
the [Pi v1.4.0 root license](https://github.com/earendil-works/pi/blob/v1.4.0/LICENSE)
as [licenses/PI-LICENSE](licenses/PI-LICENSE), and copied for each bundled MIT Pi
package.

standardwebhooks 1.1.1 also omits its license in the npm package. Its MIT notice
is vendored as [licenses/STANDARDWEBHOOKS-LICENSE](licenses/STANDARDWEBHOOKS-LICENSE)
from [the libraries license at its published git revision](https://github.com/standard-webhooks/standard-webhooks/blob/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/libraries/LICENSE).
The build copies it for that exact package version.

quickjs-wasi's wrapper license does not replace the engine's copyright notices.
[licenses/QUICKJS-NG-LICENSE](licenses/QUICKJS-NG-LICENSE) is from engine revision
[`6d46d07`](https://github.com/quickjs-ng/quickjs/blob/6d46d07d04041b40f4f49eaa7fdebe44c314c699/LICENSE),
the submodule pinned by
[quickjs-wasi@3.6.2](https://github.com/vercel-labs/quickjs-wasi/tree/quickjs-wasi%403.6.2).
Both wrapper and engine notices are included in the built distribution.

Build/test tooling is not shipped as extension runtime code. Its package licenses
remain in `node_modules`. Search and model services have their own terms and
data policies; this project's MIT license does not grant service access or
search-result storage rights.
