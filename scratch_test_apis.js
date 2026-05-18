const axios = require('axios');

const endpoints = [
    { name: 'Consultas API', url: 'http://5.161.71.18:3111/api/cpf?token=sua_key_aqui&cpf=12345678909' }, // Provavelmente dará erro de auth, mas o servidor deve responder
    { name: 'Waifu API', url: 'https://api.waifu.pics/nsfw/waifu' },
    { name: 'Pollinations', url: 'https://image.pollinations.ai/prompt/test' },
    { name: 'ViaCEP', url: 'https://viacep.com.br/ws/01001000/json/' },
    { name: 'BrasilAPI CNPJ', url: 'https://brasilapi.com.br/api/cnpj/v1/19131243000197' },
    { name: 'IP-API', url: 'http://ip-api.com/json/8.8.8.8' },
    { name: 'Alianca Instagram', url: 'https://api-momoayse.aliancakkgr.com.br/api/Instagram' },
    { name: 'Google TTS', url: 'https://translate.google.com/translate_tts?ie=UTF-8&q=teste&tl=pt&client=tw-ob' },
    { name: 'Is.gd', url: 'https://is.gd/create.php?format=json&url=https://google.com' },
    { name: 'WeatherAPI', url: 'http://api.weatherapi.com/v1/current.json?key=c8c07e604f32446f884140026240405&q=Sao%20Paulo&lang=pt' },
    { name: 'Meme API', url: 'https://meme-api.com/gimme' },
    { name: 'CoinGecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=brl' }
];

async function checkAPIs() {
    console.log('🔄 Iniciando teste das APIs...');
    for (const api of endpoints) {
        try {
            const res = await axios.get(api.url, { timeout: 5000, validateStatus: () => true });
            if (res.status >= 200 && res.status < 500) {
                console.log(`✅ [OK] ${api.name} (Status: ${res.status})`);
            } else {
                console.log(`⚠️ [WARNING] ${api.name} (Status: ${res.status})`);
            }
        } catch (e) {
            console.log(`❌ [ERROR] ${api.name} - ${e.message}`);
        }
    }
}

checkAPIs();
