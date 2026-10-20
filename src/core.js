const FORMULA_PREFIX = /^[=+\-@]/;

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeReview(input) {
  return {
    id: normalizeText(input.id),
    author: normalizeText(input.author),
    rating: Number.isFinite(Number(input.rating)) ? Number(input.rating) : null,
    date: normalizeText(input.date),
    text: normalizeText(input.text),
    variant: normalizeText(input.variant),
    likes: Number.isFinite(Number(input.likes)) ? Number(input.likes) : null,
    images: Array.isArray(input.images)
      ? [...new Set(input.images.map(normalizeText).filter(Boolean))]
      : [],
    sourceUrl: normalizeText(input.sourceUrl)
  };
}

export function fingerprint(review) {
  const normalized = normalizeReview(review);
  const source = [
    normalized.author,
    normalized.rating ?? "",
    normalized.date,
    normalized.text,
    normalized.variant,
    normalized.images.join("|")
  ].join("\u241f");

  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fp_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function reviewKey(review) {
  const id = normalizeText(review.id);
  return id ? `id_${id}` : fingerprint(review);
}

export function mergeReviews(existing, incoming) {
  const byKey = new Map();
  for (const candidate of [...existing, ...incoming]) {
    const normalized = normalizeReview(candidate);
    const key = reviewKey(normalized);
    const previous = byKey.get(key);
    byKey.set(key, previous ? mergeRecord(previous, normalized) : normalized);
  }
  return [...byKey.values()];
}

function mergeRecord(previous, next) {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (Array.isArray(value)) {
      merged[key] = [...new Set([...(previous[key] ?? []), ...value])];
    } else if (value !== "" && value !== null) {
      merged[key] = value;
    }
  }
  return merged;
}

export function safeSpreadsheetCell(value) {
  const text = Array.isArray(value) ? value.join(" | ") : String(value ?? "");
  return FORMULA_PREFIX.test(text.trimStart()) ? `'${text}` : text;
}

export function parseExactReviewTotal(value) {
  const text = normalizeText(value).replace(/,/g, "");
  const match = text.match(/(?:review|评价|评论|avis|reseña)[^0-9]{0,12}(\d+)(\+)?/i)
    ?? text.match(/(\d+)(\+)?[^0-9]{0,12}(?:review|评价|评论|avis|reseña)/i);
  return match && !match[2] ? Number(match[1]) : null;
}

export function toCsv(reviews) {
  const fields = ["id", "author", "rating", "date", "text", "variant", "likes", "images", "sourceUrl"];
  const escape = (value) => {
    const safe = safeSpreadsheetCell(value).replace(/"/g, '""');
    return /[",\r\n]/.test(safe) ? `"${safe}"` : safe;
  };
  const rows = reviews.map((review) => fields.map((field) => escape(review[field])).join(","));
  return `\uFEFF${fields.join(",")}\r\n${rows.join("\r\n")}`;
}

export function toJson(reviews, metadata = {}) {
  return JSON.stringify({ metadata, reviews }, null, 2);
}

export function isSupportedSheinProductUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && /(^|\.)shein\.com$/i.test(parsed.hostname)
      && /-(?:p|review)-\d+\.html$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function extractSheinProductId(value) {
  try {
    const parsed = new URL(value);
    return parsed.pathname.match(/-(?:p|review)-(\d+)\.html$/i)?.[1] ?? "product";
  } catch {
    return "product";
  }
}

export function createCollectionState({ tabId, url, now = Date.now() }) {
  return {
    tabId,
    url,
    status: "running",
    reviews: [],
    loaded: 0,
    expectedTotal: null,
    completeness: "unverified",
    endConfirmed: false,
    completionReason: "",
    iteration: 0,
    error: "",
    startedAt: now,
    updatedAt: now
  };
}

export function resumeCollectionState(state, { tabId, now = Date.now() }) {
  return {
    ...state,
    tabId,
    status: "running",
    error: "",
    updatedAt: now
  };
}

export function applyCollectionBatch(state, batch, now = Date.now()) {
  const reviews = mergeReviews(state.reviews ?? [], batch.reviews ?? []);
  return {
    ...state,
    reviews,
    loaded: reviews.length,
    expectedTotal: Number.isFinite(batch.expectedTotal)
      ? batch.expectedTotal
      : state.expectedTotal,
    iteration: Number(batch.iteration ?? state.iteration ?? 0),
    updatedAt: now
  };
}

export function finishCollectionState(state, finalBatch = {}, now = Date.now()) {
  const next = applyCollectionBatch(state, finalBatch, now);
  const endConfirmed = finalBatch.endConfirmed === true;
  return {
    ...next,
    status: "finished",
    completeness: endConfirmed ? "complete" : calculateCompleteness(next.loaded, next.expectedTotal),
    endConfirmed,
    completionReason: normalizeText(finalBatch.completionReason),
    updatedAt: now
  };
}

export function calculateCompleteness(loaded, expectedTotal) {
  if (!Number.isFinite(expectedTotal)) return "unverified";
  return loaded === expectedTotal ? "complete" : "partial";
}

export async function collectPages({
  fetchPage,
  checkpoint = async () => {},
  resume = {},
  signal,
  maxRetries = 3,
  baseDelayMs = 5,
  minIntervalMs = 350,
  sleep = delay
}) {
  let cursor = resume.cursor ?? null;
  let reviews = mergeReviews([], resume.reviews ?? []);
  let pages = Number(resume.pages ?? 0);
  let expectedTotal = Number.isFinite(resume.expectedTotal) ? resume.expectedTotal : null;

  while (true) {
    if (signal?.aborted) throw abortError();
    const page = await retry(() => fetchPage({ cursor, signal }), {
      signal,
      maxRetries,
      baseDelayMs,
      sleep
    });
    pages += 1;
    reviews = mergeReviews(reviews, page.reviews ?? []);
    if (Number.isFinite(page.expectedTotal)) expectedTotal = page.expectedTotal;
    cursor = page.nextCursor ?? null;
    await checkpoint({ cursor, reviews, pages, expectedTotal });
    if (!cursor) {
      return {
        cursor,
        reviews,
        pages,
        expectedTotal,
        completeness: expectedTotal === null
          ? "unverified"
          : reviews.length === expectedTotal
            ? "complete"
            : "partial"
      };
    }
    await sleep(minIntervalMs, signal);
  }
}

export async function retry(action, {
  signal,
  maxRetries = 3,
  baseDelayMs = 100,
  sleep = delay
} = {}) {
  let attempt = 0;
  while (true) {
    if (signal?.aborted) throw abortError();
    try {
      return await action(attempt);
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (attempt >= maxRetries || error?.retryable === false) throw error;
      const retryAfterMs = Number(error?.retryAfterMs);
      const waitMs = Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? retryAfterMs
        : baseDelayMs * 2 ** attempt;
      await sleep(waitMs, signal);
      attempt += 1;
    }
  }
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

function abortError() {
  return new DOMException("The operation was cancelled", "AbortError");
}
