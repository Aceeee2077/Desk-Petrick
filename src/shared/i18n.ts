// ============================================================================
// Single source of truth for the app's UI strings (zh / en).
// Used by the main process (tray, context menu, dialogs, AI error messages) and
// served to the renderer via the 'i18n:get' IPC so window.PetricI18n can translate.
// Keys are flat. Values may be strings or arrays (e.g. the click speech lines).
// ============================================================================

export const zhDict: Record<string, I18nValue> = {
  // Pet window
  'bubble.greeting': '喵～ 我是 Petric！',
  'bubble.aiNotEnabled': 'AI 对话还没开启，去设置里配置一下吧 ✨',
  'bubble.noCustom': '没有找到自定义外观，去设置里选一张吧 🖼️',
  'bubble.no3d': '3D 渲染不可用，已回退到猫 🐱',
  'bubble.modelLoadFail': '3D 模型加载失败，已回退到猫 🐱',
  'bubble.imageLoadFail': '图片加载失败，已回退到猫 🐱',
  'bubble.thinking': '💭 思考中…',
  'chat.placeholder': '和宠物说点什么…',
  'chat.send': '发送',
  lines: ['喵～', '别摸我！', '饿了…', '今天也要加油鸭！', '(*^▽^*)', '哼，不许偷看我！', '陪我玩嘛～'],

  // Settings panel
  'settings.windowTitle': 'Petric 设置',
  'settings.title': '🐾 Petric 设置',
  'settings.close': '关闭',
  'settings.language': '界面语言',
  'settings.zh': '中文',
  'settings.en': 'English',
  'settings.petSection': '宠物',
  'settings.skin': '宠物类型',
  'settings.skinCat': '🐱 猫',
  'settings.skinDog': '🐶 狗',
  'settings.skinDango': '👻 团子',
  'settings.skinCustom': '🖼️ 自定义',
  'settings.customLabel': '自定义外观',
  'settings.pickFile': '🖼️ 选择文件…',
  'settings.customType': '类型',
  'settings.modeSingle': '单张图片',
  'settings.modeSheet': '精灵表',
  'settings.modeModel': '🧊 3D 模型',
  'settings.modeBillboard': '🧱 2.5D 立牌',
  'settings.clearCustom': '🗑️ 清除自定义外观',
  'settings.customHint':
    '支持图片 PNG / JPG / WebP / GIF（≤15MB）与 3D 模型 GLB（≤60MB）。<br/>「单张图片」：整体显示，程序自动做呼吸 / 行走 / 睡眠 / 跳跃动画；<br/>「精灵表」：需要 4 行 × 4 列、行序 idle / walking / sleeping / click，每帧等大；<br/>「3D 模型」：GLB 格式，程序自动适配大小并做待机 / 行走 / 睡眠 / 点击动画，点击判定用射线检测；<br/>「2.5D 立牌」：单张图片放进 3D 场景，朝向光标转动、拖拽倾斜，看起来立体、本质是平片。',
  'settings.animSpeed': '动画速度',
  'settings.opacity': '透明度',
  'settings.sound': '点击音效',
  'settings.autolaunch': '开机自启',
  'settings.resetPos': '🎯 重置位置',
  'settings.aiSection': 'AI 对话',
  'settings.optional': '可选',
  'settings.aiEnabled': '启用 AI 对话',
  'settings.apiBase': 'API Base URL',
  'settings.apiKey': 'API Key',
  'settings.model': '模型',
  'settings.testAi': '🧪 测试对话',
  'settings.aiHint':
    '支持任何 OpenAI 兼容接口：OpenAI、DeepSeek、Moonshot、Ollama 等。<br/>API Key 仅保存在本机 userData/config.json，不会上传到任何地方。',
  'settings.choosing': '选择中…',
  'settings.applied': '✅ 已应用',
  'settings.cancelled': '已取消选择',
  'settings.cleared': '已清除',
  'settings.requesting': '请求中…',
  'settings.failed': '失败：',
  'settings.aiTestPrompt': '你好！请用一句话介绍你自己。',
  'settings.apiOk': '✓ API 正常',

  // Screenshot compositing (--screenshot mode)
  'shot.browser': '浏览器',
  'shot.terminal': '终端',

  // Main process: AI errors, tray, context menu, dialogs
  'errors.aiDisabled': 'AI 对话未启用：请打开设置 → 「启用 AI 对话」开关',
  'errors.noApiKey': '未填写 API Key：请在设置 → AI 对话 中粘贴你的 API Key',
  'errors.network': '网络请求失败，请检查 API Base URL 与网络连接',
  'errors.apiStatus': 'API 返回 {status}: {body}',
  'errors.noReply': 'API 未返回有效回复',
  'menu.settings': '⚙️ 打开设置',
  'menu.chat': '💬 AI 对话',
  'menu.resetPos': '🎯 重置位置',
  'menu.quitPet': '👋 退出宠物',
  'menu.quit': '👋 退出',
  'tray.tooltip': 'Petric · 桌面宠物',
  'dialog.pickTitle': '选择宠物外观（图片或 3D 模型）',
  'dialog.filterAll': '图片/模型',
  'dialog.filterModel': '3D 模型',
  'dialog.filterImage': '图片',
  'dialog.unsupportedFormat': '不支持的格式',
  'dialog.copyFailed': '复制文件失败',
  'dialog.readFailed': '读取自定义外观失败',
};

export const enDict: Record<string, I18nValue> = {
  // Pet window
  'bubble.greeting': 'Meow~ I\'m Petric!',
  'bubble.aiNotEnabled': 'AI chat is not enabled yet — set it up in Settings ✨',
  'bubble.noCustom': 'No custom appearance found — pick one in Settings 🖼️',
  'bubble.no3d': '3D rendering unavailable, switched back to the cat 🐱',
  'bubble.modelLoadFail': 'Failed to load the 3D model, switched back to the cat 🐱',
  'bubble.imageLoadFail': 'Failed to load the image, switched back to the cat 🐱',
  'bubble.thinking': '💭 Thinking…',
  'chat.placeholder': 'Say something to your pet…',
  'chat.send': 'Send',
  lines: ['Meow~', 'Don\'t touch me!', 'I\'m hungry…', 'You can do it today!', '(*^▽^*)', 'Hey, don\'t stare!', 'Play with me~'],

  // Settings panel
  'settings.windowTitle': 'Petric Settings',
  'settings.title': '🐾 Petric Settings',
  'settings.close': 'Close',
  'settings.language': 'Language',
  'settings.zh': '中文',
  'settings.en': 'English',
  'settings.petSection': 'Pet',
  'settings.skin': 'Pet type',
  'settings.skinCat': '🐱 Cat',
  'settings.skinDog': '🐶 Dog',
  'settings.skinDango': '👻 Dango',
  'settings.skinCustom': '🖼️ Custom',
  'settings.customLabel': 'Custom appearance',
  'settings.pickFile': '🖼️ Choose File…',
  'settings.customType': 'Type',
  'settings.modeSingle': 'Single image',
  'settings.modeSheet': 'Sprite sheet',
  'settings.modeModel': '🧊 3D model',
  'settings.modeBillboard': '🧱 2.5D standee',
  'settings.clearCustom': '🗑️ Clear custom appearance',
  'settings.customHint':
    'Supports images PNG / JPG / WebP / GIF (≤15MB) and 3D models GLB (≤60MB).<br/>"Single image": shown as-is with procedural breathing / walking / sleeping / click animation.<br/>"Sprite sheet": 4 rows × 4 columns, row order idle / walking / sleeping / click, equal frames.<br/>"3D model": GLB format, auto-fitted size with procedural idle / walking / sleeping / click animation; hit testing uses raycasting.<br/>"2.5D standee": a single image placed in the 3D scene — it turns toward the cursor and leans while dragging, so it looks 3D while staying a flat plane.',
  'settings.animSpeed': 'Animation speed',
  'settings.opacity': 'Opacity',
  'settings.sound': 'Click sound',
  'settings.autolaunch': 'Launch at startup',
  'settings.resetPos': '🎯 Reset position',
  'settings.aiSection': 'AI Chat',
  'settings.optional': 'optional',
  'settings.aiEnabled': 'Enable AI chat',
  'settings.apiBase': 'API Base URL',
  'settings.apiKey': 'API Key',
  'settings.model': 'Model',
  'settings.testAi': '🧪 Test Chat',
  'settings.aiHint':
    'Works with any OpenAI-compatible API: OpenAI, DeepSeek, Moonshot, Ollama, etc.<br/>Your API Key is stored only on this machine (userData/config.json) and is never uploaded anywhere.',
  'settings.choosing': 'Choosing…',
  'settings.applied': '✅ Applied',
  'settings.cancelled': 'Selection cancelled',
  'settings.cleared': 'Cleared',
  'settings.requesting': 'Requesting…',
  'settings.failed': 'Failed: ',
  'settings.aiTestPrompt': 'Hi! Introduce yourself in one sentence.',
  'settings.apiOk': '✓ API OK',

  // Screenshot compositing (--screenshot mode)
  'shot.browser': 'Browser',
  'shot.terminal': 'Terminal',

  // Main process: AI errors, tray, context menu, dialogs
  'errors.aiDisabled': 'AI chat is disabled — enable the "AI Chat" toggle in Settings',
  'errors.noApiKey': 'No API Key — paste your API Key under Settings → AI Chat',
  'errors.network': 'Network request failed — check the API Base URL and your connection',
  'errors.apiStatus': 'API returned {status}: {body}',
  'errors.noReply': 'The API returned no valid reply',
  'menu.settings': '⚙️ Open Settings',
  'menu.chat': '💬 AI Chat',
  'menu.resetPos': '🎯 Reset Position',
  'menu.quitPet': '👋 Quit Pet',
  'menu.quit': '👋 Quit',
  'tray.tooltip': 'Petric · Desktop Pet',
  'dialog.pickTitle': 'Choose a pet appearance (image or 3D model)',
  'dialog.filterAll': 'Images / Models',
  'dialog.filterModel': '3D Models',
  'dialog.filterImage': 'Images',
  'dialog.unsupportedFormat': 'Unsupported file format',
  'dialog.copyFailed': 'Failed to copy the file',
  'dialog.readFailed': 'Failed to read the custom appearance',
};

export function getDict(locale: Locale): Record<string, I18nValue> {
  return locale === 'en' ? enDict : zhDict;
}

/** Build a translate function bound to a locale. Params fill {placeholders}. */
export function makeT(locale: Locale) {
  const dict = getDict(locale);
  return (key: string, params?: Record<string, string | number>): string | I18nValue => {
    const v = dict[key] ?? key;
    if (typeof v === 'string' && params) {
      return v.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''));
    }
    return v;
  };
}
