/**
 * painterly.js — 2D (no WebGL) painterly stroke tool for p5.js
 *
 * 目標：重現壁畫 / 蛋彩 / 乾筆質感 —— 平整的幾何色塊，但表面有
 *   1. 乾筆刷毛條紋 (bristle streaks)
 *   2. 低頻顏料濃淡斑駁 (mottling)
 *   3. 高頻顆粒 / 畫布紋理 (tooth grain)
 *   4. 邊緣的抖動與磨損 (edge wobble & scuff)
 *
 * 全部只用 2D canvas API，沒有 shader。
 *
 * 主要 API：
 *   const brush = new PainterlyBrush(pg, opts)
 *   brush.stroke(x1, y1, x2, y2, color, width)   // 單一筆畫
 *   brush.fillPolygon(points, color)             // 用筆畫填滿多邊形色塊
 *   brush.grain(color)                           // 整體顆粒疊加
 *
 * 座標一律是 pixel。所有隨機來源都走 opts.rng，方便 fxhash 決定性重現。
 */

/* ------------------------------------------------------------------ */
/* 隨機與雜訊                                                          */
/* ------------------------------------------------------------------ */

/** mulberry32：小而快的決定性 PRNG，回傳 0..1 */
function makeRng(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * ValueNoise2D：自帶的 2D value noise。
 * 不用 p5.noise() 是因為 p5 的 noise 有全域 seed，
 * 在多筆畫、多圖層的情況下不好隔離。
 */
class ValueNoise2D {
	constructor(rng, size = 256) {
		this.size = size;
		this.mask = size - 1;
		this.table = new Float32Array(size * size);
		for (let i = 0; i < this.table.length; i += 1) {
			this.table[i] = rng();
		}
	}

	valueAt(ix, iy) {
		return this.table[(iy & this.mask) * this.size + (ix & this.mask)];
	}

	/** smoothstep 內插的 value noise，回傳 0..1 */
	get(x, y) {
		const x0 = Math.floor(x);
		const y0 = Math.floor(y);
		const fx = x - x0;
		const fy = y - y0;
		const ux = fx * fx * (3 - 2 * fx);
		const uy = fy * fy * (3 - 2 * fy);

		const v00 = this.valueAt(x0, y0);
		const v10 = this.valueAt(x0 + 1, y0);
		const v01 = this.valueAt(x0, y0 + 1);
		const v11 = this.valueAt(x0 + 1, y0 + 1);

		const a = v00 + (v10 - v00) * ux;
		const b = v01 + (v11 - v01) * ux;
		return a + (b - a) * uy;
	}

	/**
	 * 多層疊加的 fbm，回傳 0..1。
	 *
	 * 每層都繞一個無理數角度旋轉，否則各層的格子會對齊在同一組軸上，
	 * 產生肉眼可見的方塊格狀structure —— 那是「電腦雜訊」和「石灰壁」
	 * 最明顯的差別。旋轉之後紋理才會是各向同性 (isotropic) 的。
	 */
	fbm(x, y, octaves = 4, gain = 0.5, lacunarity = 2) {
		// 0.7548776662 ≈ 1/φ，配合下面的旋轉讓各層盡可能不重複
		const ca = 0.8775825619;  // cos(0.5)
		const sa = 0.4794255386;  // sin(0.5)

		let amp = 1;
		let freq = 1;
		let sum = 0;
		let norm = 0;
		let px = x;
		let py = y;

		for (let i = 0; i < octaves; i += 1) {
			sum += amp * this.get(px * freq, py * freq);
			norm += amp;
			amp *= gain;
			freq *= lacunarity;
			// 旋轉座標系再進下一層
			const rx = px * ca - py * sa;
			const ry = px * sa + py * ca;
			px = rx + 1.7;
			py = ry + 9.2;
		}
		return sum / norm;
	}
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function clamp01(v) {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp2(a, b, t) {
	return a + (b - a) * t;
}

function clampByte(v) {
	return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** 把 p5 color / hex / [r,g,b] 統一轉成 {r,g,b} (0-255) */
function toRgb(c) {
	if (Array.isArray(c)) {
		return { r: c[0], g: c[1], b: c[2] };
	}
	// 已經是 {r,g,b} 了 (例如 shadeRgb() 的輸出) 就直接用
	if (c && typeof c === 'object' && typeof c.r === 'number') {
		return c;
	}
	if (typeof c === 'string') {
		const parsed = color(c);
		return { r: red(parsed), g: green(parsed), b: blue(parsed) };
	}
	// p5.Color
	return { r: red(c), g: green(c), b: blue(c) };
}

/** 顏料濃淡：把顏色往亮/暗推一點，模擬同一顏料的厚薄差異 */
function shadeRgb(rgb, amount) {
	// amount > 0 往白推，< 0 往黑推
	if (amount >= 0) {
		return {
			r: lerp2(rgb.r, 255, amount),
			g: lerp2(rgb.g, 255, amount),
			b: lerp2(rgb.b, 255, amount),
		};
	}
	const t = -amount;
	return {
		r: lerp2(rgb.r, 0, t),
		g: lerp2(rgb.g, 0, t),
		b: lerp2(rgb.b, 0, t),
	};
}

/** 色相微偏移：讓大色塊不會死板，模擬顏料混合不均 */
function hueDriftRgb(rgb, drift) {
	// 極簡的通道權重偏移，比完整 HSL 轉換快，視覺上夠用
	return {
		r: rgb.r + drift * 6,
		g: rgb.g + drift * 2,
		b: rgb.b - drift * 5,
	};
}

function rgbaStr(rgb, alpha) {
	const r = Math.max(0, Math.min(255, Math.round(rgb.r)));
	const g = Math.max(0, Math.min(255, Math.round(rgb.g)));
	const b = Math.max(0, Math.min(255, Math.round(rgb.b)));
	return `rgba(${r},${g},${b},${alpha})`;
}

/* ------------------------------------------------------------------ */
/* PainterlyBrush                                                      */
/* ------------------------------------------------------------------ */

const PAINTERLY_DEFAULTS = {
	// --- 底色覆蓋 ---
	// 這是關鍵：真實的顏料是不透明的。先鋪一層接近實色的底，
	// 刷毛只負責在上面製造「濃淡不均」，而不是負責建立顏色本身。
	baseCoat: 1,            // 色塊底色的不透明度 (0 = 純筆觸堆疊)
	baseCoatLift: 0.16,     // 底色比目標色亮多少 (讓上面的筆觸壓得出深淺)
	fillStrokeBody: 0.34,   // 填色時每一筆帶的顏料量 —— 筆觸可見度的關鍵
	brushScale: 0.16,       // 筆刷寬度相對於色塊對角線的比例
	// 斑駁代表的是「媒材本身」(石灰底、畫布)，所以它會連續地跨過色塊邊界。
	// 這一層要壓得低，讓它退到背景去；畫面的主角是上面那層筆觸。
	baseCoatMottle: 0.01,   // 底色斑駁幅度
	// 頻率單位是 1/px。0.08 ≈ 12px 一個雲斑，0.33 ≈ 3px 一顆粗糙。
	// 刻意不提供更低頻的參數，避免色塊內出現大範圍的明暗漸層。
	mottleMidScale: 0.08,   // 中頻雲斑 (質感主體)
	mottleFineScale: 0.33,  // 細頻粗糙感
	mottleSpeckle: 0.22,    // 每像素顆粒的比重 (不經內插，保留鋭利的牙口)

	// --- 刷毛 ---
	strokeBody: 0.85,       // 單獨筆畫的核心不透明度 (fillPolygon 會設為 0)
	// 刷毛不要太密：太密會糊成一片均勻的紋理，看不出「一根一根的毛」。
	// 疏一點反而看得到毛的走向，那才是筆觸。
	bristleDensity: 0.42,   // 每 px 筆寬幾根刷毛 (0.2 稀疏乾筆 / 1.2 密實)
	// 填色時刷毛只是「暗示」筆觸，太濃會變成掃描線般的斜條紋；
	// 單獨畫筆畫時則需要濃一點才看得出刷毛，所以兩者分開。
	bristleAlpha: 0.13,     // 單獨筆畫的刷毛不透明度
	fillBristleAlpha: 0.11, // 填色時的刷毛不透明度 —— 筆觸的可見度靠這個
	bristleJitter: 0.35,    // 刷毛在筆寬方向的位置抖動 (相對於間距)
	bristleDropout: 0.4,    // 刷毛整根消失的機率 (乾筆的關鍵)
	bristleWaver: 2.6,      // 刷毛沿路徑的橫向飄移量 (px)

	// --- 筆畫路徑 ---
	pathWobble: 1.6,        // 筆畫中線的彎曲量 (px)
	pathWobbleScale: 0.004, // 彎曲的頻率 (越小越平緩)
	stepPx: 2.2,            // 沿路徑取樣間距 (px)，越小越細緻越慢

	// --- 壓力 / 濃淡 ---
	pressureNoiseScale: 0.012, // 沿路徑的壓力起伏頻率
	pressureRange: 0.45,       // 壓力起伏幅度 0..1
	liftEnds: 0.12,            // 頭尾提筆比例 (0 = 不提筆)
	skipAmount: 0.45,          // 乾擦強度：顏料咬不住紙面的比例
	skipScale: 0.05,           // 乾擦的空間頻率

	// --- 顏料變化 ---
	hueDrift: 0.5,          // 色相偏移強度

	// --- 顆粒 ---
	grainAmount: 0.018,     // 顆粒強度
	grainScale: 0.9,        // 顆粒密度 (越大越細)

	// --- 色塊填滿 ---
	planeVariation: 0.5,    // 每個色塊紋理參數的隨機變化幅度
	edgePool: 0.10,         // 色塊邊緣內側的顏料堆積 (手刷平塗的特徵)
	edgePoolWidth: 5,       // 堆積的寬度 (px)
	// 重疊少、筆數少，每一筆才留得下自己的邊界。
	// 重疊太多時幾百筆低透明度的筆畫會互相平均掉，結果又變回平塗。
	fillOverlap: 0.12,      // 填色筆畫的重疊比例
	fillPasses: 1,          // 填幾層
	fillAngleJitter: 0.11,  // 每筆角度抖動 (radian)
	fillPassAngle: 0.28,    // 層與層之間的角度差。小 = 同一個方向反覆刷，
	                        // 大 = 交叉。設太大會變成規律的網格底紋
	fillStrokeMinLen: 0.3,  // 最短的一筆佔多少比例 (讓長短筆混在一起)
	fillStrokeTone: 0.09,   // 每一筆的色調差異 (沾料多寡不同)
	edgeScuff: 0.5,         // 邊緣磨損強度
};

class PainterlyBrush {
	/**
	 * @param {p5|p5.Graphics} target 繪圖目標 (2D renderer)
	 * @param {object} opts 見 PAINTERLY_DEFAULTS
	 */
	constructor(target, opts = {}) {
		this.target = target;
		this.opts = Object.assign({}, PAINTERLY_DEFAULTS, opts);

		const seed = opts.seed ?? 12345;
		this.rng = opts.rng ?? makeRng(seed);
		this.noise = new ValueNoise2D(this.rng);
		// 每支筆有自己的雜訊偏移，避免所有筆畫的紋理對齊
		this.nOff = this.rng() * 1000;
		// 斑駁紋理的偏移；固定在 brush 上，讓整張畫的壁面紋理是連續的一片，
		// 而不是每個色塊各自為政 (那會讓色塊邊界過於明顯)
		this.mottleOffset = this.rng() * 500;
	}

	setOption(key, value) {
		this.opts[key] = value;
		return this;
	}

	setOptions(obj) {
		Object.assign(this.opts, obj);
		return this;
	}

	random(lo = 1, hi) {
		if (hi === undefined) {
			hi = lo;
			lo = 0;
		}
		return lo + this.rng() * (hi - lo);
	}

	/* -------------------------------------------------------------- */
	/* 單一筆畫                                                        */
	/* -------------------------------------------------------------- */

	/**
	 * 畫一道乾筆筆畫。
	 * @param {number} x1,y1 起點
	 * @param {number} x2,y2 終點
	 * @param {*} col 顏色 (p5.Color / hex / [r,g,b])
	 * @param {number} w 筆寬 (px)
	 * @param {object} over 這一筆的參數覆寫
	 */
	stroke(x1, y1, x2, y2, col, w, over = {}) {
		const o = over === PAINTERLY_DEFAULTS ? this.opts : Object.assign({}, this.opts, over);
		const g = this.target;
		const rgb = toRgb(col);

		const dx = x2 - x1;
		const dy = y2 - y1;
		const len = Math.hypot(dx, dy);
		if (len < 0.01 || w <= 0) {
			return;
		}

		// 路徑方向與法線
		const ux = dx / len;
		const uy = dy / len;
		const nx = -uy;
		const ny = ux;

		// 沿路徑的取樣點數
		const steps = Math.max(2, Math.ceil(len / o.stepPx));

		// 刷毛數量
		const bristleCount = Math.max(1, Math.round(w * o.bristleDensity));
		const spacing = bristleCount > 1 ? w / (bristleCount - 1) : 0;

		// 每根刷毛獨立的雜訊種子，讓條紋彼此不相關
		const strokeSeed = this.rng() * 500;

		// 筆身：單獨使用 stroke() 時，先鋪一條較實的核心，
		// 否則只有稀疏刷毛會讓筆畫淡到幾乎看不見。
		// fillPolygon() 會把這個關掉，因為它自己已經有底色。
		if (o.strokeBody > 0) {
			const bodyW = w * 0.82;
			g.push();
			g.noFill();
			g.strokeCap(ROUND);
			g.strokeJoin(ROUND);
			g.strokeWeight(bodyW);
			g.stroke(rgbaStr(rgb, o.strokeBody));
			g.beginShape();
			for (let s = 0; s <= steps; s += 1) {
				const t = s / steps;
				const px = x1 + dx * t;
				const py = y1 + dy * t;
				const wob = (this.noise.get(
					(px + this.nOff) * o.pathWobbleScale,
					(py + this.nOff) * o.pathWobbleScale
				) - 0.5) * 2 * o.pathWobble;
				g.vertex(px + nx * wob, py + ny * wob);
			}
			g.endShape();
			g.pop();
		}

		g.push();
		g.noFill();
		g.strokeCap(ROUND);
		g.strokeJoin(ROUND);

		for (let b = 0; b < bristleCount; b += 1) {
			// 乾筆：部分刷毛整根不著色
			if (this.rng() < o.bristleDropout) {
				continue;
			}

			// 刷毛在筆寬方向的位置 (-w/2 .. w/2)，加上抖動
			const base = bristleCount > 1 ? -w / 2 + b * spacing : 0;
			const jitter = (this.rng() - 0.5) * spacing * o.bristleJitter * 2;
			const offset = base + jitter;

			// 這根刷毛的粗細與濃度。
			// 粗細差距要拉大：有的毛沾得多、鋪得寬，有的細如髮絲。
			// 全部一樣粗會糊成均勻的網底，看不出是一根根的毛。
			const bw = Math.max(0.5, spacing * this.random(0.35, 1.6));
			const bristleTone = this.rng();
			const bSeed = strokeSeed + b * 37.13;

			// 邊緣刷毛較淡 (筆刷兩側顏料少)
			const edgeT = bristleCount > 1 ? Math.abs(offset) / (w / 2) : 0;
			const edgeFade = 1 - 0.45 * edgeT * edgeT;

			g.beginShape();
			let anyPoint = false;
			for (let s = 0; s <= steps; s += 1) {
				const t = s / steps;
				const px = x1 + dx * t;
				const py = y1 + dy * t;

				// 路徑本身的彎曲
				const wob = (this.noise.get(
					(px + this.nOff) * o.pathWobbleScale,
					(py + this.nOff) * o.pathWobbleScale
				) - 0.5) * 2 * o.pathWobble;

				// 這根刷毛沿路徑的橫向飄移
				const waver = (this.noise.get(
					bSeed + t * len * 0.03,
					bSeed * 0.5
				) - 0.5) * 2 * o.bristleWaver;

				const off = offset + wob + waver;
				const cx = px + nx * off;
				const cy = py + ny * off;

				g.vertex(cx, cy);
				anyPoint = true;
			}

			if (!anyPoint) {
				g.endShape();
				continue;
			}

			// 這根刷毛的整體色彩：濃淡 + 色相偏移。
			// 毛與毛之間的深淺差是「看得見刷毛」的主因。
			const drift = (bristleTone - 0.5) * 2 * o.hueDrift;
			let c = shadeRgb(rgb, (bristleTone - 0.5) * 0.22);
			c = hueDriftRgb(c, drift);

			const alpha = o.bristleAlpha * edgeFade * lerp2(0.35, 1.5, bristleTone);
			g.stroke(rgbaStr(c, clamp01(alpha)));
			g.strokeWeight(bw);
			g.endShape();
		}

		g.pop();

		// --- 濃淡斑駁 ---
		// 遮罩要「比筆身稍微窄」，不能比它寬。
		// 遮罩一旦超出實際上色的範圍，就會在筆畫四周留下一圈被洗過的矩形光暈。
		if (o.strokeBody > 0) {
			const hw = w * 0.34;
			const mnx = Math.min(x1, x2) - hw;
			const mny = Math.min(y1, y2) - hw;
			const mxx = Math.max(x1, x2) + hw;
			const mxy = Math.max(y1, y2) + hw;
			this.maskedMottle(
				[
					{ x: x1 + nx * hw, y: y1 + ny * hw },
					{ x: x2 + nx * hw, y: y2 + ny * hw },
					{ x: x2 - nx * hw, y: y2 - ny * hw },
					{ x: x1 - nx * hw, y: y1 - ny * hw },
				],
				mnx, mny, mxx, mxy,
				o
			);
		}
	}

	/**
	 * 有壓力變化的筆畫：沿路徑分段，每段依壓力調整不透明度與寬度。
	 * 比 stroke() 更像真的一筆下去，適合單獨的表現性筆觸。
	 */
	pressureStroke(x1, y1, x2, y2, col, w, over = {}) {
		const o = Object.assign({}, this.opts, over);
		const dx = x2 - x1;
		const dy = y2 - y1;
		const len = Math.hypot(dx, dy);
		if (len < 0.01) {
			return;
		}

		const g = this.target;
		const rgb = toRgb(col);
		const ux = dx / len;
		const uy = dy / len;
		const nx = -uy;
		const ny = ux;

		const steps = Math.max(8, Math.ceil(len / o.stepPx));
		const pSeed = this.rng() * 300;

		// 先沿路徑算好每一點的壓力與中線位置。
		// 一次算完再畫成「單一條」形狀，而不是一段一段畫 —— 分段畫會因為
		// 每段各自有 ROUND 端點而在筆畫上留下一顆顆膠囊狀的接痕。
		const pts = [];
		for (let s = 0; s <= steps; s += 1) {
			const t = s / steps;
			const px = x1 + dx * t;
			const py = y1 + dy * t;

			// 壓力：沿路徑的低頻起伏
			const pn = this.noise.get(pSeed + t * len * o.pressureNoiseScale, pSeed);
			let pressure = 1 - o.pressureRange * (1 - pn);

			// 頭尾提筆。用非線性的收尾，讓末端是「抬起來」而不是「被切斷」。
			// 頭尾不對稱：下筆是「咬進去」，很短距離內就到滿壓，所以開頭比較鈍；
			// 收筆是「拖出去」，衰減得比較長，才會有拖尾。
			if (o.liftEnds > 0) {
				const headRaw = Math.min(1, t / (o.liftEnds * 0.45));
				// 開根號讓起筆很快變粗，末端不會是一個對稱的尖角
				const headT = Math.sqrt(headRaw);
				const tailT = Math.min(1, (1 - t) / (o.liftEnds * 1.6));
				const lift = Math.min(headT, tailT * tailT * (3 - 2 * tailT));
				pressure *= lift;
			}

			// 路徑彎曲
			const wob = (this.noise.get(
				(px + this.nOff) * o.pathWobbleScale,
				(py + this.nOff) * o.pathWobbleScale
			) - 0.5) * 2 * o.pathWobble;

			// 乾擦：沿路徑的低頻雜訊決定顏料有沒有咬住紙面。
			// 沒有這個，筆畫會是一條密不透風的緞帶，看不出「筆」的存在。
			const skipN = this.noise.fbm(pSeed * 2 + t * len * o.skipScale, pSeed * 2, 2);
			const skip = clamp01((skipN - (1 - o.skipAmount)) / Math.max(0.001, o.skipAmount));

			pts.push({
				x: px + nx * wob,
				y: py + ny * wob,
				p: clamp01(pressure),
				// 乾擦處顏料變薄
				s: lerp2(1, 0.25, skip),
			});
		}

		// --- 筆身：用一個左右輪廓構成的封閉多邊形，寬度隨壓力變化 ---
		const outline = [];
		if (o.strokeBody > 0) {
			for (let i = 0; i < pts.length; i += 1) {
				// 下限壓到很低，末端才收得成一個尖，而不是被齊頭切斷
				const hw = (w * 0.82 * lerp2(0.04, 1, pts[i].p)) / 2;
				outline.push({ x: pts[i].x + nx * hw, y: pts[i].y + ny * hw });
			}
			for (let i = pts.length - 1; i >= 0; i -= 1) {
				// 下限壓到很低，末端才收得成一個尖，而不是被齊頭切斷
				const hw = (w * 0.82 * lerp2(0.04, 1, pts[i].p)) / 2;
				outline.push({ x: pts[i].x - nx * hw, y: pts[i].y - ny * hw });
			}

			// 整條一次填成單一形狀，用固定的不透明度。
			//
			// 不要逐段畫四邊形再各給一個 alpha：相鄰段的 alpha 不同時，
			// 接縫會變成一條垂直於筆畫的硬線，整條筆畫看起來像燈芯絨。
			// 乾擦的變化改成後面用 per-pixel 的方式挖掉 (見 eatStroke)，
			// 那是連續場，不會產生任何接縫。
			g.push();
			g.noStroke();
			g.fill(rgbaStr(rgb, o.strokeBody));
			g.beginShape();
			for (const p of outline) {
				g.vertex(p.x, p.y);
			}
			g.endShape(CLOSE);
			g.pop();
		}

		// --- 刷毛：整條一次畫完，濃度隨當地壓力變化 ---
		const bristleCount = Math.max(1, Math.round(w * o.bristleDensity));
		const spacing = bristleCount > 1 ? w / (bristleCount - 1) : 0;
		const bSeedBase = this.rng() * 500;

		g.push();
		g.noFill();
		g.strokeCap(ROUND);
		g.strokeJoin(ROUND);

		for (let b = 0; b < bristleCount; b += 1) {
			if (this.rng() < o.bristleDropout) {
				continue;
			}

			const base = bristleCount > 1 ? -w / 2 + b * spacing : 0;
			const jitter = (this.rng() - 0.5) * spacing * o.bristleJitter * 2;
			const offset = base + jitter;
			const bSeed = bSeedBase + b * 37.13;
			const tone = this.rng();

			const edgeT = bristleCount > 1 ? Math.abs(offset) / (w / 2) : 0;
			const edgeFade = 1 - 0.45 * edgeT * edgeT;

			// 壓力低的地方刷毛要斷開，所以拆成多段 shape 而不是一條連續線
			let open = false;
			for (let i = 0; i < pts.length; i += 1) {
				const pt = pts[i];
				// 壓力越小、乾擦越嚴重，這根刷毛越可能離開紙面
				const contact = pt.p * pt.s > 0.12 + tone * 0.28;
				if (!contact) {
					if (open) {
						g.endShape();
						open = false;
					}
					continue;
				}
				if (!open) {
					// 低於門檻的直接不畫。極淡的刷毛會沿著筆身外緣留下一圈
					// 看得見的細絲輪廓，那是幾何殘影而不是顏料。
					const ba = o.bristleAlpha * edgeFade * lerp2(0.55, 1.2, tone);
					if (ba < 0.012) {
						break;
					}
					g.stroke(rgbaStr(
						shadeRgb(rgb, (tone - 0.5) * 0.08),
						clamp01(ba)
					));
					g.strokeWeight(Math.max(0.4, spacing * lerp2(0.5, 1.15, tone)));
					g.beginShape();
					open = true;
				}
				const waver = (this.noise.get(bSeed + (i / steps) * len * 0.03, bSeed * 0.5) - 0.5)
					* 2 * o.bristleWaver;
				// 壓力小的時候筆毛往中間收
				let off = (offset + waver) * lerp2(0.55, 1, pt.p);
				// 夾在筆身寬度之內：飄出去的刷毛會在筆身外側連成一條
				// 細細的輪廓線，看起來像沒清乾淨的幾何殘影。
				const limit = (w * 0.82 * lerp2(0.04, 1, pt.p)) / 2;
				off = Math.max(-limit, Math.min(limit, off));
				g.vertex(pt.x + nx * off, pt.y + ny * off);
			}
			if (open) {
				g.endShape();
			}
		}

		g.pop();

		// --- 濃淡斑駁：讓筆身也是顏料，而不是一條實色緞帶 ---
		if (outline.length > 2) {
			let mnx = Infinity;
			let mny = Infinity;
			let mxx = -Infinity;
			let mxy = -Infinity;
			for (const p of outline) {
				if (p.x < mnx) mnx = p.x;
				if (p.y < mny) mny = p.y;
				if (p.x > mxx) mxx = p.x;
				if (p.y > mxy) mxy = p.y;
			}
			this.maskedMottle(outline, mnx, mny, mxx, mxy, o);

			// --- 乾擦：最後才挖 ---
			// 一定要挖到「完全透明」，讓底下的紙露出來；只是把 alpha 降低
			// 看起來只是顏色不勻，不是乾筆。
			// 而且必須放在斑駁之後：斑駁走 getImageData/putImageData，
			// 那組 API 拿到的 RGB 是未預乘的，先挖洞的話洞裡的 RGB 會是 0，
			// 再被斑駁 pass 寫回畫布時就變成一塊塊黑色。
			if (o.skipAmount > 0) {
				this.eatStroke(outline, x1, y1, ux, uy, nx, ny, len, w, o);
			}
		}
	}

	/**
	 * 乾擦：在已經畫好的筆身上挖出空洞，讓底下的紙露出來。
	 *
	 * 雜訊在「筆畫座標系」(沿筆畫 u、垂直筆畫 v) 取樣，所以空洞會順著
	 * 筆的方向拉長，像刷毛掃過的痕跡；若直接用畫布座標，空洞會是圓的，
	 * 看起來像被蟲蛀而不是乾筆。
	 *
	 * 實作上是「把底色補回去」而不是用 destination-out 把 alpha 清掉。
	 * 主畫布通常是不透明的 (createCanvas 預設沒有 alpha)，在這種畫布上
	 * destination-out 擦出來的是黑色而不是透明，會在筆畫上留下一塊塊黑斑。
	 * 因此這裡需要知道底下是什麼顏色，由 groundColor 記錄。
	 */
	eatStroke(outline, x1, y1, ux, uy, nx, ny, len, w, o) {
		const g = this.target;
		const ctx = g.drawingContext;
		const dpr = g.pixelDensity ? g.pixelDensity() : 1;

		let mnx = Infinity;
		let mny = Infinity;
		let mxx = -Infinity;
		let mxy = -Infinity;
		for (const p of outline) {
			if (p.x < mnx) mnx = p.x;
			if (p.y < mny) mny = p.y;
			if (p.x > mxx) mxx = p.x;
			if (p.y > mxy) mxy = p.y;
		}

		const x0 = Math.max(0, Math.floor(mnx * dpr));
		const y0 = Math.max(0, Math.floor(mny * dpr));
		const x1p = Math.min(ctx.canvas.width, Math.ceil(mxx * dpr));
		const y1p = Math.min(ctx.canvas.height, Math.ceil(mxy * dpr));
		const bw = x1p - x0;
		const bh = y1p - y0;
		if (bw <= 0 || bh <= 0) {
			return;
		}

		// 讀出目前畫布內容，直接在上面把「乾擦掉的地方」換成底色。
		// 這樣不需要處理 alpha，也就不會踩到不透明畫布的 destination-out 問題。
		const base = toRgb(this.groundColor ?? '#e5dcc9');
		const img = ctx.getImageData(x0, y0, bw, bh);
		const d = img.data;
		const nz = this.noise;
		const seed = this.rng() * 400;
		const halfW = w * 0.5;

		for (let j = 0; j < bh; j += 1) {
			const py = (y0 + j) / dpr;
			for (let i = 0; i < bw; i += 1) {
				const px = (x0 + i) / dpr;

				// 換算到筆畫座標：u = 沿筆畫距離, v = 離中線的距離
				const rx = px - x1;
				const ry = py - y1;
				const u = rx * ux + ry * uy;
				const v = rx * nx + ry * ny;
				const t = clamp01(u / Math.max(1, len));

				// 沿筆畫拉長的雜訊。u 與 v 的頻率差距要拉大 (這裡約 1:16)，
				// 空洞才會是又細又長的條狀 —— 那是刷毛跳過去的痕跡。
				// 兩軸頻率接近的話，空洞會變成一片片鏡片狀的大洞，
				// 看起來像鏤空的型版而不是乾筆。
				const n = nz.fbm(
					seed + u * o.skipScale * 0.35,
					seed + v * o.skipScale * 5.6,
					3
				);

				// 邊緣比中間容易乾擦；筆畫後半段顏料變少也更容易乾擦
				const edge = clamp01(Math.abs(v) / Math.max(1, halfW));
				let bias = o.skipAmount * (0.55 + 0.75 * edge) * (0.6 + 0.8 * t);

				// 末端崩解：最後 12% 讓刷毛散開成幾根，而不是收成一個實心的尖
				const tipT = clamp01((t - 0.88) / 0.12);
				if (tipT > 0) {
					// 沿 v 方向的高頻條紋 = 分岔的刷毛
					const filament = nz.get(seed * 3 + v * 0.55, seed * 3);
					bias += tipT * (0.55 + 0.75 * filament);
				}
				// 起筆端：範圍要夠長、力度要夠，否則會收成一根針。
				// 真實的下筆是「咬進去」，開頭反而比較鈍、比較毛，
				// 不是一個對稱的尖角。
				const headT = clamp01((0.08 - t) / 0.08);
				if (headT > 0) {
					const filament = nz.get(seed * 5 + v * 0.62, seed * 5);
					bias += headT * (0.5 + 0.7 * filament);
				}

				// n 低於門檻的地方就挖掉。
				// 過渡帶做成不對稱的：接近全挖的那一側收得快 (顏料就是沒沾上)，
				// 剛開始變薄的那一側拖得長 (顏料越來越少)。對稱的過渡帶
				// 會讓空洞邊緣看起來像被裁切出來的。
				const cut = clamp01((bias - n) / 0.13);
				const a = cut * cut * (3 - 2 * cut) * lerp2(0.85, 1, cut);

				// 往底色插值：a=1 代表這裡完全沒沾到顏料
				const idx = (j * bw + i) * 4;
				if (a > 0.002) {
					d[idx] = clampByte(lerp2(d[idx], base.r, a));
					d[idx + 1] = clampByte(lerp2(d[idx + 1], base.g, a));
					d[idx + 2] = clampByte(lerp2(d[idx + 2], base.b, a));
				}
			}
		}

		const tmp = this._getTmpCanvas(bw, bh);
		tmp.ctx.putImageData(img, 0, 0);

		// 只在筆身範圍內扣，避免影響到旁邊已經畫好的東西。
		// clip 直接沿用筆身路徑的話，筆身自己的反鋸齒邊會殘留成一條細輪廓線，
		// 所以把路徑以形心為中心稍微放大，讓乾擦連那圈邊緣一起吃掉。
		let ccx = 0;
		let ccy = 0;
		for (const p of outline) {
			ccx += p.x;
			ccy += p.y;
		}
		ccx /= outline.length;
		ccy /= outline.length;
		const grow = 1.5;

		ctx.save();
		ctx.beginPath();
		for (let i = 0; i < outline.length; i += 1) {
			const p = outline[i];
			const vx = p.x - ccx;
			const vy = p.y - ccy;
			const d2 = Math.hypot(vx, vy) || 1;
			const gx = p.x + (vx / d2) * grow;
			const gy = p.y + (vy / d2) * grow;
			if (i === 0) {
				ctx.moveTo(gx, gy);
			} else {
				ctx.lineTo(gx, gy);
			}
		}
		ctx.closePath();
		ctx.clip();
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(tmp.canvas, x0 / dpr, y0 / dpr, bw / dpr, bh / dpr);
		ctx.imageSmoothingEnabled = true;
		ctx.restore();
	}

	/* -------------------------------------------------------------- */
	/* 多邊形色塊                                                      */
	/* -------------------------------------------------------------- */

	/**
	 * 用一道道筆畫填滿多邊形，做出畫中那種「平面但有筆觸」的色塊。
	 * @param {Array<{x,y}|[x,y]>} pts 多邊形頂點
	 * @param {*} col 顏色
	 * @param {object} over 參數覆寫；另可加 angle (填色筆畫方向, radian)
	 */
	fillPolygon(pts, col, over = {}) {
		const o = Object.assign({}, this.opts, over);
		const g = this.target;
		const rgb = toRgb(col);
		const poly = pts.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y }));
		if (poly.length < 3) {
			return;
		}

		// 邊界框
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const p of poly) {
			if (p.x < minX) minX = p.x;
			if (p.y < minY) minY = p.y;
			if (p.x > maxX) maxX = p.x;
			if (p.y > maxY) maxY = p.y;
		}
		const cx = (minX + maxX) / 2;
		const cy = (minY + maxY) / 2;
		const diag = Math.hypot(maxX - minX, maxY - minY);

		const baseAngle = over.angle ?? this.random(0, Math.PI * 2);
		// 筆要夠寬。筆寬相對於色塊太細時，一片色塊要用上百筆才填得滿，
		// 疊起來就糊成一片；寬筆只要十幾筆，每一筆都看得見。
		// 但也不能超過色塊的短邊太多，否則細長的帶子會只被一筆蓋掉。
		const shortSide = Math.min(maxX - minX, maxY - minY);
		const brushW = over.brushWidth
			?? Math.max(8, Math.min(diag * o.brushScale, shortSide * 0.55));

		// 用 clip 把筆畫限制在多邊形內，邊緣再另外處理。
		//
		// 注意：斑駁 pass 走 getImageData/putImageData，而那組 API 不受 clip 影響，
		// 所以它不能放在這個 clip 區塊裡，必須自己重新套用多邊形遮罩 (見 maskedMottle)。
		g.push();
		g.drawingContext.save();
		g.drawingContext.beginPath();
		g.drawingContext.moveTo(poly[0].x, poly[0].y);
		for (let i = 1; i < poly.length; i += 1) {
			g.drawingContext.lineTo(poly[i].x, poly[i].y);
		}
		g.drawingContext.closePath();
		g.drawingContext.clip();

		// --- 0. 這一塊的個性 ---
		// 每個色塊給自己一組略微不同的紋理參數。若全部共用同一組，
		// 每一面的紋理統計會一模一樣，那是「程式跑出來的」而不是「手畫的」最大破綻。
		const vary = o.planeVariation;
		if (vary > 0) {
			// 三個頻段各自獨立抽，而且是用「乘法」在對數尺度上散開。
			// 若只在 ±10% 內微調，各面的統計數字幾乎一樣，
			// 看起來仍然是同一種紋理換了顏色而已。
			// 這裡讓雲斑尺度可以差到 2-3 倍，才會出現「這面粗、那面細」的差別。
			const lg = (amount) => Math.exp((this.rng() - 0.5) * 2 * amount);

			// 濃淡幅度：有的面顏料吃得深，有的面幾乎是平塗
			o.baseCoatMottle *= lg(vary * 1.5);
			// 雲斑尺度：這是「粗 / 細」的主要來源，散得最開
			o.mottleMidScale *= lg(vary * 2.4);
			// 顆粒密度：和上面兩者不相關，才能有「粗但平滑」「細但密」等組合
			o.mottleSpeckle *= lg(vary * 1.6);
			o.mottleFineScale *= lg(vary * 1.2);
		}

		// --- 1. 底色 ---
		// 這一層只是「把區域佔住」，不是最終的顏色。
		// 它刻意畫得比目標色淡一點，真正的顏色由上面一筆一筆疊出來——
		// 底色若already 是實色，後面不管怎麼刷都只是在實色上抹一層薄霧，
		// 永遠看不出筆觸。
		if (o.baseCoat > 0) {
			g.push();
			g.noStroke();
			g.fill(rgbaStr(shadeRgb(rgb, o.baseCoatLift), o.baseCoat));
			g.beginShape();
			for (const p of poly) {
				g.vertex(p.x, p.y);
			}
			g.endShape(CLOSE);
			g.pop();
		}

		// --- 2. 筆觸 ---
		//
		// 這一層是畫面的主角：要讓人看得出「這片顏色是刷出來的」。
		//
		// 關鍵在於每一筆都是獨立的一筆，而不是梳子梳過去。
		// 若所有筆畫等長、等寬、等濃度、方向一致，疊起來會變成規律的
		// 斜線網底 (看起來像掃描線)，那是「圖樣」不是「筆觸」。
		// 所以每一筆各自抽自己的：長度、起訖位置、寬度、濃度、色調。
		for (let pass = 0; pass < o.fillPasses; pass += 1) {
			// 同一片色塊的筆觸方向大致一致 (那是手的方向)，
			// 只在層與層之間帶一點角度差，不要做成正交交叉網。
			const angle = baseAngle + pass * o.fillPassAngle
				+ this.random(-0.1, 0.1);
			const ax = Math.cos(angle);
			const ay = Math.sin(angle);
			const px = -ay;
			const py = ax;

			const step = brushW * (1 - o.fillOverlap);
			const half = diag * 0.75;
			const lines = Math.ceil((half * 2) / step);

			for (let i = 0; i <= lines; i += 1) {
				const d = -half + i * step + this.random(-step * 0.45, step * 0.45);
				const mxc = cx + px * d;
				const myc = cy + py * d;

				const jitter = this.random(-o.fillAngleJitter, o.fillAngleJitter);
				const ja = angle + jitter;
				const jx = Math.cos(ja);
				const jy = Math.sin(ja);

				// 每一筆的長度和位置都不同：有的橫貫整片，有的只刷一小段。
				// 這是「一筆一筆刷」和「梳子梳過去」最大的差別。
				const lenScale = this.random(o.fillStrokeMinLen, 1.15);
				const slide = this.random(-0.35, 0.35);
				const ext = half * lenScale;
				const ox = mxc + jx * half * slide;
				const oy = myc + jy * half * slide;

				// 這一筆的顏料濃淡：模擬每次沾料多寡不同
				const load = this.random(0.55, 1.35);
				const tone = (this.rng() - 0.5) * 2;
				const c = shadeRgb(rgb, tone * o.fillStrokeTone);

				this.stroke(
					ox - jx * ext, oy - jy * ext,
					ox + jx * ext, oy + jy * ext,
					c,
					brushW * this.random(0.65, 1.4),
					{
						// 每一筆都帶有實際的顏料量。
						// 這是看得出筆觸的關鍵：筆畫本身是不透明的顏料，
						// 疊在一起時會互相蓋掉，邊界就是「這一筆刷到哪裡」。
						// 若只留刷毛紋理 (strokeBody: 0)，畫面永遠是平塗加一層薄紋。
						strokeBody: o.fillStrokeBody * load,
						bristleAlpha: o.fillBristleAlpha * load * (pass === 0 ? 1 : 0.8),
						bristleDropout: o.bristleDropout,
						// 填色的筆不要乾擦挖洞，否則會露出底色變成破洞
						skipAmount: 0,
					}
				);
			}
		}

		// --- 2.5 邊緣顏料堆積 ---
		// 手刷的平塗色塊，顏料會在邊界內側稍微積厚一點。
		// 少了這一道，色塊會像是「被填滿的向量圖形」而不是「刷出來的一片顏色」。
		// 畫在 clip 之內，所以只會影響色塊內側，不會糊到外面。
		if (o.edgePool > 0) {
			const ctx2 = g.drawingContext;
			ctx2.save();
			ctx2.lineJoin = 'round';
			ctx2.strokeStyle = rgbaStr(shadeRgb(rgb, -0.5), o.edgePool);
			ctx2.lineWidth = o.edgePoolWidth * 2; // 一半會被 clip 切掉，剩下內側那半
			ctx2.beginPath();
			ctx2.moveTo(poly[0].x, poly[0].y);
			for (let i = 1; i < poly.length; i += 1) {
				ctx2.lineTo(poly[i].x, poly[i].y);
			}
			ctx2.closePath();
			ctx2.stroke();
			ctx2.restore();
		}

		g.drawingContext.restore();
		g.pop();

		if (o.edgeScuff > 0) {
			this.scuffEdges(poly, col, o);
		}

		// --- 3. 濃淡斑駁：延後到 finish() ---
		// 每個色塊各自立刻套一次會出問題：色塊重疊處的像素會被套兩次，
		// 疊加後的亮度和只套一次的地方對不起來，在 bounding box 邊界
		// 形成一道直的接縫。所以這裡只把「這一塊要用什麼參數」記下來，
		// 等 finish() 時依序、且每個像素只套一次地做完。
		this.mottleQueue = this.mottleQueue ?? [];
		this.mottleQueue.push({
			poly: poly,
			minX: minX, minY: minY, maxX: maxX, maxY: maxY,
			opts: {
				baseCoatMottle: o.baseCoatMottle,
				mottleMidScale: o.mottleMidScale,
				mottleFineScale: o.mottleFineScale,
				mottleSpeckle: o.mottleSpeckle,
			},
		});
	}

	/**
	 * 收尾：把累積的斑駁範圍一次套用，然後疊上整體顆粒。
	 *
	 * 一定要呼叫，否則 fillPolygon() 畫出來的色塊會停在「平塗」的狀態。
	 * 一次做完也保證重疊的色塊只被套一次，不會出現接縫。
	 */
	finish(opt = {}) {
		const queue = this.mottleQueue ?? [];

		// 依照當初繪製的順序套用。重疊處由後面的色塊覆蓋前面的，
		// 所以每個像素最終只會被套用一次，不會出現亮度疊加的接縫。
		for (const job of queue) {
			this.maskedMottle(
				job.poly, job.minX, job.minY, job.maxX, job.maxY,
				Object.assign({}, this.opts, job.opts)
			);
		}
		this.mottleQueue = [];

		if ((opt.grain ?? true) && this.opts.grainAmount > 0) {
			this.grain(opt);
		}
	}

	/**
	 * 對多邊形區域套用斑駁，並用多邊形本身當遮罩。
	 *
	 * 因為 putImageData 無視 clip，所以做法是：
	 *   1. 取出整個 bounding box 的像素
	 *   2. 在暫存 canvas 上算好斑駁
	 *   3. 用多邊形 path 當 clip，再把暫存結果畫回去
	 * 第 3 步是一般的 drawImage，會正常受 clip 影響。
	 */
	maskedMottle(poly, minX, minY, maxX, maxY, o) {
		const g = this.target;
		if (o.baseCoatMottle <= 0) {
			return;
		}

		const ctx = g.drawingContext;
		const dpr = g.pixelDensity ? g.pixelDensity() : 1;

		const x0 = Math.max(0, Math.floor(minX * dpr));
		const y0 = Math.max(0, Math.floor(minY * dpr));
		const x1 = Math.min(ctx.canvas.width, Math.ceil(maxX * dpr));
		const y1 = Math.min(ctx.canvas.height, Math.ceil(maxY * dpr));
		const w = x1 - x0;
		const h = y1 - y0;
		if (w <= 0 || h <= 0) {
			return;
		}

		const img = ctx.getImageData(x0, y0, w, h);
		this.applyMottleToImageData(img, x0, y0, dpr, o);

		// 暫存 canvas，把算好的像素放回去再受 clip 地畫回主畫布
		const tmp = this._getTmpCanvas(w, h);
		tmp.ctx.putImageData(img, 0, 0);

		ctx.save();
		ctx.beginPath();
		ctx.moveTo(poly[0].x, poly[0].y);
		for (let i = 1; i < poly.length; i += 1) {
			ctx.lineTo(poly[i].x, poly[i].y);
		}
		ctx.closePath();
		ctx.clip();
		// drawImage 用的是 CSS 座標，所以要除回 dpr。
		// 因為 x0/y0/w/h 都是整數 device pixel，除以 dpr 後對得回原位，
		// 不會有重新取樣造成的接縫。
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(tmp.canvas, x0 / dpr, y0 / dpr, w / dpr, h / dpr);
		ctx.imageSmoothingEnabled = true;
		ctx.restore();
	}

	_getTmpCanvas(w, h) {
		if (!this._tmp) {
			this._tmp = { canvas: document.createElement('canvas') };
			this._tmp.ctx = this._tmp.canvas.getContext('2d', { willReadFrequently: true });
		}
		// 尺寸一定要設成剛好，設定 width/height 同時也會清空畫布。
		// 若沿用比較大的暫存畫布，上一次的殘留像素會被 drawImage 一起畫回去，
		// 在畫面上形成一塊塊灰色的矩形。
		this._tmp.canvas.width = w;
		this._tmp.canvas.height = h;
		return this._tmp;
	}

	/**
	 * 在已經上好底色的區域疊「石灰壁 / 蛋彩」的濃淡斑駁。
	 *
	 * 用 per-pixel 的 fbm 直接寫進 ImageData，而不是畫一格格矩形——
	 * 矩形做法會留下肉眼可見的方格接縫，那正是這種質感最忌諱的東西。
	 * 這個 pass 是整個質感的主角，不是可有可無的裝飾。
	 */
	applyMottleToImageData(img, x0, y0, dpr, o) {
		const amount = o.baseCoatMottle;
		const w = img.width;
		const h = img.height;
		const d = img.data;
		const nz = this.noise;

		// 兩個頻段 + 一層顆粒：
		//   mid   — 中頻雲斑，質感的主體 (吸水不均、批土痕)
		//   micro — 細頻的粗糙感
		//   speck — 每像素的顆粒，不做任何平滑
		//
		// 刻意「沒有」低頻大尺度層。加了之後每個色塊會出現一道橫跨整片的
		// 明暗漸層，看起來像被打光的 3D 面，而不是一片平塗的顏料。
		// 中世紀 / 現代主義的平面色塊在「平均值」上必須是平的。
		const ms = o.mottleMidScale;
		const fs = o.mottleFineScale;
		const off = this.mottleOffset;
		const speck = o.mottleSpeckle;
		const rng = this.rng;

		for (let j = 0; j < h; j += 1) {
			const py = (y0 + j) / dpr;
			for (let i = 0; i < w; i += 1) {
				const idx = (j * w + i) * 4;
				// 全透明的地方不要動 (色塊外、或是被乾擦挖掉的洞)
				const av = d[idx + 3];
				if (av === 0) {
					continue;
				}
				const px = (x0 + i) / dpr;

				const mid = nz.fbm(px * ms + off, py * ms + off, 4) - 0.5;
				const micro = nz.fbm(px * fs + off * 3, py * fs + off * 3, 2) - 0.5;
				// 顆粒不經過任何內插，才留得住「牙口」的鋭利感
				const grit = (rng() - 0.5) * speck;

				const n = mid * 1.0 + micro * 0.45 + grit;
				// 依 alpha 衰減：半透明的像素 (乾擦挖出來的洞的邊緣) 其 RGB
				// 是未預乘的，數值不可靠，直接照著加會把黑色帶進畫面。
				const delta = n * amount * 255 * 2.4 * (av / 255);

				// 三個通道給略微不同的係數，讓濃淡同時帶一點色溫變化，
				// 而不是單純的灰階明暗——這是顏料看起來「有顏色深度」的關鍵。
				d[idx] = clampByte(d[idx] + delta * 1.06);
				d[idx + 1] = clampByte(d[idx + 1] + delta * 1.0);
				d[idx + 2] = clampByte(d[idx + 2] + delta * 0.88);
			}
		}
	}

	/**
	 * 邊緣處理：沿著多邊形的邊再走一次淡筆，
	 * 讓邊界不是數學上的直線，而是有磨損、有溢出的手繪邊。
	 */
	scuffEdges(poly, col, o) {
		const strength = o.edgeScuff;
		for (let i = 0; i < poly.length; i += 1) {
			const a = poly[i];
			const b = poly[(i + 1) % poly.length];
			const len = Math.hypot(b.x - a.x, b.y - a.y);
			if (len < 1) {
				continue;
			}

			// 沿邊界的細筆，模擬顏料沿邊緣堆積或缺損
			const passes = 2;
			for (let p = 0; p < passes; p += 1) {
				const w = Math.max(1.5, len * 0.012) * this.random(0.6, 1.4);
				this.stroke(a.x, a.y, b.x, b.y, col, w, {
					strokeBody: 0,
					bristleAlpha: o.fillBristleAlpha * strength * this.random(0.4, 0.9),
					bristleDropout: 0.45,
					pathWobble: o.pathWobble * 1.6,
					bristleWaver: o.bristleWaver * 1.5,
				});
			}
		}
	}

	/* -------------------------------------------------------------- */
	/* 顆粒與整體質感                                                  */
	/* -------------------------------------------------------------- */

	/**
	 * 在指定範圍疊上顆粒 (畫布纖維 / 石灰牆的粗糙感)。
	 * 直接操作 pixels，比畫幾萬個點快很多。
	 * @param {object} opt {amount, scale, x, y, w, h, warm}
	 */
	grain(opt = {}) {
		const g = this.target;
		const amount = opt.amount ?? this.opts.grainAmount;
		const scale = opt.scale ?? this.opts.grainScale;
		if (amount <= 0) {
			return;
		}

		const x = Math.max(0, Math.floor(opt.x ?? 0));
		const y = Math.max(0, Math.floor(opt.y ?? 0));
		const w = Math.floor(opt.w ?? g.width - x);
		const h = Math.floor(opt.h ?? g.height - y);

		const ctx = g.drawingContext;
		const img = ctx.getImageData(x, y, w, h);
		const d = img.data;
		const rng = this.rng;
		const noiseRef = this.noise;

		// 低頻的「紙張凹凸」乘上高頻的隨機顆粒
		for (let j = 0; j < h; j += 1) {
			for (let i = 0; i < w; i += 1) {
				const idx = (j * w + i) * 4;

				// 高頻顆粒
				const speckle = (rng() - 0.5) * 2;
				// 低頻紙紋，讓顆粒有聚散
				const tooth = noiseRef.fbm(i * 0.02 * scale, j * 0.02 * scale, 3);

				// 暗處顆粒較明顯，模擬顏料沒填滿紙張凹陷
				const lum = (d[idx] * 0.299 + d[idx + 1] * 0.587 + d[idx + 2] * 0.114) / 255;
				const vis = lerp2(1.0, 0.55, lum);

				const delta = speckle * amount * 255 * lerp2(0.4, 1.0, tooth) * vis;

				d[idx] = Math.max(0, Math.min(255, d[idx] + delta));
				d[idx + 1] = Math.max(0, Math.min(255, d[idx + 1] + delta * 0.97));
				d[idx + 2] = Math.max(0, Math.min(255, d[idx + 2] + delta * 0.92));
			}
		}

		ctx.putImageData(img, x, y);
	}

	/**
	 * 底色 / 打底：一層帶紋理的底，讓後續色塊有東西可以「透出來」。
	 */
	ground(col, opt = {}) {
		const g = this.target;
		const rgb = toRgb(col);
		const w = g.width;
		const h = g.height;

		// ground() 代表一張新的畫開始，把上一輪殘留的待處理項目清掉
		this.mottleQueue = [];
		// 記下底色，乾擦時要用它把顏料「擦掉」的地方補回去
		this.groundColor = col;

		g.push();
		g.noStroke();
		g.fill(rgbaStr(rgb, 1));
		g.rect(0, 0, w, h);
		g.pop();

		// 底色的斑駁一樣交給 finish() 統一處理，避免和色塊的斑駁疊加兩次。
		// 排在佇列最前面，之後的色塊會覆蓋掉它們自己的範圍。
		// groundAmountOverride 用來從外部強制指定 (例如分離測試時要整層關掉)，
		// 因為 opt.amount 是呼叫端寫死的，會蓋過全域設定。
		const amount = this.groundAmountOverride ?? opt.amount ?? this.opts.baseCoatMottle;

		this.mottleQueue.push({
			poly: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }],
			minX: 0, minY: 0, maxX: w, maxY: h,
			opts: { baseCoatMottle: amount },
		});
	}
}

/* ------------------------------------------------------------------ */
/* 匯出                                                                */
/* ------------------------------------------------------------------ */

if (typeof module !== 'undefined' && module.exports) {
	module.exports = { PainterlyBrush, ValueNoise2D, makeRng, PAINTERLY_DEFAULTS };
}
