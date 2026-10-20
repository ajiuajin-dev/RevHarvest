import {
  applyCollectionBatch,
  createCollectionState,
  finishCollectionState,
  extractSheinProductId,
  isSupportedSheinProductUrl,
  resumeCollectionState,
  toCsv,
  toJson
} from "./core.js";

const STATE_KEY = "reviewExportState";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "START":
      return startCollection(message.tabId, message.url);
    case "BATCH":
      return updateFromBatch(message, sender.tab?.id);
    case "FINISH":
      return finishCollection(message, sender.tab?.id);
    case "FAIL":
      return failCollection(message, sender.tab?.id);
    case "GET_STATE":
      return { ok: true, state: await getState() };
    case "CANCEL":
      return cancelCollection(message.tabId);
    case "EXPORT":
      return exportReviews(message.format);
    case "RESET":
      await chrome.storage.local.remove(STATE_KEY);
      return { ok: true };
    default:
      throw new Error("Unknown message type");
  }
}

async function startCollection(tabId, url) {
  if (!isSupportedSheinProductUrl(url)) throw new Error("Open a supported HTTPS SHEIN product or review page first.");
  const previous = await getState();
  const resume = previous?.url === url && ["failed", "cancelled", "running"].includes(previous.status);
  const state = resume
    ? resumeCollectionState(previous, { tabId })
    : createCollectionState({ tabId, url });
  await setState(state);
  await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content.js"] });
  await chrome.tabs.sendMessage(tabId, { type: "COLLECT", resumeCount: state.reviews.length });
  return { ok: true, state };
}

async function updateFromBatch(message, tabId) {
  const state = await requireState(tabId);
  if (state.status !== "running") return { ok: true, ignored: true };
  const next = applyCollectionBatch(state, message);
  await setState(next);
  return { ok: true, count: next.loaded };
}

async function finishCollection(message, tabId) {
  const state = await requireState(tabId);
  const next = finishCollectionState(state, message);
  await setState(next);
  return { ok: true, state: next };
}

async function failCollection(message, tabId) {
  const state = await requireState(tabId);
  state.status = "failed";
  state.error = String(message.error ?? "Collection failed");
  state.updatedAt = Date.now();
  await setState(state);
  return { ok: true };
}

async function cancelCollection(tabId) {
  const state = await getState();
  if (!state || state.tabId !== tabId) return { ok: true };
  state.status = "cancelled";
  state.updatedAt = Date.now();
  await setState(state);
  try {
    await chrome.tabs.sendMessage(tabId, { type: "CANCEL_COLLECTION" });
  } catch {
    // The page may already be closed. Persisted progress is still recoverable.
  }
  return { ok: true, state };
}

async function exportReviews(format) {
  const state = await getState();
  if (!state?.reviews?.length) throw new Error("No reviews are available to export.");
  const metadata = {
    sourceUrl: state.url,
    exportedAt: new Date().toISOString(),
    expectedTotal: state.expectedTotal,
    exportedUnique: state.reviews.length,
    completeness: state.completeness,
    endConfirmed: state.endConfirmed === true,
    completionReason: state.completionReason || ""
  };
  const normalizedFormat = format === "json" ? "json" : "csv";
  const contents = normalizedFormat === "json"
    ? toJson(state.reviews, metadata)
    : toCsv(state.reviews);
  const mime = normalizedFormat === "json" ? "application/json" : "text/csv";
  const url = `data:${mime};charset=utf-8,${encodeURIComponent(contents)}`;
  const productId = extractSheinProductId(state.url);
  await chrome.downloads.download({
    url,
    filename: `shein-reviews-${productId}.${normalizedFormat}`,
    saveAs: true
  });
  return { ok: true };
}

async function requireState(tabId) {
  const state = await getState();
  if (!state || state.tabId !== tabId) throw new Error("No active collection for this tab.");
  return state;
}

async function getState() {
  return (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] ?? null;
}

async function setState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}
