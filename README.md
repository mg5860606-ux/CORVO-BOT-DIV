<p align="center">
  <img src="./logo.png" alt="Corvo Bot Logo" width="220" style="border-radius: 50%; box-shadow: 0 4px 15px rgba(0,0,0,0.5);"/>
</p>

<h1 align="center">🦅 CORVO BOT (CORVO DIV) 🦅</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js"/>
  <img src="https://img.shields.io/badge/Baileys-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" alt="Baileys WhatsApp"/>
  <img src="https://img.shields.io/badge/Telegraf-26A69A?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegraf Telegram"/>
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="MIT License"/>
</p>

<p align="center">
  <strong>O Sistema Supremo e Definitivo de Automação, Divulgação em Massa (Spam/Rajada) e Ferramentas de Elite Integradas (WhatsApp & Telegram).</strong>
</p>

<hr />

## ⚡ Apresentação
O **Corvo Bot (ou Corvo Div)** é uma inteligência de elite focada em automação extrema, spam massivo indetectável, evasão de banimentos e monitoramento inteligente de dados. Ele integra perfeitamente múltiplas contas do **WhatsApp** através de um painel de controle premium no **Telegram**, oferecendo recursos táticos robustos e um sistema autônomo de monetização via chaves VIP (VIP Keys).

> ⚠️ **Aviso de Elite:** Desenvolvido para máxima furtividade, simulando comportamento humano real (Gaussian jitter, digitação natural e delay inteligente) para evitar bloqueios das operadoras de telefonia e do próprio WhatsApp.

---

## 🚀 Recursos de Destaque (Elite Features)

### 🔑 1. Sistema Autônomo de VIP Keys (Auto-Monetização)
* **Redeem de Chaves:** Usuários podem resgatar licenças diretamente no bot do Telegram digitando `/redeem <chave>`.
* **Gerador Inteligente (Admin):** O administrador gera licenças dinâmicas informando o tempo de validade desejado via `/genkey <dias>`. O sistema gera a chave no formato `CORVO-VIP-XXXX-XXXX` de forma assíncrona e persistente.
* **Alertas no Telegram:** Notificações em tempo real ao administrador toda vez que um cliente resgatar uma chave.

### 👻 2. Ghost Mode (Modo Fantasma)
* **Modo Furtivo Total:** Esconde o status de visualização e impede que as confirmações de leitura (tiques azuis) sejam enviadas ao remetente, mantendo sua leitura 100% oculta enquanto você opera.
* **Presença Persistente:** Salvo no perfil do usuário e ativado de forma invisível a cada mensagem recebida.

### 📸 3. Anti-ViewOnce (Revelador de Mídia Única)
* **Baixador Automático:** Intercepta mídias enviadas em modo de visualização única no WhatsApp.
* **Revelação Permanente:** Converte e encaminha a foto ou vídeo permanente diretamente no privado do Telegram do usuário, com dados de quem enviou, legenda e o grupo de origem.

### 🛡️ 4. Anti-Delete (WhatsApp para Telegram)
* **Cache Inteligente:** Armazena em cache na memória RAM as últimas 200 mensagens recebidas em tempo real.
* **Recuperação de Apagados:** Quando um contato apaga uma mensagem usando "Apagar para todos", o Corvo Bot intercepta o evento, resgata a mensagem e a envia em formato de citação no seu chat privado do Telegram.

### 💣 5. Motor de Divulgação em Massa (Rajada / Nuke)
* **Divulgação Automática:** Envio em massa e sequencial para centenas de grupos de WhatsApp extraídos via scraper inteligente ou listados na web.
* **Human-like Simulator:** Simulação automática de digitação, gravação de áudio e pausas dinâmicas antes de disparar cada rajada para evitar bans do sistema antispam do WhatsApp.

---

## 🛠️ Tecnologias Utilizadas

O ecossistema do Corvo Bot foi desenhado com tecnologia de ponta em JavaScript para garantir alta escalabilidade, zero latência e persistência segura:

| Tecnologia | Descrição | Utilidade no Projeto |
| :--- | :--- | :--- |
| **Node.js** | Ambiente de Execução Javascript assíncrono. | Core do sistema e gerenciamento de conexões assíncronas. |
| **Baileys (@itsliaaa/baileys)** | Biblioteca de WhatsApp Web API de alta performance. | Gerenciamento de sockets, presença invisível e listeners. |
| **Telegraf** | Framework avançado para criação de Bots do Telegram. | Interface com o usuário, menus interativos e comandos (/clear, /genkey). |
| **Axios & Cheerio** | Clientes HTTP e coletores de dados rápidos. | Scraper inteligente de grupos públicos de divulgação e APIs de consulta. |
| **Pino Logger** | Mecanismo de log de alta performance e baixo overhead. | Registro cirúrgico de eventos de conexão e erros. |
| **Promisse API** | Plataforma de transações integradas de pagamento (PIX). | Emissão automática de PIX e liberação imediata de VIP. |

---

## 📦 Como Instalar e Executar

### Pré-requisitos
* Node.js v16 ou superior instalado.
* NPM ou Yarn configurado.
* Uma chave de API para o Telegram (obtida com o [@BotFather](https://t.me/BotFather)).

### Passo a Passo

1. **Clonar o Repositório:**
   ```bash
   git clone https://github.com/mg5860606-ux/CORVO-BOT-DIV.git
   cd CORVO-BOT-DIV
   ```

2. **Instalar Dependências:**
   ```bash
   npm install
   ```

3. **Configurações Iniciais:**
   Abra o arquivo `index.js` e edite as seguintes constantes:
   ```javascript
   const TELEGRAM_TOKEN = 'SEU_TOKEN_TELEGRAM_AQUI';
   const ADMIN_ID = SEU_ID_TELEGRAM_NUMERICO; // Exemplo: 8273924319
   ```

4. **Executar o Robô:**
   ```bash
   npm start
   ```

---

## 📜 Licença

Este projeto está sob a licença **MIT**. Veja o arquivo [LICENSE](./LICENSE) para mais detalhes.

<hr />

<p align="center">
  🦅 <i>Desenvolvido e mantido por Marcos — Corvo Intelligence System 2026.</i> 🦅
</p>
