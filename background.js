// Leaf Tabs - background service worker (MV3, event-driven, no persistent global state)
//
// All tree state lives in chrome.storage.local under the "leafTree" key:
//   { [tabId]: { parentId: number|null, color: string|null, customName: string|null, collapsed: boolean, locked: boolean } }
// The service worker never assumes in-memory state survives between events -
// every handler reads what it needs from storage, mutates, and writes back.

const STORE_KEY = "leafTree";

async function getTree() {
  const data = await chrome.storage.local.get(STORE_KEY);
  return data[STORE_KEY] || {};
}

async function setTree(tree) {
  await chrome.storage.local.set({ [STORE_KEY]: tree });
}

// Ensure every currently open tab has a tree entry (covers install/update
// and any tabs that existed before the extension was loaded).
async function reconcileWithOpenTabs() {
  const tabs = await chrome.tabs.query({});
  const tree = await getTree();
  const openIds = new Set(tabs.map((t) => t.id));

  for (const tab of tabs) {
    if (!tree[tab.id]) {
      tree[tab.id] = {
        parentId:
          typeof tab.openerTabId === "number" ? tab.openerTabId : null,
        color: null,
        customName: null,
        collapsed: false,
        locked: false,
      };
    }
  }

  // Drop entries for tabs that no longer exist.
  for (const idStr of Object.keys(tree)) {
    if (!openIds.has(Number(idStr))) {
      delete tree[idStr];
    }
  }

  await setTree(tree);
}

chrome.runtime.onInstalled.addListener(() => {
  reconcileWithOpenTabs();
});

chrome.runtime.onStartup.addListener(() => {
  reconcileWithOpenTabs();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  const tree = await getTree();
  tree[tab.id] = {
    parentId: typeof tab.openerTabId === "number" ? tab.openerTabId : null,
    color: null,
    customName: null,
    collapsed: false,
    locked: false,
  };
  await setTree(tree);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tree = await getTree();
  const entry = tree[tabId];
  if (!entry) return;

  const formerParentId = entry.parentId;

  // Re-parent children of the closed tab to its former parent so closing a
  // middle tab in a chain doesn't orphan its descendants.
  for (const [idStr, node] of Object.entries(tree)) {
    if (node.parentId === tabId) {
      node.parentId = formerParentId;
    }
  }

  delete tree[tabId];
  await setTree(tree);
});

// Keep storage in sync if a tab navigates in a way that changes its opener
// (rare, but onUpdated can carry openerTabId changes in some Chrome versions).
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!("openerTabId" in changeInfo)) return;
  const tree = await getTree();
  if (!tree[tabId]) {
    tree[tabId] = { parentId: null, color: null, customName: null, collapsed: false, locked: false };
  }
  tree[tabId].parentId =
    typeof changeInfo.openerTabId === "number" ? changeInfo.openerTabId : null;
  await setTree(tree);
});

// Handle attach/detach (tab dragged between windows) - parentId relationships
// are independent of window, so no tree change is needed, but we make sure an
// entry still exists.
chrome.tabs.onAttached.addListener(async (tabId) => {
  const tree = await getTree();
  if (!tree[tabId]) {
    tree[tabId] = { parentId: null, color: null, customName: null, collapsed: false, locked: false };
    await setTree(tree);
  }
});
