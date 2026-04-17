import { MantleMcpError } from "../errors.js";
import * as dns from "node:dns/promises";

function isIpv4(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host);
}

function isPrivateIpv4(host: string): boolean {
  if (!isIpv4(host)) {
    return false;
  }
  const octets = host.split(".").map((part) => Number(part));
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isBlockedIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80")
  );
}

function isLocalHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function parseAllowlist(): string[] {
  const raw = process.env.MANTLE_ALLOWED_ENDPOINT_DOMAINS ?? "";
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  const normalized = host.toLowerCase();
  return allowlist.some(
    (domain) => normalized === domain || normalized.endsWith(`.${domain}`)
  );
}

export function ensureEndpointAllowed(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new MantleMcpError(
      "ENDPOINT_NOT_ALLOWED",
      `Invalid endpoint URL: ${endpoint}`,
      "Provide a valid absolute endpoint URL.",
      { endpoint }
    );
  }

  const host = url.hostname;
  const allowHttpLocal = process.env.MANTLE_ALLOW_HTTP_LOCAL_ENDPOINTS === "true";
  const allowLoopbackHttp = allowHttpLocal && url.protocol === "http:" && isLocalHost(host);

  if (url.protocol !== "https:" && !allowLoopbackHttp) {
    throw new MantleMcpError(
      "ENDPOINT_NOT_ALLOWED",
      `Endpoint protocol not allowed: ${url.protocol}`,
      "Use https:// endpoints, or enable local http for localhost only.",
      { endpoint: url.toString() }
    );
  }

  if (!allowLoopbackHttp && (isPrivateIpv4(host) || isBlockedIpv6(host))) {
    throw new MantleMcpError(
      "ENDPOINT_NOT_ALLOWED",
      `Endpoint host is private or local and is not allowed: ${host}`,
      "Use a public endpoint host.",
      { endpoint: url.toString(), host }
    );
  }

  const metadataHosts = new Set(["169.254.169.254", "metadata.google.internal"]);
  if (metadataHosts.has(host.toLowerCase())) {
    throw new MantleMcpError(
      "ENDPOINT_NOT_ALLOWED",
      `Metadata endpoint is blocked: ${host}`,
      "Use a non-metadata endpoint.",
      { endpoint: url.toString(), host }
    );
  }

  const allowlist = parseAllowlist();
  if (allowlist.length > 0 && !hostMatchesAllowlist(host, allowlist)) {
    throw new MantleMcpError(
      "ENDPOINT_NOT_ALLOWED",
      `Endpoint host is not in allowlist: ${host}`,
      "Set MANTLE_ALLOWED_ENDPOINT_DOMAINS to include this host, or use an allowed endpoint.",
      { endpoint: url.toString(), host, allowlist }
    );
  }

  return url;
}

/**
 * Resolve a hostname to IP addresses and reject if any resolve to private/loopback ranges.
 * This prevents DNS rebinding and SSRF via hostname tricks.
 */
async function rejectPrivateResolution(hostname: string): Promise<void> {
  // Skip resolution for direct IP inputs — already checked in ensureEndpointAllowed
  if (isIpv4(hostname) || isBlockedIpv6(hostname)) return;

  let addresses: string[] = [];
  let addresses6: string[] = [];
  let resolve4Failed = false;
  let resolve6Failed = false;

  try {
    addresses = await dns.resolve4(hostname);
  } catch {
    resolve4Failed = true;
  }

  try {
    addresses6 = await dns.resolve6(hostname);
  } catch {
    resolve6Failed = true;
  }

  // Fail closed: if BOTH lookups fail, reject — the hostname is unresolvable
  // but fetch() might still resolve it via OS lookup / /etc/hosts / split-horizon DNS
  if (resolve4Failed && resolve6Failed) {
    throw new MantleMcpError(
      "ENDPOINT_NOT_ALLOWED",
      `Cannot resolve hostname '${hostname}'. Unresolvable hosts are rejected for safety.`,
      "Use a hostname that resolves to a public IP address via DNS.",
      { hostname }
    );
  }

  const allAddresses = [...addresses, ...addresses6];
  for (const addr of allAddresses) {
    if (isPrivateIpv4(addr) || isBlockedIpv6(addr) || addr === "0.0.0.0") {
      throw new MantleMcpError(
        "ENDPOINT_NOT_ALLOWED",
        `Hostname '${hostname}' resolves to private/loopback address ${addr}.`,
        "Use a hostname that resolves to a public IP address.",
        { hostname, resolved_address: addr }
      );
    }
  }
}

/**
 * Full endpoint validation: URL check + DNS resolution check.
 * Use this for user-supplied endpoints (indexer, diagnostics probe).
 *
 * @param dnsResolver - Optional override for DNS resolution. Pass a no-op
 *   `async () => {}` in tests to bypass real DNS lookups for fake hostnames.
 */
export async function ensureEndpointSafe(
  endpoint: string,
  dnsResolver?: (hostname: string) => Promise<void>
): Promise<URL> {
  const url = ensureEndpointAllowed(endpoint);
  if (dnsResolver) {
    await dnsResolver(url.hostname);
  } else {
    await rejectPrivateResolution(url.hostname);
  }
  return url;
}

/**
 * Create fetch options with redirect protection.
 * All fetch calls to user-supplied endpoints MUST use redirect: "error"
 * to prevent SSRF via open redirect chains.
 */
export function safeFetchOptions(
  options: RequestInit = {}
): RequestInit {
  return {
    ...options,
    redirect: "error"
  };
}

/**
 * Strict allowlist-based read-only SQL validation.
 * Only allows single SELECT statements (with optional WITH/CTE prefix).
 * Rejects multi-statement payloads, procedure calls, and all mutation forms.
 */
export function ensureReadOnlySql(query: string): void {
  const trimmed = query.trim();

  // Reject empty queries
  if (!trimmed) {
    throw new MantleMcpError(
      "INDEXER_ERROR",
      "Empty SQL query.",
      "Submit a non-empty SELECT query.",
      { query }
    );
  }

  // Reject multi-statement payloads (semicolons followed by more content)
  const withoutStrings = trimmed.replace(/'[^']*'/g, "''"); // strip string literals
  if (/;[\s]*\S/.test(withoutStrings)) {
    throw new MantleMcpError(
      "INDEXER_ERROR",
      "Multi-statement SQL queries are not allowed.",
      "Submit a single SELECT statement only.",
      { query }
    );
  }

  // Only allow queries starting with SELECT or WITH ... SELECT
  const normalized = trimmed.replace(/\s+/g, " ").toLowerCase();
  const isSelect = /^select\s/.test(normalized);
  const isWithSelect = /^with\s/.test(normalized) && /\bselect\b/.test(normalized);

  if (!isSelect && !isWithSelect) {
    throw new MantleMcpError(
      "INDEXER_ERROR",
      "Only SELECT queries are allowed.",
      "Submit a read-only SELECT or WITH ... SELECT query.",
      { query }
    );
  }

  // Reject known dangerous constructs even inside SELECT-like queries
  const dangerousPatterns =
    /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|exec|execute|copy|load|import|into\s+outfile|into\s+dumpfile)\b/i;
  if (dangerousPatterns.test(normalized)) {
    throw new MantleMcpError(
      "INDEXER_ERROR",
      "SQL query contains disallowed mutation or procedure keywords.",
      "Submit a pure read-only SELECT query without mutation side-effects.",
      { query }
    );
  }
}
