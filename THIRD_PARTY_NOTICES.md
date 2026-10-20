# 第三方组件与数据许可

本项目源代码采用 **MIT License**，见根目录 [LICENSE](LICENSE)。

以下第三方组件/数据不改变其原有许可。分发本项目时请一并保留对应许可文件。

## 软件

| 组件 | 版本 | 许可 | 许可文件 |
| --- | --- | --- | --- |
| MapLibre GL JS | 4.7.1 | BSD-3-Clause | `web/assets/vendor/LICENSE.txt` |
| fit-file-parser | 6.2.2 | MIT | `web/assets/vendor/fit-parser.LICENSE.txt` |
| Blackout 2AM | 5.3.0 (Fontsource) | SIL OFL-1.1 | `web/assets/fonts/blackout-2am.LICENSE.txt` |
| Saira Stencil One | 5.3.0 (Fontsource) | SIL OFL-1.1 | `web/assets/fonts/saira-stencil-one.LICENSE.txt` |

FIT 浏览器 bundle 由 `scripts/fit-entry.js` 使用 esbuild 打包，包含 fit-file-parser 及其依赖；相关依赖仍遵循各自的开源许可。

## 地图数据与瓦片

| 来源 | 用途 | 许可/条款 |
| --- | --- | --- |
| OpenStreetMap contributors / OpenFreeMap | 浅色/深色底图、道路矢量 | ODbL / OpenFreeMap 服务条款；需保留 attribution |
| 天地图 | 地形底图与注记（通过服务端代理） | 天地图服务条款；公开传播需遵守审图/备案要求 |
| 高德地图 | 卫星影像 | 高德地图服务条款 |

地图瓦片和轨迹数据不随本仓库分发；使用在线服务时请遵守对应提供方的服务条款和版权要求。

## 轨迹数据

仓库不包含个人轨迹数据或示例轨迹。用户导入的 GPX / FIT 数据版权归各自作者所有。
