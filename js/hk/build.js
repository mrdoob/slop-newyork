// js/hk/build.js
// 香港世界的建置版本。
//
// 為什麼需要它：`python -m http.server` 只送 Last-Modified，Chrome 會用「啟發式快取」
// （約 10% 檔案年齡）—— 即係你 git pull 之後，**新的 main.js 有機會配舊的 traffic.js**。
// 真實發生過：main.js 呼叫 traffic.collidePlayer()，但快取中的舊 traffic.js 冇這個方法，
// 於是第一幀就 throw，整個畫面被錯誤卡蓋住。
//
// ① index.html 用 `?v=<BUILD>` 載入入口模組（入口強制更新）；
// ② 診斷面板顯示版本，一眼看出係唔係新舊混用；
// ③ main.js 對所有「可能未存在」的方法用 optional call（見下），舊模組頂多冇功能，唔會炸死世界。
export const BUILD = '2026-10-25.10';
