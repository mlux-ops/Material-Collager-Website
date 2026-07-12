import { cleanupExpiredJobs, listLibraryJobs, publicJob, type JobRow } from "@/app/lib/generation-jobs";
import { errorResponse } from "@/app/lib/openai-server";

export const runtime = "edge";

export async function GET() {
  try {
    await cleanupExpiredJobs();
    const rows = await listLibraryJobs();
    const items = rows.results.map((row: JobRow) => {
      const job = publicJob(row);
      return { ...job, imageUrl: `/api/library/${encodeURIComponent(job.id)}/image` };
    });
    return Response.json({ ok: true, items });
  } catch (error) {
    return errorResponse(error);
  }
}
