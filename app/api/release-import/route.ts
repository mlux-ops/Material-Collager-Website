import { env } from "cloudflare:workers";

import rightsManifest from "@/docs/release-collage-rights.json";
import { ensureJobStorage, publicJob, runtimeStorage, type JobRow } from "@/app/lib/generation-jobs";
import { errorResponse } from "@/app/lib/openai-server";

export const runtime = "edge";

const MAX_PNG_BYTES = 10 * 1024 * 1024;
const RELEASE_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

type ReleaseRuntimeEnv = {
  RELEASE_IMPORT_TOKEN?: string;
};

type ApprovedCollage = (typeof rightsManifest.collages)[number];

const approvedCollages = new Map<string, { collage: ApprovedCollage; order: number }>(
  rightsManifest.collages.map((collage, index) => [collage.assetKey, { collage, order: index + 1 }]),
);

export async function POST(request: Request) {
  try {
    const configuredToken = (env as unknown as ReleaseRuntimeEnv).RELEASE_IMPORT_TOKEN?.trim();
    if (!configuredToken) {
      return Response.json({ ok: false, error: "Release import is disabled." }, { status: 503 });
    }

    const suppliedToken = request.headers.get("x-release-import-token")?.trim();
    if (!suppliedToken || suppliedToken !== configuredToken) {
      return Response.json({ ok: false, error: "Release import is not authorized." }, { status: 401 });
    }

    const form = await request.formData();
    const assetKey = textField(form, "assetKey");
    const approved = approvedCollages.get(assetKey);
    if (!approved) {
      return Response.json({ ok: false, error: "The collage is not in the approved release manifest." }, { status: 400 });
    }
    if (!approved.collage.approvedForPublicPreview || !approved.collage.approvedForDownload) {
      return Response.json({ ok: false, error: "The collage does not have complete release approval." }, { status: 400 });
    }

    const image = form.get("image");
    if (!(image instanceof File)) {
      return Response.json({ ok: false, error: "Attach one PNG release collage." }, { status: 400 });
    }
    if (image.type !== "image/png") {
      return Response.json({ ok: false, error: "Release collages must be PNG files." }, { status: 400 });
    }
    if (image.size < 1 || image.size > MAX_PNG_BYTES) {
      return Response.json({ ok: false, error: "Release collages must be between 1 byte and 10 MB." }, { status: 400 });
    }

    const DB = await ensureJobStorage();
    const bucket = runtimeStorage().OUTPUTS;
    if (!bucket) throw new Error("Generated-output storage is not configured.");

    const id = `release-${assetKey}`;
    const outputKey = `release-outputs/${assetKey}.png`;
    const now = Date.now();
    const createdAt = Date.parse(approved.collage.approvedAt) - approved.order * 1000;
    const expiresAt = now + RELEASE_LIFETIME_MS;
    const filename = `${assetKey}.png`;
    const payload = {
      assetKey,
      releaseImport: true,
      rightsBasis: approved.collage.rightsBasis,
      approvedBy: approved.collage.approvedBy,
      approvedAt: approved.collage.approvedAt,
    };

    await bucket.put(outputKey, await image.arrayBuffer(), { httpMetadata: { contentType: "image/png" } });
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
        JSON.stringify({ source: "approved-release-import", assetKey }),
        createdAt,
        now,
        expiresAt,
      )
      .run();

    const row = await DB.prepare("SELECT * FROM generation_jobs WHERE id = ?").bind(id).first<JobRow>();
    if (!row) throw new Error("The release collage was stored without a Library record.");
    return Response.json({ ok: true, item: publicJob(row) });
  } catch (error) {
    return errorResponse(error);
  }
}

function textField(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}
