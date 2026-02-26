import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCron, toCronExpression } from "./schedule";

describe("schedule helpers", () => {
  it("builds daily cron from mountain time", () => {
    assert.equal(toCronExpression("daily", "05:00", []), "0 12 * * *");
  });

  it("builds weekly cron with selected weekdays", () => {
    assert.equal(toCronExpression("weekly", "09:30", ["1", "3", "5"]), "30 16 * * 1,3,5");
  });

  it("parses monthly cron back to ui fields", () => {
    const parsed = parseCron("15 14 7 * *");
    assert.deepEqual(parsed, {
      frequency: "monthly",
      time: "07:15",
      days: ["1"],
      monthlyDay: "7",
    });
  });
});
