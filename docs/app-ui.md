# Application UI building blocks (optional)

`src/components/custom/app-ui/` ships a small set of user-owned components for data
screens: a page header, metric cards, a panel, a list toolbar, a data table with real
loading / error / empty states, a status badge, form sections and a two-column shell.
Their CSS lives in `app-ui.css`, scoped to `.app-ui`, imported from the user-owned
`src/app/custom-style.css`, and inherits the app theme (`brand-theme.css`) including
dark mode.

They are a starting point, not a required composition. Use them, restyle them,
override them with utilities (explicit Tailwind classes win over the defaults), rewrite
their markup, or delete the folder together with its `@import` line in
`custom-style.css`. Nothing mounts them automatically and no workflow step or gate
expects them. Design the screen for the business first; reach for a block when it
matches what you were going to build anyway.

## Components

| Component | File | Notes |
| --- | --- | --- |
| `AppSurface` | `app-shell.tsx` | Adds the `.app-ui` scope and `data-density` (`comfortable` default, `compact`). Use inside an existing dashboard/admin shell. |
| `AppShell` | `app-shell.tsx` | Sidebar + optional top bar + one `<main>`. Mount once per area layout. Pass real links as `navigation`, mark the current one with `aria-current="page"`, give `navigationLabel` a localized value. Width knob: `--app-sidebar-width`. Provides no auth: keep the area's session/role checks around it. Never nest a second shell or `<main>`. |
| `PageHeader` | `page-header.tsx` | Title, optional description and `actions`. |
| `MetricGrid`, `MetricCard` | `metrics.tsx` | Only for values the app really has; omit metrics without a data source. |
| `Panel` | `panel.tsx` | Titled container; `className` is merged. |
| `ListToolbar` | `list-toolbar.tsx` | Slots for search/filters/actions above a list. |
| `DataTable<Row>` | `data-table.tsx` | Columns `{ id, header, cell, align? }`, `rowKey` must be stable. Owns no fetching, sorting or pagination. `loading`, `loadingLabel`, `error`, `empty` keep non-success states explicit; error wins over loading; neither shows stale rows. Scrolls inside its container on narrow screens. Keep function-valued columns and the table in the same client island (never across a Server/Client boundary). |
| `EmptyState` | `empty-state.tsx` | Title, description, one real action. |
| `StatusBadge` | `status-badge.tsx` | Tones `neutral`, `positive`, `warning`, `critical`, `info`. Always pass a text label; color alone never carries status. |
| `FormSection`, `FormActions` | `form-section.tsx` | Sections inside ONE caller-owned form; fields still need labels, validation and inline errors. Show success only after the real mutation succeeded. |

## Data and authorization

Presentation only. Read through the app's `/api` layer from a client island
(`apiFetch`), render loading, error and empty states from real responses, and keep
every protected API check server-side. Do not invent metrics, activity, people or
success feedback to fill a screen.

## Theme knobs

`--app-gap`, `--app-padding`, `--app-row-padding`, `--app-heading-size`,
`--app-panel-radius`, `--app-sidebar-width`, and the status colors
`--app-positive` / `--app-warning` / `--app-critical` / `--app-info`. Set them on
`.app-ui`, on any ancestor, or per surface via `className`. Headings inherit the
app's own font choices; the blocks impose no typeface.

## Tests

`tests/unit/app-ui.test.tsx` covers rendering and the table's state precedence.
`tests/integration/app-ui-styles.test.mjs` checks the real Tailwind cascade in a
headless Chromium (run with `node --test`, needs Chrome or `CHROME_BIN`; not part of
`npm test`).
