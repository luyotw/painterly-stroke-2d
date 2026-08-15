/**
 * render-isolate.js — 分離測試：一次只留一層紋理，另外兩層全關。
 *
 * 三層分別是：
 *   1. 斑駁 (mottle)  — 媒材本身，會跨色塊連續
 *   2. 筆觸 (brush)   — 顏料刷上去的痕跡
 *   3. 顆粒 (grain)   — 最後疊的細顆粒
 *
 * 用來確認每一層各自貢獻了什麼，方便判斷該調哪一個。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = process.env.CDP_PORT ? parseInt(process.env.CDP_PORT, 10) : 9355;
const BASE = process.env.BASE_URL || 'http://localhost:8777';
const OUT = path.join(__dirname, 'examples');
const SEED = 88310;

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function getJson(url) {
	return new Promise((resolve, reject) => {
		http.get(url, (res) => {
			let data = '';
			res.on('data', (c) => (data += c));
			res.on('end', () => {
				try {
					resolve(JSON.parse(data));
				} catch (e) {
					reject(e);
				}
			});
		}).on('error', reject);
	});
}

class Cdp {
	constructor(ws) {
		this.ws = ws;
		this.id = 0;
		this.pending = new Map();
		ws.on('message', (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.id && this.pending.has(msg.id)) {
				const { resolve, reject } = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				if (msg.error) {
					reject(new Error(JSON.stringify(msg.error)));
				} else {
					resolve(msg.result);
				}
			}
		});
	}

	send(method, params = {}) {
		const id = ++this.id;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	async evaluate(expression) {
		const res = await this.send('Runtime.evaluate', {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (res.exceptionDetails) {
			throw new Error(res.exceptionDetails.text + ' ' +
				JSON.stringify(res.exceptionDetails.exception && res.exceptionDetails.exception.description));
		}
		return res.result.value;
	}
}

// 三種設定。關掉某一層就把它的參數歸零。
//
// 注意：筆觸關掉時 baseCoatLift 也要歸零，
// 否則底色會停在「比目標色亮」的狀態，顏色會整片偏淡。
// 「關掉」= 把該層所有相關參數設成 0。
//
// 要注意的不只是主參數，還有幾個容易漏掉的：
//   - edgePool     色塊邊緣內側的顏料堆積，屬於「筆觸/顏料」那一層
//   - edgeScuff    邊緣磨損，同上
//   - baseCoatLift 底色提亮，只有在有筆觸要壓下來時才成立
// 漏掉這些的話三張圖會殘留共同的成分，量出來的數字就分不開。
//
// mottleSpeckle 不用另外歸零：它在 applyMottleToImageData() 裡是乘上
// baseCoatMottle 的，主參數歸零就整層關掉了。
const OFF_BRUSH = {
	fillStrokeBody: 0,
	fillBristleAlpha: 0,
	baseCoatLift: 0,
	edgePool: 0,
	edgeScuff: 0,
};

const ON_BRUSH = {
	fillStrokeBody: 0.34,
	fillBristleAlpha: 0.11,
	baseCoatLift: 0.16,
	edgePool: 0.10,
	edgeScuff: 0.5,
};

const CASES = [
	{
		name: 'iso-1-mottle-only',
		label: '只留斑駁',
		opts: Object.assign({ baseCoatMottle: 0.05, grainAmount: 0 }, OFF_BRUSH),
	},
	{
		name: 'iso-2-brush-only',
		label: '只留筆觸',
		opts: Object.assign({ baseCoatMottle: 0, grainAmount: 0 }, ON_BRUSH),
	},
	{
		name: 'iso-3-grain-only',
		label: '只留顆粒',
		opts: Object.assign({ baseCoatMottle: 0, grainAmount: 0.055 }, OFF_BRUSH),
	},
	{
		// 對照組：三層全關。剩下的東西就是「不屬於任何一層」的，
		// 也就是構圖本身 (半透明色塊互相重疊) 造成的明暗。
		//
		// 注意 groundAmount：drawComposition() 是用 brush.ground(col, {amount: 0.06})
		// 明確傳參數的，那個值會蓋過全域的 baseCoatMottle，
		// 所以光把 baseCoatMottle 設 0 並不會關掉打底那層的斑駁。
		name: 'iso-0-none',
		label: '三層全關 (打底仍有紋理)',
		opts: Object.assign({ baseCoatMottle: 0, grainAmount: 0 }, OFF_BRUSH),
	},
	{
		// 真正的全零：連打底的紋理也關掉。
		// 這張應該是完全平的色塊，只剩下半透明色塊重疊造成的明暗。
		name: 'iso-00-flat',
		label: '全部歸零 (含打底)',
		opts: Object.assign({ baseCoatMottle: 0, grainAmount: 0 }, OFF_BRUSH),
		groundAmount: 0,
	},
];

async function main() {
	fs.mkdirSync(OUT, { recursive: true });

	const userDir = path.join(require('os').tmpdir(), 'painterly-iso-profile');
	const chrome = spawn(CHROME, [
		'--headless=new',
		`--remote-debugging-port=${PORT}`,
		`--user-data-dir=${userDir}`,
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-gpu',
		'--hide-scrollbars',
		'--window-size=2000,2000',
		'about:blank',
	], { stdio: 'ignore' });

	let version = null;
	for (let i = 0; i < 60; i += 1) {
		try {
			version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
			break;
		} catch (e) {
			await sleep(250);
		}
	}
	if (!version) {
		chrome.kill();
		throw new Error('Chrome CDP did not start');
	}

	const WebSocket = require('./ws-lite.js');
	const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
	const page = targets.find((t) => t.type === 'page');
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await ws.ready();
	const cdp = new Cdp(ws);

	await cdp.send('Page.enable');
	await cdp.send('Runtime.enable');
	await cdp.send('Page.navigate', { url: `${BASE}/render.html` });

	for (let i = 0; i < 120; i += 1) {
		if (await cdp.evaluate('!!window.__ready && !!window.grab')) {
			break;
		}
		await sleep(250);
	}
	await sleep(600);

	for (const c of CASES) {
		// 每次都重新以同一個 seed 建 brush，構圖才會完全一樣，
		// 三張圖才有可比性。
		//
		// 有些參數 (fillStrokeBody / baseCoatLift) 沒有掛在 UI 上，
		// uiValues 不會帶到，所以在 rebuild() 之後直接寫進 brush.opts，
		// 再手動重畫一次。
		await cdp.evaluate(`
			(() => {
				mode = 'compose';
				seed = ${SEED};
				Object.assign(uiValues, ${JSON.stringify(c.opts)});
				rebuild();
				brush.setOptions(${JSON.stringify(c.opts)});
				brush.groundAmountOverride = ${c.groundAmount === undefined ? 'undefined' : c.groundAmount};
				brush.rng = makeRng(seed);
				redraw();
				return true;
			})()
		`);
		await sleep(1200);
		const dataUrl = await cdp.evaluate('window.grab()');
		const file = path.join(OUT, `${c.name}.png`);
		fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
		console.log('wrote', file, `(${c.label})`);
	}

	ws.close();
	chrome.kill();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
