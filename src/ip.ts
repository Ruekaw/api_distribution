import ipaddr from "ipaddr.js";

const encoder = new TextEncoder();

export function normalizeIp(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 128) return null;
  try {
    const address = ipaddr.parse(trimmed);
    if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) {
      return address.toIPv4Address().toString();
    }
    return address.toString();
  } catch {
    return null;
  }
}

export function getClientIp(request: Request): string | null {
  const header = request.headers.get("CF-Connecting-IP");
  return header === null ? null : normalizeIp(header);
}

export async function hashClientIp(
  normalizedIp: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(normalizedIp),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
