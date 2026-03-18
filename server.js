const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const { callAI } = require('./services/aiService');

const app         = express();
const PORT        = process.env.PORT || 3000;
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

const MINIMAX_API_KEY  = process.env.MINIMAX_API_KEY  || '';
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

/**
 * 写入操作日志
 * @param {string} type     - 日志类别（prd / analyze / review / system / config / push 等）
 * @param {string} input    - 输入内容（自动截断）
 * @param {string} output   - 输出内容（自动截断）
 * @param {object} meta     - 扩展字段 { taskType, model }
 */
function addLog(type, input, output, meta = {}) {
  const entry = {
    time:     new Date().toLocaleString('zh-CN', { hour12: false }),
    type,
    taskType: meta.taskType || type,
    model:    meta.model    || '-',
    input:    String(input).length  > 80  ? String(input).slice(0, 80)   + '…' : String(input),
    output:   String(output).length > 120 ? String(output).slice(0, 120) + '…' : String(output),
  };
  logs.unshift(entry);
  if (logs.length > 100) logs.pop();

  // 控制台结构化输出
  console.log(`[${entry.time}] task:${entry.taskType} model:${entry.model} | ${entry.input.slice(0,40)}`);

  return entry;
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
  if (!['prd', 'analyze', 'review'].includes(type)) {
    return res.status(400).json({ error: '未知类型，支持 prd / analyze / review' });
  }
  if (!config.features[type]) {
    return res.status(403).json({ error: `功能 ${type} 已关闭` });
  }

  const aiResult = await callAI(type, text);

  if (!aiResult.success) {
    addLog(type, text, `[错误] ${aiResult.error}`, { taskType: type, model: aiResult.model });
    return res.status(500).json({ error: aiResult.error });
  }

  addLog(type, text, aiResult.content, { taskType: type, model: aiResult.model });
  res.json({ result: aiResult.content });
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
  const mdText = `## 📋 AI 产品助手 — ${label}\n\n${content}\n\n---\n> 由 AI 产品助手自动生成`;

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

  const aiResult = await callAI('generate-ui', prd, { max_tokens: 6000, timeout: 180000 });

  if (!aiResult.success) {
    addLog('generate-ui', prd.slice(0, 80), `[错误] ${aiResult.error}`, { taskType: 'generate-ui', model: aiResult.model });
    return res.status(500).json({ error: aiResult.error });
  }

  // 提取纯 HTML（防止 AI 用 markdown 代码块包裹）
  const cleaned = aiResult.content
    .replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

  addLog('generate-ui', prd.slice(0, 80), '[生成静态页面] ' + cleaned.slice(0, 80), { taskType: 'generate-ui', model: aiResult.model });
  res.json({ html: cleaned });
});

// ─── Webhook（企业微信） ───────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // 先回 200，防止企业微信超时重试
  res.json({ errcode: 0, errmsg: 'ok' });

  const body = req.body;
  const text =
    body?.event?.text?.content ||
    body?.text?.content        ||
    body?.Content              ||
    (typeof body === 'string' ? body : '');

  if (!text || !text.startsWith('/')) return;

  const config = readConfig();

  if (!systemRunning) {
    console.log('[webhook] 系统已停止，忽略消息');
    return;
  }

  // 解析指令：/prd /analyze /review
  const match = text.match(/^\/(prd|analyze|review)\s+([\s\S]+)$/i);
  if (!match) {
    addLog('webhook', text, '未识别指令（支持 /prd /analyze /review）');
    return;
  }

  const [, type, content] = match;
  const taskType = type.toLowerCase();

  if (!config.features[taskType]) {
    addLog('webhook', text, `功能 ${taskType} 已关闭`);
    return;
  }

  const aiResult = await callAI(taskType, content);

  if (!aiResult.success) {
    addLog(taskType, content, `[错误] ${aiResult.error}`, { taskType, model: aiResult.model });
    console.error(`[webhook] AI 调用失败: ${aiResult.error}`);
    return;
  }

  addLog(taskType, content, aiResult.content, { taskType, model: aiResult.model });
  console.log(`[webhook] ${taskType} 完成 (model: ${aiResult.model})`);
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
