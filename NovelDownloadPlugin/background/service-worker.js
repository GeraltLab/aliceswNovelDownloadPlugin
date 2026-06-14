import {
  CATALOG_URL_RE,
  DEFAULT_SETTINGS,
  tabStorageKey,
  buildFilename,
  buildChapterRangeSuffix,
  MIN_INTERVAL_SEC,
  MAX_RETRIES,
} from "../lib/constants.js";
import {
  parseChapterBookUrl,
  parseApiChapterContentHtml,
  assembleNovelText,
} from "../lib/parser.js";

const activeJobs = new Map();
let pendingDownloadFilename = null;

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const filename = pendingDownloadFilename;
  if (!filename) return;
  if (item.byExtensionId && item.byExtensionId !== chrome.runtime.id) return;
  pendingDownloadFilename = null;
  suggest({ filename, conflictAction: "uniquify" });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

function isCatalogUrl(url) {
  return url && CATALOG_URL_RE.test(String(url).split("#")[0]);
}

function showNonCatalogAlert(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const style = document.createElement('style');
      style.textContent = `
        .novel-download-alert {
          position: fixed; top: 20px; right: 20px;
          background: linear-gradient(135deg, #4a6cf7 0%, #6b4ce6 100%);
          color: white; padding: 16px 20px; border-radius: 12px;
          box-shadow: 0 10px 40px rgba(0,0,0,0.2); font-size: 14px;
          z-index: 99999; max-width: 320px; animation: slideIn 0.3s ease;
        }
        .novel-download-alert .close-btn {
          position: absolute; top: 8px; right: 8px;
          width: 24px; height: 24px; border: none;
          background: rgba(255,255,255,0.2); border-radius: 50%;
          color: white; cursor: pointer; font-size: 14px;
          display: flex; align-items: center; justify-content: center;
        }
        .novel-download-alert .close-btn:hover { background: rgba(255,255,255,0.3); }
        @keyframes slideIn {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `;
      document.head.appendChild(style);
      const alert = document.createElement('div');
      alert.className = 'novel-download-alert';
      alert.innerHTML = '<button class="close-btn">&times;</button><p style="margin:0;line-height:1.5;">请在爱丽丝书屋的小说详情页，点击查看所有章节，再进行下载。</p>';
      document.body.appendChild(alert);
      const closeBtn = alert.querySelector('.close-btn');
      closeBtn.addEventListener('click', () => alert.remove());
      setTimeout(() => { if (alert.parentNode) alert.remove(); }, 5000);
    },
  }).catch(() => {});
}

chrome.action.onClicked.addListener(async (tab) => {
  const url = tab?.url ?? "";
  if (isCatalogUrl(url)) {
    chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: "sidepanel/sidepanel.html",
      enabled: true,
    }).catch(() => {});
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  } else {
    chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false }).catch(() => {});
    showNonCatalogAlert(tab.id);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    const url = tab.url ?? changeInfo.url ?? "";
    if (isCatalogUrl(url)) {
      chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel/sidepanel.html",
        enabled: true,
      }).catch(() => {});
    } else {
      chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
    }
    notifyActiveTabContextChanged();
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const job = activeJobs.get(tabId);
  if (job) {
    job.abort = true;
    await closeScraperTab();
    broadcastProgress(tabId, { phase: "cancelled", statusText: "目录页已关闭，下载已取消", cancelled: true });
  }
  activeJobs.delete(tabId);
  await chrome.storage.session.remove(tabStorageKey(tabId));
});

let lastActiveTabId = null;

chrome.tabs.onActivated.addListener(async ({ tabId, previousTabId }) => {
  if (previousTabId !== void 0 && previousTabId !== tabId) {
    chrome.sidePanel.setOptions({ tabId: previousTabId, enabled: false }).catch(() => {});
  }
  lastActiveTabId = tabId;
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url ?? "";
    if (isCatalogUrl(url)) {
      chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel/sidepanel.html",
        enabled: true,
      }).catch(() => {});
    } else {
      chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
    }
  } catch {}
  notifyActiveTabContextChanged();
});

async function getTabState(tabId) {
  const key = tabStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] ?? null;
}

async function setTabState(tabId, state) {
  const key = tabStorageKey(tabId);
  await chrome.storage.session.set({ [key]: state });
}

async function mergeTabState(tabId, patch) {
  const current = (await getTabState(tabId)) ?? {};
  const next = { ...current, ...patch };
  await setTabState(tabId, next);
  return next;
}

function sleep(ms, shouldAbort = null) {
  if (!shouldAbort) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (shouldAbort()) { reject(new Error("已取消")); return; }
      if (Date.now() - start >= ms) { resolve(); return; }
      setTimeout(tick, Math.min(100, ms - (Date.now() - start)));
    };
    tick();
  });
}

function notifyActiveTabContextChanged() {
  chrome.runtime.sendMessage({ type: "ACTIVE_TAB_CONTEXT" }).catch(() => {});
}

function chapterPathname(url) {
  try { return new URL(url).pathname; } catch { return ""; }
}

function extractParagraphsAndStopLoading() {
  const content = document.querySelector(".read-content.j_readContent") ?? document.querySelector(".read-content.j_readContent.user_ad_content");
  if (!content) return null;
  const paragraphs = [];
  for (const child of content.children) {
    if (child.tagName === "P") paragraphs.push(child.textContent ?? "");
  }
  if (paragraphs.length === 0) return null;
  try { window.stop(); } catch {}
  return paragraphs;
}

async function parseCatalogInTab(tabId) {
  try { return await chrome.tabs.sendMessage(tabId, { type: "PARSE_CATALOG" }); } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content/catalog.js"] });
  await sleep(200);
  try { return await chrome.tabs.sendMessage(tabId, { type: "PARSE_CATALOG" }); }
  catch (err) { throw new Error("无法连接目录页脚本，请刷新目录页后重试（F5）"); }
}

const CHAPTER_API = "https://www.alicesw.com/home/chapter/info";

async function fetchChapterParagraphsFromApi(chapterUrl, shouldAbort) {
  const parsed = parseChapterBookUrl(chapterUrl);
  if (!parsed) throw new Error("无效的章节链接");
  if (shouldAbort?.()) throw new Error("已取消");
  const apiUrl = `${CHAPTER_API}?id=${encodeURIComponent(parsed.sourceId)}&key=${encodeURIComponent(parsed.key)}`;
  const controller = new AbortController();
  if (shouldAbort) {
    const timer = setInterval(() => { if (shouldAbort()) { controller.abort(); clearInterval(timer); } }, 50);
    controller.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  }
  const response = await fetch(apiUrl, {
    credentials: "omit", signal: controller.signal,
    headers: { Accept: "application/json, text/javascript, */*; q=0.01", Referer: chapterUrl, "X-Requested-With": "XMLHttpRequest" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  if (json?.code !== 1) throw new Error(json?.msg || "章节 API 返回失败");
  const contentHtml = json?.data?.chapter?.content ?? "";
  const paragraphs = parseApiChapterContentHtml(contentHtml);
  if (paragraphs.length === 0) throw new Error("未解析到章节正文");
  return paragraphs;
}

let scraperTabId = null;

function waitForChapterParagraphs(tabId, chapterUrl, shouldAbort, timeoutMs = 12_000) {
  const expectedPath = chapterPathname(chapterUrl);
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = async () => {
      if (shouldAbort?.()) { reject(new Error("已取消")); return; }
      if (Date.now() > deadline) { reject(new Error("章节页面加载超时")); return; }
      try {
        const tab = await chrome.tabs.get(tabId);
        if (chapterPathname(tab.url ?? "") !== expectedPath) { setTimeout(poll, 80); return; }
        const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: extractParagraphsAndStopLoading });
        if (result?.length) { resolve(result); return; }
      } catch {}
      setTimeout(poll, 80);
    };
    poll();
  });
}

async function getScraperTab() {
  if (scraperTabId != null) {
    try { await chrome.tabs.get(scraperTabId); return scraperTabId; }
    catch { scraperTabId = null; }
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  scraperTabId = tab.id ?? null;
  return scraperTabId;
}

async function fetchChapterParagraphsFromTab(chapterUrl, shouldAbort) {
  const tabId = await getScraperTab();
  if (!tabId) throw new Error("无法创建抓取标签页");
  if (shouldAbort?.()) throw new Error("已取消");
  const loadPromise = waitForChapterParagraphs(tabId, chapterUrl, shouldAbort);
  await chrome.tabs.update(tabId, { url: chapterUrl });
  return loadPromise;
}

async function closeScraperTab() {
  if (scraperTabId == null) return;
  try { await chrome.tabs.remove(scraperTabId); } catch {}
  scraperTabId = null;
}

async function fetchChapterParagraphs(chapterUrl, shouldAbort) {
  try { return await fetchChapterParagraphsFromApi(chapterUrl, shouldAbort); }
  catch (apiErr) {
    if (shouldAbort?.()) throw new Error("已取消");
    try { return await fetchChapterParagraphsFromTab(chapterUrl, shouldAbort); }
    catch (tabErr) {
      if (String(tabErr?.message ?? tabErr).includes("已取消")) throw tabErr;
      throw new Error(`${String(apiErr?.message ?? apiErr)}；备用抓取失败：${String(tabErr?.message ?? tabErr)}`);
    }
  }
}

async function fetchWithRetry(url, shouldAbort) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (shouldAbort?.()) throw new Error("已取消");
    try { return await fetchChapterParagraphs(url, shouldAbort); }
    catch (err) {
      lastError = err;
      if (String(err?.message ?? err).includes("已取消")) throw err;
      if (attempt < MAX_RETRIES) await sleep(500, shouldAbort);
    }
  }
  throw lastError;
}

function broadcastProgress(tabId, data) {
  chrome.runtime.sendMessage({ type: "DOWNLOAD_PROGRESS", tabId, ...data }).catch(() => {});
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return contexts.length > 0;
  }
  if (chrome.offscreen?.hasDocument) return chrome.offscreen.hasDocument();
  return false;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({ url: "offscreen/offscreen.html", reasons: ["BLOBS"], justification: "Create blob URLs for TXT downloads" });
}

function revokeBlobUrl(objectUrl) {
  if (!objectUrl) return;
  chrome.runtime.sendMessage({ type: "OFFSCREEN_REVOKE_BLOB_URL", objectUrl }).catch(() => {});
}

async function downloadTextFile(filename, text) {
  await ensureOffscreenDocument();
  await sleep(100);
  let blobRes = null;
  let lastError = new Error("创建下载数据失败");
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "OFFSCREEN_CREATE_BLOB_URL", text });
      if (res?.ok && res.objectUrl) { blobRes = res; break; }
      lastError = new Error(res?.error || "创建下载数据失败");
    } catch (err) { lastError = err; }
    await sleep(150);
  }
  if (!blobRes?.objectUrl) throw lastError;

  const { objectUrl } = blobRes;
  pendingDownloadFilename = filename;
  const clearPending = () => { if (pendingDownloadFilename === filename) pendingDownloadFilename = null; };
  setTimeout(clearPending, 30_000);

  try {
    const downloadId = await chrome.downloads.download({ url: objectUrl, filename, saveAs: false, conflictAction: "uniquify" });
    setTimeout(() => revokeBlobUrl(objectUrl), 120_000);
    return downloadId;
  } catch (err) {
    clearPending();
    revokeBlobUrl(objectUrl);
    throw err;
  }
}

async function runDownloadJob(tabId, selectedIndices, settings) {
  const state = await getTabState(tabId);
  if (!state?.chapters?.length) throw new Error("无章节数据，请先打开目录页");

  const job = { abort: false };
  activeJobs.set(tabId, job);

  const chapters = selectedIndices.filter((i) => i >= 0 && i < state.chapters.length).sort((a, b) => a - b).map((i) => state.chapters[i]);
  const intervalMs = Math.max(settings.intervalSec, MIN_INTERVAL_SEC) * 1000;
  const batchSize = Math.max(1, Math.floor(settings.batchSize));
  const batchPauseMs = Math.max(0, settings.batchPauseSec) * 1000;

  const blocks = [];
  const failed = [];
  let cancelled = false;
  const shouldAbort = () => job.abort;

  try {
    for (let i = 0; i < chapters.length; i++) {
      if (job.abort) { cancelled = true; break; }
      const ch = chapters[i];
      broadcastProgress(tabId, { phase: "downloading", current: i + 1, total: chapters.length, chapterTitle: ch.title, statusText: `正在下载：${ch.title}` });

      try {
        const paragraphs = await fetchWithRetry(ch.url, shouldAbort);
        blocks.push({ title: ch.title, paragraphs });
      } catch (err) {
        if (job.abort || String(err?.message ?? err).includes("已取消")) { cancelled = true; break; }
        failed.push({ title: ch.title, error: String(err?.message ?? err) });
        broadcastProgress(tabId, { phase: "downloading", current: i + 1, total: chapters.length, chapterTitle: ch.title, statusText: `章节失败：${ch.title}`, lastError: String(err?.message ?? err) });
      }

      if (job.abort) { cancelled = true; break; }
      const isLast = i === chapters.length - 1;
      if (!isLast && !job.abort) {
        await sleep(intervalMs, shouldAbort);
        if ((i + 1) % batchSize === 0) {
          broadcastProgress(tabId, { phase: "batch_pause", current: i + 1, total: chapters.length, statusText: `已下载 ${i + 1} 章，暂停 ${settings.batchPauseSec} 秒…` });
          await sleep(batchPauseMs, shouldAbort);
        }
      }
    }

    if (blocks.length === 0) {
      broadcastProgress(tabId, { phase: "error", statusText: cancelled ? "已取消，无已下载内容" : "全部章节下载失败", failed, cancelled });
      return { success: false, cancelled, failed, blocks };
    }

    const text = assembleNovelText(blocks);
    const rangeSuffix = buildChapterRangeSuffix(selectedIndices, state.chapters.length);
    const filename = buildFilename(state.novelName, state.author, rangeSuffix);
    broadcastProgress(tabId, { phase: "saving", statusText: "正在生成并保存 TXT 文件…", current: blocks.length, total: chapters.length });
    await downloadTextFile(filename, text);
    const allSucceeded = failed.length === 0 && !cancelled;

    if (allSucceeded) {
      await chrome.storage.session.remove(tabStorageKey(tabId));
      broadcastProgress(tabId, { phase: "done", statusText: `下载完成：${filename}`, current: blocks.length, total: chapters.length, cleared: true });
    } else {
      const reason = cancelled ? "任务已取消，已保存已完成章节" : `部分章节失败（${failed.length}），已保存已完成章节`;
      broadcastProgress(tabId, { phase: cancelled ? "cancelled" : "partial", statusText: `${reason}：${filename}`, current: blocks.length, total: chapters.length, failed, cancelled });
    }
    return { success: allSucceeded, cancelled, failed, filename };
  } finally {
    await closeScraperTab();
    activeJobs.delete(tabId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handle = async () => {
    if (message.type === "CATALOG_PARSED") {
      const tabId = sender.tab?.id;
      if (!tabId) return { ok: false };
      const selected = message.payload.chapters.map(() => true);
      await setTabState(tabId, { ...message.payload, selected, settings: DEFAULT_SETTINGS });
      chrome.runtime.sendMessage({ type: "CATALOG_UPDATED", tabId }).catch(() => {});
      return { ok: true };
    }
    if (message.type === "GET_TAB_STATE") {
      const state = await getTabState(message.tabId);
      return { ok: true, state };
    }
    if (message.type === "SAVE_TAB_STATE") {
      const state = await mergeTabState(message.tabId, message.patch);
      return { ok: true, state };
    }
    if (message.type === "RELOAD_CATALOG" || message.type === "REQUEST_PARSE") {
      const tabId = message.tabId;
      const tab = await chrome.tabs.get(tabId);
      if (!isCatalogUrl(tab.url ?? "")) return { ok: false, error: "当前标签页不是小说目录页" };
      const res = await parseCatalogInTab(tabId);
      return { ok: true, chapterCount: res?.chapterCount ?? 0 };
    }
    if (message.type === "START_DOWNLOAD") {
      const { tabId, selectedIndices, settings } = message;
      if (activeJobs.has(tabId)) return { ok: false, error: "已有下载任务在进行中" };
      runDownloadJob(tabId, selectedIndices, settings).catch((err) => broadcastProgress(tabId, { phase: "error", statusText: String(err?.message ?? err) }));
      return { ok: true };
    }
    if (message.type === "CANCEL_DOWNLOAD") {
      const job = activeJobs.get(message.tabId);
      if (job) { job.abort = true; return { ok: true }; }
      return { ok: false, error: "没有进行中的任务" };
    }
    if (message.type === "IS_JOB_ACTIVE") return { ok: true, active: activeJobs.has(message.tabId) };
    return { ok: false, error: "unknown message" };
  };
  handle().then(sendResponse).catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
  return true;
});