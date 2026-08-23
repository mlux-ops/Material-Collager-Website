import { cleanupExpiredJobs, listLibraryJobs, publicJob, type JobRow } from "@/app/lib/generation-jobs";
import { errorResponse } from "@/app/lib/openai-server";

export const runtime = "edge";

/**
 * Aspect ratio (width / height) of a stored render, from the request payload
 * that produced it: the generator resolves an orientation to one of three
 * standard sizes (see standardSizeFor in app/api/generate/route.ts). Serving
 * it here is what lets the archive lay out its grid with correct boxes
 * BEFORE any image loads — the alternative, probing every image's natural
 * size on the client, is what made that page hang.
 */
function aspectRatioOf(row: JobRow): number {
  try {
    const payload = JSON.parse(row.payload_json) as {
      orientation?: string;
      collageType?: string;
    };
    const orientation = payload?.orientation && payload.orientation !== "default"
      ? payload.orientation
      : payload?.collageType === "bathroom_tile_collage"
        ? "portrait"
        : "landscape";
    if (orientation === "portrait") return 1024 / 1536;
    if (orientation === "square") return 1;
    return 1536 / 1024;
  } catch {
    return 1536 / 1024; // unparseable or a non-generator payload (e.g. workbench saves)
  }
}

export async function GET() {
  try {
    await cleanupExpiredJobs();
    const rows = await listLibraryJobs();
    const items = rows.results.map((row: JobRow) => {
      const job = publicJob(row);
      return {
        ...job,
        imageUrl: `/api/library/${encodeURIComponent(job.id)}/image`,
        aspectRatio: aspectRatioOf(row),
      };
    });
    return Response.json({ ok: true, items });
  } catch (error) {
    return errorResponse(error);
  }
}
