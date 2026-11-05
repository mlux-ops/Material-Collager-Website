import { cleanupExpiredJobs, ensureJobStorage, publicJob, type JobRow } from "@/app/lib/generation-jobs";
import { errorResponse } from "@/app/lib/openai-server";

export const runtime = "edge";

// The Generator's History drawer: the newest 30 generation_jobs rows of every
// render kind, drafts included. Read-only — it refreshes nothing and calls no
// model. (Rows written by the retired Economy mode still list here as the
// terminal or pending records they were left as.)
export async function GET() {
  try {
    await cleanupExpiredJobs();
    const DB = await ensureJobStorage();
    const jobs = await DB.prepare("SELECT * FROM generation_jobs ORDER BY created_at DESC LIMIT 30").all<JobRow>();
    return Response.json({ ok: true, jobs: jobs.results.map(publicJob) });
  } catch (error) {
    return errorResponse(error);
  }
}
