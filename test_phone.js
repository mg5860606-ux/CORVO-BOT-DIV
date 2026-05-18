const axios = require('axios');

const CONSULTAS_TOKEN = '6b37bf08416e08c4276b4d55cc276be2';
const CONSULTAS_API_BASE = 'https://apis.gonzalesdev.shop/';

async function fetchApi(url, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.get(url, { timeout: 15000 });
            return response.data;
        } catch (error) {
            if (i === retries - 1) return { error: true, message: error.message };
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

async function testLookup(tel) {
    console.log(`Testing lookup for: ${tel}`);
    const ddd = tel.substring(0, 2);
    
    let regionalInfo = '';
    try {
        const resDDD = await axios.get(`https://brasilapi.com.br/api/ddd/v1/${ddd}`);
        if (resDDD.data) {
            regionalInfo = `📍 REGIÃO (DDD ${ddd})\n• Estado: ${resDDD.data.state}\n• Principais Cidades: ${resDDD.data.cities.slice(0, 5).join(', ')}\n\n`;
        }
    } catch (e) {
        regionalInfo = 'Regional info failed\n';
    }

    try {
        const urlTel = `${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=base_local&telefone=${tel}`;
        const resTel = await fetchApi(urlTel);
        
        console.log('Tel Result:', JSON.stringify(resTel, null, 2));

        if (resTel.error || resTel.erro) {
            console.log('Error in Tel lookup');
            return;
        }

        const results = Array.isArray(resTel) ? resTel : (resTel.dados || [resTel]);
        const linkedCpfObj = results.find(item => item.cpf || item['cpf/cnpj']);
        const cpfVinculado = linkedCpfObj ? (linkedCpfObj.cpf || linkedCpfObj['cpf/cnpj']).replace(/[^0-9]/g, '') : null;

        if (cpfVinculado) {
            console.log(`Linked CPF: ${cpfVinculado}`);
            const [resDados, resFoto, resOperadora] = await Promise.allSettled([
                fetchApi(`${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=base_local&cpf=${cpfVinculado}`),
                fetchApi(`${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=foto_cnh&cpf=${cpfVinculado}`),
                fetchApi(`${CONSULTAS_API_BASE}?token=${CONSULTAS_TOKEN}&r=operadora&tel=${tel}`)
            ]);

            const dRaw = resDados.status === 'fulfilled' ? resDados.value : null;
            let d = Array.isArray(dRaw) ? dRaw[0] : (dRaw?.dados ? (Array.isArray(dRaw.dados) ? dRaw.dados[0] : dRaw.dados) : dRaw);
            
            const op = resOperadora.status === 'fulfilled' ? resOperadora.value : null;
            const operadoraName = op ? (op.operadora || op.name || op.desc || 'Não informado') : 'Não informado';

            if (d) {
                const nome = d.nome || d.nome_completo || d.NOME || 'Não informado';
                const rg = d.rg || d.identidade || d.numero_rg || 'Não informado';
                const mae = d.mae || d.nome_mae || 'Não informado';
                const pai = d.pai || d.nome_pai || 'Não informado';
                const avo_paterna = d.avo_paterna || d.nome_avo_paterna || 'Não informado';
                const avo_paterno = d.avo_paterno || d.nome_avo_paterno || 'Não informado';
                const avo_materna = d.avo_materna || d.nome_avo_materna || 'Não informado';
                const avo_materno = d.avo_materno || d.nome_avo_materno || 'Não informado';

                console.log('--- FINAL MESSAGE SIMULATION ---');
                console.log(`📱 Telefone: ${tel}`);
                console.log(`📡 Operadora: ${operadoraName}`);
                console.log(regionalInfo);
                console.log(`👤 DADOS PESSOAIS VINCULADOS`);
                console.log(`• Nome: ${nome}`);
                console.log(`• CPF: ${cpfVinculado}`);
                console.log(`• RG: ${rg}`);
                console.log(`👨‍👩‍👧 FILIAÇÃO`);
                console.log(`• Mãe: ${mae}`);
                console.log(`• Pai: ${pai}`);
                console.log(`👴 AVÓS`);
                console.log(`• Avó Paterna: ${avo_paterna}`);
                console.log(`• Avô Paterno: ${avo_paterno}`);
                console.log(`• Avó Materna: ${avo_materna}`);
                console.log(`• Avô Materno: ${avo_materno}`);
                console.log(`---------------------------------`);
                
                if (resFoto.status === 'fulfilled' && resFoto.value.base64) {
                    console.log('✅ Foto found (base64 string present)');
                } else {
                    console.log('❌ No photo found');
                }
            } else {
                console.log('No detailed data found for CPF');
            }
        } else {
            console.log('No linked CPF found');
        }
    } catch (e) {
        console.error(e);
    }
}

testLookup('11943431616');
