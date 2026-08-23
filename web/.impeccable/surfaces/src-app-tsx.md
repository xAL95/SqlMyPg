---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/components/ui.tsx","src/index.css","src/components/CommandLine.tsx","src/components/Login.tsx","src/components/BrowseTab.tsx","src/components/QueryTab.tsx"]
---

# App shell

**Scope** The whole authenticated workspace: app bar, schema tree, tab strip, work surfaces and
status rail, plus the sign-on surface.

**Visitor mode** Operate. The user is in a task; expression may never obscure the task, the state,
or a familiar affordance.

## Audience and job

A developer or operator who self-hosts this and points it at their own Postgres servers, sometimes
production, at a wide desktop with a keyboard and mouse. The job is to read a schema, page a table,
run SQL with real transaction semantics, edit rows and schema, and get results out.

The operator is usually not the author, so sign-on carries the one explanation of what the product
is, and the empty workspace teaches the tab model rather than shrugging.

## Task and constraints

- **Untouchable, confirmed with the user:** Monaco as the editor; keyboard grid navigation and
  right-click context menus; the tab model where one tab owns one pinned session.
- **Density is not licensed any more.** The operator asked for the opposite: the previous
  12px-everything monospace scale was named as hard to read and the UI as too small overall. The
  floor is now a 14px interface base, 13px data, and 32px controls. See PRODUCT.md.
- **Desktop only** is a product decision, not an oversight: no touch fallback is owed, and modifier
  gestures and hover affordances are legitimate.
- **Newbie friendly** was asked for by name: no important action reachable only by right-click,
  every icon control labelled, and empty states that name an action that can actually succeed.
- Both renditions ship. The runtime light/dark toggle is a capability, so the world has a light form,
  not a dark-only look.

## Chosen direction

**A modern developer tool, executed properly.** Pinned by the brief, not by a roll: the operator
named the world and its referents (TablePlus, DataGrip, Supabase Studio), so convention *is* the
commitment, and their craft level is the bar. Executed at full fidelity, with no irony and no
smuggled quirk from the previous direction.

It replaces **Dealing Desk** (seed `36fa37b8`), which the brief rejected by name along with the
"must not look like a rounded-panel dark IDE" constraint that produced it. Nothing of that world is
preserved; the two are not blended.

What carries the design instead:

- the system UI face for everything operable, mono confined to SQL and to grid values;
- layered blue-grey planes in dark, a white canvas on a grey chrome plane in light;
- one blue accent split into a fill token and a text token, so both are legible;
- radius and elevation on a documented scale, enforced by the detector;
- states that still read with colour removed: selection is a tint *and* a stronger gutter, the
  transaction state changes its wording as well as its fill, a spent statement is struck through.

## Memorable moment

**The tab strip is the control bar.** Both tab kinds used to carry their own toolbar directly under
the strip, and on a browse tab that bar printed the relation name a second time and repeated the
row estimate the status rail already carries. The active tab now renders its controls into a slot on
the strip itself (`TAB_ACTIONS_ID` / `TabActions`), so the grid or the editor begins immediately
beneath the tabs and there is exactly one horizontal control surface in the product.

The command field is the second: Ctrl+P searches tables, connections and commands from the catalog
snapshot the editor's completion already caches, in a real search field on the app bar rather than a
modal palette floating over the work.

## Unresolved

- No accessibility standard is chosen (see PRODUCT.md). The grid carries `aria-sort`, roles and full
  keyboard paths, but no bar has been set and no audit has been run.
- There is still no logo asset; the three-bar mark is drawn inline and is a placeholder for a real
  identity if one is ever commissioned.
- The schema tree's search highlight is source-confirmed but has never been observed rendered.
- `scripts/smoke/api.mjs` carries assertion blocks for insert / edit / delete / DDL / ACL that have
  never been run; they need `SMOKE_EMAIL` and `SMOKE_PASSWORD`.
- The dialogs inherit the world through the token and primitive layers and have had a pass for
  control sizing, label voice and radius, but not a composition pass of their own.
