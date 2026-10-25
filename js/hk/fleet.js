// js/hk/fleet.js
// 車隊分配：把 N 架車按比例分給幾種車型，**總和必須等於 N**。
//
// 這裡抽出來的原因很實際：原本在 traffic.js 內用 Math.round(share * N) 算容量，四種車型加起來是 95，
// 但迴圈要放 96 架車，最後一架「所有車隊都滿」→ while 迴圈永遠跳唔出，主執行緒鎖死（Page Unresponsive）。
// 用最大餘數法（largest remainder）就唔會出現呢種落差，而且可以單元測試。

/**
 * @param {number[]} shares 各車型的比例（任意正數，不必加起來等於 1）
 * @param {number} total 要分配的總數
 * @returns {number[]} 每個車型分到的數量，總和 === total
 */
export function allocateFleet(shares, total) {
  const n = Math.max(0, Math.floor(total));
  if (!shares.length || n === 0) return shares.map(() => 0);
  const sum = shares.reduce((a, b) => a + Math.max(0, b), 0);
  if (!(sum > 0)) return shares.map((_, i) => (i === 0 ? n : 0));

  const exact = shares.map((s) => (Math.max(0, s) / sum) * n);
  const base = exact.map(Math.floor);
  let left = n - base.reduce((a, b) => a + b, 0);
  // 餘數最大的先補（同餘數時按原順序，保持結果穩定可測）
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length) {
    base[order[k].i]++;
    left--;
  }
  return base;
}
