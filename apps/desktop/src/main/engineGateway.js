const WebSocket = require('ws');
const { normalizeEngineEvent, EngineEvent } = require('../shared/events');

const DEFAULT_RECONNECT_MS = 1500;
const DEFAULT_THROTTLE_MS = {
    'spectrum.data': 33
};

function toWsUrl(httpUrl) {
    try {
        const url = new URL(httpUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.pathname = '/ws';
        url.search = '';
        return url.toString();
    } catch (_err) {
        return 'ws://127.0.0.1:55554/ws';
    }
}

class EngineGateway {
    constructor({ engineUrl, emitEvent, throttleMs = DEFAULT_THROTTLE_MS }) {
        this.engineUrl = engineUrl;
        this.emitEvent = emitEvent;
        this.throttleMs = throttleMs;
        this.ws = null;
        this.fetch = null;
        this.reconnectTimer = null;
        this.lastEmitAt = new Map();
    }

    async ensureFetch() {
        if (this.fetch) return this.fetch;
        if (global.fetch) {
            this.fetch = global.fetch.bind(global);
            return this.fetch;
        }
        const module = await import('node-fetch');
        this.fetch = module.default;
        return this.fetch;
    }

    emit(rawEvent) {
        if (!this.emitEvent) return;
        const parsed = EngineEvent.safeParse(rawEvent);
        if (!parsed.success) return;
        this.emitEvent(parsed.data);
    }

    emitStatus(connected, message) {
        this.emit({ type: 'engine.status', connected, message });
    }

    async refreshState() {
        try {
            const fetch = await this.ensureFetch();
            const res = await fetch(`${this.engineUrl}/state`, { method: 'GET' });
            if (!res.ok) return false;
            const payload = await res.json().catch(() => null);
            if (payload && payload.state) {
                this.emit({ type: 'playback.state', state: payload.state });
                this.emitStatus(true, 'state refreshed');
                return true;
            }
            return false;
        } catch (_err) {
            // Silent fallback; WS reconnects are already handled.
            return false;
        }
    }

    shouldEmit(type) {
        const limit = this.throttleMs[type];
        if (!limit) return true;
        const now = Date.now();
        const last = this.lastEmitAt.get(type) || 0;
        if (now - last < limit) return false;
        this.lastEmitAt.set(type, now);
        return true;
    }

    connectWs() {
        const wsUrl = toWsUrl(this.engineUrl);
        const ws = new WebSocket(wsUrl);
        this.ws = ws;

        ws.on('open', () => {
            this.emitStatus(true, 'connected');
            this.refreshState();
        });

        ws.on('message', (data) => {
            let payload;
            try {
                payload = JSON.parse(data.toString());
            } catch (_err) {
                return;
            }
            const normalized = normalizeEngineEvent(payload);
            if (!normalized) return;
            if (!this.shouldEmit(normalized.type)) return;
            this.emit(normalized);
        });

        ws.on('close', () => {
            this.ws = null;
            this.emitStatus(false, 'disconnected');
            this.scheduleReconnect();
        });

        ws.on('error', () => {
            ws.close();
        });
    }

    scheduleReconnect() {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connectWs();
        }, DEFAULT_RECONNECT_MS);
    }

    async request(endpoint, { method = 'GET', body } = {}) {
        const fetch = await this.ensureFetch();
        const url = `${this.engineUrl}${endpoint}`;
        const options = {
            method,
            headers: { 'Content-Type': 'application/json' }
        };
        if (body) {
            options.body = JSON.stringify(body);
        }
        const response = await fetch(url, options);
        const text = await response.text();
        if (!response.ok) {
            const message = text || `HTTP ${response.status}`;
            this.emit({ type: 'error', code: 'http_error', message });
            throw new Error(message);
        }
        try {
            return JSON.parse(text);
        } catch (_err) {
            return text;
        }
    }

    async command(name, payload) {
        switch (name) {
            case 'state':
                return this.request('/state', { method: 'GET' });
            case 'play':
                return this.request('/play', { method: 'POST' });
            case 'pause':
                return this.request('/pause', { method: 'POST' });
            case 'stop':
                return this.request('/stop', { method: 'POST' });
            case 'seek':
                return this.request('/seek', { method: 'POST', body: payload });
            case 'load':
                return this.request('/load', { method: 'POST', body: payload });
            case 'set-volume':
                return this.request('/volume', { method: 'POST', body: payload });
            case 'get-devices':
                return this.request('/devices', { method: 'GET' });
            case 'configure-output':
                return this.request('/configure_output', { method: 'POST', body: payload });
            case 'set-eq':
                return this.request('/set_eq', { method: 'POST', body: payload });
            case 'set-eq-type':
                return this.request('/set_eq_type', { method: 'POST', body: payload });
            case 'configure-optimizations':
                return this.request('/configure_optimizations', { method: 'POST', body: payload });
            case 'configure-upsampling':
                return this.request('/configure_upsampling', { method: 'POST', body: payload });
            case 'load-stream':
                return this.request('/load_stream', { method: 'POST', body: payload });
            case 'capture-start':
                return this.request('/capture/start', { method: 'POST', body: payload || {} });
            case 'capture-stop':
                return this.request('/capture/stop', { method: 'POST' });
            case 'get-capture-devices':
                return this.request('/capture/devices', { method: 'GET' });
            case 'spectrum-ws':
                return this.request('/spectrum/ws', { method: 'POST', body: payload });
            default:
                throw new Error(`Unknown engine command: ${name}`);
        }
    }
}

module.exports = { EngineGateway };
