/**
 * Server-side localhost detection from Host header.
 */
export function isLocalHost(host: string): boolean {
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

/**
 * Client-side localhost detection from window.location.
 * Returns false during SSR.
 */
export function isLocalClient(): boolean {
  if (typeof window === "undefined") return false;
  const hostname = window.location.hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
}
