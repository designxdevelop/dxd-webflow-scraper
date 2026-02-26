import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractFailedDownloadUrl, normalizeUrlForBlacklist } from "./crawls.utils.js";

describe("crawls.utils", () => {
  it("normalizes URLs for blacklist matching", () => {
    const normalized = normalizeUrlForBlacklist("https://cdn.example.com/script.js?x=1#frag");
    assert.equal(normalized, "https://cdn.example.com/script.js");
  });

  it("extracts failed download URL from explicit log url", () => {
    const extracted = extractFailedDownloadUrl({
      message: "Failed to download asset",
      url: "https://cdn.example.com/a.js?cache=1",
    });

    assert.equal(extracted, "https://cdn.example.com/a.js");
  });

  it("extracts failed download URL from message text and trims punctuation", () => {
    const extracted = extractFailedDownloadUrl({
      message: "Could not download https://cdn.example.com/b.js);",
    });

    assert.equal(extracted, "https://cdn.example.com/b.js");
  });

  it("returns null for unrelated logs", () => {
    assert.equal(extractFailedDownloadUrl({ message: "Crawl started" }), null);
  });
});
