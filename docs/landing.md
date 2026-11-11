# Configure the landing

`/` renders a complete landing from `src/lib/business/landing/config.ts`.
The template includes the sections and their responsive styles; no editor or
studio is shipped. The starter uses neutral copy and an image placeholder that
onboarding replaces with the business's content.

## Two modes

- **No brand facts (onboarding):** configure the catalog described below. It is
  the reliability floor — a validated config, real CTAs, content visible before
  JavaScript, accessible interactions and reduced-motion support come with it.
- **Brand facts supplied, or a redesign requested:** the renderer is user-owned.
  Restyle or extend `src/components/custom/landing/**` and its CSS modules, open
  `src/lib/business/landing/schema.ts` and `theme.ts` further, or replace
  `src/app/(setup)/page.tsx` with a bespoke home. The floor then becomes the
  completion checks below: a validated config if you keep one, real
  CTAs/assets/claims, unique section ids, no-JS visibility, accessibility and
  reduced motion, and a desktop + mobile check.

## Onboarding workflow

1. Read the business brief and roadmap. Set the identity in `src/lib/brand.ts`.
2. Read `src/lib/business/landing/catalog.ts` for available pieces,
   `types.ts` for their fields and `schema.ts` for variant requirements. Inspect
   the active home and current `config.ts`; preserve an existing composition
   outside the requested changes. Use the decisions below before editing.
3. Set `theme`: `palette` (`cobalt`, `forest`, `wine`) or all four
   `theme.colors` (then `palette` is optional); `typography` as a preset
   (`sans`, `editorial`, `rounded`) or as `{ display, body }` font-family
   strings for fonts you self-host; and `radius` (`sharp`, `soft`, `round`).
   Presets are starting points, not a restriction on which colors or fonts the
   landing can use.
4. Choose `navbar.variant` from `navbarCatalog` independently of the hero. Keep
   section IDs unique. Array order determines page order; `enabled: false`
   hides a section. Update navigation and action anchors to target visible
   sections. `#landing-footer` targets the footer.
5. Replace placeholder images with business assets in `public/` or HTTPS image
   URLs. Supply descriptive alt text. Use supported facts and attributable
   testimonials. Preserve supplied prices; when pricing decisions are delegated,
   record the chosen launch price and rationale without presenting it as market
   research or founder approval. Omit optional sections without supporting content.
6. Point actions at working routes, section anchors, HTTPS destinations or
   `mailto:` addresses. Install the appropriate module for capabilities such
   as checkout or auth, then link its real flow. A CTA is a normal link, with
   no simulated success or demo dialog.
7. Use the workflow's verification helper when one is supplied; it owns the
   required commands. Otherwise run `npm test`, `npm run lint`,
   `SKIP_ENV_VALIDATION=1 npm run build`, then `npm run typecheck`.
   Complete the page and action checks below; a build alone does not prove them.

## Composition decisions

Before changing configuration, record a short composition rationale in the
workflow's existing analysis/plan or working notes. No extra planning file is
required. In read-only phases, record decisions without editing the app.

1. **Purpose:** identify the visitor, concrete offer and one primary conversion
   goal from the brief and roadmap. Separate capabilities available now from
   planned capabilities. Explicit customer requirements take precedence over
   the starter composition.
2. **Content:** inventory supplied copy, assets, prices, people, references and
   customer quotes. Each proposed section needs useful supported content and a
   visitor question to answer. Omit optional sections without it; report missing
   content for an explicit requirement instead of silently dropping that requirement.
3. **Structure:** choose the smallest composition that covers those questions.
   Introduce the offer, explain it, provide available evidence and lead to the
   action. These are roles, not mandatory sections. Preserve a clear first screen,
   one hero/H1 and a small navigation. The catalog is not a checklist to display.
4. **Variants:** match the amount and shape of content to a layout. Use `menu`
   for categorized text/prices, `catalog` for image-led offers, `schedule` for
   timed sessions, and `curriculum` for ordered learning modules. Choose an
   immersive/collage hero only with appropriate imagery; choose tabs only when
   each item has useful media. One quote suits `spotlight`/`split`; multiple quotes
   can use `wall`/`carousel`. Keep essential decision content outside hidden tabs
   or later slides. Use the variant reference below for exact fields.
5. **Coherence:** choose one theme for the page, using the supplied brand colors
   when available. Vary layout where the content benefits from it; avoid changing
   variants at random or repeating the same card composition in every section.
   Keep configured defaults when they fit. All pieces are available to every business.
6. **Actions:** name each CTA's promised outcome and actual destination. A contact
   email or informational anchor can be the correct primary action. A signup,
   checkout or booking CTA needs its corresponding working flow; scrolling to
   explanatory text does not complete that action. During a landing-only bake,
   use an honest contact/exploration action or a supplied, verified HTTPS flow
   that already delivers the promised action, within that workflow's scope.

For each selected section, the rationale should identify its role, `type` and
`variant`, supplied content/assets and any action destination. Resolve exact
variant names and requirements from this checkout, not a remembered template
version. Keep implementation details in engineering notes, not visitor-facing copy.

### Missing imagery

Use existing assets or exact URLs returned by the workflow's asset tools. Create
and verify a local file before referencing a new path. With no suitable photograph,
choose a layout that needs less imagery and, when necessary, create a simple
decorative SVG in `public/` with honest alt text. A decorative illustration can
support a hero; it cannot stand in for a real person's portrait, a customer logo,
a location map or evidence of a before/after result. Omit optional proof sections
or report the missing required asset. For software/SaaS, product imagery must be
a genuine screenshot supplied by the customer or captured from the working app.
Never generate, draw or ship a fabricated dashboard, screenshot or UI preview.
The `dashboard` media kind accepts a real screenshot via `src`; the old built-in
mock workspace has been removed. Existing configurations using that placeholder
must supply a real capture or switch to a `centered` hero without `media`.
Decorative art must not depict invented application controls or capabilities.

### Completion checks

- The configuration passes `landingConfigSchema` and the workflow's build checks.
  Keep the home page's validation and server-rendered metadata intact.
- Every visible section supports the brief and contains business content rather
  than starter copy. Factual claims, identities and endorsements have support;
  launch prices follow supplied terms or recorded, authorized product decisions.
  Future roadmap features are presented as planned, when relevant.
- Inspect `/` at desktop and narrow mobile widths. Check image loading, text
  contrast, wrapping and overflow, including custom colors and the chosen variants.
- Follow every navigation link and CTA. Anchors resolve to enabled sections or
  `#landing-footer`; routes exist and the promised flow works. Schema validation
  checks shapes and URL syntax, not destination existence or business truth.
- Check keyboard navigation for the interactive variants you used, reduced motion
  and readable content before JavaScript. Whatever motion you use, keep the
  reduced-motion preference honored and the content visible without JavaScript.
- Report the chosen composition, working destinations, verification performed and
  any unmet requirement.

## Variant reference

### Navbar

Set `navbar` in `src/lib/business/landing/config.ts`. Existing compositions can
omit it and retain `classic`. The links still come from `navigation` and the
conversion action from `primaryAction`; links to disabled sections are filtered.

| `navbar.variant` | Layout and use |
| --- | --- |
| `classic` | Brand left, visible links and action. General service and product sites. |
| `centered` | Brand centered between links and action. Editorial, hospitality and retail identities with concise navigation. |
| `floating` | An inset rounded bar above the hero, using the landing's theme. |
| `minimal` | Brand, action and menu toggle. Links stay in the menu even on desktop; useful for focused campaigns and portfolios. |

All variants share the same disclosure menu, keyboard support and reduced-motion
behavior. Below 900px the links move into the menu; at 620px and below the header
action also moves there to leave space for the brand and a 44px menu button.
Long names and labels wrap. Check the actual business name at 320px and 390px.

Localize menu accessibility labels through `navbar.labels`, for example:

```ts
navbar: {
  variant: 'centered',
  labels: {
    navigation: 'Navigation principale',
    openMenu: 'Ouvrir le menu',
    closeMenu: 'Fermer le menu',
  },
},
```

The navbar is independent of the shared `SiteNav` used on other public routes.
The landing continues to own its header at `/`.

### Sections

| Section | Variants |
| --- | --- |
| Hero | `split`, `centered`, `cover`, `immersive`, `collage`, `profile`, `campaign` |
| Benefits / services | `grid`, `split`, `list`, `bento`, `tabs` |
| Products / projects / menu | `cards`, `editorial`, `catalog`, `menu`, `portfolio`, `mosaic`, `story` |
| Product collection (`commerce`) | `grid`, `featured`, `compact`, `rail`, `lookbook` |
| How it works | `timeline`, `cards`, `vertical`, `image-accordion`, `alternating`, `narrative` |
| Pricing | `cards`, `compact` |
| Testimonial | `spotlight`, `split`, `wall`, `carousel` |
| References (`logos`) | `band`, `grid` |
| Key figures (`stats`) | `inline`, `visual` |
| People (`team`) | `founder`, `grid` |
| Contact / location | `details`, `map` |
| Comparison | `table`, `before-after` |
| Programme (`agenda`) | `schedule`, `curriculum` |
| FAQ | `accordion`, `columns` |
| Call to action | `banner`, `centered`, `minimal` |

Hero media supports `image`, `product`, or `dashboard`; all require a supplied
`src` and descriptive `alt`. `centered` and `profile` can omit `media` entirely.
A profile portrait must use `kind: 'image'` and show the actual person.
Sections are independent of business categories: compose them from the brief.

### Choose content and layouts

The catalog contains 15 section types and 53 layouts. The same pieces can serve
software, commerce, services, hospitality, education or other businesses; there
is no business-type restriction. Select a layout based on the available content.

- **Hero:** `immersive` places copy over a supplied image; `collage` arranges the
  primary image beside one or two additional images in `collage`. Both require
  `media.kind: 'image' | 'product'` and `media.src`. `campaign` puts a wide supplied
  image above centered copy and actions, with an optional caption and note.
  Photography fills its frame; real `dashboard` captures remain uncropped.
- **Personal introduction:** `hero/profile` leads with a person's name, role,
  introduction and contact action. A real portrait is optional; no image frame
  or fake portrait is rendered when omitted. Use `eyebrow` for a supplied role
  and `note` for useful factual context, not invented availability or credentials.
- **Selected work:** `gallery/portfolio` presents projects as spacious rows with
  title, optional `subtitle`, `category`, `tag` and a working `action`. Images are
  optional; supply both `image` and `alt` when a real project image is available.
  Use existing team/contact sections for biography and contact details when needed.
  Personal sites do not need pricing cards, fabricated testimonials or decorative
  dashboard panels. Typography and real work can carry the page.
- **Commerce:** `commerce/grid` shows equally weighted products; `commerce/featured`
  emphasizes the first product. `compact` fits more products per row; `rail` offers
  a horizontal collection visitors can scroll or focus with a keyboard; `lookbook`
  alternates large photographs and copy, keeping product descriptions visible.
  Items require unique `id`, `title` and
  `image: { src, alt, caption? }`. Optional `price` preserves the supplied string,
  `category` groups merchandise, and `description` / `details: [{ label, value }]`
  provide expandable product information (materials, colours, sizing, etc.).
  `filter: { label, allLabel }` enables category buttons after JavaScript loads;
  all products and native expandable details remain available without JavaScript.
  `detailsLabel` localizes the disclosure label; `scrollLabel` localizes the rail's
  scrolling hint. `notice` can identify an explicitly
  authorized concept/demo collection. Product `action` links to a working route,
  contact or purchase flow; omit it until that destination exists. These layouts
  provide browsing, not stock, variant selection, cart or checkout infrastructure.
- **Benefits:** `bento` varies card sizes and accepts optional item `media`;
  `tabs` switches the description and image and requires `media` on every item.
- **Offers:** `catalog` uses image cards with optional `price` and `action`;
  `menu` groups items by optional `category`, with optional images. `mosaic` pairs
  varied photograph sizes with captions; `story` alternates images and text rows.
  Both preserve item titles, subtitles, categories, tags, prices and actions. Other gallery
  layouts except `portfolio` require `image` and `alt` on every item. Prices are supplied strings,
  not computed checkout amounts.
- **Call to action:** `minimal` gives a large, left-aligned heading generous
  whitespace beside its description and underlined primary action. It also
  supports the existing optional `secondaryAction`.
- **References:** `logos.items` accepts `{ name, image?, href? }`. Use supplied
  client or partner references only; names can render without logo assets.
- **Figures:** `stats.items` accepts `{ value, label, description? }`.
  `visual` requires section `media`. Values are supplied facts, never invented
  counters or estimates.
- **People:** `team.people` accepts `{ name, role, bio?, portrait?, action? }`.
  `founder` introduces the first person; `grid` displays everyone in the list. Portraits
  are optional and must depict the people being introduced.
- **Testimonials:** existing `spotlight`/`split` use `quote`, `author`, `role`.
  `wall`/`carousel` use `items: [{ quote, author, role?, portrait? }]` with optional
  section `heading` and `description`. The carousel is manual, without autoplay.
- **Contact:** supply `address`, `email`, `phone`, `hours: [{ label, value }]`
  and/or `action`. `map` also requires `map: { src, alt, href }`: a supplied map
  image and HTTPS directions URL. It does not load a map service or create a
  contact form. Email and phone fields become working contact links.
- **Comparison:** `table` needs `columns: [{ label, highlighted? }]` and
  `rows: [{ label, values: string[] }]`, with exactly one value per column.
  `before-after` needs `before` and `after`, each `{ src, alt, label }`, showing
  comparable supplied views. The visitor controls the reveal with a slider.
- **Programme:** `agenda.items` accepts `{ title, description?, label?, time?,
  duration?, action? }`. `schedule` emphasizes sessions and times; `curriculum`
  presents ordered learning modules. Booking and enrollment actions must link
  to real flows.

Shared `media` and `portrait` fields use `{ src, alt, caption? }` with a local
public path or HTTPS URL. Configuration validation rejects missing imagery
required by a layout, unattributed quotes and inconsistent table rows. Omit
sections whose content is unavailable; do not fabricate proof to fill a layout.
The neutral starter remains a small composition, rather than enabling every
section by default.

Omit `caption` and `note` unless they add useful editorial information,
an explicitly requested credit or a required attribution. Do not add automatic
stock-photo, inspiration, AI-generated or demo disclaimers under images. Keep
any necessary page-level concept context concise instead of repeating it under
every photo. This does not make illustrative imagery evidence of an actual
product: use genuine captures for software and genuine product imagery when
presenting an item for sale.

Tabs, testimonial navigation and the comparison slider support keyboard input.
Before JavaScript loads, text remains readable; tabs and carousel expose all
items, and image comparison starts at an even split with its slider disabled
until hydration. These interactions follow the same reduced-motion preference
as the surrounding landing.

### Customize the colors

Set any of these four fields in `config.ts`; omitted fields inherit the selected
palette. When all four are set, `palette` may be omitted entirely. Use opaque
hexadecimal colors (`#RGB` or `#RRGGBB`). Other CSS syntax, including color
names, alpha channels and CSS variables, is rejected.

```ts
theme: {
  palette: 'forest',
  typography: 'sans',
  radius: 'soft',
  // Placeholders — derive every value from the brief and the inspected references.
  colors: {
    primary: '<#RRGGBB>',    // Buttons, brand mark and emphasis
    accent: '<#RRGGBB>',     // Tinted cards and secondary surfaces
    background: '<#RRGGBB>', // Page background
    text: '<#RRGGBB>',       // Headings and body text
  },
},
```

The renderer applies these colors to every section without changing its CSS.
Muted text and borders follow custom page/text colors. Text on primary buttons
and banners automatically uses a contrasting foreground; primary-colored text
also gets a readable fallback on the page background. Check your chosen text
against both the page and accent backgrounds on desktop and mobile. Custom
colors are not a guarantee of contrast for every arbitrary combination.

Remove `theme.colors` to restore the palette. Existing configurations require
no migration. These colors apply to the landing; other app pages use the app
theme in `src/app/brand-theme.css`.

### Customize the fonts

`typography` accepts a preset — `sans`, `editorial` (serif display) or
`rounded` — which only selects system font stacks so the seeded page renders
without a web font, or your own families. Presets are not a brand choice. Pick
families for the brand from the brief and the references you inspected, then
load them:

```ts
theme: {
  colors: { /* as above */ },
  typography: {
    display: '"<Display Family>", <fallback stack>',
    body: '"<Body Family>", <fallback stack>',
  },
  radius: 'soft',
},
```

The renderer reads them through the `--land-display` and `--land-body` CSS
variables, so every section follows. Load the files first: run
`npm run font:add -- "<Family>" 400 700` for a Google Fonts family (it
self-hosts the `.woff2` files in `public/fonts/` and writes the `@font-face`
rules into `src/app/custom-style.css`), or add the files and rules yourself
(`font-src 'self'` allows it; a Google Fonts stylesheet is blocked by the CSP).
If loading fails, fix it for the same family — never fall back to a font that happens to be in the checkout.
Values are plain family lists — letters, digits, spaces, quotes, commas and
hyphens; any other CSS syntax is rejected.

### Choose a steps layout

All six layouts use the same `heading`, optional `description`, and ordered
`items` with `title` and `description`. Choose by the content and desired
composition, independently of business category:

| Variant | Composition | Required imagery |
| --- | --- | --- |
| `timeline` | Numbered columns with connecting rules; vertical on mobile | None |
| `cards` | Tinted cards with large numbers; stacked on mobile | None |
| `vertical` | Introduction on the left, a vertical timeline on the right | None |
| `image-accordion` | One image on the left, expandable steps on the right | Section-level `media` |
| `alternating` | Full-width rows alternating image/text sides; image first on mobile | `media` on every item |
| `narrative` | Large introduction, chapter text beside an image that stays in view and follows the active chapter on desktop | Section `media` fallback; optional item `media` |

Each `media` is `{ src: '/images/process.jpg', alt: 'Describe the actual image' }`.
Add the referenced business image to `public/images/` or use an HTTPS URL. For
`image-accordion`, set `section.media`; for `alternating`, set
`section.items[n].media` for every step. The schema rejects missing images,
unsupported sources and empty alt text. If the business has no appropriate
imagery, choose a text-only layout. Existing `timeline` and `cards`
configurations need no changes.

The accordion opens its first step by default and allows one open step at a
time. It supports keyboard interaction and works without JavaScript. Each
section has its own disclosure group. All layouts inherit the palette, fonts,
corners and section entrance animation from the landing.

Motion is installed and integrated into every section variant. Sections enter
once when scrolled into view, action links respond to hover and press, and the
mobile menu has a short entrance. These defaults live in
`src/components/custom/landing/landing-page.tsx` and `landing-action.tsx` in the
same directory; onboarding configures the landing and keeps these behaviors.
A redesign may change or replace the motion (Motion is already installed, so
prefer it over adding a second library) as long as two behaviors survive: the
renderer honors the device's reduced-motion preference (`LazyMotion` with
`domAnimation` and `MotionConfig reducedMotion="user"` today) and keeps
server-rendered content visible before JavaScript loads or when it is disabled.
When extending the renderer, check desktop, mobile and reduced motion.

`src/app/(setup)/page.tsx` validates the configuration before rendering and
reads page metadata from `brand.ts`. The landing owns its header and footer;
other public pages use `src/lib/nav.ts` and `SiteNav`/`SiteFooter`. Add links
from the landing to any additional public pages and installed features. If you
replace the landing with a different home page, remove the `/` suppression in
both components in `src/components/custom/site-nav.tsx` or supply your own
navigation there.

Custom app behavior still belongs in user-owned code. During onboarding, prefer
configuring the catalog; when brand facts or a redesign call for it, extend or
replace the renderer as described in "Two modes" and keep the completion checks.

## Optional art direction

Read `landingCompositionCapabilities` in the checked-out `catalog.ts` before
using these fields. Older checkouts may not support them. No migration is
needed: omitting `composition` and `framing` preserves existing section markup,
classes and styles. These are bounded configuration options, not arbitrary CSS.

Choose one memorable visual idea from the business's actual subject, then use
quieter sections to explain the offer and action. Record the intended image
subject, headline scale, page rhythm and supported evidence in the existing
composition rationale. A larger headline alone is not a design direction.

### Section composition

Every section accepts optional `composition`; each field can be omitted
independently. These options affect only that section, never its neighbours or
the navbar. Existing `theme` fonts, brand colors and radii remain the foundation.

| Field | Values and effect |
| --- | --- |
| `width` | `narrow`: content within roughly 960px; `wide`: up to roughly 1440px; `full`: near-edge composition with at least 16px gutters. Internal layout limits still protect readable copy. |
| `spacing` | `compact`: 28–56px vertical padding; `generous`: 64–160px, responsive to page width. Omit to keep that variant's spacing. |
| `tone` | `surface`: theme accent/tinted surface; `accent`: primary brand background; `inverse`: theme text color as background. Foreground, muted text, borders and actions are recalculated for that surface. Verify the actual media and nested layout in preview. |
| `display` | `standard`: existing variant scale; `large`: larger H1/H2; `monumental`: exceptional display scale. Body text stays readable. Use concise headings, and reserve the strongest scale for one focal section. |

For example, a supplied photographic hero can use
`composition: { width: 'full', spacing: 'compact', display: 'monumental' }`.
Select values from the brief rather than assigning the same combination to
every page. `narrow` is unsuitable for an already dense product collection.

### Image framing and mobile assets

Structured media (`{ src, alt, caption? }`, including hero media, collage,
commerce images, steps, benefits, portraits, statistics, maps and comparisons)
accepts an optional `framing` object:

```ts
framing: {
  fit: 'cover',
  position: { x: 65, y: 40 },
  mobile: {
    src: '/images/courtyard-portrait.jpg',
    fit: 'cover',
    position: { x: 50, y: 35 },
  },
},
```

Each field is optional. `fit` is `cover` or `contain`; focal `position` uses
numeric percentages from 0 to 100, measured from the top-left. Mobile overrides
apply at viewport widths up to 700px. A supplied mobile `src` uses native
`picture` selection before JavaScript and shares the image's alt text: it must
show the same subject, not replace it with different content. Without a mobile
source the existing image remains, with optional mobile fit/position overrides.
Omitted fit/position preserve that layout's defaults. This does not add a new
aspect-ratio setting; frames keep the layout's responsive proportions.

Legacy gallery `items.image` strings and logo image strings do not accept these
fields. Choose a suitable existing crop or use a section with structured media.
Use `contain` when a complete product silhouette or evidence matters. Real app
captures with `kind: 'dashboard'` remain complete: the schema rejects `cover`
and all focal positions, including mobile overrides. An alternate mobile
capture must come from the actual working application. Framing does not create
assets, prove their authenticity or verify their URLs; inspect each file and
its rendered desktop/mobile crop. Never invent product screens or proof.

### Expressive compositions

- **`steps/narrative`:** a large introduction precedes ordered chapters. The
  section requires `media` as the fallback; an item's optional `media` replaces
  it as that chapter enters the reading area. On desktop the image stays beside
  the text using native CSS sticky positioning and a small IntersectionObserver;
  there is no scroll hijacking, pinned animation timeline or autoplay. Before
  JavaScript, without observer support, on mobile and with reduced motion, every
  chapter is a normal image-and-text list. All copy remains in the document and
  no scroll step gates access. Use it for a genuine sequence or unfolding story,
  not unrelated numbered benefit cards. Check that captions/alt text match each
  chapter and that chapter changes choose the intended image.

The original 52 layouts and four navbars remain available; the narrative addition
brings the catalog to 53 layouts. No new font, video, 3D dependency, studio or
demo route is required. Validate the generated preview at desktop and narrow
mobile widths, including reduced motion, disabled JavaScript, image loading,
headline wrapping, keyboard actions and the actual promised destinations.
