#!/usr/bin/env python3
"""
Build assets/sig-tokens.css for the Signature Society Shopify theme.

    python3 build-theme-css.py

Reads css/tokens.css and css/typography.css, strips the legacy alias
layer that only the guidelines document needs, repoints the logo URLs
at the Shopify CDN, and writes the result to

    ~/signaturesociety-theme/assets/sig-tokens.css

The output is a generated file. Edit css/tokens.css or
css/typography.css and re-run this, never the other way round.
"""
import re, pathlib

SRC = pathlib.Path("/Users/lindsayyoung/Library/CloudStorage/GoogleDrive-lindsay@lindsaydev.com/My Drive/CLIENTS/LE_FLEUR_SOCIETY/SIG_SOCIETY/2026/WBD/SIG_2026_WBD_Main/css")
OUT = pathlib.Path("/Users/lindsayyoung/signaturesociety-theme/assets/sig-tokens.css")

tokens = SRC.joinpath("tokens.css").read_text()
typo   = SRC.joinpath("typography.css").read_text()

# --- tokens.css: drop the header block, the @font-face, and section 23 -------
start = tokens.index("/* ============================================================\n   2 · ROOT SIZE")
end   = tokens.index("/* ============================================================\n   23 · LEGACY ALIASES")
tokens = tokens[start:end]

# drop the "Legacy aliases, restated" tail inside the dark block
tokens = re.sub(
    r"\n  /\* ---- Legacy aliases, restated so the remap reaches them ---- \*/.*?\n\}\n",
    "\n}\n", tokens, flags=re.S)

# drop the timeline-only legacy form-colour block
tokens = re.sub(
    r"/\* Deliberately NOT folded into the block above.*?\n\}\n\n", "", tokens, flags=re.S)

# this build has no #tab-timeline panel and no legacy aliases, so trim both
tokens = tokens.replace("""
   #tab-timeline is listed because it IS a dark document: it sits on
   1-900 with light type. Saying so once means its controls read the
   dark tokens without every one of them carrying an .on-dark class.

   Both the --sig-* roles AND their legacy aliases are restated here.
   An alias declared only in :root computes against :root's value and
   is then inherited as that fixed colour, so it would not follow the
   remap on a descendant.
""", """
   Only the --sig-* roles are restated. A token declared once in
   :root computes against :root and is then inherited as that fixed
   value, so it would not follow the remap on a descendant.
""")
tokens = tokens.replace('[data-surface="dark"],\n.on-dark,\n#tab-timeline {', '[data-surface="dark"],\n.on-dark {')

# the dark scheme swap still has to happen for .on-dark; re-add a minimal version
tokens = tokens.replace(
    "  --sig-field-caret:          var(--sig-color-1-300);\n",
    "  --sig-field-caret:          var(--sig-color-1-300);\n\n"
    "  /* Which palette the browser draws its OWN parts with — the date\n"
    "     picker, the select arrow, the scrollbar inside a multi-select.\n"
    "     They follow color-scheme, not the fill. */\n"
    "  --sig-field-scheme: dark;\n")

# drop legacy names from the prefers-contrast block
tokens = re.sub(r"\n *--field-border: +var\(--sig-color[^\n]*", "", tokens)
tokens = re.sub(r"\n *--field-placeholder: +var\(--sig-color[^\n]*", "", tokens)

# --- typography.css: drop the header block and the legacy class aliases ------
tstart = typo.index("/* ============================================================\n   HEADING 1")
tend   = typo.index("/* ============================================================\n   LEGACY CLASS ALIASES")
typo = typo[tstart:tend]

CDN = "https://cdn.shopify.com/s/files/1/0734/5176/5871/files/"
tokens = (tokens
  .replace('url("../assets/SIG_LOGO_LOGOTYPE_WHITE.svg")', f'url("{CDN}SIG_LOGO_LOGOTYPE_WHITE.svg?v=1785988734")')
  .replace('url("../assets/SIG_LOGO_PRIMARY_WHITE.svg")',  f'url("{CDN}SIG_LOGO_PRIMARY_WHITE.svg?v=1785988726")')
  .replace('url("../assets/SIG_LOGO_LOGOMARK_WHITE.svg")', f'url("{CDN}SIG_LOGO_LOGOMARK_WHITE.svg?v=1785988717")'))

HEADER = '''/* ============================================================
   SIGNATURE SOCIETY · DESIGN TOKENS + TYPOGRAPHY
   Portable build for the Shopify theme.
   ------------------------------------------------------------
   GENERATED FILE. The source of truth is

       SIG_2026_WBD_Main/css/tokens.css
       SIG_2026_WBD_Main/css/typography.css

   Edit there, then re-run the build. Editing this file directly
   means the next build silently reverts it.

   This build drops the legacy --face-*, --heading-*, --body-*,
   --color1-* alias layer that the guidelines document still
   needs. Everything here is --sig-* prefixed, so it cannot
   collide with theme.css, which owns unprefixed names such as
   --heading-font-family.

   REQUIRES, in layout/theme.liquid <head>, before this file:

       <link rel="preconnect" href="https://use.typekit.net" crossorigin>
       <link rel="stylesheet" href="https://use.typekit.net/hqq5dii.css">
       <link rel="stylesheet"
             href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap">

   Kepler Std comes from the Adobe kit; Inter from Google Fonts,
   because the Adobe kit publishes inter-18pt at weight 400 only
   and the system needs a real 500 for form labels and eyebrows.

   NOTE ON THE ROOT SIZE. Section 2 sets html { font-size: 112.5% }
   so that 1rem = 18px, which is the base of the scale. theme.css
   was written against the browser default of 16px, so every rem in
   it renders 12.5% larger once this file loads. That is the
   intended behaviour of an 18px-based scale, but it IS a global
   change — if the theme's own spacing needs to stay where it is,
   delete section 2 and the rem tokens below will resolve against
   16px instead (18px steps become 20px, and so on).
   ============================================================ */


/* ============================================================
   1 · FONT LOADING
   PP Playground is served from the Shopify CDN. Declared across
   the full weight range because only one cut is uploaded: this
   stops the browser synthesising a faux bold or light for the
   weights the ramp does not ship.
   ============================================================ */

@font-face {
  font-family: "PP Playground";
  src: url("''' + CDN + '''PPPlayground-Medium.ttf?v=1783550925") format("truetype");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}


'''

OUT.write_text(HEADER + tokens.rstrip() + "\n\n\n" + typo.rstrip() + "\n")
print("wrote", OUT, OUT.stat().st_size, "bytes")
