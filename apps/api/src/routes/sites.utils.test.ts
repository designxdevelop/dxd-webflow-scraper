import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getNextScheduledAt,
  isValidDownloadBlacklistRule,
  normalizeDownloadBlacklistRules,
} from "./sites.utils.js";

describe("sites.utils", () => {
  it("accepts absolute URLs and URL prefixes", () => {
    assert.equal(isValidDownloadBlacklistRule("https://example.com/script.js"), true);
    assert.equal(isValidDownloadBlacklistRule("https://example.com/assets/*"), true);
  });

  it("rejects invalid blacklist rules", () => {
    assert.equal(isValidDownloadBlacklistRule(""), false);
    assert.equal(isValidDownloadBlacklistRule("not-a-url"), false);
  });

  it("normalizes, deduplicates, and strips query/hash where expected", () => {
    const normalized = normalizeDownloadBlacklistRules([
      " https://example.com/a.js?cache=1 ",
      "https://example.com/a.js#frag",
      "https://example.com/path/*",
      "https://example.com/path/*",
      "invalid",
    ]);

    assert.deepEqual(normalized, [
      "https://example.com/a.js",
      "https://example.com/path/*",
    ]);
  });

  it("calculates next run only when schedule is enabled", () => {
    assert.equal(getNextScheduledAt(false, "0 5 * * *"), null);
    assert.equal(getNextScheduledAt(true, null), null);

    const next = getNextScheduledAt(true, "0 5 * * *");
    assert.ok(next instanceof Date);
  });
});
