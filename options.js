"use strict";

const AUTO_GROUP_RULES_KEY = "autoGroupRules";

const GROUP_TITLE_DISPLAY_KEY = "groupTitleDisplay";

const GROUP_BASE_TITLES_KEY = "groupBaseTitles";

const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "cyan", "purple", "pink", "orange"];

async function loadGroupTitleDisplayOptions() {
  const data = await chrome.storage.local.get(GROUP_TITLE_DISPLAY_KEY);

  const raw = data[GROUP_TITLE_DISPLAY_KEY];

  const o = typeof raw === "object" && raw !== null ? raw : {};

  return {
    showOrderInChromeTitle: o.showOrderInChromeTitle !== false,
    showTabCountInChromeTitle: o.showTabCountInChromeTitle !== false
  };
}

async function saveGroupTitleDisplayPartial(partial) {
  const cur = await loadGroupTitleDisplayOptions();

  const next = { ...cur, ...partial };

  await chrome.storage.local.set({ [GROUP_TITLE_DISPLAY_KEY]: next });

  await notifyBackgroundSyncGroupTitles({ type: "bdsm-sync-group-titles" });
}

async function persistGroupBaseInOptions(groupId, base) {
  const data = await chrome.storage.local.get(GROUP_BASE_TITLES_KEY);

  const map = {
    ...(typeof data[GROUP_BASE_TITLES_KEY] === "object" && data[GROUP_BASE_TITLES_KEY] !== null ? data[GROUP_BASE_TITLES_KEY] : {})
  };

  map[String(groupId)] = String(base ?? "").trim();

  await chrome.storage.local.set({ [GROUP_BASE_TITLES_KEY]: map });
}

/**
 * @param {{ type: string, stripOrderWindowId?: number, stripGroupIds?: number[] }} payload
 * @returns {Promise<boolean>}
 */
async function notifyBackgroundSyncGroupTitles(payload) {
  bdsmDebugLog("options", "notify.syncGroupTitles.send", payload);

  try {
    await chrome.runtime.sendMessage(payload);

    bdsmDebugLog("options", "notify.syncGroupTitles.ok", { type: payload.type });

    return true;
  } catch (err) {
    console.error("bdsm-sync-group-titles failed", err);

    bdsmDebugLog("options", "notify.syncGroupTitles.error", {
      payload,
      message: err instanceof Error ? err.message : String(err)
    });

    toast(err instanceof Error ? err.message : String(err ?? "Title sync failed"), "error");

    return false;
  }
}

/** Let Chrome commit tab-strip indices before the background reads `tabs.query`. */
function settleStripReorderAfterMoves() {
  bdsmDebugLog("options", "reorder.settle.rAF.start");

  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bdsmDebugLog("options", "reorder.settle.rAF.done");

        resolve();
      });
    });
  });
}

const COLOR_HEX = {
  grey: "#6f6f7a",
  blue: "#4285f4",
  red: "#ea4335",
  yellow: "#fbbc05",
  green: "#34a853",
  cyan: "#00acc1",
  purple: "#a142f4",
  pink: "#f06292",
  orange: "#fb8635"
};

const COLOR_FG = {
  grey: "#fafafa",
  blue: "#ffffff",
  red: "#ffffff",
  yellow: "#111118",
  green: "#ffffff",
  cyan: "#ffffff",
  purple: "#ffffff",
  pink: "#ffffff",
  orange: "#ffffff"
};

function normalizeGroupColorKey(value) {
  return typeof value === "string" && GROUP_COLORS.includes(value) ? value : "grey";
}

/**
 * @param {HTMLSelectElement} select
 */
function styleChromeGroupColorSelect(select) {
  select.classList.add("chrome-group-color-select");

  const sync = () => {
    const key = normalizeGroupColorKey(select.value);
    const bg = COLOR_HEX[key] ?? COLOR_HEX.grey;
    const fg = COLOR_FG[key] ?? "#fafafa";
    select.style.backgroundColor = bg;
    select.style.color = fg;
    select.style.borderColor = key === "yellow" ? "rgba(0, 0, 0, 0.5)" : "rgba(0, 0, 0, 0.38)";
    select.style.caretColor = fg;

    for (const opt of Array.from(select.options)) {
      if (!opt.value) continue;
      const k = normalizeGroupColorKey(opt.value);
      opt.style.backgroundColor = COLOR_HEX[k] ?? COLOR_HEX.grey;
      opt.style.color = COLOR_FG[k] ?? "#fafafa";
    }
  };

  sync();
  select.addEventListener("change", sync);
}

/** @returns {HTMLElement} */
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return /** @type {HTMLElement} */ (t.content.firstElementChild);
}

function toast(text, variant) {
  const node = /** @type {HTMLElement} */ (document.getElementById("toast"));
  if (!node) return;
  node.hidden = false;
  node.textContent = text;
  node.style.borderColor = variant === "error" ? "rgba(224,96,96,0.6)" : "var(--border)";
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => {
    node.hidden = true;
  }, 2400);
}

function normalizeTitle(v) {
  return v ?? "";
}

function validateRegex(pattern) {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function loadRules() {
  const data = await chrome.storage.local.get(AUTO_GROUP_RULES_KEY);
  const incoming = Array.isArray(data[AUTO_GROUP_RULES_KEY]) ? [...data[AUTO_GROUP_RULES_KEY]] : [];
  const out = [];

  for (const raw of incoming) {
    if (typeof raw !== "object" || raw === null) continue;

    const rule = /** @type {Record<string, any>} */ ({ ...raw });

    if (typeof rule.id !== "string" || !rule.id.trim()) {
      rule.id = crypto.randomUUID();
    }

    if (rule.name == null) rule.name = "";

    if (rule.regex == null) rule.regex = "";

    if (rule.targetGroupTitle == null) rule.targetGroupTitle = "";

    rule.targetColor = typeof rule.targetColor === "string" ? rule.targetColor : "grey";

    rule.enabled = rule.enabled !== false;

    out.push(rule);
  }

  const priorSerialized = JSON.stringify(incoming);

  const nextSerialized = JSON.stringify(out);

  if (nextSerialized !== priorSerialized) await saveRules(out);

  return out;
}

async function saveRules(rules) {
  await chrome.storage.local.set({ [AUTO_GROUP_RULES_KEY]: rules });
}

let groupTitleLowerToChromeColor = /** @type {Map<string, string>} */ (new Map());

async function hydrateSharedGroupTitlesDatalist() {
  groupTitleLowerToChromeColor = new Map();

  const dl = /** @type {HTMLElement | null} */ (document.getElementById("rule-groups-suggestions"));

  if (!(dl instanceof HTMLElement) || dl.tagName !== "DATALIST") return;

  const win = await chrome.windows.getCurrent();

  const wid = win.id;

  if (!wid) {

    dl.replaceChildren();

    return;

  }

  dl.replaceChildren();

  const baseStore = await chrome.storage.local.get(GROUP_BASE_TITLES_KEY);

  const baseMap =
    typeof baseStore[GROUP_BASE_TITLES_KEY] === "object" && baseStore[GROUP_BASE_TITLES_KEY] !== null
      ? baseStore[GROUP_BASE_TITLES_KEY]
      : {};

  const rows = [...(await chrome.tabGroups.query({ windowId: wid }))]

    .map((g) => {
      const raw = typeof g.title === "string" ? g.title.trim() : "";

      const colorStr = typeof g.color === "string" ? g.color : "";

      const colorSafe = GROUP_COLORS.includes(colorStr) ? colorStr : "grey";

      const gk = String(g.id);

      const stored = typeof baseMap[gk] === "string" ? baseMap[gk].trim() : "";

      const display = stored || inferBaseFromDecoratedTitle(raw);

      return { display, colorSafe, id: g.id };
    })
    .sort((a, b) => a.display.localeCompare(b.display, undefined, { sensitivity: "accent" }));

  for (const row of rows) {
    const lk = row.display.toLocaleLowerCase("en-US");

    groupTitleLowerToChromeColor.set(lk, row.colorSafe);

    const opt = document.createElement("option");

    opt.value = row.display;

    opt.label = row.display !== "" ? `${row.display} · ${row.colorSafe}` : `Untitled (${row.id})`;

    dl.appendChild(opt);
  }

}

/**

 * @param {HTMLSelectElement} colorSelect

 * @param {HTMLInputElement} titleInput

 */

function syncRuleColorFromPickedTitle(colorSelect, titleInput) {

  const trimmed = String(titleInput.value ?? "").trim();

  const colorMaybe = groupTitleLowerToChromeColor.get(trimmed.toLocaleLowerCase("en-US"));

  if (!colorMaybe || !GROUP_COLORS.includes(colorMaybe)) {

    return;

  }

  colorSelect.value = colorMaybe;

  styleChromeGroupColorSelect(colorSelect);

}



async function refreshGroupsView() {
  const root = document.getElementById("groups-root");

  try {
    if (!root) return;

    const currentWindow = await chrome.windows.getCurrent();

    const winId = currentWindow.id;

    if (!winId) {
      root.replaceChildren(el(`<div class="empty-hint">No active window.</div>`));

      return;

    }

    const [tabs, groups] = await Promise.all([
      chrome.tabs.query({ windowId: winId }),
      chrome.tabGroups.query({ windowId: winId })
    ]);

    if (!groups.length) {

      root.replaceChildren(

        el(

          `<div class="empty-hint">No tab groups in this window. Use <strong>New group</strong> above to create one.</div>`

        )

      );

      return;

    }

    const groupedTabs = new Map(groups.map((g) => [g.id, []]));

    for (const tab of tabs) {

      const gid = tab.groupId;

      if (gid < 0 || !groupedTabs.has(gid)) continue;

      groupedTabs.get(gid).push(tab);

    }

    const baseStore = await chrome.storage.local.get(GROUP_BASE_TITLES_KEY);

    const baseMap =
      typeof baseStore[GROUP_BASE_TITLES_KEY] === "object" && baseStore[GROUP_BASE_TITLES_KEY] !== null
        ? baseStore[GROUP_BASE_TITLES_KEY]
        : {};

    const sortedGroups = sortGroupsByVisualTabOrder(groups, tabs);

    const enriched = sortedGroups.map((g) => ({
      ...g,

      tabs: groupedTabs.get(g.id) ?? []
    }));

    root.replaceChildren();

    const frag = document.createDocumentFragment();

    for (let i = 0; i < enriched.length; i++) {
      const group = enriched[i];

      frag.append(
        makeReorderableGroupWrapper(
          winId,
          group.id,
          renderGroupCard(group, enriched, i + 1, /** @type {Record<string, string>} */ (baseMap))
        )
      );
    }

    root.appendChild(frag);

  } finally {

    await hydrateSharedGroupTitlesDatalist();

  }

}

/**
 * @param {chrome.tabGroups.TabGroup} group
 * @param {(chrome.tabGroups.TabGroup & { tabs?: chrome.tabs.Tab[] })[]} allGroups
 * @param {number} visualOrderNum
 * @param {Record<string, string>} baseMap
 */
function renderGroupCard(group, allGroups, visualOrderNum, baseMap) {
  const accent = COLOR_HEX[group.color ?? "grey"] ?? "#6f6f7a";

  const card = el(`<article class="group-card"><div class="group-card-inner"></div></article>`);
  const inner = card.querySelector(".group-card-inner");
  inner.style.borderLeftColor = accent;

  const head = el(`<div class="group-card-head"></div>`);
  const titleRow = /** @type {HTMLElement} */ (el(`<div class="group-title-row"></div>`));
  const orderBadge = /** @type {HTMLElement} */ (
    el(`<span class="group-order-badge" aria-label="Order ${visualOrderNum}">${visualOrderNum}:</span>`)
  );
  const titleWrap = el(`<div class="group-title-field">
    <label for="grp-title-${group.id}">Group title</label>
    <input id="grp-title-${group.id}" type="text" autocomplete="off" />
  </div>`);

  const titleInput = /** @type {HTMLInputElement} */ (titleWrap.querySelector("input"));

  const gk = String(group.id);

  const storedBase = typeof baseMap[gk] === "string" ? baseMap[gk].trim() : "";

  titleInput.value = storedBase || inferBaseFromDecoratedTitle(group.title);

  titleInput.addEventListener(
    "change",
    () => handleGroupTitleBlur(group.id, titleInput.value).catch(console.error),
    false
  );
  titleInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "enter") {
      titleInput.blur();
    }
  });

  const colorWrap = el(`<div class="group-color-field">
    <label for="grp-color-${group.id}">Color</label>
    <select id="grp-color-${group.id}"></select>
  </div>`);

  const colorSelect = /** @type {HTMLSelectElement} */ (colorWrap.querySelector("select"));

  colorSelect.tabIndex = 0;

  for (const c of GROUP_COLORS) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    if (group.color === c) opt.selected = true;
    colorSelect.appendChild(opt);
  }

  styleChromeGroupColorSelect(colorSelect);

  colorSelect.addEventListener("change", () => {
    const next = /** @type {chrome.tabGroups.Color} */ (colorSelect.value);

    chrome.tabGroups
      .update(group.id, { color: next })
      .then(() => {
        toast("Updated group color");
        inner.style.borderLeftColor = COLOR_HEX[normalizeGroupColorKey(next)] ?? COLOR_HEX.grey;
      })
      .catch((err) => {
        toast(String(err ?? "Cannot update"), "error");
      });
  });

  const collapsed = normalizeTitle(group.collapsed ? "Collapsed" : "Expanded");
  const meta = el(`<div class="group-meta">${collapsed}</div>`);

  titleRow.appendChild(orderBadge);
  titleRow.appendChild(titleWrap);
  head.appendChild(titleRow);
  head.appendChild(colorWrap);
  head.appendChild(meta);

  inner.appendChild(head);

  inner.appendChild(renderGroupToolbar(group.tabs));

  const list = document.createElement("ul");
  list.className = "group-tabs";
  list.dataset.groupId = String(group.id);

  if (!group.tabs.length) {
    const row = el(`<li class="tab-row tab-row-empty"><div class="muted" style="grid-column: 1 / -1">Empty group</div></li>`);
    list.appendChild(row);
  } else {
    for (const tab of group.tabs) {
      list.appendChild(renderTabRow(tab, group, allGroups, baseMap));
    }
  }

  inner.appendChild(list);

  return card;
}

/**
 * @param {chrome.tabs.Tab[]} tabsInGroup
 */
function renderGroupToolbar(tabsInGroup) {
  const bar = /** @type {HTMLElement} */ (document.createElement("div"));

  bar.className = "group-toolbar";

  const tabIdsForApi = tabsInGroup.map((t) => /** @type {number} */ (t.id ?? 0)).filter((id) => id > 0);

  const usable = tabIdsForApi.length > 0;

  const unBtn = /** @type {HTMLButtonElement} */ (el(`<button type="button" class="btn btn-sm">Ungroup tabs</button>`));

  unBtn.title = usable ? "Remove grouping; tabs stay open" : "No tabs";

  const closeAllBtn = /** @type {HTMLButtonElement} */ (
    el(`<button type="button" class="btn btn-sm btn-outline-danger">Close all tabs</button>`)

  );

  closeAllBtn.title = usable ? "Close every tab in this group" : "No tabs";

  unBtn.disabled = !usable;

  closeAllBtn.disabled = !usable;

  unBtn.addEventListener("click", () => handleUngroupTabs(tabIdsForApi));

  closeAllBtn.addEventListener("click", () => handleCloseAllTabsInGroup(tabIdsForApi, tabsInGroup.length));

  bar.append(unBtn, closeAllBtn);

  return bar;
}

async function countLeadingPinnedTabs(windowId) {
  const tabs = await chrome.tabs.query({ windowId });

  const sorted = [...tabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  let n = 0;

  for (const tab of sorted) {

    if (!tab.pinned) break;

    n++;

  }

  return n;

}

/**
 * @param {chrome.tabGroups.TabGroup["id"][]} orderedGroupIds
 */
async function applyTabGroupStripOrder(windowId, orderedGroupIds) {
  const moveGroup =
    typeof chrome.tabGroups?.move === "function" ? chrome.tabGroups.move.bind(chrome.tabGroups) : null;

  let insertAt = await countLeadingPinnedTabs(windowId);

  for (const groupId of orderedGroupIds) {
    const tabs = await chrome.tabs.query({ windowId, groupId });

    tabs.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    const count = tabs.length;

    if (!count) continue;

    if (moveGroup) {
      await moveGroup(groupId, { index: insertAt, windowId });
    } else {
      const ids = tabs.map((t) => /** @type {number} */ (t.id ?? 0)).filter((id) => id > 0);

      await chrome.tabs.move(ids, { index: insertAt });

    }

    insertAt += count;

  }

}

/**
 * @param {chrome.tabGroups.TabGroup["id"][]} order
 * @param {chrome.tabGroups.TabGroup["id"]} draggedId
 * @param {chrome.tabGroups.TabGroup["id"]} targetId
 * @param {boolean} beforeTarget Insert before (`true`) or after (`false`) the target wrapper.
 */

function spliceReorderGroupIds(order, draggedId, targetId, beforeTarget) {

  const fromIx = order.indexOf(draggedId);

  const toIxOriginal = order.indexOf(targetId);

  if (fromIx === -1 || toIxOriginal === -1) return order.slice();

  const next = order.filter((id) => id !== draggedId);

  let insertIx = next.indexOf(targetId);

  if (insertIx === -1) return order.slice();

  if (!beforeTarget) insertIx += 1;

  next.splice(insertIx, 0, draggedId);

  return next;

}

/**
 * @param {number} windowId

 * @param {chrome.tabGroups.TabGroup["id"]} groupId

 * @param {HTMLElement} cardEl Rendered `.group-card` root.

 */

function makeReorderableGroupWrapper(windowId, groupId, cardEl) {

  const shell = /** @type {HTMLElement} */ (document.createElement("div"));

  shell.className = "group-card-shell";

  shell.dataset.groupId = String(groupId);

  shell.dataset.windowId = String(windowId);

  const rail = /** @type {HTMLElement} */ (document.createElement("aside"));

  rail.className = "group-drag-rail";

  const handle = /** @type {HTMLButtonElement} */ (document.createElement("button"));

  handle.type = "button";

  handle.className = "group-drag-handle";

  handle.draggable = true;

  handle.title = "Drag to reorder · left = earlier in tab bar";

  handle.setAttribute("aria-label", `Reorder tab group`);

  rail.append(handle);

  const skin = /** @type {HTMLElement} */ (document.createElement("div"));

  skin.className = "group-card-skin";

  skin.append(cardEl);

  shell.append(rail, skin);

  return shell;

}

function orderFromShellNodes(rootEl) {
  const ids = [];

  rootEl.querySelectorAll(".group-card-shell[data-group-id]").forEach((node) => {
    ids.push(Number(/** @type {HTMLElement} */ (node).dataset.groupId));
  });

  return ids;
}

let dragSourceGroupId = null;

function clearGroupDragVisuals() {
  const root = document.getElementById("groups-root");

  if (!root) return;

  root.classList.remove("groups-reordering");

  root.querySelectorAll(".group-card-shell").forEach((el) => {
    el.classList.remove("shell-dragging", "drop-slot-before", "drop-slot-after");
  });
}

function ensureGroupReorderDelegates() {
  const root = document.getElementById("groups-root");

  if (!root || root.dataset.bdsmReorderDelegates === "1") return;

  root.dataset.bdsmReorderDelegates = "1";

  root.addEventListener("dragstart", (ev) => {

    let t = /** @type {EventTarget | null} */ (ev.target);

    while (t instanceof Text) t = t.parentElement ?? null;

    if (!(t instanceof HTMLElement)) return;

    const handle = /** @type {HTMLElement | null} */ (t.closest(".group-drag-handle"));

    if (!(handle instanceof HTMLElement)) return;

    const shell = /** @type {HTMLElement | null} */ (handle.closest(".group-card-shell"));

    if (!(shell instanceof HTMLElement) || !shell.dataset.groupId) return;

    if (!ev.dataTransfer) return;

    const gid = Number(shell.dataset.groupId);

    dragSourceGroupId = Number.isFinite(gid) ? gid : null;

    ev.dataTransfer.setData("application/x-bdsm-group-id", String(shell.dataset.groupId));

    ev.dataTransfer.effectAllowed = "move";

    shell.classList.add("shell-dragging");

    root.classList.add("groups-reordering");

  });

  root.addEventListener("dragend", () => {

    dragSourceGroupId = null;

    clearGroupDragVisuals();

  });

  root.addEventListener("dragover", (ev) => {

    if (dragSourceGroupId === null || !ev.dataTransfer) return;

    let t = /** @type {EventTarget | null} */ (ev.target);

    while (t instanceof Text) t = t.parentElement ?? null;

    if (!(t instanceof Element)) return;

    const shell = /** @type {HTMLElement | null} */ (t.closest(".group-card-shell"));

    if (!(shell instanceof HTMLElement) || !shell.dataset.groupId) return;

    const overId = Number(shell.dataset.groupId);

    if (!Number.isFinite(overId)) return;

    if (!Number.isFinite(dragSourceGroupId) || overId === dragSourceGroupId) return;

    ev.preventDefault();

    ev.dataTransfer.dropEffect = "move";

    const rect = shell.getBoundingClientRect();

    const before = ev.clientY < rect.top + rect.height / 2;

    root.querySelectorAll(".group-card-shell.drop-slot-before,.group-card-shell.drop-slot-after").forEach((el) => {

      /** @type {HTMLElement} */ (el).classList.remove("drop-slot-before", "drop-slot-after");

    });

    shell.classList.toggle("drop-slot-before", before);

    shell.classList.toggle("drop-slot-after", !before);

  });

  root.addEventListener("drop", async (ev) => {

    ev.preventDefault();

    const xfer = /** @type {DataTransfer | null | undefined} */ (ev.dataTransfer);

    let sourceIdRaw = xfer ? xfer.getData("application/x-bdsm-group-id") : "";

    if (!sourceIdRaw && dragSourceGroupId !== null) sourceIdRaw = String(dragSourceGroupId);

    const sourceId = Number(sourceIdRaw);

    let t = /** @type {EventTarget | null} */ (ev.target);

    while (t instanceof Text) t = t.parentElement ?? null;

    const shellEl = /** @type {HTMLElement | null} */ (t instanceof Element ? t.closest(".group-card-shell") : null);

    dragSourceGroupId = null;

    clearGroupDragVisuals();

    if (!(shellEl instanceof HTMLElement) || !shellEl.dataset.windowId || !shellEl.dataset.groupId) return;

    const targetId = Number(shellEl.dataset.groupId);

    const windowIdNum = Number(shellEl.dataset.windowId);

    if (!Number.isFinite(sourceId) || !Number.isFinite(targetId) || !Number.isFinite(windowIdNum)) return;

    if (targetId === sourceId) {

      await refreshGroupsView();

      return;

    }

    const rect = shellEl.getBoundingClientRect();

    const beforeTarget = ev.clientY < rect.top + rect.height / 2;

    const curr = orderFromShellNodes(root);

    const nextOrder = spliceReorderGroupIds(curr, sourceId, targetId, beforeTarget);

    if (!nextOrder.length || nextOrder.length !== curr.length) {

      await refreshGroupsView();

      return;

    }

    const unchanged = curr.length === nextOrder.length && curr.every((v, i) => v === nextOrder[i]);

    if (unchanged) {

      await refreshGroupsView();

      return;

    }

    bdsmDebugLog("options", "reorderDnD.plan", {
      windowId: windowIdNum,
      dragSourceGroupId: sourceId,
      dropTargetGroupId: targetId,
      insertBeforeTarget: beforeTarget,
      orderBefore: curr,
      orderNext: nextOrder
    });

    try {

      await applyTabGroupStripOrder(windowIdNum, nextOrder);

      bdsmDebugLog("options", "reorderDnD.stripMovesDone", {
        windowId: windowIdNum,
        stripGroupIds: nextOrder
      });

      await settleStripReorderAfterMoves();

      const synced = await notifyBackgroundSyncGroupTitles({
        type: "bdsm-sync-group-titles",
        stripOrderWindowId: windowIdNum,
        stripGroupIds: nextOrder
      });

      if (synced) {
        toast("Group order updated");
      }

      await refreshGroupsView();

    } catch (e) {

      toast(String(e ?? "Reorder failed"), "error");

      await refreshGroupsView();

    }

  });

}

async function handleUngroupTabs(tabIds) {
  try {
    await chrome.tabs.ungroup(tabIds);

    toast("Ungrouped");

    await refreshGroupsView();

  } catch (e) {
    toast(String(e ?? "Cannot ungroup"), "error");

  }

}

async function handleCloseAllTabsInGroup(tabIds, count) {
  if (!tabIds.length) return;

  if (!confirm(`Close all ${count} tab(s) in this group?`)) return;

  try {
    await chrome.tabs.remove(tabIds);

    toast("Tabs closed");

    await refreshGroupsView();

  } catch (e) {
    toast(String(e ?? "Cannot close tabs"), "error");

  }

}

async function handleCloseTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);

    toast("Tab closed");

    await refreshGroupsView();

  } catch (e) {

    toast(String(e ?? "Cannot close tab"), "error");

  }

}

async function handleNewGroup() {
  try {
    const currentWindow = await chrome.windows.getCurrent();

    const winId = currentWindow.id;

    if (!winId) {
      toast("No active window", "error");

      return;

    }

    const createdTab = await chrome.tabs.create({ windowId: winId, active: true });

    const gid = await chrome.tabs.group({
      tabIds: /** @type {number[]} */ ([createdTab.id]),
      createProperties: { windowId: winId }
    });

    await chrome.tabGroups.update(gid, {
      color: /** @type {chrome.tabGroups.Color} */ ("grey"),

      collapsed: false
    });

    await persistGroupBaseInOptions(gid, "New group");

    const synced = await notifyBackgroundSyncGroupTitles({ type: "bdsm-sync-group-titles" });

    if (synced) {
      toast("Created new group");
    }

    await refreshGroupsView();

  } catch (e) {

    toast(String(e ?? "Cannot create group"), "error");

  }

}

function tabDisplayUrl(tab) {
  return tab.pendingUrl ?? tab.url ?? "";
}

function tabDisplayTitle(tab) {
  const t = tab.title?.trim();
  if (t) return t;
  const url = tabDisplayUrl(tab);
  return url ? url : "(no title)";
}

/**
 * @param {chrome.tabs.Tab} tab
 * @param {chrome.tabGroups.TabGroup} currentGroup
 * @param {chrome.tabGroups.TabGroup[]} allGroups
 * @param {Record<string, string>} baseMap
 */
function renderTabRow(tab, currentGroup, allGroups, baseMap) {
  const row = el(`<li class="tab-row"></li>`);

  const favWrap = /** @type {HTMLElement} */ (document.createElement("div"));
  favWrap.className = "tab-favicon";

  const icon = tab.favIconUrl ?? "";
  if (icon && !/^chrome-extension:\/\//u.test(icon)) {
    favWrap.style.backgroundImage = `url("${icon.replace(/"/gu, `%22`)}")`;
  }

  const textWrap = el(`<div class="tab-text">
    <div class="tab-title-text"></div>
    <div class="tab-url-text"></div>
  </div>`);

  textWrap.querySelector(".tab-title-text").textContent = tabDisplayTitle(tab);
  textWrap.querySelector(".tab-url-text").textContent = tabDisplayUrl(tab) || "";

  const moveWrap = el(`<div class="tab-move">
    <label for="mv-${tab.id}">Move</label>
    <select id="mv-${tab.id}"></select>
  </div>`);

  const select = /** @type {HTMLSelectElement} */ (moveWrap.querySelector("select"));

  const optSame = document.createElement("option");
  optSame.value = "";
  optSame.textContent = "— Same group —";
  optSame.selected = true;
  select.appendChild(optSame);

  for (const g of allGroups.filter((grp) => grp.id !== currentGroup.id)) {
    const o = document.createElement("option");
    o.value = String(g.id);
    const gk = String(g.id);
    const stored = typeof baseMap[gk] === "string" ? baseMap[gk].trim() : "";
    const labelBase = stored || inferBaseFromDecoratedTitle(g.title);
    o.textContent = labelBase || `#${g.id}`;
    select.appendChild(o);
  }

  select.addEventListener("change", () => handleTabMove(Number(select.value), tab.id));

  const closeBtn = /** @type {HTMLButtonElement} */ (
    el(`<button type="button" class="btn btn-sm btn-outline-danger tab-close-btn">Close</button>`)
  );

  closeBtn.addEventListener("click", () => {
    if (tab.id != null) handleCloseTab(tab.id);
  });

  row.appendChild(favWrap);

  row.appendChild(textWrap);

  row.appendChild(moveWrap);

  row.appendChild(closeBtn);

  return row;
}

async function handleTabMove(destinationGroupId, tabId) {
  if (!destinationGroupId) return;
  try {
    await chrome.tabs.group({ tabIds: [tabId], groupId: destinationGroupId });
    toast("Tab moved");
    await refreshGroupsView();
  } catch (e) {
    toast(String(e ?? "Cannot move tab"), "error");
  }
}

async function handleGroupTitleBlur(groupId, value) {
  try {
    await persistGroupBaseInOptions(groupId, value);

    const synced = await notifyBackgroundSyncGroupTitles({ type: "bdsm-sync-group-titles" });

    if (synced) {
      toast("Saved group title");
    }

    await refreshGroupsView();
  } catch (e) {
    toast(String(e ?? "Cannot update"), "error");
  }
}

function truncateCell(s, max) {
  const t = String(s ?? "");

  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
}

async function renderRules(rules) {
  const root = document.getElementById("rules-root");

  if (!root) return;

  root.replaceChildren();

  await hydrateSharedGroupTitlesDatalist();

  if (!rules.length) {
    root.appendChild(
      el(
        `<div class="rules-empty">
          <p class="muted">No rules yet. Rules are evaluated top to bottom — first match wins.</p>
          <p class="rules-empty-hint muted small">Use <strong>Add rule</strong> to open the editor.</p>
        </div>`
      )
    );
    return;
  }

  const wrap = /** @type {HTMLElement} */ (el(`<div class="rules-table-wrap"></div>`));

  const table = document.createElement("table");

  table.className = "rules-table";

  table.setAttribute("aria-label", "Auto group rules");

  const thead = /** @type {HTMLTableSectionElement} */ (el(`<thead>
    <tr>
      <th scope="col">Name</th>
      <th scope="col">Regex</th>
      <th scope="col">Target group</th>
      <th scope="col">Color</th>
      <th scope="col">On</th>
      <th scope="col" class="rules-th-actions">Actions</th>
    </tr>
  </thead>`));

  const tbody = document.createElement("tbody");

  for (const rule of rules) {
    tbody.appendChild(buildRuleTableRow(rule));
  }

  table.append(thead, tbody);

  wrap.appendChild(table);

  root.appendChild(wrap);
}

/**
 * @param {any} rule
 */
function buildRuleTableRow(rule) {
  const id = typeof rule?.id === "string" ? rule.id : "";

  const tr = document.createElement("tr");

  tr.dataset.ruleId = id;

  const nameTd = document.createElement("td");

  nameTd.className = "rules-td-name";

  nameTd.textContent = String(rule?.name ?? "").trim() || "(unnamed)";

  const rxTd = document.createElement("td");

  rxTd.className = "rules-td-regex";

  const rxCode = document.createElement("code");

  rxCode.className = "rules-regex-preview";

  const rxFull = String(rule?.regex ?? "");

  rxCode.textContent = truncateCell(rxFull, 56);

  rxCode.title = rxFull;

  rxTd.appendChild(rxCode);

  const tgtTd = document.createElement("td");

  tgtTd.className = "rules-td-target";

  tgtTd.textContent = String(rule?.targetGroupTitle ?? "").trim() || "—";

  const colorTd = document.createElement("td");

  colorTd.className = "rules-td-color";

  const sw = document.createElement("span");

  sw.className = "rules-color-swatch";

  const ck = normalizeGroupColorKey(typeof rule?.targetColor === "string" ? rule.targetColor : "grey");

  sw.style.backgroundColor = COLOR_HEX[ck] ?? "#6f6f7a";

  sw.title = ck;

  const colorLbl = document.createElement("span");

  colorLbl.className = "rules-color-label";

  colorLbl.textContent = ck;

  colorTd.append(sw, colorLbl);

  const onTd = document.createElement("td");

  onTd.className = "rules-td-on";

  const onCh = /** @type {HTMLInputElement} */ (document.createElement("input"));

  onCh.type = "checkbox";

  onCh.checked = rule?.enabled !== false;

  onCh.title = "Enabled";

  onCh.addEventListener("change", () => toggleRuleEnabled(id, onCh.checked).catch(console.error));

  onTd.appendChild(onCh);

  const actTd = document.createElement("td");

  actTd.className = "rules-td-actions";

  const editBtn = /** @type {HTMLButtonElement} */ (el(`<button type="button" class="btn btn-sm btn-table">Edit</button>`));

  editBtn.addEventListener("click", () => openRuleEditorModal(rule, false));

  const delBtn = /** @type {HTMLButtonElement} */ (
    el(`<button type="button" class="btn btn-sm btn-outline-danger btn-table">Delete</button>`)

  );

  delBtn.addEventListener("click", () => confirmDeleteRule(id));

  actTd.append(editBtn, delBtn);

  tr.append(nameTd, rxTd, tgtTd, colorTd, onTd, actTd);

  return tr;

}

async function toggleRuleEnabled(ruleId, enabled) {
  const list = await loadRules();

  const rule = list.find((r) => r?.id === ruleId);

  if (!rule) return;

  rule.enabled = enabled;

  await saveRules(list);

  toast(enabled ? "Rule enabled" : "Rule disabled");
}

async function confirmDeleteRule(ruleId) {

  const list = await loadRules();

  const rule = list.find((r) => r?.id === ruleId);

  if (!rule) return;

  if (!confirm(`Delete rule "${String(rule?.name ?? "").trim() || "untitled"}"?`)) return;

  await saveRules(list.filter((r) => r?.id !== ruleId));

  toast("Rule deleted");

  closeRuleEditorModal();

  await renderRules(await loadRules());

}

function getRuleModalNodes() {

  const modal = document.getElementById("rule-edit-modal");

  const backdrop = modal?.querySelector(".rule-modal-backdrop");

  const body = document.getElementById("rule-modal-body");

  const titleEl = modal?.querySelector(".rule-modal-title");

  const headClose = modal?.querySelector("#rule-modal-close-empty");

  return { modal, backdrop, body, titleEl, headClose };

}

function closeRuleEditorModal() {

  const { modal, body } = getRuleModalNodes();

  if (body) body.replaceChildren();

  modal?.classList.remove("rule-modal-visible");

  if (modal) modal.hidden = true;

  document.documentElement.style.overflow = "";

}

function openRuleEditorModal(rule, isNew) {

  const { modal, body, titleEl } = getRuleModalNodes();

  if (!modal || !body) return;

  hydrateSharedGroupTitlesDatalist().catch(console.error);

  body.replaceChildren(buildRuleEditorForm(rule, isNew));

  modal.hidden = false;

  modal.classList.add("rule-modal-visible");

  if (titleEl) titleEl.textContent = isNew ? "New rule" : "Edit rule";

  document.documentElement.style.overflow = "hidden";

  const firstFocus = /** @type {HTMLElement|null} */ (
    body.querySelector("input:not([hidden]), textarea, select, button")
  );

  firstFocus?.focus();

}

/**
 * @param {any} rule
 * @param {boolean} isNew
 */
function buildRuleEditorForm(rule, isNew) {

  const stableId =
    typeof rule?.id === "string" && rule.id.trim().length ? rule.id.trim() : crypto.randomUUID();

  const wrap = document.createElement("div");

  wrap.className = "rule-card rule-card-editor";

  wrap.dataset.ruleId = stableId;

  const header = document.createElement("div");

  header.className = "rule-card-header";

  const nameOuter = document.createElement("div");

  nameOuter.className = "field rule-name-field";

  const nameLbl = document.createElement("label");

  nameLbl.textContent = "Rule name";

  const nameInput = /** @type {HTMLInputElement} */ (document.createElement("input"));

  nameInput.type = "text";

  nameInput.autocomplete = "off";

  nameInput.value = normalizeTitle(rule?.name);

  nameOuter.append(nameLbl, nameInput);

  const enabledOuter = document.createElement("div");

  enabledOuter.className = "field rule-enabled-inline";

  const enInput = /** @type {HTMLInputElement} */ (document.createElement("input"));

  enInput.type = "checkbox";

  enInput.checked = rule?.enabled !== false;

  enInput.id = `en-${crypto.randomUUID()}`;

  const enLbl = document.createElement("label");

  enLbl.className = "muted";

  enLbl.htmlFor = enInput.id;

  enLbl.textContent = "Enabled";

  enabledOuter.append(enInput, enLbl);

  header.append(nameOuter, enabledOuter);

  const regexOuter = document.createElement("div");

  regexOuter.className = "field field-regex";

  const regexLbl = document.createElement("label");

  regexLbl.textContent = "URL regex";

  const regexArea = /** @type {HTMLTextAreaElement} */ (document.createElement("textarea"));

  regexArea.rows = 3;

  regexArea.spellcheck = false;

  regexArea.placeholder = String.raw`e.g. ^https:\/\/github\.com\/.*`;

  regexArea.value = normalizeTitle(rule?.regex);

  regexOuter.append(regexLbl, regexArea);

  const split = document.createElement("div");

  split.className = "rule-target-split";

  const tgtOuter = document.createElement("div");

  tgtOuter.className = "field field-target-title";

  const tgtLbl = document.createElement("label");

  tgtLbl.textContent = "Target group";

  const tgtInput = /** @type {HTMLInputElement} */ (document.createElement("input"));

  tgtInput.type = "text";

  tgtInput.autocomplete = "off";

  tgtInput.setAttribute("list", "rule-groups-suggestions");

  tgtInput.placeholder = "Suggested groups from this window, or type a new title";

  tgtInput.value = normalizeTitle(rule?.targetGroupTitle);

  const tgtHint = document.createElement("p");

  tgtHint.className = "field-hint muted";

  tgtHint.textContent =
    "Picking an existing title copies its accent color automatically. Tabs move to strip end when the rule fires.";

  tgtOuter.append(tgtLbl, tgtInput, tgtHint);

  const colorOuter = document.createElement("div");

  colorOuter.className = "field field-target-color";

  const colorLbl = document.createElement("label");

  colorLbl.textContent = "Accent color";

  const colorSelect = /** @type {HTMLSelectElement} */ (document.createElement("select"));

  colorSelect.required = true;

  for (const c of GROUP_COLORS) {

    const opt = document.createElement("option");

    opt.value = c;

    opt.textContent = c;

    colorSelect.appendChild(opt);

    if ((rule?.targetColor ?? "grey") === c) opt.selected = true;

  }

  colorOuter.append(colorLbl, colorSelect);

  styleChromeGroupColorSelect(colorSelect);

  const syncTitlePick = () => syncRuleColorFromPickedTitle(colorSelect, tgtInput);

  tgtInput.addEventListener("change", syncTitlePick);

  tgtInput.addEventListener("blur", syncTitlePick);

  split.append(tgtOuter, colorOuter);

  const err = document.createElement("div");

  err.className = "regex-error";

  err.hidden = true;

  wrap.append(header, regexOuter, split, err);

  const actions = document.createElement("div");

  actions.className = "rule-actions";

  const saveBtn = /** @type {HTMLElement} */ (el(`<button type="button" class="btn btn-accent btn-sm">Save rule</button>`));

  saveBtn.addEventListener("click", async () => {
    err.hidden = true;

    const regex = regexArea.value;

    const v = validateRegex(regex);

    if (v) {
      err.textContent = v;

      err.hidden = false;

      toast(`Invalid regex: ${v}`, "error");

      return;
    }

    const replacement = {
      id: stableId,

      name: String(nameInput.value ?? "").trim(),
      regex,
      targetGroupTitle: String(tgtInput.value ?? ""),
      targetColor: /** @type {chrome.tabGroups.Color} */ colorSelect.value,
      enabled: enInput.checked
    };

    const current = await loadRules();

    const next = [...current.filter((item) => item?.id !== stableId)];

    next.push(replacement);

    await saveRules(next);

    closeRuleEditorModal();

    await renderRules(await loadRules());

    toast("Rule saved");
  });

  const cancelBtn = /** @type {HTMLElement} */ (el(`<button type="button" class="btn btn-sm rule-btn-cancel">Cancel</button>`));

  cancelBtn.addEventListener("click", () => closeRuleEditorModal());

  actions.append(saveBtn);

  if (!isNew) {

    const delBtn = /** @type {HTMLElement} */ (el(`<button type="button" class="btn btn-danger btn-sm">Delete rule</button>`));

    delBtn.addEventListener("click", () => confirmDeleteRule(stableId));

    actions.append(delBtn);

  }

  actions.append(cancelBtn);

  wrap.appendChild(actions);

  return wrap;
}

document.addEventListener("DOMContentLoaded", () => {
  ensureGroupReorderDelegates();

  const orderCh = /** @type {HTMLInputElement | null} */ (document.getElementById("opt-show-order-chrome"));

  const countCh = /** @type {HTMLInputElement | null} */ (document.getElementById("opt-show-count-chrome"));

  if (orderCh && countCh) {
    loadGroupTitleDisplayOptions()
      .then((d) => {
        orderCh.checked = d.showOrderInChromeTitle;

        countCh.checked = d.showTabCountInChromeTitle;
      })
      .catch(console.error);

    orderCh.addEventListener("change", () => {
      saveGroupTitleDisplayPartial({ showOrderInChromeTitle: orderCh.checked }).catch(console.error);
    });

    countCh.addEventListener("change", () => {
      saveGroupTitleDisplayPartial({ showTabCountInChromeTitle: countCh.checked }).catch(console.error);
    });
  }

  document.getElementById("btn-new-group")?.addEventListener("click", () => handleNewGroup().catch(console.error));

  document.getElementById("btn-refresh-groups")?.addEventListener("click", () =>
    refreshGroupsView().catch(console.error)
  );

  document.getElementById("btn-add-rule")?.addEventListener("click", () => {

    openRuleEditorModal(
      {
        id: crypto.randomUUID(),
        name: "New rule",
        regex: ".*\\.example\\.com/.*",
        targetGroupTitle: "Example",
        targetColor: "blue",
        enabled: true
      },

      true
    );

  });

  document.addEventListener("keydown", (ev) => {

    const modal = /** @type {HTMLElement | null} */ (document.getElementById("rule-edit-modal"));

    if (!modal || modal.hidden || !modal.classList.contains("rule-modal-visible")) return;

    if (ev.key === "Escape") {

      ev.preventDefault();

      closeRuleEditorModal();

    }

  });

  const mn = getRuleModalNodes();

  mn.modal?.querySelector(".rule-modal-backdrop")?.addEventListener("click", () => closeRuleEditorModal());

  mn.headClose?.addEventListener("click", () => closeRuleEditorModal());

  Promise.all([refreshGroupsView(), loadRules()])
    .then(([, rules]) => renderRules(rules))
    .catch(console.error);
});
