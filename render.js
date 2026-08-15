/**
 * render.js — 用 headless Chrome 把各模式輸出成 PNG。
 *
 * 用法：
 *   node render.js [outDir]
 *
 * 需要先啟動靜態 server (預設 http://localhost:8777)。
 * 透過 CDP 直接跟 Chrome 溝通，不需要額外的 npm 套件。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = process.env.CDP_PORT ? parseInt(process.env.CDP_PORT, 10) : 9333;
const BASE = process.env.BASE_URL || 'http://localhost:8777';
const OUT = process.argv[2] || path.join(__dirname, 'examples');

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

/** 極簡 CDP client，只用到 Runtime.evaluate 與 Page.captureScreenshot */
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

async function main() {
	fs.mkdirSync(OUT, { recursive: true });

	const userDir = path.join(require('os').tmpdir(), 'painterly-chrome-profile');
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

	// 等 CDP 起來
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

	// 等 sketch 準備好
	for (let i = 0; i < 120; i += 1) {
		const ready = await cdp.evaluate('!!window.__ready && !!window.grab');
		if (ready) {
			break;
		}
		await sleep(250);
	}
	await sleep(600);

	const jobs = process.env.COMPOSE_ONLY
		? [
			{ mode: 'compose', seed: 11021, name: 'c1' },
			{ mode: 'compose', seed: 33507, name: 'c2' },
			{ mode: 'compose', seed: 60142, name: 'c3' },
			{ mode: 'compose', seed: 88310, name: 'c4' },
		]
		: [
			{ mode: 'painting', seed: 20260815, name: '01-painting' },
			{ mode: 'painting', seed: 777001, name: '02-painting-alt' },
			{ mode: 'swatches', seed: 4242, name: '03-swatches' },
			{ mode: 'strokes', seed: 909090, name: '04-strokes' },
			{ mode: 'compose', seed: 88310, name: '05-compose' },
		];

	for (const job of jobs) {
		await cdp.evaluate(`window.renderMode(${JSON.stringify(job.mode)}, ${job.seed})`);
		await sleep(900);
		const dataUrl = await cdp.evaluate('window.grab()');
		const b64 = dataUrl.split(',')[1];
		const file = path.join(OUT, `${job.name}.png`);
		fs.writeFileSync(file, Buffer.from(b64, 'base64'));
		console.log('wrote', file);
	}

	ws.close();
	chrome.kill();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
