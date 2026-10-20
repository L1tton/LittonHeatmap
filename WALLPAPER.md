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
- 面板打开时：可拖动 / 缩放地图
- 点击面板右上角 `−`：收起面板，地图重新锁定
- 拖动面板顶部：移动面板
- 双击面板顶部：复位到左侧居中

## 数据更新

重新同步/导入网页版数据后，重新运行构建脚本，再到 Wallpaper Engine 项目中替换文件或重新导入。

个人轨迹数据只存在于本地 `dist/wallpaper/wallpaper-data.js`，不会进入 Git。

## 限制

- 地图瓦片来自在线底图，需要联网
- 壁纸版不提供行者同步、GPX/FIT 导入和 PNG 导出
- 壁纸版不启用天地图地形；地形依赖服务端代理
- Wallpaper Engine 需要开启鼠标输入才能使用面板
