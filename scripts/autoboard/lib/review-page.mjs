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
  .upload-card .error { color: var(--danger); font-size: 0.7rem; }
  #status { position: fixed; bottom: 1rem; right: 1rem; background: #14532d; color: #fff; padding: 0.5rem 0.9rem; border-radius: 6px; font-size: 0.8rem; opacity: 0; transition: opacity 0.2s; z-index: 20; }
  #status.error { background: var(--danger); }
  #status.show { opacity: 1; }
</style>
</head>
<body>
<header>
  <h1 id="run-title">Autoboard Review</h1>
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
<div id="status"></div>

<script>
"use strict";
let plan = null;
let activeBoardId = null;
let activeSlotId = null;

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
  document.getElementById("run-title").textContent = "Autoboard Review — " + plan.runId;
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
  return el("section", { className: "board", id: "board-" + board.id }, [
    el("h2", { text: board.title }),
    el("div", { className: "meta", text: board.collageType + " \\u00b7 " + board.items.length + " slot(s)" }),
    slots,
  ]);
}

function renderSlotCard(board, item) {
  const image = item.images && item.images[0];
  const img = el("img", { src: image ? imageUrl(image) : "", alt: item.slotId });
  const body = el("div", { className: "body" }, [
    el("div", { className: "slot-id", text: item.slotId + (item.required ? "" : " (optional)") }),
    el("div", { className: "name", text: item.name || "(unnamed)" }),
    el("div", { className: "brand", text: item.brand || "" }),
  ]);
  if (item.overriddenAt) {
    body.appendChild(el("div", { className: "overridden", text: "manually changed" }));
    body.appendChild(el("button", { "data-action": "reset", "data-board": board.id, "data-slot": item.slotId, text: "Reset to auto-pick" }));
  }
  const actions = el("div", { className: "actions" }, [
    el("button", { "data-action": "change", "data-board": board.id, "data-slot": item.slotId, text: "Change" }),
  ]);
  body.appendChild(actions);
  const card = el("article", { className: "slot-card", "data-board": board.id, "data-slot": item.slotId }, [img, body]);
  return card;
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
    grid.appendChild(el("button", props, [
      el("img", { src: imageUrl(option.imagePath), alt: "" }),
      el("div", { className: "label", text: labelText }),
    ]));
  });
  if (data.slotKind === "tile") grid.appendChild(renderAddTileCard());
  if (!data.options.length && data.slotKind !== "tile") {
    grid.appendChild(el("p", { text: "No candidate items found in this room." }));
  }
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

loadPlan();
</script>
</body>
</html>`;
}
