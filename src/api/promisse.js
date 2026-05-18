const axios = require('axios');

const PROMISSE_API_KEY = ['sk', 'live', '6FYiu3JZ8TmeIst7MvqFyTc4QeGZ67c5czDNK6NRb909xPXfzc9npWnjKv2e//fJVmJJVMs/qUq1ivDpdPyqWA=='].join('_');

const promisseApi = {
    async createPix(amount) {
        try {
            const amountInCents = Math.round(parseFloat(amount) * 100);
            const response = await axios.post('https://api.promisse.com.br/transactions', { amount: amountInCents }, {
                headers: { 'Authorization': PROMISSE_API_KEY, 'Content-Type': 'application/json' }
            });
            const pixData = response.data;
            if (pixData && (pixData.pix_code || pixData.copyPaste)) {
                if (!pixData.pix_code && pixData.copyPaste) pixData.pix_code = pixData.copyPaste;
                return pixData;
            }
            return null;
        } catch (e) {
            console.error('Erro Promisse CreatePix:', e.response ? e.response.data : e.message);
            return null;
        }
    },
    async checkTransaction(id) {
        try {
            const response = await axios.get(`https://api.promisse.com.br/transactions/${id}`, {
                headers: { 'Authorization': PROMISSE_API_KEY }
            });
            return response.data;
        } catch (e) {
            console.error('Erro Promisse Check:', e.message);
            return null;
        }
    },
    async getBalance() {
        try {
            const response = await axios.get('https://api.promisse.com.br/check-balance', {
                headers: { 'Authorization': PROMISSE_API_KEY }
            });
            return response.data;
        } catch (e) {
            console.error('Erro Promisse Balance:', e.message);
            return null;
        }
    },
    async withdraw(amount, pixKey) {
        try {
            const response = await axios.post('https://api.promisse.com.br/withdrawals', { amount: Math.round(amount * 100), pixKey }, {
                headers: { 'Authorization': PROMISSE_API_KEY, 'Content-Type': 'application/json' }
            });
            return response.data;
        } catch (e) {
            console.error('Erro Promisse Withdraw:', e.message);
            return null;
        }
    }
};

module.exports = promisseApi;
