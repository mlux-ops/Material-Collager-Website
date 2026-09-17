import { getRenderObject } from "@/app/lib/autoboard-renders";

export const runtime = "edge";

export async function GET(_request: Request, context: { params: Promise<{ renderId: string }> }) {
  const { renderId } = await context.params;
  const object = await getRenderObject(renderId);
  if (!object) return new Response("No such render.", { status: 404 });
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "image/png",
      "Cache-Control": "private, max-age=300",
      "X-Robots-Tag": "noindex, noimageindex",
    },
  });
}
