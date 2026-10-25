// tools/hk/seed-hk.mjs — hand-curated seed geography for Hong Kong, in real WGS84 degrees.
//
// WHY A SEED: this sandbox has no route to the Overpass API, so the first Hong Kong build cannot download OSM.
// The seed is therefore a *small, honest, coordinate-true* core — the corridor from Sheung Wan through Central,
// Admiralty, Wan Chai and Causeway Bay on the island, and West Kowloon / Tsim Sha Tsui / Jordan / Yau Ma Tei /
// Mong Kok across the harbour — with real road centrelines, real landmark positions and real landmark heights
// (approximate to ~50 m, which is coarser than the frame's ~1 m projection error).
//
// REPLACING THE SEED: drop real Overpass JSON into tools/data/hk/ (see tools/data/q_hk_*.overpassql) and the same
// builder will read it instead of this file. Nothing downstream of `js/hk-geodata.js` needs to change.

// zh = 中文名, en = English name, cls = road class, w = curb-to-curb width (m), lanes = travel lanes each way,
// oneway = true when the corridor only runs in the polyline's direction.
export const ROADS = [
  {
    zh: '干諾道中', en: 'Connaught Road Central', cls: 'trunk', w: 24, lanes: 4, oneway: false,
    pts: [[114.1508, 22.2876], [114.1535, 22.2862], [114.1563, 22.2848], [114.1590, 22.2836], [114.1618, 22.2824],
      [114.1648, 22.2811], [114.1678, 22.2801]]
  },
  {
    zh: '德輔道中', en: 'Des Voeux Road Central', cls: 'trunk', w: 20, lanes: 3, oneway: true,
    pts: [[114.1512, 22.2866], [114.1539, 22.2853], [114.1566, 22.2840], [114.1592, 22.2829], [114.1620, 22.2818]]
  },
  {
    zh: '皇后大道中', en: "Queen's Road Central", cls: 'primary', w: 16, lanes: 2, oneway: false,
    pts: [[114.1516, 22.2856], [114.1542, 22.2843], [114.1570, 22.2830], [114.1596, 22.2819], [114.1624, 22.2808]]
  },
  {
    zh: '金鐘道', en: 'Queensway', cls: 'trunk', w: 22, lanes: 3, oneway: false,
    pts: [[114.1620, 22.2809], [114.1646, 22.2800], [114.1670, 22.2796]]
  },
  {
    zh: '軒尼詩道', en: 'Hennessy Road', cls: 'trunk', w: 20, lanes: 3, oneway: false,
    pts: [[114.1670, 22.2796], [114.1700, 22.2794], [114.1730, 22.2791], [114.1762, 22.2789], [114.1792, 22.2790]]
  },
  {
    zh: '怡和街', en: 'Yee Wo Street', cls: 'primary', w: 18, lanes: 3, oneway: false,
    pts: [[114.1792, 22.2790], [114.1822, 22.2795], [114.1852, 22.2802], [114.1882, 22.2812]]
  },
  {
    zh: '告士打道', en: 'Gloucester Road', cls: 'trunk', w: 26, lanes: 4, oneway: false,
    pts: [[114.1662, 22.2806], [114.1692, 22.2804], [114.1722, 22.2801], [114.1752, 22.2799], [114.1782, 22.2798],
      [114.1812, 22.2800]]
  },
  {
    zh: '花園道', en: 'Garden Road', cls: 'primary', w: 14, lanes: 2, oneway: false,
    pts: [[114.1601, 22.2803], [114.1593, 22.2781], [114.1587, 22.2758]]
  },
  {
    zh: '彌敦道', en: 'Nathan Road', cls: 'trunk', w: 22, lanes: 4, oneway: false,
    pts: [[114.1718, 22.2966], [114.1715, 22.3002], [114.1712, 22.3042], [114.1709, 22.3082], [114.1706, 22.3122],
      [114.1703, 22.3162], [114.1700, 22.3202], [114.1697, 22.3242]]
  },
  {
    zh: '梳士巴利道', en: 'Salisbury Road', cls: 'trunk', w: 24, lanes: 4, oneway: false,
    pts: [[114.1670, 22.2938], [114.1698, 22.2941], [114.1724, 22.2944], [114.1752, 22.2947]]
  },
  {
    zh: '廣東道', en: 'Canton Road', cls: 'primary', w: 18, lanes: 3, oneway: false,
    pts: [[114.1685, 22.2992], [114.1686, 22.2964], [114.1688, 22.2936], [114.1691, 22.2908]]
  },
  {
    zh: '漆咸道南', en: 'Chatham Road South', cls: 'trunk', w: 20, lanes: 3, oneway: false,
    pts: [[114.1763, 22.3034], [114.1757, 22.2998], [114.1752, 22.2964], [114.1749, 22.2938]]
  },
  {
    zh: '佐敦道', en: 'Jordan Road', cls: 'primary', w: 18, lanes: 3, oneway: false,
    pts: [[114.1660, 22.3052], [114.1710, 22.3050], [114.1760, 22.3047]]
  },
  {
    zh: '柯士甸道', en: 'Austin Road', cls: 'primary', w: 16, lanes: 2, oneway: false,
    pts: [[114.1662, 22.3022], [114.1712, 22.3020], [114.1758, 22.3018]]
  },
  {
    zh: '亞皆老街', en: 'Argyle Street', cls: 'primary', w: 18, lanes: 2, oneway: false,
    pts: [[114.1666, 22.3192], [114.1704, 22.3190], [114.1752, 22.3188], [114.1794, 22.3186]]
  },
  {
    zh: '漆咸道北', en: 'Chatham Road North', cls: 'trunk', w: 20, lanes: 3, oneway: false,
    pts: [[114.1763, 22.3034], [114.1770, 22.3080], [114.1776, 22.3126], [114.1784, 22.3172]]
  },
  {
    zh: '加士居道', en: 'Gascoigne Road', cls: 'primary', w: 18, lanes: 3, oneway: false,
    pts: [[114.1706, 22.3076], [114.1750, 22.3074], [114.1792, 22.3072]]
  }
];

// Land masses (coarse outlines, real orientation). Everything outside them is Victoria Harbour.
// Rings are listed in the order they will be drawn; renderer fills them as slabs above the water plane.
export const LAND = [
  {
    id: 'hk-island', zh: '香港島', en: 'Hong Kong Island',
    ring: [
      // north shore, west → east: kept a little seaward (north) of the reclaimed waterfront so IFC,
      // Exchange Square and the Central piers all stand on land
      [114.1480, 22.2872], [114.1530, 22.2866], [114.1580, 22.2861], [114.1630, 22.2856], [114.1680, 22.2851],
      [114.1730, 22.2847], [114.1780, 22.2845], [114.1830, 22.2849], [114.1880, 22.2859], [114.1930, 22.2874],
      [114.1970, 22.2860], [114.1960, 22.2770], [114.1880, 22.2660], [114.1760, 22.2580], [114.1620, 22.2530],
      [114.1480, 22.2510], [114.1400, 22.2590], [114.1420, 22.2700], [114.1445, 22.2790], [114.1460, 22.2845]
    ]
  },
  {
    id: 'kowloon', zh: '九龍', en: 'Kowloon',
    ring: [
      // south shore (TST / Hung Hom), kept a little seaward so the clock tower, Cultural Centre and
      // Star Ferry pier stand on land
      [114.1560, 22.3026], [114.1620, 22.2980], [114.1670, 22.2928], [114.1730, 22.2920], [114.1790, 22.2946],
      [114.1830, 22.2996], [114.1860, 22.3058], [114.1900, 22.3160], [114.1900, 22.3400], [114.1500, 22.3400],
      [114.1450, 22.3200], [114.1480, 22.3100]
    ]
  },
  {
    id: 'west-kowloon', zh: '西九文化區', en: 'West Kowloon Cultural District',
    ring: [
      [114.1500, 22.3048], [114.1560, 22.3020], [114.1620, 22.2978], [114.1665, 22.2952], [114.1645, 22.3062],
      [114.1600, 22.3125], [114.1520, 22.3112]
    ]
  }
];

// Landmarks: real position, real height (m), approximate footprint (m). kind drives the model: tower | civic | pier | hall
export const LANDMARKS = [
  { id: 'ifc', zh: '國際金融中心二期', en: 'Two IFC', lonlat: [114.1590, 22.2850], h: 412, w: 58, d: 58, kind: 'tower' },
  { id: 'boc', zh: '中銀大廈', en: 'Bank of China Tower', lonlat: [114.1612, 22.2792], h: 367, w: 52, d: 52, kind: 'tower' },
  { id: 'hsbc', zh: '匯豐總行大廈', en: 'HSBC Main Building', lonlat: [114.1597, 22.2804], h: 179, w: 70, d: 55, kind: 'tower' },
  { id: 'cheung-kong', zh: '長江集團中心', en: 'Cheung Kong Center', lonlat: [114.1602, 22.2818], h: 283, w: 48, d: 48, kind: 'tower' },
  { id: 'the-center', zh: '中環中心', en: 'The Center', lonlat: [114.1560, 22.2850], h: 346, w: 46, d: 46, kind: 'tower' },
  { id: 'exchange', zh: '交易廣場', en: 'Exchange Square', lonlat: [114.1578, 22.2842], h: 188, w: 62, d: 52, kind: 'tower' },
  { id: 'city-hall', zh: '香港大會堂', en: 'Hong Kong City Hall', lonlat: [114.1618, 22.2820], h: 30, w: 70, d: 45, kind: 'civic' },
  { id: 'pacific-place', zh: '太古廣場', en: 'Pacific Place', lonlat: [114.1655, 22.2775], h: 220, w: 70, d: 60, kind: 'tower' },
  { id: 'central-plaza', zh: '中環廣場', en: 'Central Plaza', lonlat: [114.1735, 22.2802], h: 374, w: 46, d: 46, kind: 'tower' },
  { id: 'hkcec', zh: '香港會議展覽中心', en: 'HKCEC', lonlat: [114.1730, 22.2820], h: 45, w: 160, d: 90, kind: 'hall' },
  { id: 'hopewell', zh: '合和中心', en: 'Hopewell Centre', lonlat: [114.1730, 22.2755], h: 222, w: 44, d: 44, kind: 'tower' },
  { id: 'times-square', zh: '時代廣場', en: 'Times Square', lonlat: [114.1825, 22.2782], h: 191, w: 60, d: 50, kind: 'tower' },
  { id: 'icc', zh: '環球貿易廣場', en: 'ICC', lonlat: [114.1652, 22.3033], h: 484, w: 60, d: 60, kind: 'tower' },
  { id: 'mplus', zh: 'M+ 博物館', en: 'M+ Museum', lonlat: [114.1590, 22.3008], h: 65, w: 110, d: 60, kind: 'hall' },
  { id: 'palace', zh: '香港故宮文化博物館', en: 'Hong Kong Palace Museum', lonlat: [114.1566, 22.3022], h: 40, w: 80, d: 55, kind: 'hall' },
  { id: 'clock-tower', zh: '尖沙咀鐘樓', en: 'Clock Tower', lonlat: [114.1692, 22.2936], h: 44, w: 12, d: 12, kind: 'tower' },
  { id: 'cultural-centre', zh: '香港文化中心', en: 'Cultural Centre', lonlat: [114.1719, 22.2937], h: 40, w: 110, d: 70, kind: 'hall' },
  { id: 'peninsula', zh: '半島酒店', en: 'The Peninsula', lonlat: [114.1717, 22.2951], h: 55, w: 90, d: 55, kind: 'civic' },
  { id: 'ocean-terminal', zh: '海運大廈', en: 'Ocean Terminal', lonlat: [114.1687, 22.2957], h: 30, w: 90, d: 60, kind: 'pier' },
  { id: 'space-museum', zh: '香港太空館', en: 'Space Museum', lonlat: [114.1722, 22.2943], h: 25, w: 40, d: 40, kind: 'civic' },
  { id: 'k11', zh: 'K11 MUSEA', en: 'K11 MUSEA', lonlat: [114.1742, 22.2940], h: 60, w: 70, d: 55, kind: 'hall' },
  { id: 'i-square', zh: '國際廣場', en: 'iSQUARE', lonlat: [114.1724, 22.2970], h: 100, w: 45, d: 40, kind: 'tower' },
  { id: 'langham', zh: '朗豪坊', en: 'Langham Place', lonlat: [114.1685, 22.3180], h: 255, w: 50, d: 50, kind: 'tower' },
  { id: 'central-pier', zh: '中環天星碼頭', en: 'Central Star Ferry Pier', lonlat: [114.1585, 22.2848], h: 12, w: 70, d: 34, kind: 'pier' },
  { id: 'tst-pier', zh: '尖沙咀天星碼頭', en: 'TST Star Ferry Pier', lonlat: [114.1683, 22.2935], h: 12, w: 70, d: 34, kind: 'pier' }
];

// Neighbourhoods as lon/lat rectangles, tested in order (first match wins). Bilingual, because Hong Kong is.
export const DISTRICTS = [
  { id: 'sheung-wan', zh: '上環', en: 'Sheung Wan', box: [114.140, 22.2830, 114.1535, 22.2920] },
  { id: 'central', zh: '中環', en: 'Central', box: [114.1535, 22.2790, 114.1640, 22.2880] },
  { id: 'admiralty', zh: '金鐘', en: 'Admiralty', box: [114.1640, 22.2760, 114.1690, 22.2835] },
  { id: 'wan-chai', zh: '灣仔', en: 'Wan Chai', box: [114.1690, 22.2730, 114.1780, 22.2835] },
  { id: 'causeway-bay', zh: '銅鑼灣', en: 'Causeway Bay', box: [114.1780, 22.2740, 114.1900, 22.2850] },
  { id: 'west-kowloon', zh: '西九文化區', en: 'West Kowloon', box: [114.1500, 22.2960, 114.1650, 22.3120] },
  { id: 'tsim-sha-tsui', zh: '尖沙咀', en: 'Tsim Sha Tsui', box: [114.1640, 22.2900, 114.1800, 22.2990] },
  { id: 'jordan', zh: '佐敦', en: 'Jordan', box: [114.1640, 22.3020, 114.1800, 22.3072] },
  { id: 'yau-ma-tei', zh: '油麻地', en: 'Yau Ma Tei', box: [114.1640, 22.3072, 114.1800, 22.3145] },
  { id: 'mong-kok', zh: '旺角', en: 'Mong Kok', box: [114.1620, 22.3145, 114.1800, 22.3260] }
];

// Tram (香港電車) along Des Voeux Road → Queensway → Hennessy → Yee Wo → Causeway Road, and the Star Ferry.
export const TRAM = [
  [114.1470, 22.2878], [114.1512, 22.2866], [114.1539, 22.2853], [114.1566, 22.2840], [114.1592, 22.2829],
  [114.1620, 22.2818], [114.1646, 22.2800], [114.1670, 22.2796], [114.1700, 22.2794], [114.1730, 22.2791],
  [114.1762, 22.2789], [114.1792, 22.2790], [114.1822, 22.2795], [114.1852, 22.2802], [114.1882, 22.2812]
];
export const FERRY = { from: 'central-pier', to: 'tst-pier', minutes: 9 };

// Harbour crossings, data only (the demo does not drive through them): the real Cross-Harbour Tunnel portals.
export const TUNNELS = [
  { id: 'xharbour', zh: '紅磡海底隧道', en: 'Cross-Harbour Tunnel', pts: [[114.1832, 22.3008], [114.1846, 22.2852]] }
];

// District building-height profiles (m) used by the generator: min, max, share of towers
export const HEIGHT_PROFILE = {
  'sheung-wan': [45, 150, 0.18],
  central: [70, 260, 0.42],
  admiralty: [80, 220, 0.38],
  'wan-chai': [55, 190, 0.25],
  'causeway-bay': [50, 170, 0.22],
  'west-kowloon': [40, 160, 0.2],
  'tsim-sha-tsui': [40, 150, 0.16],
  jordan: [35, 110, 0.08],
  'yau-ma-tei': [30, 100, 0.07],
  'mong-kok': [35, 130, 0.1]
};
