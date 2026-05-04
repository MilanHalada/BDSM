"use strict";

/**
 * Order tab groups along the window’s tab strip: walk tabs left-to-right (`tab.index`),
 * and on first sighting of each `groupId`, append that group (see tabGroups.onMoved + tabs.query on MDN).
 * Groups with no tabs (empty) trail in query order.
 *
 * @param {chrome.tabGroups.TabGroup[]} groups
 * @param {chrome.tabs.Tab[]} windowTabs Tabs in one window only
 * @returns {chrome.tabGroups.TabGroup[]}
 */
function sortGroupsByVisualTabOrder(groups, windowTabs) {
  const byId = new Map(groups.map((g) => [g.id, g]));

  const ordered = [];

  /** @type {Set<number>} */
  const seen = new Set();

  const tabs = [...windowTabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  for (const t of tabs) {
    const gid = t.groupId;

    if (gid == null || gid < 0) continue;

    if (seen.has(gid)) continue;

    seen.add(gid);

    const g = byId.get(gid);

    if (g) ordered.push(g);
  }

  for (const g of groups) {
    if (!seen.has(g.id)) ordered.push(g);
  }

  return ordered;
}

/**
 * @param {number} order 1-based
 * @param {string|null|undefined} base
 * @param {number} tabCount
 * @param {boolean} showOrderNumber
 * @param {boolean} showTabCount
 */
function formatBdsmGroupTitle(order, base, tabCount, showOrderNumber, showTabCount) {
  const name = String(base ?? "").trim() || "Untitled";

  let core = name;

  if (showTabCount) {
    core = `${name} (${tabCount})`;
  }

  if (showOrderNumber) {
    return `${order}: ${core}`;
  }

  return core;
}

/**
 * Best-effort unwrap when migrating from formatted Chrome titles to stored base titles.
 * @param {string|null|undefined} title
 * @returns {string}
 */
function inferBaseFromDecoratedTitle(title) {
  const t = String(title ?? "").trim();

  if (!t) return "";

  let m = /^\d+\s*:\s*(.+?)\s*\(\d+\)\s*$/u.exec(t);

  if (m) return m[1].trim();

  m = /^\d+\s*:\s*(.+)\s*$/u.exec(t);

  if (m) return m[1].trim();

  m = /^(.+?)\s*\(\d+\)\s*$/u.exec(t);

  if (m) return m[1].trim();

  return t;
}
