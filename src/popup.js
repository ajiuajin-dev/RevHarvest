const elements = {
  status: document.querySelector("#status"),
  progress: document.querySelector("#progress"),
  count: document.querySelector("#count"),
  warning: document.querySelector("#warning"),
  start: document.querySelector("#start"),
  cancel: document.querySelector("#cancel"),
  csv: document.querySelector("#csv"),
  json: document.querySelector("#json")
};

let activeTab = null;

elements.start.addEventListener("click", async () => {
  const tab = await getActiveTab();
  const response = await chrome.runtime.sendMessage({ type: "START", tabId: tab.id, url: tab.url });
  if (!response.ok) showError(response.error);
  await refresh();
});

elements.cancel.addEventListener("click", async () => {
  const tab = await getActiveTab();
  await chrome.runtime.sendMessage({ type: "CANCEL", tabId: tab.id });
  await refresh();
});

elements.csv.addEventListener("click", () => exportFormat("csv"));
elements.json.addEventListener("click", () => exportFormat("json"));

async function exportFormat(format) {
  const response = await chrome.runtime.sendMessage({ type: "EXPORT", format });
  if (!response.ok) showError(response.error);
}

async function refresh() {
  activeTab = await getActiveTab();
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  render(response.state);
}

function render(state) {
  if (!state || state.url !== activeTab?.url) {
    elements.status.textContent = "Ready";
    elements.count.textContent = "0 reviews";
    setStaticProgress(0);
    setButtons(false, false);
    return;
  }
  elements.status.textContent = statusLabel(state.status);
  elements.count.textContent = state.expectedTotal === null
    ? `${state.loaded} unique reviews`
    : `${state.loaded} / ${state.expectedTotal} unique reviews`;
  if (state.expectedTotal) {
    elements.progress.max = state.expectedTotal;
    elements.progress.value = Math.min(state.loaded, state.expectedTotal);
  } else if (state.status === "running") {
    elements.progress.removeAttribute("value");
  } else {
    setStaticProgress(state.status === "finished" ? 1 : 0);
  }
  const incomplete = state.status === "finished" && state.completeness !== "complete";
  elements.warning.hidden = !incomplete && !state.error;
  elements.warning.textContent = state.error || (incomplete
    ? "Finished, but completeness could not be confirmed."
    : "");
  setButtons(state.status === "running", state.loaded > 0);
}

function setStaticProgress(value) {
  elements.progress.max = 1;
  elements.progress.value = value;
}

function setButtons(running, canExport) {
  elements.start.disabled = running;
  elements.cancel.disabled = !running;
  elements.csv.disabled = !canExport;
  elements.json.disabled = !canExport;
}

function statusLabel(status) {
  return ({
    running: "Collecting reviews...",
    finished: "Collection finished",
    cancelled: "Cancelled — progress saved",
    failed: "Collection failed — progress saved"
  })[status] ?? "Ready";
}

function showError(message) {
  elements.warning.hidden = false;
  elements.warning.textContent = message;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");
  return tab;
}

refresh();
setInterval(refresh, 750);
