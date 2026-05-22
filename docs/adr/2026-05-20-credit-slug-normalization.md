# 2026-05-20 Credit Slug Normalization

Short mononym credits collide in MusicBrainz and in Odyssey slugs. The pipeline prompt asks for canonical full names for short credits, and edge slug construction must use `makeSlug()` so all paths share one normalization rule.
