# Culture Graph — Project Spec

## Vision

Culture Graph helps the **best diggers discover music**.

Discovering music isn't about finding "songs you might like" — it's about **understanding the cultural context** that produced the music. Who made it, where, when, on what label, under whose influence, against what scene. The deeper you understand the context, the richer every listen becomes, and the further you can dig.

Culture Graph gives diggers a tool to **always go deeper**: from a track, to its artist, to that artist's label, to a labelmate's influences, to the genre those influences came from, back out to another artist in that genre — an **odyssey through the music**, navigated through cultural connections instead of algorithmic similarity.

## Core concept — the graph

The product is a **graph of cultural nodes**, navigated on an infinite canvas (inspired by [public.work / Cosmos](https://public.work)).

There is always **exactly one focused node**. By default it sits at the center of the canvas, but the user can freely swipe/pan around — the focused node is not locked to the center. When the user clicks a surrounding node, that node becomes the new focused node and a smooth animation re-centers the canvas on it, with *its* connected nodes appearing around it.

Navigation is the experience. Every click is a step deeper into the cultural fabric.

## Node types

There are **five node types**, all peers on the canvas:

1. **Genre**
2. **Label**
3. **Artist**
4. **Project** (album or EP)
5. **Track**

Any node type can connect to any other node type. A user can move from a track directly to a genre, from a label directly to a track, etc. — no forced hierarchy.

## Node UI — two variants

Every node on the canvas is rendered in one of two states:

- **Focused** — the full card, with all metadata visible and the full editorial article readable. There is exactly one focused node at any time.
- **Preview** — a compact card shown when the node sits around the focused one on the canvas. Surfaces just enough to entice a click (e.g., name, type, cover/photo, a one-line teaser).

Clicking a preview node transitions it into the focused state.

## Node metadata

Each node has a set of metadata. Some metadata fields are **text** (descriptive); others are **node references** (clickable — they're the connections that build the graph).

Every node also has an **editorial article** — a mandatory long-form piece of writing that reads like a real article about the node (its history, context, why it matters). This is core to the product, not a footnote. The shorter "editorial pitch / bio / definition" fields below are the teaser shown in preview state; the full article is what the user reads when the node is focused.

These are first-draft proposals to be refined.

### Genre
- **Name** (text)
- **Editorial definition** (text, 1–2 sentences — preview teaser)
- **Editorial article** (long-form text, mandatory — full article shown when focused)
- **Era** (text, e.g., "late 1980s – mid 1990s")
- **Origin** (text, geography)
- **Sonic markers** (text, e.g., "BPM 120–140 · drum machines · dub influence")
- **Parent genre(s)** → Genre nodes
- **Subgenres** → Genre nodes
- **Related genres** → Genre nodes
- **Key artists** → Artist nodes
- **Key labels** → Label nodes
- **Landmark projects** → Project nodes
- **Landmark tracks** → Track nodes

### Label
- **Name** (text)
- **Founded** (text, year)
- **Location** (text)
- **Founders** (text)
- **Editorial description** (text, 1–2 sentences — preview teaser)
- **Editorial article** (long-form text, mandatory — full article shown when focused)
- **Active years** (text)
- **Genres** → Genre nodes
- **Roster** → Artist nodes
- **Notable releases** → Project nodes

### Artist
- **Name** (text)
- **Photo** (image)
- **Origin** (text, geography)
- **Active years** (text)
- **Editorial bio** (text, short — preview teaser)
- **Editorial article** (long-form text, mandatory — full article shown when focused)
- **Genres** → Genre nodes
- **Labels** → Label nodes
- **Discography** → Project nodes
- **Notable tracks** → Track nodes
- **Influences** → Artist nodes (artists who shaped them)
- **Influenced** → Artist nodes (artists they shaped)
- **Collaborators** → Artist nodes
- **Aliases** → Artist nodes (the same person recording under another name — e.g., side projects, pseudonyms)
- **Members** → Artist nodes (members of a group, or groups an individual is part of)

### Project (album / EP)
- **Title** (text)
- **Cover art** (image)
- **Artist(s)** → Artist nodes
- **Year** (text)
- **Label** → Label node
- **Genre(s)** → Genre nodes
- **Editorial pitch** (text, 1 sentence — preview teaser)
- **Editorial article** (long-form text, mandatory — full article shown when focused)
- **Tracklist** → Track nodes
- **Producers** → Artist nodes
- **Related projects** → Project nodes (sonic / era / scene siblings)

### Track
- **Title** (text)
- **Cover** (image, inherited from project)
- **Artist(s)** → Artist nodes
- **Project** → Project node
- **Year** (text)
- **Genre(s)** → Genre nodes
- **Duration** (text)
- **Producers** → Artist nodes
- **Samples** → Track nodes
- **Sampled by** → Track nodes
- **Remix of** → Track node (when this track is a remix of another)
- **Remixed by** → Track nodes (remixes of this track)
- **Editorial teaser** (text, 1 sentence — preview teaser)
- **Editorial article** (long-form text, mandatory — full article shown when focused)

## Interaction model

- The canvas **feels infinite** and is freely pannable (swipe/drag in any direction). Inspired by [public.work / Cosmos](https://public.work).
- **No zoom for now** — a single zoom level. Zoom in/out is out of scope for the first version.
- **Exactly one node is focused at any time.** The focused node is not locked to the center — the user can pan it anywhere on screen.
- The focused node displays its **full card** (focused variant) with all metadata and the full editorial article visible.
- The nodes referenced in the focused node's metadata appear **around it** on the canvas as **preview cards**, with a second ring of **second-degree connections** extending outward so the canvas feels infinite. See [Algorithm](#algorithm) for how these are selected.
- For the first version, the spatial layout of surrounding nodes is **random** (no ordering by type or connection strength).
- Clicking a preview node makes it the new focused node. A smooth animation re-centers the canvas on the newly focused node, and *its* connected (and second-degree) nodes appear around it.
- Clickable metadata fields on the focused card are also navigation entry points (clicking "Brian Eno" in a project's Producers list does the same thing as clicking the Brian Eno node on the canvas).

## Algorithm

Two algorithms power the product: a **display algorithm** that decides what to render around the focused node, and a **materialization algorithm** that decides where the data comes from. They are deliberately decoupled — the display algorithm reads from a cache, the materialization algorithm writes to it.

### Vocabulary

- **Node schema** — for each type, the fixed list of *typed edges* that can attach to it (e.g., a Track has `artists`, `project`, `genres`, `samples`, `remix_of`, …).
- **Candidate set** — for a focused node `N`, the union of all nodes reachable via `N`'s schema edges, drawn from the cache (materialized nodes only).
- **Display set** — the subset of the candidate set actually rendered as preview cards. At most the size of the candidate set, and typically smaller (capped by the display cap `K`).
- **Cache** — persistent store of every node we've materialized.
- **Frontier** — internal queue of references waiting to be materialized by the background crawl. Populated when an agent run emits a reference to a node that isn't in the cache yet. Never user-visible: the display algorithm only renders materialized nodes.

The schema says what edges *can* exist, the candidate set says what we *know about*, the display set says what we *show*. These are three different things; the algorithm chooses between them.

### Display algorithm

Given a focused node `N` and a display cap `K`:

1. **Build the candidate set.** For each edge type in `N`'s schema, look up neighbors in the cache.
2. **Allocate slots across edge types** with soft per-type quotas, so a focused Track always surfaces a mix (at least one artist, one genre, one project, …) before piling on extras. Quotas roll over to other edge types when an edge type is empty.
3. **Within each slot bucket, sample semi-randomly**, with these biases:
   - **Strong negative bias on already-displayed nodes** — if a node is currently on the canvas (focused, first-degree, or second-degree), its weight drops sharply or to zero. This is the serendipity lever.
   - **Negative bias on recently-focused nodes** — discourages loops back to nodes the user just left; biases the walk forward.
4. **Second-degree expansion.** Run the same algorithm with a smaller cap on each first-degree preview, to fill the outer ring. The already-displayed bias is **global across both rings**, not per-ring — otherwise rings duplicate.

### Per-type edge schemas

These are the candidate-edge lists the algorithm reads. They are exactly the node-reference fields in the [Node metadata](#node-metadata) section above — same names, same meaning. Any drift between this list and the metadata is a bug.

- **Track** → `artists`, `project`, `genres`, `producers`, `samples`, `sampled_by`, `remix_of`, `remixed_by`
- **Project** → `artists`, `label`, `tracklist`, `producers`, `genres`, `related_projects`
- **Artist** → `discography`, `notable_tracks`, `labels`, `genres`, `influences`, `influenced`, `collaborators`, `aliases`, `members`
- **Label** → `roster`, `notable_releases`, `genres`
- **Genre** → `parent_genres`, `subgenres`, `related_genres`, `key_artists`, `key_labels`, `landmark_projects`, `landmark_tracks`

Note: `Label.founders` is plain text in the metadata, not a graph edge — it's commonly a non-artist (label-owner, businessperson), so it doesn't reliably resolve to a node. When a founder *is* in the graph as an Artist, they're usually also on the label's `roster`, so the navigation is preserved.

### Materialization algorithm

There is no pre-scraped corpus, and there is no on-demand fetch at navigation time — the canvas needs to feel smooth and synchronous, and a web-scraping agent can't meet that latency budget. Instead, the graph is built **entirely by a background crawl** that runs before users touch the product and keeps running afterwards to expand and refresh it.

**The agent.** Given `(type, name, disambiguators?)`, it returns the full structured node payload: text fields, the long-form editorial article, and the edge references. Tools: web search + URL fetch. Output is schema-validated; references are emitted as canonical IDs (e.g., `artist:aphex-twin`), not free text. Model is a cheap, high-throughput one (DeepSeek / Qwen class) — graph volume dominates per-call cost.

> Tension worth naming: editorial articles are core to the product and want a stronger model than pure structured extraction does. A possible split is cheap model for structure + references, better model for the article.

**The crawl loop.** Seed → frontier. Loop: pop reference → agent call → write payload to cache → push the new references onto the frontier (dedup against what's already cached or queued). Runs autonomously against a budget (time / node count / dollars). BFS by default. Can run arbitrarily long from any seed, and can be re-started at any time to expand the graph further or refresh stale nodes.

### Identity & dedup

Without canonicalization the cache fragments into islands. Two related but **distinct** mechanisms keep that from happening:

- **Slug normalization at write time.** Variant spellings of the *same* entity collapse to one canonical slug — "Aphex Twin" / "aphex twin" / "Aphex Twin (musician)" all resolve to `artist:aphex-twin`. Best done by the agent itself with a "is this the same entity as any of: …?" disambiguation step before insertion. This is the only mechanism that *removes* would-be nodes.
- **Personas, side projects, and aliases stay as distinct nodes.** AFX, Polygon Window, and Richard D. James are *not* normalized into `artist:aphex-twin`. Each has its own discography, its own editorial article, and its own slug. They connect to Aphex Twin via the Artist node's `aliases` and `members` edges. This is part of the cultural fabric the product wants to surface — collapsing personas would erase exactly the kind of connection a digger wants to follow.

Rule of thumb: normalize *spellings* of one entity; keep *personas* of one person as separate nodes.

### Reverse-edge materialization

Half the schema edges are directional: `samples`/`sampled_by`, `influences`/`influenced`, `remix_of`/`remixed_by`. When the agent writes Track A's `samples: [B]`, the cache must also update B's `sampled_by` to include A. Otherwise the graph stays sparse on the reverse direction and serendipity suffers (you can find a sample but never the things it sampled). Either materialize both sides on write, or compute reverse edges on read.

### Cache shape

Keyed by canonical slug. Stores: payload, references (as slugs), materialization timestamp, source citations (for trust + debugging), and a freshness TTL. Read by the display algorithm; written by the background crawl.

### Cold start

Because navigation never blocks on materialization, the product can't launch until enough of the graph is pre-crawled to make any reachable node feel rich on first click. Practically: pick the initial seeds, run the background crawl long enough to materialize several hops out from each, then ship. After launch, the crawler keeps running to grow and refresh the graph.

### Knobs to lock down

- Display cap `K`, per-type quotas, decay curve on "already-displayed."
- Stability vs. re-roll on back-navigation (probably restore for the immediate parent, re-roll otherwise).
- Whether second-degree previews are directly clickable (skip-to-focus) or first promote to first-degree.
- Cache TTL / refresh policy.
- Agent guardrails: citations required? Refuse-on-uncertain? Acceptable hallucination floor in editorial articles?
- Total crawl budget (time / node count / dollars) to reach "launch-ready" coverage from the chosen seeds.
- One agent or two (cheap for structure, stronger for articles).

## Open questions

These need answers as we go, but we don't need them all locked before prototyping:

- Edges in the data model are typed (see [per-type edge schemas](#per-type-edge-schemas)). Open question: do we *surface* the edge type in the UI (e.g., a "shared producer" label between two nodes), or keep the connection implicit and let the editorial article do the explaining?
- How does the user start their journey — search, curated seeds, random?
- How is the canvas state persisted? Can a user save a "trail" / their odyssey through the graph?
- Where does the actual music playback come from (Spotify/Apple link-out vs in-app previews vs full streaming)?
- How do we handle **sparse nodes** (an obscure label with only 2 releases)? The display cap and per-type quotas in the Algorithm section handle dense nodes; sparse nodes leave display slots unfilled. Do we pad with second-degree promotions, with thematically-related nodes outside the candidate set, or just show fewer previews?

## North star

The user opens Culture Graph, clicks on a track they love, and three hours later finds themselves reading the editorial blurb of a Belgian EBM label from 1986 they'd never heard of — and they understand *exactly* how they got there, and why it matters.
