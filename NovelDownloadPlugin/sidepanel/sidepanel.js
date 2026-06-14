import {
  MIN_INTERVAL_SEC,
  DEFAULT_SETTINGS,
  CATALOG_URL_RE,
} from "../lib/constants.js";

const USER_SETTINGS_KEY = "novel_download_user_settings";

function isCatalogUrl(url) {
  return url && CATALOG_URL_RE.test(String(url).split("#")[0]);
}

function loadUserSettings() {
  try {
    const saved = localStorage.getItem(USER_SETTINGS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch {
    /* ignore parse errors */
  }
  return { ...DEFAULT_SETTINGS };
}

function saveUserSettings(settings) {
  try {
    localStorage.setItem(USER_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore storage errors */
  }
}

const $ = (sel) => document.querySelector(sel);

const novelMeta = $("#novel-meta");
const chapterList = $("#chapter-list");
const statusEl = $("#status");
const progressSection = $("#progress-section");
const progressBar = $("#progress-bar");
const progressText = $("#progress-text");

const btnSelectAll = $("#btn-select-all");
const btnSelectNone = $("#btn-select-none");
const btnReload = $("#btn-reload");
const btnDownload = $("#btn-download");
const btnCancel = $("#btn-cancel");

const inputInterval = $("#input-interval");
const inputBatchSize = $("#input-batch-size");
const inputBatchPause = $("#input-batch-pause");

let currentTabId = null;
let state = null;
let lastClickedIndex = null;
let downloading = false;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function readSettingsFromUI() {
  const intervalSec = Math.max(
    parseFloat(inputInterval.value) || DEFAULT_SETTINGS.intervalSec,
    MIN_INTERVAL_SEC
  );
  const batchSize = Math.max(
    1,
    Math.floor(parseFloat(inputBatchSize.value) || DEFAULT_SETTINGS.batchSize)
  );
  const batchPauseSec = Math.max(
    0,
    parseFloat(inputBatchPause.value) ?? DEFAULT_SETTINGS.batchPauseSec
  );
  return { intervalSec, batchSize, batchPauseSec };
}

function applySettingsToUI(settings) {
  const userSaved = loadUserSettings();
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}), ...userSaved };
  inputInterval.value = String(s.intervalSec);
  inputBatchSize.value = String(s.batchSize);
  inputBatchPause.value = String(s.batchPauseSec);
}

function setStatus(text, isError = false) {
  statusEl.textContent = text ?? "";
  statusEl.style.background = isError ? "#fde8e8" : "";
  statusEl.style.borderColor = isError ? "#f5c2c2" : "";
}

function setDownloading(active) {
  downloading = active;
  const onCatalog = state?.chapters?.length;
  btnDownload.disabled = active || !onCatalog;
  btnReload.disabled = active || !onCatalog;
  btnSelectAll.disabled = active || !onCatalog;
  btnSelectNone.disabled = active || !onCatalog;
  btnCancel.hidden = !active;
  progressSection.hidden = !active;
  if (!active) {
    progressBar.style.width = "0%";
  }
}

function updateProgress(current, total, text) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  progressText.textContent = text ?? "";
}

function setToolbarEnabled(enabled) {
  btnSelectAll.disabled = !enabled;
  btnSelectNone.disabled = !enabled;
  btnReload.disabled = !enabled || downloading;
  btnDownload.disabled = !enabled || downloading;
}

function renderNonCatalogView() {
  state = null;
  setDownloading(false);
  setToolbarEnabled(false);
  novelMeta.textContent = "请切换到小说目录页以查看章节列表";
  chapterList.innerHTML = "";
  const li = document.createElement("li");
  li.className = "empty-hint";
  li.textContent = "当前不是目录页，章节列表已隐藏";
  chapterList.appendChild(li);
}

function renderMeta() {
  if (!state?.novelName) {
    novelMeta.textContent = "请打开 alicesw.com 的小说目录页，然后点击扩展图标打开本面板";
    return;
  }
  novelMeta.textContent = `《${state.novelName}》  作者：${state.author || "未知"}  （共 ${state.chapters?.length ?? 0} 章）`;
}

function renderChapterList() {
  chapterList.innerHTML = "";
  const chapters = state?.chapters ?? [];
  const selected = state?.selected ?? [];

  if (!chapters.length) {
    const li = document.createElement("li");
    li.className = "empty-hint";
    li.textContent = currentTabId
      ? "未解析到章节，请确认当前标签页为目录页后点击「重新加载目录」"
      : "无法获取当前标签页";
    chapterList.appendChild(li);
    return;
  }

  chapters.forEach((ch, index) => {
    const li = document.createElement("li");
    li.className = "chapter-item";
    li.dataset.index = String(index);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected[index] !== false;
    checkbox.dataset.index = String(index);

    const span = document.createElement("span");
    span.className = "chapter-title";
    span.textContent = ch.title;

    li.appendChild(checkbox);
    li.appendChild(span);

    li.addEventListener("click", (e) => {
      if (e.target === checkbox) return;
      checkbox.checked = !checkbox.checked;
      handleCheckboxClick(index, checkbox.checked, false);
    });

    checkbox.addEventListener("click", (e) => {
      e.stopPropagation();
      handleCheckboxClick(index, checkbox.checked, e.shiftKey);
    });

    chapterList.appendChild(li);
  });
}

function handleCheckboxClick(index, checked, shiftKey) {
  if (!state?.chapters) return;

  const checkboxes = [...chapterList.querySelectorAll('input[type="checkbox"]')];

  if (shiftKey && lastClickedIndex !== null && lastClickedIndex !== index) {
    const start = Math.min(lastClickedIndex, index);
    const end = Math.max(lastClickedIndex, index);
    for (let i = start; i <= end; i++) {
      if (!state.selected) state.selected = state.chapters.map(() => true);
      state.selected[i] = checked;
      if (checkboxes[i]) checkboxes[i].checked = checked;
    }
  } else {
    if (!state.selected) state.selected = state.chapters.map(() => true);
    state.selected[index] = checked;
  }

  lastClickedIndex = index;
  persistState();
}

async function persistState() {
  if (!currentTabId || !state) return;
  const settings = readSettingsFromUI();
  saveUserSettings(settings);
  state.settings = settings;
  await chrome.runtime.sendMessage({
    type: "SAVE_TAB_STATE",
    tabId: currentTabId,
    patch: {
      selected: state.selected,
      settings,
    },
  });
}

function waitForCatalogUpdated(tabId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve(false);
    }, timeoutMs);

    const listener = (message) => {
      if (message.type === "CATALOG_UPDATED" && message.tabId === tabId) {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(true);
      }
    };

    chrome.runtime.onMessage.addListener(listener);
  });
}

async function requestParseIfNeeded() {
  if (!currentTabId) return;
  if (state?.chapters?.length) return;

  const tab = await getActiveTab();
  const url = tab?.url ?? "";
  if (!url.includes("/other/chapters/id/")) return;

  setStatus("正在解析目录页…");
  const res = await chrome.runtime.sendMessage({
    type: "REQUEST_PARSE",
    tabId: currentTabId,
  });

  if (!res?.ok) {
    setStatus(res?.error ?? "解析失败", true);
    return;
  }

  await waitForCatalogUpdated(currentTabId, 8000);
}

async function loadState() {
  const tab = await getActiveTab();
  currentTabId = tab?.id ?? null;

  if (!currentTabId || !isCatalogUrl(tab?.url)) {
    renderNonCatalogView();
    return;
  }

  setToolbarEnabled(true);

  const res = await chrome.runtime.sendMessage({
    type: "GET_TAB_STATE",
    tabId: currentTabId,
  });

  state = res?.state ?? null;

  if (!state?.chapters?.length) {
    await requestParseIfNeeded();
    const again = await chrome.runtime.sendMessage({
      type: "GET_TAB_STATE",
      tabId: currentTabId,
    });
    state = again?.state ?? state;
  }
  if (state?.settings) {
    applySettingsToUI(state.settings);
  } else {
    applySettingsToUI(DEFAULT_SETTINGS);
  }

  const jobRes = await chrome.runtime.sendMessage({
    type: "IS_JOB_ACTIVE",
    tabId: currentTabId,
  });
  setDownloading(!!jobRes?.active);

  renderMeta();
  renderChapterList();
}

function getSelectedIndices() {
  const chapters = state?.chapters ?? [];
  const selected = state?.selected ?? chapters.map(() => true);
  return selected
    .map((on, i) => (on ? i : -1))
    .filter((i) => i >= 0);
}

btnSelectAll.addEventListener("click", async () => {
  if (!state?.chapters) return;
  state.selected = state.chapters.map(() => true);
  renderChapterList();
  await persistState();
});

btnSelectNone.addEventListener("click", async () => {
  if (!state?.chapters) return;
  state.selected = state.chapters.map(() => false);
  renderChapterList();
  await persistState();
});

btnReload.addEventListener("click", async () => {
  if (!currentTabId || downloading) return;
  setStatus("正在重新读取目录页…");
  btnReload.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "RELOAD_CATALOG",
      tabId: currentTabId,
    });
    if (!res?.ok) {
      setStatus(res?.error ?? "重新加载失败", true);
      return;
    }
    await waitForCatalogUpdated(currentTabId, 8000);
    const stateRes = await chrome.runtime.sendMessage({
      type: "GET_TAB_STATE",
      tabId: currentTabId,
    });
    state = stateRes?.state ?? null;
    if (state?.settings) applySettingsToUI(state.settings);
    renderMeta();
    renderChapterList();
    if (state?.chapters?.length) {
      setStatus(`目录已重新加载（${state.chapters.length} 章）`);
    } else {
      setStatus("仍未解析到章节，请刷新目录页（F5）后重试", true);
    }
  } catch (err) {
    setStatus(`重新加载失败：${err?.message ?? err}`, true);
  } finally {
    btnReload.disabled = downloading;
  }
});

btnDownload.addEventListener("click", async () => {
  if (!currentTabId || !state?.chapters?.length || downloading) return;

  const indices = getSelectedIndices();
  if (!indices.length) {
    setStatus("请至少勾选一个章节", true);
    return;
  }

  const settings = readSettingsFromUI();
  await persistState();

  setDownloading(true);
  setStatus("");
  updateProgress(0, indices.length, "准备下载…");

  const res = await chrome.runtime.sendMessage({
    type: "START_DOWNLOAD",
    tabId: currentTabId,
    selectedIndices: indices,
    settings,
  });

  if (!res?.ok) {
    setDownloading(false);
    setStatus(res?.error ?? "无法开始下载", true);
  }
});

btnCancel.addEventListener("click", async () => {
  if (!currentTabId) return;
  await chrome.runtime.sendMessage({
    type: "CANCEL_DOWNLOAD",
    tabId: currentTabId,
  });
  setStatus("正在取消…");
});

[inputInterval, inputBatchSize, inputBatchPause].forEach((el) => {
  el.addEventListener("change", () => persistState());
});

chrome.tabs.onActivated.addListener(() => {
  loadState();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([active]) => {
    if (active?.id === tabId) loadState();
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "ACTIVE_TAB_CONTEXT") {
    loadState();
    return;
  }

  if (message.type === "CATALOG_UPDATED" && message.tabId === currentTabId) {
    loadState().then(() => {
      if (state?.chapters?.length) {
        setStatus(`已加载 ${state.chapters.length} 章`);
      }
    });
    return;
  }

  if (message.type === "DOWNLOAD_PROGRESS" && message.tabId === currentTabId) {
    const { phase, current, total, statusText } = message;

    if (phase === "downloading" || phase === "batch_pause" || phase === "saving") {
      setDownloading(true);
      updateProgress(current ?? 0, total ?? 0, statusText);
    }

    if (phase === "done" || phase === "partial" || phase === "cancelled" || phase === "error") {
      setDownloading(false);
      if (total) updateProgress(current ?? 0, total, statusText);
      setStatus(statusText, phase === "error");
      if (phase === "done") {
        state = null;
        renderMeta();
        chapterList.innerHTML = "";
        const li = document.createElement("li");
        li.className = "empty-hint success";
        li.textContent = "下载完成！如需下载其他小说，请切换到相应的目录页";
        chapterList.appendChild(li);
        setToolbarEnabled(false);
      } else {
        loadState();
      }
    }
  }
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

loadState();
