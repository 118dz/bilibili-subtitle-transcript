const elements = {
  videoTitle: document.getElementById("videoTitle"),
  refreshButton: document.getElementById("refreshButton"),
  subtitleSelect: document.getElementById("subtitleSelect"),
  timestampToggle: document.getElementById("timestampToggle"),
  transcript: document.getElementById("transcript"),
  copyButton: document.getElementById("copyButton"),
  downloadTxtButton: document.getElementById("downloadTxtButton"),
  downloadSrtButton: document.getElementById("downloadSrtButton"),
  status: document.getElementById("status")
};

let activeTab = null;
let pageInfo = null;
let currentResult = null;
let isLoading = false;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

elements.refreshButton.addEventListener("click", () => loadTranscript());
elements.subtitleSelect.addEventListener("change", () => {
  loadTranscript(Number(elements.subtitleSelect.value));
});
elements.timestampToggle.addEventListener("change", renderTranscript);
elements.copyButton.addEventListener("click", copyTranscript);
elements.downloadTxtButton.addEventListener("click", () => downloadText("txt"));
elements.downloadSrtButton.addEventListener("click", () => downloadText("srt"));

async function init() {
  try {
    setBusy(true, "正在检查当前标签页...");

    const tabs = await chromeTabsQuery({ active: true, currentWindow: true });
    activeTab = tabs[0] || null;

    if (!activeTab?.url || !/https:\/\/www\.bilibili\.com\/(video|bangumi\/play)\//.test(activeTab.url)) {
      setBusy(false, "请先打开一个 B 站视频播放页。", true);
      return;
    }

    pageInfo = await readPageInfo(activeTab.id);
    await loadTranscript();
  } catch (error) {
    setBusy(false, formatUserFacingError(error.message || String(error)), true);
  }
}

async function readPageInfo(tabId) {
  const info = await chromeSendTabMessage(tabId, { type: "BILI_SUBTITLE_PAGE_INFO" }).catch(() => null);
  if (info) return info;

  await chromeExecuteScript({
    target: { tabId },
    files: ["content-script.js"]
  }).catch(() => null);

  return chromeSendTabMessage(tabId, { type: "BILI_SUBTITLE_PAGE_INFO" }).catch(() => null);
}

async function loadTranscript(subtitleIndex = null) {
  if (!activeTab || isLoading) return;

  setBusy(true, "正在读取字幕...");
  setActionsEnabled(false);

  try {
    const response = await chromeRuntimeSendMessage({
      type: "BILI_SUBTITLE_FETCH",
      payload: {
        url: activeTab.url,
        pageInfo,
        subtitleIndex
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "读取失败");
    }

    currentResult = response.data;
    renderResult(currentResult);
    if (currentResult.quality?.warning) {
      setBusy(false, currentResult.quality.warning, true);
    } else {
      setBusy(false, `已整理 ${currentResult.segments.length} 段文字稿。`);
    }
  } catch (error) {
    currentResult = null;
    elements.transcript.value = "";
    elements.videoTitle.textContent = "读取失败";
    setActionsEnabled(false);
    setBusy(false, formatUserFacingError(error.message || String(error)), true);
  }
}

function renderResult(result) {
  const title = [result.video.title, result.video.partTitle].filter(Boolean).join(" / ");
  elements.videoTitle.textContent = title || "B站视频";

  renderSubtitleOptions(result.subtitles, result.selectedIndex);
  renderTranscript();
  setActionsEnabled(true);
}

function renderSubtitleOptions(subtitles, selectedIndex) {
  elements.subtitleSelect.textContent = "";

  for (const subtitle of subtitles) {
    const option = document.createElement("option");
    option.value = String(subtitle.index);
    option.textContent = `${subtitle.languageName} · ${subtitle.isAi ? "AI" : "字幕"}`;
    elements.subtitleSelect.append(option);
  }

  elements.subtitleSelect.value = String(selectedIndex);
  elements.subtitleSelect.disabled = subtitles.length <= 1;
}

function renderTranscript() {
  if (!currentResult) return;
  elements.transcript.value = elements.timestampToggle.checked
    ? currentResult.timestampText
    : currentResult.plainText;
}

async function copyTranscript() {
  if (!currentResult) return;
  if (!elements.transcript.value.trim()) {
    setStatus("当前没有可复制的文字，请重新读取。", true);
    return;
  }

  try {
    await navigator.clipboard.writeText(elements.transcript.value);
    setStatus("已复制到剪贴板。");
  } catch (error) {
    setStatus("复制失败，请手动选中文字复制。", true);
  }
}

function downloadText(type) {
  if (!currentResult) return;

  const isSrt = type === "srt";
  const content = isSrt ? currentResult.srtText : elements.transcript.value;
  if (!content.trim()) {
    setStatus("当前没有可下载的文字，请重新读取。", true);
    return;
  }

  const blob = new Blob([content], { type: isSrt ? "application/x-subrip" : "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = `${currentResult.fileBaseName}.${isSrt ? "srt" : "txt"}`;
  anchor.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setBusy(busy, message, isError = false) {
  isLoading = busy;
  elements.refreshButton.disabled = busy;
  setStatus(message, isError);
}

function setActionsEnabled(enabled) {
  elements.copyButton.disabled = !enabled;
  elements.downloadTxtButton.disabled = !enabled;
  elements.downloadSrtButton.disabled = !enabled;
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", Boolean(isError));
}

function chromeTabsQuery(queryInfo) {
  return chromeCall((done) => chrome.tabs.query(queryInfo, done), "读取当前标签页超时");
}

function chromeSendTabMessage(tabId, message) {
  return chromeCall((done) => chrome.tabs.sendMessage(tabId, message, done), "读取页面信息超时", 2500);
}

function chromeRuntimeSendMessage(message) {
  return chromeCall((done) => chrome.runtime.sendMessage(message, done), "读取字幕超时，请刷新视频页后重试", 20000);
}

function chromeExecuteScript(details) {
  if (!chrome.scripting?.executeScript) {
    return Promise.resolve(null);
  }

  return chromeCall((done) => chrome.scripting.executeScript(details, done), "注入页面脚本超时", 3000);
}

function chromeCall(start, timeoutMessage, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(reject, new Error(timeoutMessage)), timeoutMs);

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    }

    try {
      start((result) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          finish(reject, new Error(lastError.message));
          return;
        }

        finish(resolve, result);
      });
    } catch (error) {
      finish(reject, error);
    }
  });
}

function formatUserFacingError(message) {
  const text = String(message || "");
  if (/Extension context invalidated|context invalidated/i.test(text)) {
    return "插件刚更新或在扩展页被重新加载了，请刷新当前 B 站视频页面一次。";
  }

  if (/Receiving end does not exist|Could not establish connection/i.test(text)) {
    return "页面脚本还没有接上插件，请刷新当前 B 站视频页面一次。";
  }

  return text;
}
