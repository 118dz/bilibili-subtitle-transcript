# 发布流程

## 本地打包

运行：

```bash
./scripts/package.sh
```

打包结果会生成在 `dist/` 目录。

## Chrome Web Store 上传

1. 打开 Chrome Web Store Developer Dashboard。
2. 新建或选择扩展项目。
3. 上传 `dist/` 目录里最新版本的 zip，例如 `dist/bilibili-subtitle-transcript-1.3.0.zip`。
4. 使用 `STORE_LISTING.md` 中的文案填写商店信息。
5. 使用 `PRIVACY.md` 作为隐私说明参考。
6. 提交审核。

## Git 发布

如果本地还没有远程仓库：

```bash
git remote add origin <你的仓库地址>
git push -u origin main
```

如果已经配置远程仓库：

```bash
git push
```
