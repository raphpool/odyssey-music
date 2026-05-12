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
- **Members / aliases / side projects** → Artist nodes

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
- **Candidate set** — for a focused node `N`, the union of all nodes reachable via `N`'s schema edges, drawn from the cache.
- **Display set** — the subset of the candidate set actually rendered as preview cards. Always smaller than the candidate set.
- **Cache** — persistent store of every node we've materialized.
- **Frontier** — queue of node references we've seen but haven't materialized yet.

The schema says what edges *can* exist, the candidate set says what we *know about*, the display set says what we *show*. These are three different things; the algorithm chooses between them.

### Display algorithm

Given a focused node `N` and a display cap `K`:

1. **Build the candidate set.** For each edge type in `N`'s schema, look up neighbors in the cache.
2. **Allocate slots across edge types** with soft per-type quotas, so a focused Track always surfaces a mix (at least one artist, one genre, one project, …) before piling on extras. Quotas roll over to other edge types when an edge type is empty.
3. **Within each slot bucket, sample semi-randomly**, with these biases:
   - **Strong negative bias on already-displayed nodes** — if a node is currently on the canvas (focused, first-degree, or second-degree), its weight drops sharply or to zero. This is the serendipity lever.
   - **Negative bias on recently-focused nodes** — discourages loops back to nodes the user just left; biases the walk forward.
   - *(Future)* Mild positive bias toward cache-warm neighbors so the next click doesn't hit a loading state.
4. **Second-degree expansion.** Run the same algorithm with a smaller cap on each first-degree preview, to fill the outer ring. The already-displayed bias is **global across both rings**, not per-ring — otherwise rings duplicate.

### Per-type edge schemas

These are the candidate-edge lists the algorithm reads. They mirror the metadata sections above — the schema and the metadata are the same shape.

- **Track** → `artists`, `project`, `genres`, `producers`, `samples`, `sampled_by`, `remix_of`, `remixed_by`
- **Project** → `artists`, `label`, `tracks`, `producers`, `genres`, `related_projects`
- **Artist** → `projects`, `tracks`, `labels`, `genres`, `influences`, `influenced`, `collaborators`, `aliases`, `members`
- **Label** → `roster`, `releases`, `genres`, `founders`
- **Genre** → `parent_genres`, `subgenres`, `related_genres`, `key_artists`, `key_labels`, `landmark_projects`, `landmark_tracks`

### Materialization algorithm

There is no pre-scraped corpus. Nodes are materialized lazily by an agent with web access.

**The agent.** Given `(type, name, disambiguators?)`, it returns the full structured node payload: text fields, the long-form editorial article, and the edge references. Tools: web search + URL fetch. Output is schema-validated; references are emitted as canonical IDs (e.g., `artist:aphex-twin`), not free text. Model is a cheap, high-throughput one (DeepSeek / Qwen class) — graph volume dominates per-call cost.

> Tension worth naming: editorial articles are core to the product and want a stronger model than pure structured extraction does. A possible split is cheap model for structure + references, better model for the article.

**Two crawl modes, one agent:**

- **Background crawl ("warm the cache").** Seed → frontier. Loop: pop node → agent call → write payload to cache → push referenced nodes onto frontier (dedup against visited). Runs autonomously against a budget (time / node count / dollars). BFS by default. Can run arbitrarily long from any seed.
- **On-demand crawl.** When the user navigates to a node that exists only as a *reference stub* — named somewhere but not yet materialized — trigger the agent inline. Show a loading state on the focused card. Newly discovered references join the frontier for later background expansion.

Same agent, same cache, same frontier. Only the trigger differs.

### Identity & dedup

Without canonicalization the cache fragments into islands. Two pieces:

- **Slug normalization at write time.** Every reference becomes `{type}:{normalized-name}` before it touches the cache.
- **Alias resolution.** "Richard D. James" / "AFX" / "Polygon Window" should all resolve to `artist:aphex-twin`. Best done by the agent itself with a "is this the same entity as any of: …" disambiguation step before insertion.

### Reverse-edge materialization

Half the schema edges are directional: `samples`/`sampled_by`, `influences`/`influenced`, `remix_of`/`remixed_by`. When the agent writes Track A's `samples: [B]`, the cache must also update B's `sampled_by` to include A. Otherwise the graph stays sparse on the reverse direction and serendipity suffers (you can find a sample but never the things it sampled). Either materialize both sides on write, or compute reverse edges on read.

### Cache shape

Keyed by canonical slug. Stores: payload, references (as slugs), materialization timestamp, source citations (for trust + debugging), and a freshness TTL. Read by the display algorithm; written by both crawl modes.

### Cold start

The first node has nothing behind it. The very first navigation must run the agent synchronously before anything renders. Worth designing the loading state for this case explicitly — it's the user's first impression.

### Knobs to lock down

- Display cap `K`, per-type quotas, decay curve on "already-displayed."
- Stability vs. re-roll on back-navigation (probably restore for the immediate parent, re-roll otherwise).
- Whether second-degree previews are directly clickable (skip-to-focus) or first promote to first-degree.
- Cache TTL / refresh policy.
- Agent guardrails: citations required? Refuse-on-uncertain? Acceptable hallucination floor in editorial articles?
- Per-session cost ceiling on on-demand crawls.
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
