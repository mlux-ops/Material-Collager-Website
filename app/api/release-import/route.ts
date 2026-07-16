import { env } from "cloudflare:workers";

import rightsManifest from "@/docs/release-collage-rights.json";
import { ensureJobStorage, publicJob, runtimeStorage, type JobRow } from "@/app/lib/generation-jobs";
import { errorResponse } from "@/app/lib/openai-server";

export const runtime = "edge";

const MAX_PNG_BYTES = 10 * 1024 * 1024;
const MAX_CHUNK_BYTES = 384 * 1024;
const MAX_CHUNKS = 64;
const RELEASE_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const RELEASE_IMPORT_RETIRED = true;

type ReleaseRuntimeEnv = {
  RELEASE_IMPORT_TOKEN?: string;
};

type ApprovedCollage = (typeof rightsManifest.collages)[number];

type ImportMetadata = {
  assetKey: string;
  startedAt: number;
  totalBytes: number;
  totalParts: number;
};

type ImportCommand = {
  action?: unknown;
  assetKey?: unknown;
  data?: unknown;
  index?: unknown;
  totalBytes?: unknown;
  totalParts?: unknown;
};

const approvedCollages = new Map<string, { collage: ApprovedCollage; order: number }>(
  rightsManifest.collages.map((collage, index) => [collage.assetKey, { collage, order: index + 1 }]),
);

export async function POST(request: Request) {
  try {
    if (RELEASE_IMPORT_RETIRED) {
      return Response.json({ ok: false, error: "The release import is closed." }, { status: 410 });
    }

    const configuredToken = (env as unknown as ReleaseRuntimeEnv).RELEASE_IMPORT_TOKEN?.trim();
    if (!configuredToken) {
      return Response.json({ ok: false, error: "Release import is disabled." }, { status: 503 });
    }

    const suppliedToken = request.headers.get("x-release-import-token")?.trim();
    if (!suppliedToken || suppliedToken !== configuredToken) {
      return Response.json({ ok: false, error: "Release import is not authorized." }, { status: 401 });
    }

    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      return Response.json({ ok: false, error: "Release imports must use the chunked JSON protocol." }, { status: 415 });
    }

    const command = await request.json() as ImportCommand;
    const action = typeof command.action === "string" ? command.action : "";
    const assetKey = typeof command.assetKey === "string" ? command.assetKey.trim() : "";
    const approved = approvedCollages.get(assetKey);
    if (!approved) {
      return Response.json({ ok: false, error: "The collage is not in the approved release manifest." }, { status: 400 });
    }
    if (!approved.collage.approvedForPublicPreview || !approved.collage.approvedForDownload) {
      return Response.json({ ok: false, error: "The collage does not have complete release approval." }, { status: 400 });
    }

    const bucket = runtimeStorage().OUTPUTS;
    if (!bucket) throw new Error("Generated-output storage is not configured.");

    if (action === "start") {
      return startImport(bucket, assetKey, command);
    }
    if (action === "part") {
      return storeImportPart(bucket, assetKey, command);
    }
    if (action === "complete") {
      return completeImport(bucket, approved);
    }
    return Response.json({ ok: false, error: "Choose start, part, or complete." }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}

async function startImport(bucket: R2Bucket, assetKey: string, command: ImportCommand) {
  const totalBytes = integerField(command.totalBytes);
  const totalParts = integerField(command.totalParts);
  if (totalBytes < 1 || totalBytes > MAX_PNG_BYTES) {
    return Response.json({ ok: false, error: "Release collages must be between 1 byte and 10 MB." }, { status: 400 });
  }
  if (totalParts < 1 || totalParts > MAX_CHUNKS || totalParts !== Math.ceil(totalBytes / MAX_CHUNK_BYTES)) {
    return Response.json({ ok: false, error: "The release collage chunk count is invalid." }, { status: 400 });
  }

  const metadata: ImportMetadata = { assetKey, startedAt: Date.now(), totalBytes, totalParts };
  await bucket.put(metadataKey(assetKey), JSON.stringify(metadata), { httpMetadata: { contentType: "application/json" } });
  return Response.json({ ok: true, assetKey, maxChunkBytes: MAX_CHUNK_BYTES, totalParts });
}

async function storeImportPart(bucket: R2Bucket, assetKey: string, command: ImportCommand) {
  const metadata = await readMetadata(bucket, assetKey);
  const index = integerField(command.index);
  const encoded = typeof command.data === "string" ? command.data : "";
  if (index < 0 || index >= metadata.totalParts) {
    return Response.json({ ok: false, error: "The release collage chunk index is invalid." }, { status: 400 });
  }
  const bytes = base64Bytes(encoded);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_CHUNK_BYTES) {
    return Response.json({ ok: false, error: "The release collage chunk size is invalid." }, { status: 400 });
  }
  if (index < metadata.totalParts - 1 && bytes.byteLength !== MAX_CHUNK_BYTES) {
    return Response.json({ ok: false, error: "Only the final release collage chunk may be short." }, { status: 400 });
  }

  await bucket.put(partKey(assetKey, index), bytes, { httpMetadata: { contentType: "application/octet-stream" } });
  return Response.json({ ok: true, assetKey, index, bytes: bytes.byteLength });
}

async function completeImport(bucket: R2Bucket, approved: { collage: ApprovedCollage; order: number }) {
  const assetKey = approved.collage.assetKey;
  const metadata = await readMetadata(bucket, assetKey);
  const parts: Uint8Array[] = [];
  let byteLength = 0;
  for (let index = 0; index < metadata.totalParts; index += 1) {
    const object = await bucket.get(partKey(assetKey, index));
    if (!object) {
      return Response.json({ ok: false, error: `Release collage chunk ${index} is missing.` }, { status: 409 });
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    parts.push(bytes);
    byteLength += bytes.byteLength;
  }
  if (byteLength !== metadata.totalBytes) {
    return Response.json({ ok: false, error: "The assembled release collage size does not match the source." }, { status: 409 });
  }

  const image = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    image.set(part, offset);
    offset += part.byteLength;
  }
  if (!isPng(image)) {
    return Response.json({ ok: false, error: "The assembled release collage is not a PNG." }, { status: 400 });
  }

  const item = await persistReleaseCollage(bucket, approved, image);
  await Promise.all([
    bucket.delete(metadataKey(assetKey)),
    ...Array.from({ length: metadata.totalParts }, (_, index) => bucket.delete(partKey(assetKey, index))),
  ]);
  return Response.json({ ok: true, item });
}

async function persistReleaseCollage(
  bucket: R2Bucket,
  approved: { collage: ApprovedCollage; order: number },
  image: Uint8Array,
) {
  const DB = await ensureJobStorage();
  const id = `release-${approved.collage.assetKey}`;
  const outputKey = `release-outputs/${approved.collage.assetKey}.png`;
  const now = Date.now();
  const createdAt = Date.parse(approved.collage.approvedAt) - approved.order * 1000;
  const expiresAt = now + RELEASE_LIFETIME_MS;
  const filename = `${approved.collage.assetKey}.png`;
  const payload = {
    assetKey: approved.collage.assetKey,
    releaseImport: true,
    rightsBasis: approved.collage.rightsBasis,
    approvedBy: approved.collage.approvedBy,
    approvedAt: approved.collage.approvedAt,
  };

  await bucket.put(outputKey, image, { httpMetadata: { contentType: "image/png" } });
  await DB.prepare(`INSERT INTO generation_jobs
    (id, mode, status, openai_batch_id, output_key, filename, format, prompt, payload_json, reference_ids_json,
     render_kind, collage_type, library_visible, title, estimated_usd, usage_json, qa_json, error, created_at, updated_at, expires_at)
    VALUES (?, 'immediate', 'completed', NULL, ?, ?, 'png', 'Imported approved release collage.', ?, '[]',
      'final', 'material_package', 1, ?, NULL, '{}', ?, NULL, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      mode = excluded.mode,
      status = excluded.status,
      openai_batch_id = NULL,
      output_key = excluded.output_key,
      filename = excluded.filename,
      format = excluded.format,
      prompt = excluded.prompt,
      payload_json = excluded.payload_json,
      reference_ids_json = excluded.reference_ids_json,
      render_kind = excluded.render_kind,
      collage_type = excluded.collage_type,
      library_visible = excluded.library_visible,
      title = excluded.title,
      estimated_usd = NULL,
      usage_json = excluded.usage_json,
      qa_json = excluded.qa_json,
      error = NULL,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at`)
    .bind(
      id,
      outputKey,
      filename,
      JSON.stringify(payload),
      approved.collage.title,
      JSON.stringify({ source: "approved-release-import", assetKey: approved.collage.assetKey }),
      createdAt,
      now,
      expiresAt,
    )
    .run();

  const row = await DB.prepare("SELECT * FROM generation_jobs WHERE id = ?").bind(id).first<JobRow>();
  if (!row) throw new Error("The release collage was stored without a Library record.");
  return publicJob(row);
}

async function readMetadata(bucket: R2Bucket, assetKey: string) {
  const object = await bucket.get(metadataKey(assetKey));
  if (!object) throw new Error("Start the release collage import before sending chunks.");
  return JSON.parse(await object.text()) as ImportMetadata;
}

function metadataKey(assetKey: string) {
  return `release-imports/${assetKey}/metadata.json`;
}

function partKey(assetKey: string, index: number) {
  return `release-imports/${assetKey}/part-${String(index).padStart(3, "0")}`;
}

function integerField(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : -1;
}

function base64Bytes(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function isPng(value: Uint8Array) {
  return value.byteLength >= 8
    && value[0] === 0x89
    && value[1] === 0x50
    && value[2] === 0x4e
    && value[3] === 0x47
    && value[4] === 0x0d
    && value[5] === 0x0a
    && value[6] === 0x1a
    && value[7] === 0x0a;
}
