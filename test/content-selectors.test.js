import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/content.js", import.meta.url), "utf8");
const popupSource = await readFile(new URL("../src/popup.js", import.meta.url), "utf8");

test("content collector recognizes the current SHEIN review card structure", () => {
  assert.match(source, /common-reviews-new__list-item/);
  assert.match(source, /\.rate-des/);
  assert.match(source, /\.nikename/);
  assert.match(source, /\.sui-pagination|pagination/);
  assert.match(source, /findCardsFromReviewAnchors/);
});

test("review total detection is bounded and does not scan whole review containers", () => {
  assert.match(source, /text\.length > 120/);
  assert.doesNotMatch(source, /querySelectorAll\("h1, h2, h3, button, \[role='tab'\], \[class\*='review'\]"\)/);
});

test("collector only treats genuinely scrollable containers as review surfaces", () => {
  assert.match(source, /getComputedStyle\(element\)\.overflowY/);
  assert.match(source, /\(auto\|scroll\)/);
  assert.doesNotMatch(source, /target\.scrollHeight > target\.clientHeight;/);
});

test("collector treats the visible no-more-reviews marker as a confirmed end", () => {
  assert.match(source, /hasNoMoreReviewsMarker/);
  assert.match(source, /no more reviews/);
  assert.match(source, /no-more-reviews-marker/);
  assert.match(source, /endConfirmed/);
});

test("popup only uses indeterminate progress while collection is running", () => {
  assert.match(popupSource, /state\.status === "running"/);
  assert.match(popupSource, /setStaticProgress\(state\.status === "finished" \? 1 : 0\)/);
  assert.match(popupSource, /setStaticProgress\(0\)/);
});
