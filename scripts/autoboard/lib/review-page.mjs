// Static HTML/CSS/JS for the local review server (see review-server.mjs).
// No build step, no framework. All dynamic content is built via DOM APIs
// (createElement/textContent) rather than innerHTML string interpolation —
// item names/SKUs come from the Smartsheet and shouldn't be trusted as markup.

export function renderReviewPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Autoboard Review</title>
<style>
  :root { --bg:#fafaf8; --surface:#fff; --line:#ddd; --ink:#1a1a1a; --muted:#666; --accent:#7c4a03; --danger:#a5502f; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; background: var(--bg); color: var(--ink); }
  header { position: sticky; top: 0; background: var(--surface); border-bottom: 1px solid var(--line); padding: 1rem 1.5rem; z-index: 5; }
  header h1 { margin: 0 0 0.25rem; font-size: 1.2rem; }
  header p { margin: 0; font-size: 0.8rem; color: var(--muted); }
  #board-nav { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.6rem; }
  #board-nav a { font-size: 0.72rem; padding: 0.15rem 0.5rem; background: #f0f0ec; border-radius: 4px; color: var(--ink); text-decoration: none; }
  main { max-width: 1200px; margin: 0 auto; padding: 1.5rem; }
  section.board { margin-bottom: 2.5rem; scroll-margin-top: 6rem; }
  section.board h2 { font-size: 1.05rem; margin: 0 0 0.2rem; }
  section.board .meta { font-size: 0.78rem; color: var(--muted); margin-bottom: 0.8rem; }
  .slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
  .slot-card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .slot-card img { width: 100%; height: 140px; object-fit: cover; display: block; background: #eee; }
  .slot-card .body { padding: 0.6rem 0.7rem; }
  .slot-card .slot-id { font-family: monospace; font-size: 0.68rem; color: var(--accent); text-transform: uppercase; }
  .slot-card .name { font-size: 0.85rem; margin: 0.2rem 0; line-height: 1.3; min-height: 2.4em; }
  .slot-card .brand { font-size: 0.72rem; color: var(--muted); }
  .slot-card .overridden { display: inline-block; margin-top: 0.3rem; font-size: 0.68rem; color: var(--danger); }
  .slot-card .low-res { display: inline-block; margin-top: 0.3rem; margin-right: 0.3rem; padding: 0.05rem 0.35rem; font-size: 0.66rem; color: #92400e; background: #fef3c7; border-radius: 4px; }
  .slot-card .actions { display: flex; gap: 0.4rem; margin-top: 0.5rem; }
  button { font-size: 0.75rem; padding: 0.3rem 0.6rem; border: 1px solid var(--line); background: #f5f5f2; border-radius: 4px; cursor: pointer; }
  button:hover { background: #ebebe6; }
  #modal-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 10; }
  #modal { position: fixed; inset: 4vh 4vw; background: var(--surface); border-radius: 10px; z-index: 11; display: none; flex-direction: column; }
  #modal-header { padding: 1rem 1.25rem; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
  #modal-grid { padding: 1rem; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.75rem; }
  .option { border: 1px solid var(--line); border-radius: 6px; overflow: hidden; cursor: pointer; background: #fff; text-align: left; padding: 0; }
  .option img { width: 100%; height: 110px; object-fit: cover; display: block; }
  .option .label { padding: 0.4rem 0.5rem; font-size: 0.72rem; line-height: 1.25; }
  .option:hover { outline: 2px solid var(--accent); }
  .upload-card { cursor: default; display: flex; flex-direction: column; gap: 0.4rem; padding: 0.6rem; }
  .upload-card:hover { outline: none; }
  .upload-card input[type="text"] { font-size: 0.75rem; padding: 0.3rem; border: 1px solid var(--line); border-radius: 4px; width: 100%; }
  .upload-card input[type="file"] { font-size: 0.7rem; width: 100%; }
  .error { color: var(--danger); font-size: 0.7rem; }
  .replace-control { padding: 0.3rem 0.5rem 0.5rem; }
  .replace-control input[type="file"] { display: none; }
  .replace-control button { font-size: 0.68rem; padding: 0.15rem 0.4rem; }
  .hero-control { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.8rem; font-size: 0.8rem; }
  .hero-control select { font-size: 0.78rem; padding: 0.25rem 0.4rem; border: 1px solid var(--line); border-radius: 4px; background: #fff; }
  .add-slot-panel { margin-top: 1rem; }
  .add-slot-toggle { font-size: 0.78rem; }
  .add-slot-form { flex-direction: column; gap: 0.5rem; max-width: 360px; margin-top: 0.6rem; padding: 0.8rem; background: var(--surface); border: 1px dashed var(--line); border-radius: 8px; }
  .add-slot-form input[type="text"] { font-size: 0.8rem; padding: 0.35rem; border: 1px solid var(--line); border-radius: 4px; width: 100%; }
  .add-slot-form label { display: flex; align-items: center; font-size: 0.8rem; gap: 0.3rem; }
  .add-slot-form .error { color: var(--danger); font-size: 0.75rem; }
  #status { position: fixed; bottom: 1rem; right: 1rem; background: #14532d; color: #fff; padding: 0.5rem 0.9rem; border-radius: 6px; font-size: 0.8rem; opacity: 0; transition: opacity 0.2s; z-index: 20; }
  #status.error { background: var(--danger); }
  #status.show { opacity: 1; }
  .board-grid { display: grid; grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr); gap: 1.25rem; align-items: start; }
  @media (max-width: 1000px) { .board-grid { grid-template-columns: 1fr; } }
  .slot-card textarea.note { width: 100%; margin-top: 0.4rem; font-size: 0.72rem; padding: 0.3rem; border: 1px solid var(--line); border-radius: 4px; resize: vertical; min-height: 2.2em; font-family: inherit; }
  .render-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 0.8rem; position: sticky; top: 7rem; }
  .render-panel h3 { margin: 0 0 0.5rem; font-size: 0.8rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
  .render-controls { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; margin-bottom: 0.5rem; }
  .variant-toggle button { padding: 0.25rem 0.55rem; }
  .variant-toggle button.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  .render-controls input[type="number"] { width: 3.2rem; font-size: 0.75rem; padding: 0.25rem; border: 1px solid var(--line); border-radius: 4px; }
  .render-status { font-size: 0.75rem; color: var(--muted); min-height: 1.2em; margin-bottom: 0.6rem; }
  .render-status.error { color: var(--danger); }
  .render-strip h4 { margin: 0.6rem 0 0.3rem; font-size: 0.72rem; color: var(--muted); }
  .thumbs { display: flex; flex-wrap: wrap; gap: 0.45rem; }
  .thumb { position: relative; width: 120px; border: 2px solid var(--line); border-radius: 6px; overflow: hidden; background: #eee; }
  .thumb.picked { border-color: var(--accent); }
  .thumb img { width: 100%; height: 80px; object-fit: cover; display: block; cursor: zoom-in; }
  .thumb .badge { position: absolute; top: 3px; left: 3px; font-size: 0.62rem; background: rgba(0,0,0,0.65); color: #fff; padding: 0.05rem 0.3rem; border-radius: 3px; pointer-events: none; }
  .thumb .stale { position: absolute; top: 62px; left: 0; right: 0; font-size: 0.6rem; background: rgba(90,90,90,0.85); color: #fff; text-align: center; pointer-events: none; }
  .thumb .thumb-actions { display: flex; gap: 0.2rem; padding: 0.2rem; background: #fff; }
  .thumb .thumb-actions button, .thumb .thumb-actions a { font-size: 0.62rem; padding: 0.1rem 0.3rem; flex: 1; text-align: center; text-decoration: none; color: var(--ink); border: 1px solid var(--line); border-radius: 4px; background: #f5f5f2; }
  .thumb .thumb-actions button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  details.earlier summary { font-size: 0.72rem; color: var(--muted); cursor: pointer; margin-top: 0.4rem; }
  .render-panel textarea.instruction { width: 100%; margin-top: 0.6rem; font-size: 0.75rem; padding: 0.35rem; border: 1px solid var(--line); border-radius: 4px; resize: vertical; min-height: 2.4em; font-family: inherit; }
  .render-actions { display: flex; gap: 0.4rem; margin-top: 0.5rem; }
  .render-actions button[disabled] { opacity: 0.45; cursor: not-allowed; }
  #queue-badge { font-size: 0.72rem; color: var(--accent); margin-left: 0.6rem; font-weight: normal; }
  #lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 30; align-items: center; justify-content: center; flex-direction: column; gap: 0.5rem; }
  #lightbox img { max-width: 94vw; max-height: 86vh; object-fit: contain; }
  #lightbox .caption { color: #fff; font-size: 0.8rem; }
</style>
</head>
<body>
<header>
  <h1 id="run-title"><span id="run-title-text">Autoboard Review</span> <span id="queue-badge"></span></h1>
  <p id="run-source"></p>
  <div id="board-nav"></div>
</header>
<main id="boards"></main>

<div id="modal-backdrop"></div>
<div id="modal">
  <div id="modal-header">
    <strong id="modal-title">Choose an item</strong>
    <button id="modal-close">Close</button>
  </div>
  <div id="modal-grid"></div>
</div>
<div id="lightbox"><img id="lightbox-img" alt=""><div class="caption" id="lightbox-caption"></div></div>
<div id="status"></div>

<script>
"use strict";
let plan = null;
let activeBoardId = null;
let activeSlotId = null;

let renderStatus = { accessError: null, baseUrl: "", queue: [], renders: {}, costs: { draft: 0, confirm: 0, final: 0 }, selectionHashes: {} };
let lastRenderJson = "";
const panelPrefs = {}; // boardId -> { variant, count }
let lightboxList = [];
let lightboxIndex = 0;

function money(kind, count) {
  return "~$" + (renderStatus.costs[kind] * (count || 1)).toFixed(2);
}

function prefsFor(boardId) {
  if (!panelPrefs[boardId]) panelPrefs[boardId] = { variant: "A", count: 3 };
  return panelPrefs[boardId];
}

function emptyRenders() {
  return { instruction: "", pickedDraftId: null, approvedConfirmedId: null, drafts: [], confirmed: [], finals: [] };
}

function boardJobs(boardId) {
  return renderStatus.queue.filter((job) => job.boardId === boardId);
}

function activeJob(boardId) {
  return boardJobs(boardId).find((job) => job.state === "running" || job.state === "queued") || null;
}

function statusLine(boardId) {
  const job = activeJob(boardId);
  if (job && job.state === "queued") {
    const ahead = renderStatus.queue.filter((entry) => (entry.state === "running" || entry.state === "queued") && entry.createdAt < job.createdAt).length;
    return { text: "queued (" + ahead + " ahead)", error: false };
  }
  if (job && job.state === "running") {
    const seconds = Math.max(0, Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000));
    return { text: "rendering " + job.kind + (job.progress ? " " + job.progress : "") + " \\u00b7 " + seconds + "s", error: false };
  }
  if (renderStatus.accessError) return { text: "Access session expired \\u2014 run: cloudflared access login " + renderStatus.baseUrl + " \\u2014 then click again", error: true };
  const last = boardJobs(boardId).slice(-1)[0];
  if (!last) return { text: "", error: false };
  if (last.state === "failed") {
    let text = "failed: " + (last.error && last.error.message ? last.error.message : "unknown error");
    if (last.error && last.error.retryAfterMs) {
      const wait = Math.ceil((new Date(last.finishedAt).getTime() + last.error.retryAfterMs - Date.now()) / 1000);
      if (wait > 0) text += " (retry after " + wait + "s)";
    }
    return { text: text, error: true };
  }
  if (last.state === "cancelled") return { text: "cancelled" + (last.progress ? " after " + last.progress : ""), error: false };
  if (last.state === "done") return { text: "done " + new Date(last.finishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), error: false };
  return { text: "", error: false };
}

function renderThumb(board, entry, kind) {
  const record = renderStatus.renders[board.id] || emptyRenders();
  const hasNotes = Boolean(entry.instruction) || Object.keys(entry.itemNotes || {}).length > 0;
  const img = el("img", { src: entry.url, alt: entry.id, "data-action": "lightbox", "data-board": board.id, "data-kind": kind, "data-id": entry.id });
  const children = [img, el("span", { className: "badge", text: entry.variant + (kind === "draft" ? " " + entry.index : "") + (hasNotes ? " \\ud83d\\udcac" : "") })];
  if (entry.stale) children.push(el("span", { className: "stale", text: "stale" }));
  const actions = el("div", { className: "thumb-actions" });
  if (kind === "draft") {
    const picked = record.pickedDraftId === entry.id;
    actions.appendChild(el("button", { className: picked ? "on" : "", "data-action": "pick-draft", "data-board": board.id, "data-id": entry.id, text: picked ? "\\u2713 picked" : "pick" }));
  } else if (kind === "confirm") {
    const approved = record.approvedConfirmedId === entry.id;
    actions.appendChild(el("button", { className: approved ? "on" : "", "data-action": "approve", "data-board": board.id, "data-id": approved ? "" : entry.id, text: approved ? "\\u2713 approved" : "approve" }));
  } else if (entry.libraryJobId) {
    actions.appendChild(el("a", { href: renderStatus.baseUrl + "/library?job=" + encodeURIComponent(entry.libraryJobId), target: "_blank", rel: "noopener", text: "Library \\u2197" }));
  }
  const thumb = el("div", { className: "thumb" + (kind === "draft" && record.pickedDraftId === entry.id ? " picked" : ""), title: entry.instruction || "" }, children);
  thumb.appendChild(actions);
  return thumb;
}

function renderDraftStrip(board) {
  const record = renderStatus.renders[board.id] || emptyRenders();
  const drafts = record.drafts;
  const wrap = el("div", { className: "render-strip" });
  if (!drafts.length) { wrap.appendChild(el("h4", { text: "Drafts \\u2014 none yet" })); return wrap; }
  const latestRevision = drafts[drafts.length - 1].revision;
  const current = drafts.filter((entry) => entry.revision === latestRevision);
  const earlier = drafts.filter((entry) => entry.revision !== latestRevision).reverse();
  wrap.appendChild(el("h4", { text: "Drafts (rev " + latestRevision + ")" }));
  wrap.appendChild(el("div", { className: "thumbs" }, current.map((entry) => renderThumb(board, entry, "draft"))));
  if (earlier.length) {
    wrap.appendChild(el("details", { className: "earlier" }, [
      el("summary", { text: "earlier drafts (" + earlier.length + ")" }),
      el("div", { className: "thumbs" }, earlier.map((entry) => renderThumb(board, entry, "draft"))),
    ]));
  }
  return wrap;
}

function renderStrip(board, list, kind, label) {
  const wrap = el("div", { className: "render-strip" });
  wrap.appendChild(el("h4", { text: label + (list.length ? "" : " \\u2014 none yet") }));
  if (list.length) wrap.appendChild(el("div", { className: "thumbs" }, list.map((entry) => renderThumb(board, entry, kind))));
  return wrap;
}

function renderPanel(board) {
  const record = renderStatus.renders[board.id] || emptyRenders();
  const prefs = prefsFor(board.id);
  const job = activeJob(board.id);
  const panel = el("div", { className: "render-panel", "data-board": board.id });
  panel.appendChild(el("h3", { text: "Render" }));

  const toggle = el("span", { className: "variant-toggle" }, ["A", "B", "C"].map((key) =>
    el("button", { className: prefs.variant === key ? "active" : "", "data-action": "variant", "data-board": board.id, "data-variant": key, text: key })));
  const count = el("input", { type: "number", min: "1", max: "10", value: String(prefs.count), "data-action": "count", "data-board": board.id, title: "How many drafts of this variant" });
  // Renders as a button element with the attribute data-action="draft", picked up by the click-delegation handler below.
  const draftButton = el("button", { "data-action": "draft", "data-board": board.id, text: "Draft \\u00d7" + prefs.count + " \\u00b7 " + money("draft", prefs.count) });
  const controls = el("div", { className: "render-controls" }, [toggle, count, draftButton]);
  if (job) controls.appendChild(el("button", { "data-action": "cancel", "data-board": board.id, "data-job": job.jobId, text: "\\u23f9 cancel" }));
  panel.appendChild(controls);

  const line = statusLine(board.id);
  panel.appendChild(el("div", { className: "render-status" + (line.error ? " error" : ""), text: line.text }));

  panel.appendChild(renderDraftStrip(board));

  const instruction = el("textarea", { className: "instruction", placeholder: "Board instruction for the next render (e.g. more breathing room, tile lower-left)", "data-action": "instruction", "data-board": board.id });
  instruction.value = record.instruction || "";
  panel.appendChild(instruction);

  const hash = renderStatus.selectionHashes[board.id];
  const picked = record.drafts.find((entry) => entry.id === record.pickedDraftId) || null;
  const approved = record.confirmed.find((entry) => entry.id === record.approvedConfirmedId) || null;
  const source = approved || picked;
  const confirmButton = el("button", { "data-action": "confirm", "data-board": board.id, text: "Confirm \\u25b6 medium \\u00b7 " + money("confirm", 1) });
  if (!picked) { confirmButton.disabled = true; confirmButton.title = "Pick a draft first"; }
  const finalButton = el("button", { "data-action": "final", "data-board": board.id, text: "Final \\u25b6 high \\u2192 Library \\u00b7 " + money("final", 1) });
  if (!source) { finalButton.disabled = true; finalButton.title = "Pick a draft or approve a confirmed render first"; }
  else if (source.selectionHash !== hash) { finalButton.disabled = true; finalButton.title = "The picked render is stale: the selection changed since it was rendered. Draft again first."; }
  panel.appendChild(el("div", { className: "render-actions" }, [confirmButton, finalButton]));

  panel.appendChild(renderStrip(board, record.confirmed, "confirm", "Confirmed"));
  panel.appendChild(renderStrip(board, record.finals, "final", "Final"));
  return panel;
}

// ---- tiny DOM builder — no innerHTML with dynamic data anywhere below ----
function el(tag, props, children) {
  const node = document.createElement(tag);
  props = props || {};
  for (const key of Object.keys(props)) {
    const value = props[key];
    if (key === "text") node.textContent = value;
    else if (key === "className") node.className = value;
    else if (key.indexOf("data-") === 0) node.setAttribute(key, value);
    else node.setAttribute(key, value);
  }
  (children || []).forEach((child) => { if (child) node.appendChild(child); });
  return node;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function imageUrl(path) {
  return "/image?path=" + encodeURIComponent(path);
}

function showStatus(message, isError) {
  const node = document.getElementById("status");
  node.textContent = message;
  node.className = "show" + (isError ? " error" : "");
  setTimeout(() => { node.className = ""; }, 2200);
}

async function loadPlan() {
  const response = await fetch("/api/plan");
  plan = await response.json();
  document.getElementById("run-title-text").textContent = "Autoboard Review — " + plan.runId;
  document.getElementById("run-source").textContent = "Source: " + plan.source;
  renderNav();
  renderBoards();
}

function renderNav() {
  const nav = document.getElementById("board-nav");
  clear(nav);
  plan.boards.forEach((board) => {
    nav.appendChild(el("a", { href: "#board-" + board.id, text: board.id }));
  });
}

function renderBoards() {
  const main = document.getElementById("boards");
  clear(main);
  plan.boards.forEach((board) => main.appendChild(renderBoard(board)));
}

function renderBoard(board) {
  const slots = el("div", { className: "slots" });
  board.items.forEach((item) => slots.appendChild(renderSlotCard(board, item)));
  const left = el("div", { className: "board-left" }, [renderHeroControl(board), slots, renderAddSlotPanel(board)]);
  const right = el("div", { className: "board-right" }, [renderPanel(board)]);
  return el("section", { className: "board", id: "board-" + board.id }, [
    el("h2", { text: board.title }),
    el("div", { className: "meta", text: board.collageType + " \\u00b7 " + board.items.length + " slot(s)" }),
    el("div", { className: "board-grid" }, [left, right]),
  ]);
}

// Finding F3a: lets the reviewer pin which slot anchors the composition
// instead of always trusting heroFor's ranked auto-pick.
function renderHeroControl(board) {
  const hasManualHero = Boolean(board.heroItemId);
  const select = el("select", { className: "hero-select" });
  board.items.forEach((item) => {
    const showDefaultTag = !hasManualHero && item.slotId === board.defaultHeroItemId;
    select.appendChild(el("option", { value: item.slotId, text: item.slotId + (showDefaultTag ? " (default)" : "") }));
  });
  select.value = board.heroItemId || board.defaultHeroItemId;

  select.addEventListener("change", async () => {
    const boardId = board.id;
    const slotId = select.value;
    try {
      const response = await fetch("/api/set-hero", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardId: boardId, slotId: slotId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Set hero failed");
      updateBoardInPlan(boardId, data.board);
      showStatus("Hero item set \\u2014 " + slotId + ".");
    } catch (error) {
      showStatus(error.message, true);
    }
  });

  const resetButton = el("button", { className: "hero-reset", text: "Reset to default" });
  resetButton.disabled = !hasManualHero;
  resetButton.addEventListener("click", async () => {
    const boardId = board.id;
    try {
      const response = await fetch("/api/set-hero", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardId: boardId, slotId: null }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Reset hero failed");
      updateBoardInPlan(boardId, data.board);
      showStatus("Hero item reset to default for " + boardId + ".");
    } catch (error) {
      showStatus(error.message, true);
    }
  });

  return el("div", { className: "hero-control" }, [
    el("label", { text: "Hero item:" }),
    select,
    resetButton,
  ]);
}

function updateBoardInPlan(boardId, updatedBoard) {
  const index = plan.boards.findIndex((entry) => entry.id === boardId);
  plan.boards[index] = updatedBoard;
  const section = document.getElementById("board-" + boardId);
  section.replaceWith(renderBoard(updatedBoard));
}

// A small "Replace photo" control usable both on the main-page card (no
// target argument — swaps whatever currently occupies slotId) and on a
// picker option card (target: { kind, code|rowId } — swaps that SPECIFIC
// library item's own photo, which may not even be the slot's current pick).
// Stops propagation on every click inside it so it never triggers the
// option's own "select this" click handler (see openPicker's use of it,
// nested inside an .option card whose whole body is otherwise
// clickable-to-select).
function createReplaceControl({ boardId, slotId, target, buttonText, onDone }) {
  const fileInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp" });
  const button = el("button", { text: buttonText });
  const errorText = el("div", { className: "error" });

  button.addEventListener("click", () => { fileInput.click(); });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    button.disabled = true;
    errorText.textContent = "";
    try {
      const dataBase64 = await fileToBase64(file);
      const body = { boardId: boardId, slotId: slotId, mimeType: file.type, dataBase64: dataBase64 };
      if (target) body.target = target;
      const response = await fetch("/api/replace-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Replace image failed");
      button.disabled = false;
      fileInput.value = "";
      onDone(data);
    } catch (error) {
      errorText.textContent = error.message;
      button.disabled = false;
    }
  });

  const wrap = el("div", { className: "replace-control" }, [button, fileInput, errorText]);
  wrap.addEventListener("click", (event) => { event.stopPropagation(); });
  return wrap;
}

function renderSlotCard(board, item) {
  const image = item.images && item.images[0];
  const img = el("img", { src: image ? imageUrl(image) : "", alt: item.slotId });
  const body = el("div", { className: "body" }, [
    el("div", { className: "slot-id", text: item.slotId + (item.required ? "" : " (optional)") }),
    el("div", { className: "name", text: item.name || "(unnamed)" }),
    el("div", { className: "brand", text: item.brand || "" }),
  ]);
  const meta = item.imageMeta && item.imageMeta[0];
  if (meta && !meta.error && Math.min(meta.width, meta.height) < 600) {
    body.appendChild(el("div", { className: "low-res", text: "low-res " + meta.width + "x" + meta.height }));
  }
  if (item.overriddenAt) {
    body.appendChild(el("div", { className: "overridden", text: "manually changed" }));
    body.appendChild(el("button", { "data-action": "reset", "data-board": board.id, "data-slot": item.slotId, text: "Reset to auto-pick" }));
  }
  const actions = el("div", { className: "actions" }, [
    el("button", { "data-action": "change", "data-board": board.id, "data-slot": item.slotId, text: "Change" }),
    el("button", { "data-action": "remove-slot", "data-board": board.id, "data-slot": item.slotId, text: "Remove" }),
  ]);
  body.appendChild(actions);
  const note = el("textarea", { className: "note", placeholder: "Note for this item (used by the next render)", "data-action": "item-note", "data-board": board.id, "data-slot": item.slotId });
  note.value = item.note || "";
  body.appendChild(note);
  // Swaps just this slot's photo in place — same item, new picture. No
  // target argument, so the server always resolves it to whatever's
  // currently in this slot (a real row, a custom item, or a tile) and
  // refreshes it.
  body.appendChild(createReplaceControl({
    boardId: board.id,
    slotId: item.slotId,
    target: null,
    buttonText: "Replace image",
    onDone: (data) => {
      updateItemInPlan(board.id, data.item);
      showStatus("Replaced image — " + item.slotId + " updated.");
    },
  }));
  const card = el("article", { className: "slot-card", "data-board": board.id, "data-slot": item.slotId }, [img, body]);
  return card;
}

// A collapsed-by-default "+ Add slot" panel at the bottom of each board —
// creates an entirely new item (not one of the board type's preset slots),
// requiring an image up front since there's no "auto-pick" to fall back on.
function renderAddSlotPanel(board) {
  const toggleButton = el("button", { className: "add-slot-toggle", text: "+ Add slot" });
  const form = el("div", { className: "add-slot-form" });
  form.style.display = "none";

  const slotIdInput = el("input", { type: "text", placeholder: "Slot ID, e.g. wall_art (letters/numbers/underscore)" });
  const roleInput = el("input", { type: "text", placeholder: "Role, e.g. decorative wall art" });
  const requiredLabel = el("label", {}, [
    el("input", { type: "checkbox" }),
    el("span", { text: " Required" }),
  ]);
  const requiredCheckbox = requiredLabel.querySelector("input");
  const nameInput = el("input", { type: "text", placeholder: "Item name" });
  const brandInput = el("input", { type: "text", placeholder: "Brand (optional)" });
  const notesInput = el("input", { type: "text", placeholder: "Notes (optional)" });
  const fileInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp" });
  const errorText = el("div", { className: "error" });
  const submitButton = el("button", { text: "Add slot" });

  toggleButton.addEventListener("click", () => {
    form.style.display = form.style.display === "none" ? "flex" : "none";
  });

  submitButton.addEventListener("click", async () => {
    const slotId = slotIdInput.value.trim();
    const role = roleInput.value.trim();
    const name = nameInput.value.trim();
    const brand = brandInput.value.trim();
    const notes = notesInput.value.trim();
    const file = fileInput.files[0];
    if (!slotId || !name || !file) { errorText.textContent = "Slot ID, name, and a file are all required."; return; }
    submitButton.disabled = true;
    errorText.textContent = "";
    try {
      const dataBase64 = await fileToBase64(file);
      const response = await fetch("/api/add-slot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardId: board.id, slotId: slotId, role: role, required: requiredCheckbox.checked,
          name: name, brand: brand, notes: notes, mimeType: file.type, dataBase64: dataBase64,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Add slot failed");
      showStatus("Added slot '" + slotId + "'.");
      await loadPlan();
    } catch (error) {
      errorText.textContent = error.message;
      submitButton.disabled = false;
    }
  });

  form.appendChild(el("div", {}, [slotIdInput]));
  form.appendChild(el("div", {}, [roleInput]));
  form.appendChild(requiredLabel);
  form.appendChild(el("div", {}, [nameInput]));
  form.appendChild(el("div", {}, [brandInput]));
  form.appendChild(el("div", {}, [notesInput]));
  form.appendChild(el("div", {}, [fileInput]));
  form.appendChild(submitButton);
  form.appendChild(errorText);

  return el("div", { className: "add-slot-panel" }, [toggleButton, form]);
}

async function openPicker(boardId, slotId) {
  activeBoardId = boardId;
  activeSlotId = slotId;
  document.getElementById("modal-title").textContent = boardId + " \\u2014 " + slotId;
  const grid = document.getElementById("modal-grid");
  clear(grid);
  grid.appendChild(el("p", { text: "Loading..." }));
  document.getElementById("modal-backdrop").style.display = "block";
  document.getElementById("modal").style.display = "flex";
  const response = await fetch("/api/library?boardId=" + encodeURIComponent(boardId) + "&slotId=" + encodeURIComponent(slotId));
  const data = await response.json();
  clear(grid);
  data.options.forEach((option) => {
    if (option.kind === "row" && !option.imagePath) {
      grid.appendChild(renderUploadRowCard(option));
      return;
    }
    const labelText = option.kind === "tile"
      ? option.code + " \\u2014 " + option.label
      : option.label + (option.sku ? " (" + option.sku + ")" : "");
    const props = { className: "option" };
    if (option.kind === "tile") { props["data-kind"] = "tile"; props["data-code"] = option.code; }
    else { props["data-kind"] = "row"; props["data-row-id"] = option.rowId; }
    const img = el("img", { src: imageUrl(option.imagePath), alt: "" });
    // Fixes THIS option's own photo on disk — not necessarily the slot's
    // current pick (the picker lists every candidate in the room, not just
    // the active one). If it does turn out to be the active pick, the server
    // reports back an updated item and the slot card refreshes too;
    // otherwise only this thumbnail changes.
    const target = option.kind === "tile" ? { kind: "tile", code: option.code } : { kind: "row", rowId: option.rowId };
    const replaceControl = createReplaceControl({
      boardId: activeBoardId,
      slotId: activeSlotId,
      target: target,
      buttonText: "Replace photo",
      onDone: (data) => {
        if (data.item) {
          updateItemInPlan(activeBoardId, data.item);
          img.src = imageUrl(data.item.images[0]);
        } else {
          img.src = imageUrl(data.imagePath);
        }
        showStatus("Replaced photo for \\u2014 " + labelText);
      },
    });
    grid.appendChild(el("div", props, [
      img,
      el("div", { className: "label", text: labelText }),
      replaceControl,
    ]));
  });
  if (data.slotKind === "tile") grid.appendChild(renderAddTileCard());
  else grid.appendChild(renderAddCustomItemCard());
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

function renderUploadRowCard(option) {
  const fileInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp" });
  const errorText = el("div", { className: "error" });
  const button = el("button", { text: "Upload & select" });
  button.addEventListener("click", async () => {
    const file = fileInput.files[0];
    if (!file) { errorText.textContent = "Choose a file first."; return; }
    const boardId = activeBoardId;
    const slotId = activeSlotId;
    button.disabled = true;
    errorText.textContent = "";
    try {
      const dataBase64 = await fileToBase64(file);
      const response = await fetch("/api/upload-row-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardId: boardId, slotId: slotId, rowId: option.rowId, mimeType: file.type, dataBase64: dataBase64 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Upload failed");
      updateItemInPlan(boardId, data.item);
      closePicker();
      showStatus("Uploaded and selected \\u2014 " + slotId + " updated.");
    } catch (error) {
      errorText.textContent = error.message;
      button.disabled = false;
    }
  });
  return el("div", { className: "option upload-card" }, [
    el("div", { className: "label", text: option.label + (option.sku ? " (" + option.sku + ")" : "") }),
    el("div", { className: "label", text: "No photo yet" }),
    fileInput,
    button,
    errorText,
  ]);
}

function renderAddTileCard() {
  const codeInput = el("input", { type: "text", placeholder: "New code, e.g. WT14" });
  const nameInput = el("input", { type: "text", placeholder: "Material name" });
  const fileInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp" });
  const errorText = el("div", { className: "error" });
  const button = el("button", { text: "Add & select" });
  button.addEventListener("click", async () => {
    const code = codeInput.value.trim().toUpperCase();
    const materialName = nameInput.value.trim();
    const file = fileInput.files[0];
    if (!code || !materialName || !file) { errorText.textContent = "Code, name, and a file are all required."; return; }
    const boardId = activeBoardId;
    const slotId = activeSlotId;
    button.disabled = true;
    errorText.textContent = "";
    try {
      const dataBase64 = await fileToBase64(file);
      const response = await fetch("/api/upload-tile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardId: boardId, slotId: slotId, code: code, materialName: materialName, mimeType: file.type, dataBase64: dataBase64 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Upload failed");
      updateItemInPlan(boardId, data.item);
      closePicker();
      showStatus("Added tile " + code + " and selected it.");
    } catch (error) {
      errorText.textContent = error.message;
      button.disabled = false;
    }
  });
  return el("div", { className: "option upload-card" }, [
    el("div", { className: "label", text: "Add a new tile" }),
    codeInput,
    nameInput,
    fileInput,
    button,
    errorText,
  ]);
}

// Row-slot equivalent of "Add a new tile" — a brand-new fixture item that has
// no Smartsheet row at all, scoped to this board's room.
function renderAddCustomItemCard() {
  const nameInput = el("input", { type: "text", placeholder: "Item name" });
  const brandInput = el("input", { type: "text", placeholder: "Brand (optional)" });
  const notesInput = el("input", { type: "text", placeholder: "Notes (optional)" });
  const fileInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp" });
  const errorText = el("div", { className: "error" });
  const button = el("button", { text: "Add & select" });
  button.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const brand = brandInput.value.trim();
    const notes = notesInput.value.trim();
    const file = fileInput.files[0];
    if (!name || !file) { errorText.textContent = "Name and a file are required."; return; }
    const boardId = activeBoardId;
    const slotId = activeSlotId;
    button.disabled = true;
    errorText.textContent = "";
    try {
      const dataBase64 = await fileToBase64(file);
      const response = await fetch("/api/add-custom-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardId: boardId, slotId: slotId, name: name, brand: brand, notes: notes, mimeType: file.type, dataBase64: dataBase64 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Upload failed");
      updateItemInPlan(boardId, data.item);
      closePicker();
      showStatus("Added '" + name + "' and selected it.");
    } catch (error) {
      errorText.textContent = error.message;
      button.disabled = false;
    }
  });
  return el("div", { className: "option upload-card" }, [
    el("div", { className: "label", text: "Add a new item (not in the manifest)" }),
    nameInput,
    brandInput,
    notesInput,
    fileInput,
    button,
    errorText,
  ]);
}

function closePicker() {
  document.getElementById("modal-backdrop").style.display = "none";
  document.getElementById("modal").style.display = "none";
  activeBoardId = null;
  activeSlotId = null;
}

async function selectChoice(choice) {
  const boardId = activeBoardId;
  const slotId = activeSlotId;
  try {
    const response = await fetch("/api/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boardId: boardId, slotId: slotId, choice: choice }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Selection failed");
    updateItemInPlan(boardId, data.item);
    closePicker();
    showStatus("Saved \\u2014 " + slotId + " updated.");
  } catch (error) {
    showStatus(error.message, true);
  }
}

async function resetSlot(boardId, slotId) {
  try {
    const response = await fetch("/api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boardId: boardId, slotId: slotId }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Reset failed");
    updateItemInPlan(boardId, data.item);
    showStatus("Reset \\u2014 " + slotId + " back to its auto-pick.");
  } catch (error) {
    showStatus(error.message, true);
  }
}

async function removeSlotAction(boardId, slotId) {
  try {
    const response = await fetch("/api/remove-slot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boardId: boardId, slotId: slotId }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Remove failed");
    showStatus("Removed slot '" + slotId + "'.");
    await loadPlan();
  } catch (error) {
    showStatus(error.message, true);
  }
}

function updateItemInPlan(boardId, updatedItem) {
  const board = plan.boards.find((entry) => entry.id === boardId);
  const index = board.items.findIndex((entry) => entry.slotId === updatedItem.slotId);
  board.items[index] = updatedItem;
  const card = document.querySelector('.slot-card[data-board="' + boardId + '"][data-slot="' + updatedItem.slotId + '"]');
  card.replaceWith(renderSlotCard(board, updatedItem));
}

document.addEventListener("click", (event) => {
  const changeBtn = event.target.closest('[data-action="change"]');
  if (changeBtn) { openPicker(changeBtn.getAttribute("data-board"), changeBtn.getAttribute("data-slot")); return; }
  const resetBtn = event.target.closest('[data-action="reset"]');
  if (resetBtn) { resetSlot(resetBtn.getAttribute("data-board"), resetBtn.getAttribute("data-slot")); return; }
  const removeBtn = event.target.closest('[data-action="remove-slot"]');
  if (removeBtn) { removeSlotAction(removeBtn.getAttribute("data-board"), removeBtn.getAttribute("data-slot")); return; }
  const option = event.target.closest(".option");
  if (option) {
    const kind = option.getAttribute("data-kind");
    const choice = kind === "tile"
      ? { kind: "tile", code: option.getAttribute("data-code") }
      : { kind: "row", rowId: option.getAttribute("data-row-id") };
    selectChoice(choice);
    return;
  }
  if (event.target.id === "modal-close" || event.target.id === "modal-backdrop") closePicker();
});

async function postJson(route, body) {
  const response = await fetch(route, { method: "POST", body: JSON.stringify(body) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || ("HTTP " + response.status));
  return json;
}

function refreshPanel(boardId) {
  const board = plan.boards.find((entry) => entry.id === boardId);
  const existing = document.querySelector('.render-panel[data-board="' + boardId + '"]');
  if (!board || !existing) return;
  // Never yank the textarea out from under the user while they type.
  const active = document.activeElement;
  if (active && active.tagName === "TEXTAREA" && existing.contains(active)) return;
  existing.replaceWith(renderPanel(board));
}

function refreshQueueBadge() {
  const running = renderStatus.queue.find((job) => job.state === "running");
  const queued = renderStatus.queue.filter((job) => job.state === "queued").length;
  document.getElementById("queue-badge").textContent = running
    ? "Rendering: " + running.boardId + (queued ? " \\u00b7 " + queued + " queued" : "")
    : (queued ? queued + " queued" : "");
}

function applyRenderStatus(json) {
  const text = JSON.stringify(json);
  const changed = text !== lastRenderJson;
  lastRenderJson = text;
  renderStatus = json;
  refreshQueueBadge();
  plan.boards.forEach((board) => {
    const job = activeJob(board.id);
    if (changed || (job && job.state === "running")) refreshPanel(board.id);
  });
}

async function pollOnce() {
  const response = await fetch("/api/render-status");
  applyRenderStatus(await response.json());
}

async function pollRenderStatus() {
  try { await pollOnce(); } catch (error) { /* server unreachable mid-poll; next tick retries */ }
  const busy = renderStatus.queue.some((job) => job.state === "running" || job.state === "queued");
  setTimeout(pollRenderStatus, busy ? 2000 : 15000);
}

function openLightbox(boardId, kind, id) {
  const record = renderStatus.renders[boardId] || emptyRenders();
  const list = kind === "draft" ? record.drafts : kind === "confirm" ? record.confirmed : record.finals;
  lightboxList = list.map((entry) => ({ url: entry.url, caption: boardId + " \\u00b7 " + kind + " " + entry.id + " \\u00b7 variant " + entry.variant + (entry.instruction ? " \\u00b7 " + entry.instruction : "") }));
  lightboxIndex = Math.max(0, list.findIndex((entry) => entry.id === id));
  showLightbox();
}

function showLightbox() {
  const item = lightboxList[lightboxIndex];
  if (!item) return;
  document.getElementById("lightbox-img").src = item.url;
  document.getElementById("lightbox-caption").textContent = item.caption + "  (" + (lightboxIndex + 1) + "/" + lightboxList.length + ")";
  document.getElementById("lightbox").style.display = "flex";
}

function closeLightbox() { document.getElementById("lightbox").style.display = "none"; }

document.addEventListener("keydown", (event) => {
  if (document.getElementById("lightbox").style.display !== "flex") return;
  if (event.key === "Escape") closeLightbox();
  if (event.key === "ArrowRight" && lightboxIndex < lightboxList.length - 1) { lightboxIndex++; showLightbox(); }
  if (event.key === "ArrowLeft" && lightboxIndex > 0) { lightboxIndex--; showLightbox(); }
});

document.addEventListener("click", async (event) => {
  if (event.target.id === "lightbox" || event.target.id === "lightbox-img" || event.target.id === "lightbox-caption") { closeLightbox(); return; }
  const node = event.target.closest("[data-action]");
  if (!node) return;
  const action = node.getAttribute("data-action");
  const boardId = node.getAttribute("data-board");
  try {
    if (action === "variant") { prefsFor(boardId).variant = node.getAttribute("data-variant"); refreshPanel(boardId); }
    else if (action === "draft") {
      const prefs = prefsFor(boardId);
      const json = await postJson("/api/render", { boardId: boardId, kind: "draft", variant: prefs.variant, count: prefs.count });
      showStatus(json.accessError ? json.accessError : "Queued " + prefs.count + " draft(s) of " + prefs.variant, Boolean(json.accessError));
      await pollOnce();
    }
    else if (action === "confirm") { await postJson("/api/render", { boardId: boardId, kind: "confirm" }); showStatus("Queued confirm render"); await pollOnce(); }
    else if (action === "final") {
      const record = renderStatus.renders[boardId] || emptyRenders();
      const source = record.approvedConfirmedId ? "confirmed " + record.approvedConfirmedId : "draft " + record.pickedDraftId;
      if (!window.confirm("Render final at high quality, " + money("final", 1) + ", from " + source + "? It will appear in the site Library.")) return;
      await postJson("/api/render", { boardId: boardId, kind: "final" });
      showStatus("Queued final render");
      await pollOnce();
    }
    else if (action === "cancel") { await postJson("/api/render-cancel", { jobId: node.getAttribute("data-job") }); await pollOnce(); }
    else if (action === "pick-draft") { await postJson("/api/pick-draft", { boardId: boardId, draftId: node.getAttribute("data-id") }); await pollOnce(); }
    else if (action === "approve") { const id = node.getAttribute("data-id"); await postJson("/api/approve-confirmed", { boardId: boardId, confirmedId: id || null }); await pollOnce(); }
    else if (action === "lightbox") { openLightbox(boardId, node.getAttribute("data-kind"), node.getAttribute("data-id")); }
  } catch (error) {
    showStatus(error.message, true);
  }
});

document.addEventListener("change", (event) => {
  const node = event.target.closest("[data-action]");
  if (!node || node.getAttribute("data-action") !== "count") return;
  const boardId = node.getAttribute("data-board");
  prefsFor(boardId).count = Math.max(1, Math.min(10, Number(node.value) || 1));
  refreshPanel(boardId);
});

document.addEventListener("focusout", async (event) => {
  const node = event.target;
  if (!node || !node.getAttribute) return;
  const action = node.getAttribute("data-action");
  const boardId = node.getAttribute("data-board");
  try {
    if (action === "instruction") {
      await postJson("/api/instruction", { boardId: boardId, instruction: node.value });
      await pollOnce();
    } else if (action === "item-note") {
      const json = await postJson("/api/item-note", { boardId: boardId, slotId: node.getAttribute("data-slot"), note: node.value });
      const board = plan.boards.find((entry) => entry.id === boardId);
      const index = board.items.findIndex((entry) => entry.slotId === json.item.slotId);
      board.items[index] = json.item;
      await pollOnce();
    }
  } catch (error) {
    showStatus(error.message, true);
  }
});

loadPlan().then(() => pollRenderStatus());
</script>
</body>
</html>`;
}
