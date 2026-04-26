# 视频字幕稿 Chrome 扩展

这是一个 Manifest V3 的 Chrome 扩展，用来在 B 站和 YouTube 视频播放页读取已有字幕，并整理成可复制、可下载的文字稿。

## 使用方法

1. 打开 Chrome，进入 `chrome://extensions/`。
2. 打开右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本目录：`bilibili-ai-subtitle-extension`。
5. 打开一个 B 站或 YouTube 视频页，点击浏览器右上角扩展图标。
6. 也可以直接点击视频页右下角的「字幕稿」按钮读取字幕。

## 功能

- 自动识别当前 B 站或 YouTube 视频。
- 优先选择中文 AI 字幕；如果没有 AI 字幕，但视频有人工字幕，也可以读取和下载。
- B 站优先读取播放器实际加载的字幕资源，避免接口字幕和画面字幕不一致。
- YouTube 支持读取公开视频已有字幕轨，包括自动字幕和人工字幕。
- 支持复制纯文字稿。
- 支持导出 TXT 和 SRT。
- 支持切换带时间戳的显示格式。

## 说明

- 扩展读取的是视频本身已经存在的字幕文件，不会自动做语音识别。
- 如果字幕是直接压在画面里的“硬字幕”，扩展无法直接下载，只能通过 OCR 或语音识别另做提取。
- 某些字幕可能需要你已经在对应网站网页端登录。
- B 站和 YouTube 字幕接口属于网页内部数据，若网站改版，可能需要更新扩展里的适配逻辑。
- 如果插件提示没有检测到字幕，但播放器确实有字幕，请先在播放器里开启字幕，再点插件面板的「重读」。

## 发布

发布用 zip 包生成后会放在 `dist/` 目录。Chrome Web Store 上传时选择 zip 文件即可。

## 命令行下载字幕

CLI 默认会打开本机 Chrome，像页面插件一样读取字幕资源：

```bash
node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx"
node scripts/download-subtitle.mjs "https://www.youtube.com/watch?v=xxxxxxxxxxx"
```

如果你想看到浏览器窗口，方便确认播放器字幕是否打开：

```bash
node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx" --headed
```

如果你确认 B 站接口字幕就是你要的内容，也可以显式允许接口模式：

```bash
node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx" --allow-api
```

默认会写入 `downloads/` 目录，并同时生成：

- `.txt`：整理后的文字稿
- `.srt`：带时间轴的字幕文件
- `.json`：原始分段和元数据

常用选项：

```bash
node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx" --format txt --out ./downloads
node scripts/download-subtitle.mjs "https://www.youtube.com/watch?v=xxxxxxxxxxx" --format txt --out ./downloads
node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx" --list
node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx?p=2" --page 2
```

有些字幕需要登录态。如果 URL 直接下载提示没有字幕，可以从浏览器复制对应网站 Cookie 到文本文件，然后：

```bash
node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx" --cookie-file ./bili.cookie.txt
```

或使用环境变量：

```bash
BILI_COOKIE="SESSDATA=..." node scripts/download-subtitle.mjs "https://www.bilibili.com/video/BVxxxx"
```

注意：默认浏览器模式仍然不能读取画面硬字幕；这类视频需要 OCR 或语音识别。`--allow-api` 会跳过浏览器抓取，直接使用平台页面/接口字幕；B 站可能和播放器实际字幕不一致。

如果命令行直接用 B 站 URL 下载到的字幕和页面插件不一致，说明当前视频的播放器字幕资源和 B 站接口字幕不一致。此时可以：

1. 在 B 站页面用插件读取到正确字幕。
2. 点击插件面板里的「命令」按钮。
3. 回到本地项目目录粘贴执行复制出来的命令。

复制出来的命令会带 `--subtitle-url`，直接下载插件实际使用的字幕源，不需要 `--allow-api`，也不需要浏览器抓取。
