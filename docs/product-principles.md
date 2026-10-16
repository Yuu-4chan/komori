# Product principles

## Core rule

Build the smallest useful layer, use it with real files, fix what reality exposes, then add the next layer.

## Product priorities

- Lightweight, responsive, fast desktop application.
- A feature exists only when it works in the real desktop app with real files.
- Unit tests and synthetic fixtures are necessary, not sufficient.
- Manual real-world failures outrank green synthetic tests; the fix should improve both implementation and coverage.
- Visual polish must not block core Reader/Library/Dictionary functionality.

## Reader principles

- Keep EPUB rendering replaceable.
- Store reading position semantically using Komori-owned locators; renderer-specific CFI is only an optional precision hint.
- Keep writing mode, CSS direction, package page progression, spine order, navigation direction, image layout, and scroll direction as separate concepts.
- Writing mode is a saved reader choice, Horizontal (the default) or Vertical, applied to every reflowable book; fixed-layout pages keep their own geometry.
- Text and image presentation are isolated. Image layout must not alter normal text-page geometry.
- View mode (continuous, semi-continuous, paginated or VN) is independent of writing mode.
- Continuous view keeps stable whole-book geometry rather than a scrollbar that grows as chapters lazily appear.
- Renderer transitions are serialized: capture locator → lock interaction → rebuild/reflow → restore locator → unlock.
- Reader settings use concrete bounded controls where practical instead of vague presets.

## UX principles

- Desktop-first but responsive across common desktop widths.
- Reuse consistent primitives instead of page-specific recreations of buttons, dropdowns, cards, toggles, and popovers.
- Branding artwork is replaceable; layouts do not depend on a particular logo or icon asset.
