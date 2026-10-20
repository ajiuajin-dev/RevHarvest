import test from "node:test";
import assert from "node:assert/strict";
import {
  collectPages,
  createCollectionState,
  applyCollectionBatch,
  finishCollectionState,
  extractSheinProductId,
  isSupportedSheinProductUrl,
  mergeReviews,
  parseExactReviewTotal,
  resumeCollectionState,
  reviewKey,
  safeSpreadsheetCell,
  toCsv,
  toJson
} from "../src/core.js";

test("accepts HTTPS SHEIN product URLs and rejects lookalikes or non-products", () => {
  assert.equal(isSupportedSheinProductUrl("https://us.shein.com/item-p-12345.html"), true);
  assert.equal(isSupportedSheinProductUrl("https://m.shein.com/us/item-p-12345.html?x=1"), true);
  assert.equal(isSupportedSheinProductUrl("https://us.shein.com/item-review-543380593.html?sku=abc"), true);
  assert.equal(isSupportedSheinProductUrl("http://us.shein.com/item-p-12345.html"), false);
  assert.equal(isSupportedSheinProductUrl("https://shein.com.evil.example/item-p-12345.html"), false);
  assert.equal(isSupportedSheinProductUrl("https://us.shein.com/category.html"), false);
  assert.equal(extractSheinProductId("https://us.shein.com/item-review-543380593.html?sku=abc"), "543380593");
  assert.equal(extractSheinProductId("https://us.shein.com/item-p-12345.html"), "12345");
});

test("persists unique batches and resumes a cancelled task without losing progress", () => {
  const started = createCollectionState({ tabId: 7, url: "https://us.shein.com/item-p-123.html", now: 1 });
  const batched = applyCollectionBatch(started, {
    reviews: [{ id: "1" }, { id: "2" }],
    expectedTotal: 3,
    iteration: 1
  }, 2);
  const repeated = applyCollectionBatch(batched, {
    reviews: [{ id: "2" }],
    expectedTotal: 3,
    iteration: 2
  }, 3);
  const cancelled = { ...repeated, status: "cancelled", error: "stopped" };
  const resumed = resumeCollectionState(cancelled, { tabId: 8, now: 4 });
  assert.equal(repeated.loaded, 2);
  assert.equal(resumed.loaded, 2);
  assert.equal(resumed.tabId, 8);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.error, "");
});

test("marks exact totals complete and unknown or mismatched totals conservatively", () => {
  const base = createCollectionState({ tabId: 1, url: "https://us.shein.com/item-p-123.html", now: 1 });
  const complete = finishCollectionState(base, {
    reviews: [{ id: "1" }, { id: "2" }],
    expectedTotal: 2
  }, 2);
  const partial = finishCollectionState(base, {
    reviews: [{ id: "1" }],
    expectedTotal: 2
  }, 2);
  const unknown = finishCollectionState(base, { reviews: [{ id: "1" }] }, 2);
  const markerConfirmed = finishCollectionState(base, {
    reviews: [{ id: "1" }],
    endConfirmed: true,
    completionReason: "no-more-reviews-marker"
  }, 2);
  assert.equal(complete.completeness, "complete");
  assert.equal(partial.completeness, "partial");
  assert.equal(unknown.completeness, "unverified");
  assert.equal(markerConfirmed.completeness, "complete");
  assert.equal(markerConfirmed.endConfirmed, true);
  assert.equal(markerConfirmed.completionReason, "no-more-reviews-marker");
});

test("accepts exact review totals but not lower-bound labels", () => {
  assert.equal(parseExactReviewTotal("Customer Reviews (1,234)"), 1234);
  assert.equal(parseExactReviewTotal("500+ Reviews"), null);
  assert.equal(parseExactReviewTotal("客户评论 100+"), null);
  assert.equal(parseExactReviewTotal("Rhinestone Set 48,000pcs 24 Colors Includes Glue and Tools Customer Reviews"), null);
});

test("deduplicates stable ids across pages and enriches partial records", () => {
  const merged = mergeReviews(
    [{ id: "42", author: "A", text: "Good" }],
    [{ id: "42", author: "A", text: "Good", variant: "Blue" }, { id: "43", text: "Nice" }]
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].variant, "Blue");
});

test("uses a deterministic normalized fingerprint when an id is unavailable", () => {
  const first = reviewKey({ author: " A ", text: "Very   good", date: "2026-01-01" });
  const second = reviewKey({ author: "A", text: "Very good", date: "2026-01-01" });
  assert.equal(first, second);
  assert.match(first, /^fp_/);
});

test("exports UTF-8 CSV with quoting and spreadsheet formula protection", () => {
  const csv = toCsv([{ id: "1", author: "=cmd", text: "great, \"really\"", images: [] }]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /'=cmd/);
  assert.match(csv, /"great, ""really"""/);
  assert.equal(safeSpreadsheetCell("+1+1"), "'+1+1");
});

test("exports JSON with completeness metadata", () => {
  const parsed = JSON.parse(toJson([{ id: "1" }], { completeness: "complete" }));
  assert.equal(parsed.metadata.completeness, "complete");
  assert.equal(parsed.reviews.length, 1);
});

test("collects until the terminal cursor and reports complete", async () => {
  const pages = new Map([
    [null, { reviews: [{ id: "1" }, { id: "2" }], nextCursor: "b", expectedTotal: 3 }],
    ["b", { reviews: [{ id: "2" }, { id: "3" }], nextCursor: null, expectedTotal: 3 }]
  ]);
  const checkpoints = [];
  const result = await collectPages({
    fetchPage: async ({ cursor }) => pages.get(cursor),
    checkpoint: async (state) => checkpoints.push(state)
  });
  assert.equal(result.reviews.length, 3);
  assert.equal(result.pages, 2);
  assert.equal(result.completeness, "complete");
  assert.equal(checkpoints.length, 2);
});

test("retries temporary failures with a bounded retry count", async () => {
  let attempts = 0;
  const waits = [];
  const result = await collectPages({
    fetchPage: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary");
      return { reviews: [{ id: "1" }], nextCursor: null, expectedTotal: 1 };
    },
    maxRetries: 2,
    baseDelayMs: 10,
    sleep: async (milliseconds) => waits.push(milliseconds)
  });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 20]);
  assert.equal(result.completeness, "complete");
});

test("paces successful pagination and honors a server-suggested retry delay", async () => {
  const waits = [];
  let attempts = 0;
  const result = await collectPages({
    fetchPage: async ({ cursor }) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("rate limited");
        error.retryAfterMs = 900;
        throw error;
      }
      return cursor === null
        ? { reviews: [{ id: "1" }], nextCursor: "next", expectedTotal: 2 }
        : { reviews: [{ id: "2" }], nextCursor: null, expectedTotal: 2 };
    },
    minIntervalMs: 500,
    sleep: async (milliseconds) => waits.push(milliseconds)
  });
  assert.deepEqual(waits, [900, 500]);
  assert.equal(result.reviews.length, 2);
  assert.equal(result.completeness, "complete");
});

test("resumes from a saved cursor and preserves earlier reviews", async () => {
  const result = await collectPages({
    resume: { cursor: "next", reviews: [{ id: "1" }], pages: 1, expectedTotal: 2 },
    fetchPage: async ({ cursor }) => {
      assert.equal(cursor, "next");
      return { reviews: [{ id: "2" }], nextCursor: null, expectedTotal: 2 };
    }
  });
  assert.equal(result.pages, 2);
  assert.deepEqual(result.reviews.map((review) => review.id), ["1", "2"]);
});

test("cancels before requesting another page", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    collectPages({
      signal: controller.signal,
      fetchPage: async () => {
        calls += 1;
        controller.abort();
        return { reviews: [{ id: "1" }], nextCursor: "next", expectedTotal: 2 };
      }
    }),
    { name: "AbortError" }
  );
  assert.equal(calls, 1);
});
