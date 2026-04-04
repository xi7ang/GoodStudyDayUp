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
      return handleTelegramWebhook(request, env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

// 用于记录每个 chatId 的添加状态
const addStateMap = new Map();

/**
 * 处理 Telegram webhook 请求
 */
async function handleTelegramWebhook(request, env) {
  try {
    const update = await request.json();

    // 检查是否是消息更新
    if (!update.message) {
      return new Response('OK', { status: 200 });
    }

    const message = update.message;
    const chatId = message.chat.id;
    const text = message.text;

    // 检查是否处于添加资源状态
    if (addStateMap.get(chatId) === 'waiting_resource_info' && text) {
      await handleAddResource(chatId, text, env);
      addStateMap.delete(chatId);
      return new Response('OK', { status: 200 });
    }

    // 处理 /add 命令
    if (text && text.trim() === '/add') {
      addStateMap.set(chatId, 'waiting_resource_info');
      await sendMessage(chatId, '请按照以下格式发送资源信息', env);
      return new Response('OK', { status: 200 });
    }

    // 处理 /start 命令
    if (text && text.startsWith('/start')) {
      await handleStartCommand(chatId, text, env);
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Error processing webhook:', error);
    return new Response('Internal Server Error', { status: 500 });
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

    // 格式化并发送资源信息
    const formattedMessage = formatResourceMessage(resourceData);
    await sendMessage(chatId, formattedMessage, env);

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
