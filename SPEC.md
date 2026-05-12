# Culture Graph — Project Spec

## Vision

Culture Graph helps the **best diggers discover music**.

Discovering music isn't about finding "songs you might like" — it's about **understanding the cultural context** that produced the music. Who made it, where, when, on what label, under whose influence, against what scene. The deeper you understand the context, the richer every listen becomes, and the further you can dig.

Culture Graph gives diggers a tool to **always go deeper**: from a track, to its artist, to that artist's label, to a labelmate's influences, to the genre those influences came from, back out to another artist in that genre — an **odyssey through the music**, navigated through cultural connections instead of algorithmic similarity.

## Core concept — the graph

The product is a **graph of cultural nodes**, navigated on an infinite canvas (inspired by [public.work / Cosmos](https://public.work)).

There is always **exactly one focused node** at the center of the canvas. Surrounding it are the nodes that appear in its metadata — its artist, its label, its genre, its related projects, etc. The user clicks a surrounding node, that node becomes the new focused node, and the canvas re-arranges to show *its* connected nodes.

Navigation is the experience. Every click is a step deeper into the cultural fabric.

## Node types

There are **five node types**, all peers on the canvas:

1. **Genre**
2. **Label**
3. **Artist**
4. **Project** (album or EP)
5. **Track**

Any node type can connect to any other node type. A user can move from a track directly to a genre, from a label directly to a track, etc. — no forced hierarchy.

## Node metadata

Each node has a set of metadata. Some metadata fields are **text** (descriptive); others are **node references** (clickable — they're the connections that build the graph).

These are first-draft proposals to be refined.

### Genre
- **Name** (text)
- **Editorial definition** (text, 1–2 sentences)
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
- **Editorial description** (text, 1–2 sentences)
- **Active years** (text)
- **Genres** → Genre nodes
- **Roster** → Artist nodes
- **Notable releases** → Project nodes

### Artist
- **Name** (text)
- **Photo** (image)
- **Origin** (text, geography)
- **Active years** (text)
- **Editorial bio** (text, short)
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
- **Editorial pitch** (text, 1 sentence)
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
- **Editorial note** (text, optional)

## Interaction model

- The canvas is **infinite and zoomable**, à la public.work.
- **Exactly one node is focused at any time**, centered on the canvas.
- The focused node displays its **full card** with all metadata visible.
- The nodes referenced in the focused node's metadata appear **around it** on the canvas as smaller cards.
- Clicking a surrounding node makes it the new focused node; the canvas smoothly re-arranges to show *its* connected nodes.
- Clickable metadata fields on the focused card are also navigation entry points (clicking "Brian Eno" in a project's Producers list does the same thing as clicking the Brian Eno node on the canvas).
- The user can pan and zoom freely; an "overview" mode shows the broader graph context.

## Open questions

These need answers as we go, but we don't need them all locked before prototyping:

- How are "related" nodes ordered or laid out spatially around the focused node? By type? By strength of connection?
- Do edges show *why* two nodes are connected (e.g., "shared producer", "same scene")?
- How does the user start their journey — search, curated seeds, random?
- How is the canvas state persisted? Can a user save a "trail" / their odyssey through the graph?
- Where does the actual music playback come from (Spotify/Apple link-out vs in-app previews vs full streaming)?
- Where does the data and editorial content come from (curated, AI-generated, hybrid)?
- How does the system handle sparse nodes (an obscure label with only 2 releases) vs dense nodes (a major artist with 40 connections)?

## North star

The user opens Culture Graph, clicks on a track they love, and three hours later finds themselves reading the editorial blurb of a Belgian EBM label from 1986 they'd never heard of — and they understand *exactly* how they got there, and why it matters.
