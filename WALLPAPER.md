# LittonHeatmap · Wallpaper Engine 版

这是从 `main` 独立出来的 `wallpaper-engine` 分支，不会影响网页版。

## 特性

- 启动时面板收起，地图保持静态
- 只有打开调整面板后，地图才允许拖动、滚轮缩放、双指缩放
- 右下角 `☰` 默认在桌面右下角，收起状态下可拖动
- 调整面板默认在画面左侧垂直居中
- 时间层：`13:36` / `OCTOBER 20, 2026` / `TUESDAY`
- 去除导入、同步、导出、onboarding 等网页版操作
- 轨迹数据静态打包，不依赖 Node 服务

## 构建

需要本机已有 `web/data/manifest.json` 和对应轨迹文件（网页版同步/导入后生成）。

首次构建先安装 devDependency（esbuild）：

```powershell
cd D:\program\deepseek\dsh\xingzhe-heatmap
npm install
node scripts/build-wallpaper.mjs

# 本地预览
npm run serve:wallpaper
# 打开 http://127.0.0.1:5180/
```

输出：

```text
dist/wallpaper/index.html
dist/wallpaper/assets/
dist/wallpaper/wallpaper-data.js
```

`dist/` 已被 gitignore，不会提交。

## 导入 Wallpaper Engine

1. 打开 Wallpaper Engine
2. 点击 **Create Wallpaper**
3. 把 `dist/wallpaper/index.html` 拖进去
4. Wallpaper Engine 会复制整个目录并生成自己的项目
5. 在壁纸设置中开启鼠标输入，才能点击右下角按钮

## 操作

- 点击右下角 `☰`：打开面板
- 拖动 `☰`：移动按钮位置，不会打开面板
- 面板打开时：可拖动 / 缩放地图；右下角 `+ / −` 也可以缩放
- 鼠标滚轮在面板打开时可直接缩放地图
- 如果 Wallpaper Engine 没有把滚轮转发给网页，直接用右下角 `+ / −`
- 点击面板右上角 `−`：收起面板，地图重新锁定
- 拖动面板顶部：移动面板，关闭后再次打开会保留位置
- 双击面板顶部：复位到左侧居中
- 拖动时间左上角把手：移动时间位置，关闭壁纸后位置保留
- 双击时间左上角把手：复位到右侧居中
- 导入 GPX / FIT：替换为自定义路线，保存在 IndexedDB；也可以把文件直接拖到壁纸上
- 恢复默认路线：清除自定义路线，回到构建时的静态数据
- 清除路线：清空当前地图，只保留底图和时间，刷新后仍为空；用“恢复默认路线”可恢复

## 数据更新

壁纸支持三种数据状态：

1. **默认路线**：构建时从 `web/data` 写入静态数据
2. **自定义路线**：在壁纸面板里导入 GPX / FIT，保存在当前壁纸的 IndexedDB
3. **已清除**：地图为空，刷新后仍保持；点“恢复默认路线”恢复静态数据

重新构建后，到 Wallpaper Engine 项目中替换 `index.html`、`assets/` 和 `wallpaper-data.js` 即可更新默认路线。

个人轨迹数据只存在于本地 `dist/wallpaper/wallpaper-data.js` 或浏览器 IndexedDB，不会进入 Git。

## 限制

- 地图瓦片来自在线底图，需要联网
- 壁纸版不提供行者同步和 PNG 导出
- 壁纸版不启用天地图地形；地形依赖服务端代理
- Wallpaper Engine 需要开启鼠标输入才能使用面板
