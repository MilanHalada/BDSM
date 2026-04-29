const LAST_ACTIVE_GROUP_KEY = "lastActiveGroupByWindow";

const AUTO_GROUP_RULES_KEY = "autoGroupRules";

const ALLOWED_TAB_GROUP_COLORS = new Set(["grey", "blue", "red", "yellow", "green", "cyan", "purple", "pink", "orange"]);

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
  const groups = await chrome.tabGroups.query({ windowId });
  return groups.sort((a, b) => a.id - b.id);
}

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

async function collapseAllExcept(windowId, activeGroupId) {
  const groups = await getWindowGroups(windowId);
  await Promise.all(
    groups.map((group) =>
      chrome.tabGroups.update(group.id, { collapsed: group.id !== activeGroupId })
    )
  );
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

    if (parsed.protocol === "about:" || parsed.protocol === "edge:" || parsed.protocol === "devtools:")
      return false;

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

  for (const rule of rules) {
    if (!rule.regex.test(urlCandidate)) continue;

    const windowId = /** @type {number} */ (tab.windowId);

    const groups = await chrome.tabGroups.query({ windowId });

    const existing = groups.find(
      (group) => String(group.title ?? "").trim() === String(rule.targetTitle ?? "").trim()
    );

    if (existing) {
      if (tab.groupId !== existing.id) {
        try {
          await chrome.tabs.group({ tabIds: [tab.id], groupId: existing.id });
        } catch {
          return;
        }
      }

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

    try {
      await chrome.tabGroups.update(newGroupId, {
        title: rule.targetTitle,
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
}

chrome.commands.onCommand.addListener((command) => {
  withLock(async () => {
    const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (!window?.id) {
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
  });
});

chrome.tabGroups.onUpdated.addListener((group) => {
  withLock(async () => {
    if (!group.windowId || group.collapsed !== false) {
      return;
    }
    await collapseAllExcept(group.windowId, group.id);
    await setStoredActiveGroup(group.windowId, group.id);
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  withLock(async () => {
    if (tab.windowId == null) {
      return;
    }
    await ensureSingleExpanded(tab.windowId);

    if (tab.id) {
      await applyMatchingAutoGroupRule(tab.id);
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const shouldEvaluate = changeInfo.status === "complete" || typeof changeInfo.url === "string";

  if (!shouldEvaluate) {
    return;
  }

  withLock(async () => {
    await applyMatchingAutoGroupRule(tabId);
  });
});

chrome.runtime.onStartup.addListener(() => {
  withLock(async () => {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    await Promise.all(windows.map((window) => ensureSingleExpanded(window.id)));
  });
});

chrome.runtime.onInstalled.addListener(() => {
  withLock(async () => {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    await Promise.all(windows.map((window) => ensureSingleExpanded(window.id)));
  });
});
