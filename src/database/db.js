const fs = require('fs');
const path = require('path');

const VIP_FILE = path.join(__dirname, '../../data/vips.json');
const PAYMENTS_FILE = path.join(__dirname, '../../data/payments.json');
const USAGE_FILE = path.join(__dirname, '../../data/usage.json');
const STATS_FILE = path.join(__dirname, '../../data/stats.json');
const USERS_DATA_FILE = path.join(__dirname, '../../data/users_data.json');
const USERS_FILE = path.join(__dirname, '../../data/users.json');

// Criar pasta de dados se não existir
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

let vips = {};
let pendingPayments = {};
let userUsage = {};
let globalStats = {
    nukedGroups: 0,
    rajarGroups: 0,
    messagesSent: 0
};
let usersData = {};
let totalUsers = new Set();

// Carregar arquivos JSON
try {
    if (fs.existsSync(VIP_FILE)) vips = JSON.parse(fs.readFileSync(VIP_FILE, 'utf8'));
    if (fs.existsSync(PAYMENTS_FILE)) pendingPayments = JSON.parse(fs.readFileSync(PAYMENTS_FILE, 'utf8'));
    if (fs.existsSync(USAGE_FILE)) userUsage = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (fs.existsSync(STATS_FILE)) globalStats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    if (fs.existsSync(USERS_DATA_FILE)) usersData = JSON.parse(fs.readFileSync(USERS_DATA_FILE, 'utf8'));
    if (fs.existsSync(USERS_FILE)) totalUsers = new Set(JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')));
} catch (e) {
    console.error('Erro ao carregar banco de dados JSON:', e.message);
}

// Salvar arquivos com debounce (Batch Saves)
let pendingSaves = {};

function scheduleSave(filePath, data, key) {
    if (pendingSaves[key]) return;
    pendingSaves[key] = true;
    setTimeout(() => {
        try {
            const content = key === 'users' ? JSON.stringify(Array.from(data), null, 2) : JSON.stringify(data, null, 2);
            fs.writeFileSync(filePath, content, 'utf8');
        } catch (e) {
            console.error(`Erro ao salvar ${key}:`, e.message);
        }
        pendingSaves[key] = false;
    }, 5000); // Salva a cada 5 segundos
}

module.exports = {
    getVips: () => vips,
    getPendingPayments: () => pendingPayments,
    getUsage: () => userUsage,
    getStats: () => globalStats,
    getUsersData: () => usersData,
    getTotalUsers: () => totalUsers,
    
    saveVips: () => scheduleSave(VIP_FILE, vips, 'vips'),
    savePayments: () => scheduleSave(PAYMENTS_FILE, pendingPayments, 'payments'),
    saveUsage: () => scheduleSave(USAGE_FILE, userUsage, 'usage'),
    saveStats: () => scheduleSave(STATS_FILE, globalStats, 'stats'),
    saveUsersData: () => scheduleSave(USERS_DATA_FILE, usersData, 'usersData'),
    saveUsers: () => scheduleSave(USERS_FILE, totalUsers, 'users'),

    isUserVip: (userId, adminId) => {
        if (Number(userId) === Number(adminId)) return true;
        const vip = vips[userId];
        if (!vip) return false;
        if (Date.now() > vip.expiresAt) return false;
        return true;
    },
    
    getUserVipType: (userId, adminId) => {
        if (Number(userId) === Number(adminId)) return 'ADMIN/FULL';
        const vip = vips[userId];
        if (!vip) return 'FREE';
        if (Date.now() > vip.expiresAt) return 'FREE';
        if (vip.type === 'trial') return 'VIP TRIAL (1 DIA)';
        return vip.type === 'full' ? 'VIP COMPLETO' : 'VIP PADRÃO';
    },

    giveTrialVip: (userId, adminId) => {
        if (Number(userId) === Number(adminId)) return;
        if (vips[userId]) return; // Já teve VIP antes
        const oneDayMs = 24 * 60 * 60 * 1000;
        vips[userId] = {
            type: 'trial',
            expiresAt: Date.now() + oneDayMs
        };
        scheduleSave(VIP_FILE, vips, 'vips');
    }
};
