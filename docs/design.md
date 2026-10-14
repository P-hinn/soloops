# Design system

The interface borrows its visual language from philippniestroj.com. The tokens
live in one place, [`apps/web/src/style.css`](../apps/web/src/style.css), and are
identical to the website's:

| Token                            | Value                 | Role                                 |
| -------------------------------- | --------------------- | ------------------------------------ |
| `--color-paper`                  | `#f1efe8`             | warm off-white, the base surface     |
| `--color-ink`                    | `#171714`             | text, primary button, strong borders |
| `--color-soft` / `--color-muted` | `#575750` / `#6c6b64` | body copy, secondary text            |
| `--color-acid`                   | `#d8ff55`             | lime — the one loud accent           |
| `--color-blue`                   | `#5c76ff`             | kicker labels and links              |
| `--color-line`                   | `rgba(23,23,20,.15)`  | hairline                             |

Three rules carry the look:

1. **Radius 0 everywhere — except buttons.** Surfaces, cards, inputs and badges
   have sharp corners; buttons are always full pills.
2. **Lines instead of boxes.** Tables and grids are structured by hairlines,
   not by raised boxes. Key figures sit under a heavy top rule, without a frame.
3. **Kicker labels.** Sections don't carry an `<h2>` at body size but a small,
   letterspaced uppercase label in blue (`.eyebrow`).

Type: **Space Grotesk** (variable 400–700, self-hosted under
`apps/web/public/fonts/`) for headings, numbers and anything tabular;
Helvetica Neue/Arial for body copy. Digits are tabular throughout so that
amounts and durations line up in columns.

Reusable classes: `.card`, `.btn-primary` / `.btn-ghost` / `.btn-acid` /
`.btn-xs`, `.input`, `.label`, `.badge` (+ `-acid` / `-good` / `-warn` / `-bad` /
`-blue`), `.table`, `.eyebrow`, `.display-xl`, `.prose-note`.
