"use strict";

/**
 * Master switch for BDSM debug / strip-order event logging.
 * Logs go to: (1) this page’s DevTools console if open, (2) `chrome.storage.local` ring buffer viewable from the toolbar popup.
 */
var BDSM_DEBUG_LOG_ENABLED = false;

const BDSM_DEBUG_LOG_KEY = "bdsmDebugEventLog";

const BDSM_DEBUG_LOG_MAX_LINES = 500;

let bdsmDebugLogSeq = 0;

let bdsmDebugLogWriteChain = Promise.resolve();

/**
 * @param {unknown} detail
 */
function bdsmSerializeDetail(detail) {
  if (detail === undefined) {
    return "";
  }

  try {
    if (typeof detail !== "object" || detail === null) {
      return String(detail);
    }

    return JSON.stringify(detail);
  } catch {
    return "[unserializable detail]";
  }
}

/**
 * @param {"bg"|"options"|"popup"} source
 * @param {string} event
 * @param {Record<string, unknown> | undefined} detail
 */
function bdsmDebugLog(source, event, detail) {
  if (!BDSM_DEBUG_LOG_ENABLED) {
    return;
  }

  const id = ++bdsmDebugLogSeq;

  const ts = new Date().toISOString();

  if (detail !== undefined) {
    console.log(`[BDSM #${id} ${ts} ${source}] ${event}`, detail);
  } else {
    console.log(`[BDSM #${id} ${ts} ${source}] ${event}`);
  }

  const line =
    `[#${id} ${ts}] [${source}] ${event}` + (detail !== undefined ? ` ${bdsmSerializeDetail(detail)}` : "");

  bdsmDebugLogWriteChain = bdsmDebugLogWriteChain
    .then(async () => {
      const data = await chrome.storage.local.get(BDSM_DEBUG_LOG_KEY);

      const prev = Array.isArray(data[BDSM_DEBUG_LOG_KEY]) ? data[BDSM_DEBUG_LOG_KEY] : [];

      prev.push(line);

      while (prev.length > BDSM_DEBUG_LOG_MAX_LINES) {
        prev.shift();
      }

      await chrome.storage.local.set({ [BDSM_DEBUG_LOG_KEY]: prev });
    })
    .catch(() => {});
}

async function bdsmDebugLogGetLines() {
  const data = await chrome.storage.local.get(BDSM_DEBUG_LOG_KEY);

  return Array.isArray(data[BDSM_DEBUG_LOG_KEY]) ? data[BDSM_DEBUG_LOG_KEY] : [];
}

async function bdsmDebugLogClear() {
  await chrome.storage.local.remove(BDSM_DEBUG_LOG_KEY);

  bdsmDebugLogSeq = 0;
}
