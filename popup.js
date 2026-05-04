"use strict";

const pre = /** @type {HTMLPreElement} */ (document.getElementById("log"));

async function refresh() {
  if (!pre) return;

  try {
    const lines = await bdsmDebugLogGetLines();

    pre.textContent = lines.length ? lines.join("\n") : "(empty — trigger a tab move or open options to generate events)";
  } catch (e) {
    pre.textContent = String(e instanceof Error ? e.message : e);
  }
}

document.getElementById("btn-refresh")?.addEventListener("click", () => {
  void refresh();
});

document.getElementById("btn-clear")?.addEventListener("click", () => {
  void bdsmDebugLogClear().then(() => refresh());
});

void refresh();

bdsmDebugLog("popup", "popup.opened", {});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !Object.prototype.hasOwnProperty.call(changes, BDSM_DEBUG_LOG_KEY)) {
    return;
  }

  void refresh();
});
