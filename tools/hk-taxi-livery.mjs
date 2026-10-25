// tools/hk-taxi-livery.mjs
// 香港紅的士塗裝的「CPU 版」：把 createLoftedCarMaterial 內 hk-taxi 那一段的規則，
// 用普通 JS 重寫一次，好讓 tools/render-model.mjs 可以在 sandbox 裡真的畫出嚟睇。
//
// 為什麼要重寫：真正的塗裝是 TSL 節點圖，在 Node 裡冇 GPU 跑唔到；而「紅的士是遊戲的靈魂」，
// 唔可以盲改。這個檔案只覆蓋「遠處都睇得出」的特徵：雙色車身、鍍鉻鬼面罩、綠色 TAXI 牌、
// 白前牌／黃後牌、車門車隊證、車頂白底紅字燈箱、頭尾燈、鉻腰線。
// 佢同 actor-models.js 用同一個 spec 數字，所以調這裡的數值 = 調真材質的數值。

const PART = { BODY: 0, WINDOW: 1, TYRE: 2, ALLOY: 3, TRIM: 4, MIRROR: 5, SIGN: 6, FRONT: 7, REAR: 8, CHROME: 9, PLATE: 10 };

const COLORS = {
  paint: [181, 18, 27],
  twoTone: [223, 228, 230],
  glass: [22, 32, 40],
  seal: [17, 19, 21],
  chrome: [206, 213, 218],
  chromeDark: [150, 158, 164],
  rubber: [23, 25, 28],
  lampLens: [233, 238, 242],
  indicator: [201, 128, 43],
  tailRed: [128, 18, 28],
  plateWhite: [244, 246, 246],
  plateYellow: [240, 196, 25],
  ink: [20, 24, 28],
  badgeGreen: [13, 148, 80],
  cardWhite: [233, 242, 240],
  cardBlue: [47, 111, 156],
  signWhite: [247, 243, 230],
  signRed: [200, 20, 28],
  tyre: [22, 24, 27],
  alloy: [196, 201, 206],
  mirrorGlass: [124, 138, 148]
};

const inRect = (u, v, hw, hh) => Math.abs(u) <= hw && Math.abs(v) <= hh;
const mix3 = (a, b, t) => (t <= 0 ? a : t >= 1 ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
// 用正弦條紋示意「字」：門檻越高 = 字越疏（車牌要大部分係白底）
const glyphs = (u, pitch, threshold = 0.55) => (Math.sin(u * pitch) > threshold ? 1 : 0);

/**
 * @param {{x:number,y:number,z:number}} p 物件座標（車頭 +Z）
 * @param {{x:number,y:number,z:number}} n 法線
 * @param {number} partId
 * @param {object} spec HK_TAXI_SPEC
 * @returns {[number,number,number]}
 */
export function paintHKT(p, n, partId, spec = {}) {
  const id = Math.round(partId);
  const zFront = spec.zFront ?? 2.34;
  const zRear = spec.zRear ?? -2.34;
  const cab = spec.cabin ?? {};
  const [hlX, hlY, hlW, hlH] = spec.headlight ?? [0.56, 0.63, 0.235, 0.072];
  const [tlX, tlY, tlW, tlH] = spec.taillight ?? [0.57, 0.82, 0.245, 0.055];
  const [grY, grW, grH] = spec.grille ?? [0.635, 0.3, 0.055];
  const [inY, inW, inH] = spec.intake ?? [0.37, 0.42, 0.042];
  const [plateF, plateR] = spec.plates ?? [0.46, 0.6];
  const badgeX = spec.hk?.badgeX ?? 0.155;
  const twoTone = (() => {
    const v = spec.twoTone ?? 0xdfe4e6;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  })();

  const ax = Math.abs(p.x);
  const side = Math.abs(n.x) > 0.42;
  const isFront = n.z > 0.3 && p.z > zFront - 0.6;
  const isRear = n.z < -0.3 && p.z < zRear + 0.6;
  const isUp = n.y > 0.6;
  const isDown = n.y < -0.4;

  if (id === PART.TYRE) return COLORS.tyre;
  if (id === PART.ALLOY) {
    // 五幅輪圈 + 鉻輪圈環 + 中央蓋（同 TSL 材質同一套規則）。
    // 角度用 atan2(dy, dz)：呢個係「正對鏡頭看到的輪面」，所以只有 5 條輻條，唔會出現 10 條。
    const R = spec.wheelRadius ?? 0.315;
    const rim = R * 0.64;
    const dy = p.y - R;
    // 輪圈的中心在「前軸或後軸」上，所以先減去軸距位置（同 TSL 材質的 abs(p.z).sub(axleZ) 一樣）
    const dz = Math.abs(p.z) - (spec.wheelZ ?? 1.34);
    const r = Math.hypot(dz, dy);
    if (r > rim * 1.04) return [11, 14, 18]; // 輪圈外緣的黑影
    if (r > rim * 0.84) return COLORS.chrome; // 鉻輪圈環
    if (r < 0.048) return COLORS.chrome; // 中央蓋
    const ang = Math.atan2(dy, dz);
    const spoke = Math.abs(Math.cos(ang * 2.5)); // 5 條輻條
    return spoke > 0.35 ? COLORS.alloy : [12, 15, 19];
  }
  if (id === PART.TRIM) return COLORS.rubber;
  if (id === PART.CHROME) return COLORS.chrome;
  if (id === PART.MIRROR) return COLORS.mirrorGlass;
  if (id === PART.SIGN) {
    // 車頂「TAXI」燈箱：白底、紅色粗體字（用正弦條紋示意字距，遠看就係一條紅字帶）
    const bandY = Math.abs(p.y - ((spec.cabin?.roofY?.[0]?.[1] ?? 1.478) + 0.115));
    if (bandY > 0.055) return COLORS.signWhite;
    return Math.sin(p.x * 42 + 0.6) > -0.35 ? COLORS.signRed : COLORS.signWhite;
  }
  if (id === PART.PLATE) {
    // 獨立車牌薄板：前白後黃、黑色字，四邊留黑框
    const [plateF, plateR] = spec.plates ?? [0.46, 0.6];
    const front = n.z >= 0;
    const yc = front ? plateF : plateR;
    if (Math.abs(p.x) > 0.147 || Math.abs(p.y - yc) > 0.04) return COLORS.ink;
    const base = front ? COLORS.plateWhite : COLORS.plateYellow;
    if (Math.abs(p.y - yc) < 0.022 && glyphs(p.x, 105, 0.58)) return COLORS.ink;
    return base;
  }
  if (id === PART.FRONT) return COLORS.lampLens;
  if (id === PART.REAR) return COLORS.tailRed;

  if (id === PART.WINDOW) {
    // 玻璃艙 = 銀白車頂／A、C 柱 + 深色玻璃 + 黑色窗框。判別方式同 TSL 材質一樣，
    // 用物件座標的多邊形區域，唔係用「朝上就係車頂」這種粗糙規則（之前後擋玻璃被畫成白色）。
    const cowl = cab.cowl ?? 0.96;
    const roofFront = cab.roofFront ?? 0.6;
    const roofRear = cab.roofRear ?? -1.4;
    const deck = cab.deck ?? -1.86;
    const railY = (cab.roofY?.[0]?.[1] ?? 1.478) - ((cab.roofEdge ?? 0.022) + (cab.roofCrown ?? 0.008));
    const pillarZ = cab.pillars?.[0] ?? -0.3;

    if (p.z > roofFront) {
      // 擋風玻璃區（cowl → roofFront）
      const frame = p.z > cowl - 0.045;
      return frame ? COLORS.seal : COLORS.glass;
    }
    if (p.z < roofRear) {
      // 後擋玻璃區（roofRear → deck）
      const frame = p.z < deck + 0.05;
      return frame ? COLORS.seal : COLORS.glass;
    }
    // 車頂區（roofRear → roofFront）
    if (isUp || n.y > 0.35) return mix3(twoTone, [205, 210, 213], 0.12); // 車頂銀白
    if (!side) return COLORS.seal;
    // 側窗：玻璃上下留 6 cm 白色邊（車頂邊緣），B/C 柱黑色
    const topFrame = p.y > railY - 0.055;
    const beltFrame = p.y < 0.955;
    if (topFrame) return twoTone;
    if (Math.abs(p.z - pillarZ) < 0.05) return COLORS.seal;
    if (beltFrame) return Math.abs(p.y - 0.928) < 0.012 ? COLORS.chrome : COLORS.seal;
    return COLORS.glass;
  }

  // --- BODY ---
  if (isDown) return [14, 16, 19];
  let c = COLORS.paint;

  if (isFront) {
    // 鬼面罩 + 綠色 TAXI 牌 + 鉻橫間
    if (inRect(p.x, p.y - grY, grW, grH)) {
      const inner = inRect(p.x, p.y - grY, grW - 0.016, grH - 0.012);
      if (!inner) c = COLORS.chromeDark;
      else if (inRect(p.x + badgeX, p.y - (grY - 0.004), 0.06, 0.034)) {
        c = glyphs(p.y, 150) && Math.abs(p.x + badgeX) < 0.048 ? COLORS.plateWhite : COLORS.badgeGreen;
      } else c = Math.sin(p.y * 78) > 0.62 ? COLORS.chrome : [24, 27, 30];
    }
    if (inRect(p.x, p.y - inY, inW, inH)) c = [21, 24, 26];
    // 頭燈：黑框 → 清玻璃燈罩 → 外側琥珀轉向燈
    if (inRect(ax - hlX, p.y - hlY, hlW + 0.018, hlH + 0.016)) {
      if (!inRect(ax - hlX, p.y - hlY, hlW, hlH)) c = [18, 20, 22];
      else c = ax > hlX + hlW * 0.62 ? COLORS.indicator : COLORS.lampLens;
    }
    // 白前牌
      if (inRect(p.x, p.y - plateF, 0.16, 0.058)) {
      c = glyphs(p.x, 105) && inRect(p.x, p.y - plateF, 0.135, 0.022) ? COLORS.ink : COLORS.plateWhite;
    }
  }

  if (isRear) {
    if (inRect(ax - tlX, p.y - tlY, tlW + 0.014, tlH + 0.012)) {
      if (!inRect(ax - tlX, p.y - tlY, tlW, tlH)) c = [18, 20, 22]; // 黑色燈框
      else if (ax > tlX + tlW * 0.52) c = COLORS.indicator; // 外側琥珀轉向燈
      else if (ax < tlX - tlW * 0.55) c = [232, 236, 238]; // 內側白色倒車燈
      else c = [150, 20, 26]; // 深紅燈罩（比車身漆深，遠看有邊界）
    }
    if (inRect(p.x, p.y - plateR, 0.16, 0.062)) {
      c = glyphs(p.x, 105) && inRect(p.x, p.y - plateR, 0.14, 0.024) ? COLORS.ink : COLORS.plateYellow;
    }
    const stripY = tlY + tlH + 0.035;
    if (Math.abs(p.y - stripY) < 0.006 && ax < tlX + tlW + 0.03 && p.y > stripY - 0.004) c = COLORS.chromeDark;
  }

  if (side) {
    // 車門車隊證（白底藍字）
    const doorMid = ((spec.doors?.[0] ?? 0.92) + (spec.doors?.[1] ?? -0.34)) / 2 - 0.12;
    if (inRect(p.z - doorMid, p.y - 0.66, 0.115, 0.045)) {
      c = Math.sin(p.z * 52) > 0.1 ? COLORS.cardBlue : COLORS.cardWhite;
    }
    // 腰線鉻條（車身與玻璃之間）
    if (Math.abs(p.y - 0.925) < 0.009) c = COLORS.chrome;
    // 沙板鏡底座附近保持紅色
  }

  return c;
}

export const HK_PART = PART;
