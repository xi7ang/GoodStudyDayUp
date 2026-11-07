/**
 * GoodStudyDayUpBot - Telegram Bot Worker
 * 处理 Telegram webhook 并查询 Cloudflare D1 数据库
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 健康检查端点
    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }

    // Telegram webhook 端点
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleTelegramWebhook(request, env, ctx);
    }

    // 资源注册 API 端点（供 mswnlz_publish 调用）
    if (url.pathname === '/api/add' && request.method === 'POST') {
      return handleApiAdd(request, env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

// 用于记录每个 chatId 的添加状态
const addStateMap = new Map();

/**
 * 处理 API 资源注册请求
 * POST /api/add
 * Body: {"resource_name": "...", "resource_description": "...", "resource_link": "...", "resource_hint": "..."}
 */
async function handleApiAdd(request, env) {
  try {
    const body = await request.json();
    const { resource_name, resource_description, resource_link, resource_hint } = body;

    if (!resource_name || !resource_link) {
      return new Response(JSON.stringify({
        error: 'resource_name 和 resource_link 为必填字段'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const result = await env.DB.prepare(
      'INSERT INTO pandata (resource_name, resource_description, resource_link, resource_hint) VALUES (?, ?, ?, ?)'
    ).bind(
      resource_name,
      resource_description || '',
      resource_link,
      resource_hint || ''
    ).run();

    const resourceId = result.meta.last_row_id;
    const start_link = `https://t.me/GoodStudyDayUpBot?start=${resourceId}`;

    return new Response(JSON.stringify({
      id: resourceId,
      start_link
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error in /api/add:', error);
    return new Response(JSON.stringify({
      error: '服务器内部错误'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * 处理 Telegram webhook 请求
 */
async function handleTelegramWebhook(request, env, ctx) {
  try {
    const update = await request.json();

    // ========== 回调按钮（分页翻页） ==========
    if (update.callback_query) {
      const cb = update.callback_query;
      const [action, query, page] = cb.data.split('|');

      if (action === 'search') {
        await handleSearch(cb.message.chat.id, query, parseInt(page), env, cb.id, cb.message.message_id);
        return new Response('OK', { status: 200 });
      }
      return new Response('OK', { status: 200 });
    }

    // 检查是否是消息更新
    if (!update.message) {
      return new Response('OK', { status: 200 });
    }

    const message = update.message;
    const chatId = message.chat.id;
    const text = message.text;

    // 处理 /start 命令（私聊和任何群组都可用）
    if (text && text.startsWith('/start')) {
      await handleStartCommand(chatId, text, env);
      return new Response('OK', { status: 200 });
    }

    // 处理 /add 命令（任何地方都可用）
    if (text && text.trim() === '/add') {
      addStateMap.set(chatId, 'waiting_resource_info');
      await sendMessage(chatId, '请按照以下格式发送资源信息', env);
      return new Response('OK', { status: 200 });
    }

    // 检查是否处于添加资源状态
    if (addStateMap.get(chatId) === 'waiting_resource_info' && text) {
      await handleAddResource(chatId, text, env);
      addStateMap.delete(chatId);
      return new Response('OK', { status: 200 });
    }

    // ========== 普通消息 → 全文搜索（仅限白名单群组，非管理员）==========
    // 安全过滤：仅允许的群组能触发搜索
    if (env.ALLOWED_GROUP_ID && chatId.toString() !== env.ALLOWED_GROUP_ID) {
      return new Response('OK', { status: 200 });
    }

    // ========== 普通消息 → 全文搜索（仅限白名单群组，非管理员）==========
    if (text && !text.startsWith('/')) {
      // 管理员和群主不触发搜索
      try {
        const TELEGRAM_API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
        const memberResp = await fetch(
          `${TELEGRAM_API}/getChatMember?chat_id=${chatId}&user_id=${message.from.id}`
        );
        const memberData = await memberResp.json();
        if (memberData.result?.status === 'administrator') {
          return new Response('OK', { status: 200 });
        }
      } catch (err) {
        console.error('getChatMember error:', err);
      }

      const query = text.trim();
      if (query.length >= 2) {
        try {
          await handleSearch(chatId, query, 1, env, null, null, ctx);
        } catch (err) {
          console.error('Search error:', err);
        }
      }
      return new Response('OK', { status: 200 });
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Error processing webhook:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

/**
 * 处理搜索请求
 * @param {number} chatId - Telegram chat ID
 * @param {string} query - 搜索关键词
 * @param {number} page - 页码
 * @param {object} env - Cloudflare env
 * @param {string|null} callbackQueryId - 回调Query ID（分页按钮场景）
 * @param {number|null} messageId - 消息ID（编辑原消息场景，传则为新消息）
 */
// 搜索结果消息展示时长（毫秒）：发出后自动删除
const SEARCH_RESULT_TTL_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function deleteMessage(chatId, messageId, env) {
  const TELEGRAM_API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  try {
    await fetch(`${TELEGRAM_API}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
  } catch (error) {
    console.error('deleteMessage error:', error);
  }
}

// 搜索结果发出后 30 秒自动删除：webhook 先回 OK，删除在后台跑（ctx.waitUntil），
// 不阻塞 webhook 响应，避免 Telegram 因响应超时重发 update 导致重复消息。
// 注意：若平台提前回收后台任务，个别消息可能删不掉，属于可接受的软失败。
function scheduleSearchResultDelete(chatId, sentResp, ctx, env) {
  if (!ctx || !sentResp) return;
  ctx.waitUntil((async () => {
    try {
      const data = await sentResp.json().catch(() => null);
      const messageId = data?.result?.message_id;
      if (!messageId) return;
      await sleep(SEARCH_RESULT_TTL_MS);
      await deleteMessage(chatId, messageId, env);
    } catch (error) {
      console.error('auto-delete error:', error);
    }
  })());
}

async function handleSearch(chatId, query, page = 1, env, callbackQueryId = null, messageId = null, ctx = null) {
  const pageSize = 5;
  const offset = (page - 1) * pageSize;

  // 子串搜索：FTS5 默认分词器 unicode61 会把中文切成整个 token（如“赛博朋克2077”），
  // MATCH 只能整 token 匹配，简称/前半截永远搜不到；改用 LIKE 对标题和描述做子串匹配。
  // 转义 LIKE 通配符，避免用户输入里的 % _ \ 改变查询语义。
  const escaped = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  const likePattern = `%${escaped}%`;
  const results = await env.DB.prepare(`
    SELECT id, resource_name, resource_link
    FROM pandata
    WHERE (resource_name LIKE ? ESCAPE '\\' OR resource_description LIKE ? ESCAPE '\\')
    LIMIT ? OFFSET ?
  `).bind(likePattern, likePattern, pageSize, offset).all();

  // 获取总数
  const countResult = await env.DB.prepare(`
    SELECT COUNT(*) as total FROM pandata
    WHERE (resource_name LIKE ? ESCAPE '\\' OR resource_description LIKE ? ESCAPE '\\')
  `).bind(likePattern, likePattern).first();

  const items = results.results || [];
  const total = countResult?.total || 0;
  const totalPages = Math.ceil(total / pageSize) || 1;

  // 仅当至少返回一条资源时才展示搜索结果消息；无结果时静默，不发“未找到”提示
  if (items.length === 0) {
    if (callbackQueryId) {
      await answerCallback(callbackQueryId, env);
    }
    return;
  }

  const message = formatSearchResults(query, { items, page, totalPages, total });
  const replyMarkup = buildSearchKeyboard(query, page, totalPages);

  if (messageId) {
    // 分页按钮场景：编辑原消息（无翻页时不传 reply_markup，保留原按钮）
    // 计时不重置：消息自首次发出起 30 秒后删除，翻页不延长
    await editMessageText(chatId, messageId, message, totalPages > 1 ? replyMarkup : null, env);
  } else {
    // 普通搜索场景：发送新消息，30 秒后自动删除
    const sentResp = await sendMessageWithReply(chatId, message, replyMarkup, env);
    scheduleSearchResultDelete(chatId, sentResp, ctx, env);
  }

  // 如果是回调查询，消除按钮按下状态
  if (callbackQueryId) {
    await answerCallback(callbackQueryId, env);
  }
}

/**
 * 格式化搜索结果
 */
function formatSearchResults(query, { items, page, totalPages, total }) {
  if (!items || items.length === 0) {
    return `🔍 搜索词：${query}\n\n❌ 未找到相关资源`;
  }

  let text = `🔍 搜索词：${query}\n📑 第 ${page}/${totalPages} 页 | 共 ${total} 条结果\n\n`;

  const startNum = (page - 1) * 5;
  items.forEach((item, i) => {
    text += `${startNum + i + 1}. ${item.resource_name}\n链接：${item.resource_link}\n\n`;
  });

  return text.trim();
}

/**
 * 生成分页按钮键盘
 */
function buildSearchKeyboard(query, page, totalPages) {
  if (totalPages <= 1) return {};

  const row = [];
  if (page > 1) {
    row.push({ text: '◀️ 上一页', callback_data: `search|${query}|${page - 1}` });
  }
  if (page < totalPages) {
    row.push({ text: '下一页 ▶️', callback_data: `search|${query}|${page + 1}` });
  }

  if (row.length === 0) return {};
  return { inline_keyboard: [row] };
}

/**
 * 编辑已发送的消息（用于分页翻页）
 */
async function editMessageText(chatId, messageId, text, replyMarkup, env) {
  const TELEGRAM_API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  try {
    const response = await fetch(`${TELEGRAM_API}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: replyMarkup,
      }),
    });
    if (!response.ok) {
      console.error('editMessageText error:', await response.text());
    }
  } catch (err) {
    console.error('editMessageText fetch error:', err);
  }
}

/**
 * 发送带 reply_markup 的消息
 */
async function sendMessageWithReply(chatId, text, replyMarkup, env) {
  const TELEGRAM_API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  try {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: replyMarkup,
      }),
    });
    if (!response.ok) {
      console.error('sendMessageWithReply error:', await response.text());
    }
  } catch (err) {
    console.error('sendMessageWithReply fetch error:', err);
  }
}

/**
 * 消除回调按钮按下状态
 */
async function answerCallback(callbackQueryId, env) {
  const TELEGRAM_API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  try {
    const response = await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
    if (!response.ok) {
      console.error('answerCallback error:', await response.text());
    }
  } catch (err) {
    console.error('answerCallback fetch error:', err);
  }
}

/**
 * 处理添加资源
 */
async function handleAddResource(chatId, text, env) {
  // 新格式解析
  const nameMatch = text.match(/资源名称：「(.+?)」/);
  const descMatch = text.match(/资源名称：「.+?」\s*\n\n([\s\S]+?)\n\n链接：/);
  const linkMatch = text.match(/链接：([^\n\r]+)\n\n/);
  const tipsMatch = text.match(/Tips：([^\n\r]+)/);

  if (!nameMatch || !descMatch || !linkMatch || !tipsMatch) {
    await sendMessage(chatId, '格式错误，请重新发送', env);
    return;
  }

  const resource_name = nameMatch[1].trim();
  const resource_description = descMatch[1].trim();
  const resource_link = linkMatch[1].trim();
  const resource_hint = tipsMatch[1].trim();

  try {
    // 插入数据库
    const result = await env.DB.prepare(
      'INSERT INTO pandata (resource_name, resource_description, resource_link, resource_hint) VALUES (?, ?, ?, ?)'
    ).bind(resource_name, resource_description, resource_link, resource_hint).run();

    // 获取插入的资源ID
    const resourceId = result.meta.last_row_id;
    // 查询数据库
    const resourceData = await queryResourceById(resourceId, env);

    if (!resourceData) {
      await sendMessage(chatId, `未找到 ID 为 ${resourceId} 的资源信息。`, env);
      return;
    }

    // 格式化并发送资源信息
    const formattedMessage = formatResourceMessage1(resourceData);
    await sendMessage(chatId, formattedMessage, env);
  } catch (error) {
    console.error('Error inserting resource:', error);
    await sendMessage(chatId, '添加资源失败，请稍后再试。', env);
  }
}


/**
 * 处理 /start 命令
 * 格式: /start ask_id=123 或 /start 123
 */
async function handleStartCommand(chatId, text, env) {
  try {
    // 提取 ask_id 参数
    const askId = extractAskId(text);

    if (!askId) {
      await sendMessage(chatId, '欢迎使用 GoodStudyDayUpBot！\n\n请使用正确的链接访问，格式：https://t.me/GoodStudyDayUpBot?start=资源ID', env);
      return;
    }

    // 查询数据库
    const resourceData = await queryResourceById(askId, env);

    if (!resourceData) {
      await sendMessage(chatId, `未找到 ID 为 ${askId} 的资源信息。`, env);
      return;
    }

    // 格式化并发送资源信息（带复制按钮）
    const formattedMessage = formatResourceMessage(resourceData);
    const replyMarkup = buildResourceInlineKeyboard(resourceData);
    await sendMessageWithKeyboard(chatId, formattedMessage, replyMarkup, env);

  } catch (error) {
    console.error('Error handling start command:', error);
    await sendMessage(chatId, '抱歉，查询资源信息时出现错误，请稍后再试。', env);
  }
}

/**
 * 从命令文本中提取 ask_id
 * 支持格式: /start 123 或 /start ask_id=123
 */
function extractAskId(text) {
  // 移除 /start 命令
  const params = text.replace('/start', '').trim();

  if (!params) {
    return null;
  }

  // 检查是否是 ask_id=xxx 格式
  const askIdMatch = params.match(/ask_id[=_](\d+)/i);
  if (askIdMatch) {
    return parseInt(askIdMatch[1]);
  }

  // 检查是否是纯数字
  const numMatch = params.match(/^(\d+)$/);
  if (numMatch) {
    return parseInt(numMatch[1]);
  }

  return null;
}

/**
 * 从 D1 数据库查询资源信息
 */
async function queryResourceById(askId, env) {
  try {
    const result = await env.DB.prepare(
      'SELECT * FROM pandata WHERE id = ?'
    ).bind(askId).first();

    return result;
  } catch (error) {
    console.error('Database query error:', error);
    return null;
  }
}

/**
 * 构建资源详情的内联键盘（复制按钮）
 */
// Telegram 的 copy_text 按钮上限 256 字符；超了整条消息会被 400 拒掉
// （BUTTON_COPY_TEXT_INVALID），用户看到的就是「点开 start=xxx 什么都没有」。
const COPY_TEXT_LIMIT = 256;

function clipCopyText(text, limit = COPY_TEXT_LIMIT) {
  const s = String(text || '');
  if (s.length <= limit) return s;
  let out = '';
  for (const ch of s) { // 按码点走，别劈开 emoji 的代理对
    if (out.length + ch.length > limit) break;
    out += ch;
  }
  return out;
}

function buildResourceInlineKeyboard(resource) {
  const promos = [
    '免费高清影视资源尽在devmini.space',
    '精品端手游戏资源尽在devmini.space',
    '备考办公素材资源尽在devmini.space'
  ].join('\n');
  const name = clipCopyText(resource.resource_name || '', 60);
  const link = clipCopyText(resource.resource_link || '', 100);
  const head = `📌资源名称：${name}\n📝资源描述：`;
  const tail = `\n🔗资源链接：${link}\n\n${promos}`;
  const budget = Math.max(0, COPY_TEXT_LIMIT - head.length - tail.length);
  const desc = clipCopyText(resource.resource_description || '', budget);

  const copyTitle = clipCopyText(resource.resource_name || '');
  const copyFull = clipCopyText(`${head}${desc}${tail}`);

  return {
    inline_keyboard: [[
      { text: '📋 一键复制标题', copy_text: { text: copyTitle } },
      { text: '📋 一键复制全文', copy_text: { text: copyFull } },
    ]]
  };
}

/**
 * 格式化资源信息为消息文本
 */
function formatResourceMessage(resource) {
  let message = '📚 资源信息\n\n';

  if (resource.resource_name) {
    message += `📌 资源名称：${resource.resource_name}\n\n`;
  }

  if (resource.resource_description) {
    message += `📝 资源描述：\n${resource.resource_description}\n\n`;
  }

  if (resource.resource_link) {
    message += `🔗 资源链接：\n${resource.resource_link}\n\n`;
  }

  if (resource.resource_hint) {
    message += `💡 使用提示：\n${resource.resource_hint}\n`;
  }

  return message;
}

/**
 * 格式化资源信息为消息文本
 */
function formatResourceMessage1(resource) {
  let message = '';

  if (resource.resource_name) {
    message += `📌${resource.resource_name}\n\n`;
  }

  if (resource.resource_description) {
    message += `📝${resource.resource_description}\n\n`;
  }

  if (resource.resource_name) {
    message += `🔗点击获取${resource.resource_name}\n`;
  }

  if (resource.resource_hint) {
    message += `https://t.me/GoodStudyDayUpBot?start=${resource.id}`;
  }

  return message;
}

/**
 * 发送消息到 Telegram
 */
async function sendMessage(chatId, text, env) {
  const TELEGRAM_API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

  try {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Telegram API error:', error);
    }

    return response;
  } catch (error) {
    console.error('Error sending message:', error);
    throw error;
  }
}

/**
 * 发送带内联键盘的消息到 Telegram
 */
async function sendMessageWithKeyboard(chatId, text, replyMarkup, env) {
  const TELEGRAM_API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

  try {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('sendMessageWithKeyboard error:', error);
    }

    return response;
  } catch (error) {
    console.error('Error sending message with keyboard:', error);
    throw error;
  }
}
