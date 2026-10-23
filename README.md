# Audiobook Builder

A single-author web app for producing multi-voice audiobooks. Ingest a
manuscript and the app splits it into chapters and segments, runs a reading
pass that attributes dialogue to speakers, and then walks the author through
the whole production:

- **Here's your book** — chapters, cast and counts at a glance.
- **Who's speaking?** — every contested line (attributed under 85%
  confidence, or not attributed at all) is reachable in exactly one of two
  settle lists: a disagreement queue with two-candidate cards for lines
  that carry a second candidate or a character-level stake, and a plain
  review queue for the rest. Both lists paginate by cursor, so settling
  lines can never skip one. Contested lines never count toward a
  character's stats, signature line or preview until they are settled.
  Settlements record provenance (the reading pass's original attribution
  is kept alongside the human decision).
- **Cast your voices** — per-character voice previews with tone variants
  (deeper / warmer / brighter), pace control, and casting-call auditions of
  alternative voices reading the character's own signature line.
- **Pronunciation book** — tricky-word rules that rewrite the spoken text
  without ever touching the manuscript text.
- **Listen and fix** — chapter playback with word-tap pronunciation fixes,
  wrong-speaker fixes and approval.
- **Render packages** — export per-chapter job packages (JSON with
  pronunciation applied to the spoken text and pinned engine settings) for an
  external speech-synthesis pipeline, plus production files and cast /
  pronunciation CSVs. A package refuses to build while an included chapter
  has unsettled dialogue, unless explicitly overridden — and then unsettled
  lines fall back to the narrator's voice and are listed in a manifest
  (a segment is never emitted without a voice). Casting or pronunciation
  changes mark affected chapters stale and clear their approval;
  confirming a casting does not. Replacing the manuscript with a revised
  edition carries settlements (the human decisions themselves, matched by
  paragraph text + occurrence), rules, flags and approvals forward for
  unchanged paragraphs, and the new version goes live atomically.

## Tech

Cloudflare Workers (ES module) + D1, static assets served by the worker,
access gated by Cloudflare Access. Synthesis happens outside the app; the app
produces job packages only.

## Layout

- `worker.js` — API, routing and export logic
- `public/` — the single-page app (`index.html`, `app.js`, `styles.css`)
- `schema.sql` — the D1 schema

Book content, voice renders and production data are intentionally not part of
this repository.
