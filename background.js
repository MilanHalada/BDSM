importScripts("debug-log.js");
importScripts("group-utils.js");

const LAST_ACTIVE_GROUP_KEY = "lastActiveGroupByWindow";

const AUTO_GROUP_RULES_KEY = "autoGroupRules";

const GROUP_TITLE_DISPLAY_KEY = "groupTitleDisplay";

const GROUP_BASE_TITLES_KEY = "groupBaseTitles";

const ALLOWED_TAB_GROUP_COLORS = new Set(["grey", "blue", "red", "yellow", "green", "cyan", "purple", "pink", "orange"]);

/**
 * Background strip-order / sync events (also persisted for the toolbar popup — see `debug-log.js`).
 *
 * @param {string} event
 * @param {Record<string, unknown> | undefined} detail
 */
function stripLog(event, detail) {
  bdsmDebugLog("bg", event, detail);
}

/**
 * First-seen group id per left-to-right tab index (same idea as `sortGroupsByVisualTabOrder`).
 *
 * @param {chrome.tabs.Tab[]} windowTabs
 * @returns {{ groupId: number, firstTabIndex: number }[]}
 */
function tabStripGroupOrderSnapshot(windowTabs) {
  const sorted = [...windowTabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  /** @type {{ groupId: number, firstTabIndex: number }[]} */
  const out = [];

  /** @type {Set<number>} */
  const seen = new Set();

  for (const t of sorted) {
    const gid = t.groupId;

    if (gid == null || gid < 0) {
      continue;
    }

    if (seen.has(gid)) {
      continue;
    }

    seen.add(gid);

    out.push({ groupId: gid, firstTabIndex: t.index ?? 0 });
  }

  return out;
}

let mutationQueueTail = Promise.resolve();

function enqueueMutation(task) {
  mutationQueueTail = mutationQueueTail
    .then(() => task())
    .catch(() => {})
    .then(() => undefined);
}

function withLock(task) {
  enqueueMutation(task);
}

async function getWindowGroups(windowId) {
  const [groups, tabs] = await Promise.all([
    chrome.tabGroups.query({ windowId }),
    chrome.tabs.query({ windowId })
  ]);

  return sortGroupsByVisualTabOrder(groups, tabs);
}

async function loadGroupTitleDisplay() {
  const data = await chrome.storage.local.get(GROUP_TITLE_DISPLAY_KEY);

  const raw = data[GROUP_TITLE_DISPLAY_KEY];

  const o = typeof raw === "object" && raw !== null ? raw : {};

  return {
    showOrderInChromeTitle: o.showOrderInChromeTitle !== false,
    showTabCountInChromeTitle: o.showTabCountInChromeTitle !== false
  };
}

async function loadGroupBaseTitlesMap() {
  const data = await chrome.storage.local.get(GROUP_BASE_TITLES_KEY);

  const raw = data[GROUP_BASE_TITLES_KEY];

  return typeof raw === "object" && raw !== null ? { ...raw } : {};
}

/**
 * @param {number} groupId
 * @param {string} base
 */
async function persistGroupBaseTitle(groupId, base) {
  const prev = await chrome.storage.local.get(GROUP_BASE_TITLES_KEY);

  const map = { ...(typeof prev[GROUP_BASE_TITLES_KEY] === "object" && prev[GROUP_BASE_TITLES_KEY] !== null
    ? prev[GROUP_BASE_TITLES_KEY]
    : {}) };

  map[String(groupId)] = String(base ?? "").trim();

  await chrome.storage.local.set({ [GROUP_BASE_TITLES_KEY]: map });
}

/**
 * @param {chrome.tabGroups.TabGroup} group
 * @param {Record<string, string>} baseMap
 */
function resolveBaseTitleForGroup(group, baseMap) {
  const k = String(group.id);

  if (Object.prototype.hasOwnProperty.call(baseMap, k)) {
    const v = baseMap[k];

    if (typeof v === "string" && v.trim()) return v.trim();
  }

  return inferBaseFromDecoratedTitle(group.title);
}

/** Non-zero during programmatic tabGroups.update batches (titles + collapse) — ignore noisy onUpdated churn. */
let suppressTabGroupsOnUpdatedDepth = 0;

/**
 * Snapshot of collapsed state (survives service worker restarts via chrome.storage.session).
 * @type {Map<number, boolean>}
 */
const lastCollapsedByGroupId = new Map();

const COLLAPSED_SNAPSHOT_SESSION_KEY = "bdsmLastCollapsedByGroup";

async function loadCollapsedSnapshotFromSession() {
  try {
    const d = await chrome.storage.session.get(COLLAPSED_SNAPSHOT_SESSION_KEY);

    const raw = d[COLLAPSED_SNAPSHOT_SESSION_KEY];

    if (!raw || typeof raw !== "object") {
      return;
    }

    lastCollapsedByGroupId.clear();

    for (const [k, v] of Object.entries(raw)) {
      const id = Number(k);

      if (Number.isFinite(id)) {
        lastCollapsedByGroupId.set(id, Boolean(v));
      }
    }
  } catch {
    //
  }
}

async function saveCollapsedSnapshotToSession() {
  try {
    const o = Object.fromEntries(lastCollapsedByGroupId);

    await chrome.storage.session.set({ [COLLAPSED_SNAPSHOT_SESSION_KEY]: o });
  } catch {
    //
  }
}

/**
 * Queue a title renumbering pass for this window. Uses the global mutation queue instead of setTimeout:
 * MV3 service workers can terminate before a timer fires (see Extension service worker lifecycle).
 *
 * @param {number} windowId
 */
function requestTitleSyncForWindow(windowId) {
  const wid = Number(windowId);

  if (!Number.isFinite(wid)) return;

  withLock(async () => {
    await syncDecoratedTitlesForWindow(wid);
  });
}

/** After strip moves Chrome may briefly report stale tab indices; coalesce passes and delay one read cycle. */
const MOVE_TITLE_SYNC_DEBOUNCE_MS = 500;

/** Bumped when discarding pending debounced work (e.g. options preset sync) so stale passes skip. */
let moveTitleSyncGeneration = 0;

/** @type {ReturnType<typeof setTimeout>|null} */
let moveTitleSyncTimer = null;

/** @type {Set<number>} */
const moveTitleSyncPendingWindows = new Set();

function flushPendingDebouncedMoveTitleSync() {
  const hadTimer = moveTitleSyncTimer != null;

  const pendingBefore = moveTitleSyncPendingWindows.size;

  if (moveTitleSyncTimer != null) {
    clearTimeout(moveTitleSyncTimer);

    moveTitleSyncTimer = null;
  }

  moveTitleSyncPendingWindows.clear();

  moveTitleSyncGeneration += 1;

  stripLog("debounce.flush", {
    hadTimer,
    pendingWindowsCleared: pendingBefore,
    generation: moveTitleSyncGeneration
  });
}

/**
 * Debounced renumber for tab/group moves — avoids stale `tabs.query` right after reorder.
 *
 * @param {number} windowId
 * @param {string} [reason] Listener source (for `[BDSM]` event log).
 */
function requestDebouncedTitleSyncAfterMove(windowId, reason) {
  const wid = Number(windowId);

  if (!Number.isFinite(wid)) return;

  moveTitleSyncPendingWindows.add(wid);

  if (moveTitleSyncTimer != null) {
    clearTimeout(moveTitleSyncTimer);
  }

  stripLog("debounce.schedule", {
    reason: reason ?? "move",
    windowId: wid,
    pendingWindowIds: [...moveTitleSyncPendingWindows],
    delayMs: MOVE_TITLE_SYNC_DEBOUNCE_MS,
    generation: moveTitleSyncGeneration
  });

  moveTitleSyncTimer = setTimeout(() => {
    moveTitleSyncTimer = null;

    const batch = [...moveTitleSyncPendingWindows];

    moveTitleSyncPendingWindows.clear();

    if (!batch.length) {
      stripLog("debounce.fireEmpty", { generation: moveTitleSyncGeneration });

      return;
    }

    const firedGen = moveTitleSyncGeneration;

    stripLog("debounce.fire", { windowIds: batch, firedGen, currentGen: moveTitleSyncGeneration });

    withLock(async () => {
      if (firedGen !== moveTitleSyncGeneration) {
        stripLog("debounce.skipSuperseded", { firedGen, currentGen: moveTitleSyncGeneration, windowIds: batch });

        return;
      }

      for (const w of batch) {
        if (firedGen !== moveTitleSyncGeneration) {
          stripLog("debounce.skipSupersededMidBatch", { firedGen, currentGen: moveTitleSyncGeneration, atWindow: w });

          return;
        }

        await syncDecoratedTitlesForWindow(w);
      }
    });
  }, MOVE_TITLE_SYNC_DEBOUNCE_MS);
}

/**
 * @param {number} windowId
 * @param {number[] | undefined} orderedGroupIds When set (e.g. after options-page drag), numbering matches this strip order instead of querying tab indices.
 */
async function syncDecoratedTitlesForWindowUnchecked(windowId, orderedGroupIds) {
  const syncT0 =
    typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : null;

  const [display, baseRaw, tabs, groupsRaw] = await Promise.all([
    loadGroupTitleDisplay(),
    chrome.storage.local.get(GROUP_BASE_TITLES_KEY),
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId })
  ]);

  const baseMap =
    typeof baseRaw[GROUP_BASE_TITLES_KEY] === "object" && baseRaw[GROUP_BASE_TITLES_KEY] !== null
      ? { ...baseRaw[GROUP_BASE_TITLES_KEY] }
      : {};

  /** @type {chrome.tabGroups.TabGroup[]} */
  let groups;

  if (Array.isArray(orderedGroupIds) && orderedGroupIds.length > 0) {
    const byId = new Map(groupsRaw.map((g) => [g.id, g]));

    const primary = [];

    const seenIds = /** @type {Set<number>} */ (new Set());

    for (const rawId of orderedGroupIds) {
      const gid = Number(rawId);

      const g = Number.isFinite(gid) ? byId.get(gid) : undefined;

      if (g == null || seenIds.has(g.id)) continue;

      seenIds.add(g.id);

      primary.push(g);
    }

    const restSorted = sortGroupsByVisualTabOrder(
      groupsRaw.filter((g) => !seenIds.has(g.id)),
      tabs
    );

    groups = [...primary, ...restSorted];
  } else {

    groups = sortGroupsByVisualTabOrder(groupsRaw, tabs);

  }

  if (BDSM_DEBUG_LOG_ENABLED) {
    const tabStripSnap = tabStripGroupOrderSnapshot(tabs);

    const presetActive = Array.isArray(orderedGroupIds) && orderedGroupIds.length > 0;

    stripLog("sync.start", {
      windowId,
      presetActive,
      presetGroupIds: presetActive ? orderedGroupIds.slice() : null,
      tabCount: tabs.length,
      tabStripSnapshot: tabStripSnap,
      resolvedGroupIds: groups.map((g) => g.id),
      chromeTitlesBefore: groups.map((g) => ({ id: g.id, title: g.title ?? "" }))
    });
  }

  const countByGid = /** @type {Map<number, number>} */ new Map();

  for (const t of tabs) {
    const gid = t.groupId;

    if (gid == null || gid < 0) continue;

    countByGid.set(gid, (countByGid.get(gid) ?? 0) + 1);
  }

  let mapDirty = false;

  let order = 0;

  const ops = [];

  for (const g of groups) {
    order += 1;

    const gidKey = String(g.id);

    let base = typeof baseMap[gidKey] === "string" ? baseMap[gidKey].trim() : "";

    if (!base) {
      base = inferBaseFromDecoratedTitle(g.title);

      if (!base) base = "Untitled";

      baseMap[gidKey] = base;

      mapDirty = true;
    }

    const cnt = countByGid.get(g.id) ?? 0;

    const nextTitle = formatBdsmGroupTitle(
      order,
      base,
      cnt,
      display.showOrderInChromeTitle,
      display.showTabCountInChromeTitle
    );

    if ((g.title ?? "") !== nextTitle) {
      ops.push(chrome.tabGroups.update(g.id, { title: nextTitle }));
    }
  }

  if (mapDirty) {
    await chrome.storage.local.set({ [GROUP_BASE_TITLES_KEY]: baseMap });
  }

  if (ops.length) {
    await Promise.all(ops);
  }

  if (BDSM_DEBUG_LOG_ENABLED) {
    const elapsedMs =
      syncT0 != null && typeof performance !== "undefined" && typeof performance.now === "function"
        ? +(performance.now() - syncT0).toFixed(2)
        : null;

    /** @type {{ ordinal: number, id: number, previousTitle: string, nextTitle: string, wouldUpdate: boolean }[]} */
    const perGroupTitles = [];

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];

      const ordinal = i + 1;

      const oid = String(g.id);

      let base = typeof baseMap[oid] === "string" ? baseMap[oid].trim() : "";

      if (!base) base = inferBaseFromDecoratedTitle(g.title);

      if (!base) base = "Untitled";

      const cnt = countByGid.get(g.id) ?? 0;

      const nextTitle = formatBdsmGroupTitle(
        ordinal,
        base,
        cnt,
        display.showOrderInChromeTitle,
        display.showTabCountInChromeTitle
      );

      perGroupTitles.push({
        ordinal,
        id: g.id,
        previousTitle: g.title ?? "",
        nextTitle,
        wouldUpdate: (g.title ?? "") !== nextTitle
      });
    }

    stripLog("sync.done", {
      windowId,
      elapsedMs,
      chromeTabGroupWrites: ops.length,
      persistedBaseMap: mapDirty,
      perGroupTitles
    });
  }
}

/**
 * @param {number} windowId
 * @param {number[] | undefined} orderedGroupIds
 */
async function syncDecoratedTitlesForWindow(windowId, orderedGroupIds) {
  suppressTabGroupsOnUpdatedDepth += 1;

  try {
    await syncDecoratedTitlesForWindowUnchecked(windowId, orderedGroupIds);
  } finally {
    suppressTabGroupsOnUpdatedDepth -= 1;
  }
}

/**
 * @param {number | undefined} presetWindowId
 * @param {number[] | undefined} presetOrderedGroupIds
 */
async function syncDecoratedTitlesAllWindows(presetWindowId, presetOrderedGroupIds) {
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });

  if (BDSM_DEBUG_LOG_ENABLED) {
    stripLog("sync.allWindows.enter", {
      normalWindowIds: wins.map((w) => w.id ?? null),
      presetWindowId: presetWindowId ?? null,
      presetGroupIds:
        presetWindowId != null &&
        Array.isArray(presetOrderedGroupIds) &&
        presetOrderedGroupIds.length > 0
          ? [...presetOrderedGroupIds]
          : null
    });
  }

  suppressTabGroupsOnUpdatedDepth += 1;

  try {
    const usePresetIds =
      typeof presetWindowId === "number" &&
      Number.isFinite(presetWindowId) &&
      Array.isArray(presetOrderedGroupIds) &&
      presetOrderedGroupIds.length > 0
        ? presetOrderedGroupIds
        : undefined;

    for (const w of wins) {
      if (w.id != null) {
        const preset = usePresetIds != null && w.id === presetWindowId ? usePresetIds : undefined;

        await syncDecoratedTitlesForWindowUnchecked(w.id, preset);
      }
    }
  } finally {
    suppressTabGroupsOnUpdatedDepth -= 1;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "bdsm-sync-group-titles") {
    return undefined;
  }

  stripLog("message.syncGroupTitles.recv", {
    stripOrderWindowId: message.stripOrderWindowId ?? null,
    stripGroupIds: Array.isArray(message.stripGroupIds) ? [...message.stripGroupIds] : null
  });

  flushPendingDebouncedMoveTitleSync();

  withLock(async () => {
    const pw =
      typeof message.stripOrderWindowId === "number" && Number.isFinite(message.stripOrderWindowId)
        ? message.stripOrderWindowId
        : undefined;

    const pidsRaw = message.stripGroupIds;

    const pids =
      Array.isArray(pidsRaw) && pidsRaw.length > 0
        ? pidsRaw.map((/** @type {*} */ x) => Number(x)).filter((n) => Number.isFinite(n))
        : undefined;

    await syncDecoratedTitlesAllWindows(pw, pids);

    sendResponse({ ok: true });
  });

  return true;
});

async function getTabsInGroup(windowId, groupId) {
  const tabs = await chrome.tabs.query({ windowId, groupId });

  return tabs.sort((a, b) => a.index - b.index);
}

async function setStoredActiveGroup(windowId, groupId) {
  const data = await chrome.storage.local.get(LAST_ACTIVE_GROUP_KEY);

  const map = data[LAST_ACTIVE_GROUP_KEY] || {};

  map[String(windowId)] = groupId;

  await chrome.storage.local.set({ [LAST_ACTIVE_GROUP_KEY]: map });
}

async function getStoredActiveGroup(windowId) {
  const data = await chrome.storage.local.get(LAST_ACTIVE_GROUP_KEY);

  const map = data[LAST_ACTIVE_GROUP_KEY] || {};

  return typeof map[String(windowId)] === "number" ? map[String(windowId)] : null;
}

async function primeCollapsedSnapshotsAllWindows() {
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });

  for (const w of wins) {
    if (!w.id) continue;

    try {
      const groups = await chrome.tabGroups.query({ windowId: w.id });

      for (const g of groups) {
        if (typeof g.collapsed === "boolean") {
          lastCollapsedByGroupId.set(g.id, g.collapsed);
        }
      }
    } catch {
      //
    }
  }

  await saveCollapsedSnapshotToSession();
}

async function collapseAllExcept(windowId, activeGroupId) {
  suppressTabGroupsOnUpdatedDepth += 1;

  try {
    const groups = await getWindowGroups(windowId);

    await Promise.all(groups.map((group) => chrome.tabGroups.update(group.id, { collapsed: group.id !== activeGroupId })));

    for (const g of groups) {
      lastCollapsedByGroupId.set(g.id, g.id !== activeGroupId);
    }

    await saveCollapsedSnapshotToSession();
  } finally {
    suppressTabGroupsOnUpdatedDepth -= 1;
  }
}

async function activateWorkspace(windowId, groupId, focusFirstTab = true) {
  const tabs = await getTabsInGroup(windowId, groupId);

  if (!tabs.length) {
    return;
  }

  await collapseAllExcept(windowId, groupId);

  await setStoredActiveGroup(windowId, groupId);

  if (focusFirstTab) {
    const refreshed = await getTabsInGroup(windowId, groupId);

    if (refreshed.length) {
      await chrome.tabs.update(refreshed[0].id, { active: true });
    }
  }
}

async function activateByStep(windowId, direction) {
  const groups = await getWindowGroups(windowId);

  if (!groups.length) {
    return;
  }

  const activeTab = await chrome.tabs.query({ windowId, active: true });

  const currentGroupId = activeTab[0]?.groupId >= 0 ? activeTab[0].groupId : null;

  let currentIndex = groups.findIndex((group) => group.id === currentGroupId);

  if (currentIndex === -1) {
    const stored = await getStoredActiveGroup(windowId);

    currentIndex = groups.findIndex((group) => group.id === stored);
  }

  if (currentIndex === -1) {
    currentIndex = 0;
  }

  const nextIndex = (currentIndex + direction + groups.length) % groups.length;

  await activateWorkspace(windowId, groups[nextIndex].id, true);
}

/**
 * Activate the Nth tab group left-to-right along the strip (1-based). Activates first tab in that group.
 * @param {number} windowId
 * @param {number} oneBasedIndex
 */
async function activateWorkspaceByOneBasedIndex(windowId, oneBasedIndex) {
  const groups = await getWindowGroups(windowId);

  if (!groups.length || oneBasedIndex < 1) {
    return;
  }

  const ix = oneBasedIndex - 1;

  if (ix >= groups.length) {
    return;
  }

  await activateWorkspace(windowId, groups[ix].id, true);
}

async function switchTabInsideActiveGroup(windowId, direction) {
  const activeTabs = await chrome.tabs.query({ windowId, active: true });

  const activeTab = activeTabs[0];

  if (!activeTab || activeTab.groupId < 0) {
    return;
  }

  const tabs = await getTabsInGroup(windowId, activeTab.groupId);

  if (tabs.length <= 1) {
    return;
  }

  const currentIndex = tabs.findIndex((tab) => tab.id === activeTab.id);

  if (currentIndex === -1) {
    return;
  }

  const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;

  await chrome.tabs.update(tabs[nextIndex].id, { active: true });
}

async function ensureSingleExpanded(windowId) {
  const groups = await getWindowGroups(windowId);

  if (!groups.length) {
    return;
  }

  const expanded = groups.filter((group) => !group.collapsed);

  let target = null;

  if (expanded.length > 0) {
    target = expanded[expanded.length - 1];
  } else {
    const activeTabs = await chrome.tabs.query({ windowId, active: true });

    const gid = activeTabs[0]?.groupId;

    if (gid >= 0) {
      target = groups.find((group) => group.id === gid) || null;
    }
  }

  if (!target) {
    const stored = await getStoredActiveGroup(windowId);

    target = groups.find((group) => group.id === stored) || groups[0];
  }

  await collapseAllExcept(windowId, target.id);

  await setStoredActiveGroup(windowId, target.id);
}

function coerceGroupColor(raw) {
  return typeof raw === "string" && ALLOWED_TAB_GROUP_COLORS.has(raw)
    ? /** @type {chrome.tabGroups.Color} */ (raw)
    : /** @type {chrome.tabGroups.Color} */ ("grey");
}

async function fetchAutoRules() {
  const data = await chrome.storage.local.get(AUTO_GROUP_RULES_KEY);

  const list = Array.isArray(data[AUTO_GROUP_RULES_KEY]) ? data[AUTO_GROUP_RULES_KEY] : [];

  const out = [];

  for (const rule of list) {
    if (typeof rule !== "object" || rule === null || rule.enabled === false) continue;

    if (typeof rule.regex !== "string") continue;

    let re = null;

    try {
      const pattern = typeof rule.regex === "string" ? rule.regex.trim() : "";

      if (!pattern) continue;

      re = new RegExp(pattern);
    } catch {
      console.warn("[BDSM] Ignoring rule with invalid regex:", rule.regex, rule?.name ? `(${rule.name})` : "");

      continue;
    }

    const targetTitle = typeof rule.targetGroupTitle === "string" ? rule.targetGroupTitle.trim() : "";

    if (!targetTitle) continue;

    const targetColor =
      typeof rule.targetColor === "string" ? coerceGroupColor(rule.targetColor) : coerceGroupColor(null);

    out.push({
      regex: re,
      regexText: typeof rule.regex === "string" ? rule.regex : "",
      targetTitle,
      targetColor
    });
  }

  return out;
}

function isHandledUrlCandidate(url) {
  if (!url || url.startsWith("chrome-extension://")) return false;

  try {
    const parsed = new URL(url);

    if (parsed.protocol === "chrome:") return false;

    if (parsed.protocol === "about:" || parsed.protocol === "edge:" || parsed.protocol === "devtools:") return false;

    return true;
  } catch {
    return false;
  }
}

async function applyMatchingAutoGroupRule(tabId) {
  const tab = await chrome.tabs.get(tabId);

  const urlCandidate = typeof tab.pendingUrl === "string" && tab.pendingUrl ? tab.pendingUrl : tab.url;

  if (!isHandledUrlCandidate(urlCandidate)) return;

  if (tab.windowId == null || tab.discarded === true) return;

  const rules = await fetchAutoRules();

  const baseMap = await loadGroupBaseTitlesMap();

  for (const rule of rules) {
    if (!rule.regex.test(urlCandidate)) continue;

    const windowId = /** @type {number} */ (tab.windowId);

    const groups = await chrome.tabGroups.query({ windowId });

    const targetNorm = String(rule.targetTitle ?? "").trim();

    const existing = groups.find((group) => resolveBaseTitleForGroup(group, baseMap) === targetNorm);

    if (existing) {
      if (tab.groupId !== existing.id) {
        try {
          await chrome.tabs.group({ tabIds: [tab.id], groupId: existing.id });
        } catch {
          return;
        }
      }

      await persistGroupBaseTitle(existing.id, targetNorm);

      await finalizeAutoGroupRuleTarget(windowId, existing.id, tab.id);

      return;
    }

    let newGroupId;

    try {
      newGroupId = await chrome.tabs.group({
        tabIds: [tab.id],
        createProperties: { windowId }
      });
    } catch {
      return;
    }

    await persistGroupBaseTitle(newGroupId, rule.targetTitle);

    try {
      await chrome.tabGroups.update(newGroupId, {
        color: rule.targetColor,
        collapsed: false
      });
    } catch {
      //
    }

    await finalizeAutoGroupRuleTarget(windowId, newGroupId, tab.id);

    return;
  }
}

async function finalizeAutoGroupRuleTarget(windowId, groupId, activateTabId) {
  try {
    if (typeof chrome.tabGroups?.move === "function") {
      await chrome.tabGroups.move(groupId, { windowId, index: -1 });
    }
  } catch {
    //
  }

  await collapseAllExcept(windowId, groupId);

  await setStoredActiveGroup(windowId, groupId);

  try {
    await chrome.tabs.update(activateTabId, { active: true });
  } catch {
    const fallback = await getTabsInGroup(windowId, groupId);

    if (fallback.length) await chrome.tabs.update(fallback[0].id, { active: true });
  }

  await syncDecoratedTitlesForWindow(windowId);
}

chrome.commands.onCommand.addListener((command) => {
  withLock(async () => {
    const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });

    if (!window?.id) {
      return;
    }

    if (command.startsWith("switch-workspace-")) {

      let slot = 0;

      if (command === "switch-workspace-0") {

        slot = 10;

      } else {

        const m = /^switch-workspace-(\d)$/.exec(command);

        if (m != null) slot = Number(m[1]);

      }

      if (slot >= 1) {

        await activateWorkspaceByOneBasedIndex(window.id, slot);

      }

      return;

    }

    if (command === "switch-previous-workspace") {
      await activateByStep(window.id, -1);
    } else if (command === "switch-next-workspace") {
      await activateByStep(window.id, 1);
    } else if (command === "switch-previous-tab-in-workspace") {
      await switchTabInsideActiveGroup(window.id, -1);
    } else if (command === "switch-next-tab-in-workspace") {
      await switchTabInsideActiveGroup(window.id, 1);
    }
  });
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  withLock(async () => {
    const tab = await chrome.tabs.get(tabId);

    if (tab.groupId >= 0) {
      await collapseAllExcept(windowId, tab.groupId);

      await setStoredActiveGroup(windowId, tab.groupId);
    }

    await syncDecoratedTitlesForWindow(windowId);
  });
});


chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  stripLog("event.tabs.onMoved", {
    tabId,
    windowId: moveInfo.windowId,
    fromIndex: moveInfo.fromIndex,
    toIndex: moveInfo.toIndex
  });

  requestDebouncedTitleSyncAfterMove(moveInfo.windowId, "tabs.onMoved");
});

if (chrome.tabGroups.onMoved && typeof chrome.tabGroups.onMoved.addListener === "function") {
  chrome.tabGroups.onMoved.addListener((group) => {
    if (group.windowId != null) {
      stripLog("event.tabGroups.onMoved", { groupId: group.id, windowId: group.windowId });

      requestDebouncedTitleSyncAfterMove(group.windowId, "tabGroups.onMoved");
    }
  });
}

chrome.tabGroups.onUpdated.addListener((group) => {
  if (suppressTabGroupsOnUpdatedDepth > 0 || !group.windowId) {
    return;
  }

  if (typeof group.collapsed !== "boolean") {
    return;
  }

  withLock(async () => {
    if (lastCollapsedByGroupId.size === 0) {
      await loadCollapsedSnapshotFromSession();
    }

    const gid = group.id;

    const prevCollapsed = lastCollapsedByGroupId.get(gid);

    lastCollapsedByGroupId.set(gid, group.collapsed);

    await saveCollapsedSnapshotToSession();

    if (prevCollapsed !== true || group.collapsed !== false) {
      return;
    }

    await collapseAllExcept(group.windowId, gid);

    await setStoredActiveGroup(group.windowId, gid);
  });
});

if (chrome.tabGroups.onCreated && typeof chrome.tabGroups.onCreated.addListener === "function") {
  chrome.tabGroups.onCreated.addListener((group) => {
    if (typeof group.collapsed === "boolean") {
      lastCollapsedByGroupId.set(group.id, group.collapsed);

      saveCollapsedSnapshotToSession().catch(() => {});
    }

    if (group.windowId != null) {
      requestTitleSyncForWindow(group.windowId);
    }
  });
}

if (chrome.tabGroups.onRemoved && typeof chrome.tabGroups.onRemoved.addListener === "function") {
  chrome.tabGroups.onRemoved.addListener((group) => {
    lastCollapsedByGroupId.delete(group.id);

    saveCollapsedSnapshotToSession().catch(() => {});

    if (group.windowId != null) {
      requestTitleSyncForWindow(group.windowId);
    }
  });
}

chrome.tabs.onCreated.addListener((tab) => {
  withLock(async () => {
    if (tab.windowId == null) {
      return;
    }

    await ensureSingleExpanded(tab.windowId);

    if (tab.id) {
      await applyMatchingAutoGroupRule(tab.id);
    }

    requestTitleSyncForWindow(tab.windowId);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (Object.prototype.hasOwnProperty.call(changeInfo, "groupId") && tab?.windowId != null) {
    requestTitleSyncForWindow(tab.windowId);
  }

  const shouldEvaluate = changeInfo.status === "complete" || typeof changeInfo.url === "string";

  if (!shouldEvaluate) {
    return;
  }

  withLock(async () => {
    await applyMatchingAutoGroupRule(tabId);
  });
});

chrome.tabs.onRemoved.addListener((_tabId, removeInfo) => {
  const w = removeInfo.windowId;

  if (w != null && !removeInfo.isWindowClosing) {
    requestTitleSyncForWindow(w);
  }
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  stripLog("event.tabs.onAttached", {
    tabId,
    newWindowId: attachInfo.newWindowId,
    newPosition: attachInfo.newPosition
  });

  requestDebouncedTitleSyncAfterMove(attachInfo.newWindowId, "tabs.onAttached");
});

chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
  stripLog("event.tabs.onDetached", {
    tabId,
    oldWindowId: detachInfo.oldWindowId,
    oldPosition: detachInfo.oldPosition
  });

  requestDebouncedTitleSyncAfterMove(detachInfo.oldWindowId, "tabs.onDetached");
});

chrome.runtime.onStartup.addListener(() => {
  withLock(async () => {
    await primeCollapsedSnapshotsAllWindows();

    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });

    await Promise.all(windows.map((window) => ensureSingleExpanded(window.id)));

    await syncDecoratedTitlesAllWindows();
  });
});

chrome.runtime.onInstalled.addListener(() => {
  withLock(async () => {
    await primeCollapsedSnapshotsAllWindows();

    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });

    await Promise.all(windows.map((window) => ensureSingleExpanded(window.id)));

    await syncDecoratedTitlesAllWindows();
  });
});
