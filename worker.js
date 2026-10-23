// Audiobook Builder — single-user studio. Worker code + D1 (binding: DB).
// Synthesis is external (Mac Mini CosyVoice 2 pipeline); this app produces
// render job packages. Display text is never overwritten by pronunciation
// rules: rules apply only to the spoken layer at package time.

const JSON_H = { "Content-Type": "application/json" };

// Tone variants ("change it slightly"): saved per casting, previewed with
// pre-rendered audio, and carried into render packages as the exact
// CosyVoice 2 instruct2 instruction the Mini pipeline must use.
const TONES = ["base", "deeper", "warmer", "brighter"];
const TONE_INSTRUCTIONS = {
  base: "",
  deeper: "speak in a deeper, lower voice",
  warmer: "speak in a warmer, softer voice",
  brighter: "speak in a brighter, younger-sounding voice",
};

function jres(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { ...JSON_H, ...extra } });
}
function jerr(msg, status = 400) {
  return jres({ error: msg }, status);
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- pronunciation rules ----------
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function rulesFor(rules, seg) {
  return rules.filter((r) => {
    if (!r.active) return false;
    if (r.scope === "global") return true;
    if (r.scope === "character") return seg.speaker_id === r.scope_id;
    if (r.scope === "chapter") return seg.chapter_id === r.scope_id;
    return false;
  });
}

// All-caps terms (acronyms: US, IT, ID, ERCOT) match case-SENSITIVELY — a
// rule for "US" must never rewrite the word "us".
function isCapsTerm(term) {
  return term.length > 1 && /[A-Za-z]/.test(term) && term === term.toUpperCase();
}
const SCOPE_RANK = { chapter: 3, character: 2, global: 1 };

function applyRules(text, rules) {
  const usable = (rules || []).filter((r) => r.term && r.respelling);
  if (!usable.length) return text;
  // Priority: scope (chapter > character > global), then longer terms first.
  // ONE combined pass over the original text: replacements are never
  // rescanned, so a rule can never match inside another rule's output.
  const sorted = [...usable].sort((a, b) =>
    (SCOPE_RANK[b.scope] || 0) - (SCOPE_RANK[a.scope] || 0) ||
    b.term.length - a.term.length);
  const re = new RegExp(
    `(?<![A-Za-z])(?:${sorted.map((r) => escRe(r.term)).join("|")})(?![A-Za-z])`, "gi");
  return text.replace(re, (m) => {
    for (const r of sorted) {
      if (isCapsTerm(r.term)) {
        if (m === r.term) return r.respelling; // exact case; respelling verbatim
      } else if (m.toLowerCase() === r.term.toLowerCase()) {
        return matchCase(m, r.respelling);
      }
    }
    return m;
  });
}
function matchCase(orig, resp) {
  if (!resp) return orig;
  if (orig === orig.toUpperCase() && orig.length > 1) return resp.toUpperCase();
  if (orig[0] === orig[0].toUpperCase()) return resp[0].toUpperCase() + resp.slice(1);
  return resp;
}
function countTerm(text, term) {
  const re = new RegExp(`(?<![A-Za-z])${escRe(term)}(?![A-Za-z])`, isCapsTerm(term) ? "g" : "gi");
  return (text.match(re) || []).length;
}

// ---------- rule-based reading pass (ingest) ----------
const VERBS = ["said", "asked", "replied", "answered", "whispered", "muttered",
  "murmured", "shouted", "yelled", "snapped", "added", "continued", "began",
  "told", "called", "noted", "observed", "remarked", "declared", "announced",
  "insisted", "admitted", "agreed", "warned", "ordered", "demanded", "inquired",
  "pressed", "urged", "offered", "suggested", "explained", "repeated", "echoed",
  "responded", "countered", "interjected", "finished", "concluded", "stated",
  "spoke", "cried", "protested", "acknowledged", "confirmed", "reported"];

// Split one paragraph into dialogue/narration pieces. Quote state carries
// across paragraphs WITHIN a chapter (createVersionWithText resets it per
// chapter). Typographic convention: a speech spanning paragraphs re-opens
// each continuation paragraph with a quote mark but closes only at the end —
// so an opening mark seen while a quote is already open is a continuation
// mark, never a close. Curly quotes are directional (“ opens, ” closes);
// straight quotes toggle, except at a paragraph start while a quote is
// open, where they are the continuation re-open mark.
function splitParagraph(text, inQuote) {
  const pieces = [];
  let buf = "", cur = inQuote ? "dialogue" : "narration";
  let atStart = true; // nothing but whitespace seen yet in this paragraph
  const push = () => {
    const piece = buf.trim();
    if (piece) pieces.push({ type: cur, text: piece });
    buf = "";
  };
  for (const ch of text) {
    if (ch === "“") { // opening quote
      if (cur !== "dialogue") { push(); cur = "dialogue"; inQuote = true; }
      atStart = false;
      continue;
    }
    if (ch === "”") { // closing quote
      if (cur === "dialogue") { push(); cur = "narration"; inQuote = false; }
      else { push(); cur = "dialogue"; inQuote = true; } // some texts use ” as the opener
      atStart = false;
      continue;
    }
    if (ch === '"') {
      if (cur === "dialogue" && atStart) { atStart = false; continue; } // continuation re-open
      push();
      cur = cur === "dialogue" ? "narration" : "dialogue";
      inQuote = cur === "dialogue";
      atStart = false;
      continue;
    }
    buf += ch;
    if (!/\s/.test(ch)) atStart = false;
  }
  push();
  return { pieces, inQuote };
}

const CHAPTER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30 };
const NAMED_HEADINGS = /^(Prologue|Epilogue|Introduction|Foreword|Preface|Afterword|Interlude)\s*$/i;

function parseManuscript(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const starts = []; // {num|null, name|null, line}
  lines.forEach((line, n) => {
    const t = line.trim();
    let m = t.match(/^Chapter\s+(\d+)\s*$/i);
    if (m) { starts.push({ num: parseInt(m[1]), name: null, line: n }); return; }
    m = t.match(/^Chapter\s+([A-Za-z]+(?:-[A-Za-z]+)?)\s*$/i);
    if (m && CHAPTER_WORDS[m[1].toLowerCase()] !== undefined) {
      starts.push({ num: CHAPTER_WORDS[m[1].toLowerCase()], name: null, line: n });
      return;
    }
    m = t.match(NAMED_HEADINGS);
    if (m) starts.push({ num: null, name: m[1], line: n });
  });
  const chapters = [];
  if (!starts.length) {
    const paras = lines.map((l) => l.trim()).filter(Boolean);
    return [{ idx: 1, title: "Chapter 1", paragraphs: paras }];
  }
  // Chapter indexes: numbered chapters keep their number. Named chapters
  // slot in by position: leading named chapters (Prologue) count up to 0 so
  // Chapter 1 stays 1; a named chapter after a numbered one takes the
  // previous chapter's idx + 1 (Epilogue after Chapter 18 -> 19).
  const firstNumPos = starts.findIndex((x) => x.num !== null);
  const leadNamed = firstNumPos === -1 ? starts.length : firstNumPos;
  let prevIdx = null;
  starts.forEach((s, k) => {
    if (s.num !== null) { s.idx = s.num; }
    else if (k < leadNamed) { s.idx = k - leadNamed + 1; } // ..., -1, 0
    else { s.idx = (prevIdx ?? 0) + 1; }
    prevIdx = s.idx;
  });
  // Front matter: anything before the first heading is kept, never dropped.
  const frontParas = lines.slice(0, starts[0].line).map((l) => l.trim()).filter(Boolean);
  if (frontParas.length) {
    chapters.push({ idx: starts[0].idx - 1, title: "Front Matter", paragraphs: frontParas });
  }
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1].line : lines.length;
    let title = "", bodyStart = s.line + 1;
    if (s.name) {
      title = s.name;
    } else {
      for (let j = s.line + 1; j < end; j++) {
        if (lines[j].trim()) { title = lines[j].trim(); bodyStart = j + 1; break; }
      }
    }
    const paras = [];
    for (let j = bodyStart; j < end; j++) if (lines[j].trim()) paras.push(lines[j].trim());
    chapters.push({ idx: s.idx, title: title || s.name || `Chapter ${s.num}`, paragraphs: paras });
  }
  return chapters;
}

function buildMatcher(roster) {
  // roster: [{id, name, aliases:[]}]
  const alias2id = new Map();
  for (const c of roster) {
    alias2id.set(c.name, c.id);
    for (const a of c.aliases || []) alias2id.set(a, c.id);
  }
  const aliases = [...alias2id.keys()].sort((a, b) => b.length - a.length);
  if (!aliases.length) return null;
  const re = new RegExp(`\\b(${aliases.map(escRe).join("|")})\\b`, "g");
  const verbRe = new RegExp(`\\b(${VERBS.join("|")})\\b`, "gi");
  return { alias2id, re, verbRe };
}

function findTag(narration, matcher) {
  if (!narration || !matcher) return null;
  const voiceCue = narration.match(new RegExp(
    `\\b(${[...matcher.alias2id.keys()].sort((a, b) => b.length - a.length).map(escRe).join("|")})(?:'s|’s) voice\\b`));
  if (voiceCue) return { id: matcher.alias2id.get(voiceCue[1]), conf: 0.85 };
  const names = [...narration.matchAll(matcher.re)].map((m) => ({ pos: m.index, id: matcher.alias2id.get(m[1]) }));
  const verbs = [...narration.matchAll(matcher.verbRe)].map((m) => m.index);
  if (!names.length || !verbs.length) return null;
  for (const n of names) for (const v of verbs) {
    if (Math.abs(v - n.pos) <= 40) return { id: n.id, conf: 0.9 };
  }
  return null;
}

// Attribute segments for one chapter. piecesList: per-paragraph piece arrays.
function attributeChapter(piecesList, matcher) {
  const segs = [];
  piecesList.forEach((pieces, pi) => {
    pieces.forEach((p, si) => {
      const seg = { paragraph_idx: pi, idx: si, type: p.type, text: p.text,
        speaker_id: null, confidence: p.type === "narration" ? 1.0 : 0.2 };
      if (p.type === "dialogue" && matcher) {
        const before = si > 0 && pieces[si - 1].type === "narration" ? pieces[si - 1].text : "";
        const after = si + 1 < pieces.length && pieces[si + 1].type === "narration" ? pieces[si + 1].text : "";
        const hit = findTag(after, matcher) || findTag(before, matcher);
        if (hit) { seg.speaker_id = hit.id; seg.confidence = hit.conf; }
      }
      segs.push(seg);
    });
  });
  // same-paragraph propagation
  const byPara = new Map();
  for (const s of segs) {
    if (!byPara.has(s.paragraph_idx)) byPara.set(s.paragraph_idx, []);
    byPara.get(s.paragraph_idx).push(s);
  }
  for (const group of byPara.values()) {
    const known = group.filter((s) => s.type === "dialogue" && s.speaker_id);
    if (known.length) {
      const best = known.reduce((a, b) => (a.confidence > b.confidence ? a : b));
      for (const s of group) {
        if (s.type === "dialogue" && !s.speaker_id) {
          s.speaker_id = best.speaker_id; s.confidence = 0.8;
        }
      }
    }
  }
  // sandwich + alternation over dialogue sequence
  const dlg = segs.filter((s) => s.type === "dialogue");
  const near = (i, dir) => {
    for (let j = i + dir; j >= 0 && j < dlg.length && Math.abs(j - i) <= 6; j += dir) {
      if (dlg[j].speaker_id) return { seg: dlg[j], dist: Math.abs(j - i) };
    }
    return null;
  };
  dlg.forEach((s, i) => {
    if (s.speaker_id) return;
    const p = near(i, -1), n = near(i, 1);
    if (p && n && p.seg.speaker_id === n.seg.speaker_id) {
      s.speaker_id = p.seg.speaker_id; s.confidence = 0.6;
    }
  });
  dlg.forEach((s, i) => {
    if (s.speaker_id) return;
    const p = near(i, -1), n = near(i, 1);
    if (p && n && p.seg.speaker_id !== n.seg.speaker_id && p.dist + n.dist <= 4) {
      s.speaker_id = (p.dist <= n.dist ? n : p).seg.speaker_id;
      s.confidence = 0.55;
    }
  });
  return segs;
}

// Auto-detect a roster from tags when a book has none yet. Scans the WHOLE
// book (both "Name said" and "said Name" orders) before attribution starts.
function detectRoster(chaptersPieces) {
  const cand = new Map();
  const verbs = "said|asked|replied|answered|whispered|muttered|murmured|shouted|yelled|snapped|added|continued|began|told|called|noted|observed|remarked|declared|announced|insisted|admitted|agreed|warned|ordered|demanded|inquired|pressed|urged|offered|suggested|explained|repeated|echoed|responded|countered|interjected|finished|concluded|stated|spoke|cried|protested|acknowledged|confirmed|reported";
  const nameFirst = new RegExp(`\\b([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})\\s+(?:${verbs})\\b`, "g");
  const verbFirst = new RegExp(`\\b(?:${verbs})\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})\\b`, "g");
  const bad = new Set(["He", "She", "It", "The", "But", "And", "Then", "Chapter"]);
  for (const piecesList of chaptersPieces) {
    for (const pieces of piecesList) {
      for (const p of pieces) {
        if (p.type !== "narration") continue;
        for (const re of [nameFirst, verbFirst]) {
          for (const m of p.text.matchAll(re)) {
            const name = m[1].trim();
            if (bad.has(name.split(" ")[0])) continue;
            cand.set(name, (cand.get(name) || 0) + 1);
          }
        }
      }
    }
  }
  return [...cand.entries()].filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1]).slice(0, 80).map(([name]) => name);
}

// ---------- D1 helpers ----------
async function multiInsert(db, table, cols, rows) {
  if (!rows.length) return;
  const per = Math.max(1, Math.floor(90 / cols.length));
  const ph = `(${cols.map(() => "?").join(",")})`;
  for (let i = 0; i < rows.length; i += per) {
    const part = rows.slice(i, i + per);
    const sql = `INSERT INTO ${table} (${cols.join(",")}) VALUES ${part.map(() => ph).join(",")}`;
    await db.prepare(sql).bind(...part.flat()).run();
  }
}

// The single stale-marking path. Semantics (C2): a chapter with render
// progress (queued/rendering/ready) whose inputs change becomes 'stale'
// AND loses its approval — a chapter can never read approved+stale at once.
// Every writer that changes render inputs goes through here.
async function markChaptersStale(db, chapterIds) {
  for (const cid of chapterIds) {
    await db.prepare(
      `UPDATE chapters SET render_state='stale', approved=0 WHERE id=? AND
       render_state IN ('queued','rendering','ready')`
    ).bind(cid).run();
  }
}
async function staleChaptersForCharacter(db, bookId, characterId) {
  const vid = await currentVersionId(db, bookId);
  const rows = await db.prepare(
    "SELECT DISTINCT chapter_id FROM segments WHERE book_id=? AND version_id=? AND speaker_id=?"
  ).bind(bookId, vid, characterId).all();
  await markChaptersStale(db, rows.results.map((r) => r.chapter_id));
}
async function staleChaptersForTerm(db, bookId, term) {
  const vid = await currentVersionId(db, bookId);
  const segs = await db.prepare(
    `SELECT DISTINCT chapter_id, display_text FROM segments WHERE book_id=? AND version_id=?`
  ).bind(bookId, vid).all();
  const hitChapters = new Set();
  for (const s of segs.results) if (countTerm(s.display_text, term) > 0) hitChapters.add(s.chapter_id);
  await markChaptersStale(db, [...hitChapters]);
}

// ---------- ingest ----------
async function createVersionWithText(db, book, text, sourceName, roster) {
  const vno = (await db.prepare(
    "SELECT COALESCE(MAX(version_no),0)+1 AS n FROM manuscript_versions WHERE book_id=?"
  ).bind(book.id).first()).n;
  // Built in a non-live state: nothing reads this version until the caller
  // flips books.current_version_id to it (and marks it 'live') at the end.
  // A failure mid-build leaves the previous version live (C3 atomicity).
  const v = await db.prepare(
    "INSERT INTO manuscript_versions (book_id, version_no, source_name, status) VALUES (?,?,?,'building') RETURNING id"
  ).bind(book.id, vno, sourceName || "").first();
  const versionId = v.id;
  const chaptersParsed = parseManuscript(text);
  // A roster of only the Narrator yields a useless matcher and would block
  // roster auto-detection for new books.
  let matcher = roster.some((r) => !r.narrator_flag) ? buildMatcher(roster) : null;
  // Pre-split every chapter, then (for a book with no roster yet) detect the
  // cast from the whole book before attributing anything.
  const allPieces = chaptersParsed.map((ch) => {
    let inQuote = false;
    return ch.paragraphs.map((p) => {
      const r = splitParagraph(p, inQuote);
      inQuote = r.inQuote;
      return r.pieces;
    });
  });
  if (!matcher) {
    const names = detectRoster(allPieces);
    const newChars = [];
    for (const name of names) {
      const row = await db.prepare(
        "INSERT INTO characters (book_id, name, aliases, tier) VALUES (?,?,?,'minor') RETURNING id"
      ).bind(book.id, name, JSON.stringify([name.split(" ").pop()])).first();
      newChars.push({ id: row.id, name, aliases: [name.split(" ").pop()] });
    }
    if (newChars.length) {
      roster = [...roster, ...newChars];
      matcher = buildMatcher(roster);
    }
  }
  const chapterRows = [];
  const paraRows = [];
  const segRows = [];
  for (let ci = 0; ci < chaptersParsed.length; ci++) {
    const ch = chaptersParsed[ci];
    const wc = ch.paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
    const chRow = await db.prepare(
      "INSERT INTO chapters (book_id, version_id, idx, title, word_count) VALUES (?,?,?,?,?) RETURNING id"
    ).bind(book.id, versionId, ch.idx, ch.title, wc).first();
    chapterRows.push({ ...ch, id: chRow.id });
    const piecesList = allPieces[ci];
    const segs = attributeChapter(piecesList, matcher);
    const paraIds = [];
    for (let pi = 0; pi < ch.paragraphs.length; pi++) {
      const hash = (await sha256hex(ch.paragraphs[pi])).slice(0, 32);
      const pr = await db.prepare(
        "INSERT INTO paragraphs (book_id, version_id, chapter_id, idx, display_text, text_hash) VALUES (?,?,?,?,?,?) RETURNING id"
      ).bind(book.id, versionId, chRow.id, pi, ch.paragraphs[pi], hash).first();
      paraIds.push(pr.id);
    }
    for (const s of segs) {
      const effSpeaker = s.type === "narration"
        ? roster.find((r) => r.narrator_flag)?.id ?? s.speaker_id : s.speaker_id;
      // Provenance (H2): machine_* records what this reading pass produced.
      // Human settlements later write settled_* and move speaker_id; the
      // machine record is never overwritten.
      segRows.push([book.id, versionId, chRow.id, paraIds[s.paragraph_idx], s.idx,
        s.type, effSpeaker, s.text, s.text, s.confidence, effSpeaker, s.confidence]);
    }
  }
  await multiInsert(db, "segments",
    ["book_id", "version_id", "chapter_id", "paragraph_id", "idx", "type",
     "speaker_id", "display_text", "spoken_text", "confidence",
     "machine_speaker", "machine_conf"], segRows);
  return { versionId, versionNo: vno, chapters: chapterRows.length, segments: segRows.length };
}

async function loadRoster(db, bookId) {
  const rows = await db.prepare(
    "SELECT id, name, aliases, narrator_flag FROM characters WHERE book_id=? ORDER BY id"
  ).bind(bookId).all();
  return rows.results.map((r) => ({ ...r, aliases: JSON.parse(r.aliases || "[]") }));
}

async function currentVersionId(db, bookId) {
  // The live version is the one the pointer names — a version still being
  // built by ingest/replace is invisible until the flip (C3 atomicity).
  const b = await db.prepare(
    "SELECT current_version_id FROM books WHERE id=?").bind(bookId).first();
  if (b && b.current_version_id) return b.current_version_id;
  const v = await db.prepare(
    "SELECT id FROM manuscript_versions WHERE book_id=? ORDER BY version_no DESC LIMIT 1"
  ).bind(bookId).first();
  return v ? v.id : null;
}

// Flip a fully built version live, atomically: pointer + status in one batch.
async function flipVersionLive(db, bookId, versionId) {
  await db.batch([
    db.prepare("UPDATE manuscript_versions SET status='superseded' WHERE book_id=? AND status='live' AND id<>?")
      .bind(bookId, versionId),
    db.prepare("UPDATE manuscript_versions SET status='live' WHERE id=?").bind(versionId),
    db.prepare("UPDATE books SET current_version_id=? WHERE id=?").bind(versionId, bookId),
  ]);
}

// ---------- contested lines (the disagreement system) ----------
// A dialogue line is CONTESTED when a human has not settled it: confidence
// < 0.85 OR no speaker at all (H1 — one definition, shared by the queues,
// the book counts and the render-package guard). Settlements are stored at
// confidence 1.0 with settled_* provenance, so "settled" reads off the row.
// Contested is a derived state — no parallel bookkeeping. Displayed
// turns/words count confirmed lines only.
const CONF_LINE = 0.85;
const WORDS_EXPR = "(LENGTH(display_text)-LENGTH(REPLACE(display_text,' ',''))+1)";

async function characterStats(db, bookId, vid) {
  const rows = await db.prepare(
    `SELECT speaker_id,
       SUM(CASE WHEN confidence>=${CONF_LINE} THEN 1 ELSE 0 END) AS conf_turns,
       SUM(CASE WHEN confidence>=${CONF_LINE} THEN ${WORDS_EXPR} ELSE 0 END) AS conf_words,
       SUM(CASE WHEN type='dialogue' AND confidence<${CONF_LINE} THEN 1 ELSE 0 END) AS contested_turns,
       SUM(CASE WHEN type='dialogue' AND confidence>=${CONF_LINE} THEN 1 ELSE 0 END) AS conf_dialogue,
       SUM(CASE WHEN type='dialogue' THEN 1 ELSE 0 END) AS dialogue_turns
     FROM segments WHERE book_id=? AND version_id=? AND speaker_id IS NOT NULL
     GROUP BY speaker_id`).bind(bookId, vid).all();
  const map = {};
  for (const r of rows.results) map[r.speaker_id] = r;
  return map;
}

// Which segment each character's preview line came from (exact-text match on
// the character's own segments — the same match the manifest build used).
async function previewSegments(db, bookId, vid) {
  const pv = await db.prepare(
    "SELECT character_id, line_text FROM previews WHERE book_id=?").bind(bookId).all();
  const segs = await db.prepare(
    "SELECT id, speaker_id, confidence, display_text FROM segments " +
    "WHERE book_id=? AND version_id=? AND speaker_id IS NOT NULL").bind(bookId, vid).all();
  const byKey = {};
  for (const s of segs.results) byKey[s.speaker_id + "|" + s.display_text] = s;
  const map = {};
  for (const p of pv.results) {
    const s = byKey[p.character_id + "|" + p.line_text];
    if (s) map[p.character_id] = { segment_id: s.id, confidence: s.confidence };
  }
  return map;
}

// The contested-line computation. Every contested dialogue line lands in
// exactly one of two settle lists: `disputes` (lines carrying a second
// named candidate OR a high character impact — the segment is the
// character's preview line, or the character has no confirmed line at all,
// or this is their only line) and `queue` (all the rest). Both lists settle
// through the same PATCH path, so contested_total always equals
// disputes.length + queue.length — every contested line is reachable.
// The per-line census attribution file no longer exists, so second
// candidates come from the text itself, labeled by their evidence: a
// speaker tag in the adjoining narration, the speaker on both sides of the
// line, or the other voice(s) in the exchange.
async function computeContested(db, bookId, vid) {
  const roster = await loadRoster(db, bookId);
  const matcher = buildMatcher(roster);
  const nameOf = {};
  for (const c of roster) nameOf[c.id] = c.name;
  const chRows = (await db.prepare(
    "SELECT id, idx, title FROM chapters WHERE book_id=? AND version_id=?").bind(bookId, vid).all()).results;
  const chMap = {};
  for (const c of chRows) chMap[c.id] = c;
  const segs = (await db.prepare(
    "SELECT id, chapter_id, paragraph_id, idx, type, speaker_id, confidence, display_text " +
    "FROM segments WHERE book_id=? AND version_id=? ORDER BY chapter_id, paragraph_id, idx"
  ).bind(bookId, vid).all()).results;
  const stats = await characterStats(db, bookId, vid);
  const pvSegs = await previewSegments(db, bookId, vid);
  const pvSegIds = {};
  for (const [cid, pv] of Object.entries(pvSegs)) pvSegIds[pv.segment_id] = Number(cid);

  const byChapter = new Map();
  for (const s of segs) {
    if (!byChapter.has(s.chapter_id)) byChapter.set(s.chapter_id, []);
    byChapter.get(s.chapter_id).push(s);
  }
  let contestedTotal = 0;
  const items = [];
  for (const list of byChapter.values()) {
    const dlgPos = [];
    list.forEach((s, i) => { if (s.type === "dialogue") dlgPos.push(i); });
    list.forEach((s, pos) => {
      if (s.type !== "dialogue") return;
      if (s.speaker_id && s.confidence >= CONF_LINE) return; // settled
      contestedTotal++;
      const di = dlgPos.indexOf(pos);
      const prevD = di > 0 ? list[dlgPos[di - 1]] : null;
      const nextD = di >= 0 && di < dlgPos.length - 1 ? list[dlgPos[di + 1]] : null;
      const narrNear = [];
      for (let i = pos - 1; i >= 0 && narrNear.length < 3; i--) {
        if (list[i].type === "dialogue") break;
        narrNear.push(list[i]);
      }
      for (let i = pos + 1; i < list.length && narrNear.length < 6; i++) {
        if (list[i].type === "dialogue") break;
        narrNear.push(list[i]);
      }
      const alts = [];
      const addAlt = (id, label) => {
        if (id && id !== s.speaker_id && !alts.find((a) => a.id === id) && alts.length < 2)
          alts.push({ id, name: nameOf[id] || ("#" + id), label });
      };
      // 1) a speaker tag in the narration right after / before the line
      let tagHit = null;
      const after = list[pos + 1] && list[pos + 1].type !== "dialogue" ? list[pos + 1].display_text : null;
      const before = list[pos - 1] && list[pos - 1].type !== "dialogue" ? list[pos - 1].display_text : null;
      if (after) tagHit = findTag(after, matcher);
      if (!tagHit && before) tagHit = findTag(before, matcher);
      if (tagHit) addAlt(tagHit.id, "Named in the text right here");
      // 2) the same speaker on both sides (sandwich)
      if (prevD && nextD && prevD.speaker_id && prevD.speaker_id === nextD.speaker_id)
        addAlt(prevD.speaker_id, "Speaker on both sides of this line");
      // 3) the other voice(s) in the exchange
      if (prevD) addAlt(prevD.speaker_id, "Also speaking in this exchange");
      if (nextD) addAlt(nextD.speaker_id, "Also speaking in this exchange");
      // 4) exactly one other character named in the adjoining narration
      if (!alts.length && matcher && narrNear.length) {
        const named = new Set();
        for (const n of narrNear)
          for (const m of n.display_text.matchAll(matcher.re))
            named.add(matcher.alias2id.get(m[1]));
        named.delete(s.speaker_id);
        if (named.size === 1) addAlt([...named][0], "Named in the text right here");
      }
      const st = (s.speaker_id && stats[s.speaker_id]) || { conf_dialogue: 0, dialogue_turns: 0 };
      let impact = null;
      if (st.dialogue_turns > 0 && st.conf_dialogue === 0) impact = "all";
      else if (st.dialogue_turns === 1) impact = "only";
      else if (pvSegIds[s.id] === s.speaker_id) impact = "preview";
      const ctx = (x) => (x ? x.display_text.slice(0, 170) : "");
      items.push({
        id: s.id, chapter_idx: chMap[s.chapter_id]?.idx ?? null,
        chapter_title: chMap[s.chapter_id]?.title ?? "",
        paragraph_id: s.paragraph_id, idx: s.idx,
        text: s.display_text, confidence: s.confidence,
        speaker_id: s.speaker_id, speaker_name: nameOf[s.speaker_id] || "—",
        context_before: ctx(list[pos - 1]), context_after: ctx(list[pos + 1]),
        candidates: alts, impact,
        char_confirmed: st.conf_dialogue, char_total: st.dialogue_turns,
        in_disputes: alts.length > 0 || !!impact,
        _rank: impact === "all" ? 0 : impact === "only" ? 1 : impact === "preview" ? 2 : 3,
        _ch: chMap[s.chapter_id]?.idx ?? 0,
      });
    });
  }
  const disputes = items.filter((d) => d.in_disputes);
  disputes.sort((a, b) => a._rank - b._rank || a._ch - b._ch ||
    a.paragraph_id - b.paragraph_id || a.idx - b.idx || a.id - b.id);
  const queueItems = items.filter((d) => !d.in_disputes);
  queueItems.sort((a, b) => a._ch - b._ch ||
    a.paragraph_id - b.paragraph_id || a.idx - b.idx || a.id - b.id);
  const two = disputes.filter((d) => d.candidates.length > 0).length;
  return { disputes, queue: queueItems, contested_total: contestedTotal,
           two_candidate: two, single_candidate: disputes.length - two };
}

// Keyset pagination over a pre-sorted list: the cursor carries the sort
// tuple of the last item served, so settling items (which removes them
// from the list) can never shift the window and skip a line the way
// offset pagination did.
function keysetPage(items, keyOf, cursor, limit) {
  let start = 0;
  if (cursor) {
    let cur = null;
    try { cur = JSON.parse(atob(cursor)); } catch { cur = null; }
    if (Array.isArray(cur)) {
      start = items.length;
      for (let i = 0; i < items.length; i++) {
        const k = keyOf(items[i]);
        let gt = false;
        for (let j = 0; j < k.length; j++) {
          if (k[j] > cur[j]) { gt = true; break; }
          if (k[j] < cur[j]) break;
        }
        if (gt) { start = i; break; }
      }
    }
  }
  const page = items.slice(start, start + limit);
  const next = page.length && start + limit < items.length
    ? btoa(JSON.stringify(keyOf(page[page.length - 1]))) : null;
  return { page, next_cursor: next };
}
function disputeKey(d) { return [d._rank ?? 3, d._ch ?? 0, d.paragraph_id, d.idx, d.id]; }
function queueKey(d) { return [d._ch ?? 0, d.paragraph_id, d.idx, d.id]; }
function stripInternal(d) {
  const { _rank, _ch, in_disputes, ...rest } = d;
  return rest;
}

// ---------- API ----------
async function api(req, env, url) {
  const db = env.DB;
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const seg = parts.slice(1);
  const method = req.method;

  if (seg[0] === "health") return jres({ ok: true, app: "audiobook-builder" });

  // /api/books
  if (seg[0] === "books" && seg.length === 1) {
    if (method === "GET") {
      const rows = await db.prepare("SELECT * FROM books ORDER BY id").all();
      return jres({ books: rows.results });
    }
    if (method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || !body.title || !body.text) return jerr("title and text are required", 422);
      const b = await db.prepare(
        "INSERT INTO books (title, author, engine_version) VALUES (?,?,?) RETURNING id"
      ).bind(body.title, body.author || "", "cosyvoice2-0.5").first();
      const book = { id: b.id };
      const narr = await db.prepare(
        "INSERT INTO characters (book_id, name, aliases, tier, narrator_flag) VALUES (?, 'Narrator', '[]', 'narrator', 1) RETURNING id"
      ).bind(b.id).first();
      const roster = [{ id: narr.id, name: "Narrator", aliases: [], narrator_flag: 1 }];
      const stats = await createVersionWithText(db, book, body.text, body.source_name || "pasted/uploaded", roster);
      const vid = await db.prepare(
        "SELECT id FROM manuscript_versions WHERE book_id=? AND status='building' ORDER BY version_no DESC LIMIT 1"
      ).bind(b.id).first();
      if (vid) await flipVersionLive(db, b.id, vid.id);
      return jres({ book_id: b.id, ...stats }, 201);
    }
  }

  const bookId = seg[0] === "books" && seg[1] ? parseInt(seg[1]) : null;

  if (bookId && seg.length === 2 && method === "GET") {
    const book = await db.prepare("SELECT * FROM books WHERE id=?").bind(bookId).first();
    if (!book) return jerr("book not found", 404);
    const vid = await currentVersionId(db, bookId);
    const chapters = await db.prepare(
      "SELECT * FROM chapters WHERE book_id=? AND version_id=? ORDER BY idx").bind(bookId, vid).all();
    const counts = await db.prepare(
      `SELECT (SELECT COUNT(*) FROM characters WHERE book_id=?) AS characters,
              (SELECT COUNT(*) FROM segments WHERE book_id=? AND version_id=? AND type='dialogue' AND (speaker_id IS NULL OR confidence<0.85)) AS queue,
              (SELECT COUNT(*) FROM flags WHERE book_id=? AND status='open') AS open_flags,
              (SELECT COUNT(*) FROM pron_rules WHERE book_id=? AND active=1) AS rules,
              (SELECT COUNT(*) FROM segments WHERE book_id=? AND version_id=?) AS segments`
    ).bind(bookId, bookId, vid, bookId, bookId, bookId, vid).first();
    const versions = await db.prepare(
      "SELECT * FROM manuscript_versions WHERE book_id=? ORDER BY version_no").bind(bookId).all();
    return jres({ book, chapters: chapters.results, counts, versions: versions.results });
  }

  if (bookId && seg[2] === "characters") {
    if (method === "GET") {
      const rows = await db.prepare(
        `SELECT c.*, ca.voice_id, ca.speed, ca.prompt, ca.tone, ca.confirmed, v.name AS voice_name,
                pv.line_text AS preview_line,
                cn.why_text AS why_text, cn.shaky AS shaky, cn.collision AS collision
         FROM characters c LEFT JOIN castings ca ON ca.book_id=c.book_id AND ca.character_id=c.id
         LEFT JOIN voices v ON v.id=ca.voice_id
         LEFT JOIN previews pv ON pv.book_id=c.book_id AND pv.character_id=c.id
         LEFT JOIN casting_notes cn ON cn.book_id=c.book_id AND cn.character_id=c.id
         WHERE c.book_id=? ORDER BY c.narrator_flag DESC, c.turns DESC, c.id`).bind(bookId).all();
      const aud = await db.prepare(
        `SELECT a.character_id, a.voice_id, v.name AS voice_name
         FROM auditions a LEFT JOIN voices v ON v.id=a.voice_id
         WHERE a.book_id=? ORDER BY a.voice_id`).bind(bookId).all();
      const audByChar = new Map();
      for (const a of aud.results) {
        if (!audByChar.has(a.character_id)) audByChar.set(a.character_id, []);
        audByChar.get(a.character_id).push({ voice_id: a.voice_id, voice_name: a.voice_name });
      }
      // Contested lines don't count: displayed turns/words are the confirmed
      // segment counts (confidence >= 0.85; manual fixes sit at 1.0). The
      // census figures ride along as census_turns / census_words.
      const vid = await currentVersionId(db, bookId);
      const stats = await characterStats(db, bookId, vid);
      const pvSegs = await previewSegments(db, bookId, vid);
      const chars = rows.results.map((r) => {
        const st = stats[r.id];
        const pv = pvSegs[r.id];
        const out = { ...r, tone: r.tone || "base",
          aliases: JSON.parse(r.aliases || "[]"),
          auditions: audByChar.get(r.id) || [],
          census_turns: r.turns, census_words: r.words,
          contested_turns: st ? st.contested_turns : 0,
          disputed_all: st && st.dialogue_turns > 0 && st.conf_dialogue === 0 ? 1 : 0,
          disputed_only_line: st && st.dialogue_turns === 1 && st.contested_turns === 1 ? 1 : 0,
          dialogue_total: st ? st.dialogue_turns : 0,
          preview_segment_id: pv ? pv.segment_id : null,
          preview_contested: pv && pv.confidence < CONF_LINE ? 1 : 0,
        };
        if (st) { out.turns = st.conf_turns; out.words = st.conf_words; }
        // shaky is derived now: the preview line is contested, or every one
        // of the character's lines is.
        out.shaky = out.preview_contested || out.disputed_all ? 1 : 0;
        return out;
      });
      chars.sort((a, b) => (b.narrator_flag - a.narrator_flag) ||
        (b.turns - a.turns) || (a.id - b.id));
      return jres({ characters: chars });
    }
    if (method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || !body.name) return jerr("name is required", 422);
      const r = await db.prepare(
        "INSERT INTO characters (book_id, name, aliases, tier, role_note) VALUES (?,?,?,?,?) RETURNING id"
      ).bind(bookId, body.name, JSON.stringify(body.aliases || []), body.tier || "minor", body.role_note || "").first();
      return jres({ id: r.id }, 201);
    }
  }

  if (seg[0] === "characters" && seg[1]) {
    const charId = parseInt(seg[1]);
    if (seg[2] === "merge" && method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || !body.into_id) return jerr("into_id is required", 422);
      await db.prepare("UPDATE segments SET speaker_id=? WHERE speaker_id=?").bind(body.into_id, charId).run();
      await db.prepare("DELETE FROM castings WHERE character_id=?").bind(charId).run();
      await db.prepare("DELETE FROM characters WHERE id=?").bind(charId).run();
      return jres({ ok: true });
    }
    if (method === "PATCH") {
      const body = await req.json().catch(() => ({}));
      const cur = await db.prepare("SELECT * FROM characters WHERE id=?").bind(charId).first();
      if (!cur) return jerr("character not found", 404);
      await db.prepare("UPDATE characters SET name=?, aliases=?, tier=?, role_note=? WHERE id=?")
        .bind(body.name ?? cur.name, JSON.stringify(body.aliases ?? JSON.parse(cur.aliases || "[]")),
          body.tier ?? cur.tier, body.role_note ?? cur.role_note, charId).run();
      return jres({ ok: true });
    }
  }

  if (seg[0] === "chapters" && seg[1] && method === "PATCH") {
    const chId = parseInt(seg[1]);
    const body = await req.json().catch(() => ({}));
    const cur = await db.prepare("SELECT * FROM chapters WHERE id=?").bind(chId).first();
    if (!cur) return jerr("chapter not found", 404);
    const newState = body.render_state ?? cur.render_state;
    // C2 invariant: a stale chapter is never approved.
    const newApproved = newState === "stale" ? 0
      : (body.approved === undefined ? cur.approved : (body.approved ? 1 : 0));
    await db.prepare("UPDATE chapters SET title=?, included=?, approved=?, render_state=? WHERE id=?")
      .bind(body.title ?? cur.title,
        body.included === undefined ? cur.included : (body.included ? 1 : 0),
        newApproved, newState, chId).run();
    return jres({ ok: true });
  }

  if (bookId && seg[2] === "queue" && method === "GET") {
    // The plain settle list: contested lines WITHOUT a second candidate or
    // character impact (the disputes list carries the rest). One
    // computation (computeContested), one settle path — every contested
    // line appears in exactly one of the two lists, keyset-paginated so
    // settling items can never skip a line.
    const vid = await currentVersionId(db, bookId);
    const c = await computeContested(db, bookId, vid);
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "100")));
    const { page, next_cursor } = keysetPage(c.queue, queueKey,
      url.searchParams.get("cursor"), limit);
    const out = page.map((d) => {
      const r = stripInternal(d);
      return { id: r.id, ch_idx: r.chapter_idx, ch_title: r.chapter_title,
        paragraph_id: r.paragraph_id, idx: r.idx,
        display_text: r.text, text: r.text,
        speaker_id: r.speaker_id, confidence: r.confidence,
        context_before: r.context_before, context_after: r.context_after };
    });
    return jres({ queue: out, total: c.queue.length,
      contested_total: c.contested_total, next_cursor });
  }

  if (bookId && seg[2] === "disputes" && method === "GET") {
    const vid = await currentVersionId(db, bookId);
    const d = await computeContested(db, bookId, vid);
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "100")));
    const { page, next_cursor } = keysetPage(d.disputes, disputeKey,
      url.searchParams.get("cursor"), limit);
    return jres({ disputes: page.map(stripInternal),
      total: d.disputes.length, contested_total: d.contested_total,
      two_candidate: d.two_candidate, single_candidate: d.single_candidate,
      next_cursor });
  }

  if (bookId && seg[2] === "segments" && method === "GET") {
    const chapterId = url.searchParams.get("chapter_id");
    if (!chapterId) return jerr("chapter_id is required", 422);
    const rows = await db.prepare(
      `SELECT s.*, c.name AS speaker_name FROM segments s
       LEFT JOIN characters c ON c.id=s.speaker_id
       WHERE s.chapter_id=? ORDER BY s.paragraph_id, s.idx`).bind(parseInt(chapterId)).all();
    return jres({ segments: rows.results });
  }

  if (seg[0] === "segments" && seg[1] && method === "PATCH") {
    const sId = parseInt(seg[1]);
    const body = await req.json().catch(() => ({}));
    const cur = await db.prepare("SELECT * FROM segments WHERE id=?").bind(sId).first();
    if (!cur) return jerr("segment not found", 404);
    if (body.speaker_id !== undefined) {
      // A settlement (M3 validation + H2 provenance + C2 staleness):
      // - speaker changes are dialogue-only;
      // - a named speaker must exist and belong to this segment's book;
      // - settling writes settled_* and derives confidence (1.0 named,
      //   0.2 when settled to "nobody") — a null speaker NEVER reads as
      //   confirmed; machine_* provenance is never touched;
      // - a real speaker change stales the segment's chapter.
      if (cur.type !== "dialogue")
        return jerr("speaker can only be set on dialogue segments", 400);
      const speaker = body.speaker_id;
      if (speaker !== null) {
        if (!Number.isInteger(speaker)) return jerr("speaker_id must be an integer or null", 400);
        const ch = await db.prepare("SELECT id, book_id FROM characters WHERE id=?").bind(speaker).first();
        if (!ch) return jerr("speaker not found", 400);
        if (ch.book_id !== cur.book_id) return jerr("speaker belongs to a different book", 400);
      }
      const changed = speaker !== cur.speaker_id;
      await db.prepare(
        `UPDATE segments SET speaker_id=?, confidence=?, status=?,
           settled_speaker=?, settled_at=? WHERE id=?`
      ).bind(speaker, speaker === null ? 0.2 : 1.0, body.status ?? cur.status,
        speaker, new Date().toISOString(), sId).run();
      if (changed) await markChaptersStale(db, [cur.chapter_id]);
      return jres({ ok: true });
    }
    await db.prepare("UPDATE segments SET status=? WHERE id=?")
      .bind(body.status ?? cur.status, sId).run();
    return jres({ ok: true });
  }

  if (seg[0] === "voices") {
    if (method === "GET") {
      const rows = await db.prepare("SELECT * FROM voices ORDER BY id").all();
      return jres({ voices: rows.results });
    }
    if (method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || !body.name) return jerr("name is required", 422);
      const r = await db.prepare(
        `INSERT INTO voices (name, engine, kind, description, tags, ref_text, provenance, consent)
         VALUES (?,?,?,?,?,?,?,?) RETURNING id`
      ).bind(body.name, body.engine || "CosyVoice 2", body.kind || "cloned",
        body.description || "", body.tags || "", body.ref_text || "",
        body.provenance || "", body.consent || "").first();
      return jres({ id: r.id }, 201);
    }
  }

  if (seg[0] === "castings" && method === "PUT") {
    const body = await req.json().catch(() => null);
    if (!body || !body.book_id || !body.character_id) return jerr("book_id and character_id are required", 422);
    const book = await db.prepare("SELECT casting_locked FROM books WHERE id=?").bind(body.book_id).first();
    if (!book) return jerr("book not found", 404);
    if (book.casting_locked) return jerr("casting is locked for this book", 409);
    if (body.tone !== undefined && !TONES.includes(body.tone)) return jerr("unknown tone variant", 422);
    if (body.confirmed !== undefined && ![0, 1].includes(body.confirmed)) return jerr("confirmed must be 0 or 1", 422);
    // Merge semantics: fields the caller omits keep their current values, so
    // a voice swap, a tone tweak, and a pace change can be saved independently.
    const cur = await db.prepare(
      "SELECT * FROM castings WHERE book_id=? AND character_id=?")
      .bind(body.book_id, body.character_id).first();
    const voiceId = body.voice_id === undefined ? (cur?.voice_id ?? null) : body.voice_id;
    const speed = body.speed === undefined ? (cur?.speed ?? 1.0)
      : Math.min(2, Math.max(0.5, parseFloat(body.speed) || 1.0));
    const prompt = body.prompt === undefined ? (cur?.prompt ?? "") : body.prompt;
    const tone = body.tone === undefined ? (cur?.tone ?? "base") : body.tone;
    const confirmed = body.confirmed === undefined ? (cur?.confirmed ?? 0) : body.confirmed;
    await db.prepare(
      `INSERT INTO castings (book_id, character_id, voice_id, speed, prompt, tone, confirmed) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(book_id, character_id) DO UPDATE SET voice_id=excluded.voice_id,
       speed=excluded.speed, prompt=excluded.prompt, tone=excluded.tone, confirmed=excluded.confirmed`
    ).bind(body.book_id, body.character_id, voiceId, speed, prompt, tone, confirmed).run();
    // C2: stale only when a RENDER input changed (voice / pace / prompt /
    // tone). Flipping `confirmed` alone changes no render input and must
    // NOT stale chapters.
    const renderChanged = !cur || cur.voice_id !== voiceId || cur.speed !== speed ||
      cur.prompt !== prompt || cur.tone !== tone;
    if (renderChanged) await staleChaptersForCharacter(db, body.book_id, body.character_id);
    return jres({ ok: true, voice_id: voiceId, speed, prompt, tone, confirmed });
  }

  // Bulk-confirm castings (the grouped tail's "Looks good"): confirmation is
  // workflow state only — it changes no render input, so no stale-marking.
  if (seg[0] === "castings" && seg[1] === "confirm" && method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || !body.book_id || !Array.isArray(body.character_ids) || !body.character_ids.length)
      return jerr("book_id and character_ids[] are required", 422);
    const book = await db.prepare("SELECT casting_locked FROM books WHERE id=?").bind(body.book_id).first();
    if (!book) return jerr("book not found", 404);
    if (book.casting_locked) return jerr("casting is locked for this book", 409);
    let n = 0;
    for (const cid of body.character_ids) {
      const r = await db.prepare(
        "UPDATE castings SET confirmed=1 WHERE book_id=? AND character_id=?")
        .bind(body.book_id, cid).run();
      n += r.meta?.changes ?? 0;
    }
    return jres({ ok: true, confirmed: n });
  }

  if (bookId && seg[2] === "cast" && seg[3] === "accept-all" && method === "POST") {
    const book = await db.prepare("SELECT casting_locked FROM books WHERE id=?").bind(bookId).first();
    if (book.casting_locked) return jerr("casting is locked for this book", 409);
    const chars = await db.prepare("SELECT * FROM characters WHERE book_id=? ORDER BY id").bind(bookId).all();
    const fixed = new Map(); // top-5 by turns get the hand-picked lead voices
    const leads = chars.results.filter((c) => !c.narrator_flag)
      .sort((a, b) => b.turns - a.turns);
    const leadVoices = [5, 2, 3, 4, 6];
    leads.slice(0, 5).forEach((c, i) => fixed.set(c.id, leadVoices[i]));
    // Gender is DATA (characters.gender, 'F'/'M'), never a name list in
    // code — the cast of a book is the book's content, not the app's.
    const pool = [7, 8, 9, 10, 11, 12, 13, 14, 5, 3, 4, 6];
    const util = [13, 14, 12];
    const existingCast = await db.prepare(
      "SELECT character_id, voice_id FROM castings WHERE book_id=?").bind(bookId).all();
    const prevVoice = {};
    for (const r of existingCast.results) prevVoice[r.character_id] = r.voice_id;
    const voiceChanged = [];
    for (const c of chars.results) {
      let v;
      if (c.narrator_flag) v = 1;
      else if (fixed.has(c.id)) v = fixed.get(c.id);
      else if (c.gender === "F") {
        const p = (c.tier === "lead" || c.tier === "supporting") ? [7, 8, 11, 14, 3, 4] : [14, 12, 11];
        v = p[(c.id * 7) % p.length];
      } else if (c.gender === "M") {
        const p = (c.tier === "lead" || c.tier === "supporting") ? [9, 10, 13, 5, 6, 2] : [13, 12, 10];
        v = p[(c.id * 7) % p.length];
      }
      else if (c.tier === "lead" || c.tier === "supporting") v = pool[(c.id * 7) % pool.length];
      else v = util[c.id % util.length];
      await db.prepare(
        `INSERT INTO castings (book_id, character_id, voice_id) VALUES (?,?,?)
         ON CONFLICT(book_id, character_id) DO UPDATE SET voice_id=excluded.voice_id`
      ).bind(bookId, c.id, v).run();
      if (prevVoice[c.id] !== v) voiceChanged.push(c.id);
    }
    // C2: re-casting stales only the chapters of characters whose voice
    // actually changed.
    for (const cid of voiceChanged) await staleChaptersForCharacter(db, bookId, cid);
    return jres({ ok: true, cast: chars.results.length });
  }

  if (bookId && seg[2] === "cast" && seg[3] === "lock" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    await db.prepare("UPDATE books SET casting_locked=? WHERE id=?")
      .bind(body.locked ? 1 : 0, bookId).run();
    return jres({ ok: true, locked: !!body.locked });
  }

  if (bookId && seg[2] === "collisions" && method === "GET") {
    const rows = await db.prepare(
      `SELECT ca.voice_id, v.name AS voice_name, GROUP_CONCAT(c.name, ', ') AS names, COUNT(*) AS n
       FROM castings ca JOIN characters c ON c.id=ca.character_id
       LEFT JOIN voices v ON v.id=ca.voice_id
       WHERE ca.book_id=? AND ca.voice_id IS NOT NULL
       GROUP BY ca.voice_id HAVING n>1 ORDER BY n DESC`).bind(bookId).all();
    return jres({ collisions: rows.results });
  }

  if (bookId && seg[2] === "rules") {
    if (method === "GET") {
      const rows = await db.prepare(
        "SELECT * FROM pron_rules WHERE book_id=? ORDER BY active DESC, term").bind(bookId).all();
      return jres({ rules: rows.results });
    }
    if (method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || !body.term?.trim() || !body.respelling?.trim())
        return jerr("term and respelling must be non-empty", 400);
      const r = await db.prepare(
        `INSERT INTO pron_rules (book_id, term, respelling, scope, scope_id) VALUES (?,?,?,?,?) RETURNING id`
      ).bind(bookId, body.term.trim(), body.respelling.trim(), body.scope || "global",
        body.scope_id ?? null).first();
      await staleChaptersForTerm(db, bookId, body.term);
      return jres({ id: r.id }, 201);
    }
  }
  if (seg[0] === "rules" && seg[1] && method === "PATCH") {
    const rId = parseInt(seg[1]);
    const body = await req.json().catch(() => ({}));
    const cur = await db.prepare("SELECT * FROM pron_rules WHERE id=?").bind(rId).first();
    if (!cur) return jerr("rule not found", 404);
    if (body.respelling !== undefined && !String(body.respelling).trim())
      return jerr("respelling must be non-empty", 400);
    await db.prepare("UPDATE pron_rules SET respelling=?, scope=?, scope_id=?, active=? WHERE id=?")
      .bind(body.respelling ?? cur.respelling, body.scope ?? cur.scope,
        body.scope_id === undefined ? cur.scope_id : body.scope_id,
        body.active === undefined ? cur.active : (body.active ? 1 : 0), rId).run();
    await staleChaptersForTerm(db, cur.book_id, cur.term);
    return jres({ ok: true });
  }

  if (bookId && seg[2] === "occurrences" && method === "GET") {
    const term = url.searchParams.get("term") || "";
    if (!term) return jerr("term is required", 422);
    const vid = await currentVersionId(db, bookId);
    const rows = await db.prepare(
      `SELECT s.id, s.display_text, ch.idx AS ch_idx, ch.title AS ch_title
       FROM segments s JOIN chapters ch ON ch.id=s.chapter_id
       WHERE s.book_id=? AND s.version_id=? ORDER BY ch.idx, s.paragraph_id, s.idx`
    ).bind(bookId, vid).all();
    let count = 0;
    const perChapter = new Map();
    const samples = [];
    for (const s of rows.results) {
      const n = countTerm(s.display_text, term);
      if (n) {
        count += n;
        perChapter.set(s.ch_idx, (perChapter.get(s.ch_idx) || 0) + n);
        if (samples.length < 10) samples.push({ segment_id: s.id, ch_idx: s.ch_idx, text: s.display_text });
      }
    }
    return jres({ term, count, chapters: [...perChapter.entries()].map(([idx, n]) => ({ idx, count: n })), samples });
  }

  if (bookId && seg[2] === "tricky" && method === "GET") {
    const vid = await currentVersionId(db, bookId);
    const rows = await db.prepare(
      "SELECT display_text FROM segments WHERE book_id=? AND version_id=?").bind(bookId, vid).all();
    const ruled = await db.prepare(
      "SELECT term FROM pron_rules WHERE book_id=? AND active=1").bind(bookId).all();
    const ruledSet = new Set(ruled.results.map((r) => r.term.toLowerCase()));
    const roster = await loadRoster(db, bookId);
    const nameWords = new Set();
    for (const c of roster) {
      nameWords.add(c.name.toLowerCase());
      for (const a of c.aliases) a.toLowerCase().split(/\s+/).forEach((w) => nameWords.add(w));
      c.name.toLowerCase().split(/\s+/).forEach((w) => nameWords.add(w));
    }
    const STOP = new Set(["i", "mr", "mrs", "dr", "sen", "col", "gen", "capt", "lt", "maj",
      "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
      "january", "february", "march", "april", "may", "june", "july", "august",
      "september", "october", "november", "december",
      "american", "americans", "english", "texas", "houston", "washington",
      "christmas", "thanksgiving", "god", "president", "senate", "congress",
      "white", "house", "earth", "internet", "google", "iphone"]);
    const counts = new Map();
    const wordRe = /[A-Za-z][A-Za-z'’-]+/g;
    for (const r of rows.results) {
      const text = r.display_text;
      let m;
      wordRe.lastIndex = 0;
      while ((m = wordRe.exec(text))) {
        const w = m[0];
        const before = text.slice(Math.max(0, m.index - 2), m.index);
        const sentenceStart = m.index === 0 || /[.!?…]\s*$/.test(before) || /["“]\s*$/.test(before);
        const isAcronym = /^[A-Z]{2,}$/.test(w);
        const isCap = /^[A-Z]/.test(w);
        if (!isAcronym && !(isCap && !sentenceStart)) continue;
        if (!isAcronym && /['’]/.test(w)) continue; // contractions are not tricky
        const key = w.replace(/['’]s$/i, "");
        if (STOP.has(key.toLowerCase()) || nameWords.has(key.toLowerCase())) continue;
        if (ruledSet.has(key.toLowerCase())) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    const words = [...counts.entries()].map(([word, count]) => ({ word, count }))
      .filter((w) => w.count >= 2).sort((a, b) => b.count - a.count).slice(0, 40);
    return jres({ words });
  }

  if (bookId && seg[2] === "flags") {
    if (method === "GET") {
      const rows = await db.prepare(
        `SELECT f.*, s.display_text AS segment_text, ch.idx AS ch_idx
         FROM flags f LEFT JOIN segments s ON s.id=f.segment_id
         LEFT JOIN chapters ch ON ch.id=f.chapter_id
         WHERE f.book_id=? ORDER BY f.status, f.id DESC`).bind(bookId).all();
      return jres({ flags: rows.results });
    }
    if (method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || !body.type) return jerr("type is required", 422);
      let chapterId = body.chapter_id ?? null;
      if (!chapterId && body.segment_id) {
        const s = await db.prepare("SELECT chapter_id FROM segments WHERE id=?").bind(body.segment_id).first();
        chapterId = s ? s.chapter_id : null;
      }
      const r = await db.prepare(
        `INSERT INTO flags (book_id, segment_id, chapter_id, type, note) VALUES (?,?,?,?,?) RETURNING id`
      ).bind(bookId, body.segment_id ?? null, chapterId, body.type, body.note || "").first();
      return jres({ id: r.id }, 201);
    }
  }
  if (seg[0] === "flags" && seg[1] && method === "PATCH") {
    const fId = parseInt(seg[1]);
    const body = await req.json().catch(() => ({}));
    const cur = await db.prepare("SELECT * FROM flags WHERE id=?").bind(fId).first();
    if (!cur) return jerr("flag not found", 404);
    await db.prepare("UPDATE flags SET status=?, resolution=? WHERE id=?")
      .bind(body.status ?? cur.status, body.resolution ?? cur.resolution, fId).run();
    return jres({ ok: true });
  }

  if (bookId && seg[2] === "render-package" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    const book = await db.prepare("SELECT * FROM books WHERE id=?").bind(bookId).first();
    if (!book) return jerr("book not found", 404);
    const vid = await currentVersionId(db, bookId);
    const rules = (await db.prepare(
      "SELECT * FROM pron_rules WHERE book_id=? AND active=1").bind(bookId).all()).results;
    const castRows = (await db.prepare(
      `SELECT ca.*, c.name AS character_name, v.name AS voice_name, v.engine AS voice_engine
       FROM castings ca JOIN characters c ON c.id=ca.character_id
       LEFT JOIN voices v ON v.id=ca.voice_id WHERE ca.book_id=?`).bind(bookId).all()).results;
    const castMap = new Map(castRows.map((r) => [r.character_id, r]));
    const charRows = (await db.prepare(
      "SELECT id, name FROM characters WHERE book_id=?").bind(bookId).all()).results;
    const charMap = new Map(charRows.map((r) => [r.id, r.name]));
    let chQuery = "SELECT * FROM chapters WHERE book_id=? AND version_id=? AND included=1";
    const binds = [bookId, vid];
    if (body.chapter_id) { chQuery += " AND id=?"; binds.push(body.chapter_id); }
    chQuery += " ORDER BY idx";
    const chapters = (await db.prepare(chQuery).bind(...binds).all()).results;
    if (!chapters.length) return jerr("no chapters to package", 422);
    // C1 guard: scan every included chapter for unsettled dialogue BEFORE
    // writing anything (no render_jobs rows, no chapter state changes on a
    // refusal). Unsettled = contested (confidence < 0.85), no speaker, or a
    // speaker with no voice cast. Without an explicit override the package
    // is refused with the count; with one, unsettled lines fall back to the
    // narrator's voice and are listed in an unsettled manifest. A segment
    // is NEVER emitted with voice: null.
    const override = body.allow_unsettled === true || body.allow_contested === true;
    const narratorRow = await db.prepare(
      "SELECT id FROM characters WHERE book_id=? AND narrator_flag=1").bind(bookId).first();
    const narratorCast = narratorRow ? castMap.get(narratorRow.id) : null;
    const segRowsByChapter = new Map();
    const unsettledByChapter = new Map();
    const unsettledIds = new Set();
    let unsettledCount = 0;
    for (const ch of chapters) {
      const segs = (await db.prepare(
        "SELECT * FROM segments WHERE chapter_id=? ORDER BY paragraph_id, idx").bind(ch.id).all()).results;
      segRowsByChapter.set(ch.id, segs);
      const list = [];
      for (const s of segs) {
        let reason = null;
        if (s.type === "dialogue") {
          if (s.speaker_id === null) reason = "no_speaker";
          else if (s.confidence < CONF_LINE) reason = "contested";
          else if (!castMap.get(s.speaker_id)?.voice_id) reason = "uncast";
        } else if (!castMap.get(s.speaker_id)?.voice_id) {
          reason = "narrator_uncast"; // narration must never emit voice: null either
        }
        if (reason) { list.push({ segment_id: s.id, reason }); unsettledIds.add(s.id); }
      }
      if (list.length) { unsettledByChapter.set(ch.id, list); unsettledCount += list.length; }
    }
    if (unsettledCount > 0 && !override) {
      const perChapter = {};
      for (const [cid, list] of unsettledByChapter) perChapter[cid] = list.length;
      return jres({ error: `${unsettledCount} unsettled dialogue line(s) in the included chapters — settle them, or pass allow_unsettled:true to build with narrator-voice fallbacks listed in an unsettled manifest`,
        unsettled_count: unsettledCount, unsettled_by_chapter: perChapter }, 409);
    }
    if (unsettledCount > 0 && !narratorCast?.voice_id) {
      return jres({ error: "unsettled lines need a narrator voice to fall back to, but the narrator has no voice cast",
        unsettled_count: unsettledCount }, 409);
    }
    const pkgChapters = [];
    for (const ch of chapters) {
      const segs = segRowsByChapter.get(ch.id);
      const outSegs = [];
      for (const s of segs) {
        const spoken = applyRules(s.display_text, rulesFor(rules, s));
        let cast = s.speaker_id ? castMap.get(s.speaker_id) : null;
        let voiceFallback = false;
        if (unsettledIds.has(s.id)) { cast = narratorCast; voiceFallback = true; }
        const tone = cast?.tone || "base";
        const hash = await sha256hex(
          `${spoken}|${cast?.voice_id ?? ""}|${cast?.speed ?? 1}|${cast?.prompt ?? ""}|${tone}|${book.engine_version}`);
        outSegs.push({
          segment_id: s.id, idx: s.idx, paragraph_id: s.paragraph_id, type: s.type,
          speaker: s.speaker_id ? charMap.get(s.speaker_id) : null,
          speaker_id: s.speaker_id, confidence: s.confidence,
          display_text: s.display_text, spoken_text: spoken,
          voice: cast ? { voice_id: cast.voice_id, name: cast.voice_name,
            engine: cast.voice_engine, speed: cast.speed, pace: cast.speed,
            prompt: cast.prompt, tone,
            tone_instruction: TONE_INSTRUCTIONS[tone] || "" } : null,
          voice_fallback: voiceFallback,
          hash,
        });
      }
      const pkgHash = await sha256hex(outSegs.map((s) => s.hash).join(""));
      await db.prepare(
        "INSERT INTO render_jobs (book_id, chapter_id, state, segment_count, package_hash) VALUES (?,?,?,?,?)"
      ).bind(bookId, ch.id, "queued", outSegs.length, pkgHash).run();
      await db.prepare("UPDATE chapters SET render_state='queued' WHERE id=?").bind(ch.id).run();
      pkgChapters.push({ chapter_id: ch.id, idx: ch.idx, title: ch.title,
        package_hash: pkgHash,
        unsettled: unsettledByChapter.get(ch.id) || [],
        segments: outSegs });
    }
    const pkg = {
      kind: "render-job-package", generated_at: new Date().toISOString(),
      book: { id: book.id, title: book.title, author: book.author,
        engine_version: book.engine_version, engine: "CosyVoice 2" },
      note: "Synthesis runs on the external Mac Mini pipeline. spoken_text has pronunciation rules applied; display_text is the locked manuscript text.",
      unsettled_count: unsettledCount,
      ...(unsettledCount > 0 ? { unsettled: [...unsettledByChapter.entries()].map(
        ([cid, list]) => ({ chapter_id: cid, segments: list })) } : {}),
      chapters: pkgChapters,
    };
    return new Response(JSON.stringify(pkg, null, 2), {
      headers: { ...JSON_H, "Content-Disposition": `attachment; filename="render-package-book${bookId}.json"` },
    });
  }

  if (bookId && seg[2] === "export" && method === "GET") {
    const book = await db.prepare("SELECT * FROM books WHERE id=?").bind(bookId).first();
    if (!book) return jerr("book not found", 404);
    const chars = (await db.prepare(
      `SELECT c.id, c.name, c.tier, c.turns, c.words, ca.voice_id, v.name AS voice_name, ca.speed, ca.prompt, ca.tone, ca.confirmed
       FROM characters c LEFT JOIN castings ca ON ca.book_id=c.book_id AND ca.character_id=c.id
       LEFT JOIN voices v ON v.id=ca.voice_id WHERE c.book_id=? ORDER BY c.narrator_flag DESC, c.turns DESC`
    ).bind(bookId).all()).results;
    // Exports follow the same rule as the app: contested lines don't count.
    const statsVid = await currentVersionId(db, bookId);
    const exStats = await characterStats(db, bookId, statsVid);
    for (const c of chars) {
      const st = exStats[c.id];
      if (st) {
        c.census_turns = c.turns; c.census_words = c.words;
        c.turns = st.conf_turns; c.words = st.conf_words;
      }
    }
    const rules = (await db.prepare(
      "SELECT term, respelling, scope, scope_id, active FROM pron_rules WHERE book_id=? ORDER BY term"
    ).bind(bookId).all()).results;
    if (seg[3] === "casting.csv") {
      const csv = ["character,tier,turns,words,voice,speed,prompt,tone,tone_instruction",
        ...chars.map((c) => [c.name, c.tier, c.turns, c.words, c.voice_name || "", c.speed ?? "",
          (c.prompt || "").replace(/,/g, ";"), c.tone || "base",
          (TONE_INSTRUCTIONS[c.tone] || "").replace(/,/g, ";")].join(","))].join("\n");
      return new Response(csv, { headers: { "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="casting-book${bookId}.csv"` } });
    }
    if (seg[3] === "pronunciation.csv") {
      const csv = ["term,respelling,scope,scope_id,active",
        ...rules.map((r) => [r.term, r.respelling, r.scope, r.scope_id ?? "", r.active].join(","))].join("\n");
      return new Response(csv, { headers: { "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="pronunciation-book${bookId}.csv"` } });
    }
    // production.json
    const vid = await currentVersionId(db, bookId);
    const chapters = (await db.prepare(
      "SELECT idx, title, word_count, render_state, approved FROM chapters WHERE book_id=? AND version_id=? ORDER BY idx"
    ).bind(bookId, vid).all()).results;
    return jres({
      kind: "production-package", generated_at: new Date().toISOString(),
      book: { id: book.id, title: book.title, author: book.author, engine_version: book.engine_version },
      credits: {
        narration: "Synthesized voices (CosyVoice 2), cast as listed.",
        ai_disclosure: "This audiobook was produced with AI-generated synthetic voices. No human narrator performed this recording.",
      },
      cast: chars, pronunciation_rules: rules, chapters,
    });
  }

  if (bookId && seg[2] === "replace" && method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || !body.text) return jerr("text is required", 422);
    const book = await db.prepare("SELECT * FROM books WHERE id=?").bind(bookId).first();
    if (!book) return jerr("book not found", 404);
    const oldVid = await currentVersionId(db, bookId);
    const roster = await loadRoster(db, bookId);
    // snapshot old paragraphs + segments + flags
    const oldParas = (await db.prepare(
      "SELECT p.*, ch.idx AS ch_idx FROM paragraphs p JOIN chapters ch ON ch.id=p.chapter_id WHERE p.book_id=? AND p.version_id=? ORDER BY ch.idx, p.idx"
    ).bind(bookId, oldVid).all()).results;
    const oldSegs = (await db.prepare(
      "SELECT * FROM segments WHERE book_id=? AND version_id=? ORDER BY paragraph_id, idx"
    ).bind(bookId, oldVid).all()).results;
    const oldSegsByPara = new Map();
    for (const s of oldSegs) {
      if (!oldSegsByPara.has(s.paragraph_id)) oldSegsByPara.set(s.paragraph_id, []);
      oldSegsByPara.get(s.paragraph_id).push(s);
    }
    const oldFlags = (await db.prepare(
      "SELECT * FROM flags WHERE book_id=? AND segment_id IS NOT NULL").bind(bookId).all()).results;

    // create the new version fresh
    const stats = await createVersionWithText(db, book, body.text,
      body.source_name || "replacement manuscript", roster);
    const newVid = stats.versionId;

    // carry-over (C3): match paragraphs by (text_hash + occurrence ordinal
    // among identical paragraphs) — duplicated one-liners each keep their
    // own history instead of collapsing onto the last copy with that hash.
    const newParas = (await db.prepare(
      "SELECT p.*, ch.idx AS ch_idx FROM paragraphs p JOIN chapters ch ON ch.id=p.chapter_id WHERE p.book_id=? AND p.version_id=? ORDER BY ch.idx, p.idx"
    ).bind(bookId, newVid).all()).results;
    const newSegs = (await db.prepare(
      "SELECT * FROM segments WHERE book_id=? AND version_id=? ORDER BY paragraph_id, idx"
    ).bind(bookId, newVid).all()).results;
    const newSegsByPara = new Map();
    const newSegById = new Map();
    for (const s of newSegs) {
      if (!newSegsByPara.has(s.paragraph_id)) newSegsByPara.set(s.paragraph_id, []);
      newSegsByPara.get(s.paragraph_id).push(s);
      newSegById.set(s.id, s);
    }
    // Grouping is scoped to the chapter: a paragraph that moves chapters
    // is a different context (and its chapters register as touched via
    // the sequence check below) — global ordinals would smear one
    // chapter's settlements into another's identical one-liners.
    const groupByHash = (paras) => {
      const m = new Map();
      for (const p of paras) {
        const key = `${p.ch_idx}|${p.text_hash}`;
        if (!m.has(key)) m.set(key, []);
        m.get(key).push(p);
      }
      return m;
    };
    const oldGroups = groupByHash(oldParas);
    const newGroups = groupByHash(newParas);
    const paraPair = new Map(); // new paragraph id -> old paragraph
    for (const [h, news] of newGroups) {
      const olds = oldGroups.get(h) || [];
      news.forEach((np, k) => { if (olds[k]) paraPair.set(np.id, olds[k]); });
    }
    const newChapters = (await db.prepare(
      "SELECT * FROM chapters WHERE book_id=? AND version_id=?").bind(bookId, newVid).all()).results;
    const oldChapters = (await db.prepare(
      "SELECT * FROM chapters WHERE book_id=? AND version_id=?").bind(bookId, oldVid).all()).results;
    const oldChByIdx = new Map(oldChapters.map((c) => [c.idx, c]));
    const newChByIdx = new Map(newChapters.map((c) => [c.idx, c]));
    let matched = 0, changed = 0;
    const segIdMap = new Map();
    const touchedChapters = new Set(); // NEW chapter ids
    for (const np of newParas) {
      const op = paraPair.get(np.id);
      const nsegs = newSegsByPara.get(np.id) || [];
      if (!op) { changed++; if (nsegs.length) touchedChapters.add(np.chapter_id); continue; }
      matched++;
      const osegs = oldSegsByPara.get(op.id) || [];
      const n = Math.min(osegs.length, nsegs.length);
      for (let i = 0; i < n; i++) {
        segIdMap.set(osegs[i].id, nsegs[i].id);
        const o = osegs[i], w = nsegs[i];
        const settled = o.settled_speaker != null || !!o.settled_at;
        if (settled) {
          // Carry the DECISION wholesale — a human settlement survives even
          // when the new reading pass agrees with it.
          if (o.speaker_id !== w.speaker_id || o.status !== w.status ||
              o.confidence !== w.confidence || (w.settled_speaker ?? null) !== o.settled_speaker) {
            await db.prepare(
              `UPDATE segments SET speaker_id=?, confidence=?, status=?,
                 settled_speaker=?, settled_at=? WHERE id=?`
            ).bind(o.speaker_id, o.confidence, o.status,
              o.settled_speaker, o.settled_at, w.id).run();
          }
        } else if (o.speaker_id !== w.speaker_id || o.status !== w.status) {
          await db.prepare("UPDATE segments SET speaker_id=?, confidence=?, status=? WHERE id=?")
            .bind(o.speaker_id, Math.max(o.confidence, w.confidence), o.status, w.id).run();
        }
      }
      if (osegs.length !== nsegs.length) touchedChapters.add(np.chapter_id);
    }
    // Deleted paragraphs: an old paragraph with no pair means its chapter
    // genuinely changed — mark the same-idx new chapter touched.
    const pairedOld = new Set([...paraPair.values()].map((p) => p.id));
    for (const op of oldParas) {
      if (pairedOld.has(op.id)) continue;
      const nc = newChByIdx.get(op.ch_idx);
      if (nc) touchedChapters.add(nc.id);
    }
    // Chapter-level check: the ordered paragraph-hash sequence must match
    // for a chapter to count as untouched (catches reorders too).
    const seqOf = (paras) => {
      const m = new Map();
      for (const p of paras) {
        if (!m.has(p.ch_idx)) m.set(p.ch_idx, []);
        m.get(p.ch_idx).push(p.text_hash);
      }
      return m;
    };
    const oldSeq = seqOf(oldParas), newSeq = seqOf(newParas);
    for (const [idx, hashes] of newSeq) {
      const oh = oldSeq.get(idx);
      if (!oh || oh.length !== hashes.length || oh.some((h, i) => h !== hashes[i])) {
        const nc = newChByIdx.get(idx);
        if (nc) touchedChapters.add(nc.id);
      }
    }
    // Flags whose segment survived are re-anchored IN PLACE (same flag row,
    // new segment + that segment's new chapter) — never copied, so flag
    // counts can't double across replaces.
    let flagsCarried = 0;
    for (const f of oldFlags) {
      const nid = segIdMap.get(f.segment_id);
      if (!nid) continue;
      const nseg = newSegById.get(nid);
      await db.prepare("UPDATE flags SET segment_id=?, chapter_id=? WHERE id=?")
        .bind(nid, nseg ? nseg.chapter_id : f.chapter_id, f.id).run();
      flagsCarried++;
    }
    // Chapter-scoped pronunciation rules re-anchor to the new version's
    // chapter with the same idx instead of pointing at a dead chapter.
    let rulesReanchored = 0;
    const scopedRules = (await db.prepare(
      "SELECT id, scope_id FROM pron_rules WHERE book_id=? AND scope='chapter' AND scope_id IS NOT NULL"
    ).bind(bookId).all()).results;
    for (const r of scopedRules) {
      const oc = oldChapters.find((c) => c.id === r.scope_id);
      const nc = oc ? newChByIdx.get(oc.idx) : null;
      if (nc && nc.id !== r.scope_id) {
        await db.prepare("UPDATE pron_rules SET scope_id=? WHERE id=?").bind(nc.id, r.id).run();
        rulesReanchored++;
      }
    }
    // Chapter state: untouched chapters keep their render_state AND
    // approval exactly; touched chapters lose approval, and any with
    // render progress go stale (the C2 invariant — never approved+stale).
    for (const nc of newChapters) {
      const oc = oldChByIdx.get(nc.idx);
      if (!oc) continue;
      if (!touchedChapters.has(nc.id)) {
        await db.prepare("UPDATE chapters SET render_state=?, approved=? WHERE id=?")
          .bind(oc.render_state, oc.approved, nc.id).run();
      } else if (["queued", "rendering", "ready"].includes(oc.render_state)) {
        await db.prepare(
          "UPDATE chapters SET render_state='stale', approved=0 WHERE id=?").bind(nc.id).run();
      } else {
        await db.prepare("UPDATE chapters SET approved=0 WHERE id=?").bind(nc.id).run();
      }
    }
    // Atomic flip: only now does the new version become the live one. Any
    // failure above leaves the old version live and this one 'building'.
    await flipVersionLive(db, bookId, newVid);
    return jres({ ok: true, version_no: stats.versionNo, paragraphs_matched: matched,
      paragraphs_changed: changed, flags_carried: flagsCarried,
      rules_reanchored: rulesReanchored,
      chapters_stale: touchedChapters.size, ...stats });
  }

  return jerr("not found", 404);
}

const MAX_BODY_BYTES = 25 * 1024 * 1024; // manuscript uploads are a few MB

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        // Write endpoints speak JSON only, and bodies are size-capped.
        if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
          const ct = req.headers.get("content-type") || "";
          if (!ct.toLowerCase().includes("application/json"))
            return jerr("Content-Type must be application/json", 415);
          const len = parseInt(req.headers.get("content-length") || "0");
          if (len > MAX_BODY_BYTES) return jerr("request body too large", 413);
        }
        return await api(req, env, url);
      } catch (e) {
        console.error("api error:", e && e.message ? e.message : e);
        return jerr("internal error", 500);
      }
    }
    // Static assets (index.html is served at "/" by the assets layer itself;
    // rewriting "/" -> "/index.html" causes a canonicalization redirect loop.)
    return env.ASSETS.fetch(req);
  },
};
