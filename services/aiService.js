const { callMaxClaw } = require('./maxclawService');
const { callQwen }    = require('./qwenService');

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
  summarize: '你是一名资深产品经理，我会给你一份系统探索报告，包含操作步骤、页面关系图和接口信息。请输出：1. 核心业务模块（列举主要功能模块）；2. 用户操作流程（描述关键用户路径）；3. 关键接口说明（说明重要 API 的业务含义）。用简洁的中文输出，不要逐条复述原始数据，要提炼业务逻辑。',
  'explore-prd': `你是高级产品经理。以下是系统自动探索结果，请输出一份简化 PRD。
要求：
1. 用 Markdown 格式输出
2. 包含：产品概述、核心功能模块、用户操作流程、接口说明
3. 语言简洁专业，不超过 1500 字
4. 基于数据推断，合理补充细节`,
  ask: '你是系统分析助手。我会给你一份系统探索数据（操作步骤、页面关系、接口信息），请根据数据回答用户的具体问题。回答要准确、简洁，基于数据作答，不要编造不存在的功能。',
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

  const systemPrompt = SYSTEM_PROMPTS[taskType] || '你是一个专业的 AI 助手。';

  // 模型路由：qwen 优先，其次 maxclaw，都未启用则报错
  if (config.model.qwen) {
    const result = await callQwen(prompt, systemPrompt, options);
    return { ...result, model: 'qwen' };
  }

  if (config.model.maxclaw) {
    const result = await callMaxClaw(prompt, systemPrompt, options);
    return { ...result, model: 'maxclaw' };
  }

  return { success: false, error: '未启用任何 AI 模型，请在侧栏开启 MaxClaw 或 Qwen', model: 'none' };
}

module.exports = { callAI };
