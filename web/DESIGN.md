---
name: SqlMyPg
description: A Postgres client built as a modern desktop developer tool. System UI sans for the interface, mono only for SQL and data, layered blue-grey planes, one blue accent.
colors:
  bg: "#0f1115"
  surface: "#15181e"
  elevated: "#1b1f27"
  hover: "#212632"
  line: "#242932"
  line-strong: "#333a45"
  fg: "#e8ebf0"
  muted: "#9aa3b2"
  faint: "#6e7887"
  accent: "#1f6feb"
  accent-text: "#6ea8ff"
  accent-fg: "#ffffff"
  accent-soft: "#16304f"
  ok: "#3fb950"
  warn: "#d29922"
  danger: "#f85149"
  danger-soft: "#2d1416"
  ident: "#79c0ff"
  bg-light: "#ffffff"
  surface-light: "#f5f6f8"
  elevated-light: "#ffffff"
  hover-light: "#eceef1"
  line-light: "#e2e5ea"
  line-strong-light: "#ccd1d9"
  fg-light: "#1b1f24"
  muted-light: "#57606a"
  faint-light: "#7d8590"
  accent-light: "#1f6feb"
  accent-text-light: "#1257c9"
  accent-fg-light: "#ffffff"
  accent-soft-light: "#ddf0ff"
  ok-light: "#166d2f"
  warn-light: "#8a5a00"
  danger-light: "#cf222e"
  danger-soft-light: "#ffebe9"
  ident-light: "#0550ae"
typography:
  display:
    fontFamily: "'Segoe UI Variable Display', 'Segoe UI', -apple-system, BlinkMacSystemFont, ui-sans-serif, Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "34px"
    fontWeight: 600
    lineHeight: "42px"
    letterSpacing: "-0.02em"
  hero:
    fontFamily: "'Segoe UI Variable Display', 'Segoe UI', -apple-system, BlinkMacSystemFont, ui-sans-serif, Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: "34px"
  title:
    fontFamily: "'Segoe UI Variable Display', 'Segoe UI', -apple-system, BlinkMacSystemFont, ui-sans-serif, Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "28px"
  subtitle:
    fontFamily: "'Segoe UI Variable Display', 'Segoe UI', -apple-system, BlinkMacSystemFont, ui-sans-serif, Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "24px"
  body:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', -apple-system, BlinkMacSystemFont, ui-sans-serif, Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
    letterSpacing: "normal"
  panel-title:
    fontFamily: "'Segoe UI Variable Display', 'Segoe UI', -apple-system, BlinkMacSystemFont, ui-sans-serif, Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "20px"
  data:
    fontFamily: "'JetBrains Mono', 'Cascadia Mono', 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
    fontFeature: "tabular-nums"
  label:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', -apple-system, BlinkMacSystemFont, ui-sans-serif, Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "18px"
  micro:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', -apple-system, BlinkMacSystemFont, ui-sans-serif, Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "16px"
rounded:
  xs: "3px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "999px"
spacing:
  "0.5": "2px"
  "1": "4px"
  "1.5": "6px"
  "2": "8px"
  "2.5": "10px"
  "3": "12px"
  "3.5": "14px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
  "14": "56px"
shadows:
  sm: "0 1px 2px 0 rgb(0 0 0 / 0.5)"
  md: "0 2px 6px -1px rgb(0 0 0 / 0.5), 0 1px 2px -1px rgb(0 0 0 / 0.5)"
  lg: "0 12px 32px -8px rgb(0 0 0 / 0.65), 0 4px 8px -4px rgb(0 0 0 / 0.5)"
  sm-light: "0 1px 2px 0 rgb(31 35 40 / 0.12)"
  md-light: "0 2px 6px -1px rgb(31 35 40 / 0.12), 0 1px 2px -1px rgb(31 35 40 / 0.12)"
  lg-light: "0 12px 32px -8px rgb(31 35 40 / 0.2), 0 4px 8px -4px rgb(31 35 40 / 0.12)"
components:
  button-default:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.fg}"
    borderColor: "{colors.line-strong}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
    shadow: "{shadows.sm}"
  button-default-hover:
    backgroundColor: "{colors.hover}"
    borderColor: "{colors.faint}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
    borderColor: "{colors.accent}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
    shadow: "{shadows.sm}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.fg}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
    height: "32px"
  button-danger-hover:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
  button-sm:
    height: "28px"
    padding: "0 8px"
    typography: "{typography.label}"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    height: "32px"
  input:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.fg}"
    borderColor: "{colors.line-strong}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  input-focus:
    borderColor: "{colors.accent}"
    ring: "2px {colors.accent} / 30%"
  badge-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    borderColor: "{colors.line-strong}"
    rounded: "{rounded.full}"
    typography: "{typography.micro}"
    padding: "0 8px"
    height: "20px"
  badge-accent:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.full}"
    typography: "{typography.micro}"
    height: "20px"
  badge-ok:
    textColor: "{colors.ok}"
    rounded: "{rounded.full}"
    typography: "{typography.micro}"
    height: "20px"
  badge-warn:
    textColor: "{colors.warn}"
    rounded: "{rounded.full}"
    typography: "{typography.micro}"
    height: "20px"
  badge-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    rounded: "{rounded.full}"
    typography: "{typography.micro}"
    height: "20px"
  kbd:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    borderColor: "{colors.line-strong}"
    rounded: "{rounded.xs}"
    typography: "{typography.micro}"
    padding: "0 6px"
    height: "20px"
  app-bar:
    backgroundColor: "{colors.surface}"
    padding: "0 8px"
    height: "40px"
  tab-strip:
    backgroundColor: "{colors.surface}"
    padding: "0 8px 0 4px"
    height: "40px"
  tab-active:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.fg}"
    borderColor: "{colors.line}"
    rounded: "{rounded.md}"
    typography: "{typography.label}"
    padding: "0 10px"
    height: "32px"
    shadow: "{shadows.sm}"
  tab-inactive:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    typography: "{typography.label}"
    height: "32px"
  status-rail:
    backgroundColor: "{colors.surface}"
    padding: "0 12px"
    height: "28px"
  dialog:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.fg}"
    borderColor: "{colors.line-strong}"
    rounded: "{rounded.lg}"
    padding: "14px 16px 16px"
    shadow: "{shadows.lg}"
  dialog-footer:
    backgroundColor: "{colors.surface}"
    padding: "12px 16px"
  menu:
    backgroundColor: "{colors.elevated}"
    borderColor: "{colors.line-strong}"
    rounded: "{rounded.lg}"
    padding: "4px"
    shadow: "{shadows.lg}"
  menu-item:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    typography: "{typography.label}"
    padding: "6px 10px"
  menu-item-highlighted:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.fg}"
  command-field:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.fg}"
    borderColor: "{colors.line-strong}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  command-register-row:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    typography: "{typography.label}"
    padding: "6px 10px"
  command-register-row-active:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
  tree-row:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    typography: "{typography.panel-title}"
    padding: "6px 8px"
  tree-row-hover:
    backgroundColor: "{colors.hover}"
  grid-header-cell:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    borderColor: "{colors.line}"
    padding: "0 6px"
    height: "44px"
  grid-row:
    typography: "{typography.data}"
    height: "30px"
  grid-row-selected:
    backgroundColor: "{colors.accent-soft}"
  grid-cell-selected:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.fg}"
  grid-gutter-selected:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
  card:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.line}"
    rounded: "{rounded.lg}"
    padding: "16px"
---

# Design System: SqlMyPg

## Overview

**Creative North Star: "A modern developer tool, executed properly."**

This world is pinned by the brief. The operator asked for the thing this category has settled on,
naming TablePlus, DataGrip and Supabase Studio, and said in as many words that the monospace
interface itself was the problem and that the UI was too small. So the commitment here is the
convention, executed at full fidelity: no irony, no smuggled quirk, and no attempt to redirect it
back toward a house style. The craft has to show in how legible, calm and unhurried the tool is,
not in refusing what a database client is supposed to look like.

It replaces "The Dealing Desk", a zero-radius, amber, all-monospace terminal world, which this
brief rejected explicitly. Nothing of that direction is preserved. This is a replacement, not a
refinement, and the two are not blended.

**The one decision everything else follows from:** mono is not the interface. It is confined to the
two places it is doing a job (SQL in the editor, values in the data grid), and everything
operable speaks the operating system's own UI face. The referents are native desktop applications;
loading a webfont to imitate nativeness would be the wrong instinct, and the platform face is
already hinted for the screen it will be read on.

**Scale.** The interface steps off **14px**, not 12px. Data sits one step down at **13px** mono,
because a grid earns its density and a table of values is read in blocks rather than as prose.
Controls are **32px** tall (28px for the compact variant that sits inside a data row), which is
where this tool class settled and what makes the product hittable without aiming.

**Depth.** Panels are objects with a body: real radius (4px on controls, 6–8px on panels and
overlays) and real elevation, offset down and softly spread. A blur with no offset is a glow, not a
shadow. Surfaces also separate by tone, not only by a hairline: dark is a stack of blue-grey planes
(`bg` → `surface` → `elevated` → `hover`), and light is a white canvas on a grey chrome plane. The
sidebar being darker than the canvas in light mode is not an inconsistency with dark mode; it is
how every tool in this class builds its light theme, because the canvas is the paper.

**Colour.** One blue accent, and it does two jobs that need two tokens: `accent` is the **fill**
(white on it passes AA), `accent-text` is the same hue lifted for **text and icons** on a panel.
Using the fill colour as text was the shortcut that made an earlier contrast claim false. The
accent fills exactly one primary action per surface and tints selection; `ok` is committed, `warn`
is attention, `danger` is destructive, `ident` is the hue of a schema or relation name. Nothing is
coloured decoratively.

**Key characteristics**

- System UI sans for everything operable; JetBrains Mono only for SQL and grid values.
- 14px interface / 13px data / 32px controls.
- Radius and elevation are real and on a scale; both are documented above and enforced.
- Two complete renditions, switched by `data-theme` on the root element. Dark is primary and comes
  from the use scene: a wide desktop with a terminal open beside the browser.
- **One control bar, not two.** The tab strip carries the active tab's own controls.
- Every state still reads with colour removed: selection is a tint *and* a stronger gutter, the
  transaction state changes its wording as well as its fill, a failed statement is struck through.

## Type

| Role | Family | Size / line | Weight | Used for |
|---|---|---|---|---|
| `display` | UI sans (display cut) | 34 / 42 | 600 | The sign-on headline, once. |
| `hero` | UI sans (display cut) | 26 / 34 | 600 | The empty-workspace headline, once. |
| `title` | UI sans (display cut) | 20 / 28 | 600 | Dialog titles, sign-on form heading. |
| `subtitle` | UI sans (display cut) | 16 / 24 | 600 | Empty-state titles, feature-card headings. |
| `body` | UI sans (text cut) | 14 / 20 | 400 | Everything else in the interface. The base. |
| `panel-title` | UI sans (display cut) | 13 / 20 | 600 | Panel headers, tree rows, `.panel-title`. |
| `data` | JetBrains Mono | 13 / 20 | 400 | Grid cells, the SQL editor, generated SQL. |
| `label` | UI sans (text cut) | 12 / 18 | 500 | Field labels (`.placard`), tab labels, menu rows. |
| `micro` | UI sans (text cut) | 11 / 16 | 400 | Annotations (`.annot`), column types, row estimates. |

Tabular figures are applied where figures are read as data (`.font-mono`, anything `tabular`) and
not to interface prose, which does not need them.

`.placard` kept its class name and changed its job: it was tracked uppercase in a condensed face,
and it is now an ordinary field label in the interface voice, because a form label that shouts is a
label you read twice. Every `.placard` in the app inherited that change without being touched.

## Colour

`bg` is the canvas; `surface` is the chrome plane (app bar, tab strip, sidebar, status rail, grid
header and gutter, cards); `elevated` is anything that sits on top of a plane (inputs, overlays,
menus, the active tab chip); `hover` is one step up from whatever it sits on.

| Token | Dark | Light | Job |
|---|---|---|---|
| `bg` | `#0f1115` | `#ffffff` | The canvas: editor, grid, workspace. |
| `surface` | `#15181e` | `#f5f6f8` | Chrome: bars, sidebar, status rail, cards. |
| `elevated` | `#1b1f27` | `#ffffff` | Inputs, overlays, menus, active tab. |
| `hover` | `#212632` | `#eceef1` | One step up, on hover. |
| `line` | `#242932` | `#e2e5ea` | Dividers and quiet borders. |
| `line-strong` | `#333a45` | `#ccd1d9` | Control and input borders. |
| `fg` | `#e8ebf0` | `#1b1f24` | Primary ink. |
| `muted` | `#9aa3b2` | `#57606a` | Secondary ink, labels, icons. |
| `faint` | `#6e7887` | `#7d8590` | Placeholders, NULL, disabled ink. |
| `accent` | `#1f6feb` | `#1f6feb` | The **fill**: primary buttons, the mark, selected gutter. |
| `accent-text` | `#6ea8ff` | `#1257c9` | The **text/icon** hue: links, focus ring, spinners. |
| `accent-soft` | `#16304f` | `#ddf0ff` | Selection tint, badge grounds, icon tiles. |
| `ok` | `#3fb950` | `#166d2f` | Committed, connected, live. |
| `warn` | `#d29922` | `#8a5a00` | Attention: open cursor, read-only table, not signed in. |
| `danger` | `#f85149` | `#cf222e` | Errors and destructive actions. |
| `ident` | `#79c0ff` | `#0550ae` | Schema and relation names, wherever they appear. |

White on `accent` is **4.63:1**, which is AA for normal text with nothing to spare. `accent-text` on `bg`
is **7.84:1** dark and **6.50:1** light. Those figures are the reason the accent is split into two
tokens: the fill cannot carry text on a panel, and the ink cannot carry white on itself.

82 text and component pairs across both renditions were measured (every ink on every ground, every
badge on its own tint, both accent roles, the error banner, the selected cell and gutter). **80 pass
their target.** The two that do not are named under Known gaps below. Both are control borders, and
the miss is deliberate.

## Shape and depth

Radius: `xs` 3px (keycaps, checkboxes, inline code, the editor's statement bar), `sm` 4px (menu
rows, small icon buttons), `md` 6px (buttons, inputs, tabs, icon buttons), `lg` 8px (dialogs, menus,
cards), `xl` 12px (unused today, reserved), `full` 999px (badges, status dots, scrollbar thumbs).

Elevation: `sm` on controls that should read as liftable, `lg` on anything that floats over the
page (dialogs, menus, toasts). `md` exists for the middle case. Every shadow has a vertical offset.

Hairlines still exist, `.rule-t/-b/-l/-r` at one device pixel. They are simply no longer the only
way two things are separated.

## The tab strip is the control bar

Both tab kinds used to carry a toolbar directly under the tab strip. On a browse tab that bar also
printed the relation name a second time, when the tab above it already said
`public.query_history`, and repeated the row estimate the status rail already carries. Two stacked bars, and one of them
redundant.

Now the strip is the control bar. `TAB_ACTIONS_ID` marks a slot on its right; the active tab renders
its controls into that slot through `TabActions`, and the grid or the editor starts immediately
beneath the tabs. Hidden tabs stay mounted, because that is the session model, so each tab is told whether
it is `active` and only the active one may claim the slot.

- **Browse tab:** a filter field with a search icon (a SQL `WHERE`, applied on Enter, cleared on
  Escape), a sort select with a direction toggle, a primary `+ Row`, refresh, and an overflow menu
  holding CSV export and the generated SQL. A `Read-only` badge appears when the table has no key
  the grid can address a row by, which is the reason editing is off.
- **Query tab:** a primary `Run`, `Run all`, a `Cancel` that appears only while a statement is in
  flight, the row cap, and an overflow menu holding Explain, CSV export and Save. The running clock
  and the transaction badge sit alongside; the pid and database do not, because the status rail
  already carries them permanently.

Column sorting is also on the header click, but the sort select stays: a table can be wider than the
screen, and the column you want to sort by may not be on it.

The grid carries the same insert as a context-menu entry, and it is reachable from **every** region
of the grid: the row gutter, any data cell, the blank field below the last row, and an empty
relation. Three of those had no trigger at all before: a right-click inside the data or on the
blank field fell through to the browser's own menu, and the blank field is the largest target in
the whole view. Right-clicking a cell outside the current selection re-points it first, so a copy
acts on what was pointed at instead of a stale range.

The triggers nest: rows and header cells sit inside the scroll container's own trigger, so each one
stops the event bubbling and the innermost menu is the only one that opens. A query result gets no
insert entry anywhere, because there is no relation to insert into.

## Editing a result

Double-clicking a cell opens the editor, in the browse grid and in a query result alike. It is the
same dialog and it opens straight into edit mode, because having to press Edit first is one step too
many when you are working through a column of cells.

A query result is arbitrary, so whether a cell can be written is decided per column, and stated when
it cannot be. Postgres reports the source table oid and attnum on a result column only when that
column is a plain reference to a stored column; `lib/resultEdit` adds the two conditions that
reporting alone does not cover: the relation must be an ordinary or partitioned table, and every
column of its unique key must be in the projection, so the row can be named exactly. Requiring the
whole key is also what makes a grouped or joined result safe: if the key is projected, one result
row is one table row whatever the query did around it.

The refusals put the useful part on the panel instead of in a tooltip, because the useful part is
usually an instruction, as in *Add id to the SELECT to edit users*. One of them is a hazard and not
just a limitation: with a transaction open in the tab, a grid edit would run on a pooled connection
and wait on the locks that same tab is holding, so it is refused instead of left to hang.

None of this authorises anything. The server re-resolves the relation from its schema and name,
re-derives the key from the catalog, and refuses any request that disagrees, so the client can only
ever offer an edit the server would independently allow.

## Discoverability

The brief asked for newbie-friendly, which in a tool like this means: nothing important reachable
only by right-click, and every control says what it does.

- Every icon-only control has both an `aria-label` and a `title`; a disabled control's `title` says
  why it is disabled.
- The filter field's tooltip gives an example predicate instead of assuming you know the syntax.
- The empty workspace offers the action that is actually next: **Add a connection** when none is
  saved, **New query tab** when one is. It used to offer a query tab either way, which cannot work
  with nothing to run it against.
- Empty states are centred and given the weight of a page, with an icon tile, a 16px title and a
  sentence, not a caption.
- Keyboard routes are printed in keycaps in the empty workspace and on the status rail, so the fast
  path is discovered by reading instead of by documentation.

## The editor

Monaco is locked in. Its theme is re-derived from this palette in `lib/monacoPg.ts`, in both
renditions, at 13px / 20px in JetBrains Mono. Token rules stay qualified with `.sql`, because the pgsql
tokenizer postfixes the language id and the base theme defines those qualified scopes, so a bare
`string` rule loses to it. The theme is threaded in as a prop instead of sniffed from the DOM,
because the shell writes `dataset.theme` and a `classList` check silently ran the light theme inside
the dark shell once already.

Keywords are coral, strings green, numbers orange, functions purple, and identifiers take the same
`ident` blue the rest of the app prints schema and relation names in, so an identifier in the
editor reads as the same kind of thing as an identifier in the tree.

## Browser surfaces

The parts we did not draw still carry the design: scrollbars (12px, rounded thumb, inset by a
transparent border), the caret, `::selection` (an `accent-soft` tint), `:focus-visible` (a 2px
`accent-text` ring, offset clear of the control), placeholders, and the `<summary>` marker. Leaving
these to the browser is the tell that a UI was assembled rather than built.

## Motion

150ms, damped (`cubic-bezier(0.16, 1, 0.3, 1)`), on background, border, colour and shadow only, and
always from an already-visible default. The busy signal is three easing dots (`.scanner`); the
load-more bar uses the same pulse, so the product has one busy vocabulary. Both stop under
`prefers-reduced-motion: reduce`.

## Conventions worth keeping

**The One-Grid Rule.** A matrix's header and its rows must live in the *same* CSS grid. Splitting
them into two containers makes `auto`/`1fr` tracks resolve per container, and the labels drift off
the columns they name. This has been hit three times in this codebase: the new-table form, the
users dialog, and it was pre-empted in both ACL dialogs.

**Tailwind scans source text, comments included.** `@import 'tailwindcss' source(none)` plus an
explicit `@source` is the guard; without it, a class name written in prose emits a real rule.

**One primary action per surface.** If every button is filled, none of them is primary, and that is the single
most common way this class of UI loses its hierarchy.

**Disabled recesses, it does not hatch.** `.screened` is now opacity plus `not-allowed`, which is
what people expect from a control they cannot use.

**A list that must look live is invalidated by the writer, not by each caller.** Queries default to
`staleTime: 30_000` with no refetch on focus, so a panel that nothing invalidates simply sits there.
Query history is written from two places, the pinned-session exec path and the pooled writes the
grid, DDL and privilege dialogs make. Both go through one function, `recordQuery`, which emits
a `history` message on the socket once the row has actually landed. The panel listens and refetches.
Hooking each call site instead would have left every future write path to remember it.

## Where this is implemented

| Concern | File |
|---|---|
| Tokens, both renditions, class layer | `web/src/index.css` |
| Primitives, the tab-actions slot | `web/src/components/ui.tsx` |
| Shell, app bar, tab strip, empty workspace | `web/src/App.tsx` |
| Editor theme | `web/src/lib/monacoPg.ts`, `web/src/components/SqlEditor.tsx` |
| Data grid | `web/src/components/ResultGrid.tsx` |
| Direction contract | `web/index.html` (comment, first child of `<body>`) |

## Known gaps

- **Control borders sit at 1.55:1 (dark) and 1.42:1 (light) against `surface`, below the 3:1 that
  WCAG 1.4.11 asks of a component boundary.** This is deliberate and it is the brief: the named
  referents draw their own control borders at the same weight (GitHub-class dark themes sit at
  ≈1.4:1 for this role), and raising it to 3:1 would make the product visibly heavier than the tools
  it was asked to sit alongside. A control is also separated from its ground by its own fill and, on
  a button, by elevation. Flagged and not fixed, because it is a taste call the operator owns, and
  because no accessibility standard is committed for this product yet.

- The amber-era search highlight in the schema tree is source-confirmed but has never been seen
  rendered in a screenshot; it now uses the accent, still unverified visually.
- `scripts/smoke/api.mjs` carries assertion blocks for insert / edit / delete / DDL / ACL that have
  never been run; they need `SMOKE_EMAIL` and `SMOKE_PASSWORD`.
- `web/.impeccable/design.json` is the machine sidecar and is regenerated by `/impeccable document`;
  it is kept in step with this file by hand until then.
- No accessibility standard has been chosen for the product (see `PRODUCT.md`). Contrast figures
  above are measured, but there is no committed target to hold them to.
