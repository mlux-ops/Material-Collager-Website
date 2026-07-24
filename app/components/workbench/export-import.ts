// Self-contained JSON export/import (AC18). Framework-free at module scope
// (no JSX, no "@/" aliases, relative runtime imports carry explicit .ts
// extensions) so Node's --experimental-strip-types unit tests can import
// validateImport directly: it is a PURE function (no blob-cache reads/writes,
// no DOM), which is what makes it independently testable. materializeImport
// and the export builders below it DO touch blob-cache/DOM (mirroring the
// codebase's manifest-vs-.tsx split of pure core + DOM wrapper) and are only
// exercised by the browser, never the Node test target.
//
// SECURITY MODEL: an imported file is hostile input. validateImport NEVER
// reuses persistence.ts's loadGraph merge (`{...defaultParams, ...stored}`)
// -- every node kind, every param key, and every embedded image is checked
// against an explicit allowlist before anything is trusted:
//   - NodeKind allowlist: NODE_KINDS (registry-derived from manifests.ts).
//   - Per-kind param KEY allowlist: each manifest's own importSchema
//     (registry-derived via manifests.ts's importSchemaMap) -- a key not
//     declared by the node's own manifest is dropped, never merged in raw.
//   - __proto__/constructor/prototype: stripped recursively, everywhere,
//     before anything else touches the parsed JSON (stripDangerousKeys never
//     assigns through those keys, so the setter on Object.prototype is never
//     invoked even for a literal "__proto__" own-property from JSON.parse).
//   - MIME allowlist png/jpeg/webp: enforced by sniffing the DECODED BYTES'
//     magic numbers, not the data URL's declared `image/xxx` label (a label
//     can lie) -- so mislabeled SVG/HTML/anything-else is rejected outright,
//     and non-`data:` strings (javascript:, remote http(s) URLs, ...) never
//     even reach the decoder.
//   - Per-image + total decoded-byte caps, node/edge count caps: enforced
//     unconditionally, independent of what the file claims about itself.
//   - Blob-key ownership: a node only ever imports images from ITS OWN
//     exported key namespace (`${oldNodeId}:...`), remapped to its freshly
//     minted id -- a params field or references item can't "point at" some
//     other node's or an unrelated string's image data.

import type { Edge } from "@xyflow/react";
import { blobToDataUrl, getBlob, putBlob } from "./blob-cache.ts";
import { buildPhotoRun, PHOTO_SOURCE_KEY, sourceBlobKeysForNode } from "./persistence.ts";
import { defaultParams, importSchemaMap, NODE_KINDS, specFor } from "./nodes/manifests.ts";
// acceptedKindsFor is a real (value) import, so unlike the type-only imports
// elsewhere in this file, this one needs the explicit .ts extension for
// Node's --experimental-strip-types loader to resolve it at runtime.
import {
  acceptedKindsFor,
  type ImportParamRule,
  type NodeKind,
  type ReferenceItem,
  type WorkbenchNode,
  type WorkbenchParams,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

export const EXPORT_FORMAT = "material-collager-workbench" as const;
export const EXPORT_VERSION = 1 as const;

export const MAX_IMPORT_NODES = 300;
export const MAX_IMPORT_EDGES = 1000;
// Mirrors the host's existing <=50MB/image reference-route constraint.
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
// Bounds total decoded image bytes materialized from one import file,
// independent of what the file itself claims about its own size.
export const MAX_TOTAL_IMPORT_IMAGE_BYTES = 300 * 1024 * 1024;
// Export-side "this file is getting large" warning threshold (pre-encode
// estimate, not the base64-inflated final size).
export const EXPORT_SIZE_WARN_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Exported-file shape
// ---------------------------------------------------------------------------

export type ExportedNode = {
  id: string;
  kind: string;
  position: { x: number; y: number };
  params: Record<string, unknown>;
};

export type ExportedEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
};

export type ExportedGraph = {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: number;
  graphOnly: boolean;
  nodes: ExportedNode[];
  edges: ExportedEdge[];
  // Raw (pre-remap) blob-cache key -> data URL. Empty in graph-only exports.
  images: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Sanitization: proto-pollution stripping (applies before ANYTHING else reads
// the parsed JSON).
// ---------------------------------------------------------------------------

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Rebuilds parsed JSON into fresh plain objects/arrays, dropping
// __proto__/constructor/prototype keys at every nesting level. Always
// allocates a brand-new `{}` and assigns through an explicit allowlist check
// -- it never spreads/Object.assigns the untrusted object directly, which is
// the step that would actually invoke Object.prototype's `__proto__` setter
// for a literal "__proto__" own-property coming out of JSON.parse.
export function stripDangerousKeys(value: unknown, depth = 0): unknown {
  if (depth > 16) return null; // guards against pathological nesting depth
  if (Array.isArray(value)) return value.map((entry) => stripDangerousKeys(entry, depth + 1));
  if (!isPlainRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    out[key] = stripDangerousKeys(value[key], depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Image decoding: strict data-URL parsing + real magic-byte sniffing (the
// declared `image/xxx` label is never trusted on its own -- a mislabeled SVG
// or arbitrary payload is rejected because its BYTES don't match).
// ---------------------------------------------------------------------------

const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,([a-z0-9+/=]+)$/i;

function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

export type SniffedImageFormat = "png" | "jpeg" | "webp";

export function sniffImageFormat(bytes: Uint8Array): SniffedImageFormat | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "webp";
  return null; // includes SVG (XML text), HTML, or anything else -- rejected
}

export type DecodedImage = { bytes: Uint8Array; mimeType: string };

// Rejects anything that isn't a strict `data:image/(png|jpeg|webp);base64,...`
// string outright (so `data:image/svg+xml;...`, `javascript:...`, and remote
// `http(s)://...` URLs never even reach the decoder), then verifies the
// decoded bytes' magic number matches an allowed format regardless of what
// the data URL's own label claimed.
export function decodeImageDataUrl(value: unknown): DecodedImage | null {
  if (typeof value !== "string") return null;
  const match = DATA_URL_RE.exec(value.trim());
  if (!match) return null;
  const bytes = base64ToBytes(match[2]);
  if (!bytes) return null;
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
  const sniffed = sniffImageFormat(bytes);
  if (!sniffed) return null;
  return { bytes, mimeType: `image/${sniffed}` };
}

// ---------------------------------------------------------------------------
// Pure validator
// ---------------------------------------------------------------------------

export class ImportValidationError extends Error {}

export type ValidatedImportNode = {
  id: string;
  kind: NodeKind;
  position: { x: number; y: number };
  params: WorkbenchParams;
};

export type ValidatedImportEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
};

export type ValidatedImportImage = { key: string; bytes: Uint8Array; mimeType: string };

export type ValidatedImport = {
  nodes: ValidatedImportNode[];
  edges: ValidatedImportEdge[];
  images: ValidatedImportImage[];
  warnings: string[];
};

function createImportId(): string {
  return globalThis.crypto?.randomUUID?.().slice(0, 8) ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function validatePrimitive(value: unknown, rule: ImportParamRule): unknown {
  switch (rule.type) {
    case "string":
      if (typeof value !== "string") return undefined;
      if (rule.maxLength !== undefined && value.length > rule.maxLength) return undefined;
      return value;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
      if (rule.integer && !Number.isInteger(value)) return undefined;
      if (rule.min !== undefined && value < rule.min) return undefined;
      if (rule.max !== undefined && value > rule.max) return undefined;
      return value;
    }
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "enum":
      return typeof value === "string" && (rule.values as readonly string[]).includes(value) ? value : undefined;
    default:
      return undefined;
  }
}

// A blob-cache key is only ever accepted back if (a) it is namespaced under
// the node's OWN old id (the export convention every node kind uses --
// `${nodeId}:...`) and (b) an image actually decoded successfully for that
// exact raw key. Anything else (a stranger's key, a key with no matching
// image, a key for an image that failed the MIME/byte-cap gate) is dropped
// silently -- never trusted into the live blob cache.
function remapBlobKey(
  oldKey: string,
  oldId: string,
  newId: string,
  decodedImages: Map<string, DecodedImage>,
  usedImageKeys: Map<string, string>,
): string | null {
  if (!oldKey.startsWith(`${oldId}:`)) return null;
  if (!decodedImages.has(oldKey)) return null;
  const newKey = `${newId}${oldKey.slice(oldId.length)}`;
  usedImageKeys.set(oldKey, newKey);
  return newKey;
}

const DEFAULT_MAX_REFERENCE_ITEMS = 64;
const DEFAULT_MAX_IMAGES_PER_ITEM = 16;

function validateReferenceItemList(
  value: unknown,
  rule: Extract<ImportParamRule, { type: "referenceItemList" }>,
  oldId: string,
  newId: string,
  decodedImages: Map<string, DecodedImage>,
  usedImageKeys: Map<string, string>,
): ReferenceItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const maxItems = rule.maxItems ?? DEFAULT_MAX_REFERENCE_ITEMS;
  const maxImages = rule.maxImagesPerItem ?? DEFAULT_MAX_IMAGES_PER_ITEM;
  const seenIds = new Set<string>();
  const items: ReferenceItem[] = [];
  for (const rawItem of value.slice(0, maxItems)) {
    if (!isPlainRecord(rawItem)) continue;
    let id = typeof rawItem.id === "string" && rawItem.id.trim() ? rawItem.id.trim().slice(0, 128) : `item-${createImportId()}`;
    while (seenIds.has(id)) id = `item-${createImportId()}`;
    seenIds.add(id);
    const role = typeof rawItem.role === "string" ? rawItem.role.slice(0, 200) : "";
    const brand = typeof rawItem.brand === "string" ? rawItem.brand.slice(0, 200) : undefined;
    const name = typeof rawItem.name === "string" ? rawItem.name.slice(0, 200) : undefined;
    const finish = typeof rawItem.finish === "string" ? rawItem.finish.slice(0, 200) : undefined;
    const notes = typeof rawItem.notes === "string" ? rawItem.notes.slice(0, 2_000) : undefined;
    const required = typeof rawItem.required === "boolean" ? rawItem.required : undefined;
    const rawKeys = Array.isArray(rawItem.imageKeys) ? rawItem.imageKeys.filter((key): key is string => typeof key === "string") : [];
    const imageKeys: string[] = [];
    for (const rawKey of rawKeys.slice(0, maxImages)) {
      const remapped = remapBlobKey(rawKey, oldId, newId, decodedImages, usedImageKeys);
      if (remapped) imageKeys.push(remapped);
    }
    items.push({ id, role, brand, name, finish, notes, required, imageKeys });
  }
  return items;
}

function validateNodeParams(
  kind: NodeKind,
  paramsRaw: Record<string, unknown>,
  oldId: string,
  newId: string,
  decodedImages: Map<string, DecodedImage>,
  usedImageKeys: Map<string, string>,
): WorkbenchParams {
  const schema = importSchemaMap[kind];
  const validated: Record<string, unknown> = {};

  for (const [key, rule] of Object.entries(schema.paramKeys)) {
    const value = paramsRaw[key];
    if (value === undefined) continue; // optional-and-absent (or required-but-absent) both just fall through to defaultParams
    if (rule.type === "referenceItemList") {
      const list = validateReferenceItemList(value, rule, oldId, newId, decodedImages, usedImageKeys);
      if (list !== undefined) validated[key] = list;
      continue;
    }
    const ok = validatePrimitive(value, rule);
    if (ok !== undefined) validated[key] = ok;
  }

  // Fields the manifest declares as holding a single blob-cache key (e.g.
  // Masked Edit's maskCacheKey): remap through the same ownership check.
  for (const field of schema.sourceBlobKeys) {
    const value = validated[field];
    if (typeof value !== "string" || !value) continue;
    const remapped = remapBlobKey(value, oldId, newId, decodedImages, usedImageKeys);
    if (remapped) validated[field] = remapped;
    else delete validated[field];
  }

  // Photo's SOURCE image is cached under the node-id convention
  // (PHOTO_SOURCE_KEY), never a param field -- mirrors persistence.ts's own
  // legacy special-case (sourceBlobKeysForNode) for exactly this one kind.
  // Nothing else to store on `validated`: materializeImport re-derives
  // PHOTO_SOURCE_KEY(newId) directly once the image lands in usedImageKeys.
  if (kind === "photo") remapBlobKey(PHOTO_SOURCE_KEY(oldId), oldId, newId, decodedImages, usedImageKeys);

  return validated as WorkbenchParams;
}

function wouldCreateCycle(edges: ValidatedImportEdge[], source: string, target: string): boolean {
  if (source === target) return true;
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  }
  const queue = [target];
  const seen = new Set<string>();
  while (queue.length) {
    const current = queue.pop()!;
    if (current === source) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of outgoing.get(current) ?? []) queue.push(next);
  }
  return false;
}

// The dedicated strict import validator (AC18). NEVER reuses persistence.ts's
// loadGraph merge -- every node kind, every param key, and every image is
// checked against an explicit allowlist. Malformed per-node/per-edge/
// per-image entries are dropped with a warning rather than aborting the
// whole import; only a fundamentally unrecognizable top-level shape throws.
export function validateImport(raw: unknown): ValidatedImport {
  const warnings: string[] = [];
  const sanitized = stripDangerousKeys(raw);
  if (!isPlainRecord(sanitized) || sanitized.format !== EXPORT_FORMAT) {
    throw new ImportValidationError("This file is not a Material Collager workbench export.");
  }

  const nodesRaw = Array.isArray(sanitized.nodes) ? sanitized.nodes : [];
  const edgesRaw = Array.isArray(sanitized.edges) ? sanitized.edges : [];
  const imagesRaw = isPlainRecord(sanitized.images) ? sanitized.images : {};

  if (nodesRaw.length > MAX_IMPORT_NODES) throw new ImportValidationError(`This graph has too many nodes (max ${MAX_IMPORT_NODES}).`);
  if (edgesRaw.length > MAX_IMPORT_EDGES) throw new ImportValidationError(`This graph has too many edges (max ${MAX_IMPORT_EDGES}).`);

  // Decode + verify every embedded image up front, independent of whether any
  // node ends up referencing it. Object.entries preserves string-key
  // insertion order, so the total-byte cap below always drops the LAST
  // images in the file first, not an arbitrary subset.
  const decodedImages = new Map<string, DecodedImage>();
  let totalBytes = 0;
  let overCap = false;
  for (const [key, value] of Object.entries(imagesRaw)) {
    if (!key) continue;
    const decoded = decodeImageDataUrl(value);
    if (!decoded) {
      warnings.push(`Skipped an embedded image ("${key}"): invalid or disallowed format.`);
      continue;
    }
    if (totalBytes + decoded.bytes.byteLength > MAX_TOTAL_IMPORT_IMAGE_BYTES) {
      overCap = true;
      continue;
    }
    totalBytes += decoded.bytes.byteLength;
    decodedImages.set(key, decoded);
  }
  if (overCap) warnings.push("Some embedded images were skipped: this import exceeded the total size cap.");

  const idMap = new Map<string, string>(); // oldId -> newId
  const seenOldIds = new Set<string>();
  const usedImageKeys = new Map<string, string>(); // oldKey -> newKey, populated as params are validated
  const validatedNodes: ValidatedImportNode[] = [];

  for (const rawNode of nodesRaw) {
    if (!isPlainRecord(rawNode)) {
      warnings.push("Skipped a malformed node entry.");
      continue;
    }
    const kind = rawNode.kind;
    if (typeof kind !== "string" || !NODE_KINDS.includes(kind as NodeKind)) {
      warnings.push(`Skipped a node with an unrecognized kind ("${String(kind)}").`);
      continue;
    }
    const oldId = typeof rawNode.id === "string" && rawNode.id ? rawNode.id : null;
    if (!oldId || seenOldIds.has(oldId)) {
      warnings.push("Skipped a node with a missing or duplicate id.");
      continue;
    }
    seenOldIds.add(oldId);
    const newId = `${kind}-${createImportId()}`;
    idMap.set(oldId, newId);

    const rawPosition = rawNode.position;
    const position =
      isPlainRecord(rawPosition) &&
      typeof rawPosition.x === "number" && Number.isFinite(rawPosition.x) &&
      typeof rawPosition.y === "number" && Number.isFinite(rawPosition.y)
        ? { x: rawPosition.x, y: rawPosition.y }
        : { x: 0, y: 0 };

    const paramsRaw = isPlainRecord(rawNode.params) ? rawNode.params : {};
    const validatedFields = validateNodeParams(kind as NodeKind, paramsRaw, oldId, newId, decodedImages, usedImageKeys);
    const params: WorkbenchParams = { ...defaultParams(kind as NodeKind), ...validatedFields };

    validatedNodes.push({ id: newId, kind: kind as NodeKind, position, params });
  }

  const nodeByNewId = new Map(validatedNodes.map((node) => [node.id, node]));
  const validatedEdges: ValidatedImportEdge[] = [];
  const claimedSingleTargets = new Set<string>();
  for (const rawEdge of edgesRaw) {
    if (!isPlainRecord(rawEdge)) {
      warnings.push("Skipped a malformed edge entry.");
      continue;
    }
    const oldSource = typeof rawEdge.source === "string" ? rawEdge.source : null;
    const oldTarget = typeof rawEdge.target === "string" ? rawEdge.target : null;
    const newSource = oldSource ? idMap.get(oldSource) : undefined;
    const newTarget = oldTarget ? idMap.get(oldTarget) : undefined;
    if (!newSource || !newTarget) {
      warnings.push("Skipped an edge referencing an unknown node.");
      continue;
    }
    const sourceNode = nodeByNewId.get(newSource)!;
    const targetNode = nodeByNewId.get(newTarget)!;
    const sourceHandle = typeof rawEdge.sourceHandle === "string" ? rawEdge.sourceHandle : null;
    const targetHandle = typeof rawEdge.targetHandle === "string" ? rawEdge.targetHandle : null;
    const sourcePort = sourceHandle ? specFor(sourceNode.kind).outputs.find((port) => port.id === sourceHandle) : undefined;
    const targetPort = targetHandle ? specFor(targetNode.kind).inputs.find((port) => port.id === targetHandle) : undefined;
    if (!sourcePort || !targetPort) {
      warnings.push("Skipped an edge with an invalid or missing port handle.");
      continue;
    }
    if (!acceptedKindsFor(targetPort).includes(sourcePort.kind)) {
      warnings.push("Skipped an edge whose port kinds don't match.");
      continue;
    }
    const targetKey = `${newTarget}:${targetHandle}`;
    if (!targetPort.multi && claimedSingleTargets.has(targetKey)) {
      warnings.push("Skipped a duplicate connection into a single-input port.");
      continue;
    }
    if (wouldCreateCycle(validatedEdges, newSource, newTarget)) {
      warnings.push("Skipped an edge that would create a cycle.");
      continue;
    }
    claimedSingleTargets.add(targetKey);
    // sourceHandle/targetHandle are guaranteed non-null here: sourcePort/
    // targetPort above only resolve to a real port when each handle is a
    // string (the ternaries feeding them fall back to `undefined` otherwise,
    // which would already have hit the `continue` above).
    validatedEdges.push({ id: `edge-${createImportId()}`, source: newSource, target: newTarget, sourceHandle: sourceHandle!, targetHandle: targetHandle! });
  }

  const images: ValidatedImportImage[] = [...usedImageKeys].map(([oldKey, newKey]) => {
    const decoded = decodedImages.get(oldKey)!;
    return { key: newKey, bytes: decoded.bytes, mimeType: decoded.mimeType };
  });

  return { nodes: validatedNodes, edges: validatedEdges, images, warnings };
}

// ---------------------------------------------------------------------------
// Materialize: the DOM/blob-cache-touching half (browser only). Splits from
// validateImport the same way every node's manifest/.tsx pair splits a pure
// core from its DOM wrapper.
// ---------------------------------------------------------------------------

export function materializeImport(validated: ValidatedImport): { nodes: WorkbenchNode[]; edges: Edge[] } {
  for (const image of validated.images) {
    // Re-wrap in a fresh Uint8Array (always ArrayBuffer-backed, never
    // SharedArrayBuffer) so this satisfies BlobPart regardless of exactly how
    // decodeImageDataUrl's Uint8Array<ArrayBufferLike> was typed.
    putBlob(image.key, new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }));
  }

  const nodes: WorkbenchNode[] = validated.nodes.map((node) => {
    const built: WorkbenchNode = {
      id: node.id,
      type: node.kind,
      position: node.position,
      data: { kind: node.kind, params: node.params, status: "idle", runs: [], activeRun: 0 },
    };
    if (node.kind === "photo") {
      const key = PHOTO_SOURCE_KEY(node.id);
      const blob = getBlob(key);
      if (blob) {
        const url = URL.createObjectURL(blob);
        built.data.runs = [buildPhotoRun(node.id, url, key, node.params.fileFingerprint, Date.now())];
        built.data.status = "done";
      }
    }
    // References self-heals its display run from params.referenceItems + the
    // now-populated blob cache via its own mount effect (references.tsx),
    // exactly like it already does after a normal graph reload -- nothing
    // extra to do here.
    return built;
  });

  const edges: Edge[] = validated.edges.map((edge) => ({ ...edge } as Edge));
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Export builders (browser only).
// ---------------------------------------------------------------------------

export type ExportSizeEstimate = { imageCount: number; totalBytes: number; overWarnThreshold: boolean };

// Cheap, synchronous pre-flight so the UI can warn BEFORE paying the cost of
// base64-encoding everything (buildExportGraph below).
export function estimateExportSize(nodes: WorkbenchNode[]): ExportSizeEstimate {
  let totalBytes = 0;
  let imageCount = 0;
  for (const node of nodes) {
    const keys = sourceBlobKeysForNode(node.data.kind, node.id, node.data.params);
    for (const key of keys) {
      const blob = getBlob(key);
      if (blob) {
        totalBytes += blob.size;
        imageCount += 1;
      }
    }
  }
  return { imageCount, totalBytes, overWarnThreshold: totalBytes > EXPORT_SIZE_WARN_BYTES };
}

export type BuildExportOptions = { graphOnly: boolean };

// Builds the full self-contained export: node params/positions verbatim (the
// STRICT allowlist gate lives entirely on the import side, matching the
// threat model -- an export made by this same app has nothing to sanitize
// against), plus every SOURCE upload embedded as a data URL keyed by its raw
// blob-cache key (graphOnly omits the images entirely, for image-heavy
// graphs the user wants to keep small).
export async function buildExportGraph(nodes: WorkbenchNode[], edges: Edge[], options: BuildExportOptions): Promise<ExportedGraph> {
  const images: Record<string, string> = {};
  const exportedNodes: ExportedNode[] = [];

  for (const node of nodes) {
    const keys = options.graphOnly ? [] : sourceBlobKeysForNode(node.data.kind, node.id, node.data.params);
    for (const key of keys) {
      if (images[key]) continue;
      const blob = getBlob(key);
      if (blob) images[key] = await blobToDataUrl(blob);
    }
    exportedNodes.push({ id: node.id, kind: node.data.kind, position: node.position, params: node.data.params });
  }

  const exportedEdges: ExportedEdge[] = edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
  }));

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    graphOnly: options.graphOnly,
    nodes: exportedNodes,
    edges: exportedEdges,
    images,
  };
}

export function serializeExportGraph(graph: ExportedGraph): string {
  return JSON.stringify(graph, null, 2);
}

// Triggers a browser file download of the export JSON (same anchor-click
// idiom as exportDownload.tsx's image download).
export function triggerJsonDownload(json: string, filename: string): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
