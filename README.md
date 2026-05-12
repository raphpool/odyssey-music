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
- The nodes referenced in the focused node's metadata appear **around it** on the canvas as **preview cards**.
- To make the canvas feel truly infinite, once the directly connected nodes are laid out, we also display **second-degree connections** — randomly picked nodes connected to those connected nodes — extending outward. This continues as the user pans further.
- For the first version, the spatial layout of surrounding nodes is **random** (no ordering by type or connection strength).
- Clicking a preview node makes it the new focused node. A smooth animation re-centers the canvas on the newly focused node, and *its* connected (and second-degree) nodes appear around it.
- Clickable metadata fields on the focused card are also navigation entry points (clicking "Brian Eno" in a project's Producers list does the same thing as clicking the Brian Eno node on the canvas).

## Open questions

These need answers as we go, but we don't need them all locked before prototyping:

- Do edges show *why* two nodes are connected (e.g., "shared producer", "same scene")?
- How does the user start their journey — search, curated seeds, random?
- How is the canvas state persisted? Can a user save a "trail" / their odyssey through the graph?
- Where does the actual music playback come from (Spotify/Apple link-out vs in-app previews vs full streaming)?
- Where does the data and editorial content come from (curated, AI-generated, hybrid)?
- How does the system handle sparse nodes (an obscure label with only 2 releases) vs dense nodes (a major artist with 40 connections)?

## North star

The user opens Culture Graph, clicks on a track they love, and three hours later finds themselves reading the editorial blurb of a Belgian EBM label from 1986 they'd never heard of — and they understand *exactly* how they got there, and why it matters.
