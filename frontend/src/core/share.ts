import { normalizeDesign } from "./design";
import type { Design } from "../engine/types";

const PREFIX = "d=";

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Response(new Response(bytes as BodyInit).body!.pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** URL fragment holding a deflated design; never sent to any server. */
export async function encodeShare(design: Design): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(design));
  return PREFIX + toBase64Url(await pipe(bytes, new CompressionStream("deflate-raw")));
}

export async function decodeShare(hash: string): Promise<Design | null> {
  const fragment = hash.replace(/^#/, "");
  if (!fragment.startsWith(PREFIX)) return null;
  const bytes = await pipe(fromBase64Url(fragment.slice(PREFIX.length)), new DecompressionStream("deflate-raw"));
  return normalizeDesign(JSON.parse(new TextDecoder().decode(bytes)));
}
