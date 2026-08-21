/**
 * Shared Library placeholder thumbnails (see app/lib/library-thumbs-store.ts).
 * GET returns the deployment's set; PUT replaces it wholesale with a
 * client-captured batch. Input is sanitized to capped, data-URI-only entries
 * on both write and read. The deployment sits behind Cloudflare Access; no
 * additional per-route auth, matching the other library routes.
 */

import { getStoredLibraryThumbs, replaceLibraryThumbs } from "@/app/lib/library-thumbs-store.ts";

export async function GET() {
  try {
    return Response.json({ thumbs: await getStoredLibraryThumbs() });
  } catch {
    // Missing DB (unconfigured deployment) or transient D1 error: the
    // placeholder row is optional, so an empty set beats a 500.
    return Response.json({ thumbs: [] });
  }
}

export async function PUT(request: Request) {
  let candidate: unknown;
  try {
    candidate = ((await request.json()) as { thumbs?: unknown })?.thumbs;
  } catch {
    return Response.json({ error: "Body must be JSON: { thumbs: [...] }" }, { status: 400 });
  }
  try {
    const stored = await replaceLibraryThumbs(candidate);
    return Response.json({ stored });
  } catch {
    return Response.json({ error: "Thumbnail storage is unavailable." }, { status: 503 });
  }
}
