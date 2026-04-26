const SCRIPT_VERSION = "1.1.2";
let subtitleResourceSince = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "BILI_SUBTITLE_PAGE_INFO") {
    return false;
  }

  sendResponse(readPageInfo());
  return false;
});

installTranscriptPanel();

function readPageInfo() {
  const urlInfo = readUrlVideoInfo();
  const state = readInitialState();
  const videoData = state?.videoData || state?.videoInfo || {};
  const epInfo = state?.epInfo || state?.mediaInfo || {};
  const rawPages = videoData.pages || state?.pages || [];
  const pages = Array.isArray(rawPages) ? rawPages : [];
  const page = urlInfo.page || readPageNumber();
  const stateBvid = videoData.bvid || state?.bvid || epInfo.bvid || "";
  const stateAid = videoData.aid || state?.aid || epInfo.aid || "";
  const stateMatchesUrl = Boolean(
    (!urlInfo.bvid && !urlInfo.aid) ||
    (urlInfo.bvid && stateBvid === urlInfo.bvid) ||
    (urlInfo.aid && String(stateAid) === String(urlInfo.aid))
  );
  const currentPage = pages[Math.max(0, page - 1)] || {};
  const visibleSubtitle = readVisibleSubtitleText();
  const subtitleAvailability = readSubtitleAvailability(visibleSubtitle);

  return {
    title: getCleanDocumentTitle(),
    bvid: urlInfo.bvid || (stateMatchesUrl ? stateBvid : ""),
    aid: urlInfo.aid || (stateMatchesUrl ? stateAid : ""),
    cid: urlInfo.cid || (stateMatchesUrl ? (state?.cid || videoData.cid || currentPage.cid || epInfo.cid || "") : ""),
    page,
    part: stateMatchesUrl ? (currentPage.part || "") : "",
    visibleSubtitle,
    subtitleAvailable: subtitleAvailability.available,
    subtitleAvailability,
    subtitleResources: subtitleAvailability.available ? readSubtitleResourceUrls() : [],
    pages: stateMatchesUrl ? pages.map((item) => ({
      cid: item.cid,
      page: item.page,
      part: item.part || ""
    })) : []
  };
}

function readSubtitleResourceUrls() {
  const urls = [];

  for (const entry of performance.getEntriesByType("resource")) {
    const name = String(entry.name || "");
    if (subtitleResourceSince && entry.startTime < subtitleResourceSince) continue;
    if (!isSubtitleResourceUrl(name)) continue;
    urls.push(name);
  }

  for (const element of document.querySelectorAll("track[src], [src*='subtitle'], [href*='subtitle']")) {
    const url = element.getAttribute("src") || element.getAttribute("href") || "";
    if (!url || !isSubtitleResourceUrl(url)) continue;
    try {
      urls.push(new URL(url, location.href).href);
    } catch (error) {
      urls.push(url);
    }
  }

  return Array.from(new Set(urls)).slice(-20).reverse();
}

function isSubtitleResourceUrl(url) {
  return /subtitle|caption|aisub|asr/i.test(url) && /\.json(?:\?|$)|aisubtitle|subtitle/i.test(url);
}

function readSubtitleAvailability(visibleSubtitle = "") {
  if (visibleSubtitle) {
    return {
      available: true,
      reason: "visible-subtitle"
    };
  }

  const bodyText = cleanDomText(document.body?.innerText || "");
  if (/该视频没有字幕|没有字幕，无法|无法开启.*字幕|字幕不可用/.test(bodyText)) {
    return {
      available: false,
      reason: "page-says-no-subtitle"
    };
  }

  const controls = findSubtitleControls();
  if (!controls.length) {
    return {
      available: false,
      reason: "no-subtitle-control"
    };
  }

  const enabled = controls.some((element) => !isDisabledSubtitleControl(element));
  return {
    available: enabled,
    reason: enabled ? "subtitle-control" : "disabled-subtitle-control"
  };
}

function findSubtitleControls() {
  const selectors = [
    "[aria-label*='字幕']",
    "[title*='字幕']",
    "[data-title*='字幕']",
    "[class*='subtitle']",
    "[class*='Subtitle']",
    "[class*='caption']",
    ".bpx-player-ctrl-subtitle",
    ".bilibili-player-video-btn-subtitle"
  ];
  const controls = [];
  const seen = new Set();

  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (seen.has(element)) continue;
      seen.add(element);

      const label = getControlLabel(element);
      if (!/字幕|subtitle|caption|cc/i.test(label)) continue;
      if (isInsideTranscriptPanel(element)) continue;
      if (!looksLikeSubtitleControl(element, label)) continue;

      controls.push(element);
    }
  }

  return controls;
}

function getControlLabel(element) {
  return [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("data-title"),
    element.getAttribute("class"),
    element.textContent
  ].filter(Boolean).join(" ");
}

function looksLikeSubtitleControl(element, label) {
  const tagName = element.tagName?.toLowerCase() || "";
  const role = element.getAttribute("role") || "";
  const controlLike = /button|btn|ctrl|control|switch|toggle|icon|checkbox/i.test(`${tagName} ${role} ${label}`);
  const panelLike = /panel|text|item|container|wrap|list|menu/i.test(label);

  if (tagName === "button" || role === "button") return true;
  if (controlLike) return true;
  if (panelLike) return false;

  return false;
}

function isDisabledSubtitleControl(element) {
  const label = getControlLabel(element);
  const disabledAttr = element.disabled ||
    element.getAttribute("aria-disabled") === "true" ||
    element.getAttribute("disabled") !== null;
  const disabledClass = /\b(disabled|disable|unavailable|forbidden)\b/i.test(element.className || "");
  const noSubtitleLabel = /没有字幕|無字幕|无法开启.*字幕|字幕不可用/.test(label);

  return Boolean(disabledAttr || disabledClass || noSubtitleLabel);
}

function isInsideTranscriptPanel(element) {
  return Boolean(element.closest?.("#bili-ai-transcript-host"));
}

function readVisibleSubtitleText() {
  const selectors = [
    ".bpx-player-subtitle-panel-text",
    ".bpx-player-subtitle-panel",
    ".bilibili-player-video-subtitle",
    ".squirtle-subtitle-item",
    "[class*='subtitle'][class*='text']",
    "[class*='subtitle'][class*='panel']",
    "[class*='caption']"
  ];

  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const text = cleanDomText(element.textContent || "");
      if (text && text.length <= 120) return text;
    }
  }

  return "";
}

function cleanDomText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/字幕已切换至.+$/, "")
    .trim();
}

function readUrlVideoInfo() {
  try {
    const url = new URL(location.href);
    const bvidMatch = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    const aidMatch = url.pathname.match(/\/video\/av(\d+)/i);
    const page = Number(url.searchParams.get("p") || 1);
    const cid = Number(url.searchParams.get("cid") || 0);

    return {
      bvid: bvidMatch?.[1] || "",
      aid: aidMatch?.[1] || "",
      cid: Number.isFinite(cid) && cid > 0 ? cid : "",
      page: Number.isFinite(page) && page > 0 ? page : 1
    };
  } catch (error) {
    return {
      bvid: "",
      aid: "",
      cid: "",
      page: 1
    };
  }
}

function getCleanDocumentTitle() {
  return document.title
    .replace(/_哔哩哔哩_bilibili$/, "")
    .replace(/-哔哩哔哩$/, "")
    .trim();
}

function readPageNumber() {
  const url = new URL(location.href);
  const page = Number(url.searchParams.get("p") || 1);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function readInitialState() {
  for (const script of document.scripts) {
    const text = script.textContent || "";
    const markerIndex = text.indexOf("window.__INITIAL_STATE__");
    if (markerIndex < 0) continue;

    const json = extractJsonObject(text, markerIndex);
    if (!json) continue;

    try {
      return JSON.parse(json);
    } catch (error) {
      return null;
    }
  }

  return null;
}

function extractJsonObject(text, markerIndex) {
  const start = text.indexOf("{", markerIndex);
  if (start < 0) return "";

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;

    if (depth === 0) {
      return text.slice(start, index + 1);
    }
  }

  return "";
}

function installTranscriptPanel() {
  const existing = document.getElementById("bili-ai-transcript-host");
  if (existing) {
    if (existing.dataset.version === SCRIPT_VERSION) return;
    existing.remove();
  }

  const host = document.createElement("div");
  host.id = "bili-ai-transcript-host";
  host.dataset.version = SCRIPT_VERSION;
  document.documentElement.append(host);

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        color-scheme: light;
        --accent: #00a1d6;
        --accent-dark: #007fab;
        --bg: #ffffff;
        --text: #171923;
        --muted: #6f7785;
        --line: #dfe4ec;
        --danger: #b42318;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      .trigger {
        position: fixed;
        right: 22px;
        bottom: 84px;
        z-index: 2147483647;
        height: 42px;
        padding: 0 14px;
        border: 0;
        border-radius: 8px;
        background: var(--accent);
        color: #fff;
        font-size: 14px;
        font-weight: 700;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
        cursor: pointer;
      }

      .panel {
        position: fixed;
        right: 22px;
        bottom: 136px;
        z-index: 2147483647;
        display: none;
        width: min(460px, calc(100vw - 44px));
        max-height: min(680px, calc(100vh - 172px));
        padding: 14px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--bg);
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.22);
      }

      .panel.open {
        display: grid;
        gap: 10px;
      }

      .top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      .title {
        min-width: 0;
        color: var(--text);
        font-size: 15px;
        font-weight: 700;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .top-actions {
        display: flex;
        gap: 6px;
        flex: 0 0 auto;
      }

      .mini,
      .close {
        width: 30px;
        height: 30px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fff;
        color: var(--text);
        font: inherit;
        cursor: pointer;
      }

      .mini {
        width: auto;
        min-width: 46px;
        padding: 0 8px;
        font-size: 12px;
      }

      .row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: center;
      }

      select {
        width: 100%;
        height: 34px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fff;
        color: var(--text);
        padding: 0 10px;
        font: inherit;
      }

      label {
        display: flex;
        align-items: center;
        gap: 6px;
        height: 34px;
        padding: 0 10px;
        border: 1px solid var(--line);
        border-radius: 8px;
        color: var(--text);
        font-size: 13px;
        user-select: none;
      }

      textarea {
        width: 100%;
        height: min(380px, calc(100vh - 360px));
        min-height: 180px;
        resize: vertical;
        border: 1px solid var(--line);
        border-radius: 8px;
        color: var(--text);
        padding: 10px;
        font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .actions {
        display: grid;
        grid-template-columns: 1fr 76px 76px 76px;
        gap: 8px;
      }

      button.action {
        height: 34px;
        border: 0;
        border-radius: 8px;
        background: var(--accent);
        color: #fff;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }

      button.action:hover:not(:disabled),
      .trigger:hover {
        background: var(--accent-dark);
      }

      button:disabled,
      select:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      .status {
        min-height: 18px;
        color: var(--muted);
        font-size: 12px;
      }

      .status.error {
        color: var(--danger);
      }
    </style>
    <button class="trigger" type="button">字幕稿</button>
    <section class="panel" aria-label="B站字幕稿面板">
      <div class="top">
        <div class="title">B站字幕稿</div>
        <div class="top-actions">
          <button class="mini reload" type="button">重读</button>
          <button class="close" type="button" title="关闭" aria-label="关闭">×</button>
        </div>
      </div>
      <div class="row">
        <select class="subtitle" disabled>
          <option>等待读取</option>
        </select>
        <label>
          <input class="timestamp" type="checkbox">
          <span>时间戳</span>
        </label>
      </div>
      <textarea class="text" spellcheck="false" placeholder="字幕内容会显示在这里"></textarea>
      <div class="actions">
        <button class="action copy" type="button" disabled>复制</button>
        <button class="action command" type="button" disabled>命令</button>
        <button class="action txt" type="button" disabled>TXT</button>
        <button class="action srt" type="button" disabled>SRT</button>
      </div>
      <div class="status">准备就绪</div>
    </section>
  `;

  const ui = {
    trigger: shadow.querySelector(".trigger"),
    panel: shadow.querySelector(".panel"),
    reload: shadow.querySelector(".reload"),
    close: shadow.querySelector(".close"),
    title: shadow.querySelector(".title"),
    subtitle: shadow.querySelector(".subtitle"),
    timestamp: shadow.querySelector(".timestamp"),
    text: shadow.querySelector(".text"),
    copy: shadow.querySelector(".copy"),
    command: shadow.querySelector(".command"),
    txt: shadow.querySelector(".txt"),
    srt: shadow.querySelector(".srt"),
    status: shadow.querySelector(".status")
  };

  let currentResult = null;
  let isLoading = false;
  let loadedPageKey = "";
  let seenPageKey = getPageKey();
  let pendingReloadTimer = 0;

  ui.trigger.addEventListener("click", () => {
    ui.panel.classList.toggle("open");
    if (ui.panel.classList.contains("open") && (!currentResult || loadedPageKey !== getPageKey())) {
      loadTranscript();
    }
  });

  ui.close.addEventListener("click", () => ui.panel.classList.remove("open"));
  ui.reload.addEventListener("click", () => loadTranscript(Number(ui.subtitle.value), { retry: 3, delay: 900 }));
  ui.subtitle.addEventListener("change", () => loadTranscript(Number(ui.subtitle.value), { retry: 1, delay: 900 }));
  ui.timestamp.addEventListener("change", renderTranscript);
  ui.copy.addEventListener("click", async () => {
    if (!ui.text.value.trim()) {
      setStatus("当前没有可复制的文字，请点“重读”。", true);
      return;
    }

    try {
      await navigator.clipboard.writeText(ui.text.value);
      setStatus("已复制到剪贴板。");
    } catch (error) {
      setStatus("复制失败，请手动选中文字复制。", true);
    }
  });
  ui.command.addEventListener("click", async () => {
    const subtitle = getSelectedSubtitle();
    if (!subtitle?.url) {
      setStatus("当前字幕没有可复制的源 URL。", true);
      return;
    }

    const command = [
      "node scripts/download-subtitle.mjs",
      shellQuote(location.href),
      "--subtitle-url",
      shellQuote(subtitle.url)
    ].join(" ");

    try {
      await navigator.clipboard.writeText(command);
      setStatus("已复制本地下载命令。");
    } catch (error) {
      setStatus("复制命令失败，请手动复制字幕源。", true);
    }
  });
  ui.txt.addEventListener("click", () => downloadText("txt"));
  ui.srt.addEventListener("click", () => downloadText("srt"));
  window.setInterval(watchPageChange, 500);
  window.addEventListener("popstate", () => window.setTimeout(watchPageChange, 0));
  window.addEventListener("hashchange", () => window.setTimeout(watchPageChange, 0));

  async function loadTranscript(subtitleIndex = null, options = {}) {
    if (isLoading) return;
    isLoading = true;
    const requestPageKey = getPageKey();
    const retry = Number(options.retry || 0);
    const retryDelay = Number(options.delay || 900);
    setActionsEnabled(false);
    setStatus("正在读取字幕...");

    try {
      const response = await sendRuntimeMessage({
        type: "BILI_SUBTITLE_FETCH",
        payload: {
          url: location.href,
          pageInfo: readPageInfo(),
          subtitleIndex
        }
      });

      if (!response?.ok) {
        throw new Error(response?.error || "读取失败");
      }

      if (requestPageKey !== getPageKey()) {
        scheduleReload();
        return;
      }

      if (!doesResultMatchCurrentPage(response.data) && retry > 0) {
        setStatus("页面还在切换，等一下重读...");
        window.setTimeout(() => {
          loadTranscript(subtitleIndex, { retry: retry - 1, delay: retryDelay + 700 });
        }, retryDelay);
        return;
      }

      currentResult = response.data;
      loadedPageKey = requestPageKey;
      renderResult();
      setResultStatus(currentResult);
    } catch (error) {
      const message = error.message || String(error);
      if (retry > 0 && requestPageKey === getPageKey() && isRetriableReadError(message)) {
        currentResult = null;
        ui.text.value = "";
        setActionsEnabled(false);
        setStatus(`${message}，正在重试...`);
        window.setTimeout(() => {
          loadTranscript(subtitleIndex, { retry: retry - 1, delay: retryDelay + 700 });
        }, retryDelay);
        return;
      }

      currentResult = null;
      ui.text.value = "";
      setActionsEnabled(false);
      setStatus(message, true);
    } finally {
      isLoading = false;
    }
  }

  function renderResult() {
    const title = [currentResult.video.title, currentResult.video.partTitle].filter(Boolean).join(" / ");
    ui.title.textContent = title || "B站字幕稿";
    ui.subtitle.textContent = "";

    for (const subtitle of currentResult.subtitles) {
      const option = document.createElement("option");
      option.value = String(subtitle.index);
      option.textContent = `${subtitle.languageName} · ${subtitle.sourceType || (subtitle.isAi ? "AI" : "字幕")}`;
      ui.subtitle.append(option);
    }

    ui.subtitle.value = String(currentResult.selectedIndex);
    ui.subtitle.disabled = currentResult.subtitles.length <= 1;
    renderTranscript();
    setActionsEnabled(true);
  }

  function watchPageChange() {
    const nextPageKey = getPageKey();
    if (nextPageKey === seenPageKey) return;

    seenPageKey = nextPageKey;
    resetForNewPage();

    if (ui.panel.classList.contains("open")) {
      scheduleReload();
    }
  }

  function scheduleReload() {
    window.clearTimeout(pendingReloadTimer);
    pendingReloadTimer = window.setTimeout(async () => {
      setStatus("检测到页面切换，等待页面稳定...");
      await waitForStablePageKey(getPageKey());
      loadTranscript(null, { retry: 5, delay: 1000 });
    }, 300);
  }

  function resetForNewPage() {
    currentResult = null;
    loadedPageKey = "";
    subtitleResourceSince = performance.now() - 500;
    ui.title.textContent = "B站字幕稿";
    ui.text.value = "";
    ui.subtitle.textContent = "";

    const option = document.createElement("option");
    option.textContent = "等待新视频";
    ui.subtitle.append(option);
    ui.subtitle.disabled = true;
    setActionsEnabled(false);
    setStatus(ui.panel.classList.contains("open") ? "检测到页面切换，稍后自动重读..." : "已切换视频，打开面板后会读取。");
  }

  function renderTranscript() {
    if (!currentResult) return;
    ui.text.value = ui.timestamp.checked ? currentResult.timestampText : currentResult.plainText;
  }

  function downloadText(type) {
    if (!currentResult) return;

    const isSrt = type === "srt";
    const content = isSrt ? currentResult.srtText : ui.text.value;
    if (!content.trim()) {
      setStatus("当前没有可下载的文字，请点“重读”。", true);
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

  function setActionsEnabled(enabled) {
    ui.copy.disabled = !enabled;
    ui.command.disabled = !enabled;
    ui.txt.disabled = !enabled;
    ui.srt.disabled = !enabled;
  }

  function setStatus(message, isError = false) {
    ui.status.textContent = message;
    ui.status.classList.toggle("error", Boolean(isError));
  }

  function setResultStatus(result) {
    const debug = formatVideoDebug(result.video);
    if (result.quality?.warning) {
      setStatus(`${result.quality.warning}${debug}`, true);
      return;
    }

    setStatus(`已整理 ${result.segments.length} 段文字稿。${debug}`);
  }

  function getSelectedSubtitle() {
    if (!currentResult?.subtitles?.length) return null;
    const selected = Number(ui.subtitle.value);
    return currentResult.subtitles.find((subtitle) => subtitle.index === selected) ||
      currentResult.subtitles[currentResult.selectedIndex] ||
      currentResult.subtitles[0];
  }
}

function shellQuote(text) {
  return `'${String(text || "").replace(/'/g, "'\\''")}'`;
}

function doesResultMatchCurrentPage(result) {
  const video = result?.video || {};
  const urlInfo = readUrlVideoInfo();
  const title = normalizeTitleForCompare(getCleanDocumentTitle());
  const resultTitle = normalizeTitleForCompare(video.title || "");

  if (urlInfo.bvid && video.bvid && urlInfo.bvid !== video.bvid) return false;
  if (urlInfo.aid && video.aid && String(urlInfo.aid) !== String(video.aid)) return false;
  if (urlInfo.page && video.page && Number(urlInfo.page) !== Number(video.page)) return false;
  if (title && resultTitle && !titleIncludesEither(title, resultTitle)) return false;

  return true;
}

function normalizeTitleForCompare(title) {
  return String(title || "")
    .replace(/[\s｜|_《》【】「」『』"'“”‘’\-—–·:：,，.。!！?？()[\]（）]/g, "")
    .slice(0, 80);
}

function titleIncludesEither(left, right) {
  if (!left || !right) return true;
  const shortLeft = left.slice(0, Math.min(left.length, 24));
  const shortRight = right.slice(0, Math.min(right.length, 24));
  return left.includes(shortRight) || right.includes(shortLeft);
}

function formatVideoDebug(video) {
  if (!video) return "";
  const parts = [];
  if (video.bvid) parts.push(video.bvid);
  if (video.cid) parts.push(`cid:${video.cid}`);
  if (!parts.length) return "";
  return ` 当前：${parts.join(" / ")}`;
}

function isRetriableReadError(message) {
  return /cid|字幕列表|读取字幕|没有可读取|超时|Receiving end does not exist/i.test(message);
}

function waitForStablePageKey(targetKey, stableMs = 900, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    let stableSince = Date.now();
    let previousKey = getPageKey();

    const timer = window.setInterval(() => {
      const currentKey = getPageKey();
      if (currentKey !== previousKey) {
        previousKey = currentKey;
        stableSince = Date.now();
      }

      if (currentKey !== targetKey) {
        window.clearInterval(timer);
        resolve(false);
        return;
      }

      if (Date.now() - stableSince >= stableMs || Date.now() - start >= timeoutMs) {
        window.clearInterval(timer);
        resolve(true);
      }
    }, 150);
  });
}

function getPageKey() {
  try {
    const url = new URL(location.href);
    const videoMatch = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
    const bangumiMatch = url.pathname.match(/\/bangumi\/play\/(ep\d+|ss\d+)/i);
    const page = url.searchParams.get("p") || "1";
    const cid = url.searchParams.get("cid") || "";

    if (videoMatch) return `video:${videoMatch[1]}:p=${page}:cid=${cid}`;
    if (bangumiMatch) return `bangumi:${bangumiMatch[1]}:p=${page}:cid=${cid}`;
    return `${url.pathname}?p=${page}&cid=${cid}`;
  } catch (error) {
    return location.href;
  }
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(reject, new Error("读取字幕超时，请刷新页面后重试。")), 20000);

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    }

    try {
      chrome.runtime.sendMessage(message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          finish(reject, new Error(lastError.message));
          return;
        }

        finish(resolve, response);
      });
    } catch (error) {
      finish(reject, error);
    }
  });
}
