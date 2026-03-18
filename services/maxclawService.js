const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ─── 读取环境变量 ──────────────────────────────────────────────
try {
  const envFile = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
  envFile.split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && !key.startsWith('#') && vals.length) {
      process.env[key.trim()] = vals.join('=').trim();
    }
  });
} catch (_) { /* .env 不存在时忽略 */ }

const MINIMAX_API_KEY  = process.env.MINIMAX_API_KEY  || '';
const MINIMAX_GROUP_ID = process.env.MINIMAX_GROUP_ID || '';

/**
 * 调用 MiniMax（MaxClaw）模型
 * @param {string} prompt        - 用户输入
 * @param {string} systemPrompt  - 系统角色设定
 * @param {object} options       - 可选参数 { max_tokens, timeout }
 * @returns {{ success: boolean, content?: string, error?: string }}
 */
async function callMaxClaw(prompt, systemPrompt, options = {}) {
  if (!MINIMAX_API_KEY) {
    return { success: false, error: '未配置 MINIMAX_API_KEY，请在 .env 文件中设置' };
  }

  // GroupId 作为 query 参数传入（MiniMax API 要求）
  const url = MINIMAX_GROUP_ID
    ? `https://api.minimax.chat/v1/text/chatcompletion_v2?GroupId=${MINIMAX_GROUP_ID}`
    : `https://api.minimax.chat/v1/text/chatcompletion_v2`;

  const payload = {
    model: 'MiniMax-Text-01',
    messages: [
      { role: 'system', content: systemPrompt || '你是一个专业的 AI 产品管理助手。' },
      { role: 'user',   content: prompt },
    ],
    max_tokens: options.max_tokens || 2048,
    temperature: 0.7,
  };

  try {
    const resp = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${MINIMAX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: options.timeout || 60000,
    });

    const data = resp.data;

    // 检查 MiniMax base_resp 错误码
    if (data?.base_resp?.status_code && data.base_resp.status_code !== 0) {
      return {
        success: false,
        error: `MiniMax 错误 ${data.base_resp.status_code}: ${data.base_resp.status_msg}`,
      };
    }

    // 兼容两种响应格式
    const content =
      data?.choices?.[0]?.message?.content ||     // OpenAI 兼容格式
      data?.choices?.[0]?.messages?.[0]?.text ||   // MiniMax 旧格式
      '';

    if (!content) {
      console.error('[maxclawService] 响应结构异常:', JSON.stringify(data).slice(0, 300));
      return { success: false, error: 'AI 返回内容为空，请检查控制台日志' };
    }

    return { success: true, content };

  } catch (err) {
    const msg = err?.response?.data?.error?.message || err.message;
    return { success: false, error: msg };
  }
}

module.exports = { callMaxClaw };
