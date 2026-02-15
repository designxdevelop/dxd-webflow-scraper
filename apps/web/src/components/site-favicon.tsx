import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/cn";

interface SiteFaviconProps {
  siteName: string;
  siteUrl: string;
  className?: string;
  fallbackClassName?: string;
}

function getFaviconSources(siteUrl: string): string[] {
  try {
    const parsedUrl = new URL(siteUrl);
    const hostname = parsedUrl.hostname;
    const origin = parsedUrl.origin;

    return Array.from(
      new Set([
        new URL("/favicon.ico", origin).toString(),
        `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
        `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(origin)}`,
      ])
    );
  } catch {
    return [];
  }
}

function getFallbackLabel(siteName: string): string {
  const firstCharacter = siteName.trim().charAt(0).toUpperCase();
  return firstCharacter || "?";
}

export function SiteFavicon({
  siteName,
  siteUrl,
  className,
  fallbackClassName,
}: SiteFaviconProps) {
  const faviconSources = useMemo(() => getFaviconSources(siteUrl), [siteUrl]);
  const [sourceIndex, setSourceIndex] = useState(0);

  useEffect(() => {
    setSourceIndex(0);
  }, [siteUrl]);

  const activeSource = faviconSources[sourceIndex];

  return (
    <div
      className={cn("shrink-0 rounded-md flex items-center justify-center overflow-hidden", className)}
      style={{ backgroundColor: "#27272a" }}
    >
      {activeSource ? (
        <img
          src={activeSource}
          alt={`${siteName} favicon`}
          className="w-full h-full object-contain"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() =>
            setSourceIndex((currentSourceIndex) =>
              currentSourceIndex + 1 < faviconSources.length
                ? currentSourceIndex + 1
                : faviconSources.length
            )
          }
        />
      ) : (
        <span
          className={cn("text-sm font-bold font-mono", fallbackClassName)}
          style={{ color: "#818cf8" }}
        >
          {getFallbackLabel(siteName)}
        </span>
      )}
    </div>
  );
}
