const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    delay
} = require('@itsliaaa/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const db = require('../database/db');

const logger = pino({ level: 'silent' });
const userSessions = {};
const connectionLocks = new Set();
const connectionTimers = {};
const pairingInProgress = {};

// Cache de Metadata do Grupo
const groupMetadataCache = new Map();
const GROUP_CACHE_TTL = 5 * 60 * 1000; 

function gaussianJitter(baseMs, stdDevMs = 0) {
    stdDevMs = stdDevMs || baseMs * 0.25;
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const result = Math.round(baseMs + n * stdDevMs);
    return Math.max(100, result);
}

function classifyDisconnect(statusCode) {
    const codes = {
        401: { cat: 'fatal',       reconnect: false, backoffMs: 0,      msg: 'Deslogado (401)' },
        403: { cat: 'fatal',       reconnect: false, backoffMs: 0,      msg: 'Acesso negado (403)' },
        408: { cat: 'recoverable', reconnect: true,  backoffMs: 5000,   msg: 'Timeout (408)' },
        428: { cat: 'recoverable', reconnect: true,  backoffMs: 3000,   msg: 'Conexão substituída (428)' },
        429: { cat: 'rate-limit',  reconnect: true,  backoffMs: 60000,  msg: 'Rate limit (429) — aguardando 60s' },
        440: { cat: 'fatal',       reconnect: false, backoffMs: 0,      msg: 'Deslogado (440)' },
        500: { cat: 'recoverable', reconnect: true,  backoffMs: 10000,  msg: 'Erro interno WA (500)' },
        503: { cat: 'recoverable', reconnect: true,  backoffMs: 15000,  msg: 'Serviço indisponível (503)' },
        515: { cat: 'recoverable', reconnect: true,  backoffMs: 1000,   msg: 'Reinicio obrigatório (515)' },
    };
    return codes[statusCode] || { cat: 'unknown', reconnect: true, backoffMs: 5000, msg: `Código desconhecido (${statusCode})` };
}

// Rastreamento de saúde
const sessionHealth = {};
function recordBadMac(tid) {
    if (!sessionHealth[tid]) sessionHealth[tid] = { badMac: 0, success: 0 };
    sessionHealth[tid].badMac++;
}
function recordDecryptSuccess(tid) {
    if (!sessionHealth[tid]) sessionHealth[tid] = { badMac: 0, success: 0 };
    sessionHealth[tid].success++;
}

async function connectToWhatsApp(tid, ctx = null, getMainMenu = null) {
    if (connectionLocks.has(tid)) {
        return userSessions[tid];
    }
    connectionLocks.add(tid);
    try {
        return await _connectToWhatsAppInner(tid, ctx, getMainMenu);
    } finally {
        connectionLocks.delete(tid);
    }
}

async function _connectToWhatsAppInner(tid, ctx = null, getMainMenu = null) {
    const sessionDir = path.join(__dirname, `../../sessions/${tid}`);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    let version;
    try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
    } catch (e) {
        version = [2, 3000, 1015901307];
    }

    if (userSessions[tid]) {
        try {
            userSessions[tid].ev.removeAllListeners();
            userSessions[tid].end();
        } catch (e) { }
    }

    const sock = makeWASocket({
        version,
        logger,
        auth: state,
        browser: ["Windows", "Chrome", "11.0.7"],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        printQRInTerminal: false,
        mobile: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        defaultQueryTimeoutMs: 60000,
        retryRequestDelayMs: gaussianJitter(5000, 1000),
        generateHighQualityLinkPreview: true,
        cachedGroupMetadata: async (jid) => {
            const cached = groupMetadataCache.get(jid);
            if (cached && (Date.now() - cached.ts) < GROUP_CACHE_TTL) return cached.data;
            return undefined;
        }
    });

    userSessions[tid] = sock;
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const classify = classifyDisconnect(statusCode);

            if (!classify.reconnect) {
                if (statusCode === 403) {
                    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                    if (ctx) ctx.reply(`🚫 *ACESSO NEGADO (403)*\n\nConexão rejeitada.`, { parse_mode: 'Markdown' }).catch(() => {});
                } else {
                    if (ctx) ctx.reply(`⚠️ *SESSÃO ENCERRADA*\n\n${classify.msg}`, { parse_mode: 'Markdown' }).catch(() => {});
                }
                delete userSessions[tid];
                return;
            }

            const backoff = gaussianJitter(classify.backoffMs || 5000, 1000);
            setTimeout(() => connectToWhatsApp(tid, ctx, getMainMenu), backoff);

        } else if (connection === 'open') {
            delete pairingInProgress[tid];
            if (ctx) {
                ctx.reply(`✅ *CONEXÃO ESTABELECIDA!*\n\nInstância CORVO Elite ativa e pronta.`, { parse_mode: 'Markdown' }).catch(() => {});
            }
            setTimeout(async () => {
                try { await sock.sendPresenceUpdate('available'); } catch(e) {}
            }, gaussianJitter(3000, 800));
        }
    });

    sock.ev.on('messages.update', (updates) => {
        for (const { update } of updates) {
            if (update?.messageStubType === 2) {
                recordBadMac(tid);
            } else if (update?.status) {
                recordDecryptSuccess(tid);
            }
        }
    });

    return sock;
}

module.exports = {
    connectToWhatsApp,
    userSessions,
    pairingInProgress,
    connectionTimers
};
