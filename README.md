# Slop Hong Kong

> **工程代號：Slop Hong Kong** · 把「Slop New York」這套 1:1 曼哈頓城市模擬器，改造成香港（中環／金鐘／灣仔／銅鑼灣／尖沙咀／佐敦／油麻地／旺角，維港兩岸）。
>
> ### 現況
> **香港世界已經落地並可運行**：`http://127.0.0.1:8081/?world=hk`
> 包含世界切換層（Phase 0）、香港資料管線與 `js/hk-geodata.js`（Phase 1）、以及**靠左行駛**的車流與香港車種（Phase 3）。
> 預設仍然是完整的紐約（沒有 `?world=hk` 時行為與原版一致，113 個舊測試全部保持通過）。
>
> ⚠️ 誠實聲明：香港的**地理資料是 seed**（手寫、真實座標、約 50 m 精度），因為這個 sandbox 連不到 Overpass API。
> 換成真 OSM 只要跑 `tools/overpass.sh` + `tools/hk/build-hk-geodata.mjs`，下游一行都不用改（見第 15 章）。
> 另外：這裡沒有瀏覽器與 GPU，**我無法在 sandbox 內實際執行 WebGPU**；邏輯層有 21 個測試把關，渲染層請你在瀏覽器開一次（見 15.0 的「已驗證 / 未驗證」清單）。

一句話：**three.js（dev 分支）＋ WebGPURenderer ＋ TSL 節點材質**，把真實 OSM／政府開放資料編譯成「1 單位 = 1 米」的世界，包含 2,691 個街廓、36 個地標、200 輛 AI 車、12 輛巴士、340 個有 IK 步態的行人、11 部攝影機、程序化合成的全城市聲音。

---

## 目錄

1. [快速開始](#1-快速開始)
2. [規模與真實數字](#2-規模與真實數字)
3. [系統需求](#3-系統需求)
4. [架構總覽](#4-架構總覽)
5. [啟動順序（Boot Pipeline）](#5-啟動順序boot-pipeline)
6. [世界座標系與地理資料](#6-世界座標系與地理資料)
7. [資料管線 `tools/`](#7-資料管線-tools)
8. [渲染：WebGPU + TSL](#8-渲染webgpu--tsl)
9. [效能工程](#9-效能工程)
10. [城市內容：建築、街道、樹](#10-城市內容建築街道樹)
11. [交通與行人](#11-交通與行人)
12. [控制器與物理](#12-控制器與物理)
13. [攝影機、地圖、音訊、輸入、UI](#13-攝影機地圖音訊輸入ui)
14. [測試與除錯](#14-測試與除錯)
15. [**香港世界：落地進度與工程藍圖**](#15-移植到香港工程藍圖)
16. [關於「UE5 / Blender / PhysX / 百萬行」的技術澄清](#16-關於ue5--blender--physx--百萬行的技術澄清)
17. [附錄：關鍵參數速查](#17-附錄關鍵參數速查)
18. [授權與資料來源](#18-授權與資料來源)

---

## 1. 快速開始

沒有 build step、沒有 `package.json`、沒有 `node_modules`。全部是原生 ES modules + import map，three.js 由 jsDelivr 直接抓 `mrdoob/three.js@dev`。

```bash
cd slop-hongkong

# 一定要用 HTTP server（file:// 會擋 ES module + import map）
python3 -m http.server 8081
# 或：npx --yes serve -l 8081 .

# 開 http://127.0.0.1:8081/
```

跑測試（18 個測試檔、144 個 test case，約 37 秒；只有 1 個需要先 `npm install three --no-save`，否則自動跳過）：

```bash
node --test "tests/*.test.cjs" "tests/*.test.mjs"
```

> 注意：**不要**用 `node --test tests/`，Node 22 會把它當成單一檔案路徑而 `MODULE_NOT_FOUND`。

行人 CPU 效能基準（需要自備 three.js 的 `build/three.core.js`）：

```bash
node tools/benchmark-pedestrians.mjs /path/to/three.js/build/three.core.js
# 或 THREE_CORE_PATH=... node tools/benchmark-pedestrians.mjs
```

重建地理資料（需要 `tools/data/*.json`，見第 7 章）：

```bash
GEO_DATA=tools/data node --max-old-space-size=8192 tools/build-geodata.mjs
```

---

## 2. 規模與真實數字

| 項目 | 實測值 |
|---|---|
| Git 追蹤檔案 | 70 |
| 程式碼行數（`index.html` + `css` + `js` + `tests` + `tools`） | **36,953 行** |
| 生成的地理資料 `js/nyc-geodata.js` | 1.13 MB（壓縮成 7 行 JSON） |
| 執行期模組 | 32 個（`index.html` 有 32 個 `modulepreload`，順序被 `tests/boot.test.cjs` 鎖死） |
| 世界尺度 | 1 單位 = 1 米；島長約 13.6 km（129th St → Battery） |
| 香港 seed | 17 條走廊 · 1,349 棟樓 · 25 地標 · 10 地區 · `js/hk-geodata.js` 124 kB |
| 街廓（curb island） | 2,691 個，其中 2,280 個帶可建地塊矩形 |
| 道路折線 | 3,246 條；路網圖 4,288 節點 / 3,030 連線 |
| 編號街道 / 大道 | 132 條 / 22 條 |
| 公園 / 碼頭 / 地標 footprint | 116 / 69 / 36 |
| 中央公園 | 7 個水體、9 片草坪、217 段園道、15 個景點 |
| 車流 | 200 輛車 + 12 輛巴士（另有高速公路車道程序化車輛） |
| 行人 | 340 個（每個有 15 骨 IK 步態） |
| 防火梯 | 上限 2,400 個 |
| 攝影機預設 | 11 個 |
| TSL 材質工廠 | 28 個 |
| 測試 | 144 pass / 0 fail（113 紐約 + 31 香港） |

> 使用者提到的「一百萬行」與實際不符：本 repo 是約 **3.7 萬行**的高密度程式碼（大量是 TSL 節點圖與幾何生成器），加上 1.13 MB 機器生成的 geo 資料。真正的工作量在密度，不在行數。

---

## 3. 系統需求

- **瀏覽器**：必須支援 **WebGPU**（香港世界同樣需要）。Chrome / Edge 桌面版最穩；Safari、Firefox 依版本而定（不支援時 `WebGPURenderer` 直接失敗，畫面停在 loading）。
- **Node.js**：22+（測試與 `tools/` 都用 `node:test`、ESM、`fs`）。
- **網路**：首次載入要抓 jsDelivr 的 three.js dev build 與 Google Fonts（Inter、Overpass）。
- **顯示卡**：需要能跑 MSAA + 半解析度 SSR + 2 級 CSM 陰影的獨顯或近代內顯。

> **fork 前強烈建議**把 `index.html` 的 import map 從 `@dev` 釘到某個 commit，不然上游一改 API，你的城市會在一夜之間變黑。

---

## 4. 架構總覽

```
index.html          HUD DOM（SVG icon sprite、popover、觸控層）、import map、32 個 modulepreload
css/style.css       HUD 版面（1,452 行）：品牌列 / 工具列 / 雷達小地圖 / 模式切換 / 儀表 / 全螢幕地圖

js/nyc-geodata.js   ⚠️ 由 tools/ 生成，勿手改。GEO = 整個紐約的資料（1.13 MB）
js/city-config.js   ★ 世界觀的「單一真相」：街道資料庫、大道、區塊索引、區位判定、地標表、號誌時序
        │
        ├── city-grid.js      地表：海、海堤、瀝青、行人道緣石、廣場、中央公園、碼頭、水岸
        ├── boroughs.js       外圍：布魯克林/皇后/布朗克斯/史泰登島/新澤西、離島、東河大橋、纜車
        ├── buildings.js      建築量體：1916 分區退縮、立面盒、水塔、天台機房、招牌、棚架、LOD
        ├── landmarks.js      36 個 OSM footprint → 專屬模型（ESB、Chrysler、One WTC…）
        ├── fire-escapes.js   防火梯（近 256 個真幾何 / 遠 2,400 個剪影）
        ├── street-details.js 街道家具：號誌、街燈、蒸汽、地鐵入口、小食車、消防栓、樹
        ├── trees.js          3 種樹程序化生成 + 4 級 LOD + 葉圖集
        ├── road-network.js   由「實際建出的地面」推導可駛路網、車道、交叉口、轉向曲線
        ├── road-paint.js     依路網畫標線（虛線、雙黃、停等線、班馬線、單車徑）
        ├── traffic.js        IDM 車流 + 碰撞火花 + 高速車道
        ├── pedestrian-system.js / pedestrian-routes.js / pedestrians.js
        │                     340 人、人車互動、GPU skinning 的群眾
        ├── controllers.js    4 種可玩模式（人/車/單車/直升機）+ 碰撞求解
        ├── actor-models.js   LoftGeometry 放樣車體、輪胎、燈條、雙層巴士
        ├── vehicle-lights.js 車頭燈（校準過的聚光燈）
        ├── cameras.js        11 個預設 + 滑鼠/觸控 orbit
        ├── lighting.js       4 個時段：Preetham 天空、PMREM IBL、2 級 CSM 太陽
        ├── post-processing.js ACES + 分時段調色 + 門檻式 bloom
        ├── scene-culling.js  全島靜態幾何的空間分塊與陰影代理
        ├── nyc-map.js        GTA 風雷達 + 全螢幕街道圖（1:1 同步）
        ├── audio-*.js        5 個模組：合成、事件、音源、遮蔽、混音
        ├── touch-controls.js / gamepad-controls.js
        └── main.js           ★ 進入點：建世界 → 建玩家 → 編譯 shader → 動畫迴圈
```

**設計原則**（讀 code 時會反覆看到）：

1. **資料驅動、零手擺**：沒有一棟樓、一棵樹、一條線是手動座標；全部由 `GEO` 推導。
2. **一套資料、多處消費**：街道家具的號誌與 `traffic.js` 的車輛共用同一個 `SIGNAL_TIMING`；路網由「實際建出的緣石」推導，所以標線、AI、碰撞三者永遠一致。
3. **CPU 不做每幀重活**：能塞進 GPU 的（蒙皮、招牌、立面窗格、路面紋理）全部走 TSL；CPU 每幀只更新矩陣與少量狀態。
4. **能合批就合批**：`mergeGeometries` + `InstancedMesh` + storage buffer；`scene-culling.js` 再把它們切成空間塊。

---

## 5. 啟動順序（Boot Pipeline）

`js/main.js` 的 `initApp()` 是一條明確的時序，每一步都有 `markInit()` 記錄耗時，最後在 console 印一行：

```
[init] renderer 320ms, lighting 850ms, cityGrid 1400ms, boroughs ... , compile ..., firstFrame ..., gpu ...
```

| # | 階段 | 做什麼 |
|---|---|---|
| 1 | `renderer` | `WebGPURenderer({ antialias, reversedDepthBuffer: true })`、`setPixelRatio(1.0)`、`ClusteredLighting(256, 32, 28, 48)` |
| 2 | `lighting` | `LightingSystem`：天空、IBL、太陽、陰影 |
| 3 | `cityGrid` → `boroughs` → `landmarks` → `blocks` → `streetDetails` | 依序建出地面、外圍行政區、地標、街廓、街道家具 |
| 4 | `traffic` | 以 `cityGrid.footprints` + `streetDetails.footprints` + 低於 3.5 m 的碰撞體，推導路網與 200 輛車（**這一步順序不能動**：路網由已建出的幾何決定） |
| 5 | `roadPaint` | 用同一份 `trafficSystem.network` 畫標線 |
| 6 | `controllers` | 4 種模式實體 + `localStorage` 還原上次位置（key：`nyc-player-state`，version 1） |
| 7 | `culling` | `setupSceneCulling()` 切塊、建立陰影代理 |
| 8 | `postFX` + `compile` | 先渲染一張空場景以確定 render target 格式，再以 **16 條並行 worker** 預編譯 shader（「暖機快取 2.1 s vs 冷快取 25 s」） |
| 9 | `warmup` / `firstFrame` / `gpu` | 第一幀關掉 frustum culling 編譯剩下（陰影 pass 才用到的）pipeline；等 `queue.onSubmittedWorkDone()` 後才移除 loading |
| 10 | 迴圈 | 依序：gamepad → controllers → cameras → 號誌時鐘 → traffic → highway → 存檔(每 5 s) → boroughs.update → cityBlocks 四叉樹 → 街燈 → lighting → 地圖 → 音訊 → culling → render |

每幀 `dt` 被夾在 `[1 ms, 50 ms]`；FPS/速度/高度/位置每 250 ms 更新一次 DOM。

---

## 6. 世界座標系與地理資料

`js/nyc-geodata.js` 開頭就寫清楚了（也請照這個格式寫 HK 版）：

```
1 unit = 1 m
x = 曼哈頓網格「東」   z = 曼哈頓網格「南」（北 = -z）
原點 = 5th Ave & 42nd St 中心線交點
座標軸相對真北轉 29.02°（實測的街道網格方位角）
```

- 水面 `y = -2.2`，行人道高 `0.22`。
- `frame.cutZ = -7090`：詳細島嶼的北界（約 129th St）；再北（Harlem 上半、Washington Heights）交給 `boroughs.js` 的低細節模式。
- `frame.strip = 20`（水岸保留帶）、`frame.sidewalk = 4.6`（緣石到地界線，即 15 ft）。

### `GEO` schema（HK 版要沿用）

| 欄位 | 型別 | 內容 |
|---|---|---|
| `frame` | obj | `bearingDeg`, `origin`, `units`, `cutZ`, `strip`, `sidewalk` |
| `manhattan` / `upperManhattan` / `innerShore` | flat polyline | 島嶼岸線（`[x0,z0,x1,z1,…]`） |
| `islands` | obj | `roosevelt` / `randalls` / `governors` / `liberty` / `millRock` / `ellis` |
| `boroughs` | obj | `brooklyn` / `queens` / `bronx` / `statenIsland` / `newJersey`（多環） |
| `streets` | array | `{ n, z, segs:[[x0,x1,dir,curbWidth]] }` ← **曼哈頓專用** |
| `avenues` | array | `{ id, label, x, segs:[{z0,z1,dir,w,lanes,names}] }` ← **曼哈頓專用** |
| `broadway` | flat polyline | 斜向主幹（示範「非網格道路」怎麼進資料） |
| `plazas` | array | 行人專用區（Times Sq、Herald Sq…） |
| `roads` | array | `[name, width, dir, lanes, isHighway, flatLine]` ← **通用，HK 的主力** |
| `roadGraph` | obj | `{ nodes, links, names }`：由中心線推出的拓撲圖 |
| `blocks` | array | `[flatPoly, rects, parkShare, parkName, isRect, frames]` |
| `parks` | array | `{ name, cat, acres, rings }` |
| `centralPark` | obj | `bounds/outline/water/lawns/drives/paths/sites` |
| `piers` | array | `{ name, cx, cz, len, wid, ang, ring }` |
| `bridges` | obj | 4 條東河橋的 `a`（曼哈頓端）/`dir` |
| `landmarks` | obj | 36 個 real footprint：`{ x, z, w, d, h, ang }` |
| `points` | obj | 橋塔、自由女神、Whitehall Terminal 等單點 |

`city-config.js` 把這些原始資料「加工成人類可用的世界觀」，最重要的幾件：

- **`SHORE`**：把岸線光柵化成每 2 m 一格的 `west[]`/`east[]` 表 → `getIslandBoundsAtZ(z)` O(1)。水岸、行人道、路面、AI 邊界全用它。
- **`BLOCKS`**：每個街廓算出多邊形、面積、質心、是否軸對齊、是否中央分隔島（`median`）、以及 `district`。
- **空間索引**：道路段與街廓都丟進 64 m 網格（`ROAD_GRID` / `BLOCK_GRID`），`nearestRoads(x, z, r)`、`blockAt(x, z)`、`blocksInRect()` 都是 O(1) 級。
- **`districtAt(x, z)`**：用真實街道座標切出 30 多個社區（Midtown、SoHo、FiDi…），決定建築風格。
- **`SIGNAL_TIMING`**：60 秒循環。大道 0–26 綠、26–30 黃、30–60 紅；橫街 30–56 綠、56–60 黃；行人 `walk = 7 s`。**號誌燈頭與 AI 車輛共用同一組常數**。
- **`fromOldFrame()`**：舊版壓縮座標 → 真實 1:1 的分段線性換算（保留「離 5th Ave 中心線 6 m」這類相對位置）。這是歷史包袱，HK 版不需要。

---

## 7. 資料管線 `tools/`

6 個 ESM 模組，按順序 import，最後噴出一個 `.js`：

| 檔案 | 職責 |
|---|---|
| `geo-base.mjs` | 世界框（`LAT0 = 40.75318`、bearing 29.02°）、`toWorld()`、RDP 簡化、面積、`load()`、光柵化 `Raster` |
| `geo-streets.mjs` | 讀 CSCL 街道中心線 → `pieces`（名稱、路寬 ft→m、車道數、單雙向、等級）→ `STREETS` / `AVENUES` |
| `geo-blocks.mjs` | 把每條平面道路按 curb-to-curb 寬度光柵化，剩下的陸地就label成街廓；輸出緣石多邊形 + 地塊矩形（`CUT_Z=-7090`, `STRIP=20`, `SIDEWALK=4.6`） |
| `geo-extra.mjs` | 公園覆蓋率、OSM 碼頭、東河橋、新澤西岸線、離島、上曼哈頓切分 |
| `geo-roadgraph.mjs` | 中心線 → 圖（1 m 內節點合併），供 `road-network.js` 在網格失效的鬧區以外使用 |
| `build-geodata.mjs` | 主程式：Broadway 中心線、道路折線合併、中央公園特徵、地標 footprint、輸出 `js/nyc-geodata.js` |

輸入（`tools/data/`，共 9 個檔，含 4 支 `.overpassql` 查詢與 `overpass.sh` 下載器）：

| 檔案 | 來源 |
|---|---|
| `dcp_boroughs.json` | NYC DCP Borough Boundaries（`gthc-hcne`） |
| `cscl_manhattan.json` | NYC Street Centerline（`inkn-q76z`） |
| `nycparks_manhattan.json` | NYC Parks Properties（`enfh-gkve`） |
| `osm_centralpark.json` / `osm_coastline.json` / `osm_landmarks.json` / `osm_piers.json` | OpenStreetMap via Overpass |

`overpass.sh` 值得單獨一提：12 次重試、3 個 endpoint 輪替、`mktemp` 原子替換、JSON 驗證通過才 rename——**下載中斷不會弄壞既有資料**。HK 版直接沿用。

---

## 8. 渲染：WebGPU + TSL

### 8.1 Renderer 設定

- `WebGPURenderer`，`antialias: true`，**`reversedDepthBuffer: true`**（32-bit float 反轉深度）→ 近平面 `0.35`、遠平面 `60000`，因為 1:1 尺度下外圍行政區到地平線有 20–40 km。
- `setPixelRatio(1.0)`：刻意不跟 devicePixelRatio，換幀率。
- `ClusteredLighting(256, 32, 28, 48)`：數百盞街燈/車燈/店面燈走 clustered path，不是逐盞 forward。

### 8.2 主 Render Graph

```
scene pass（MSAA，彩色/法線/metalRough 三個 attachment 設為 memoryless：storeMultisampledColorBuffer = false）
  ├─ output
  ├─ normalView
  └─ metalRough = vec2( roughness < 0.75 ? metalness * fade(360→180 m) : 0 , roughness )
SSR（半解析度 resolutionScale 0.5、maxDistance 42、thickness 0.85、quality 0.25 + binaryRefine、intensity 0.5）
  × reflectionMask（roughness > 0.75 或被 fade 掉的地方直接歸零，避免假反射爬到霧面）
→ createPostProcessing()：exposure → 白平衡 → bloom(門檻式) → ACES → 輸出色彩空間
→ THREE.RenderPipeline
```

小細節但有效：bloom 只夾峰值亮度、RGB 等比縮放（霓虹與街燈不變色）；tone mapping 只做一次。

### 8.3 28 個 TSL 材質工廠（`tsl-materials.js`，3,040 行）

幕牆 `createCurtainWallMaterial`、戰前磚石 `createPreWarBuildingMaterial`、立面盒 `createFacadeBoxes`、Chrysler 皇冠、車漆 clearcoat、樹葉（atlas + 風擺）、公園鋪面/矮牆/鐵欄/燈球/光池、隧道暗部、TKTS 階梯、大理石、樹穴格柵、**路面**、標線、行人道、緣石、招牌（程序化 canvas 主題）、水面、草坪、蒸汽、**god ray**、接觸陰影、車燈 flare。

材質的共同語言是 `cityUniforms`：全域時間、霧、店面內透光、夜間係數等——一支 uniform 改完全城。

### 8.4 四個時段（`lighting.js`）

`golden`（17:45，太陽 5.8）、`midday`（13:30，6.6）、`twilight`（19:15，3.1）、`midnight`（23:00，1.45）。
每個預設同時決定：太陽方向/色溫、半球光、天空頂/地平色、霧色與密度（golden 為 `0.00024`）、室內透光、以及 `post-processing.js` 的曝光/對比/飽和/白平衡/bloom 門檻。
技術：`SkyMesh`（Preetham）＋ Beer-Powder 雲 ＋ `PMREMGenerator` 即時 IBL ＋ `SunLight`（r186，2 級 CSM）。

---

## 9. 效能工程

這是整個專案最值錢的部分，四個手段：

### 9.1 `scene-culling.js` — 三種切法

問題：整島的街燈、號誌、立面盒被合成「幾個」`InstancedMesh`，包圍球直徑 7 km，three.js 永遠不會剔除；每幀 GPU 要把全島的燈柱變換三次（view + 2 個陰影 cascade）。

1. **小型 props 分塊 + 距離剔除**：依實例大小算剔除距離（`CULL_PER_METRE = 1100 px/m`、下限 300 m、上限 2000 m）。
2. **大型靜態投影體 → 陰影代理**：切 500 m 格子、只放位置、獨立 layer 3，只有 cascade 相機渲染；原件停投影。同面共用一個材質 → 一格一次 draw call。
3. **其餘大批次 → 1,000 m 格子做視錐剔除**，但保留全距離。

### 9.2 Instancing + WebGPU storage buffer

WebGPU 上 ≤1000 實例的 `InstancedMesh` 矩陣放在 uniform buffer，**每個 pass 都會重上傳**（含陰影 cascade 約 2.5 MB/幀）。`main.js` 在 WebGPU backend 下把 `instanceMatrix` 換成 `StorageInstancedBufferAttribute`（WebGL2 保持原樣，否則變換會壞）。

### 9.3 Shader 預編譯

冷快取直接渲染要編 ~500 條 pipeline ≈ 25 s。做法：空場景先渲染一張以確定 render target 格式 → 依材質分組的 job 佇列 → **16 條 worker 並行 `compileAsync()`** → 再補一幀「關閉 frustum culling」的暖機（陰影 pass 專屬 pipeline）→ 等 GPU 佇列清空才收 loading。

### 9.4 內容本身的 LOD

- **建築**：`Quadtree` 串流的高細節建築池（LOD0 只圍繞玩家）、立面窗格在 shader 內程序化（`fwidth` 抗摩爾紋）、屋頂細節按像素尺寸淡出（`crownLOD = smoothstep(8.0, 3.0, px)`）。
- **防火梯**：近 30 m 內最多 256 個真幾何，其餘 2,400 個剪影。
- **樹**：3 物種 × 4 級 LOD，葉卡圖集 1024² 分 2×2 tile，遠景用「整團樹冠」卡片。
- **行人**：2 級 LOD，每級一次 instanced draw；每人的骨骼（四元數+位移+縮放）放在 storage buffer，由 vertex stage 蒙皮。
- **交通**：車輛 380 m 內保留、350 m 內不重生（避免近景彈出），高速車道獨立系統。

---

## 10. 城市內容：建築、街道、樹

### 建築（`buildings.js`，2,597 行）

- 依 `districtAt()` 決定風格：戰前磚石（防火梯、水塔）vs 幕牆（`createCurtainWallMaterial`）。
- **1916 分區「wedding cake」**：滿地塊基座 → 退縮層 → 塔樓；`LANDMARK_SITES` 上的真實 footprint 由 `landmarks.js` 接手。
- 屋頂：石簷口、木水塔（鋼箍 + 四腳鋼架）、機房與冷卻塔、排氣扇。
- 地面：帆布雨篷、發光店招、施工棚架、店面 SpotLight（走 clustered）。
- 全部碰撞體進 `controllers.js` / `traffic.js` / `audio-acoustics.js` 共用的 AABB/OBB 清單。

### 街道家具（`street-details.js`，1,209 行，8 個 section）

1. 63 個路口的**懸臂式紐約黃號誌**、街名牌（綠底白字，canvas 貼圖）、行人號誌。
2. 中段橡實燈 / 眼鏡蛇街燈。
3. **Con Ed 橙白蒸汽煙囪** + TSL 體積蒸汽、NYCDOT 木馬圍欄。
4. **MTA 地鐵入口**與綠色球燈。
5. 熱狗 / Halal 小食車 + 藍黃傘。
6. 消防栓與 USPS 藍郵箱（instanced）。
7. 喬木：公園、廣場、中央公園林地、大道行道樹（`trees.js`）。
8. 街燈光池（clustered）。

### 地標（`landmarks.js`，1,071 行）

`GEO.landmarks` 有 36 個真實 footprint；`landmarks.js` 其中 **11 個**有專屬模型與細節（依檔案內 section 順序）：

ESB（含 86 樓觀景台欄杆）、Chrysler（專屬皇冠材質，`createChryslerCrownMaterial`）、One Vanderbilt、Grand Central ＋ Park Ave Viaduct ＋ MetLife、Bryant Park ＋ NYPL、One Times Square ＋ Broadway LED 峽谷、30 Rock、Citigroup Center、Flatiron、Seagram ＋ 花崗岩廣場、One WTC。

其餘地標用 `LANDMARK_SITES` 的 `w/h/d/ang` 生成合規量體。**注意**：section 1–10 仍以 `getBlockBounds(col, row)`（舊 Midtown superblock 行列）定位，section 11 之後才用真實 lot——這是 NYC 遺留耦合的活證據，也是移植時要一併清掉的技術債。

### 外圍（`boroughs.js`，3,391 行）

土地分區貼圖（公園/工業/低密度/濕地，約 31 m texel）、鄰里街道網格、遠景便宜材質、海堤、Palisades 山脊、離島（Roosevelt + 纜車、Governors、Randalls、自由女神）、4 條東河橋（懸索/斜張/懸臂各自的塔、主纜、吊索、錨碇）、以及 GWB 與 Verrazzano。

---

## 11. 交通與行人

### 路網（`road-network.js`）

**不從 config 讀，而是從「實際建出的緣石與障礙物」推導**（32 m 空間哈希）：大道走廊、橫街缺口、避開分隔島/廣場/蒸汽煙囪的車道、路口（有號誌的標記）、以及穿越路口或轉彎的 lane-to-lane 曲線。
慣例：北 = `-z`、東 = `+x`；每條有向邊有單位方向 `(dx, dz)` 與右法線 `(rx, rz) = (-dz, dx)`；**車道是相對中心線「向右」的橫向偏移，由左至右排序**。`CROSSWALK = 2.5 m`。

### 車流（`traffic.js`，2,160 行）

- 200 輛（黃的士/轎車/SUV/NYPD）+ 12 輛 MTA 巴士（`NUM_BUSES = 12`；檔案內 section 2 的註解寫「32 BUSES」，是過時註解）；高速車道另有程序化車流。
- **IDM（Intelligent Driver Model）**：轎車 `{a 2.0, b 3.0, T 1.2, s0 2.0, aLat 3.5}`、巴士 `{1.1, 2.5, 1.5, 2.5, 2.0}`；`LOOKAHEAD = 70 m`。
- 能力：跟車、變線超車、進轉向車道、轉入他街、看號誌停等、左轉讓對向、無號誌路口讓幹道、讓行人、**不塞住路口**。
- 玩家互動：SAT 接觸 + 衝量 + 火花粒子池（推與被推）。
- 車輛幾何由 `actor-models.js` 的 `LoftGeometry` 放樣：截面環、弧長 UV、平滑接縫法線、Newell 封蓋、圓形輪拱、Lathe 輪胎、五幅鋁圈、後視鏡、車頂燈箱。

### 行人（`pedestrian-system.js` + `pedestrian-routes.js` + `pedestrians.js`）

- 340 人；每人有獨立身高/體型/性別/髮型/衣著/步速（1.22–1.6 m/s）。
- **步態真的「踩在地上」**：腳跟觸地 → 全掌 → 提踵 → 趾離地，兩骨 IK 彎膝髖，骨盆隨步伐上下（倒單擺），骨盆旋轉/擺動、胸腔反向旋轉、手臂擺動全部由腳驅動；上下緣石、原地轉身、停下並腳、跑、跳、騎單車都有。
- `pedestrian-routes.js`：只連接同一緣石島的行人路線；**過馬路是另一套由 `traffic.js` 持有、受號誌控制的軌道**；只在 WALK 的前 7 秒起步。
- 玩家靠近會讓路（避讓間隔 0.12 s），會停下交談。

---

## 12. 控制器與物理

| 模式 | 最高速 | 加速 | 其他 |
|---|---|---|---|
| `person` | 跑 8.2 m/s | — | 跳躍、`getGroundHeight` 取地形/緣石/草坪高度 |
| `car` | 23.5 / boost 36 / 倒車 10.5 m/s | 4.5 / boost 5.25 | 滾阻 0.18、風阻 0.0012、剎車 9；>45 km/h 後功率限制 |
| `cyclist` | 12.8 / boost 19 / 倒車 4.5 | 9 / 13.5 | 滾阻 0.08、風阻 0.004、剎車 7.5（倒車輸入 ×0.6） |
| `helicopter` | 52 m/s | — | 高度上限 380 m；集體槳距影響升力 |

- HUD 速度表滿刻度：`{person 18, car 81, cyclist 43, helicopter 116} mph`（由 m/s 反推）。
- 碰撞：AABB + 可選 OBB（旋轉過的街廓），以 32–64 m 網格索引（`_colliderCells`）；`buildingContact()` 做分軸推出並回傳法線。
- 直升機 `verticalSpeed` 會被高度夾住但不會自動清零 → `audio-sources.js` 有專門處理（`helicopterVerticalSpeed()`）。
- 換模式時若在靜態風景鏡頭，自動切回 Chase。

---

## 13. 攝影機、地圖、音訊、輸入、UI

### 攝影機（`cameras.js`，11 個預設）

3 個跟隨（Chase 56° / Action 60° / POV 68°）+ 7 個地標風景（中央公園 52°、5th Ave & ESB 48°、Times Sq 58°、42nd St Chrysler/GCT 50°、ESB 86 樓 52°、Bryant Park 52°、東河天際線 46°）+ 自動導演空拍 50°。滑鼠/觸控 orbit（`orbitYawOffset`、`orbitPitchOffset`、`zoomMultiplier`），拖曳後有自動回位計時器。

### 地圖（`nyc-map.js`，1,290 行）

- **雷達**：`RADAR_SCALE = 0.32 px/m`，隨高度縮放，即時畫街廓/道路/地標/GPS 路線。
- **全螢幕地圖**：`MIN_ZOOM 0.015`（整個海港）→ `MAX_ZOOM 3.0`（單一地塊）；畫真正的 `GEO`（岸線、碼頭、街廓與其上的建築、公園、中央公園草地/水體/園道、快速道路、標註道路名、外圍行政區、離島、橋）。
- 兩張圖都「網格北朝上」（真北偏東 29.02°），與 3D 世界 1:1 同步；搜尋框可找街道/地標並傳送。
- 有測試專門驗證「點擊座標 ↔ 世界座標」在 3 種解析度 × DPR 下都正確。

### 音訊（5 個模組）

- **全程序化合成**（`audio-synthesis.js`，590 行）：內燃機氣缸脈衝、柴油、輪胎、風、警笛、腳步、環境事件；`setControlRate()` 把所有控制參數降到 k-rate（省 CPU）。
- **空間化**：HRTF `PannerNode`、`inverse` 距離模型、`rolloff 1.15`、`maxDistance 500`；有方向性的音源（警笛）用 cone 參數。
- **遮蔽**：`audio-acoustics.js` 用與移動碰撞同一份 AABB/OBB 做 slab 求交，算「穿牆厚度」→ 低通濾波；近距離包圍盒快取；不做 mesh raycast、不做 audio-rate DSP。
- **反射**：所有聲音共用一條短卷積，無 per-voice reverb。
- 音源範圍：引擎 180 m、警笛 220 m、人聲 45 m、號誌 35 m。

### 輸入

- 鍵盤：`1–4` 模式、`5–0` 攝影機、`V`/`Shift+V` 切換、`H` 收 HUD、`N` 靜音、`B` 喇叭、`M` 地圖、`Space` 跳/升、`Q/C` 降、`Shift` 加速；在 `INPUT`/`SELECT` 內打字時全部略過（`isTypingInField`）。
- 觸控：虛擬搖桿（死區 0.15、半徑 44 px）+ 動作鍵；與鍵盤狀態**完全分離**（放手不會放掉按住的鍵）。
- 手把：Gamepad API，17 鍵、搖桿死區正規化、按鍵邊緣偵測、失焦保護。

### UI

原生 `<dialog>`/`popover`（`togglePopover`，自動 light-dismiss + Esc）、SVG icon sprite、`prefers-reduced-motion`、`aria-*` 完整；HUD 面板有 `hud-minimized` 淨空模式；模式切換用 CSS 變數 `--ind-x/--ind-w` 讓黃色藥丸滑動。

---

## 14. 測試與除錯

| 測試檔 | 驗什麼 |
|---|---|
| `boot.test.cjs` | import map；bootstrap（世界判斷 ＋ 錯誤顯示）必須早過 module 入口；兩個世界的預載清單冇重複、檔案存在、每個相對 import 都已被預載 |
| `geodata.test.mjs` | 生成資料的 schema 與合理性 |
| `overpass.test.mjs` | `.overpassql` 查詢語法與 `overpass.sh` 健壯性 |
| `traffic.test.cjs` / `traffic-performance.test.cjs` | IDM 行為邊界、預算/複雜度 |
| `controllers.test.cjs` | 鍵盤對應、加減速、碰撞、模式切換 |
| `cameras.test.cjs` | 11 個預設、插值平滑、縮放/繞行 |
| `nyc-map.test.cjs` | 點擊 ↔ 世界座標（3 解析度 × DPR）、縮放界線 |
| `facade-projection.test.cjs` | 把生產環境的 TSL 表達式用數值 stub 重算，驗證抗鋸齒立面投影 |
| `smoke-texture.test.cjs` | 蒸汽雲貼圖烘焙只做一次、雜湊成本 |
| `teleports.test.cjs` | 8 個傳送點不在建築裡、朝向合理 |
| `touch-controls.test.cjs` | 多點觸控、按鍵狀態隔離 |
| `vehicle-lights.test.cjs` | 車燈從燈具位置出發、不照穿底盤 |
| `hk-geodata.test.mjs` | 香港資料：世界框方向、投影、樓宇不壓路、地標在陸上、海岸線分離、交通資料 |
| `hk-world.test.cjs` | 香港世界：**靠左行駛的車道幾何**、車道數、`poseAt`、號誌、雙語標籤、傳送點、跟車模型、世界切換 |
| `hk-render.test.mjs` | 標線只產生**一個** typed array（回歸測試）、無 NaN、留在車行道內、虛線相位跨段、退化輸入、啟動流程會 macrotask 讓路並預編譯 shader |
| `hk-traffic.test.cjs` | 車流在**子程序**中建得起（20 s timeout 偵測無限迴圈）、車隊分配總和必等於車數、`traffic.js` 不再有無界 while |
| `hk-smoke.test.mjs` | 用**真 three.js** 建整個香港場景並跑 180 幀（未安裝 three 時自動 skip） |
| `hk-modules.test.mjs` | **逐個模組做語法檢查**（`node --check`）、香港的靜態 import 白名單、`index.html` 必須「只 import 一個世界」 |
| `hk-boot.test.mjs` | **端到端開機**：用真的 `index.html`（jsdom）+ 真 three.js 幾何 + 假 `WebGPURenderer`，由 `?world=hk` 行到第一幀（未安裝 three / jsdom 時自動 skip） |

測試手法值得學：`tests/helpers/module.cjs` 用 `vm` 把檔案裡的 `import`/`export` 改寫掉，餵進 stub namespace，**生產程式碼本體一行不改**就能在 Node 裡跑。所以測試不需要 three.js、不需要瀏覽器。

除錯：

- console 的 `[init] ...` 逐階段耗時；`[compile]` 警告代表某物件退回暖機編譯。
- 目前**沒有** URL query 參數（`?map=…` 之類不會有作用）；要一開場就開地圖，得自己加 `URLSearchParams` 讀取。
- 存檔：`localStorage['nyc-player-state']`（version 1，每 5 s 與 `pagehide`/`visibilitychange` 寫入）。
- FPS 顏色：≥50 綠、≥30 黃、其餘紅。

---

## 15. 移植到香港：落地進度與工程藍圖

### 15.0 已經落地的東西（Phase 0 / 1 / 3）

| Phase | 內容 | 檔案 | 狀態 |
|---|---|---|---|
| **0** 世界切換 | `?world=hk` / `?world=ny` / 記住上次選擇；品牌、標題、`localStorage` key 分離；兩邊 HUD 互有連結 | `js/world.js`(102)、`js/main.js`(+8)、`css/hk.css`(204)、`index.html` | ✅ |
| **0.5** 開機層 | `index.html` inline bootstrap：先決定世界 → 只 import 那一個世界；`__slopBootFail` 錯誤卡 ＋ 20 秒 watchdog；按世界分流 `modulepreload` | `index.html`、`js/hk/main.js`（依賴收窄到 `three/webgpu`） | ✅ |
| **1** 資料管線 | 世界座標框（真北朝上）、投影、OSM-ready seed、街廓／樓宇生成、地標、地區、電車／渡輪／隧道 | `tools/hk/frame.mjs`(107)、`seed-hk.mjs`(189)、`blocks.mjs`(173)、`build-hk-geodata.mjs`(160)、`js/hk-geodata.js`(124 kB)、`tools/data/q_hk_*.overpassql` | ✅ seed（約 50 m 精度） |
| **1** 世界觀 | 「走廊 + chainage」取代 `streetZ/avenueX`；雙語地區與位置標籤；香港號誌週期 | `js/hk/config.js`(293) | ✅ |
| **3** 靠左行駛 | 車道＝中心線**向左**偏移（單一公式 `laneLateral`）、雙向走廊兩組車道、跟車模型 | `js/hk/traffic.js`(225)、`config.js` 的 `buildLanes/followSpeed` | ✅ |
| **3** 香港車種 | 紅的士（重用放樣車體）、雙層巴士、電車、小巴、天星小輪 | `js/hk/vehicles.js`(165) | ✅ |
| **3** 場景 | 維港水面、填海陸地＋海堤、路面＋行人道＋路緣、標線（單一 geometry）、1,349 棟沿街樓宇（boxLocal TSL 立面）、25 個地標、593 支街燈、電車軌 | `js/hk/city.js`、`js/hk/markings.js` | ✅ |
| **3** 操控 | 街機式駕駛（油門／剎車／滾阻／風阻／速度相關轉向）＋ AABB 碰撞；追尾鏡頭 | `js/hk/drive.js`(148) | ✅ |
| — | 進入點：WebGPU + 既有 `LightingSystem` + `createPostProcessing`，四個時段、傳送點、HUD（km/h）、建置版本徽章 | `js/hk/main.js` | ✅ |
| **3** 行人 | 重用紐約資產：`PersonCrowd` / `PersonRig` GPU 蒙皮步態、2 個 LOD 網格、300 人 | `js/hk/pedestrians.js`（動態 import `js/pedestrians.js`） | ✅ |
| **3** 地圖 | `HK.LAND` / `HK.ROADS` / `HK.TRAM` 全港地圖、即時車流、傳送點、玩家箭咀；`M` 開關、點擊傳送 | `js/hk/map.js` | ✅ |

**跑起來**

```bash
python3 -m http.server 8081
# 香港（靠左行駛）
open "http://127.0.0.1:8081/?world=hk"
# 紐約（原版）
open "http://127.0.0.1:8081/?world=ny"
# 重建香港資料
node tools/hk/build-hk-geodata.mjs
# 只跑香港的測試
node --test "tests/hk-*.test.*"
```

**操作**：`W/S` 前進倒車、`A/D` 轉向、`Shift` 加速、`Space` 剎車、`G` 切換光線、`1`–`9` 傳送到九個真實地點、**`M` 開關地圖（點地圖即傳送）**、拖曳環繞、滾輪縮放。畫面左上角 HUD 長期顯示建置版本（例如 `v2026-10-25.8`）。

**診斷**（黑畫面期間預設就開，按 `D` 或 `&debug=0` 可關）：

| 參數 | 作用 |
|---|---|
| `&debug=1` | 診斷面板（現在預設已開；`&debug=0` 關掉） |
| `&test=1` | 鏡頭前加一個**唔受燈光影響**的紅色方塊，並在 1.5 秒後**離屏渲染一次再讀回中央像素** |
| `&webgl=1` | 強制用 WebGL2 後端（用來排除 WebGPU 後端問題） |
| `&low=1` | 跳過樓宇 |
| `&post=1` | 試 TSL 後處理管線 |
| `&sky=1` | 試完整大氣天空（Preetham + PMREM） |
| `&blackcheck=1` | 才做 canvas 像素讀回（WebGPU present 之後讀回永遠係黑，所以預設關閉，亦**永不自動 reload**） |

**怎樣一次過判斷黑畫面是誰的錯**

| 你見到 | 結論 |
|---|---|
| 全黑，但面板寫 `畫面中央最上層：div… ← 蓋住咗 canvas！` | **CSS／DOM 問題**：3D 畫面被 HTML 蓋住，同渲染無關 |
| 全黑，紅色方塊都冇，讀回像素係 `#000000` | 繪製本身是黑：材質／燈光／clearing |
| 全黑，但有紅色方塊（或讀回 `#8fb2d8` 天空藍） | 場景畫得出來 → 問題在 **canvas 呈現**（後端 / CSS / 尺寸） |
| `canvas 0×0` 或 `唔在 DOM！` | canvas 尺寸／掛載問題 |
| 面板出現 `GPU 錯誤：…` 或 `DEVICE LOST` | WebGPU 裝置層問題 → 試 `&webgl=1` |
| `adapter：… （軟件模擬）` | 用緊軟件 GPU（WARP/SwiftShader）→ 試 `&webgl=1` |

面板內容：`three r…`、後端名稱（`WebGPUBackend` / `WebGLBackend`）、canvas 像素與 CSS 尺寸、**canvas 是否在 DOM／opacity／display**、**畫面中央最上層係邊個元素**、draw calls／三角形／frames、場景數與燈光數、`background` 色值、相機位置與 near/far、所在區、繪製路徑、`navigator.gpu` 與 adapter 資訊、`uncapturederror` 與 `device.lost` 訊息、離屏讀回像素。同一段文字亦會 `console.log('[hk diag] …')` 一次，方便直接複製。

> `?world=ny` 可以直接做對照實驗：如果紐約也是全黑，問題就不在香港的移植，而在瀏覽器／WebGPU 本身。

**資料規模（seed）**：17 條走廊 · 1,349 棟樓（340 棟 > 120 m）· 25 個地標（IFC 412 m、ICC 484 m、中銀 367 m…）· 10 個地區 · 1 條電車線 · 1 條天星小輪航線 · 1 條海底隧道記錄。

**已驗證（可重跑）**

- `node --test "tests/hk-*.test.*"` → **41 pass**（世界框方向、投影 round-trip、樓宇不壓馬路、地標在陸上、**每一條車道都在行車方向的左邊**、車道數與單程路、`poseAt` 單調、號誌相位與行人綠燈、雙語標籤、出生點與九個傳送點都在真實車道上、跟車模型、世界切換純函式）。
- 全倉測試：`node --test "tests/*.test.cjs" "tests/*.test.mjs"` → **157 pass / 0 fail**（原 113 個紐約測試全數保留通過）；加 `hk-boot` / `hk-modules` 兩個開機測試。
- 開機端到端：`node --import ./tools/hk-boot/register.mjs tools/boot-hk.mjs` → 由 `?world=hk` 一路行到第一幀。
- 語法檢查：`node tools/check-modules.mjs` → `✓ 全部模組語法正常`（這一項會在 CI 前抓到「重複宣告」這類令整個世界開唔到的 early error）。
- 專案內所有相對 import 的名稱都存在（用腳本掃過 40 個模組），而且每個模組都通過語法檢查。

**已知問題與已修（v2：Page Unresponsive）**

首次在瀏覽器試跑時，頁面卡在「初始化 WebGPURenderer…」並彈出 *Page Unresponsive*。追查結果是兩個**主執行緒**問題，與 WebGPU 無關：

| # | 原因 | 修法 |
|---|---|---|
| 1 | `city.js` 的標線為 **每一段虛線** 開一個 `BufferGeometry`（全城 13,108 個）再 `mergeGeometries`，同步跑幾秒至十幾秒 | 新增 `js/hk/markings.js`：一次過寫入單一 typed array。**13,108 個 geometry → 1 個**，實測 19 ms、9,008 個 quad |
| 2 | 用 `requestAnimationFrame` 當「讓路」，但 rAF 的微任務在瀏覽器 paint **之前**執行，所以建城中途卡住時畫面永遠停在舊狀態 | 改用 `setTimeout(…, 16)`（macrotask，必定 paint），並把建城拆成 4 個階段逐段顯示 |
| 3 | 第一幀一次過編譯所有 shader pipeline（紐約版正是為此寫了預編譯機制，否則冷快取 ~25 s） | 補上 8 路並行 `renderer.compileAsync()` + 進度百分比 |

**第二輪（畫面顯示「安排靠左行駛的車流…」時卡死）**

| # | 原因 | 修法 |
|---|---|---|
| 4 | **無限迴圈**：車隊容量用 `round(share × 96)` 算出 44+21+15+15 = **95**，但迴圈要放 **96** 架車；第 96 架「所有車隊都滿」，`while (fleets[pick].cars.length >= capacity) pick++` 永遠跳唔出 → 主執行緒鎖死 | 新增 `js/hk/fleet.js` 的 `allocateFleet()`（最大餘數法，**保證總和 === 要求數量**），容量一次算好，完全刪除該 while 迴圈。96 架 → `[44, 21, 16, 15]` |
| 5 | 早前重構 `traffic.js` 時誤刪了 `withLength()`，電車線一建就 throw（會在下一個階段爆） | 補回，並由新的 harness 抓到 |

另外加了：**任何啟動例外都會印在載入畫面上**（訊息 + 已完成階段 + 耗時），不會再出現「黑畫面 + Unresponsive」；以及 `?world=hk&low=1` 診斷模式（跳過樓宇，只留道路＋車流）。

**現在有甚麼機制防止再犯（兩個新工具）**

1. `tests/hk-traffic.test.cjs` + `tests/helpers/hk-traffic-harness.cjs`：在**子程序**裡建一次車流並跑 120 幀，20 秒硬性 timeout。同步無限迴圈無法在測試程序內中斷，所以用子程序＋`spawnSync({timeout})` 偵測掛機。
2. `tools/smoke-hk.mjs`：用**真的 three.js**（`npm install three@0.186.1 --no-save`）在 Node 裡把整個香港場景建一次並跑 180 幀，斷言樓宇數、三角形數、實例數、NaN 幾何、每幀成本。這是 agent 沒有瀏覽器時能做到的最強驗證。

實測報告（`node tools/smoke-hk.mjs`）：

```
phases: 海岸線與維港水面 0ms → 道路、行人道與標線 8ms → 沿街樓宇 51ms → 地標與街道家具 58ms
cityMs 64 · trafficMs 43 · frameMs 0.198
triangles 116,970 · meshes 282 · instanced 8 (2,665 instances) · lamps 610
buildings 1,349 · landmarks 25 (+冠頂 12) · cars 96 · lanes 99
player 出生於 (65, −201) → 中環
```

**第三輪（HUD 正常、車速在動，但 3D 畫面全黑）**

截圖證明模擬層完全正常（60 fps、22 km/h、「中環 Central · 干諾道中」），所以問題收窄到繪製層。兩個明確的錯：

| # | 原因 | 修法 |
|---|---|---|
| 6 | CSS 選擇器寫成 `body[data-world="hong-kong"]`，但 `applyBranding()` 實際寫入的是 `dataset.world = 'hk'` → **紐約那套 HUD 完全沒有被隱藏**（截圖右上角仍是 Golden Hour / Teleport / Map，右下角是空的 "NYC YELLOW TAXI"） | 選擇器全部改為 `body[data-world="hk"]` |
| 7 | 香港的 render graph 直接照抄紐約的 `pass()` + `createPostProcessing()`，但**沒有照抄它對 render target／MRT 的設定**。在 dev 分支的 three.js 上，`pass()` 的 output texture 可能因此是空的 → 整個畫面（連天空）都是黑 | 香港改成**自帶照明 + 直接 `renderer.render(scene, camera)`**：`js/hk/lighting.js`（半球光 + 可投影平行光 + 明確天空底色與霧）。紐約那套完整大氣天空改為 `?sky=1`、TSL 後處理管線改為 `?post=1`，兩者都用 try/catch 包住，失敗會自動退回直接繪製 |

**新增診斷面板**（按 `D` 開關，或 `?world=hk&debug=1`）：顯示 three 版本、backend（WebGPU/WebGL）、canvas 實際像素與 CSS 尺寸、**draw calls 與三角形數**、camera 位置、所在區、燈光數、目前繪製路徑。黑畫面時這幾個數字就能分辨「冇畫任何東西 / 畫了但全黑 / 後處理輸出黑」。

**注意**：`tools/smoke-hk.mjs` 驗證的是「建城、照明與模擬」，**不包括 WebGPU 繪製**（shader 編譯、管線、實際像素）。那一層仍然只有你在瀏覽器能驗；現在它會明確斷言 `lights >= 2` 與 `scene.background` 存在，避免「場景全黑但測試全綠」。

**仍未驗證（需要你在瀏覽器確認）**

- WebGPU 實際渲染：這個 sandbox 沒有 GPU、沒有瀏覽器，`?world=hk` 的畫面我沒有跑過。若仍失敗，載入畫面現在會直接顯示錯誤與停在哪一階段 —— 把那張圖貼回來即可。
- 效能：20.9 km 走廊 · 99 條車道 · 1,349 棟樓 · 593 支街燈 · 96 車；預期 60 fps 但未實測。

**第四輪（拉取上一個 commit 後，畫面直接停在全 NY 的 loading 畫面，永不進入香港）**

症狀與之前完全不同：標題仍是 **Slop New York**、狀態永遠停在 *Initializing WebGPURenderer & TSL Shaders...*。

| # | 原因 | 修法 |
|---|---|---|
| 8 | `js/hk/main.js` 在同一個 `try` 區塊宣告了**兩次** `const info`（一次是 `device.queue.onSubmittedWorkDone()` 的 promise，一次是 `renderer.info.render`）。這是 **early SyntaxError**，整個模組連評估都不會開始 | 第二個改名 `submitted`；第一個改名後語意更清楚 |
| 9 | `index.html` 用 `<script type="module" src="./js/main.js">` **無條件**載入紐約入口，再由它動態 `import('./hk/main.js')`。**紐約的 32 個模組（含 dev 分支 CDN 上的 addon）先行載入**，香港才有機會執行 | `index.html` 改成 inline bootstrap：先決定世界 → **一次只 import 那一個世界**。香港完全不經紐約的模組圖 |
| 10 | `await import()` 的 rejection **冇人接住** → 瀏覽器只會靜靜停在 loading 畫面，冇 stack、冇提示 | bootstrap 用 try/catch 接住，並用 **module 之前就註冊**的 `window.__slopBootFail()` 在畫面上顯示紅字（標題 + stack + 已完成階段）；另有 20 秒 watchdog 偵測「連模組都未載入」（多數是 CDN 拉不到 / 本機 server 沒開） |
| 11 | 品牌要等世界載入成功才換，所以模組一壞就顯示「Slop New York」——最誤導的狀態 | `applyBranding()` 提前到 import 之前執行。**即使香港載入失敗，畫面上也會寫住 Slop Hong Kong + 錯誤訊息** |
| 12 | `js/hk/main.js` 靜態 import 了 `../post-processing.js` 與 `three/tsl`（只有 `?post=1` 才用到）—— 多兩個 CDN 依賴才能開機 | 兩者都改成 `?post=1` 時才 `await import()`；`?sky=1` 的 `LightingSystem` 早已是動態載入 |

**為什麼 144 個測試全綠也抓不到？** 因為它們全部只 import 個別模組，**沒有任何測試 import 過 `js/hk/main.js`**。現在補了三層：

1. `tools/check-modules.mjs`（＋ `tests/hk-modules.test.mjs`）：把 `js/` 下每個檔案複製成暫存 `.mjs` 跑 `node --check`，抓 early error／重複宣告。實測把 `const info` 改回去 → 立即紅。
2. `tools/boot-hk.mjs`（＋ `tests/hk-boot.test.mjs`）：**真的跑一次開機**。用 jsdom 載入真正的 `index.html`（`?world=hk&debug=1`），照 bootstrap 的順序 `applyBranding → import js/hk/main.js → startHongKong()`，用真 three.js 建幾何，只把 `WebGPURenderer` 換成假的（`tools/hk-boot/shim-three-webgpu.mjs`，用 `module.register()` 的 loader hook 掛上）。斷言：overlay 已隱藏、`document.title === 'Slop Hong Kong'`、HUD 存在、`body[data-world=hk]`、位置標籤係中環、`renderer.render` 有被呼叫、場景有 ≥2 盞燈與 `scene.background`、診斷面板有內容、動畫迴圈跑得動、靠左行駛。
3. `boot.test.cjs` 改寫：唔准再出現無條件 `<script type="module" src="js/main.js">`，香港預載清單唔准包含紐約模組。

實測輸出（`node --import ./tools/hk-boot/register.mjs tools/boot-hk.mjs`）：

```
[hk] first frame { drawCalls: …, path: 'direct', sky: false }
[hk] 1349 buildings · 37 landmarks · 96 cars · 99 lanes (keep left)
__BOOT_REPORT__ {"world":"hk","title":"Slop Hong Kong","hud":"Slop Hong Kong ← New York",
                 "location":"中環 Central","frames":9,"compiled":169,"buildings":1349,"cars":96,…}
✓ 香港世界可以開機（DOM + 幾何 + 車流 + 繪製呼叫）
```

> 這個 harness 用**假的 renderer**，所以 `drawCalls` 係假數字；它證明的是「開機流程、DOM、幾何、車流、動畫迴圈全部行得通」，**不是** GPU 上的像素。

**現在如果仍然黑畫面**，最快的三步：

1. 開 `http://127.0.0.1:8082/?world=hk&debug=1`（**Ctrl+Shift+R** 強制重新載入，避免舊快取）。
2. 若載入畫面卡住 → 現在一定會顯示紅色錯誤卡（唔會再靜靜卡住）。把紅色那段貼回來。
3. 若入到場景但黑 → 睇診斷面板的 `draw calls`：`0` = 冇畫任何東西（culling／相機）；大數字 = 畫了但材質／燈光問題；`path` 應該顯示 `direct render`。

**第五輪（香港 HUD 正常、車速 42 km/h、位置正確，但 3D 畫面仍然全黑）**

這一輪的特徵很有價值：**模擬層、DOM 層、世界切換、品牌全部正常**（右下角顯示 `中環 Central · 干諾道中 Connaught Road Central`、`靠左行駛 KEEP LEFT`、60 fps）。`scene.background` 是 `#8fb2d8`（天空藍），所以「全黑」不可能只是材質太暗 —— 一定是**畫面完全沒有輸出到 canvas**，或者 **canvas 被蓋住**。

因為 sandbox 沒有 GPU／瀏覽器（Playwright 的 Chromium 下載被防火牆擋），我把「猜」變成「量度」，加了三個可以在你部機 10 秒內跑完的二分工具：

| 工具 | 用途 |
|---|---|
| 診斷面板（現時**預設開啟**） | `elementFromPoint` 報出**畫面中央最上層的元素**（如果唔係 canvas → 純 CSS 問題）；canvas 的 `isConnected`／`opacity`／`display`；後端名稱；`navigator.gpu` 與 adapter（分得出真假 GPU）；`uncapturederror`／`device.lost`；`scene.background` 色值 |
| `&test=1` | 鏡頭前放一個 `MeshBasicMaterial` 紅色方塊（唔受燈光、`depthTest:false`）＋ 1.5 秒後**離屏渲染一次並讀回中央像素**。見到紅方塊 = 管線通；讀回 `#8fb2d8` = 場景真係畫得出，問題只在 canvas 呈現 |
| `&webgl=1` | 強制 WebGL2 後端，一步排除 WebGPU 後端／裝置問題 |

另外補了：`resize` 時同步 canvas 與投影、把 WebGPU 的**靜默錯誤**（`uncapturederror` / `device.lost`）接住並顯示在面板（WebGPU 的 validation error 唔會 throw，畫面只會一直黑）。

這些診斷本身也有測試：`tools/boot-hk.mjs` 會用 `?world=hk&test=1` 再跑一次，斷言探針方塊存在、離屏讀回碼路徑真係執行過而唔會拋錯、面板包含 canvas／最上層元素／GPU 資訊。

**第六輪（畫面終於出嚟，但成個街景黑到似深夜）**

`?world=hk&test=1` 的截圖證明**管線完全正常**：中環街景、車道標線、兩旁樓宇、亮起的窗、紅色探針方塊全部出到嚟。之前那張全黑圖是預覽面板（565×635）的偶發情況 —— 同一個 build 在本機 8082 正常。

不過把截圖逐格量度之後（Pillow 取樣）發現一個**真問題**：

| 量度 | 數值 | 意思 |
|---|---|---|
| 全畫面亮度 < 16/255 的像素 | 8,044 / 12,800（63%） | 畫面嚴重偏暗 |
| 車道標線（反照率 0.9，受光） | (190, 178, 167) | 陽光**有**照到，而且偏暖 → 燈光系統正常 |
| 樓宇牆身 | (9–50) | 幾乎冇光 |
| 天空色 `#8fb2d8` 出現的像素 | 2 / 12,800 | 街道兩旁的樓太高，鏡頭見唔到天 |

結論：**問題唔在燈光，在於「冇環境光（IBL）」**。香港的玻璃帷幕用 `reflectivity: 0.9`（近乎鏡面），水面 `metalness 0.72`、樓冠 `metalness 0.8` —— 這些 PBR 材質**冇環境貼圖就一定是黑色**，只有窗的 emissive 亮。紐約之所以冇事，是因為它的 `LightingSystem` 建了 Preetham 天空 + PMREM IBL。

修法（`js/hk/lighting.js` 重寫）：

| 改動 | 內容 |
|---|---|
| **程序化 IBL** | 用一張 32×16 的 `DataTexture`（上＝天空頂、中＝地平線霧色、下＝地面反射色）經 `PMREMGenerator` 生成環境貼圖 → `scene.environment`。**零外部檔案、零 CDN 依賴**；失敗會自動退回「半球光 ×1.8」 |
| 更亮的 preset | golden：太陽 2.6→**3.4**、半球光 1.15→**1.5**、曝光 1.0→**1.15**、`environmentIntensity` 1.0；四個時段全部重調 |
| 新 URL 參數 | `&light=golden                                                                                                                                                                                                                                                                                                                         |midday|twilight|midnight`、`&shadow=0`（關陰影）、`&exposure=1.4` |
| 診斷面板 | 多一行 `light golden · shadow on · exposure 1.15 · env PMREM`（如果顯示「冇（原因）」就代表 IBL 失敗，玻璃會黑） |
| 移除 | 之前 `?test=1` 的離屏像素讀回（r187dev 的 `readRenderTargetPixelsAsync` 會拋 `invalid value used as weak map key`，冇用就唔好留住） |

`tools/boot-hk.mjs` 亦加了斷言：**PMREM 環境光必須建立成功**（失敗的話玻璃帷幕會全黑，而畫面其他部分仍然正常 —— 正是這一輪的症狀）。

**第七輪（畫面正常了，但街上「唔對路」：樓宇企喺馬路、無材質、巴士跳格、無人、撞車無反應）**

`?world=hk&test=1` 的截圖（`light golden · shadow on · exposure 1.15 · env PMREM`）證明照明同 IBL 都通了。跟住用家點名五個問題，全部有得喺 headless 驗，所以逐個做：

| 症狀（用家原話） | 真因 | 修法 |
|---|---|---|
| 「建築物無啦啦在條路中心」 | 25 個地標的座標直接來自 seed（真實經緯度），但我們的走廊是**加寬的近似線**：實測 8 個地標壓住行車道，最近的中心距只有 4.8 m | `config.js` 新增 `placeLandmarksOffRoad()`：用 box 的 support function 算淨空，有重疊就做**螺旋搜尋**（16 方向 × 4–200 m）找最近又「離開所有車道＋仍在陸地」的位置。8 個地標被搬 12–68 m，現在 **0 個壓路** |
| 「亦無材質」 | 地標是淨色 `BoxGeometry`（`civicMat` 一塊米色） | 地標改用同沿街樓宇一樣的 TSL 立面：塔樓 = 帷幕牆、civic／會堂 = 戰前石牆，窗是真實米數。25 個地標合併成 **2 個 facade mesh + 1 個冠**（原本 25+ 個 draw call 變成 3 個） |
| 「巴士打棋咁行」 | 車一到走廊盡頭就 `s = 0; lane = 隨機另一條` → **喺你眼前由一條街跳去另一條街** | 改為**只在自己條車道內繞回起點**；繞圈前先確認起點冇車（否則排隊等位） |
| （同上）跨車種互穿 | 私家車同巴士各自計 gap，互不相識 | 全部車（96 私家車 + 8 巴士 + 10 小巴）放入同一張 **per-lane 表**，按 s 排序，「下一架」就是前車 —— 巴士會跟私家車，私家車會跟巴士 |
| 「無人」 | 香港世界從來冇實作行人 | 新 `js/hk/pedestrians.js`：行人道由走廊推導（左右兩側、offset = 車道半寬 + 1.75 m），300 個行人 = **2 個 InstancedMesh**（身體＋頭），每人有自己顏色、速度、方向，行路有上下起伏 |
| 「撞車無反應」 | 玩家同車流完全冇互動 | 車流會把玩家當成「前方路障」收油；`traffic.collidePlayer()` 會在撞到時把紅的士推開並把速度 ×0.15 |

**順手加固：黑畫面自救**

- `renderFrame()` 每次先 `renderer.setRenderTarget(null)`，令「渲染到離屏 target 之後冇還原」（PMREM／自訂 pass 常見）這一類 bug 唔會令 canvas 永遠黑。
- 開機 2.5 秒後用 `createImageBitmap` 把 canvas 讀成 8×8 像素；如果**純黑**（且係 golden/midday、冇開 `?test=1`）：
  1. 先重新 `setSize` + 再 render 一次；
  2. 仍然黑就**自動用 WebGL2 後端重載一次**（`?webgl=1`，每個 session 只做一次，`?auto=0` 可關）；
  3. 都唔得就顯示紅色提示條，並在診斷面板標「讀到全黑！」。

**這一輪的新測試（156 pass / 0 fail）**

| 測試 | 驗甚麼 |
|---|---|
| `hk-streets.test.mjs` | 冇地標壓住行車道（support function 淨空 ≥ 0）、被搬的地標冇入海、行人道在自己那條街的車道以外、120 個行人跑 120 幀後 s 有限且在範圍內 |
| `hk-traffic.test.cjs`（加強） | 200 幀內 **0 架車換車道**（棋子跳的回歸測試）、同一車道最細間距 > 1.5 m（唔會疊車）、`collidePlayer` 真係推開 + 減速 |

**第八輪（「traffic.collidePlayer is not a function」——新舊模組混用）**

錯誤卡本身係新機制正常運作（開機失敗一定睇得見），但內容揭示一個更陰險的問題：

```
TypeError: traffic.collidePlayer is not a function
    at Animation_.animationLoop (js/hk/main.js:565)
```

`js/hk/main.js` 是新的（會呼叫 `collidePlayer`），但瀏覽器快取裡的 `js/hk/traffic.js` 是舊的（冇這個方法）。`python -m http.server` 只送 `Last-Modified`，Chrome 用**啟發式快取**（約檔案年齡的 10%）—— 即係 `git pull` 之後幾分鐘內，完全有可能係「新 main.js + 舊 traffic.js」。

三層修正：

| # | 修正 |
|---|---|
| 1 | **建置版本**：新增 `js/hk/build.js` 的 `BUILD`，`index.html` 用 `import(\`./js/hk/main.js?v=${HK_BUILD}\`)` 載入入口，強制入口重新抓取；診斷面板第一行顯示 `slop-hk <BUILD> · three r…`，一睇就知係唔係新舊混用。有測試保證 index.html 與 build.js 的版本一致 |
| 2 | **開機後的錯誤唔再蓋住整個世界**：以前任何一幀 throw 都會觸發全屏錯誤卡；現在 `bootDone` 之後改成「頂部紅色提示條 + console.error」，世界繼續行。只有真正開機失敗（第一幀之前）才用全屏卡 |
| 3 | **optional call**：`traffic.collidePlayer?.()`、`pedestrians.update?.()` —— 舊快取模組頂多令該功能暫時失效，唔會炸死成個世界。`tools/boot-hk.mjs` 會**故意刪掉** `collidePlayer` 再跑兩幀，斷言唔會觸發錯誤卡 |

> 這一個 bug 用家幫了大忙：錯誤卡上寫明 `js/hk/main.js:565`，所以一秒就分出「新模組叫舊模組的方法」。之前冇這個卡，只會見到黑畫面。

**第九輪（「見唔到 version」、「地圖在哪裡?」、「唔使由零開始」）**

三個願望一次過：

| 問題 | 原因 | 修正 |
|---|---|---|
| **見唔到版本** | 版本只寫在診斷面板第一行，而面板要按 `D`／`?debug=1` 才有 | 版本改成**三個一定見到的地方**：① 載入畫面 `版本 v2026-10-25.8`（`#loading-build`）② HUD 品牌列的琥珀色小徽章 `.hk-build` ③ 診斷面板第一行 `版本 v…`。`tools/boot-hk.mjs` 會斷言 HUD 徽章存在而且等於 `BUILD` |
| **冇地圖** | 紐約有 `nyc-map.js`，香港移植時漏了 | 新增 `js/hk/map.js`：用 `HK.LAND`／`HK.ROADS`／`HK.TRAM` 直接畫全港地圖（主幹道加粗、電車線虛線、即時車流小點、9 個白色傳送點、紅色玩家箭咀＋朝向）。**按 `M`** 或 HUD 右下 `地圖 [M]` 開關，**點地圖任何一點即傳送**（保留朝向、車速歸零、追尾鏡頭即時貼回）。地圖每 0.15 秒更新一次（`frameNow` 節流），唔會同主迴圈爭 CPU |
| **行人／車輛唔使由零做** | 香港版行人原本是兩粒膠囊 `InstancedMesh` | `createHongKongPedestrians()` 改成 async，**動態載入原有的 `js/pedestrians.js`**，直接用紐約的 `PersonCrowd` + `PersonRig`（GPU 蒙皮步態、2 個 LOD 網格 `PeopleNear`／`PeopleFar`），每人有獨立 `seed/scale/female/girth/hair/armSwing/stride`；300 人在行人道上以 1.05–1.6 m/s 行。動態 import 失敗就靜靜退回舊膠囊，唔會炸死開機。車輛本身一向就係重用 `js/actor-models.js` 的 `buildCarGeometry` / `buildCarProxyGeometry` / `createLoftedCarMaterial`（同一套 `LoftGeometry` 放樣、輪胎、鋁圈），只有雙層巴士／電車／小巴係香港專用形狀（紐約冇雙層巴士，所以無得直接搬） |

順手修好一個**假警報**：WebGPU 的 canvas 讀回在 present 之後永遠拿到黑色，所以監測器會誤報「全黑」並自動重新載入頁面（用戶明明見到畫面正常）。現在 `blackScreenWatchdog()` 只在 `?blackcheck=1` 時執行，而且**永遠唔會自動重新載入**；畫面中央的診斷文字亦已改為說明「讀回可能本來就係黑」。

> **這一輪的證據**（全套 **163 pass / 0 fail**，另加開機工具 21 項檢查）：
>
> | 測試 | 驗什麼 |
> |---|---|
> | `tests/hk-boot-graph.test.mjs`（4） | 全部模組的語法／early error、香港入口的依賴白名單（唔准靜態匯入紐約模組）、`index.html` 唔准靜態 `<script src>` 紐約入口、版本號三個位都在 |
> | `tests/hk-streets.test.mjs` 第 5 個 | 地圖投影 `toMap`↔`toWorld` 來回轉換、全部落在地圖之內、北朝上 |
> | `tests/hk-map.test.mjs` | 用 jsdom **真正建立地圖 DOM**、真正畫一次（>150 條 2D 指令、`arc`/`fillText`/`rotate` 都有用到）、**真正按下 canvas** 之後玩家傳送到正確座標、關閉後唔會重畫 |
> | `tools/boot-hk.mjs` 新增兩項 | 按 `M` 真係開關得到地圖；點地圖真係改到玩家座標，`teleportTo()` 可以還原 |

**第十輪（打橫行的巴士、唔似樣的地圖、要跟足實車的紅的）**

三件事，三種不同的根因：

| 你見到 | 根因 | 修正 |
|---|---|---|
| **巴士打橫行** | 車流的朝向約定是「車頭 = +Z」（`place()` 用 `rotation.y = heading`、`heading = atan2(dx, dz)`），但巴士／電車／小巴／小輪是用 `BoxGeometry(L, H, W)` 建的 —— 長度沿 **X**。整架車被轉了 90°，於是「打橫行」；車輪又排在 Z 上，所以飛到車身兩側 5 米外 | 四款車全部按 **+Z** 重建：車身、上下層窗帶、擋風玻璃、目的地牌、裙腳、電車圓頂與集電弓、小巴斜擋風玻璃、小輪雙頭斜台。車輪改成軸向 X（橫跨左右）＋**加咗輪圈**，前後軸按真實軸距放。`tests/hk-vehicles.test.mjs` 釘死「長邊一定沿 Z」「車輪唔可以飛出車身」 |
| **地圖唔掂** | 上一版用種子資料（3 個手繪多邊形、17 條折線）畫圖 —— 結果是兩團雲加幾條頭髮 | 換成**真實海岸線**：地政總署陸地邊界（`hk_terrestrial_2m.geojson`，經 aknopla/hk-terrestrial-geojson），RDP 簡化後投影到世界座標（玩樂範圍 ~12 m、其餘 ~150 m）。地圖現在畫：真實海岸線（**維港、中環填海、尖沙咀、紅磡灣的形狀都對得返**）＋ 1,331 個樓宇腳印 ＋ 按等級分粗細的道路（帶深色路肩）＋ 電車虛線 ＋ 天星航線 ＋ 9 個傳送點 ＋ 地區名 ＋ 指北針 ＋ 比例尺。3D 世界的地面板塊亦換成同一條海岸線 |
| **紅的要跟足實車** | 之前直接用紐約房車的 `BODY_SPECS.taxi`（圓潤、低頂、斜擋風玻璃） | 新增 `HK_TAXI_SPEC`：按 **豐田 Crown Comfort** 的真實尺吋重建 —— 4.69 × 1.70 × 1.50 m、軸距 2.69 m、**近乎垂直的 A/C 柱**、平頂、超橢圓四角（`lowerRound 4.6`／`upperRound 5.2`）、**上半身銀白／下半身紅**（`twoTone`）、**沙板鏡**（`fenderMirror`，全車最易認的特徵，同時取消車門鏡）、加大的車頂「的士」牌、鍍鉻泵把與水牌邊（新增 `CAR_PARTS.CHROME`） |

**在 sandbox 怎樣「用眼」驗證**（冇瀏覽器、冇 GPU）：

| 工具 | 做什麼 |
|---|---|
| `tools/render-model.mjs` | 自己寫的光柵化器（z-buffer、flat shading、按 `partId` 上色）把任何車／巴士模型畫成 PNG。`node --import ./tools/hk-boot/register.mjs tools/render-model.mjs taxi bus --views=iso,side,front,rear` |
| `tools/canvas2d.mjs` | 一個夠用的 Canvas 2D 光柵化器（路徑、虛線、旋轉、文字示意），塞進 jsdom 就可以把**真正的地圖**畫成 PNG |
| `tools/render-map.mjs` | 真的建立地圖 DOM、真的 `draw()`，輸出 `tools/out/map-<size>.png` |

> 這一輪靠 `tools/render-map.mjs` 抓到一個真 bug：我的光柵化器一開始 `fillRect` 完全畫唔出東西 —— 因為掃描線填充沒有把未封閉的多邊形補回封閉邊。這個 bug 只在**工具**裡，但正因為有這個工具，我才發現「土地填色」其實一直沒有發生，而地圖看起來「兩團雲」。**沒有這一步，我就只會盲改。**

**這一輪的證據**：`node --test tests/*.test.*` → **171 pass / 0 fail**；`tools/boot-hk.mjs` 21 項檢查全過（build `2026-10-25.9`，1,331 棟樓、25 個地標、96 架車、99 條車道、300 個行人）。

**第十一輪（紅的士的「靈魂」：真塗裝）**

上一輪只做對了「身形」——你講得對，一架顏色對、比例對的車仍然唔似香港的士。這一輪做的是**塗裝**，全部在 `createLoftedCarMaterial` 的 TSL 節點圖裡用 **object-space 座標** 畫，所以：
冇新增貼圖、冇新增 draw call、仍然係同一個 instanced 材質（96 架車一齊畫都唔會跌 fps）。

| 部位 | 相片裡的樣子 | 實作 |
|---|---|---|
| 鬼面罩 | 鍍鉻橫間 + 黑色圍邊 + 細細個綠色圓牌 | `roundedRect` 黑底 + `step(0.62, fract(y*78))` 鉻橫間 + 綠色 `TAXI 5 SEATS` 牌（白字用 `sin(x*…)` 條紋示意） |
| 頭燈 | 高身方燈，外側一小截琥珀轉向燈 | 黑燈框 → 清玻璃燈罩（`0xe9eef2`）→ 外側 `turnFront` 琥珀 |
| 尾燈 | 深紅燈罩 + 白色倒車燈 + 外側琥珀 | 先畫黑燈框，再畫**深紅** `0x7f121c` 燈罩，最上層才是白／琥珀——**順序錯就會被紅色蓋返**（這一輪踩過） |
| 車牌 | 前白後黃、黑字，**獨立一塊板** | 新增 `CAR_PARTS.PLATE`（partId 10）＋ `buildHkPlates()` 真的長出兩塊薄板幾何（0.312 × 0.098 m），顏色直接用 `n.z` 分前後。紐約的黃牌貼圖留在 `if (!isHK)` 分支 |
| 車門 | 黑色把手、白色車隊證（藍間） | 四隻鉻把手做成**真幾何**（`buildHkTrimParts`，離地 0.79 m、貼車身側面），車隊證用側面貼片畫 |
| 車頂 | 白底紅字「TAXI」燈箱 | 白底 + 紅色字帶 + 微自發光（`emissive`），紐約的車頂徽章用 `if (spec.sign && !isHK)` 排除 |
| 下半身 | 黑色橡膠泵把、鉻腰線、鉻沙板鏡 | `17191c` 泵把／裙腳、`chromeBelt` 腰線、`fenderMirror` 沙板鏡（香港的士最易認的特徵） |

**要點：我唔可以只在心裡想像個材質。** 真正嘅材質是 TSL 節點圖，Node 裡冇 GPU 跑唔到，所以加了：

- `tools/hk-taxi-livery.mjs` —— 把同一段塗裝規則用普通 JS 重寫一次（`paintHKT(p, n, partId, spec)`），**共用同一個 `HK_TAXI_SPEC`**，所以調這裡的數值就是調真材質的數值。
- `tools/render-model.mjs` —— 加**逐像素物件座標**（`oa/ob/oc`）、`partId`、以及 `nose` / `wheel` / `tail` 三個近鏡。靠這些近鏡抓到兩個真 bug：輪圈的輻條用了 `p.z` 而唔係 `|p.z| − wheelZ`（輪心跑到車中間，冇輻條），以及著色時把法線反轉向相機，令「後面」判斷失效（尾燈被畫成一圈空心紅框）。

**這一輪的證據**：`node --test tests/*.test.*` → **174 pass / 0 fail**；`tools/boot-hk.mjs` 21 項檢查全過（build `2026-10-25.10`，GPU 錯誤 0）。新增 `tests/hk-vehicles.test.mjs` 第 5–7 個測試，釘死：鬼面罩有鉻橫間、綠牌有綠底白字、頭燈玻璃與外側琥珀、尾燈深紅＋白倒車燈、前白後黃車牌（含黑字）、車頂銀白／側窗深色、燈箱白底紅字、`livery === 'hk-taxi'`、紐約徽章被排除、車牌是**真幾何**（前後各一塊、把手左右都有）。

> **仍然未被驗證的**：沙盒冇 GPU，所以我只可以證明「材質節點圖的數值對」同「軟件光柵化器畫出來似」。真機 WebGPU 的光照、反射、發光強度，要你在瀏覽器睇（`?world=hk&debug=1`，右上角版本應顯示 `2026-10-25.10`）。軟件渲染器亦畫唔出真文字，車牌／綠牌上的字只是條紋示意。

**第十二輪（車浮空／輪唔轉／燈唔着／冇 chok、隱形建築物、真實樓宇資料）**

你講的三件事，三種完全不同的根因：

| 你見到 | 根因 | 修正 |
|---|---|---|
| **架車離地、車輪不動、車燈不着、起動同停冇 chok** | 香港版的 `createPlayer()` 只是把**一個合併好的 mesh** 搬來搬去。原版紐約的 `createCarEntity()` 有五層：`chassisPivot`（彈簧-阻尼懸掛）、四條獨立可轉向車輪、車底 contact shadow、兩盞 SpotLight 頭燈、由 `material.userData.carState` 驅動的剎車燈。香港版全部冇 —— 所以架車「有影但冇反應」 | 按原版重寫 `js/hk/drive.js`：**① 懸掛樞軸**（pitch 起步後仰／剎車前傾、roll 過彎側傾、heave 浮沉，彈簧常數沿用紐約調過的 68 / 11.2）；**② 四條 `buildSteerableWheelGeo` 輪胎**，前輪跟方向盤轉、四輪按真實滾動距離自轉；**③ 車底軟影**（`createContactShadowMaterial`），車唔再看落浮空；**④ 兩盞頭燈 SpotLight**，香港的士日夜開燈（`spec.headlampsOn`，材質裡把 `nightHeadlamp` 由日夜曲線改成 constant 1）；**⑤ 剎車燈／指揮燈**經 `carState` uniform 亮起 |
| **隱形建築物阻住架車** | 樓宇碰撞用**軸對齊盒（AABB）**包住旋轉過的樓。香港的樓按街道路向轉 20–40°，AABB 會多出四隻角的「空氣」：30° 的 20×15 m 樓，包圍盒變成 24.8×23.3 m —— 每個角多 4–5 m 的隱形牆。實測：**全港車道 2 m 取樣 64,337 點，其中 1,710 點（2.7%）被這些空氣擋住** | `js/hk/city.js` 的碰撞體改為交出身兼 `rot / hw / hd`，`drive.js` 用**旋轉矩形（OBB）**推出。同一批取樣：**AABB 誤中 1,710 點 → OBB 0 點**。新測試 `tests/hk-drive.test.mjs` 把這件事釘死（同時保留 AABB 的對照數字，講明根因） |
| **用 3d.map.gov.hk 的建築物／道路** | 3D 視覺化地圖發佈的是 Cesium **3D Tiles（.b3dm）**，全港幾百 GB，而且我們只想要量體；但同一個政府來源（地政總署 CSDI「Building」圖層，`landsd_rcd_1637211194312_35158`）有 REST/GeoJSON 端點，帶 **真實輪廓 + TopHeight/BaseHeight** | 新增 `js/hk/csdi.js`：瀏覽器按玩樂範圍切 3×4 格查 CSDI（`f=geojson`、`resultOffset` 分頁、`maxAllowableOffset` 伺服器端簡化），每個輪廓取**最小外接旋轉矩形**→ 直接餵現有的盒式立面管線（x, z, w, d, h, rot）。另外：壓住行車道的真實樓會被剔走（`dropBuildingsOnRoad`），保證「見到的路一定開得通」；拉唔到就**自動退回種子樓宇**（`?geo=0` 可以手動關）。`?debug=1` 會寫明樓宇來源 |

**證據**：

- `node --test tests/*.test.*` → **184 pass / 0 fail**（新增 `tests/hk-drive.test.mjs` 3 個、`tests/hk-csdi.test.mjs` 7 個）。
- `tools/boot-hk.mjs` 21 項檢查全過，GPU 錯誤 0（build `2026-10-25.11`）。
- 「隱形牆」的量化對照（車道 2 m 取樣、玩家半徑 1.35 m）：**AABB 1,710 點受阻 / OBB 0 點**。
- `tests/fixtures/csdi-central.geojson` 是**真實政府資料**（2026-10-25 從 CSDI 查中環 114.1590,22.2820–114.1600,22.2830 取 3 棟），測試直接解析它：182 m / 85.2 m / 83.4 m 三棟樓，減 BaseHeight 3.7 m 之後高度 178.3 / 81.5 / 79.7 m。

> **仍然未被驗證的**：
> · 沙盒**出唔到互聯網**（只准 GitHub），所以我**不能**在沙盒裡真的打 CSDI 一次；CSDI 的 JSON 格式是用 `tests/fixtures/` 的真實樣本驗證的，但**瀏覽器跨域（CORS）能不能成功仍未驗證**。如果失敗，主控台會有 `[hk] 真實樓宇拉唔到…` 並自動用種子樓宇（即是你見到的一樣，不會爛）。你開 `?debug=1` 可以即時見到「樓宇來源：地政總署 CSDI…」定「種子樓宇…」。
> · 3D Tiles（.b3dm）我**沒有**用 —— 那是另一個格式，需要 Cesium 的解碼器，而且全港幾百 GB。
> · 物理手感（彈簧、車輪轉速、頭燈亮度）在軟件測試裡只能證明數值與方向正確，**真機觀感要你自己睇**。

**第十三輪（車速、四個視角包括車廂內、光線可以直接揀）**

| 你要求 | 之前 | 現在 |
|---|---|---|
| **車速再快 D** | 巡航 22 m/s（79 km/h），阻力 0.0032 令實際只去到 ~27 m/s；加速 7.5 | 巡航 **36 m/s（130 km/h）**、Shift **52 m/s（187 km/h）**；加速度 15、阻力 0.0008 —— 實測 8 秒踩到 **119 km/h**，4 秒 Shift 到 **155 km/h**（測試釘死下限） |
| **幾個視角揀，包括車廂內** | 只有一個追尾鏡頭 | `js/hk/drive.js` 新增 `CAMERA_MODES`：**追尾 / 近鏡 / 車頭冚 / 車廂內**。車廂內是**香港右軚司機位**（本地 x = −0.34、眼高 1.22 m），透過擋風玻璃睇路；車頭冚是引擎蓋前緣（z = 1.35）。`C` 鍵循環，HUD 右下角有按鈕直接揀（active 狀態會亮） |
| **光線有幾個揀架** | 只有 `G` 鍵循環四個預設，冇 UI，玩家唔知有得揀 | HUD 新增一條**光線選擇器**：黃昏 / 正午 / 入夜 / 午夜，可以直接點；`G` 仍然會循環。兩者走同一個 `applyLighting()`，街燈與夜間樓宇窗光會一齊切換 |
| **快 D 做返車頭燈** | 上一輪（`.11`）已經做咗：兩盞 SpotLight + 燈罩長亮 | 保留，並且在 boot 檢查裡釘死「玩家兩盞頭燈 intensity > 0」。你截圖顯示 **v2026-10-25.10**，係未拉到 `.11`／`.12` 的版本 |

**證據**：`node --test tests/*.test.*` → **187 pass / 0 fail**；`tools/boot-hk.mjs` **22 項**檢查全過（新增「視角／光線選擇器都在 HUD 上」），GPU 錯誤 0，build `2026-10-25.12`。

> 未驗證部分照舊：真機的觀感（車廂視角會唔會穿幫、鏡頭靈敏度）要你落場睇。車廂內視角我們**沒有**建模內裝（錶板／方向盤），所以會是「從司機位望向車頭」的第一人稱 —— 如果你想要真錶板，我下一步可以加。

### 15.1 先講結論

**這不是「換字串」的工作。**（下面這些是動手前的量測，之後 Phase 0/1/3 已經落地，見 15.0。）我實際掃過耦合度（每檔出現 `streetZ|avenueX|CENTRAL_PARK|BROADWAY|MANHATTAN|NYC_` 的次數）：

| 耦合熱度 | 檔案 |
|---|---|
| 極高 | `city-config.js` 46 · `city-grid.js` 24 · `buildings.js` 21 |
| 高 | `tsl-materials.js` 16 · `boroughs.js` 14 · `nyc-map.js` 12 |
| 中 | `street-details.js` 7 · `main.js` 5 · `controllers.js` 5 |
| 低／零 | `road-network.js` 2 · `landmarks.js` 2 · `audio-system.js` 2 · 其餘 18 個模組 **0** |

好消息：**渲染、音訊、蒙皮、地圖繪製、碰撞、輸入這 18 個模組完全與城市無關**，可以直接重用。真正要動的是「世界觀層」（config + 生成器 + 交通規則）。

### 15.2 五個硬耦合

1. **網格假設**：`streetZ(n)`（第 n 街的 z）、`avenueX(id)`、`ALL_STREETS`、`AVENUES`、`STREETS` 這些 API 被建築、街道家具、控制器大量呼叫。香港**沒有編號街道網格**，必須把這層換成「道路樁號（chainage）+ 走廊（corridor）」抽象。
2. **舊 superblock 遺留**：`STREETS`（9 條 Midtown 橫街）、`AVENUES`（7 條核心大道：8/7/6/5th、Park、Lexington、3rd）、`getBlockBounds(col, row)` 是更早期的「每 110×90 單位一個超級街廓」模型，現在仍被 `landmarks.js` 前 10 個地標與 `street-details.js` 的號誌/樹使用，與真實 `BLOCKS` 並存。移植前要先把它們收斂成一層，否則香港會同時有兩套世界觀。
3. **都市形態**：香港是沿海、依山、填海、貼線高密度；沒有 1916 分區退縮、沒有 alley、大量平台商場、行人天橋/隧道、電車軌、山坡擋土牆。`buildings.js` 的「wedding cake」生成器在 HK 會長出很奇怪的東西。
4. **行車方向**：香港**靠左行駛（右軚車）**，現行程式是靠右行駛。`road-network.js` 明寫「車道是中心線向右的偏移」、`traffic.js` 的左轉讓路、行人過路先望哪邊、單車徑位置——這是**全域語意**改動，測試也要跟著鏡像。
5. **內容素材**：黃的士、MTA 巴士、防火梯、Con Ed 蒸汽、USPS 郵筒、NY 車牌、綠底白字街牌、Inter/Overpass 字體——全部 NYC 專屬。

### 15.3 資料來源對照

| 用途 | 紐約（現用） | 香港（替代） |
|---|---|---|
| 行政區界 | NYC DCP Borough Boundaries | 地政總署 18 區界 / OSM `admin_level=6` |
| 道路中心線 | NYC CSCL（含 curb-to-curb 寬、車道數、單雙向） | 地政總署／運輸署道路中心線；或 OSM `highway=*` + `lanes`、`oneway` |
| 公園 | NYC Parks Properties | 康文署公園/花園列表；OSM `leisure=park`、`garden` |
| 海岸線／填海 | OSM coastline（`osm_coastline.json`） | OSM coastline（維港兩岸、離島）**＋ 逐年填海要選定年份** |
| 地標 footprint | OSM `osm_landmarks.json` | OSM `building` + `height`/`building:levels`；ICC、IFC、中銀、匯豐、會展、中環廣場、K11、M+ |
| 地形 | 無（只有 Palisades hack） | **新增 DEM**（5 m DTM / OSM `ele`）→ 這是新功能，不是替換 |
| 天橋／隧道 | 無 | OSM `bridge`/`tunnel`/`layer` → 多層世界（現時引擎是單層平面） |
| 電車／港鐵 | 無 | OSM `railway=tram`（香港電車）、`railway=subway`（只做視覺入口） |

### 15.4 分階段施工計畫

| Phase | 內容 | 主要檔案 | 估時（單人 full-time） |
|---|---|---|---|
| **0** 世界可切換 | 引入 `js/world/`（`WORLD_ID`、`new-york.js` / `hong-kong.js`）；UI 字串集中；品牌與 README | `main.js`、`city-config.js`、`index.html` | 0.5 天 |
| **1** 資料管線 | `tools/hk-*.mjs` 六階段對應；輸出 `js/hk-geodata.js`（沿用 GEO v1，新增 `relief`、`footbridges`、`tram`、`buildingHeights`）；`overpass.sh` 重用 | `tools/` | 3–5 天（最大風險） |
| **2** config 一般化 | 把 `streetZ/avenueX` 換成 `nearestCorridor(x,z)` / `chainageAt()`；`districtAt` 改為地理圍欄表（中環/金鐘/灣仔/銅鑼灣/尖沙咀/旺角/深水埗…）；`SIGNAL_TIMING` 改成 HK 慣例（黃燈後全紅緩衝） | `city-config.js`、`city-grid.js` | 3–4 天 |
| **3** 生成器適配 | 貼線高層、平台商場、霓虹招牌（emissive TSL）、竹棚、紙皮石外牆、玻璃幕牆；天橋層與欄杆；雙語街牌（中文＋英文，字體換 Noto Sans HK）；電車軌與電車站 | `buildings.js`、`city-grid.js`、`street-details.js`、`tsl-materials.js` | 4–6 天 |
| **4** 靠左行駛＋車種 | 車道法線鏡像、讓路/轉向邏輯、行人先望右；新增紅的士、雙層巴士、小巴、電車、貨車（`actor-models.js`）；巴士站排隊 | `road-network.js`、`traffic.js`、`actor-models.js`、`controllers.js` | 3–4 天 |
| **5** 地形與海港 | DEM 高度場接入 `getGroundHeight`、建築落地、擋土牆；天星小輪、山頂纜車；維港兩岸地標 | `controllers.js`、`boroughs.js`、`landmarks.js` | 2–3 天 |
| **6** 打磨 | 廣東話環境聲、電車「叮叮」、紅綠燈「嘟嘟」；地圖加港鐵路網；攝影機預設（山頂、維港、彌敦道、中環街市） | `audio-*`、`nyc-map.js`、`cameras.js` | 持續 |

**總計約 3–4 週**（不含自訂 3D 美術資產與資料授權流程）。

### 15.5 主要風險

| 風險 | 說明 | 對策 |
|---|---|---|
| 資料授權 | 地政總署／運輸署資料有使用條款；OSM 是 ODbL（衍生資料要標註） | 先只用 OSM + 政府公開資料，逐項確認條款；README 保留出處 |
| 非網格路網 | `road-network.js` 的「走廊 + 缺口」推導假設正交街道 | 在 HK 改用 `GEO.rograph`（已有 4,288 節點圖）為主、走廊為輔；先做中環—尖沙咀一段驗證 |
| 靠左行駛連鎖 | 一處鏡像沒改就會出現「對頭車」 | 先加單元測試（車道側向、讓路優先權），再改實作 |
| draw call 爆炸 | 香港更密、霓虹更多、招牌更大 | 沿用 `scene-culling.js`；霓虹走 emissive 貼圖而非獨立燈；招牌合批 |
| 天橋多層 | 現引擎是單層平面（`blockAt` 只有一層） | 新增 `layer` 概念；先做「天橋只做視覺 + 不阻擋地面」的簡化版 |
| three.js `@dev` | 上游 API 隨時變 | 立刻釘 commit，必要時改自架 mirror |

### 15.6 驗收標準（Definition of Done，Phase 1–4）

- [x] `node --test "tests/*.test.cjs" "tests/*.test.mjs"` 全綠，且新增兩個香港測試檔（GEO schema、靠左行駛、雙語標籤）。
- [x] 至少 3 條走廊（干諾道中、彌敦道、軒尼詩道）能由資料生成路面、緣石、行人道、標線、AI 車流。
- [x] 至少 3 個地標（IFC、中銀、尖沙咀鐘樓）站在真實 footprint 上。
- [x] 車輛全部靠左（`tests/hk-world.test.cjs` 逐點驗證）；行人過路燈與號誌相位一致（行人系統尚未接入）。
- [ ] 1080p、中階獨顯 ≥ 50 fps；首屏（含 shader 編譯）< 8 s。**（未驗證：sandbox 無 GPU）**
- [x] README 與資料來源、授權、已知限制同步更新。

### 15.7 想自己動手的話

```bash
git switch -c feat/hk-phase1-geodata
# 1) 把香港 OSM 抓下來
bash tools/overpass.sh tools/data/hk_coastline.json tools/data/q_hk_coast.overpassql
# 2) 複製 tools/build-geodata.mjs → tools/build-hk-geodata.mjs，改輸出 js/hk-geodata.js
# 3) 先只求「跑得完、schema 對」，不要一開始就追求漂亮
```

---

## 16. 關於「UE5 / Blender / PhysX / 百萬行」的技術澄清

你提到的技術堆疊與這個 repo 的實況有落差，講清楚才不會規劃錯：

| 你提到的 | 這個 repo 的實況 |
|---|---|
| Three.js | ✅ 是核心，但用的是 **three.js `dev` 分支的 `three.webgpu.js`**，不是傳統 WebGLRenderer |
| WebGPURender | ✅ 是核心，並且大量使用 **TSL 節點材質**（28 個材質工廠、3,040 行） |
| Unreal Engine 5 | ❌ 完全沒有。這是純瀏覽器專案，沒有任何 UE 資產或 `.uproject` |
| Blender 特效 | ❌ 沒有任何 `.blend`/`.glb`/`.fbx`；所有幾何（車、樹、行人、建築）都是**程序化生成**。要引入 Blender 資產得先建 glTF 管線 |
| Physical AI／撞擊力計算 | ⚠️ 有碰撞，但是**運動學解算**：AABB/OBB 分軸推出 + SAT 接觸 + 衝量 + 火花粒子。沒有剛體動力學引擎、沒有 PhysX/Havok、沒有布料/破壞模擬 |
| 3D 立體地圖 | ✅ 有，而且是雙套：GTA 風雷達 + 全螢幕 1:1 街道圖（2D canvas，資料驅動） |
| 100 萬行 | ❌ 實際 36,953 行 / 70 檔；但含 1.13 MB 生成資料與高密度 TSL，閱讀量不小 |

> 所以「雪地裸求 GPT/Claude 出山」其實不必：**這套程式的難點不在寫新演算法，而在把一套高度耦合於曼哈頓網格的世界觀，乾淨地拆成可換城市的外掛層**。第 15 章的路線圖就是為此設計的。

---

## 17. 附錄：關鍵參數速查

```
世界      1 unit = 1 m · bearing 29.02° · origin 5th Ave & 42nd St
          water y = -2.2 · sidewalk +0.22 · cutZ = -7090 · strip 20 m · sidewalk 4.6 m
相機      near 0.35 · far 60000 · fog(golden) 0.00024
渲染      reversedDepthBuffer · pixelRatio 1.0 · MSAA color memoryless
          MRT: output / normalView / metalRough(roughness<0.75, fade 180–360 m)
          SSR: 0.5 res · maxDist 42 · thickness 0.85 · quality 0.25 + binaryRefine · intensity 0.5
          燈光: ClusteredLighting(256, 32, 28, 48) · SunLight 2-cascade CSM
剔除      SHADOW_PROXY_LAYER 3 · CULL_PER_METRE 1100 · CULL_MIN 300 · CULL_MAX 2000
          PROXY_CELL 500 · STATIC_CELL 1000
號誌      cycle 60 s · avenue 0–26 綠 / 26–30 黃 / 30–60 紅 · street 30–56 綠 / 56–60 黃 · walk 7 s
交通      IDM car {2.0, 3.0, 1.2, 2.0, 3.5} · bus {1.1, 2.5, 1.5, 2.5, 2.0} · LOOKAHEAD 70 m
          VEHICLE_RADIUS 380 · NEAR_RADIUS 350 · SPAWN 250 · CROSSWALK 2.5 m
行人      NUM_PEDS 340 · PED_RADIUS 320 · SPAWN 150 · AVOID 0.12 s · 步速 1.22–1.6 m/s
載具      car 23.5/36/10.5 · bike 12.8/19/4.5 · heli 上限 380 m · HUD 滿刻 18/81/43/116 mph
音訊      引擎 180 m · 警笛 220 m · 人聲 45 m · 號誌 35 m · panner maxDist 500 · rolloff 1.15
地圖      RADAR 0.32 px/m · zoom 0.015–3.0 px/m · 網格北朝上
預算      shader 預編譯 16 併發 · 防火梯 2400（近 256 / 30 m）· 存檔每 5 s
```

---

## 18. 授權與資料來源

- 程式碼：[MIT License](LICENSE)。
- 地理資料（現時）：NYC Open Data（DCP Borough Boundaries、Street Centerline、Parks Properties）與 © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)（ODbL）。
- 原始專案：[mrdoob/slop-newyork](https://github.com/mrdoob/slop-newyork)。
- 移植香港時，**必須逐項確認新資料來源的授權**並在本節更新：地政總署／運輸署開放資料、OSM（ODbL，衍生資料需相同授權並署名）、字體（Inter、Overpass、Noto Sans HK 各自的 OFL）。

---

**最後更新**：本 README 由 Arena.ai agent 在完整閱讀 70 個檔案（36,953 行）後重寫。第 1–14、16–18 章描述現有程式碼；第 15 章是尚未動工的移植藍圖。
