const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ─── 环境变量（优先读取 .env 文件） ───────────────────────────
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  envFile.split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && !key.startsWith('#') && vals.length) {
      process.env[key.trim()] = vals.join('=').trim();
    }
  });
} catch (_) { /* .env 不存在时忽略 */ }

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || '';
const MINIMAX_GROUP_ID = process.env.MINIMAX_GROUP_ID || '';
const WECHAT_WEBHOOK_URL = process.env.WECHAT_WEBHOOK_URL || '';

// ─── 运行时状态 ────────────────────────────────────────────────
let systemRunning = true;
const logs = [];

// ─── 中间件 ───────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── 工具函数 ─────────────────────────────────────────────────
function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function addLog(type, input, output) {
  const entry = {
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
    type,
    input: input.length > 80 ? input.slice(0, 80) + '…' : input,
    output: output.length > 120 ? output.slice(0, 120) + '…' : output,
  };
  logs.unshift(entry);
  if (logs.length > 100) logs.pop();
  return entry;
}

// ─── AI 调用封装（MiniMax / MaxClaw） ─────────────────────────
async function callMaxClaw(prompt, systemPrompt, options = {}) {
  if (!MINIMAX_API_KEY) {
    return '[未配置 MINIMAX_API_KEY，请在 .env 文件中设置]';
  }

  // GroupId 作为 query 参数传入（MiniMax API 要求）
  const url = MINIMAX_GROUP_ID
    ? `https://api.minimax.chat/v1/text/chatcompletion_v2?GroupId=${MINIMAX_GROUP_ID}`
    : `https://api.minimax.chat/v1/text/chatcompletion_v2`;

  const payload = {
    model: 'MiniMax-Text-01',
    messages: [
      { role: 'system', content: systemPrompt || '你是一个专业的 AI 产品管理助手。' },
      { role: 'user', content: prompt },
    ],
    max_tokens: options.max_tokens || 2048,
    temperature: 0.7,
  };

  const headers = {
    'Authorization': `Bearer ${MINIMAX_API_KEY}`,
    'Content-Type': 'application/json',
  };

  const resp = await axios.post(url, payload, { headers, timeout: options.timeout || 60000 });
  const data = resp.data;

  // 检查 MiniMax base_resp 错误码
  if (data?.base_resp?.status_code && data.base_resp.status_code !== 0) {
    throw new Error(`MiniMax 错误 ${data.base_resp.status_code}: ${data.base_resp.status_msg}`);
  }

  // 兼容两种响应格式
  const content =
    data?.choices?.[0]?.message?.content ||          // OpenAI 兼容格式
    data?.choices?.[0]?.messages?.[0]?.text ||        // MiniMax 旧格式
    '';

  if (!content) {
    console.error('[AI] 响应结构异常:', JSON.stringify(data).slice(0, 300));
    throw new Error('AI 返回内容为空，请检查控制台日志');
  }

  return content;
}

// ─── 按指令选择 system prompt ─────────────────────────────────
function getSystemPrompt(type) {
  const prompts = {
    prd: '你是资深产品经理，请根据需求描述生成规范的 PRD（产品需求文档），包含背景、目标、功能列表、验收标准。',
    analyze: '你是数据分析师，请对用户提供的数据或问题进行深入分析，给出结论和建议。',
    review: '你是技术架构师，请对用户描述的技术方案进行评审，指出优缺点和改进建议。',
  };
  return prompts[type] || '你是一个专业的 AI 助手。';
}

// ─── REST API ─────────────────────────────────────────────────

// 获取系统状态
app.get('/api/status', (req, res) => {
  const config = readConfig();
  res.json({ running: systemRunning, config });
});

// 启动 / 停止系统
app.post('/api/toggle', (req, res) => {
  systemRunning = !systemRunning;
  addLog('system', systemRunning ? '系统启动' : '系统停止', systemRunning ? '运行中' : '已停止');
  res.json({ running: systemRunning });
});

// 获取配置
app.get('/api/config', (req, res) => {
  res.json(readConfig());
});

// 更新配置
app.put('/api/config', (req, res) => {
  try {
    const current = readConfig();
    const updated = { ...current, ...req.body };
    writeConfig(updated);
    addLog('config', '更新配置', JSON.stringify(updated));
    res.json({ ok: true, config: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取日志
app.get('/api/logs', (req, res) => {
  res.json(logs);
});

// 手动测试 AI（控制台直接调用）
app.post('/api/chat', async (req, res) => {
  const { type = 'prd', text } = req.body;
  if (!text) return res.status(400).json({ error: '缺少 text 参数' });

  const config = readConfig();
  if (!config.model.maxclaw) {
    return res.status(403).json({ error: 'MaxClaw 模型已关闭' });
  }
  if (type !== 'prd' && type !== 'analyze' && type !== 'review') {
    return res.status(400).json({ error: '未知类型，支持 prd / analyze / review' });
  }
  if (!config.features[type]) {
    return res.status(403).json({ error: `功能 ${type} 已关闭` });
  }

  try {
    const result = await callMaxClaw(text, getSystemPrompt(type));
    addLog(type, text, result);
    res.json({ result });
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err.message;
    addLog(type, text, `[错误] ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// 推送结果到企业微信群
app.post('/api/push-to-group', async (req, res) => {
  if (!WECHAT_WEBHOOK_URL) {
    return res.status(400).json({ error: '未配置 WECHAT_WEBHOOK_URL，请在 .env 中填入群机器人 Webhook 地址' });
  }

  const { type, content } = req.body;
  if (!content) return res.status(400).json({ error: '缺少 content 参数' });

  const typeLabel = { prd: 'PRD 文档', analyze: '数据分析报告', review: '技术评审报告' };
  const label = typeLabel[type] || '内容';

  // 企业微信 markdown 消息格式（群机器人支持）
  const mdText = `## 📋 AI 产品助手 — ${label}\n\n${content}\n\n---\n> 由 AI 产品助手自动生成`;

  // 企业微信单条消息上限约 4096 字符，超出截断并提示
  const MAX_LEN = 3800;
  const truncated = mdText.length > MAX_LEN;
  const finalText = truncated
    ? mdText.slice(0, MAX_LEN) + `\n\n> ⚠️ 内容较长，已截断，完整版请在控制台下载 .md 文件`
    : mdText;

  try {
    await axios.post(WECHAT_WEBHOOK_URL, {
      msgtype: 'markdown',
      markdown: { content: finalText },
    }, { timeout: 10000 });

    addLog('push', `推送${label}到群`, truncated ? '已截断推送' : '推送成功');
    res.json({ ok: true, truncated });
  } catch (err) {
    const msg = err?.response?.data?.errmsg || err.message;
    addLog('push', `推送${label}到群`, `[错误] ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// 获取群机器人配置状态
app.get('/api/push-status', (req, res) => {
  res.json({ configured: !!WECHAT_WEBHOOK_URL });
});

// 根据 PRD 生成前端静态页面
app.post('/api/generate-ui', async (req, res) => {
  const { prd } = req.body;
  if (!prd) return res.status(400).json({ error: '缺少 prd 参数' });

  const config = readConfig();
  if (!config.model.maxclaw) return res.status(403).json({ error: 'MaxClaw 模型已关闭' });

  const systemPrompt = `你是一名资深前端工程师。用户会给你一份 PRD 文档，你的任务是根据 PRD 中描述的功能需求，生成一个完整可直接运行的静态 HTML 页面。

要求：
1. 只输出 HTML 代码，不要有任何解释说明，不要用 markdown 代码块包裹
2. 使用原生 HTML + CSS + JavaScript，不依赖任何外部框架或 CDN
3. 页面要完整可用：包含真实可交互的 UI 元素（按钮点击有响应、表单可输入、列表可操作）
4. 使用 mock 数据填充，让页面看起来真实
5. 界面风格现代、简洁，使用 CSS 变量，配色专业
6. 所有功能都在一个 HTML 文件内实现
7. 页面顶部用注释标注来源 PRD 的核心功能点`;

  try {
    const html = await callMaxClaw(prd, systemPrompt, { max_tokens: 6000, timeout: 180000 });
    // 提取纯 HTML（防止 AI 用 markdown 代码块包裹）
    const cleaned = html.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    addLog('generate-ui', prd.slice(0, 80), '[生成静态页面] ' + cleaned.slice(0, 80));
    res.json({ html: cleaned });
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err.message;
    addLog('generate-ui', prd.slice(0, 80), `[错误] ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// ─── Webhook（企业微信） ───────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // 先回 200，防止企业微信超时重试
  res.json({ errcode: 0, errmsg: 'ok' });

  const body = req.body;
  // 企业微信回调消息结构
  const text =
    body?.event?.text?.content ||          // 新版结构
    body?.text?.content ||                 // 旧版结构
    body?.Content ||                       // 部分版本
    (typeof body === 'string' ? body : '');

  if (!text || !text.startsWith('/')) return;

  const config = readConfig();

  if (!systemRunning) {
    console.log('[webhook] 系统已停止，忽略消息');
    return;
  }
  if (!config.model.maxclaw) {
    console.log('[webhook] MaxClaw 已关闭');
    return;
  }

  // 解析指令
  const match = text.match(/^\/(prd|analyze|review)\s+([\s\S]+)$/i);
  if (!match) {
    addLog('webhook', text, '未识别指令（支持 /prd /analyze /review）');
    return;
  }

  const [, type, content] = match;
  const featureKey = type.toLowerCase();

  if (!config.features[featureKey]) {
    addLog('webhook', text, `功能 ${featureKey} 已关闭`);
    return;
  }

  try {
    const result = await callMaxClaw(content, getSystemPrompt(featureKey));
    addLog(featureKey, content, result);
    console.log(`[webhook] ${featureKey} 完成`);
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err.message;
    addLog(featureKey, content, `[错误] ${msg}`);
    console.error('[webhook] AI 调用失败:', msg);
  }
});

// ─── 启动 ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 AI 助手系统已启动`);
  console.log(`   Web 控制台: http://localhost:${PORT}`);
  console.log(`   Webhook:    http://localhost:${PORT}/webhook`);
  if (!MINIMAX_API_KEY) {
    console.warn('\n⚠️  未检测到 MINIMAX_API_KEY，请复制 .env.example 为 .env 并填入 API Key\n');
  }
});
