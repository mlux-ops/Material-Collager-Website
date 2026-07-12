import { ensureJobStorage, runtimeStorage } from "@/app/lib/generation-jobs";

export const runtime = "edge";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const DB = await ensureJobStorage();
  const row = await DB.prepare("SELECT output_key, filename FROM generation_jobs WHERE id = ? AND expires_at >= ?")
    .bind(id, Date.now()).first<{ output_key: string | null; filename: string }>();
  if (!row?.output_key) return new Response("Output is not ready.", { status: 404 });
  const object = await runtimeStorage().OUTPUTS?.get(row.output_key);
  if (!object) return new Response("Output has expired.", { status: 404 });
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "image/png",
      "Content-Disposition": `inline; filename="${row.filename.replace(/[\r\n\"]+/g, "_")}"`,
      "Cache-Control": "private, max-age=300",
    },
  });
}
