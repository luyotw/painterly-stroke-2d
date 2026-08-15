/**
 * ws-lite.js — 極簡 WebSocket client，只為了跟本機 Chrome DevTools Protocol 溝通。
 * 不處理 TLS、不處理分片以外的邊界情況，夠用即可，避免引入 npm 依賴。
 */

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class WsLite extends EventEmitter {
	constructor(url) {
		super();
		this.url = url;
		this.buffer = Buffer.alloc(0);
		this.readyPromise = this._connect();
	}

	ready() {
		return this.readyPromise;
	}

	_connect() {
		return new Promise((resolve, reject) => {
			const u = new URL(this.url);
			const key = crypto.randomBytes(16).toString('base64');

			const req = http.request({
				hostname: u.hostname,
				port: u.port || 80,
				path: u.pathname + u.search,
				headers: {
					Connection: 'Upgrade',
					Upgrade: 'websocket',
					'Sec-WebSocket-Key': key,
					'Sec-WebSocket-Version': '13',
				},
			});

			req.on('upgrade', (res, socket) => {
				this.socket = socket;
				socket.on('data', (chunk) => this._onData(chunk));
				socket.on('close', () => this.emit('close'));
				socket.on('error', (e) => this.emit('error', e));
				resolve(this);
			});

			req.on('error', reject);
			req.end();
		});
	}

	_onData(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		// 逐個解析完整的 frame
		for (;;) {
			if (this.buffer.length < 2) {
				return;
			}
			const b1 = this.buffer[1];
			const masked = (b1 & 0x80) !== 0;
			let len = b1 & 0x7f;
			let offset = 2;

			if (len === 126) {
				if (this.buffer.length < 4) return;
				len = this.buffer.readUInt16BE(2);
				offset = 4;
			} else if (len === 127) {
				if (this.buffer.length < 10) return;
				len = Number(this.buffer.readBigUInt64BE(2));
				offset = 10;
			}

			// server -> client 通常不遮罩，但仍保留處理
			let maskKey = null;
			if (masked) {
				if (this.buffer.length < offset + 4) return;
				maskKey = this.buffer.subarray(offset, offset + 4);
				offset += 4;
			}

			if (this.buffer.length < offset + len) {
				return;
			}

			let payload = this.buffer.subarray(offset, offset + len);
			if (maskKey) {
				const out = Buffer.allocUnsafe(len);
				for (let i = 0; i < len; i += 1) {
					out[i] = payload[i] ^ maskKey[i % 4];
				}
				payload = out;
			}

			this.buffer = this.buffer.subarray(offset + len);
			this.emit('message', payload);
		}
	}

	send(str) {
		const payload = Buffer.from(str, 'utf8');
		const len = payload.length;
		let header;
		const maskKey = crypto.randomBytes(4);

		if (len < 126) {
			header = Buffer.alloc(2 + 4);
			header[1] = 0x80 | len;
			maskKey.copy(header, 2);
		} else if (len < 65536) {
			header = Buffer.alloc(4 + 4);
			header[1] = 0x80 | 126;
			header.writeUInt16BE(len, 2);
			maskKey.copy(header, 4);
		} else {
			header = Buffer.alloc(10 + 4);
			header[1] = 0x80 | 127;
			header.writeBigUInt64BE(BigInt(len), 2);
			maskKey.copy(header, 10);
		}
		header[0] = 0x81; // FIN + text frame

		const masked = Buffer.allocUnsafe(len);
		for (let i = 0; i < len; i += 1) {
			masked[i] = payload[i] ^ maskKey[i % 4];
		}

		this.socket.write(Buffer.concat([header, masked]));
	}

	close() {
		if (this.socket) {
			this.socket.end();
		}
	}
}

module.exports = WsLite;
