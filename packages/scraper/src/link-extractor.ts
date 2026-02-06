/**
 * B7: Extract same-origin links from HTML content for URL discovery (spider mode).
 * Returns normalized, deduplicated URLs on the same hostname as baseUrl.
 */
export function extractLinks(html: string, pageUrl: string, baseUrl: string): string[] {
  const baseHostname = new URL(baseUrl).hostname;
  const discovered = new Set<string>();

  // Extract href values from <a> tags
  const hrefPattern = /<a\s[^>]*href\s*=\s*["']([^"'#]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = hrefPattern.exec(html)) !== null) {
    const href = match[1];

    // Skip non-http, javascript:, mailto:, tel: links
    if (
      href.startsWith("javascript:") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:") ||
      href.startsWith("data:")
    ) {
      continue;
    }

    try {
      const resolved = new URL(href, pageUrl);

      // Only same-hostname links
      if (resolved.hostname !== baseHostname) {
        continue;
      }

      // Skip asset URLs (images, CSS, JS, etc.)
      const pathname = resolved.pathname.toLowerCase();
      if (
        /\.(js|css|png|jpg|jpeg|gif|webp|svg|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip)$/.test(
          pathname
        )
      ) {
        continue;
      }

      // Normalize: strip hash and trailing slash, keep search params
      resolved.hash = "";
      const normalized = resolved.toString().replace(/\/+$/, "") || resolved.origin;

      discovered.add(normalized);
    } catch {
      // Invalid URL
    }
  }

  return Array.from(discovered);
}
