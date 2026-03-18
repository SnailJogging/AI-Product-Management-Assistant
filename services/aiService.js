const { callMaxClaw } = require('./maxclawService');

// ─── taskType → system prompt 映射 ────────────────────────────
const SYSTEM_PROMPTS = {
  prd:         '你是资深产品经理，请根据需求描述生成规范的 PRD（产品需求文档），包含背景、目标、功能列表、验收标准。',
  analyze:     '你是数据分析师，请对用户提供的数据或问题进行深入分析，给出结论和建议。',
  review:      '你是技术架构师，请对用户描述的技术方案进行评审，指出优缺点和改进建议。',
  'generate-ui': `你是一名资深前端工程师。用户会给你一份 PRD 文档，你的任务是根据 PRD 中描述的功能需求，生成一个完整可直接运行的静态 HTML 页面。
要求：
1. 只输出 HTML 代码，不要有任何解释说明，不要用 markdown 代码块包裹
2. 使用原生 HTML + CSS + JavaScript，不依赖任何外部框架或 CDN
3. 页面要完整可用：包含真实可交互的 UI 元素（按钮点击有响应、表单可输入、列表可操作）
4. 使用 mock 数据填充，让页面看起来真实
5. 界面风格现代、简洁，使用 CSS 变量，配色专业
6. 所有功能都在一个 HTML 文件内实现
7. 页面顶部用注释标注来源 PRD 的核心功能点`,
  // 未来扩展预留：explore / summarize / translate ...
};

/**
 * 统一 AI 调用入口
 * @param {string} taskType - prd | analyze | review | generate-ui（未来可扩展）
 * @param {string} prompt   - 用户输入内容
 * @param {object} options  - 透传给底层模型的参数 { max_tokens, timeout }
 * @returns {{ success: boolean, content?: string, error?: string, model: string }}
 *
 * 扩展说明：
 *   当前版本固定使用 MiniMax（MaxClaw）。
 *   未来接入多模型时，在此处根据 taskType 或配置决策路由，
 *   业务层（server.js）无需任何改动。
 */
async function callAI(taskType, prompt, options = {}) {
  // 动态读取配置，保证开关实时生效
  const config = require('../config.json');

  if (!config.model.maxclaw) {
    return { success: false, error: 'No AI model enabled', model: 'none' };
  }

  const systemPrompt = SYSTEM_PROMPTS[taskType] || '你是一个专业的 AI 助手。';

  // 当前版本：全部走 MiniMax
  const result = await callMaxClaw(prompt, systemPrompt, options);

  return { ...result, model: 'maxclaw' };
}

module.exports = { callAI };
