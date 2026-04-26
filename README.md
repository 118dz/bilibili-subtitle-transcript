# B站字幕稿 Chrome 扩展

这是一个 Manifest V3 的 Chrome 扩展，用来在 B 站视频播放页读取已有的 AI 字幕或人工字幕，并整理成可复制、可下载的文字稿。

## 使用方法

1. 打开 Chrome，进入 `chrome://extensions/`。
2. 打开右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本目录：`bilibili-ai-subtitle-extension`。
5. 打开一个 B 站视频页，点击浏览器右上角扩展图标。
6. 也可以直接点击视频页右下角的「字幕稿」按钮读取字幕。

## 功能

- 自动识别当前视频和分 P。
- 优先选择中文 AI 字幕；如果没有 AI 字幕，但视频有人工字幕，也可以读取和下载。
- 优先尝试读取播放器实际加载的字幕资源，避免 B 站接口字幕和画面字幕不一致。
- 支持复制纯文字稿。
- 支持导出 TXT 和 SRT。
- 支持切换带时间戳的显示格式。

## 说明

- 扩展读取的是视频本身已经存在的字幕文件，不会自动做语音识别。
- 如果字幕是直接压在画面里的“硬字幕”，扩展无法直接下载，只能通过 OCR 或语音识别另做提取。
- 某些字幕可能需要你已经在 B 站网页端登录。
- B 站字幕接口属于网页内部接口，若 B 站改版，可能需要更新扩展里的接口适配逻辑。

## 发布

发布用 zip 包生成后会放在 `dist/` 目录。Chrome Web Store 上传时选择 zip 文件即可。

## 命令行下载字幕

也可以不打开浏览器，直接用 B 站 URL 下载字幕：

```bash
node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx"
```

默认会写入 `downloads/` 目录，并同时生成：

- `.txt`：整理后的文字稿
- `.srt`：带时间轴的字幕文件
- `.json`：原始分段和元数据

常用选项：

```bash
node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx" --format txt --out ./downloads
node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx" --list
node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx?p=2" --page 2
```

有些 AI 字幕需要登录态。如果 URL 直接下载提示没有字幕，可以从浏览器复制 B 站 Cookie 到文本文件，然后：

```bash
node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx" --cookie-file ./bili.cookie.txt
```

或使用环境变量：

```bash
BILI_COOKIE="SESSDATA=..." node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx"
```

注意：命令行模式只能下载 B 站接口返回的字幕文件，不能读取播放器画面里的硬字幕；这类视频需要 OCR 或语音识别。
