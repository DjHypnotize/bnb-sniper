// Wizard BNB Sniper with HTTPS fallback, Honeypot Detection, Sell Logic, and Telegram Alerts
require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');

// Load Secrets
const {
  PRIVATE_KEY,
  HTTPS_PROVIDER,
  FACTORY_ADDRESS,
  ROUTER_ADDRESS,
  WBNB,
  TARGET_TOKEN,
  TARGET_WALLET,
  TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID
} = process.env;

// Use HTTPS JSON-RPC Provider (Blast does not support WebSocket)
const provider = new ethers.providers.JsonRpcProvider(HTTPS_PROVIDER);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const bot = new TelegramBot(TELEGRAM_TOKEN);

const notify = async (msg) => {
  try {
    console.log(`Telegram: ${msg}`);
    await bot.sendMessage(TELEGRAM_CHAT_ID, `🤖 ${msg}`);
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
};

const routerAbi = [
  'function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)'
];

const router = new ethers.Contract(ROUTER_ADDRESS, routerAbi, wallet);

const logToCSV = (event, token, amount) => {
  const line = `${new Date().toISOString()},${event},${token},${amount}\n`;
  fs.appendFileSync('bnb_trades.csv', line);
};

const isHoneypot = async (token) => {
  try {
    const res = await axios.get(`https://api.honeypot.is/v1/IsHoneypot?address=${token}`);
    return res.data?.honeypotResult?.isHoneypot;
  } catch {
    return false;
  }
};

const verifyToken = async (tokenAddress) => {
  try {
    const code = await provider.getCode(tokenAddress);
    return code !== '0x';
  } catch {
    return false;
  }
};

const snipe = async () => {
  if (!TARGET_TOKEN || TARGET_TOKEN.length !== 42) return;

  const isValid = await verifyToken(TARGET_TOKEN);
  if (!isValid) return notify(`❌ Invalid token: ${TARGET_TOKEN}`);

  const honeypot = await isHoneypot(TARGET_TOKEN);
  if (honeypot) return notify(`⚠️ Honeypot detected: ${TARGET_TOKEN}`);

  const ethAmount = ethers.utils.parseEther('0.03');
  const path = [WBNB, TARGET_TOKEN];

  try {
    const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
      0,
      path,
      TARGET_WALLET,
      Math.floor(Date.now() / 1000) + 600,
      { value: ethAmount, gasLimit: 300000 }
    );
    await tx.wait();
    await notify(`✨ Bought: ${TARGET_TOKEN}`);
    logToCSV('BUY', TARGET_TOKEN, '0.03');

    // Sell after 2 minutes
    setTimeout(() => sellToken(TARGET_TOKEN), 120000);
  } catch (e) {
    await notify(`❌ Buy error: ${e.message}`);
  }
};

const sellToken = async (tokenAddress) => {
  const tokenAbi = [
    "function approve(address spender, uint256 amount) public returns (bool)",
    "function balanceOf(address account) view returns (uint256)"
  ];
  const token = new ethers.Contract(tokenAddress, tokenAbi, wallet);
  const balance = await token.balanceOf(wallet.address);
  await token.approve(ROUTER_ADDRESS, balance);

  const path = [tokenAddress, WBNB];
  try {
    const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      balance,
      0,
      path,
      TARGET_WALLET,
      Math.floor(Date.now() / 1000) + 600,
      { gasLimit: 300000 }
    );
    await tx.wait();
    await notify(`💰 Sold: ${tokenAddress}`);
    logToCSV('SELL', tokenAddress, ethers.utils.formatEther(balance));
  } catch (e) {
    await notify(`❌ Sell error: ${e.message}`);
  }
};

// Poll for new transactions involving router and target token
const start = async () => {
  await notify(`🧙‍♂️ Wizard BNB bot is live and scanning...`);
  await notify("🧪 BNB bot is running and connected to Telegram!");

  // Poll every 3 seconds
  setInterval(async () => {
    try {
      if (!TARGET_TOKEN) return;

      const latestBlock = await provider.getBlockNumber();
      const block = await provider.getBlockWithTransactions(latestBlock);

      for (let tx of block.transactions) {
        if (tx.to && tx.to.toLowerCase() === ROUTER_ADDRESS.toLowerCase()) {
          if (tx.data.includes(TARGET_TOKEN.slice(2).toLowerCase())) {
            await notify(`🚀 Detected buy on ${TARGET_TOKEN}, sniping...`);
            await snipe();
            return;
          }
        }
      }
    } catch (err) {
      console.error('Polling error:', err.message);
    }
  }, 3000);
};

start();
