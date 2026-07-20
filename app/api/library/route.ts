import { cleanupExpiredJobs, listLibraryJobs, publicJob, type JobRow } from "@/app/lib/generation-jobs";
import { approvedReleaseImageUrl, approvedReleaseLibrary } from "@/app/lib/approved-release-library";
import { errorResponse } from "@/app/lib/openai-server";

export const runtime = "edge";

export async function GET() {
  try {
    await cleanupExpiredJobs();
    const rows = await listLibraryJobs();
    const persistedItems = rows.results.map((row: JobRow) => {
      const job = publicJob(row);
      return { ...job, imageUrl: `/api/library/${encodeURIComponent(job.id)}/image` };
    });
    const items = persistedItems.length > 0
      ? persistedItems
      : approvedReleaseLibrary.map((job) => ({ ...job, imageUrl: approvedReleaseImageUrl(job.filename) }));
    return Response.json({ ok: true, items });
  } catch (error) {
    return errorResponse(error);
  }
}
