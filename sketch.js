/**
 * sketch.js — painterly stroke tool 的展示 / 調參用 sketch
 *
 * 四個模式，用鍵盤 1/2/3/4 切換：
 *   1. painting  — 重建參考畫作的構圖與質感
 *   2. swatches  — 色塊測試板，並排比較不同參數
 *   3. strokes   — 單筆筆觸測試，看刷毛細節
 *   4. compose   — 用同一套語彙生成新的作品 (每個 seed 一張)
 *
 * 其他按鍵：
 *   R  重新產生 (換一組隨機)
 *   S  存 PNG
 *   G  顆粒開關
 */

let brush;
let pg;
let mode = 'compose';
let seed = 20260815;
let grainOn = true;
let dirty = true;

// 參考畫作的調色盤。
// 全部是「礦物顏料」的登記 —— 彩度壓低、明度往粉筆的方向靠，
// 純度太高的藍或橘會立刻讓畫面看起來像向量圖而不是蛋彩。
const PALETTE = {
	cream: '#e5dcc9',
	creamLight: '#ece5d6',
	creamDark: '#d3c8b0',
	sand: '#c0a057',
	sandDark: '#a98c46',
	olive: '#8f8c3f',
	green: '#3a7460',
	greenDark: '#2e6052',
	blue: '#3a629c',
	blueLight: '#86b8cc',
	orange: '#ac6848',
	frame: '#1a1a1a',
};

const CANVAS_SIZE = 900;

function setup() {
	pixelDensity(2);
	const c = createCanvas(CANVAS_SIZE, CANVAS_SIZE);
	c.parent('sketch-holder');
	noLoop();
	rebuild();
	setupUI();
}

function rebuild() {
	randomSeed(seed);
	brush = new PainterlyBrush(this, { seed: seed });
	applyUIToBrush();
	dirty = true;
	redraw();
}

function draw() {
	background(PALETTE.creamLight);

	if (mode === 'painting') {
		drawPainting();
	} else if (mode === 'swatches') {
		drawSwatches();
	} else if (mode === 'compose') {
		drawComposition();
	} else {
		drawStrokes();
	}

	// 收尾：統一套用斑駁 + 顆粒
	brush.finish({ grain: grainOn });
}

/* ------------------------------------------------------------------ */
/* 模式 1：重建參考畫作                                                */
/* ------------------------------------------------------------------ */

function drawPainting() {
	const S = width;
	const p = (x, y) => [x * S, y * S];

	// 打底：溫暖的米白牆面
	brush.ground(PALETTE.cream, { amount: uiValues.groundAmount });

	// --- 背景大面：左上沙金 ---
	brush.fillPolygon(
		[p(0, 0), p(0.62, 0), p(0.45, 0.55), p(0, 0.45)],
		PALETTE.sand,
		{ angle: -0.35 }
	);

	// --- 綠色楔形 ---
	brush.fillPolygon(
		[p(0.10, 0.02), p(0.30, 0.02), p(0.42, 0.42), p(0.30, 0.45)],
		PALETTE.green,
		{ angle: 1.25 }
	);

	// --- 藍色大斜帶 ---
	brush.fillPolygon(
		[p(0.24, 0.10), p(0.44, 0.16), p(0.26, 0.86), p(0.02, 0.80)],
		PALETTE.blue,
		{ angle: 1.32 }
	);

	// --- 中央米白面 (主體) ---
	brush.fillPolygon(
		[p(0.42, 0.02), p(0.98, 0.02), p(0.98, 0.62), p(0.36, 0.95), p(0.20, 0.72)],
		PALETTE.creamLight,
		{ angle: -0.55 }
	);

	// --- 內凹的方框：暗面 ---
	brush.fillPolygon(
		[p(0.60, 0.24), p(0.88, 0.14), p(0.90, 0.50), p(0.62, 0.56)],
		PALETTE.creamDark,
		{ angle: 0.4 }
	);

	// --- 框內：橄欖綠 ---
	brush.fillPolygon(
		[p(0.66, 0.26), p(0.86, 0.20), p(0.87, 0.46), p(0.67, 0.48)],
		PALETTE.olive,
		{ angle: 1.5 }
	);

	// --- 框內：深綠三角 ---
	brush.fillPolygon(
		[p(0.63, 0.27), p(0.72, 0.25), p(0.71, 0.44), p(0.63, 0.42)],
		PALETTE.greenDark,
		{ angle: 1.5 }
	);

	// --- 淺藍條 ---
	brush.fillPolygon(
		[p(0.63, 0.42), p(0.89, 0.37), p(0.90, 0.47), p(0.64, 0.50)],
		PALETTE.blueLight,
		{ angle: 0.1 }
	);

	// --- 橘色帶 (畫面下方的重音) ---
	brush.fillPolygon(
		[p(0.60, 0.50), p(0.99, 0.44), p(0.99, 0.58), p(0.62, 0.60)],
		PALETTE.orange,
		{ angle: 0.08 }
	);

	// --- 底部沙金面 ---
	brush.fillPolygon(
		[p(0.24, 0.80), p(0.62, 0.60), p(0.99, 0.60), p(0.99, 0.78), p(0.40, 0.99), p(0.22, 0.92)],
		PALETTE.sandDark,
		{ angle: -0.18 }
	);

	// --- 前景米白斜面 (蓋住部分藍色) ---
	brush.fillPolygon(
		[p(0.30, 0.30), p(0.52, 0.40), p(0.40, 0.96), p(0.24, 0.88)],
		PALETTE.cream,
		{ angle: 1.4 }
	);
}

/* ------------------------------------------------------------------ */
/* 模式 4：生成一張新的作品                                            */
/* ------------------------------------------------------------------ */

/**
 * 不是複製參考畫作，而是用同一套語彙生成新的構圖。
 *
 * 參考畫作的結構可以歸納成四件事：
 *   1. 一個內凹的開口 (aperture)，畫面的視覺重心
 *   2. 幾個朝開口摺過去的大平面，製造「摺紙 / 盒子被剖開」的錯覺
 *   3. 一到兩道斜插的窄帶，把大平面切開、破壞對稱
 *   4. 恰好一個高彩度的重音色 (橘)，面積很小但位置關鍵
 *
 * 這裡把這四件事參數化，讓每個 seed 長出不同但同調的構圖。
 */
function drawComposition() {
	const S = width;
	const P = PALETTE;
	// 用 brush 的 rng，構圖才會跟著 seed 一起變
	const rnd = (lo, hi) => brush.random(lo, hi);
	const pick = (arr) => arr[Math.floor(brush.random(0, arr.length * 0.9999))];

	brush.ground(P.cream, { amount: uiValues.groundAmount });

	// --- 決定開口的位置與大小 ---
	// 刻意偏離中心，正中央會讓畫面變得像標靶
	const apX = rnd(0.42, 0.66);
	const apY = rnd(0.26, 0.44);
	const apW = rnd(0.24, 0.33);
	const apH = apW * rnd(0.72, 1.05);
	// 整體傾斜，讓開口不是正的矩形
	const tilt = rnd(-0.10, 0.10);

	// 把「開口座標系」的點轉回畫布座標
	const ap = (u, v) => {
		const cx = (u - 0.5) * apW;
		const cy = (v - 0.5) * apH;
		const c = Math.cos(tilt);
		const s = Math.sin(tilt);
		return [(apX + cx * c - cy * s) * S, (apY + cx * s + cy * c) * S];
	};

	// --- 背景：兩到三個大平面 ---
	// 從畫面外緣朝開口收攏，形成摺面
	const horizon = rnd(0.52, 0.68);
	const split = rnd(0.28, 0.46);

	// 左上大面
	brush.fillPolygon(
		[[0, 0], [split * S, 0], [apX * S, horizon * S], [0, rnd(0.42, 0.6) * S]],
		pick([P.sand, P.sandDark, P.olive]),
		{ angle: rnd(-0.6, 0.2) }
	);

	// 右上大面 (通常是最亮的一片，開口就座落在上面)
	brush.fillPolygon(
		[[split * S, 0], [S, 0], [S, rnd(0.5, 0.68) * S], [apX * S, horizon * S]],
		P.creamLight,
		{ angle: rnd(-0.5, 0.5) }
	);

	// 下方大面：接住上面兩片，把畫面壓穩
	brush.fillPolygon(
		[
			[0, rnd(0.66, 0.8) * S], [apX * S, horizon * S],
			[S, rnd(0.56, 0.72) * S], [S, S], [0, S],
		],
		pick([P.sandDark, P.sand, P.creamDark]),
		{ angle: rnd(-0.25, 0.25) }
	);

	// --- 斜插的窄帶：破壞大面的穩定 ---
	// 帶子要在中途「收掉」，不能從上緣一路貫穿到下緣——
	// 貫穿的帶子會變成壁紙上的條紋，讀不出它壓在哪個平面上。
	// 所以下緣收在 endY，並且做成楔形 (上寬下窄)，暗示它是摺面的一條稜。
	const bandCount = Math.round(rnd(1, 2.4));
	for (let i = 0; i < bandCount; i += 1) {
		const bx = rnd(0.06, 0.30);
		const topW = rnd(0.09, 0.16);
		const drift = rnd(-0.16, 0.08);
		const endY = rnd(0.62, 1.02);
		const taper = rnd(0.3, 0.85);
		brush.fillPolygon(
			[
				[bx * S, -0.02 * S],
				[(bx + topW) * S, -0.02 * S],
				[(bx + topW * taper + drift) * S, endY * S],
				[(bx + drift) * S, endY * S],
			],
			pick([P.blue, P.green, P.greenDark]),
			{ angle: rnd(1.2, 1.9) }
		);
	}

	// --- 開口的內壁 ---
	// 關鍵在「四邊厚度不等」：光從一邊進來，被照到的內壁看得到、
	// 背光的那兩邊幾乎看不到。四邊等寬的話會變成一個貼上去的相框，
	// 而不是一個凹進去的洞。
	const wallL = rnd(0.10, 0.20);
	const wallR = rnd(0.02, 0.06);
	const wallT = rnd(0.08, 0.16);
	const wallB = rnd(0.02, 0.05);

	// 亮的兩面 (上、左)：受光的內壁
	brush.fillPolygon(
		[ap(-wallL, -wallT), ap(1 + wallR, -wallT), ap(1 + wallR, 0), ap(0, 0), ap(0, 1), ap(-wallL, 1)],
		P.creamLight,
		{ angle: tilt + rnd(-0.3, 0.3) }
	);
	// 暗的兩面 (下、右)：背光的內壁，明顯暗一階
	brush.fillPolygon(
		[ap(1, 0), ap(1 + wallR, -wallT), ap(1 + wallR, 1 + wallB), ap(-wallL, 1 + wallB), ap(-wallL, 1), ap(1, 1)],
		P.creamDark,
		{ angle: tilt + rnd(-0.3, 0.3) }
	);

	// --- 開口內部：分成上下兩塊，模擬凹進去的兩個面 ---
	const inner = rnd(0.5, 0.68);
	brush.fillPolygon(
		[ap(0, 0), ap(1, 0), ap(1, inner), ap(0, inner)],
		pick([P.olive, P.green, P.sand]),
		{ angle: tilt + Math.PI / 2 }
	);
	brush.fillPolygon(
		[ap(0, inner), ap(1, inner), ap(1, 1), ap(0, 1)],
		P.blueLight,
		{ angle: tilt }
	);

	// 開口內的第三塊：深色角落。刻意不對齊開口的邊，
	// 讓它讀起來像「洞裡面的一個東西」而不是「洞的一部分」。
	const cw = rnd(0.28, 0.46);
	const cOff = rnd(-0.06, 0.04);
	brush.fillPolygon(
		[ap(cOff, rnd(-0.05, 0.06)), ap(cw, 0), ap(cw, inner * rnd(0.78, 1.02)), ap(cOff, inner)],
		P.greenDark,
		{ angle: tilt + Math.PI / 2 }
	);

	// --- 重音：橘色窄帶，壓在開口下緣 ---
	// 面積要小、位置要準，這是整張畫唯一的高彩度
	const accY = apY + apH * rnd(0.42, 0.6);
	const accH = rnd(0.055, 0.085);
	brush.fillPolygon(
		[
			[rnd(0.4, 0.56) * S, accY * S],
			[1.02 * S, (accY - rnd(0.01, 0.05)) * S],
			[1.02 * S, (accY + accH) * S],
			[rnd(0.42, 0.58) * S, (accY + accH + rnd(0, 0.03)) * S],
		],
		P.orange,
		{ angle: rnd(-0.1, 0.1) }
	);

	// --- 前景摺面：蓋掉一部分，製造「有東西在前面」的層次 ---
	if (brush.random(0, 1) < 0.75) {
		const fx = rnd(0.2, 0.42);
		brush.fillPolygon(
			[
				[fx * S, rnd(0.2, 0.36) * S],
				[(fx + rnd(0.12, 0.2)) * S, rnd(0.3, 0.46) * S],
				[(fx + rnd(0.04, 0.14)) * S, 1.02 * S],
				[(fx - rnd(0.02, 0.1)) * S, 1.02 * S],
			],
			P.cream,
			{ angle: rnd(1.2, 1.8) }
		);
	}
}

/* ------------------------------------------------------------------ */
/* 模式 2：色塊測試板                                                  */
/* ------------------------------------------------------------------ */

function drawSwatches() {
	brush.ground(PALETTE.cream, { amount: uiValues.groundAmount });

	const cols = 3;
	const rows = 3;
	const pad = width * 0.05;
	const cw = (width - pad * (cols + 1)) / cols;
	const ch = (height - pad * (rows + 1)) / rows;

	const colors = [
		PALETTE.sand, PALETTE.green, PALETTE.blue,
		PALETTE.orange, PALETTE.olive, PALETTE.blueLight,
		PALETTE.creamDark, PALETTE.greenDark, PALETTE.sandDark,
	];

	// 每格用不同的乾筆程度，方便挑參數
	const dropouts = [0.05, 0.18, 0.35];
	const densities = [0.35, 0.55, 0.9];

	let i = 0;
	for (let r = 0; r < rows; r += 1) {
		for (let c = 0; c < cols; c += 1) {
			const x = pad + c * (cw + pad);
			const y = pad + r * (ch + pad);
			brush.fillPolygon(
				[[x, y], [x + cw, y], [x + cw, y + ch], [x, y + ch]],
				colors[i],
				{
					angle: (i * 0.7) % Math.PI,
					brushWidth: cw * 0.16,
					bristleDropout: dropouts[c],
					bristleDensity: densities[r],
				}
			);
			i += 1;
		}
	}
}

/* ------------------------------------------------------------------ */
/* 模式 3：單筆筆觸                                                    */
/* ------------------------------------------------------------------ */

function drawStrokes() {
	brush.ground(PALETTE.cream, { amount: uiValues.groundAmount });

	const colors = [
		PALETTE.blue, PALETTE.orange, PALETTE.green,
		PALETTE.sand, PALETTE.greenDark, PALETTE.olive,
	];

	const n = 6;
	const margin = width * 0.09;
	const gap = (height - margin * 2) / (n - 1);

	// 全部用 pressureStroke：它才有頭尾提筆與末端崩解。
	// 一般的 stroke() 端點是 ROUND，會蓋成一個幾何上完美的半圓，
	// 那看起來像蓋章而不是收筆，不適合當單獨的表現性筆觸。
	for (let i = 0; i < n; i += 1) {
		const y = margin + i * gap;
		const w = lerp(12, 60, i / (n - 1));
		brush.pressureStroke(margin, y, width - margin, y + random(-20, 20), colors[i], w);
	}
}

/* ------------------------------------------------------------------ */
/* 控制面板                                                            */
/* ------------------------------------------------------------------ */

/**
 * 參數依「紋理層」分組。分組的用意不只是排版：
 * 每一組是一個獨立的視覺來源，可以整組靜音，用來判斷某個效果
 * 到底是哪一層造成的。
 *
 * groundAmount 特別重要：sketch 裡是用 brush.ground(col, {amount})
 * 明確傳值的，那個值會蓋過全域的 baseCoatMottle，所以它必須有
 * 自己的控制項，否則怎麼調 baseCoatMottle 都關不掉打底那層。
 */
const GROUPS = [
	{
		id: 'ground',
		title: '打底 (媒材)',
		note: '整張畫的底噪來源，跨色塊連續',
		controls: [
			{ key: 'groundAmount', min: 0, max: 0.2, step: 0.002, label: '打底斑駁' },
		],
	},
	{
		id: 'mottle',
		title: '斑駁 (顏料吸收)',
		note: '中頻雲斑',
		controls: [
			{ key: 'baseCoatMottle', min: 0, max: 0.25, step: 0.002, label: '斑駁強度' },
			{ key: 'mottleMidScale', min: 0.01, max: 0.25, step: 0.005, label: '雲斑頻率' },
			{ key: 'mottleFineScale', min: 0.05, max: 0.8, step: 0.01, label: '粗糙頻率' },
			{ key: 'mottleSpeckle', min: 0, max: 1.2, step: 0.02, label: '顆粒比重' },
			{ key: 'planeVariation', min: 0, max: 0.8, step: 0.02, label: '色塊差異' },
		],
	},
	{
		id: 'brush',
		title: '筆觸 (顏料)',
		note: '低頻大片柔斑的來源',
		controls: [
			{ key: 'fillStrokeBody', min: 0, max: 1, step: 0.01, label: '每筆顏料量' },
			{ key: 'fillBristleAlpha', min: 0, max: 0.3, step: 0.005, label: '刷毛濃度' },
			{ key: 'fillStrokeTone', min: 0, max: 0.3, step: 0.005, label: '每筆色差' },
			{ key: 'brushScale', min: 0.03, max: 0.4, step: 0.01, label: '筆刷寬度' },
			{ key: 'fillOverlap', min: 0.02, max: 0.85, step: 0.01, label: '筆畫重疊' },
			{ key: 'fillPasses', min: 1, max: 4, step: 1, label: '層數' },
			{ key: 'fillPassAngle', min: 0, max: 1.6, step: 0.02, label: '層間角度' },
			{ key: 'fillStrokeMinLen', min: 0.1, max: 1.15, step: 0.02, label: '短筆比例' },
			{ key: 'baseCoatLift', min: 0, max: 0.5, step: 0.01, label: '底色提亮' },
			{ key: 'bristleDensity', min: 0.15, max: 1.5, step: 0.01, label: '刷毛密度' },
			{ key: 'bristleDropout', min: 0, max: 0.7, step: 0.01, label: '刷毛缺損' },
			{ key: 'bristleWaver', min: 0, max: 4, step: 0.05, label: '刷毛飄移' },
		],
	},
	{
		id: 'grain',
		title: '顆粒',
		note: '高頻細沙',
		controls: [
			{ key: 'grainAmount', min: 0, max: 0.35, step: 0.002, label: '顆粒強度' },
			{ key: 'grainScale', min: 0.2, max: 3, step: 0.05, label: '顆粒密度' },
		],
	},
	{
		id: 'edge',
		title: '邊緣',
		note: '色塊交界的處理',
		controls: [
			{ key: 'edgePool', min: 0, max: 0.4, step: 0.01, label: '邊緣堆積' },
			{ key: 'edgeScuff', min: 0, max: 1.5, step: 0.05, label: '邊緣磨損' },
		],
	},
	{
		id: 'stroke',
		title: '單筆 (模式 3)',
		note: '只影響 pressureStroke',
		controls: [
			{ key: 'strokeBody', min: 0, max: 1, step: 0.01, label: '筆身濃度' },
			{ key: 'skipAmount', min: 0, max: 0.9, step: 0.02, label: '乾擦強度' },
			{ key: 'pathWobble', min: 0, max: 8, step: 0.1, label: '筆畫彎曲' },
			{ key: 'hueDrift', min: 0, max: 3, step: 0.05, label: '色相偏移' },
		],
	},
];

const CONTROLS = GROUPS.flatMap((g) => g.controls);

// 每一組被靜音時要歸零的參數
const MUTE_KEYS = {
	ground: ['groundAmount'],
	mottle: ['baseCoatMottle'],
	brush: ['fillStrokeBody', 'fillBristleAlpha', 'baseCoatLift'],
	grain: ['grainAmount'],
	edge: ['edgePool', 'edgeScuff'],
	stroke: ['strokeBody', 'skipAmount'],
};

const muted = {};

const uiValues = {};

// groundAmount 不是 PainterlyBrush 的參數 (它是 ground() 的呼叫參數)，
// 所以預設值要另外給
const UI_EXTRA_DEFAULTS = {
	groundAmount: 0.06,
};

const inputRefs = {};

function setupUI() {
	const panel = document.getElementById('controls');
	if (!panel) {
		return;
	}

	// 先把所有預設值填好
	for (const ctl of CONTROLS) {
		uiValues[ctl.key] = UI_EXTRA_DEFAULTS[ctl.key] ?? PAINTERLY_DEFAULTS[ctl.key];
	}

	buildPresets(panel);

	for (const group of GROUPS) {
		muted[group.id] = false;

		const sec = document.createElement('section');
		sec.className = 'grp';

		const head = document.createElement('div');
		head.className = 'grp-head';

		const title = document.createElement('div');
		title.className = 'grp-title';
		title.innerHTML = `${group.title}<em>${group.note}</em>`;

		// 靜音鈕：把整組歸零，再按一次還原。
		// 判斷某個效果是哪一層造成的時候，這個比一根根拉快得多。
		const mute = document.createElement('button');
		mute.className = 'mute';
		mute.textContent = '靜音';
		mute.addEventListener('click', () => {
			muted[group.id] = !muted[group.id];
			mute.classList.toggle('on', muted[group.id]);
			sec.classList.toggle('muted', muted[group.id]);
			applyUIToBrush();
			rerender();
		});

		head.appendChild(title);
		head.appendChild(mute);
		sec.appendChild(head);

		for (const ctl of group.controls) {
			sec.appendChild(buildRow(ctl));
		}
		panel.appendChild(sec);
	}
}

function buildRow(ctl) {
	const row = document.createElement('div');
	row.className = 'ctl';

	const label = document.createElement('label');
	label.appendChild(document.createTextNode(ctl.label));

	// 數值可以直接輸入，滑桿拉不到的精度用打的
	const val = document.createElement('input');
	val.type = 'number';
	val.className = 'val';
	val.min = ctl.min;
	val.max = ctl.max;
	val.step = ctl.step;
	val.value = uiValues[ctl.key];
	label.appendChild(val);

	const input = document.createElement('input');
	input.type = 'range';
	input.min = ctl.min;
	input.max = ctl.max;
	input.step = ctl.step;
	input.value = uiValues[ctl.key];

	const commit = (v) => {
		uiValues[ctl.key] = v;
		input.value = v;
		val.value = v;
		applyUIToBrush();
		rerender();
	};

	input.addEventListener('input', () => commit(parseFloat(input.value)));
	val.addEventListener('change', () => commit(parseFloat(val.value)));

	inputRefs[ctl.key] = { input, val };

	row.appendChild(label);
	row.appendChild(input);
	return row;
}

// 幾組常用的起點
const PRESETS = {
	'目前': {},
	'極簡 (無紋理)': {
		groundAmount: 0, baseCoatMottle: 0, grainAmount: 0,
		fillStrokeBody: 0, fillBristleAlpha: 0, baseCoatLift: 0,
		edgePool: 0, edgeScuff: 0,
	},
	'乾淨': {
		groundAmount: 0.02, baseCoatMottle: 0.008, grainAmount: 0.01,
		fillStrokeBody: 0.28, fillStrokeTone: 0.06,
	},
	'厚塗': {
		groundAmount: 0.05, baseCoatMottle: 0.03, grainAmount: 0.02,
		fillStrokeBody: 0.5, fillStrokeTone: 0.14, brushScale: 0.22,
		fillOverlap: 0.08,
	},
	'壁畫': {
		groundAmount: 0.09, baseCoatMottle: 0.08, grainAmount: 0.06,
		fillStrokeBody: 0.2, fillStrokeTone: 0.07, brushScale: 0.1,
	},
};

function buildPresets(panel) {
	const box = document.createElement('div');
	box.className = 'presets';
	for (const name of Object.keys(PRESETS)) {
		const b = document.createElement('button');
		b.textContent = name;
		b.addEventListener('click', () => {
			Object.assign(uiValues, PRESETS[name]);
			syncInputs();
			applyUIToBrush();
			rerender();
		});
		box.appendChild(b);
	}
	panel.appendChild(box);
}

function syncInputs() {
	for (const key in inputRefs) {
		if (uiValues[key] !== undefined) {
			inputRefs[key].input.value = uiValues[key];
			inputRefs[key].val.value = uiValues[key];
		}
	}
}

/** 重畫。重置 rng，讓調參前後的構圖完全一樣，只有紋理不同。 */
function rerender() {
	if (brush) {
		brush.rng = makeRng(seed);
	}
	redraw();
}

function applyUIToBrush() {
	if (!brush) {
		return;
	}
	const opts = Object.assign({}, uiValues);
	// 靜音的組別整組歸零
	for (const id in muted) {
		if (muted[id]) {
			for (const k of MUTE_KEYS[id]) {
				opts[k] = 0;
			}
		}
	}
	brush.setOptions(opts);
	// groundAmount 走的是 ground() 的呼叫參數，不在 brush.opts 裡，
	// 所以要另外用 override 傳給它
	brush.groundAmountOverride = opts.groundAmount;
}

/* ------------------------------------------------------------------ */
/* 鍵盤                                                                */
/* ------------------------------------------------------------------ */

function keyPressed() {
	if (key === '1') {
		mode = 'painting';
		rebuild();
	} else if (key === '2') {
		mode = 'swatches';
		rebuild();
	} else if (key === '3') {
		mode = 'strokes';
		rebuild();
	} else if (key === '4') {
		mode = 'compose';
		rebuild();
	} else if (key === 'r' || key === 'R') {
		seed = Math.floor(Math.random() * 1e9);
		rebuild();
	} else if (key === 'g' || key === 'G') {
		grainOn = !grainOn;
		brush.rng = makeRng(seed);
		redraw();
	} else if (key === 's' || key === 'S') {
		saveCanvas(`painterly-${mode}-${seed}`, 'png');
	}
}
