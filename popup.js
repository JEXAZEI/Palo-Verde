// Leaf Tabs - popup script
const STORE_KEY = "leafTree";

const treeEl = document.getElementById("tree");
const colorPopover = document.getElementById("colorPopover");
const expandAllBtn = document.getElementById("expandAllBtn");
const collapseAllBtn = document.getElementById("collapseAllBtn");
const refreshBtn = document.getElementById("refreshBtn");

let tabsById = new Map();
let tree = {};
let colorPopoverTargetId = null;
let currentWindowFocusedTabId = null;

async function getTree() {
  const data = await chrome.storage.local.get(STORE_KEY);
  return data[STORE_KEY] || {};
}

async function setTree(next) {
  tree = next;
  await chrome.storage.local.set({ [STORE_KEY]: tree });
}

function ensureEntry(tabId) {
  if (!tree[tabId]) {
    tree[tabId] = {
      parentId: null,
      color: null,
      customName: null,
      collapsed: false,
      locked: false,
    };
  }
  return tree[tabId];
}

async function loadAndRender() {
  const [tabs, storedTree] = await Promise.all([
    chrome.tabs.query({}),
    getTree(),
  ]);

  tree = storedTree;
  tabsById = new Map(tabs.map((t) => [t.id, t]));

  // Reconcile: make sure every open tab has an entry, and drop entries for
  // tabs that no longer exist (covers tabs opened/closed while popup was shut).
  const openIds = new Set(tabsById.keys());
  let dirty = false;
  for (const tab of tabs) {
    if (!tree[tab.id]) {
      tree[tab.id] = {
        parentId: typeof tab.openerTabId === "number" ? tab.openerTabId : null,
        color: null,
        customName: null,
        collapsed: false,
        locked: false,
      };
      dirty = true;
    }
  }
  for (const idStr of Object.keys(tree)) {
    if (!openIds.has(Number(idStr))) {
      const removedId = Number(idStr);
      const formerParentId = tree[removedId].parentId;
      for (const node of Object.values(tree)) {
        if (node.parentId === removedId) node.parentId = formerParentId;
      }
      delete tree[idStr];
      dirty = true;
    }
  }
  if (dirty) await setTree(tree);

  const active = tabs.find((t) => t.active);
  currentWindowFocusedTabId = active ? active.id : null;

  render();
}

function buildChildMap() {
  const childMap = new Map();
  const validIds = new Set(tabsById.keys());

  for (const idStr of Object.keys(tree)) {
    const id = Number(idStr);
    if (!validIds.has(id)) continue;
    let parentId = tree[id].parentId;
    // Guard against dangling/self/cyclic parents - treat as root.
    if (parentId === id || (parentId != null && !validIds.has(parentId))) {
      parentId = null;
    }
    if (!childMap.has(parentId)) childMap.set(parentId, []);
    childMap.get(parentId).push(id);
  }

  for (const list of childMap.values()) {
    list.sort((a, b) => {
      const ta = tabsById.get(a)?.index ?? 0;
      const tb = tabsById.get(b)?.index ?? 0;
      return ta - tb;
    });
  }

  return childMap;
}

function displayTitle(tabId) {
  const entry = tree[tabId];
  if (entry?.customName) return entry.customName;
  const tab = tabsById.get(tabId);
  return tab?.title || tab?.url || "Untitled tab";
}

function render() {
  treeEl.innerHTML = "";
  const childMap = buildChildMap();
  const roots = childMap.get(null) || [];

  if (roots.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-msg";
    empty.textContent = "No tabs found.";
    treeEl.appendChild(empty);
    return;
  }

  for (const rootId of roots) {
    treeEl.appendChild(buildNode(rootId, childMap));
  }
}

function buildNode(tabId, childMap) {
  const tab = tabsById.get(tabId);
  const entry = ensureEntry(tabId);
  const children = childMap.get(tabId) || [];

  const wrapper = document.createElement("div");
  wrapper.className = "node-wrapper";

  const node = document.createElement("div");
  node.className = "node";
  node.dataset.tabId = String(tabId);
  if (tab?.active && tab?.id === currentWindowFocusedTabId) node.classList.add("active");
  if (tab?.discarded) node.classList.add("discarded");
  if (entry.color) {
    node.style.borderLeftColor = entry.color;
  }

  const toggle = document.createElement("span");
  toggle.className = "toggle" + (children.length === 0 ? " leaf" : "");
  toggle.textContent = entry.collapsed ? "▶" : "▼";
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    entry.collapsed = !entry.collapsed;
    setTree(tree).then(render);
  });

  const favicon = document.createElement("span");
  favicon.className = "favicon";
  if (tab?.favIconUrl) {
    favicon.style.backgroundImage = `url("${tab.favIconUrl}")`;
  } else {
    favicon.textContent = "📄";
  }

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = displayTitle(tabId);
  title.title = tab?.url || "";
  title.addEventListener("dblclick", (e) => {
    cancelPendingActivation(tabId);
    startRename(title, tabId);
  });

  const actions = document.createElement("span");
  actions.className = "actions";

  const colorBtn = document.createElement("button");
  colorBtn.className = "action-btn";
  colorBtn.title = "Set color";
  colorBtn.textContent = "●";
  colorBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openColorPopover(tabId, colorBtn);
  });

  const unloadBtn = document.createElement("button");
  unloadBtn.className = "action-btn";
  unloadBtn.title = tab?.discarded ? "Already unloaded" : "Unload tab (free memory)";
  unloadBtn.textContent = "⏻";
  unloadBtn.disabled = !!tab?.discarded || !!tab?.active;
  unloadBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await chrome.tabs.discard(tabId);
    } catch (err) {
      // Discard can fail for the active tab or special pages; ignore.
    }
    await loadAndRender();
  });

  const lockBtn = document.createElement("button");
  lockBtn.className = "action-btn";
  lockBtn.title = entry.locked ? "Unlock tab" : "Lock tab (protect from closing)";
  lockBtn.textContent = entry.locked ? "🔒" : "🔓";
  lockBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    entry.locked = !entry.locked;
    await setTree(tree);
    render();
  });

  const closeBtn = document.createElement("button");
  closeBtn.className = "action-btn";
  closeBtn.title = entry.locked ? "Locked - unlock to close" : "Close tab";
  closeBtn.textContent = "✕";
  closeBtn.disabled = !!entry.locked;
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (entry.locked) return;
    chrome.tabs.remove(tabId);
  });

  actions.append(colorBtn, lockBtn, unloadBtn, closeBtn);
  node.append(toggle, favicon, title, actions);
  if (entry.locked) node.classList.add("locked");

  node.addEventListener("click", () => scheduleActivation(tabId));
  node.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openColorPopover(tabId, node);
  });

  wrapper.appendChild(node);

  if (children.length > 0) {
    const childrenEl = document.createElement("div");
    childrenEl.className = "children" + (entry.collapsed ? " collapsed" : "");
    childrenEl.style.paddingLeft = "18px";
    for (const childId of children) {
      childrenEl.appendChild(buildNode(childId, childMap));
    }
    wrapper.appendChild(childrenEl);
  }

  return wrapper;
}

// A double-click on the title is preceded by two ordinary "click" events, so
// a naive click handler would activate (and close) the popup before the
// dblclick ever fires. Delay activation briefly so a following dblclick can
// cancel it in favor of renaming instead.
const pendingActivations = new Map();

function scheduleActivation(tabId) {
  cancelPendingActivation(tabId);
  const timer = setTimeout(() => {
    pendingActivations.delete(tabId);
    activateTab(tabId);
  }, 220);
  pendingActivations.set(tabId, timer);
}

function cancelPendingActivation(tabId) {
  const timer = pendingActivations.get(tabId);
  if (timer) {
    clearTimeout(timer);
    pendingActivations.delete(tabId);
  }
}

async function activateTab(tabId) {
  const tab = tabsById.get(tabId);
  if (!tab) return;
  try {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (err) {
    // Tab may have vanished between render and click; refresh to recover.
    await loadAndRender();
    return;
  }
  window.close();
}

function startRename(titleEl, tabId) {
  const entry = ensureEntry(tabId);
  titleEl.contentEditable = "true";
  titleEl.focus();
  document.execCommand("selectAll", false, null);

  const finish = async (save) => {
    titleEl.contentEditable = "false";
    titleEl.removeEventListener("blur", onBlur);
    titleEl.removeEventListener("keydown", onKeydown);
    if (save) {
      const value = titleEl.textContent.trim();
      entry.customName = value.length > 0 ? value : null;
      await setTree(tree);
    }
    render();
  };

  const onBlur = () => finish(true);
  const onKeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  };

  titleEl.addEventListener("blur", onBlur);
  titleEl.addEventListener("keydown", onKeydown);
}

function openColorPopover(tabId, anchorEl) {
  colorPopoverTargetId = tabId;
  const rect = anchorEl.getBoundingClientRect();
  colorPopover.style.top = `${rect.bottom + 4}px`;
  let left = rect.left;
  const maxLeft = document.documentElement.clientWidth - 160;
  if (left > maxLeft) left = maxLeft;
  colorPopover.style.left = `${Math.max(4, left)}px`;
  colorPopover.classList.remove("hidden");
}

function closeColorPopover() {
  colorPopover.classList.add("hidden");
  colorPopoverTargetId = null;
}

colorPopover.addEventListener("click", async (e) => {
  const swatch = e.target.closest(".swatch");
  if (!swatch || colorPopoverTargetId == null) return;
  const entry = ensureEntry(colorPopoverTargetId);
  const color = swatch.dataset.color;
  entry.color = color || null;
  await setTree(tree);
  closeColorPopover();
  render();
});

document.addEventListener("click", (e) => {
  if (!colorPopover.contains(e.target)) closeColorPopover();
});

expandAllBtn.addEventListener("click", async () => {
  for (const entry of Object.values(tree)) entry.collapsed = false;
  await setTree(tree);
  render();
});

collapseAllBtn.addEventListener("click", async () => {
  for (const entry of Object.values(tree)) entry.collapsed = true;
  await setTree(tree);
  render();
});

refreshBtn.addEventListener("click", loadAndRender);

// Keep the popup live while it's open, in case tabs change in the background.
chrome.tabs.onCreated.addListener(loadAndRender);
chrome.tabs.onRemoved.addListener(loadAndRender);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (
    "title" in changeInfo ||
    "favIconUrl" in changeInfo ||
    "status" in changeInfo ||
    "discarded" in changeInfo
  ) {
    loadAndRender();
  }
});
chrome.tabs.onActivated.addListener(loadAndRender);
chrome.tabs.onMoved.addListener(loadAndRender);

loadAndRender();
