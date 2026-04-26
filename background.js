const BILI_API = "https://api.bilibili.com";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "BILI_SUBTITLE_FETCH") {
    return false;
  }

  fetchTranscript(message.payload)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

async function fetchTranscript(payload = {}) {
  const identity = parseVideoIdentity(payload.url, payload.pageInfo);
  if (!identity.bvid && !identity.aid && !identity.cid) {
    throw new Error("没有识别到当前视频的 bvid/cid，请确认打开的是 B 站视频播放页。");
  }

  const view = await fetchView(identity).catch(() => null);
  const pageInfo = getTrustedPageInfo(identity, view, payload.pageInfo);
  const page = selectPage(identity, view, pageInfo);
  const bvid = view?.bvid || identity.bvid || pageInfo.bvid || null;
  const aid = view?.aid || identity.aid || pageInfo.aid || null;
  const cid = page?.cid || identity.cid || pageInfo.cid || null;

  if (!cid) {
    throw new Error("没有找到当前分 P 的 cid，暂时无法读取字幕。");
  }

  if (payload.pageInfo?.subtitleAvailable === false) {
    throw new Error("当前播放器没有检测到可读取字幕。请先在播放器里开启字幕后重读；如果播放器提示没有字幕，则此视频没有字幕文件。");
  }

  const playerResourceSubtitles = await fetchPlayerResourceSubtitles(payload.pageInfo);
  const visibleMatchedSubtitles = playerResourceSubtitles.length
    ? []
    : await fetchVisibleMatchedApiSubtitles({
        bvid,
        aid,
        cid,
        visibleSubtitle: payload.pageInfo?.visibleSubtitle || ""
      });
  const subtitles = [...playerResourceSubtitles, ...visibleMatchedSubtitles].map((item, index) => ({
    ...item,
    index
  }));

  if (!subtitles.length) {
    throw new Error("当前播放器没有加载字幕资源。请先在 B 站播放器里开启字幕后重读；若播放器提示没有字幕，则此视频没有字幕文件。");
  }

  const selectedIndex = chooseSubtitleIndex(subtitles, payload.subtitleIndex);
  const selectedSubtitle = subtitles[selectedIndex];
  const rawSegments = selectedSubtitle.rawSegments || await fetchSubtitleSegments(selectedSubtitle.url);
  const segments = buildTranscriptSegments(rawSegments);
  const quality = analyzeTranscriptQuality(rawSegments, segments);

  if (!rawSegments.length) {
    throw new Error("字幕文件里没有读取到正文内容。");
  }

  const title = view?.title || pageInfo.title || "bilibili-transcript";
  const partTitle = page?.part || pageInfo.part || "";

  return {
    video: {
      title,
      partTitle,
      bvid,
      aid,
      cid,
      page: page?.page || identity.page || 1
    },
    subtitles: subtitles.map(({ rawSegments: _rawSegments, quality: _quality, ...subtitle }) => subtitle),
    selectedIndex,
    segments,
    rawSegments,
    quality,
    plainText: formatPlainText(segments),
    timestampText: formatTimestampText(segments),
    srtText: formatSrtText(rawSegments),
    fileBaseName: safeFileName([title, partTitle].filter(Boolean).join(" - "))
  };
}

async function fetchPlayerResourceSubtitles(pageInfo = {}) {
  const visibleSubtitle = cleanText(pageInfo.visibleSubtitle || "");
  const urls = normalizeCandidateUrls(pageInfo.subtitleResources || []);
  const candidates = [];

  for (const url of urls.slice(0, 10)) {
    try {
      const rawSegments = await fetchSubtitleSegments(url);
      if (!rawSegments.length) continue;

      const segments = buildTranscriptSegments(rawSegments);
      const quality = analyzeTranscriptQuality(rawSegments, segments);
      const text = normalizeForMatch(segments.map((segment) => segment.text).join(""));
      const visible = normalizeForMatch(visibleSubtitle);
      const matchVisible = Boolean(visible && text.includes(visible.slice(0, Math.min(visible.length, 24))));

      if (visible && !matchVisible) continue;
      if (!quality.usable && !matchVisible) continue;

      candidates.push({
        language: "",
        languageName: matchVisible ? "播放器当前字幕" : "播放器字幕",
        isAi: /ai|asr|subtitle/i.test(url),
        sourceType: "播放器",
        url,
        rawSegments,
        quality,
        matchVisible,
        score: (matchVisible ? 1000 : 0) + quality.meaningfulChars
      });
    } catch (error) {
      // Some performance resource entries are stale or not subtitle JSON.
    }
  }

  return candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
}

async function fetchVisibleMatchedApiSubtitles({ bvid, aid, cid, visibleSubtitle }) {
  const visible = normalizeForMatch(visibleSubtitle);
  if (!visible || visible.length < 4) return [];

  const playerInfo = await fetchPlayerInfo({ bvid, aid, cid }).catch(() => null);
  const apiSubtitles = normalizeSubtitles(playerInfo?.subtitle?.subtitles || []);
  const candidates = [];

  for (const subtitle of apiSubtitles) {
    try {
      const rawSegments = await fetchSubtitleSegments(subtitle.url);
      if (!rawSegments.length) continue;

      const segments = buildTranscriptSegments(rawSegments);
      const quality = analyzeTranscriptQuality(rawSegments, segments);
      const text = normalizeForMatch(segments.map((segment) => segment.text).join(""));
      const matchVisible = text.includes(visible.slice(0, Math.min(visible.length, 24)));

      if (!matchVisible) continue;
      if (!quality.usable) continue;

      candidates.push({
        ...subtitle,
        languageName: `${subtitle.languageName}（当前画面校验）`,
        sourceType: "播放器",
        rawSegments,
        quality,
        matchVisible,
        score: 1000 + quality.meaningfulChars
      });
    } catch (error) {
      // Ignore subtitles that cannot be fetched or do not match the visible player text.
    }
  }

  return candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
}

async function fetchSubtitleSegments(url) {
  const subtitleJson = await requestJson(url, { skipBiliCodeCheck: true });
  return normalizeSegments(subtitleJson.body || subtitleJson.data?.body || []);
}

function normalizeCandidateUrls(urls) {
  const seen = new Set();
  const result = [];

  for (const url of urls) {
    const normalized = normalizeSubtitleUrl(url);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function parseVideoIdentity(urlText = "", pageInfo = {}) {
  const identity = {
    bvid: null,
    aid: null,
    cid: null,
    page: null,
    source: "url"
  };

  try {
    const url = new URL(urlText);
    const bvidMatch = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
    const aidMatch = url.pathname.match(/\/video\/av(\d+)/i);
    const epMatch = url.pathname.match(/\/bangumi\/play\/ep(\d+)/i);

    if (bvidMatch) identity.bvid = bvidMatch[1];
    if (aidMatch) identity.aid = aidMatch[1];
    if (epMatch) identity.epId = epMatch[1];

    const p = Number(url.searchParams.get("p"));
    if (Number.isFinite(p) && p > 0) identity.page = p;

    const cid = Number(url.searchParams.get("cid"));
    if (Number.isFinite(cid) && cid > 0) identity.cid = cid;
  } catch (error) {
    // Popup can be opened on Chrome pages where URL parsing is irrelevant.
  }

  if (!identity.bvid && !identity.aid && pageInfo.bvid) {
    identity.bvid = pageInfo.bvid;
    identity.source = "page";
  }

  if (!identity.aid && !identity.bvid && pageInfo.aid) {
    identity.aid = pageInfo.aid;
    identity.source = "page";
  }

  if (!identity.page && pageInfo.page) {
    identity.page = Number(pageInfo.page) || null;
  }

  if (!identity.cid && identity.source === "page" && pageInfo.cid) {
    identity.cid = Number(pageInfo.cid) || null;
  }

  return identity;
}

function getTrustedPageInfo(identity, view, pageInfo = {}) {
  const normalized = pageInfo || {};
  const viewBvid = view?.bvid || identity.bvid || "";
  const viewAid = Number(view?.aid || identity.aid || 0);
  const pageBvid = normalized.bvid || "";
  const pageAid = Number(normalized.aid || 0);

  if (!viewBvid && !viewAid) return normalized;
  if (pageBvid && viewBvid && pageBvid === viewBvid) return normalized;
  if (pageAid && viewAid && pageAid === viewAid) return normalized;

  return {
    title: normalized.title || "",
    page: identity.page || normalized.page || 1
  };
}

async function fetchView(identity) {
  if (!identity.bvid && !identity.aid) {
    return null;
  }

  const params = new URLSearchParams();
  if (identity.bvid) params.set("bvid", identity.bvid);
  if (!identity.bvid && identity.aid) params.set("aid", identity.aid);

  params.set("_", String(Date.now()));

  const json = await requestJson(`${BILI_API}/x/web-interface/view?${params}`);
  return json.data || null;
}

function selectPage(identity, view, pageInfo = {}) {
  const pages = view?.pages || pageInfo.pages || [];
  const cid = Number(identity.cid || pageInfo.cid);
  const wantedPage = Number(identity.page || pageInfo.page || 1);

  if (cid && pages.length) {
    const current = pages.find((item) => Number(item.cid) === cid);
    if (current) return current;
  }

  if (pages.length) {
    return pages[Math.max(0, Math.min(pages.length - 1, wantedPage - 1))];
  }

  if (cid) {
    return {
      cid,
      page: wantedPage,
      part: pageInfo.part || ""
    };
  }

  return null;
}

async function fetchPlayerInfo({ bvid, aid, cid }) {
  if (!bvid && !aid) {
    throw new Error("没有识别到当前视频的 bvid/aid，无法请求字幕列表。");
  }

  const params = new URLSearchParams({ cid: String(cid) });
  if (bvid) params.set("bvid", bvid);
  if (!bvid && aid) params.set("aid", String(aid));
  params.set("_", String(Date.now()));

  const urls = [
    `${BILI_API}/x/player/v2?${params}`,
    `${BILI_API}/x/player/wbi/v2?${params}`
  ];

  const errors = [];
  for (const url of urls) {
    try {
      const json = await requestJson(url);
      if (json.data) return json.data;
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(`读取字幕列表失败：${errors.join("；")}`);
}

function normalizeSubtitles(items) {
  return items
    .map((item, index) => {
      const url = normalizeSubtitleUrl(item.subtitle_url || item.url || "");
      const label = item.lan_doc || item.lan || `字幕 ${index + 1}`;
      const marker = `${item.lan || ""} ${item.lan_doc || ""} ${item.ai_type || ""}`;

      return {
        index,
        id: item.id || null,
        language: item.lan || "",
        languageName: label,
        isAi: /ai|自动|智能|ASR/i.test(marker),
        sourceType: /ai|自动|智能|ASR/i.test(marker) ? "AI" : "字幕",
        url
      };
    })
    .filter((item) => item.url);
}

function normalizeSubtitleUrl(rawUrl) {
  if (!rawUrl) return "";
  if (rawUrl.startsWith("//")) return `https:${rawUrl}`;
  if (rawUrl.startsWith("http://")) return rawUrl.replace(/^http:\/\//, "https://");
  if (rawUrl.startsWith("/")) return `https://www.bilibili.com${rawUrl}`;
  return rawUrl;
}

function chooseSubtitleIndex(subtitles, requestedIndex) {
  const requested = Number(requestedIndex);
  if (Number.isInteger(requested) && requested >= 0 && requested < subtitles.length) {
    return requested;
  }

  const currentPlayer = subtitles.findIndex((item) => item.sourceType === "播放器" && item.matchVisible);
  if (currentPlayer >= 0) return currentPlayer;

  const chinese = (item) => /zh|中文|简体|繁体|Chinese/i.test(`${item.language} ${item.languageName}`);
  const apiSubtitles = subtitles.filter((item) => item.sourceType !== "播放器");
  const apiOffset = subtitles.findIndex((item) => item.sourceType !== "播放器");
  const aiChinese = apiSubtitles.findIndex((item) => item.isAi && chinese(item));
  if (aiChinese >= 0 && apiOffset >= 0) return apiOffset + aiChinese;

  const anyChinese = apiSubtitles.findIndex(chinese);
  if (anyChinese >= 0 && apiOffset >= 0) return apiOffset + anyChinese;

  const anyAi = apiSubtitles.findIndex((item) => item.isAi);
  if (anyAi >= 0 && apiOffset >= 0) return apiOffset + anyAi;

  const usablePlayer = subtitles.findIndex((item) => item.sourceType === "播放器" && item.quality?.usable);
  if (usablePlayer >= 0) return usablePlayer;

  const anyPlayer = subtitles.findIndex((item) => item.sourceType === "播放器");
  if (anyPlayer >= 0) return anyPlayer;

  const fallbackAiChinese = subtitles.findIndex((item) => item.isAi && chinese(item));
  if (fallbackAiChinese >= 0) return fallbackAiChinese;

  const fallbackChinese = subtitles.findIndex(chinese);
  if (fallbackChinese >= 0) return fallbackChinese;

  const fallbackAi = subtitles.findIndex((item) => item.isAi);
  if (fallbackAi >= 0) return fallbackAi;

  return 0;
}

function normalizeForMatch(text) {
  return String(text || "")
    .replace(/[\s\d，。,.!?！？、~～…·\-—_（）()【】[\]{}<>《》"'“”‘’:：;；/\\|+*=#@￥$%^&`♪♫♬♩]/g, "")
    .trim();
}

function normalizeSegments(items) {
  const segments = items
    .map((item, index) => {
      const from = Number(item.from || item.start || 0);
      const to = Number(item.to || item.end || from);
      const text = cleanText(item.content || item.text || "");

      return {
        index: index + 1,
        from: Number.isFinite(from) ? from : 0,
        to: Number.isFinite(to) ? to : 0,
        text
      };
    })
    .filter((item) => item.text)
    .sort((left, right) => left.from - right.from || left.index - right.index);

  return removeDuplicateSegments(segments);
}

function analyzeTranscriptQuality(rawSegments, mergedSegments) {
  const texts = rawSegments.map((segment) => segment.text).filter(Boolean);
  const mergedText = mergedSegments.map((segment) => segment.text).join("");
  const musicLikeCount = texts.filter(isMusicLikeText).length;
  const meaningfulText = stripNonMeaningfulChars(mergedText);
  const musicLikeRatio = texts.length ? musicLikeCount / texts.length : 0;
  const uniqueChars = new Set(meaningfulText).size;

  const unusable = texts.length > 0 && (
    musicLikeRatio >= 0.6 ||
    meaningfulText.length < 20 ||
    (meaningfulText.length < 80 && uniqueChars <= 6)
  );

  return {
    usable: !unusable,
    musicLikeRatio,
    meaningfulChars: meaningfulText.length,
    warning: unusable
      ? "B站返回的字幕轨几乎没有有效文字，画面里的硬字幕需要 OCR 或语音识别提取。"
      : ""
  };
}

function isMusicLikeText(text) {
  const normalized = stripNonMeaningfulChars(text).toLowerCase();
  if (!normalized) return true;

  return /^(音乐|音樂|music|bgm|配乐|配樂|音效|掌声|掌聲|笑声|笑聲|无声|無聲|噪音|嗯|啊|呃|哦|哈)+$/i.test(normalized);
}

function stripNonMeaningfulChars(text) {
  return String(text || "")
    .replace(/[♪♫♬♩♭♮♯]/g, "")
    .replace(/[\s\d，。,.!?！？、~～…·\-—_（）()【】[\]{}<>《》"'“”‘’:：;；/\\|+*=#@￥$%^&`]/g, "")
    .trim();
}

function removeDuplicateSegments(segments) {
  const result = [];

  for (const segment of segments) {
    const previous = result[result.length - 1];
    if (!previous) {
      result.push(segment);
      continue;
    }

    const closeInTime = Math.abs(segment.from - previous.from) < 3;
    if (closeInTime && segment.text === previous.text) {
      continue;
    }

    if (closeInTime && previous.text.endsWith(segment.text)) {
      previous.to = Math.max(previous.to, segment.to);
      continue;
    }

    result.push(segment);
  }

  return result.map((segment, index) => ({
    ...segment,
    index: index + 1
  }));
}

function buildTranscriptSegments(segments) {
  const paragraphs = [];
  let current = null;

  for (const segment of segments) {
    if (!current) {
      current = { ...segment };
      continue;
    }

    const gap = segment.from - current.to;
    const shouldBreak = shouldStartNewParagraph(current.text, gap);

    if (shouldBreak) {
      paragraphs.push(current);
      current = { ...segment, index: paragraphs.length + 1 };
      continue;
    }

    current.text = appendWithOverlap(current.text, segment.text);
    current.to = Math.max(current.to, segment.to);
  }

  if (current) {
    paragraphs.push(current);
  }

  return paragraphs.map((segment, index) => ({
    ...segment,
    index: index + 1,
    text: normalizeParagraphText(segment.text)
  }));
}

function shouldStartNewParagraph(text, gap) {
  const length = text.length;
  const sentenceEnded = /[。！？!?；;]$/.test(text);

  if (gap > 2.5) return true;
  if (length >= 190) return true;
  if (sentenceEnded && length >= 90) return true;
  if (sentenceEnded && gap > 0.8) return true;

  return false;
}

function appendWithOverlap(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (left.includes(right)) return left;

  const maxOverlap = Math.min(24, left.length, right.length);
  for (let length = maxOverlap; length >= 2; length -= 1) {
    if (left.endsWith(right.slice(0, length))) {
      return left + right.slice(length);
    }
  }

  return needsSpaceBetween(left, right) ? `${left} ${right}` : left + right;
}

function needsSpaceBetween(left, right) {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}

function normalizeParagraphText(text) {
  return cleanText(text)
    .replace(/\s+([，。！？、；：,.!?;:])/g, "$1")
    .replace(/([（【《])\s+/g, "$1")
    .replace(/\s+([）】》])/g, "$1");
}

function cleanText(text) {
  return String(text)
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatPlainText(segments) {
  return segments.map((segment) => segment.text).join("\n\n");
}

function formatTimestampText(segments) {
  return segments.map((segment) => `[${formatClock(segment.from)}] ${segment.text}`).join("\n");
}

function formatSrtText(segments) {
  return segments
    .map((segment, index) => {
      return [
        String(index + 1),
        `${formatSrtClock(segment.from)} --> ${formatSrtClock(segment.to || segment.from + 2)}`,
        segment.text
      ].join("\n");
    })
    .join("\n\n");
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hour = Math.floor(total / 3600);
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  const parts = hour > 0 ? [hour, minute, second] : [minute, second];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

function formatSrtClock(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hour = Math.floor(value / 3600);
  const minute = Math.floor((value % 3600) / 60);
  const second = Math.floor(value % 60);
  const millisecond = Math.floor((value - Math.floor(value)) * 1000);

  return [
    String(hour).padStart(2, "0"),
    String(minute).padStart(2, "0"),
    String(second).padStart(2, "0")
  ].join(":") + `,${String(millisecond).padStart(3, "0")}`;
}

function safeFileName(name) {
  const cleaned = String(name || "bilibili-transcript")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.slice(0, 120) || "bilibili-transcript";
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    headers: {
      "Accept": "application/json, text/plain, */*"
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error("返回内容不是 JSON");
  }

  if (!options.skipBiliCodeCheck && typeof json.code === "number" && json.code !== 0) {
    throw new Error(json.message || `B站接口返回 code=${json.code}`);
  }

  return json;
}
