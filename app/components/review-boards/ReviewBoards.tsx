"use client";

/**
 * ReviewBoards — /review-boards
 * -----------------------------
 * Point this at a project's Smartsheet, pick the subsection of items you want
 * a board for, and it stores the result as a project you can switch back to.
 *
 * What it shows is a PREVIEW, not a rendered board: every slot the sheet's rows
 * matched, and every slot still empty. Boards cannot actually be built until
 * their reference photos exist — buildBoards drops any item whose resolver
 * returns nothing — so this is the step that says which rows need a photo
 * before anything can be rendered.
 *
 * The rules are not reimplemented here. Slot matching, board identity and the
 * substitute hold-back all come from app/lib/autoboard, the same core the CLI
 * runs, so a board previewed here and a board planned on the operator's machine
 * agree by construction (docs/autoboard-shared-core.md).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { RouteReady } from "../RouteReady";
import { SiteNavigation } from "../SiteNavigation";
import { SlotPhotos, type ProjectPhoto } from "./SlotPhotos";
import { withoutBrandPrefix, type BoardRender, type BuiltBoard } from "./BoardWorkflow";
import { BoardDrawer } from "./BoardDrawer";
import { AddRowDialog } from "./AddRowDialog";
import { RowTools, type Pin } from "./RowTools";
import styles from "./review-boards.module.css";

type Facet = { value: string; rowCount: number };
type SheetFacets = { unitTypes: Facet[]; rooms: (Facet & { unitTypes: string[] })[] };

type PreviewSlot = {
  slotId: string;
  role: string;
  required: boolean;
  rowId: string;
  itemName: string;
  name: string;
  brand: string;
  sku: string;
  qty: number;
  reference: string;
  tier?: string;
  pinned?: boolean;
};

type PreviewBoard = {
  id: string;
  unitType: string;
  roomLabel: string;
  collageType: string;
  kindLabel: string;
  title: string;
  slots: PreviewSlot[];
  unfilledSlots: { slotId: string; role: string; required: boolean }[];
};

type RoomScope = { unitType: string; roomLabel: string };

type BoardsPreview = {
  boards: PreviewBoard[];
  rooms: RoomScope[];
  substitutes: (RoomScope & { slotId: string; collageType: string; rowId: string; itemName: string })[];
  conflicts: (RoomScope & {
    slotId: string;
    collageType: string;
    picked: { itemName: string };
    alternates: { itemName: string }[];
  })[];
  unmapped: (RoomScope & { rowId: string; itemName: string; costCode: string })[];
  skippedRooms: (RoomScope & { itemCount: number })[];
  skippedRoomItems: (RoomScope & { rowId: string; itemName: string; costCode: string })[];
};

type Project = {
  id: string;
  name: string;
  sheetId: string;
  source: string;
  filter: { unitTypes?: string[]; rooms?: string[] };
  rowCount: number;
  boardCount: number;
  createdAt: number;
  updatedAt: number;
};

// A row as it was when removed: enough to name it in the Removed list and to
// restore it, whatever the sheet has said since.
type RemovedRow = { rowId: string; itemName: string; unitType: string; roomLabel: string; sku: string };

// A board as it was when removed: enough to name it in the Removed list.
type RemovedBoard = { id: string; title: string; unitType: string; roomLabel: string; kindLabel: string };

// The reviewer's edits on top of the sheet's rows (app/lib/autoboard/row-edits.ts).
type ProjectEdits = {
  removed: RemovedRow[];
  removedBoards: RemovedBoard[];
  pins: Record<string, Pin>;
  manualRowIds: string[];
};

type ProjectDetail = Project & { preview: BoardsPreview; edits: ProjectEdits };

// The boards that actually exist: buildBoards run over the photos a person
// selected. A row with no selected photo yields no images, so its slot is empty
// here and recorded in built.gaps — the same thing that happens on the CLI when
// a library folder is empty.
type Built = { boards: BuiltBoard[]; gaps: { imagelessItems: { slotId: string; itemName: string }[] } };

type View = "slots" | "boards";

const JSON_HEADERS = { "content-type": "application/json" };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = (await response.json().catch(() => null)) as
    | ({ ok: boolean; error?: string } & Record<string, unknown>)
    | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error ?? `Request failed with HTTP ${response.status}.`);
  }
  return payload as T;
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function ReviewBoards() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [built, setBuilt] = useState<Built | null>(null);
  const [photos, setPhotos] = useState<ProjectPhoto[]>([]);
  const [renders, setRenders] = useState<BoardRender[]>([]);
  const [view, setView] = useState<View>("slots");

  const [sheetId, setSheetId] = useState("");
  const [name, setName] = useState("");
  const [facets, setFacets] = useState<SheetFacets | null>(null);
  const [unitTypes, setUnitTypes] = useState<string[]>([]);
  const [rooms, setRooms] = useState<string[]>([]);
  const [selectedRowCount, setSelectedRowCount] = useState<number | null>(null);

  const [busy, setBusy] = useState<"" | "reading" | "building" | "refreshing" | "deleting" | "creating" | "editing">("");
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [blankName, setBlankName] = useState("");

  const loadProjects = useCallback(async () => {
    const payload = await api<{ projects: Project[] }>("/api/autoboard/projects");
    setProjects(payload.projects);
    return payload.projects;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await loadProjects();
        if (!cancelled) setActiveId((current) => current ?? list[0]?.id ?? null);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadProjects]);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [payload, photoPayload, renderPayload] = await Promise.all([
          api<{ project: ProjectDetail; built: Built }>(`/api/autoboard/projects/${encodeURIComponent(activeId)}`),
          api<{ photos: ProjectPhoto[] }>(`/api/autoboard/projects/${encodeURIComponent(activeId)}/photos`),
          api<{ renders: BoardRender[] }>(`/api/autoboard/projects/${encodeURIComponent(activeId)}/renders`),
        ]);
        if (!cancelled) {
          setDetail(payload.project);
          setBuilt(payload.built);
          setPhotos(photoPayload.photos);
          setRenders(renderPayload.renders);
        }
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // Derived rather than cleared in an effect: while a switch is in flight the
  // previous project's boards must not sit under the new project's name.
  const shown = detail && detail.id === activeId ? detail : null;

  // Reading the sheet and building from it are separate on purpose: the read
  // is what makes the unit types and rooms pickable at all, and seeing the
  // slot count for a choice before storing it is the difference between one
  // project and four abandoned ones.
  const readSheet = useCallback(async () => {
    setBusy("reading");
    setError("");
    try {
      const payload = await api<{ facets: SheetFacets; selectedRowCount: number; preview: BoardsPreview }>(
        "/api/autoboard/sheet",
        { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sheetId, unitTypes, rooms }) },
      );
      setFacets(payload.facets);
      setSelectedRowCount(payload.selectedRowCount);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  }, [sheetId, unitTypes, rooms]);

  const build = useCallback(async () => {
    setBusy("building");
    setError("");
    try {
      const payload = await api<{ project: ProjectDetail }>("/api/autoboard/projects", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name, sheetId, unitTypes, rooms }),
      });
      await loadProjects();
      setActiveId(payload.project.id);
      setFacets(null);
      setSelectedRowCount(null);
      setName("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  }, [name, sheetId, unitTypes, rooms, loadProjects]);

  const refresh = useCallback(async () => {
    if (!activeId) return;
    setBusy("refreshing");
    setError("");
    try {
      const payload = await api<{ project: ProjectDetail }>(
        `/api/autoboard/projects/${encodeURIComponent(activeId)}`,
        { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ action: "refresh" }) },
      );
      setDetail(payload.project);
      await loadProjects();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  }, [activeId, loadProjects]);

  const remove = useCallback(async () => {
    if (!activeId) return;
    setBusy("deleting");
    setError("");
    try {
      await api(`/api/autoboard/projects/${encodeURIComponent(activeId)}`, { method: "DELETE" });
      const list = await loadProjects();
      setActiveId(list[0]?.id ?? null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  }, [activeId, loadProjects]);

  const reloadPhotos = useCallback(async () => {
    if (!activeId) return;
    const [payload, photoPayload, renderPayload] = await Promise.all([
      api<{ project: ProjectDetail; built: Built }>(`/api/autoboard/projects/${encodeURIComponent(activeId)}`),
      api<{ photos: ProjectPhoto[] }>(`/api/autoboard/projects/${encodeURIComponent(activeId)}/photos`),
      api<{ renders: BoardRender[] }>(`/api/autoboard/projects/${encodeURIComponent(activeId)}/renders`),
    ]);
    setDetail(payload.project);
    setBuilt(payload.built);
    setPhotos(photoPayload.photos);
    setRenders(renderPayload.renders);
  }, [activeId]);

  const createBlank = useCallback(async () => {
    setBusy("creating");
    setError("");
    try {
      const payload = await api<{ project: ProjectDetail }>("/api/autoboard/projects", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: blankName, blank: true }),
      });
      await loadProjects();
      setActiveId(payload.project.id);
      setBlankName("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  }, [blankName, loadProjects]);

  // One row's edits — pin, remove, restore — then everything derived from the
  // rows is fetched again: a pin moves a slot, and a removal changes the built
  // boards as well as the preview and the project's row count.
  const patchRow = useCallback(
    async (rowId: string, patch: { excluded?: boolean; pin?: Pin | null }) => {
      if (!activeId) return;
      setBusy("editing");
      setError("");
      try {
        await api(`/api/autoboard/projects/${encodeURIComponent(activeId)}/rows/${encodeURIComponent(rowId)}`, {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify(patch),
        });
        await reloadPhotos();
        await loadProjects();
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        setBusy("");
      }
    },
    [activeId, reloadPhotos, loadProjects],
  );
  const pinRow = useCallback((rowId: string, pin: Pin | null) => patchRow(rowId, { pin }), [patchRow]);
  const removeRow = useCallback((rowId: string) => patchRow(rowId, { excluded: true }), [patchRow]);
  const restoreRow = useCallback((rowId: string) => patchRow(rowId, { excluded: false }), [patchRow]);

  // A board's own removal — the whole board's card disappears from both
  // views, rows and all — as distinct from removing one of its rows.
  const patchBoard = useCallback(
    async (boardId: string, excluded: boolean) => {
      if (!activeId) return;
      setBusy("editing");
      setError("");
      try {
        await api(`/api/autoboard/projects/${encodeURIComponent(activeId)}/boards/${encodeURIComponent(boardId)}`, {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ excluded }),
        });
        await reloadPhotos();
        await loadProjects();
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        setBusy("");
      }
    },
    [activeId, reloadPhotos, loadProjects],
  );
  const removeBoard = useCallback((boardId: string) => patchBoard(boardId, true), [patchBoard]);
  const restoreBoard = useCallback((boardId: string) => patchBoard(boardId, false), [patchBoard]);

  const onRowAdded = useCallback(async () => {
    await reloadPhotos();
    await loadProjects();
  }, [reloadPhotos, loadProjects]);

  const photosByRow = useMemo(() => {
    const map = new Map<string, ProjectPhoto[]>();
    for (const photo of photos) {
      const list = map.get(photo.rowId) ?? [];
      list.push(photo);
      map.set(photo.rowId, list);
    }
    return map;
  }, [photos]);

  const tally = useMemo(() => {
    if (!shown) return null;
    return {
      slots: shown.preview.boards.reduce((sum, board) => sum + board.slots.length, 0),
      openSlots: shown.preview.boards.reduce((sum, board) => sum + board.unfilledSlots.length, 0),
      withPhoto: shown.preview.boards.reduce(
        (sum, board) =>
          sum + board.slots.filter((slot) => (photosByRow.get(slot.rowId) ?? []).some((p) => p.status === "selected")).length,
        0,
      ),
    };
  }, [shown, photosByRow]);

  return (
    <div className={styles.page}>
      <RouteReady path="/review-boards" />
      <SiteNavigation active={null} />

      <div className={`${styles.shell} ${view === "boards" ? styles.shellWide : ""}`}>
        <aside className={styles.rail} aria-label="Stored projects">
          <div className={styles.railHead}>
            <h2 className={styles.railTitle}>Projects</h2>
            <span className={styles.count}>{projects.length}</span>
          </div>

          {projects.length === 0 ? (
            <p className={styles.empty}>
              No projects stored yet. Read a sheet below to build the first one.
            </p>
          ) : (
            <ul className={styles.projectList}>
              {projects.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    className={styles.projectButton}
                    aria-current={project.id === activeId}
                    onClick={() => setActiveId(project.id)}
                  >
                    <span className={styles.projectName}>{project.name}</span>
                    <span className={styles.projectMeta}>
                      {project.boardCount} boards · {project.rowCount} rows · {formatDate(project.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <section className={styles.builder} aria-label="Build a project from a sheet">
            <h2 className={styles.builderTitle}>Build from a sheet</h2>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="sheet-id">
                Smartsheet id
              </label>
              <input
                id="sheet-id"
                className={styles.input}
                value={sheetId}
                inputMode="numeric"
                placeholder="6391628162879364"
                onChange={(event) => {
                  setSheetId(event.target.value);
                  setFacets(null);
                  setSelectedRowCount(null);
                }}
              />
              <p className={styles.help}>
                The numeric id from the sheet&rsquo;s Properties panel, not its URL.
              </p>
            </div>

            {facets ? (
              <>
                <div className={styles.field}>
                  <span className={styles.label} id="unit-types-label">
                    Unit types
                  </span>
                  <div className={styles.chips} role="group" aria-labelledby="unit-types-label">
                    {facets.unitTypes.map((facet) => (
                      <button
                        key={facet.value}
                        type="button"
                        className={styles.chip}
                        aria-pressed={unitTypes.includes(facet.value)}
                        onClick={() => setUnitTypes((current) => toggle(current, facet.value))}
                      >
                        {facet.value}
                        <span className={styles.chipCount}>{facet.rowCount}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.field}>
                  <span className={styles.label} id="rooms-label">
                    Rooms
                  </span>
                  <div className={styles.chips} role="group" aria-labelledby="rooms-label">
                    {facets.rooms.map((facet) => (
                      <button
                        key={facet.value}
                        type="button"
                        className={styles.chip}
                        aria-pressed={rooms.includes(facet.value)}
                        onClick={() => setRooms((current) => toggle(current, facet.value))}
                      >
                        {facet.value}
                        <span className={styles.chipCount}>{facet.rowCount}</span>
                      </button>
                    ))}
                  </div>
                  <p className={styles.help}>
                    {unitTypes.length === 0 && rooms.length === 0
                      ? "Nothing selected means the whole sheet."
                      : `${selectedRowCount ?? 0} rows selected. Read again to recount.`}
                  </p>
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor="project-name">
                    Project name
                  </label>
                  <input
                    id="project-name"
                    className={styles.input}
                    value={name}
                    placeholder="651 Belmont — Penthouse"
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
              </>
            ) : null}

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                onClick={readSheet}
                disabled={!sheetId.trim() || busy !== ""}
              >
                {busy === "reading" ? "Reading…" : facets ? "Read again" : "Read sheet"}
              </button>
              {facets ? (
                <button type="button" className={styles.primary} onClick={build} disabled={busy !== ""}>
                  {busy === "building" ? "Building…" : "Build project"}
                </button>
              ) : null}
            </div>

            {error ? (
              <p className={styles.notice} role="alert">
                {error}
              </p>
            ) : null}
          </section>

          <section className={styles.builder} aria-label="Start a blank project">
            <h2 className={styles.builderTitle}>Start blank</h2>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="blank-name">
                Project name
              </label>
              <input
                id="blank-name"
                className={styles.input}
                value={blankName}
                placeholder="Client sample kit"
                onChange={(event) => setBlankName(event.target.value)}
              />
              <p className={styles.help}>
                No sheet behind it. Add items one at a time with Add item; they are stored with the project.
              </p>
            </div>
            <div className={styles.actions}>
              <button type="button" className={styles.secondary} onClick={createBlank} disabled={busy !== ""}>
                {busy === "creating" ? "Creating…" : "New blank project"}
              </button>
            </div>
          </section>
        </aside>

        <main className={styles.main}>
          {shown ? (
            <>
              <div className={styles.mainHead}>
                <div>
                  <h1 className={styles.mainTitle}>{shown.name}</h1>
                  <p className={styles.source}>{shown.source}</p>
                </div>
                <div className={styles.actions}>
                  <button type="button" className={styles.secondary} onClick={() => setAdding(true)} disabled={busy !== ""}>
                    Add item
                  </button>
                  {shown.sheetId ? (
                    <button type="button" className={styles.secondary} onClick={refresh} disabled={busy !== ""}>
                      {busy === "refreshing" ? "Re-reading…" : "Re-read sheet"}
                    </button>
                  ) : null}
                  <button type="button" className={styles.quiet} onClick={remove} disabled={busy !== ""}>
                    Delete
                  </button>
                </div>
              </div>

              {tally ? (
                <div className={styles.tally}>
                  <div className={styles.tallyItem}>
                    <span className={styles.tallyValue}>{shown.preview.boards.length}</span>
                    <span className={styles.tallyLabel}>Boards</span>
                  </div>
                  <div className={styles.tallyItem}>
                    <span className={styles.tallyValue}>{tally.slots}</span>
                    <span className={styles.tallyLabel}>Slots filled</span>
                  </div>
                  <div className={styles.tallyItem}>
                    <span className={styles.tallyValue}>{tally.openSlots}</span>
                    <span className={styles.tallyLabel}>Slots open</span>
                  </div>
                  <div className={styles.tallyItem}>
                    <span className={styles.tallyValue}>{tally.withPhoto}</span>
                    <span className={styles.tallyLabel}>Photos chosen</span>
                  </div>
                  <div className={styles.tallyItem}>
                    <span className={styles.tallyValue}>{built?.boards.length ?? 0}</span>
                    <span className={styles.tallyLabel}>Boards built</span>
                  </div>
                </div>
              ) : null}

              <div className={styles.views} role="tablist" aria-label="What to show">
                {(["slots", "boards"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    className={styles.viewTab}
                    aria-selected={view === key}
                    onClick={() => setView(key)}
                  >
                    {key === "slots" ? "Slots & photos" : `Built boards (${built?.boards.length ?? 0})`}
                  </button>
                ))}
              </div>

              {view === "boards" ? (
                <BuiltBoards
                  built={built}
                  projectId={shown.id}
                  renders={renders}
                  onSaved={reloadPhotos}
                  onRemoveRow={removeRow}
                  onRemoveBoard={removeBoard}
                />
              ) : (
              <div className={styles.boards}>
                {shown.preview.boards.map((board) => (
                  <article key={board.id} className={styles.board}>
                    <header className={styles.boardHead}>
                      <div className={styles.boardHeadRow}>
                        <span className={styles.boardRoom}>
                          {board.unitType} · {board.roomLabel}
                        </span>
                        <button
                          type="button"
                          className={styles.photoAction}
                          disabled={busy !== ""}
                          onClick={() => void removeBoard(board.id)}
                        >
                          Remove board
                        </button>
                      </div>
                      <span className={styles.boardKind}>{board.kindLabel}</span>
                      <span className={styles.boardFill}>
                        {board.slots.length} of {board.slots.length + board.unfilledSlots.length} slots
                      </span>
                    </header>

                    <ul className={styles.slots}>
                      {board.slots.map((slot) => {
                        const rowPhotos = photosByRow.get(slot.rowId) ?? [];
                        const chosen = rowPhotos.some((photo) => photo.status === "selected");
                        return (
                        <li key={slot.slotId} className={styles.slot}>
                          <span
                            className={`${styles.dot} ${chosen ? styles.dotFilled : styles.dotNeedsPhoto}`}
                            aria-hidden="true"
                          />
                          <span className={styles.slotBody}>
                            <span className={styles.slotName}>
                              <span className={styles.visuallyHidden}>Filled: </span>
                              {slot.brand ? <strong>{slot.brand}</strong> : null}
                              {slot.brand ? " " : ""}
                              {withoutBrandPrefix(slot.name, slot.brand)}
                              {slot.tier ? <span className={styles.tier}>{slot.tier}</span> : null}
                            </span>
                            <span className={styles.slotMeta}>
                              <span className={styles.visuallyHidden}>
                                {chosen ? "photo chosen. " : "no photo yet. "}
                              </span>
                              {slot.slotId}
                              {slot.sku ? ` · ${slot.sku}` : ""}
                              {slot.qty > 1 ? ` · qty ${slot.qty}` : ""}
                              {slot.pinned ? <span className={styles.pinTag}>· pinned</span> : null}
                              {shown.edits.manualRowIds.includes(slot.rowId) ? (
                                <span className={styles.pinTag}>· added by hand</span>
                              ) : null}
                            </span>
                            <RowTools
                              rowId={slot.rowId}
                              roomLabel={board.roomLabel}
                              pin={shown.edits.pins[slot.rowId]}
                              busy={busy !== ""}
                              onPin={pinRow}
                              onRemove={removeRow}
                            />
                            <SlotPhotos
                              projectId={shown.id}
                              rowId={slot.rowId}
                              itemName={slot.name}
                              reference={slot.reference}
                              photos={rowPhotos}
                              onChanged={reloadPhotos}
                            />
                          </span>
                        </li>
                        );
                      })}

                      {board.unfilledSlots.map((slot) => (
                        <li key={slot.slotId} className={styles.slot}>
                          <span
                            className={`${styles.dot} ${slot.required ? styles.dotRequired : styles.dotOptional}`}
                            aria-hidden="true"
                          />
                          <span className={styles.slotBody}>
                            <span className={`${styles.slotName} ${styles.slotNameEmpty}`}>
                              <span className={styles.visuallyHidden}>
                                {slot.required ? "Required, still empty: " : "Optional, still empty: "}
                              </span>
                              {slot.role}
                            </span>
                            <span className={styles.slotMeta}>
                              {slot.slotId} · {slot.required ? "required" : "optional"}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
              )}

              <GapsSection
                preview={shown.preview}
                edits={shown.edits}
                busy={busy !== ""}
                onPin={pinRow}
                onRemove={removeRow}
                onRestore={restoreRow}
                onRestoreBoard={restoreBoard}
              />

              <AddRowDialog
                projectId={shown.id}
                open={adding}
                onlyUnitType={shown.filter.unitTypes?.length === 1 ? shown.filter.unitTypes[0] : ""}
                onlyRoom={shown.filter.rooms?.length === 1 ? shown.filter.rooms[0] : ""}
                onClose={() => setAdding(false)}
                onAdded={onRowAdded}
              />
            </>
          ) : (
            <p className={styles.placeholder}>
              {projects.length === 0
                ? "Read a sheet to build your first review board."
                : "Pick a project to see its boards."}
            </p>
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * Everything the rules could not place, stated rather than hidden. This mirrors
 * the CLI's gaps.md: a board that looks complete while rows quietly went
 * missing is the failure mode the whole pipeline is built to avoid.
 */
function GapsSection({
  preview,
  edits,
  busy,
  onPin,
  onRemove,
  onRestore,
  onRestoreBoard,
}: {
  preview: BoardsPreview;
  edits: ProjectEdits;
  busy: boolean;
  onPin: (rowId: string, pin: Pin | null) => Promise<void>;
  onRemove: (rowId: string) => Promise<void>;
  onRestore: (rowId: string) => Promise<void>;
  onRestoreBoard: (boardId: string) => Promise<void>;
}) {
  const { substitutes, unmapped, skippedRooms, skippedRoomItems, conflicts } = preview;
  const removed = edits.removed;
  const removedBoards = edits.removedBoards;
  if (
    !substitutes.length &&
    !unmapped.length &&
    !skippedRooms.length &&
    !skippedRoomItems.length &&
    !conflicts.length &&
    !removed.length &&
    !removedBoards.length
  ) {
    return null;
  }

  return (
    <section className={styles.gaps} aria-label="Rows the rules could not place">
      <h2 className={styles.gapsTitle}>Not placed</h2>
      <p className={styles.gapsIntro}>
        Every row the rules could not put on a board, and why. Nothing here is an error on its own — a
        substitute is held back deliberately, and an unmapped row may simply not belong on a presentation
        board. Pin a row to put it on a slot anyway; Remove takes it off every board until restored.
      </p>

      {removedBoards.length ? (
        <div className={styles.gapGroup}>
          <h3 className={styles.gapHead}>Removed boards ({removedBoards.length})</h3>
          <ul className={styles.gapList}>
            {removedBoards.map((entry) => (
              <li key={entry.id} className={styles.gapItem}>
                {entry.title}{" "}
                <span className={styles.gapWhere}>
                  {entry.unitType} {entry.roomLabel} · {entry.kindLabel}
                </span>
                <span className={styles.gapTools}>
                  <button type="button" className={styles.photoAction} disabled={busy} onClick={() => void onRestoreBoard(entry.id)}>
                    Restore
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {removed.length ? (
        <div className={styles.gapGroup}>
          <h3 className={styles.gapHead}>Removed from every board ({removed.length})</h3>
          <ul className={styles.gapList}>
            {removed.map((entry) => (
              <li key={entry.rowId} className={styles.gapItem}>
                {entry.itemName}{" "}
                <span className={styles.gapWhere}>
                  {entry.unitType} {entry.roomLabel}
                  {entry.sku ? ` · ${entry.sku}` : ""}
                </span>
                <span className={styles.gapTools}>
                  <button type="button" className={styles.photoAction} disabled={busy} onClick={() => void onRestore(entry.rowId)}>
                    Restore
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {substitutes.length ? (
        <div className={styles.gapGroup}>
          <h3 className={styles.gapHead}>Substitutes held back from a slot ({substitutes.length})</h3>
          <ul className={styles.gapList}>
            {substitutes.map((entry) => (
              <li key={`${entry.rowId}-${entry.collageType}-${entry.slotId}`} className={styles.gapItem}>
                {entry.itemName}{" "}
                <span className={styles.gapWhere}>
                  {entry.unitType} {entry.roomLabel} · {entry.slotId}
                </span>
                <RowTools
                  rowId={entry.rowId}
                  roomLabel={entry.roomLabel}
                  pin={edits.pins[entry.rowId]}
                  busy={busy}
                  onPin={onPin}
                  onRemove={onRemove}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {conflicts.length ? (
        <div className={styles.gapGroup}>
          <h3 className={styles.gapHead}>Slots more than one row matched ({conflicts.length})</h3>
          <ul className={styles.gapList}>
            {conflicts.map((entry) => (
              <li key={`${entry.unitType}-${entry.roomLabel}-${entry.collageType}-${entry.slotId}`} className={styles.gapItem}>
                {entry.picked.itemName} won{" "}
                <span className={styles.gapWhere}>
                  {entry.slotId} · over {entry.alternates.map((alternate) => alternate.itemName).join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {unmapped.length ? (
        <div className={styles.gapGroup}>
          <h3 className={styles.gapHead}>Rows that matched no slot ({unmapped.length})</h3>
          <ul className={styles.gapList}>
            {unmapped.map((entry) => (
              <li key={entry.rowId} className={styles.gapItem}>
                {entry.itemName}{" "}
                <span className={styles.gapWhere}>
                  {entry.unitType} {entry.roomLabel} · {entry.costCode}
                </span>
                <RowTools
                  rowId={entry.rowId}
                  roomLabel={entry.roomLabel}
                  pin={edits.pins[entry.rowId]}
                  busy={busy}
                  onPin={onPin}
                  onRemove={onRemove}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {skippedRooms.length ? (
        <div className={styles.gapGroup}>
          <h3 className={styles.gapHead}>Rooms no board type maps to ({skippedRooms.length})</h3>
          <ul className={styles.gapList}>
            {skippedRooms.map((entry) => (
              <li key={`${entry.unitType}-${entry.roomLabel}`} className={styles.gapItem}>
                {entry.roomLabel}{" "}
                <span className={styles.gapWhere}>
                  {entry.unitType} · {entry.itemCount} rows
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {skippedRoomItems.length ? (
        <div className={styles.gapGroup}>
          <h3 className={styles.gapHead}>Rows in those rooms, individually ({skippedRoomItems.length})</h3>
          <p className={styles.help}>
            None of these rooms has a board of its own, so nothing here is a slot the rules missed — but a light
            fixture in a living room, dining room, or foyer belongs on the unit&rsquo;s lighting board. Pin one
            there, or remove it if it genuinely has no board.
          </p>
          <ul className={styles.gapList}>
            {skippedRoomItems.map((entry) => (
              <li key={entry.rowId} className={styles.gapItem}>
                {entry.itemName}{" "}
                <span className={styles.gapWhere}>
                  {entry.unitType} {entry.roomLabel}
                  {entry.costCode ? ` · ${entry.costCode}` : ""}
                </span>
                <RowTools
                  rowId={entry.rowId}
                  roomLabel={entry.roomLabel}
                  pin={edits.pins[entry.rowId]}
                  busy={busy}
                  onPin={onPin}
                  onRemove={onRemove}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The boards as they actually stand — buildBoards run over the selected photos.
 *
 * Empty until something is selected, and that emptiness is the honest state: a
 * board is a set of reference images, and until a person picks them there is no
 * board, only a plan for one.
 *
 * Utilitarian on purpose: a card shows only its own reference photos — no item
 * names, no slot list, no controls — so a wall of boards stays scannable by
 * sight. Everything else (settings, items, the render preview and its
 * dithering, same as the generator page) lives behind the card, in the drawer
 * that opens beside it.
 */
function BuiltBoards({
  built,
  projectId,
  renders,
  onSaved,
  onRemoveRow,
  onRemoveBoard,
}: {
  built: Built | null;
  projectId: string;
  renders: BoardRender[];
  onSaved: () => Promise<void>;
  onRemoveRow: (rowId: string) => Promise<void>;
  onRemoveBoard: (boardId: string) => Promise<void>;
}) {
  const [openBoardId, setOpenBoardId] = useState<string | null>(null);

  if (!built || !built.boards.length) {
    return (
      <p className={styles.placeholder}>
        No board has enough chosen photos yet. Pick a photo for at least two slots in a room and its board
        appears here.
      </p>
    );
  }

  const openBoard = built.boards.find((board) => board.id === openBoardId) ?? null;

  return (
    <>
      <div className={styles.builtBoardGrid}>
        {built.boards.map((board) => {
          const images = board.items.map((item) => item.images[0]).filter(Boolean).slice(0, 6);
          return (
            <button
              key={board.id}
              type="button"
              className={styles.builtBoardCard}
              onClick={() => setOpenBoardId(board.id)}
            >
              <span className={styles.builtBoardMosaic} data-count={Math.min(images.length, 6) || 1}>
                {images.length ? (
                  images.map((src, index) => (
                    // eslint-disable-next-line @next/next/no-img-element -- see SlotPhotos
                    <img key={`${board.id}-${index}`} src={src} alt="" loading="lazy" />
                  ))
                ) : (
                  <span className={styles.previewEmpty}>No photos yet</span>
                )}
              </span>
              <span className={styles.builtBoardCaption}>
                {board.unitType} · {board.roomLabel}
                <strong>{board.kindLabel}</strong>
              </span>
            </button>
          );
        })}
      </div>

      <BoardDrawer
        projectId={projectId}
        board={openBoard}
        renders={openBoard ? renders.filter((render) => render.boardId === openBoard.id) : []}
        onSaved={onSaved}
        onRemoveRow={onRemoveRow}
        onRemoveBoard={async (boardId) => {
          // The board this drawer shows is about to stop existing — close
          // before the removal lands rather than after, so the drawer never
          // sits open on a board no longer in the project.
          setOpenBoardId(null);
          await onRemoveBoard(boardId);
        }}
        onClose={() => setOpenBoardId(null)}
      />
    </>
  );
}
