# Bundled Lapis

Source: https://github.com/donkuri/lapis at commit
`f4eb29bd4129ae1dde068c64cf6557b7603462dc`, retrieved 2026-09-30.
Lapis authors: Ruri, itokatsu, kuri and upstream contributors.
License: GPL-3.0 (see LICENSE.txt). No warranty.

front.html, back.html, styling.css, anki_fields.yaml, genapkg.py and
UPSTREAM.md are unmodified upstream source. Komori creates only the Lapis
model with the upstream Mining template, ordered fields and CSS. No deck,
sample notes or example media are imported. The templates have inline SVG
and scripts but no required external assets. System fonts are used.
Komori's mapping language is separate and never evaluates scripts.

Lapis includes logic from rudnam's JP-study (https://github.com/rudnam/JP-study)
with modifications. The permission for that reuse is recorded by the Lapis
authors in their README, kept here as UPSTREAM.md (Acknowledgements: "allowed
us to reuse their code"). Komori relies on that statement and on Lapis's
GPL-3.0 grant; it adds no JP-study code of its own.
