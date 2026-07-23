// Image payloads live here, outside React state — nodes hold only object-URL
// strings, so canvas re-renders never diff multi-MB blobs.

const blobs = new Map<string, Blob>();
const urls = new Map<string, string>();

export function putBlob(key: string, blob: Blob): string {
  releaseBlob(key);
  blobs.set(key, blob);
  const url = URL.createObjectURL(blob);
  urls.set(key, url);
  return url;
}

export function getBlob(key: string): Blob | undefined {
  return blobs.get(key);
}

export function releaseBlob(key: string) {
  const url = urls.get(key);
  if (url) URL.revokeObjectURL(url);
  urls.delete(key);
  blobs.delete(key);
}

export function releaseByPrefix(prefix: string) {
  for (const key of [...blobs.keys()]) {
    if (key.startsWith(prefix)) releaseBlob(key);
  }
}
