"use strict";
// Audiobook Builder — single-page studio UI.
const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => [...(el || document).querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let BOOKS = [], BOOK = null, BOOKDATA = null, CHARACTERS = [], VOICES = [], RULES = [];
let bookId = parseInt(localStorage.getItem("ab_book") || "1", 10);

function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg; t.style.display = "block";
  clearTimeout(t._h); t._h = setTimeout(() => (t.style.display = "none"), ms);
}
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const ct = res.headers.get("content-type") || "";
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return ct.includes("json") ? res.json() : res;
}
const get = (p) => api(p);
const post = (p, body) => api(p, { method: "POST", body: JSON.stringify(body || {}) });
const put = (p, body) => api(p, { method: "PUT", body: JSON.stringify(body || {}) });
const patch = (p, body) => api(p, { method: "PATCH", body: JSON.stringify(body || {}) });

async function download(url, opts, filename) {
  const res = await fetch(url, opts);
  if (!res.ok) { toast("Download failed"); return; }
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// Render packages refuse (409) while included chapters have unsettled
// dialogue; offer the explicit override, which builds with narrator-voice
// fallbacks and an unsettled manifest in the package.
async function downloadPackage(bid, body, filename) {
  const url = `/api/books/${bid}/render-package`;
  const opts = (b) => ({ method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(b || {}) });
  const res = await fetch(url, opts(body));
  if (res.status === 409) {
    let j = {}; try { j = await res.json(); } catch {}
    const n = j.unsettled_count ?? "?";
    if (!confirm(`${n} dialogue line(s) aren't settled yet (contested, uncast, or no speaker). Build the package anyway? Unsettled lines will use the narrator's voice and be listed in an unsettled manifest inside the package.`)) {
      toast("Package not built — settle the lines first, or build anyway from here.");
      return;
    }
    await download(url, opts({ ...(body || {}), allow_unsettled: true }), filename);
    return;
  }
  if (!res.ok) { toast("Download failed"); return; }
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function loadBook() {
  const list = await get("/api/books");
  BOOKS = list.books;
  if (!BOOKS.length) { BOOK = null; return; }
  if (!BOOKS.some((b) => b.id === bookId)) bookId = BOOKS[0].id;
  localStorage.setItem("ab_book", String(bookId));
  const sel = $("#bookSel");
  sel.innerHTML = BOOKS.map((b) => `<option value="${b.id}">${esc(b.title)}</option>`).join("");
  sel.value = String(bookId);
  BOOKDATA = await get(`/api/books/${bookId}`);
  BOOK = BOOKDATA.book;
  const [chars, voices, rules] = await Promise.all([
    get(`/api/books/${bookId}/characters`), get("/api/voices"), get(`/api/books/${bookId}/rules`)]);
  CHARACTERS = chars.characters; VOICES = voices.voices; RULES = rules.rules;
  renderMilestones();
}
$("#bookSel").addEventListener("change", async (e) => {
  bookId = parseInt(e.target.value, 10);
  await loadBook(); route();
});

function renderMilestones() {
  if (!BOOKDATA) { $("#milestones").innerHTML = ""; return; }
  const c = BOOKDATA.counts;
  const cast = CHARACTERS.filter((x) => x.voice_id).length;
  const total = CHARACTERS.length;
  const approved = BOOKDATA.chapters.filter((x) => x.approved).length;
  const steps = [
    ["Bring in your book", `${BOOKDATA.chapters.length} chapters`],
    ["Check who's talking", c.queue ? `${c.queue} lines to check` : "all lines checked"],
    ["Cast your voices", `${cast} of ${total} cast`],
    ["Hear it and fix it", `${approved} of ${BOOKDATA.chapters.length} chapters approved`],
    ["Make my files", "export when ready"],
  ];
  $("#milestones").innerHTML = steps.map(([a, b], i) =>
    `<span class="ms"><b>${i + 1}. ${a}</b> — ${esc(b)}</span>`).join("");
}

const charName = (id) => {
  const c = CHARACTERS.find((x) => x.id === id);
  return c ? c.name : (id ? `#${id}` : "— not sure —");
};

// ---------------- Voice preview, fine-tune & casting call ----------------
// Previews are REAL renders from the Mini pipeline (CosyVoice 2): each
// character's signature line in their cast voice, plus Deeper/Warmer/Brighter
// instruct variants, plus the same line in every candidate voice (auditions).
// Flow per the casting verdict: the narrator is chosen from an audition (no
// silent default); leads can only be accepted after their pick has been
// heard; everyone else is recommendation-led; the tail confirms by pool.
const PV_TONES = [["base", "As cast"], ["deeper", "Deeper"], ["warmer", "Warmer"], ["brighter", "Brighter"]];
const PV = {}; // character_id -> working {tone, pace} (saved values live on the character)
const pvAudio = new Audio();
let pvPlaying = null; // {file, btn}
let PVQ = []; // play-all queue
const LISTENED_PICK = new Set(); // char ids whose current pick has been heard (>=1.5s)
const LISTENED_AUD = new Set();  // "cid:vid" auditions heard >=10s (or the full line)

function pvState(c) {
  if (!PV[c.id]) PV[c.id] = { tone: c.tone || "base", pace: parseFloat(c.speed ?? 1) || 1 };
  return PV[c.id];
}
function toneLabel(t) { const f = PV_TONES.find(([k]) => k === t); return f ? f[1] : "As cast"; }
function settingsLine(c) {
  const t = c.tone || "base";
  return `${c.voice_name || "no voice cast"}${t !== "base" ? " · " + toneLabel(t) : ""} · pace ${Number(c.speed ?? 1).toFixed(2)}`;
}
function stateChip(c) {
  if (c.confirmed) return `<span class="chip ready">✓ confirmed</span>`;
  if (c.narrator_flag) return `<span class="chip warnchip">not chosen yet</span>`;
  return `<span class="chip">our pick — recommended</span>`;
}
function parsePvFile(file) {
  let m = /^\/previews\/c(\d+)-/.exec(file || "");
  if (m) return { cid: +m[1], vid: null, kind: "preview" };
  m = /^\/auditions\/a(\d+)-v(\d+)\.mp3$/.exec(file || "");
  if (m) return { cid: +m[1], vid: +m[2], kind: "audition" };
  return null;
}
function markHeard(full) {
  const info = pvPlaying && parsePvFile(pvPlaying.file);
  if (!info) return;
  const c = CHARACTERS.find((x) => x.id === info.cid);
  if (info.kind === "preview" || (c && info.vid === c.voice_id)) LISTENED_PICK.add(info.cid);
  if (info.vid && full) LISTENED_AUD.add(info.cid + ":" + info.vid);
  refreshGates();
}
pvAudio.addEventListener("timeupdate", () => {
  const d = pvAudio.duration;
  if (!pvPlaying || !isFinite(d) || !d) return;
  const t = pvAudio.currentTime;
  if (t >= 1.5 || t >= d - 0.25) markHeard(t >= Math.min(10, d - 0.25));
});
pvAudio.addEventListener("ended", () => {
  markHeard(true);
  pvClearMarks();
  if (PVQ.length) { const f = PVQ.shift(); pvPlayFile(f, pvBtnFor(f), 1); }
});
function pvClearMarks() { $$(".pv-play.playing").forEach((b) => b.classList.remove("playing")); }
function pvBtnFor(file) { return document.querySelector(`[data-file="${file}"]`); }
function pvPlayFile(file, btn, pace) {
  pvAudio.src = file;
  pvAudio.playbackRate = pace || 1;
  pvClearMarks(); if (btn) btn.classList.add("playing");
  pvPlaying = { file, btn };
  pvAudio.play().catch(() => { if (btn) btn.classList.remove("playing"); toast("That preview isn't available"); });
}
function pvToggle(file, btn, pace) {
  if (pvPlaying && pvPlaying.file === file && !pvAudio.paused) { pvAudio.pause(); pvClearMarks(); PVQ = []; return; }
  PVQ = [];
  pvPlayFile(file, btn, pace);
}
function refreshGates() {
  $$("[data-choose]").forEach((b) => { b.disabled = !LISTENED_AUD.has(b.dataset.choose); });
  $$("[data-accept]").forEach((b) => {
    const c = CHARACTERS.find((x) => x.id === +b.dataset.accept);
    if (c && c.tier === "lead") b.disabled = !LISTENED_PICK.has(c.id);
  });
}

// The narrator audition: three candidates, order randomized per session.
const NARR_CANDS = [1, 5, 10]; // Warm Baritone (current pick) + two plausible alternates
let narrOrder = null;
function narratorOrder() {
  if (!narrOrder) {
    narrOrder = NARR_CANDS.slice();
    for (let i = narrOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [narrOrder[i], narrOrder[j]] = [narrOrder[j], narrOrder[i]];
    }
  }
  return narrOrder;
}
function narratorChooseHTML(c) {
  const cards = narratorOrder().map((vid) => {
    const v = VOICES.find((x) => x.id === vid) || {};
    return `<div class="audrow">
      <button class="btn small ghost pv-play" data-file="/auditions/a${c.id}-v${vid}.mp3">▶ Hear</button>
      <span class="audname">${esc(v.name || "")}</span>
      <span class="small muted">${esc(v.persona || "")}</span>
      <button class="btn small" data-choose="${c.id}:${vid}" disabled>Choose this narrator</button>
    </div>`;
  }).join("");
  return `<div class="pv-sec"><div class="pv-sec-t">Choose your narrator</div>
    <p class="small">About half your book is read in this voice — there is no default pick here.
    Hear each candidate read the same passage from the opening scene (a Choose button unlocks once
    you've heard that voice out), then choose.</p>${cards}</div>`;
}

function previewPanelHTML(c, full) {
  const st = pvState(c);
  const locked = BOOK.casting_locked;
  if (!c.voice_id) return `<div class="pv"><div class="small muted">No voice cast yet — pick one above.</div></div>`;
  const head = `<div class="pv-setline"><span class="pv-set">${esc(settingsLine(c))}</span>
    <span class="pv-state">${stateChip(c)}</span></div>
    ${c.why_text ? `<div class="small muted">Why this pick: ${esc(c.why_text)}</div>` : ""}
    ${c.shaky ? `<div class="shakynote">⚠ Not sure about this one — have a listen. The alternatives are right below.</div>` : ""}
    ${c.collision ? `<div class="shakynote">⚠ Shares scenes with ${esc(c.collision)} — who currently has the same voice. Open one of them below to give them a different voice.</div>` : ""}
    ${c.disputed_all ? `<div class="shakynote">⚠ All of ${esc(c.name)}'s lines are disputed — none of them count until they're settled in Who's speaking.</div>`
      : c.disputed_only_line ? `<div class="shakynote">⚠ ${esc(c.name)}'s only line is disputed — it doesn't count until it's settled in Who's speaking.</div>` : ""}
    ${c.contested_turns ? `<div class="small muted">${c.contested_turns} disputed line${c.contested_turns === 1 ? "" : "s"} not counted yet — settle them in Who's speaking and they join the tally.</div>` : ""}
    ${c.preview_line ? `<p class="pv-line">“${esc(c.preview_line)}”</p>` : ""}
    ${c.preview_line && c.preview_contested ? `<div style="margin-top:2px"><span class="chip warnchip">Preview from a disputed line</span></div>` : ""}
    ${c.preview_line && !c.narrator_flag && c.preview_segment_id ? `<div style="margin-top:6px"><button class="btn small ghost pv-nothis" type="button">Not theirs?</button><div class="nothis-slot"></div></div>` : ""}`;
  if (c.narrator_flag && !c.confirmed) {
    return `<div class="pv" data-pv="${c.id}">${head}${narratorChooseHTML(c)}</div>`;
  }
  const auds = (c.auditions || []).map((a) => `
    <div class="audrow">
      <button class="btn small ghost pv-play" data-file="/auditions/a${c.id}-v${a.voice_id}.mp3">▶ Hear</button>
      <span class="audname">${esc(a.voice_name || "")}</span>
      ${a.voice_id === c.voice_id ? `<span class="chip ready">currently cast</span>`
        : `<button class="btn small pv-cast" data-voice="${a.voice_id}" ${locked ? "disabled" : ""}>Cast this voice</button>`}
    </div>`).join("");
  const acceptRow = c.confirmed
    ? `<div class="pv-row pv-acceptrow"><span class="chip ready">✓ Using this voice</span></div>`
    : `<div class="pv-row pv-acceptrow"><button class="btn pv-accept" data-accept="${c.id}" ${locked ? "disabled" : ""}>Use this voice</button>
       ${c.tier === "lead" ? `<span class="small muted">For a lead, this unlocks once you've heard the pick.</span>` : ""}</div>`;
  return `<div class="pv" data-pv="${c.id}">${head}
    ${acceptRow}
    ${full ? `<div class="pv-sec"><div class="pv-sec-t">Casting call — the same line in every candidate voice
      ${c.narrator_flag ? `<span class="small muted" style="text-transform:none"> · You can change this later, though that re-records the whole book.</span>` : ""}</div>
      <div class="pv-row"><button class="btn small ghost" data-playall="${c.id}">▶ Play all in a row</button></div>
      ${auds || `<p class="small muted">No auditions rendered for this character.</p>`}</div>` : ""}
    <div class="pv-sec"><div class="pv-sec-t">Hear ${esc(c.name)} — and change it slightly</div>
      <div class="pv-row">
        <button class="btn pv-play pv-main" data-file="/previews/c${c.id}-${st.tone}.mp3">▶ Hear ${esc(c.name)} in this voice</button>
        <span>${PV_TONES.map(([k, label]) => `<button class="tchip${k === st.tone ? " on" : ""}" data-tone="${k}" ${locked ? "disabled" : ""}>${label}</button>`).join("")}</span>
      </div>
      <div class="pv-row small">
        <label>Pace <input type="range" class="pv-pace" min="0.90" max="1.10" step="0.01" value="${st.pace}" ${locked ? "disabled" : ""}>
        <b class="pv-paceval">${st.pace.toFixed(2)}×</b></label>
        <button class="btn small pv-save" ${locked ? "disabled" : ""}>Save voice tweaks</button>
      </div>
      <div class="small muted">Switching Deeper / Warmer / Brighter changes the preview to that render of the line. Pace in the preview is an approximation — the final render applies pace in the engine. Saving marks affected chapters stale for re-recording.</div>
    </div>
  </div>`;
}

function wirePreviewPanels(root, rerender) {
  $$("[data-pv]", root).forEach((panel) => {
    const cid = parseInt(panel.dataset.pv, 10);
    const c = CHARACTERS.find((x) => x.id === cid);
    if (!c) return;
    const st = pvState(c);
    $$(".pv-play", panel).forEach((btn) => btn.addEventListener("click", () => {
      pvToggle(btn.dataset.file, btn, btn.classList.contains("pv-main") ? st.pace : 1);
    }));
    $$("[data-tone]", panel).forEach((chip) => chip.addEventListener("click", () => {
      st.tone = chip.dataset.tone;
      $$("[data-tone]", panel).forEach((x) => x.classList.toggle("on", x === chip));
      const main = $(".pv-main", panel);
      if (main) main.dataset.file = `/previews/c${cid}-${st.tone}.mp3`;
    }));
    const slider = $(".pv-pace", panel);
    if (slider) slider.addEventListener("input", () => {
      st.pace = parseFloat(slider.value);
      $(".pv-paceval", panel).textContent = st.pace.toFixed(2) + "×";
      const main = $(".pv-main", panel);
      if (pvPlaying && main && pvPlaying.file === main.dataset.file) pvAudio.playbackRate = st.pace;
    });
    const saveBtn = $(".pv-save", panel);
    if (saveBtn) saveBtn.addEventListener("click", async () => {
      try {
        await put("/api/castings", { book_id: bookId, character_id: cid,
          voice_id: c.voice_id, speed: st.pace, prompt: c.prompt || "", tone: st.tone });
        c.tone = st.tone; c.speed = st.pace;
        $(".pv-set", panel).textContent = settingsLine(c);
        BOOKDATA = await get(`/api/books/${bookId}`); renderMilestones();
        toast(`${c.name} saved: ${c.voice_name}${st.tone !== "base" ? " · " + toneLabel(st.tone) : ""} · pace ${st.pace.toFixed(2)}`);
      } catch (e) { toast("Save failed: " + e.message); }
    });
    $$(".pv-cast", panel).forEach((btn) => btn.addEventListener("click", async () => {
      try {
        // Casting from an audition: new voice, tone resets to As cast, pace kept.
        await put("/api/castings", { book_id: bookId, character_id: cid,
          voice_id: parseInt(btn.dataset.voice, 10), tone: "base" });
        delete PV[cid]; LISTENED_PICK.delete(cid);
        toast(`${c.name} recast to ${btn.closest(".audrow").querySelector(".audname").textContent} — tone reset to As cast, pace kept`);
        await loadBook(); rerender();
      } catch (e) { toast("Casting failed: " + e.message); }
    }));
    $$("[data-choose]", panel).forEach((btn) => btn.addEventListener("click", async () => {
      try {
        await put("/api/castings", { book_id: bookId, character_id: cid,
          voice_id: parseInt(btn.dataset.choose.split(":")[1], 10), tone: "base", confirmed: 1 });
        delete PV[cid];
        toast("Narrator chosen. You can change this later, though that re-records the whole book.");
        await loadBook(); rerender();
      } catch (e) { toast("Choosing failed: " + e.message); }
    }));
    $$("[data-accept]", panel).forEach((btn) => btn.addEventListener("click", async () => {
      try {
        await put("/api/castings", { book_id: bookId, character_id: cid, confirmed: 1 });
        c.confirmed = 1;
        const chipEl = $(".pv-state", panel); if (chipEl) chipEl.innerHTML = stateChip(c);
        const row = btn.closest(".pv-acceptrow");
        if (row) row.innerHTML = `<span class="chip ready">✓ Using this voice</span>`;
        toast(`${c.name}: voice confirmed`);
      } catch (e) { toast("Accept failed: " + e.message); }
    }));
    const nothis = $(".pv-nothis", panel);
    if (nothis) nothis.addEventListener("click", () => {
      const slot = $(".nothis-slot", panel);
      if (!slot) return;
      if (slot.innerHTML) { slot.innerHTML = ""; return; }
      const top = [...CHARACTERS].filter((x) => !x.narrator_flag && x.id !== cid)
        .sort((a, b) => b.turns - a.turns).slice(0, 3);
      const opts = CHARACTERS.filter((x) => !x.narrator_flag)
        .map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
      slot.innerHTML = `<div class="small" style="margin-top:8px">This line is credited to <b>${esc(c.name)}</b>. Whose line is it really?</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px">
          ${top.map((x) => `<button class="btn small ghost" data-nothis-assign="${x.id}">${esc(x.name)}</button>`).join("")}
          <select class="nothis-sel"><option value="">Someone else…</option>${opts}</select>
          <button class="btn small" data-nothis-set>Set speaker</button>
        </div>
        <div class="small muted" style="margin-top:4px">Setting the speaker confirms the line at full confidence, so it counts for its real speaker. ${esc(c.name)}'s preview gets re-made from a confirmed line of theirs.</div>`;
      const doSet = async (sid) => {
        try {
          await patch(`/api/segments/${c.preview_segment_id}`, { speaker_id: parseInt(sid, 10) });
          toast(`Line given to ${charName(parseInt(sid, 10))} — it counts for them now`);
          await loadBook(); rerender();
        } catch (e) { toast("Failed: " + e.message); }
      };
      $$("[data-nothis-assign]", slot).forEach((b) =>
        b.addEventListener("click", () => doSet(b.dataset.nothisAssign)));
      $("[data-nothis-set]", slot).addEventListener("click", () => {
        const v = $(".nothis-sel", slot).value;
        if (v) doSet(v); else toast("Pick a speaker first");
      });
    });
    $$("[data-playall]", panel).forEach((btn) => btn.addEventListener("click", () => {
      const files = (c.auditions || []).map((a) => `/auditions/a${cid}-v${a.voice_id}.mp3`);
      if (!files.length) return;
      PVQ = files.slice(1);
      pvPlayFile(files[0], pvBtnFor(files[0]), 1);
    }));
  });
  refreshGates();
}

// ---------------- VIEWS ----------------
async function vHome(el) {
  if (!BOOK) { el.innerHTML = `<h1>Drop your manuscript</h1><p>Start with <a href="#newbook">a new book</a>.</p>`; return; }
  const c = BOOKDATA.counts;
  const stale = BOOKDATA.chapters.filter((x) => x.render_state === "stale");
  el.innerHTML = `
    <h1>${esc(BOOK.title)}</h1>
    <p class="muted">${esc(BOOK.author || "")} · Engine pinned: ${esc(BOOK.engine_version)} · Manuscript v${BOOKDATA.versions.length}</p>
    <div class="card kv">
      <div>Chapters<b>${BOOKDATA.chapters.length}</b></div>
      <div>Passages<b>${c.segments}</b></div>
      <div>Characters<b>${c.characters}</b></div>
      <div>Lines to check<b>${c.queue}</b></div>
      <div>Open flags<b>${c.open_flags}</b></div>
      <div>Pronunciation rules<b>${c.rules}</b></div>
    </div>
    ${stale.length ? `<div class="card">⚠️ <b>${stale.length} chapter(s) are stale</b> — casting or pronunciation changed since they were packaged: ${stale.map((x) => esc(x.title)).join(", ")}. <a href="#recording">Re-package them</a>.</div>` : ""}
    <div class="card"><h2>Your next step</h2>
      ${c.queue ? `<p>Check ${c.queue} lines we weren't sure about — who's speaking?</p><a class="btn" href="#speakers">Check who's talking</a>`
        : `<p>Every line has a speaker. Head to Listen &amp; fix to proof a chapter.</p><a class="btn" href="#listen">Listen &amp; fix</a>`}
    </div>
    <div class="card"><h2>First, hear it</h2>
      <p>Ninety seconds of your book, read by the winning engine (CosyVoice 2) from the shootout.</p>
      <a class="btn ghost" href="#sample">Hear a sample</a></div>`;
}

async function vBook(el) {
  const rows = BOOKDATA.chapters.map((ch) => `
    <tr>
      <td>${ch.idx}</td>
      <td><input value="${esc(ch.title)}" data-ch="${ch.id}" class="chtitle" size="26"></td>
      <td>${ch.word_count.toLocaleString()}</td>
      <td><input type="checkbox" data-ch="${ch.id}" class="chincl" ${ch.included ? "checked" : ""}></td>
      <td><span class="chip ${ch.render_state}">${esc(ch.render_state.replace("_", " "))}</span></td>
      <td>${ch.approved ? "✅ approved" : `<button class="btn small ghost" data-appr="${ch.id}">Approve</button>`}</td>
    </tr>`).join("");
  el.innerHTML = `<h1>Here's your book</h1>
    <p class="muted">Untick a chapter to leave it out of render packages (front/back matter). Rename freely — the text itself never changes here.</p>
    <div class="card"><table><tr><th>#</th><th>Chapter</th><th>Words</th><th>Include</th><th>Recording</th><th>Proof</th></tr>${rows}</table></div>`;
  $$(".chtitle", el).forEach((inp) => inp.addEventListener("change", async () => {
    await patch(`/api/chapters/${inp.dataset.ch}`, { title: inp.value }); toast("Renamed");
  }));
  $$(".chincl", el).forEach((inp) => inp.addEventListener("change", async () => {
    await patch(`/api/chapters/${inp.dataset.ch}`, { included: inp.checked }); toast("Saved");
  }));
  $$("[data-appr]", el).forEach((b) => b.addEventListener("click", async () => {
    await patch(`/api/chapters/${b.dataset.appr}`, { approved: true });
    BOOKDATA = await get(`/api/books/${bookId}`); renderMilestones(); vBook(el);
  }));
}

async function vSample(el) {
  el.innerHTML = `<h1>Hear a sample</h1>
    <p class="muted">The shootout passage from Chapter 1, read by CosyVoice 2 — the engine you picked on Oct 21.</p>
    <div class="card"><audio controls src="/sample.mp3"></audio><div id="passage">Loading passage…</div></div>`;
  try {
    const p = await (await fetch("/sample-passage.json")).json();
    $("#passage", el).innerHTML = p.map((s) => `
      <div class="seg ${s.speaker !== "NARRATOR" ? "dialogue" : ""}">
        <span class="spk">${esc(s.speaker)}</span><div class="txt">${esc(s.text)}</div></div>`).join("");
  } catch { $("#passage", el).textContent = "Passage unavailable."; }
}

function queueItem(q) {
  const top = [...CHARACTERS].filter((c) => !c.narrator_flag)
    .sort((a, b) => b.turns - a.turns).slice(0, 3);
  const opts = CHARACTERS.map((c) => `<option value="${c.id}" ${c.id === q.speaker_id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  return `<div class="card" data-q="${q.id}">
    <div class="small muted">Chapter ${q.ch_idx} · ${esc(q.ch_title)} ${q.speaker_id ? `· currently: ${esc(charName(q.speaker_id))} (not sure)` : "· no speaker yet"}</div>
    ${q.context_before ? `<p class="muted small">…${esc(q.context_before.slice(-220))}</p>` : ""}
    <p style="font-size:17px">“${esc(q.display_text)}”</p>
    ${q.context_after ? `<p class="muted small">${esc(q.context_after.slice(0, 220))}…</p>` : ""}
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      ${top.map((c) => `<button class="btn small ghost" data-assign="${c.id}">${esc(c.name)}</button>`).join("")}
      <select class="qsel"><option value="">Someone else…</option>${opts}</select>
      <button class="btn small" data-set>Set speaker</button>
    </div></div>`;
}

function disputeItem(d) {
  const impact = d.impact === "all"
    ? `<div class="shakynote">⚠ All of ${esc(d.speaker_name)}'s lines are disputed — nothing counts for them until these are settled.</div>`
    : d.impact === "only"
    ? `<div class="shakynote">⚠ This is ${esc(d.speaker_name)}'s only line — it doesn't count until it's settled.</div>`
    : d.impact === "preview"
    ? `<div class="shakynote">⚠ This is ${esc(d.speaker_name)}'s preview line — their card is badged until it's settled.</div>` : "";
  const opts = CHARACTERS.map((c) => `<option value="${c.id}" ${c.id === d.speaker_id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  return `<div class="card" data-d="${d.id}">
    <div class="small muted">Chapter ${d.chapter_idx} · ${esc(d.chapter_title)} · ${d.speaker_id ? `the reading pass says <b>${esc(d.speaker_name)}</b> (${Math.round(d.confidence * 100)}% sure)` : "no speaker yet — the reading pass couldn't attribute this line"}</div>
    ${impact}
    ${d.context_before ? `<p class="muted small">…${esc(d.context_before.slice(-170))}</p>` : ""}
    <p style="font-size:17px">“${esc(d.text)}”</p>
    ${d.context_after ? `<p class="muted small">${esc(d.context_after.slice(0, 170))}…</p>` : ""}
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      ${d.speaker_id ? `<button class="btn small" data-dsettle="${d.speaker_id}">Reading pass: ${esc(d.speaker_name)}</button>` : ""}
      ${d.candidates.map((cd) => `<button class="btn small ghost" data-dsettle="${cd.id}">${esc(cd.label)}: ${esc(cd.name)}</button>`).join("")}
      <select class="qsel"><option value="">Someone else…</option>${opts}</select>
      <button class="btn small ghost" data-dset>Set</button>
    </div></div>`;
}

async function vSpeakers(el) {
  const [q, coll, dsp] = await Promise.all([
    get(`/api/books/${bookId}/queue`), get(`/api/books/${bookId}/collisions`).catch(() => ({ collisions: [] })),
    get(`/api/books/${bookId}/disputes?limit=60`).catch(() => ({ disputes: [], total: 0, contested_total: 0, next_cursor: null }))]);
  const cards = CHARACTERS.map((c) => `
    <div class="card">
      <b>${esc(c.name)}</b> <span class="chip ${c.narrator_flag ? "narrator" : c.tier}">${c.narrator_flag ? "narrator" : esc(c.tier)}</span>
      <div class="small muted">${c.turns} lines · ${c.words.toLocaleString()} words spoken</div>
      ${c.aliases && c.aliases.length ? `<div class="small">Also: ${c.aliases.map(esc).join(", ")}</div>` : ""}
      ${c.role_note ? `<div class="small muted">${esc(c.role_note)}</div>` : ""}
      ${previewPanelHTML(c, false)}
    </div>`).join("");
  el.innerHTML = `<h1>Who's speaking?</h1>
    <p class="muted">${CHARACTERS.length} voices in this book, narrator first — the narrator carries over half the book. Line and word counts cover confirmed lines only; disputed lines join the tally once you settle them.</p>
    <h2 id="dispH">Disputed lines (${dsp.total})</h2>
    <p class="muted">${dsp.contested_total} lines in the book are contested — the reading pass attributed them at under 85% confidence, or not at all — so they don't count toward anyone's lines or words yet. The ${dsp.total} below have a second candidate or a whole character riding on them; the rest are in Needs a look. Every contested line is in exactly one of the two lists, and one tap settles it at full confidence.<span id="dispSettled"></span></p>
    <div id="dlist">${dsp.disputes.map(disputeItem).join("") || `<div class="card">🎉 No disputed lines right now — any remaining contested lines are in Needs a look below.</div>`}</div>
    ${dsp.next_cursor ? `<p><button class="btn ghost" id="dmore">Show more disputed lines</button> <span class="small muted" id="dmoreN">${dsp.total - dsp.disputes.length} more</span></p>` : ""}
    <h2>Needs a look (${q.total ?? q.queue.length})</h2>
    <p class="muted">Contested lines without a second candidate. One tap sets the speaker; "Looks right" is just picking the current name.</p>
    <div id="qlist">${q.queue.map(queueItem).join("") || `<div class="card">🎉 All clear — every line has a speaker we're confident about.</div>`}</div>
    ${q.next_cursor ? `<p><button class="btn ghost" id="qmore">Show more lines</button> <span class="small muted" id="qmoreN">${(q.total ?? 0) - q.queue.length} more</span></p>` : ""}
    <h2>Everyone in the book</h2><div class="grid wide">${cards}</div>`;
  wirePreviewPanels(el, () => vSpeakers(el));
  const wireQueue = (card) => {
    card.dataset.wired = "1";
    const id = card.dataset.q;
    const assign = async (speakerId) => {
      await patch(`/api/segments/${id}`, { speaker_id: parseInt(speakerId, 10) });
      card.remove(); toast("Speaker set");
      BOOKDATA = await get(`/api/books/${bookId}`); renderMilestones();
    };
    $$("[data-assign]", card).forEach((b) => b.addEventListener("click", () => assign(b.dataset.assign)));
    $("[data-set]", card).addEventListener("click", () => {
      const v = $(".qsel", card).value;
      if (v) assign(v); else toast("Pick a speaker first");
    });
  };
  $$("#qlist .card", el).forEach(wireQueue);
  // Keyset pagination: the cursor names the last line served, so settling
  // lines (which removes cards) can never skip one.
  let qCursor = q.next_cursor, qShown = q.queue.length;
  const qmore = $("#qmore", el);
  if (qmore) qmore.addEventListener("click", async () => {
    const page = await get(`/api/books/${bookId}/queue?limit=100&cursor=${encodeURIComponent(qCursor)}`);
    $("#qlist", el).insertAdjacentHTML("beforeend", page.queue.map(queueItem).join(""));
    $$("#qlist .card", el).forEach((card) => { if (!card.dataset.wired) wireQueue(card); });
    qShown += page.queue.length; qCursor = page.next_cursor;
    const left = (q.total ?? 0) - qShown;
    if (qCursor && left > 0) { $("#qmoreN", el).textContent = `${left} more`; }
    else { qmore.remove(); const n = $("#qmoreN", el); if (n) n.remove(); }
  });
  // Disputed lines: one tap settles at full confidence (the PATCH convention).
  let dSettled = 0, dShown = dsp.disputes.length;
  const dRemaining = () => dsp.total - dSettled;
  const wireDispute = (card) => {
    card.dataset.wired = "1";
    const id = card.dataset.d;
    const settle = async (speakerId) => {
      await patch(`/api/segments/${id}`, { speaker_id: parseInt(speakerId, 10) });
      card.remove(); dSettled++;
      $("#dispH", el).textContent = `Disputed lines (${dRemaining()})`;
      $("#dispSettled", el).textContent = ` ${dSettled} settled just now.`;
      toast(`Settled — that line counts for ${charName(parseInt(speakerId, 10))} now`);
      BOOKDATA = await get(`/api/books/${bookId}`); renderMilestones();
    };
    $$("[data-dsettle]", card).forEach((b) => b.addEventListener("click", () => settle(b.dataset.dsettle)));
    const setBtn = $("[data-dset]", card);
    if (setBtn) setBtn.addEventListener("click", () => {
      const v = $(".qsel", card).value;
      if (v) settle(v); else toast("Pick a speaker first");
    });
  };
  $$("#dlist .card", el).forEach(wireDispute);
  let dCursor = dsp.next_cursor;
  const dmore = $("#dmore", el);
  if (dmore) dmore.addEventListener("click", async () => {
    const page = await get(`/api/books/${bookId}/disputes?limit=60&cursor=${encodeURIComponent(dCursor)}`);
    $("#dlist", el).insertAdjacentHTML("beforeend", page.disputes.map(disputeItem).join(""));
    $$("#dlist .card", el).forEach((card) => { if (!card.dataset.wired) { card.dataset.wired = "1"; wireDispute(card); } });
    dShown += page.disputes.length;
    dCursor = page.next_cursor;
    const left = dsp.total - dShown;
    if (dCursor && left > 0) { $("#dmoreN", el).textContent = `${left} more`; }
    else { dmore.remove(); const n = $("#dmoreN", el); if (n) n.remove(); }
  });
}

async function vCast(el) {
  const coll = await get(`/api/books/${bookId}/collisions`).catch(() => ({ collisions: [] }));
  const vopts = (sel) => `<option value="">— pick a voice —</option>` + VOICES.map((v) =>
    `<option value="${v.id}" ${v.id === sel ? "selected" : ""}>${esc(v.name)} — ${esc(v.description)}</option>`).join("");
  const row = (c) => `
    <tr data-char="${c.id}">
      <td><b>${esc(c.name)}</b><br><span class="chip ${c.narrator_flag ? "narrator" : c.tier}">${c.narrator_flag ? "narrator" : esc(c.tier)}</span>
        <span class="small muted">${c.turns} lines</span></td>
      <td><select class="cv" ${BOOK.casting_locked ? "disabled" : ""}>${vopts(c.voice_id)}</select></td>
      <td><input class="cs" type="number" step="0.05" min="0.5" max="2" value="${c.speed ?? 1}" style="width:70px" ${BOOK.casting_locked ? "disabled" : ""}></td>
      <td><input class="cp" value="${esc(c.prompt || "")}" placeholder="e.g. calm, wry" size="18" ${BOOK.casting_locked ? "disabled" : ""}></td>
    </tr>`;
  const ordered = [...CHARACTERS].sort((a, b) =>
    (b.narrator_flag - a.narrator_flag) || (b.turns - a.turns));
  const panelCard = (c) => `<div class="card"><h3 style="margin:0 0 4px">${esc(c.name)}</h3>${previewPanelHTML(c, true)}</div>`;
  const mainCast = ordered.filter((c) => !c.narrator_flag && (c.tier === "lead" || c.tier === "supporting"));
  const tail = ordered.filter((c) => c.tier === "minor" || c.tier === "cameo");
  const pools = new Map();
  tail.forEach((c) => { if (!pools.has(c.voice_id)) pools.set(c.voice_id, []); pools.get(c.voice_id).push(c); });
  const poolCards = [...pools.entries()].sort((a, b) =>
    b[1].reduce((s, c) => s + c.turns, 0) - a[1].reduce((s, c) => s + c.turns, 0)).map(([vid, members]) => {
    const conf = members.filter((m) => m.confirmed).length;
    return `<div class="card poolcard">
      <div class="pv-row"><b>Pool — ${esc(members[0].voice_name || "")}</b>
        <span class="muted small">${members.length} character${members.length === 1 ? "" : "s"} share this voice</span>
        <button class="btn small ghost pool-play" data-file="/previews/c${members[0].id}-base.mp3">▶ Hear this voice</button>
        <span class="chip ${conf === members.length ? "ready" : ""}">${conf}/${members.length} confirmed</span>
        <button class="btn small pool-accept" data-pool="${vid}" ${BOOK.casting_locked || conf === members.length ? "disabled" : ""}>Looks good — accept all ${members.length}</button></div>
      <div class="small">${members.map((m) => `${esc(m.name)} <span class="muted">(${m.turns} lines)</span>${m.collision ? " ⚠" : ""}`).join(" · ")}</div>
      <details style="margin-top:8px"><summary class="small">Open individual characters — change or promote one</summary>
      ${members.map((m) => `<div style="margin-top:10px"><h4 style="margin:0 0 2px">${esc(m.name)}</h4>${previewPanelHTML(m, true)}</div>`).join("")}
      </details></div>`;
  }).join("");
  el.innerHTML = `<h1>Cast your voices</h1>
    <p class="muted">Narrator first — over half the runtime is one voice. Our picks are pre-filled; change any voice and it's saved. Cameos share the utility voices on purpose.</p>
    ${BOOK.casting_locked
      ? `<div class="card">🔒 Casting is locked. <button class="btn small" id="unlock">Unlock casting</button></div>`
      : `<div class="card"><button class="btn" id="acceptall">Accept all suggestions</button>
         <button class="btn ghost" id="lock">Lock casting</button>
         <span class="small muted">Locking freezes the cast so chapters can be packaged against it.</span></div>`}
    ${coll.collisions.length ? `<div class="card">⚠️ <b>Same voice, several characters:</b><br>${coll.collisions.map((x) => `${esc(x.voice_name)}: ${esc(x.names)}`).join("<br>")}<br><span class="small muted">Fine for cameos; risky for characters who share scenes.</span></div>` : ""}
    <div class="card"><table><tr><th>Character</th><th>Voice</th><th>Speed</th><th>Direction</th></tr>
    ${ordered.map(row).join("")}</table></div>
    <h2>The narrator</h2>
    ${ordered.filter((c) => c.narrator_flag).map(panelCard).join("")}
    <h2>Casting call &amp; fine-tuning — leads &amp; supporting</h2>
    <p class="muted">Hear each character's signature line in every candidate voice and cast straight from the audition — or keep the voice and change it slightly: Deeper, Warmer, Brighter, a touch of pace. A lead can't be accepted until you've heard the pick; casting from an audition resets the tone to “As cast” and keeps your pace.</p>
    ${mainCast.map(panelCard).join("")}
    <h2>Everyone else — voice pools</h2>
    <p class="muted">Minor characters and cameos share pool voices, grouped so people who share scenes don't sound alike — where the current picks break that rule, the character is flagged ⚠ and their card says who they clash with. One “Looks good” accepts a whole pool; open any individual to change or promote them.</p>
    ${poolCards}
    <h2>Voice bank</h2>
    <div class="grid">${VOICES.map((v) => `<div class="card"><b>${esc(v.name)}</b>
      <div class="small">${esc(v.description)}</div>
      <div class="small muted">${esc(v.engine)} · ${esc(v.kind)}<br>${esc(v.provenance)}</div></div>`).join("")}</div>`;
  const save = async (tr) => {
    const id = tr.dataset.char;
    await put("/api/castings", { book_id: bookId, character_id: parseInt(id, 10),
      voice_id: $(".cv", tr).value ? parseInt($(".cv", tr).value, 10) : null,
      speed: parseFloat($(".cs", tr).value || "1"), prompt: $(".cp", tr).value });
    toast("Casting saved");
  };
  $$("tr[data-char]", el).forEach((tr) => {
    $$("select, input", tr).forEach((inp) => inp.addEventListener("change", () => save(tr)));
  });
  wirePreviewPanels(el, () => vCast(el));
  $$(".pool-play", el).forEach((btn) => btn.addEventListener("click", () => pvToggle(btn.dataset.file, btn, 1)));
  $$(".pool-accept", el).forEach((btn) => btn.addEventListener("click", async () => {
    const members = CHARACTERS.filter((c) => (c.tier === "minor" || c.tier === "cameo")
      && c.voice_id === parseInt(btn.dataset.pool, 10));
    const ids = members.filter((m) => !m.confirmed).map((m) => m.id);
    if (!ids.length) return;
    try {
      const r = await post("/api/castings/confirm", { book_id: bookId, character_ids: ids });
      members.forEach((m) => { m.confirmed = 1; });
      toast(`Pool accepted — ${r.confirmed} casting${r.confirmed === 1 ? "" : "s"} confirmed`);
      vCast(el);
    } catch (e) { toast("Pool accept failed: " + e.message); }
  }));
  const aa = $("#acceptall", el);
  if (aa) aa.addEventListener("click", async () => {
    await post(`/api/books/${bookId}/cast/accept-all`); toast("Suggestions applied");
    await loadBook(); vCast(el);
  });
  const lock = $("#lock", el);
  if (lock) lock.addEventListener("click", async () => {
    await post(`/api/books/${bookId}/cast/lock`, { locked: true }); await loadBook(); vCast(el);
  });
  const unlock = $("#unlock", el);
  if (unlock) unlock.addEventListener("click", async () => {
    await post(`/api/books/${bookId}/cast/lock`, { locked: false }); await loadBook(); vCast(el);
  });
}

async function vTricky(el) {
  const t = await get(`/api/books/${bookId}/tricky`);
  el.innerHTML = `<h1>Check the tricky words</h1>
    <p class="muted">Words the engine is likeliest to trip on — invented names, acronyms, unusual capitals — ranked by how often they appear. Type how each should sound (capitals = stress) and save. Skipping is fine; most fixes happen later, in context, in Listen &amp; fix.</p>
    <div class="card"><table><tr><th>Word</th><th>Appears</th><th>Sounds like</th><th></th></tr>
    ${t.words.map((w) => `<tr data-word="${esc(w.word)}">
      <td><b>${esc(w.word)}</b></td><td>${w.count}×</td>
      <td><input class="tr" placeholder="e.g. ah-tah-KAH-mah" size="24"></td>
      <td><button class="btn small" data-add>Add rule</button></td></tr>`).join("") || `<tr><td colspan="4">Nothing flagged right now.</td></tr>`}
    </table></div>`;
  $$("[data-add]", el).forEach((b) => b.addEventListener("click", async () => {
    const tr = b.closest("tr");
    const resp = $(".tr", tr).value.trim();
    if (!resp) { toast("Type how it should sound first"); return; }
    await post(`/api/books/${bookId}/rules`, { term: tr.dataset.word, respelling: resp, scope: "global" });
    toast(`Rule saved: ${tr.dataset.word} → ${resp}`);
    tr.remove();
    RULES = (await get(`/api/books/${bookId}/rules`)).rules;
  }));
}

async function vPron(el) {
  const charOpts = CHARACTERS.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  const chOpts = BOOKDATA.chapters.map((c) => `<option value="${c.id}">Ch ${c.idx} · ${esc(c.title)}</option>`).join("");
  el.innerHTML = `<h1>Pronunciation Book</h1>
    <p class="muted">Every rule you've set, in one place. Rules change only the spoken layer — the manuscript text on the page never changes. Revert undoes a rule without deleting its history.</p>
    <div class="card"><h2>Add a rule</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="p-term" placeholder="Word (e.g. AETHER)">
        <input id="p-resp" placeholder="Sounds like (e.g. AY-ther)">
        <select id="p-scope"><option value="global">Everywhere in the book</option>
          <option value="character">Only when a character says it</option>
          <option value="chapter">Only in one chapter</option></select>
        <select id="p-scopeid" style="display:none"></select>
        <button class="btn" id="p-add">Save rule</button>
      </div></div>
    <div class="card"><table><tr><th>Word</th><th>Sounds like</th><th>Applies</th><th>Status</th><th></th></tr>
    ${RULES.map((r) => `<tr data-rule="${r.id}">
      <td><b>${esc(r.term)}</b></td>
      <td><input class="rr" value="${esc(r.respelling)}" size="20"></td>
      <td>${r.scope === "global" ? "everywhere" : r.scope === "character" ? `when ${esc(charName(r.scope_id))} says it` : `in chapter ${esc((BOOKDATA.chapters.find((c) => c.id === r.scope_id) || {}).title || "")}`}</td>
      <td>${r.active ? "active" : "<i>reverted</i>"}</td>
      <td><button class="btn small ghost" data-save>Save</button>
          <button class="btn small ghost" data-revert>${r.active ? "Revert" : "Reactivate"}</button></td></tr>`).join("") || `<tr><td colspan="5" class="muted">No rules yet. As you listen, tap any word that sounds wrong — your fixes collect here.</td></tr>`}
    </table></div>`;
  const scopeSel = $("#p-scope", el), scopeId = $("#p-scopeid", el);
  scopeSel.addEventListener("change", () => {
    if (scopeSel.value === "global") { scopeId.style.display = "none"; return; }
    scopeId.style.display = "";
    scopeId.innerHTML = scopeSel.value === "character" ? charOpts : chOpts;
  });
  $("#p-add", el).addEventListener("click", async () => {
    const term = $("#p-term", el).value.trim(), resp = $("#p-resp", el).value.trim();
    if (!term || !resp) { toast("Word and respelling both needed"); return; }
    await post(`/api/books/${bookId}/rules`, { term, respelling: resp,
      scope: scopeSel.value, scope_id: scopeSel.value === "global" ? null : parseInt(scopeId.value, 10) });
    toast("Rule saved");
    RULES = (await get(`/api/books/${bookId}/rules`)).rules; vPron(el);
  });
  $$("[data-rule]", el).forEach((tr) => {
    $("[data-save]", tr).addEventListener("click", async () => {
      await patch(`/api/rules/${tr.dataset.rule}`, { respelling: $(".rr", tr).value });
      toast("Rule updated");
    });
    $("[data-revert]", tr).addEventListener("click", async () => {
      const r = RULES.find((x) => x.id === parseInt(tr.dataset.rule, 10));
      await patch(`/api/rules/${tr.dataset.rule}`, { active: !r.active });
      RULES = (await get(`/api/books/${bookId}/rules`)).rules; vPron(el);
    });
  });
}
"use strict";
// ---- Listen & fix ----
const HOMOGRAPHS = new Set(["read", "lead", "wound", "live", "tear", "bass", "bow", "close", "minute", "object", "present", "record", "wind", "desert", "invalid", "refuse", "subject", "contract"]);
let listenChapter = null;

function suggestionsFor(word) {
  const w = word.replace(/[^A-Za-z'-]/g, "");
  const low = w.toLowerCase();
  const cap = low.charAt(0).toUpperCase() + low.slice(1);
  return [low, cap, low.split("").join("-")].filter((v, i, a) => a.indexOf(v) === i).slice(0, 3);
}

async function vListen(el) {
  const chs = BOOKDATA.chapters;
  if (!listenChapter || !chs.some((c) => c.id === listenChapter)) listenChapter = chs[0].id;
  const ch = chs.find((c) => c.id === listenChapter);
  const [segData, flagData] = await Promise.all([
    get(`/api/books/${bookId}/segments?chapter_id=${listenChapter}`),
    get(`/api/books/${bookId}/flags`)]);
  const openFlags = flagData.flags.filter((f) => f.status === "open");
  const segs = segData.segments;
  const ruledTerms = new Set(RULES.filter((r) => r.active).map((r) => r.term.toLowerCase()));
  const renderSeg = (s) => {
    const words = s.display_text.split(/(\s+)/).map((tok) => {
      if (/^\s+$/.test(tok) || !tok) return tok;
      const clean = tok.replace(/[^A-Za-z'-]/g, "").toLowerCase().replace(/'s$/, "");
      const ruled = ruledTerms.has(clean) ? " ruled" : "";
      return `<span class="w${ruled}" data-w="${esc(tok)}">${esc(tok)}</span>`;
    }).join("");
    return `<div class="seg ${s.type}" data-seg="${s.id}">
      <span class="spk" data-spk title="Tap to change who's speaking">${esc(s.speaker_name || (s.type === "dialogue" ? "— not sure —" : "Narrator"))}</span>
      ${s.confidence < 0.6 && s.type === "dialogue" ? `<span class="flagpin"> · we're not sure who's speaking</span>` : ""}
      <div class="txt">${words}</div>
      <div class="acts">
        <button data-flag="pronunciation">Sounds wrong</button>
        <button data-flag="wrong_voice">Wrong voice</button>
        <button data-flag="glitch">Glitch</button>
        <button data-flag="pacing">Pacing</button>
        <button data-flag="note">Note</button>
      </div>
      <div class="slot"></div>
    </div>`;
  };
  el.innerHTML = `<h1>Listen and fix</h1>
    <p class="muted">Tap any word to fix how it sounds. Tap a speaker name to change who's speaking. Flags pin problems to fix later — listening never has to stop.</p>
    <div class="card">
      <label>Chapter <select id="lch">${chs.map((c) => `<option value="${c.id}" ${c.id === listenChapter ? "selected" : ""}>${c.idx}. ${esc(c.title)}</option>`).join("")}</select></label>
      <span class="chip ${ch.render_state}">${esc(ch.render_state.replace("_", " "))}</span>
      ${ch.approved ? "<span class='chip ready'>approved</span>" : `<button class="btn small" id="appr">Approve this chapter</button>`}
      <span class="small muted">${segs.length} passages · ${openFlags.filter((f) => f.chapter_id === ch.id).length} open flags here</span>
    </div>
    <div id="reader">${segs.map(renderSeg).join("")}</div>
    <h2>Fix list (${openFlags.length} open)</h2>
    ${openFlags.map((f) => `<div class="card" data-flagrow="${f.id}">
      <span class="flagpin">${esc(f.type.replace("_", " "))}</span>
      <span class="small muted">Ch ${f.ch_idx ?? ""}</span>
      <div>${esc(f.segment_text || f.note || "")}</div>
      ${f.note && f.segment_text ? `<div class="small">${esc(f.note)}</div>` : ""}
      <button class="btn small ghost" data-resolve>Mark resolved</button></div>`).join("") || `<div class="card">🎉 All clear.</div>`}`;
  $("#lch", el).addEventListener("change", (e) => { listenChapter = parseInt(e.target.value, 10); vListen(el); });
  const appr = $("#appr", el);
  if (appr) appr.addEventListener("click", async () => {
    await patch(`/api/chapters/${listenChapter}`, { approved: true });
    BOOKDATA = await get(`/api/books/${bookId}`); renderMilestones(); vListen(el);
  });
  $$("[data-resolve]", el).forEach((b) => b.addEventListener("click", async () => {
    const row = b.closest("[data-flagrow]");
    await patch(`/api/flags/${row.dataset.flagrow}`, { status: "resolved" });
    row.remove(); toast("Flag resolved");
  }));

  const openPronPanel = async (segEl, seg, wordTok) => {
    const slot = $(".slot", segEl);
    const word = wordTok.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
    if (!word) return;
    const occ = await get(`/api/books/${bookId}/occurrences?term=${encodeURIComponent(word)}`);
    const isHomo = HOMOGRAPHS.has(word.toLowerCase());
    const defScope = isHomo ? "chapter" : "global";
    slot.innerHTML = `<div class="panel"><h3>How should “${esc(word)}” sound?</h3>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0">
        ${suggestionsFor(word).map((s) => `<button class="chip" data-sug="${esc(s)}">${esc(s)}</button>`).join("")}
      </div>
      <input class="pr-resp" placeholder="Type it the way it sounds — capitals = stress" size="34">
      <div style="margin:8px 0">
        <label>Applies: <select class="pr-scope">
          <option value="global" ${defScope === "global" ? "selected" : ""}>Everywhere in the book (${occ.count})</option>
          <option value="chapter" ${defScope === "chapter" ? "selected" : ""}>Just this chapter</option>
          <option value="character">Only when ${esc(seg.speaker_name || "this speaker")} says it</option>
        </select></label>
        <span class="small muted">${isHomo ? "This word is read differently in different places, so the default is just this chapter." : `Found in ${occ.chapters.length} chapter(s).`}</span>
      </div>
      <div class="small">Before: “…${esc(seg.display_text)}”<br>After: <b class="pr-after">type a respelling to preview</b></div>
      <div style="margin-top:8px"><button class="btn small" data-fix>Fix it</button>
      <button class="btn small ghost" data-close>Cancel</button></div></div>`;
    const respInp = $(".pr-resp", slot);
    $$("[data-sug]", slot).forEach((b) => b.addEventListener("click", () => {
      respInp.value = b.dataset.sug; respInp.dispatchEvent(new Event("input"));
    }));
    respInp.addEventListener("input", () => {
      const r = respInp.value.trim();
      $(".pr-after", slot).textContent = r
        ? seg.display_text.replace(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), r)
        : "type a respelling to preview";
    });
    $("[data-close]", slot).addEventListener("click", () => (slot.innerHTML = ""));
    $("[data-fix]", slot).addEventListener("click", async () => {
      const r = respInp.value.trim();
      if (!r) { toast("Type how it should sound first"); return; }
      const scope = $(".pr-scope", slot).value;
      const scope_id = scope === "global" ? null : scope === "chapter" ? seg.chapter_id : seg.speaker_id;
      await post(`/api/books/${bookId}/rules`, { term: word, respelling: r, scope, scope_id });
      toast(`${word} → ${r}. ${scope === "global" ? `Applies to ${occ.count} places.` : "Rule saved."} Affected chapters are marked for re-recording.`);
      slot.innerHTML = "";
      RULES = (await get(`/api/books/${bookId}/rules`)).rules;
      BOOKDATA = await get(`/api/books/${bookId}`); renderMilestones(); vListen(el);
    });
  };

  const openSpeakerPanel = (segEl, seg) => {
    const slot = $(".slot", segEl);
    const opts = CHARACTERS.map((c) => `<option value="${c.id}" ${c.id === seg.speaker_id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
    slot.innerHTML = `<div class="panel"><h3>Who's speaking?</h3>
      <select class="sp-sel">${opts}</select>
      <button class="btn small" data-setspk>Set speaker</button>
      <button class="btn small ghost" data-close>Cancel</button></div>`;
    $("[data-close]", slot).addEventListener("click", () => (slot.innerHTML = ""));
    $("[data-setspk]", slot).addEventListener("click", async () => {
      await patch(`/api/segments/${seg.id}`, { speaker_id: parseInt($(".sp-sel", slot).value, 10) });
      toast("Speaker set");
      BOOKDATA = await get(`/api/books/${bookId}`); renderMilestones(); vListen(el);
    });
  };

  $$(".seg", el).forEach((segEl) => {
    const seg = segs.find((s) => s.id === parseInt(segEl.dataset.seg, 10));
    $$(".w", segEl).forEach((w) => w.addEventListener("click", () => openPronPanel(segEl, seg, w.dataset.w)));
    $("[data-spk]", segEl).addEventListener("click", () => openSpeakerPanel(segEl, seg));
    $$("[data-flag]", segEl).forEach((b) => b.addEventListener("click", async () => {
      const type = b.dataset.flag;
      if (type === "pronunciation") { openPronPanel(segEl, seg, seg.display_text.split(/\s+/)[0]); return; }
      const note = type === "note" ? (prompt("Note for this line:") || "") : "";
      if (type === "note" && !note) return;
      await post(`/api/books/${bookId}/flags`, { segment_id: seg.id, type, note });
      toast("Flagged — it's in the Fix list");
      vListen(el);
    }));
  });
}

// ---- Recording ----
async function vRecording(el) {
  const rows = BOOKDATA.chapters.map((ch) => `
    <tr><td>${ch.idx}. ${esc(ch.title)}</td>
      <td><span class="chip ${ch.render_state}">${esc(ch.render_state.replace("_", " "))}</span></td>
      <td>${ch.approved ? "✅" : "—"}</td>
      <td><button class="btn small" data-pkg="${ch.id}">Render package</button>
      <select data-state="${ch.id}">
        ${["not_started", "queued", "rendering", "ready", "stale"].map((s) => `<option ${s === ch.render_state ? "selected" : ""}>${s}</option>`).join("")}
      </select></td></tr>`).join("");
  el.innerHTML = `<h1>Recording your book</h1>
    <p class="muted">Recording happens on the Mac Mini pipeline. A render package is one chapter's lines, cast, and pronunciation rules — everything the pipeline needs. Generate a package, hand it to the pipeline, then mark the chapter ready when the audio comes back. If casting or a pronunciation changes afterwards, the chapter shows as <b>stale</b>.</p>
    <div class="card"><button class="btn" id="pkgall">Generate the full-book render package</button></div>
    <div class="card"><table><tr><th>Chapter</th><th>State</th><th>Approved</th><th></th></tr>${rows}</table></div>`;
  $("#pkgall", el).addEventListener("click", async () => {
    toast("Building the full package — this can take a moment…", 6000);
    await downloadPackage(bookId, {}, `render-package-book${bookId}.json`);
    BOOKDATA = await get(`/api/books/${bookId}`); vRecording(el);
  });
  $$("[data-pkg]", el).forEach((b) => b.addEventListener("click", async () => {
    await downloadPackage(bookId, { chapter_id: parseInt(b.dataset.pkg, 10) },
      `render-package-chapter.json`);
    BOOKDATA = await get(`/api/books/${bookId}`); vRecording(el);
  }));
  $$("[data-state]", el).forEach((s) => s.addEventListener("change", async () => {
    await patch(`/api/chapters/${s.dataset.state}`, { render_state: s.value });
    BOOKDATA = await get(`/api/books/${bookId}`); renderMilestones(); vRecording(el);
  }));
}

// ---- Make my files ----
async function vFiles(el) {
  el.innerHTML = `<h1>Make my files</h1>
    <p class="muted">Everything the production needs, in open formats.</p>
    <div class="card">
      <p><button class="btn" id="f-prod">Production package (JSON)</button>
      <span class="small muted">Book, full cast with voices, every pronunciation rule, chapter states.</span></p>
      <p><button class="btn ghost" id="f-cast">Casting sheet (CSV)</button>
      <button class="btn ghost" id="f-pron">Pronunciation sheet (CSV)</button>
      <button class="btn ghost" id="f-render">Full render package (JSON)</button></p>
    </div>
    <div class="card"><h2>Credits (as exported)</h2>
    <p>“This audiobook was produced with AI-generated synthetic voices. No human narrator performed this recording.”</p>
    <p class="small muted">The AI-disclosure line is included in the production package credits automatically.</p></div>`;
  $("#f-prod", el).addEventListener("click", () =>
    download(`/api/books/${bookId}/export/production`, {}, `production-book${bookId}.json`));
  $("#f-cast", el).addEventListener("click", () =>
    download(`/api/books/${bookId}/export/casting.csv`, {}, "casting.csv"));
  $("#f-pron", el).addEventListener("click", () =>
    download(`/api/books/${bookId}/export/pronunciation.csv`, {}, "pronunciation.csv"));
  $("#f-render", el).addEventListener("click", () =>
    downloadPackage(bookId, {}, `render-package-book${bookId}.json`));
}

// ---- New book / Replace ----
async function readFileText(input) {
  const f = input.files && input.files[0];
  return f ? f.text() : null;
}
async function vNewBook(el) {
  el.innerHTML = `<h1>Bring in a book</h1>
    <div class="card">
      <p><input id="nb-title" placeholder="Title" size="40"> <input id="nb-author" placeholder="Author" size="24"></p>
      <p><input type="file" id="nb-file" accept=".txt"> <span class="small muted">or paste the text:</span></p>
      <textarea id="nb-text" placeholder="Paste the manuscript text — chapters are split on lines that say “Chapter 1”, “Chapter 2”, …"></textarea>
      <p><button class="btn" id="nb-go">Bring it in</button></p>
      <div id="nb-out"></div>
    </div>`;
  $("#nb-go", el).addEventListener("click", async () => {
    const title = $("#nb-title", el).value.trim();
    let text = $("#nb-text", el).value;
    const ft = await readFileText($("#nb-file", el));
    if (ft) text = ft;
    if (!title || !text.trim()) { toast("A title and the manuscript text are both needed"); return; }
    $("#nb-out", el).textContent = "Reading your book…";
    try {
      const r = await post("/api/books", { title, author: $("#nb-author", el).value.trim(), text });
      bookId = r.book_id;
      await loadBook();
      $("#nb-out", el).innerHTML = `✅ In: ${r.chapters} chapters, ${r.segments} passages. <a href="#speakers">Check who's talking</a>.`;
    } catch (e) { $("#nb-out", el).textContent = "Something went wrong: " + e.message; }
  });
}

async function vReplace(el) {
  el.innerHTML = `<h1>Replace the manuscript</h1>
    <div class="card">
      <p>When the copyedit lands, drop the new full text here. Nothing you've done is thrown away:
      paragraphs that didn't change keep their speakers, approvals, and flags; changed paragraphs
      come in fresh and their chapters are marked stale so you know what to re-check.
      The old version stays in the database — this adds version ${BOOKDATA.versions.length + 1}.</p>
      <p><input type="file" id="rp-file" accept=".txt"> <span class="small muted">or paste:</span></p>
      <textarea id="rp-text" placeholder="Paste the full revised manuscript"></textarea>
      <p><button class="btn" id="rp-go">Replace manuscript</button></p>
      <div id="rp-out"></div>
    </div>`;
  $("#rp-go", el).addEventListener("click", async () => {
    let text = $("#rp-text", el).value;
    const ft = await readFileText($("#rp-file", el));
    if (ft) text = ft;
    if (!text.trim()) { toast("Paste or choose the revised text first"); return; }
    if (!confirm("Replace the manuscript with this new version? Your casting, rules, and unchanged work carry over.")) return;
    $("#rp-out", el).textContent = "Comparing versions…";
    try {
      const r = await post(`/api/books/${bookId}/replace`, { text, source_name: "replacement upload" });
      $("#rp-out", el).innerHTML = `✅ Now on version ${r.version_no}: ${r.paragraphs_matched} paragraphs carried over unchanged,
        ${r.paragraphs_changed} new or changed, ${r.flags_carried} flags carried, ${r.chapters_stale} chapter(s) marked stale.`;
      BOOKDATA = await get(`/api/books/${bookId}`); renderMilestones();
    } catch (e) { $("#rp-out", el).textContent = "Something went wrong: " + e.message; }
  });
}

// ---- Router ----
const VIEWS = { home: vHome, book: vBook, sample: vSample, speakers: vSpeakers,
  cast: vCast, tricky: vTricky, pron: vPron, listen: vListen,
  recording: vRecording, files: vFiles, newbook: vNewBook, replace: vReplace };

async function route() {
  const name = (location.hash || "#home").slice(1);
  const view = VIEWS[name] || vHome;
  $$("#mainnav a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + name));
  const el = $("#view");
  el.innerHTML = `<p class="muted">Loading…</p>`;
  try { await view(el); }
  catch (e) { el.innerHTML = `<h1>Something went wrong</h1><p>${esc(e.message)}</p>`; }
}
window.addEventListener("hashchange", route);
(async () => {
  try { await loadBook(); } catch (e) { toast("Could not load: " + e.message); }
  route();
})();
