import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getEntityWithHash } from "@utils/entityHelpers";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { getPrefixes } from "@utils/pluginManager";
import { Api, TelegramClient } from "telegram";
import Database from "better-sqlite3";
import path from "path";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 原生表情符号常量 - 移除限制，支持所有Telegram表情
const NATIVE_EMOJI = "👍👎❤️🔥🥰👏😁🤔🤯😱🤬😢🎉🤩🤮💩🙏👌🕊🤡🥱🥴😍🐳❤️‍🔥🌚🌭💯🤣⚡️🍌🏆💔🤨😐🍓🍾💋🖕😈😂😭🤓👻👀🎃🙈😇😨🤝🤗🫡🎅🎄☃💅🤪🗿🆒💘🙉🦄😘💊🙊😎👾🤷😡";

// 特殊表情处理
const SPECIAL_EMOJI = "❤⬅↔➡⬆↕⬇";

// 控制字符 - 不应该作为独立反应
const CONTROL_CHARS = "\u200D\uFE0F\uFE0E"; // ZWJ, 变体选择符-16, 变体选择符-15

// 安全的默认表情（保持与官方版本兼容）
const SAFE_EMOJI = ["👍", "👎", "❤", "🔥", "😁", "😢", "🎉", "💩", "🤔", "😍"];

// 小丑表情ID列表（自定义表情）
const CLOWN_EMOJI_IDS = [
    "5249208900598641447",
    "5388998197613965755",
    "5415631414370510984",
    "5316602649779384632",
    "5210859644418798349",
    "5327767266941478693",
    "5429644664296715383",
    "5402175118623385061"
];

// 原生小丑表情
const NATIVE_CLOWN_EMOJI = "🤡";

// 大便表情ID列表（自定义表情）
const POOP_EMOJI_IDS = [
    "5429203794493717628",
    "5307750138066775853",
    "5389048680659563012",
    "5377629290332435662",
    "5471979757501439582",
    "5429284870591367446",
    "5433681959324754801",
    "5402470324610550699",
    "5316787853064155468",
    "5303480055811298438",
    "5368351181720544844",
    "5409092829173526107",
    "5465126784993347582",
    "6003598551563639868",
    "6001576717183884607",
    "6001211924136598257",
    "6001510871040268463",
    "6003628831083075884",
    "6001248246675020408",
    "6003515800428746396",
    "6001608637380827819",
    "6001534613619480981",
    "6001303716177649390",
    "6003362680549677107",
    "6003440608436297289",
    "6001349603608238751",
    "6001122344003706760",
    "6001450024238586900",
    "6001520341443157444",
    "6001135224610625424",
    "6003602636077538330",
    "6001257970480978814",
    "6003562082996337690",
    "6001075305521880360",
    "6001558562357123088",
    "6001529412414086809",
    "6003769658765746304",
    "6001593716664441412",
    "6003753922005571953",
    "6001072930404965715",
    "6003399724642605679",
    "6003671879540284434",
    "6001418185646021664",
    "6001155909173123162",
    "6001195611850807452",
    "6003755193315891739",
    "6001384938304182239",
    "6003544430680742410",
    "6003597288843254774",
    "6001577335659174948",
    "6003722736248035505",
    "6001254757845444027",
    "6001147259108990476",
    "6001431246641568735",
    "6001258374207904061",
    "6001484220768196934",
    "6001434850119129305",
    "6001517906196700557",
    "6001149329283226435",
    "6003531348210359239",
    "6001500378435164777",
    "6003729719864859938"
];

// 原生大便表情
const NATIVE_POOP_EMOJI = "💩";

// 表情模式配置
interface EmojiModeConfig {
    nativeEmoji: string;
    customEmojiIds: string[];
    modeName: string;
}

const EMOJI_MODES: Record<string, EmojiModeConfig> = {
    clown: {
        nativeEmoji: NATIVE_CLOWN_EMOJI,
        customEmojiIds: CLOWN_EMOJI_IDS,
        modeName: "小丑模式"
    },
    poop: {
        nativeEmoji: NATIVE_POOP_EMOJI,
        customEmojiIds: POOP_EMOJI_IDS,
        modeName: "大便模式"
    }
};

// 命令触发词到模式键的映射
const COMMAND_TO_MODE: Record<string, string> = {
    "小丑": "clown",
    "便便": "poop"
};

// 配置常量
const MAX_REACTIONS_NORMAL = 1;  // 普通用户只能显示1个反应
const MAX_REACTIONS_PREMIUM = 3; // 会员用户最多同时显示3个反应

// HTML转义函数
const htmlEscape = (text: string): string =>
    text.replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;',
        '"': '&quot;', "'": '&#x27;'
    }[m] || m));

// 延迟函数
const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms));

// 通用的随机表情选择函数
function getRandomEmojisForMode(modeKey: string, count: number): { nativeEmojis: string[], customEmojiIds: string[] } {
    const modeConfig = EMOJI_MODES[modeKey];
    if (!modeConfig || count <= 0) {
        return { nativeEmojis: [], customEmojiIds: [] };
    }

    // 合并原生表情和自定义表情，创建候选池
    const allOptions = [
        { type: 'native', value: modeConfig.nativeEmoji },
        ...modeConfig.customEmojiIds.map(id => ({ type: 'custom', value: id }))
    ];

    // 随机洗牌
    const shuffled = [...allOptions];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // 选择指定数量，但不超过可用表情总数
    const selected = shuffled.slice(0, Math.min(count, allOptions.length));

    const nativeEmojis: string[] = [];
    const customEmojiIds: string[] = [];

    selected.forEach(item => {
        if (item.type === 'native') {
            nativeEmojis.push(item.value);
        } else {
            customEmojiIds.push(item.value);
        }
    });

    return { nativeEmojis, customEmojiIds };
}

// 通用的表情模式命令处理函数
async function handleEmojiModeCommand(
    msg: Api.Message,
    client: TelegramClient,
    modeKey: string,
    count: number,
    config: any
): Promise<void> {
    const modeConfig = EMOJI_MODES[modeKey];
    if (!modeConfig) {
        await editAndDelete(
            msg,
            `❌ <b>错误:</b> 未知模式: ${modeKey}`,
            5,
            config.keep_log
        );
        return;
    }

    if (![1, 2, 3].includes(count)) {
        await editAndDelete(
            msg,
            `❌ <b>参数错误:</b> ${modeConfig.modeName}数量必须是 1、2 或 3\n\n💡 用法: <code>${mainPrefix}trace ${Object.keys(COMMAND_TO_MODE).find(k => COMMAND_TO_MODE[k] === modeKey)} [1|2|3]</code>`,
            5,
            config.keep_log
        );
        return;
    }

    const replyMsg = await msg.getReplyMessage();
    if (!replyMsg || !replyMsg.fromId) {
        await editAndDelete(
            msg,
            `❌ <b>错误:</b> 请回复一条消息来启用${modeConfig.modeName}`,
            5,
            config.keep_log
        );
        return;
    }

    const userId = Number(replyMsg.senderId?.toString());
    if (!userId) {
        await editAndDelete(
            msg,
            "❌ <b>错误:</b> 无法获取用户ID",
            5,
            config.keep_log
        );
        return;
    }

    // 检查是否已经追踪该用户
    const existingData = traceDB.getTracedUser(userId);

    // 添加或更新表情模式（使用新的通用格式）
    traceDB.addTracedUser(userId, [], [], undefined, undefined, { mode: modeKey, count });

    const userInfo = await client.getEntity(replyMsg.fromId);
    const formattedUser = formatUserInfo(userInfo);

    if (existingData) {
        await editAndDelete(
            msg,
            `🔄 <b>更新为${modeConfig.modeName}:</b>\n👤 ${htmlEscape(formattedUser)}\n🎭 旧: ${formatReactions(existingData)}\n🎭 新: [${modeConfig.modeName} x${count}]`,
            5,
            config.keep_log
        );
    } else {
        await editAndDelete(
            msg,
            `✅ <b>启用${modeConfig.modeName}:</b>\n👤 ${htmlEscape(formattedUser)}\n🎭 [${modeConfig.modeName} x${count}]`,
            5,
            config.keep_log
        );
    }

    // 立即发送演示反应
    const { nativeEmojis, customEmojiIds } = getRandomEmojisForMode(modeKey, count);
    const reactions = await generateReactionList(nativeEmojis, customEmojiIds, config.max_reactions);
    await sendReaction(client, msg.chatId!.toString(), replyMsg.id, reactions, config.big);
}

// 向后兼容的函数（可以删除，但保留以免破坏现有代码）
function getRandomClownEmojis(count: number): string[] {
    const { customEmojiIds } = getRandomEmojisForMode('clown', count);
    return customEmojiIds;
}

function getRandomPoopEmojis(count: number): { nativeEmojis: string[], customEmojiIds: string[] } {
    return getRandomEmojisForMode('poop', count);
}

// 数据库接口定义
interface TraceConfig {
    keep_log: boolean;
    big: boolean;
    premium_mode: boolean;  // 是否启用会员模式（支持多个反应同时显示）
    max_reactions: number;   // 最大同时显示的反应数量
}

interface TracedUser {
    user_id: number;
    reactions: string[];
    custom_emojis?: string[]; // 自定义表情ID列表（会员功能）
    clown_mode?: number; // 小丑模式：1-3 表示随机显示几个小丑表情，undefined 表示非小丑模式
    poop_mode?: number; // 大便模式：1-3 表示随机显示几个大便表情，undefined 表示非大便模式
    emoji_mode?: { mode: string, count: number }; // 通用表情模式：{mode: 'clown'|'poop'|..., count: 1-3}
}

// 数据库管理类
class TraceDB {
    private db: Database.Database;
    private dbPath: string;

    constructor() {
        const pluginDir = createDirectoryInAssets("trace");
        this.dbPath = path.join(pluginDir, "trace.db");
        this.db = new Database(this.dbPath);
        this.init();
    }

    private init(): void {
        // 创建配置表
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

        // 创建用户追踪表
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS traced_users (
        user_id INTEGER PRIMARY KEY,
        reactions TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

        // 初始化默认配置
        this.initDefaultConfig();
    }

    private initDefaultConfig(): void {
        const defaultConfig = {
            keep_log: true,
            big: true,
            premium_mode: false,
            max_reactions: 3  // 默认允许3个反应，便于调试
        };

        for (const [key, value] of Object.entries(defaultConfig)) {
            const existing = this.getConfig(key);
            if (existing === null) {
                this.setConfig(key, value.toString());
            }
        }

        // 强制更新 max_reactions 为 3（用于调试）
        this.setConfig('max_reactions', '3');
        console.log(`[Trace] 🔧 强制更新 max_reactions 为 3`);
    }

    // 配置管理
    setConfig(key: string, value: string): void {
        const stmt = this.db.prepare(`
      INSERT INTO config (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
        stmt.run(key, value);
    }

    getConfig(key: string): string | null {
        const stmt = this.db.prepare(`SELECT value FROM config WHERE key = ?`);
        const result = stmt.get(key) as { value: string } | undefined;
        return result?.value || null;
    }

    getTraceConfig(): TraceConfig {
        return {
            keep_log: this.getConfig('keep_log') === 'true',
            big: this.getConfig('big') === 'true',
            premium_mode: this.getConfig('premium_mode') === 'true',
            max_reactions: parseInt(this.getConfig('max_reactions') || '1')
        };
    }

    // 用户追踪管理
    addTracedUser(userId: number, reactions: string[], customEmojis?: string[], clownMode?: number, poopMode?: number, emojiMode?: { mode: string, count: number }): void {
        const data = {
            reactions,
            custom_emojis: customEmojis || [],
            clown_mode: clownMode,
            poop_mode: poopMode,
            emoji_mode: emojiMode
        };
        const stmt = this.db.prepare(`
      INSERT INTO traced_users (user_id, reactions)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        reactions = excluded.reactions,
        created_at = CURRENT_TIMESTAMP
    `);
        stmt.run(userId, JSON.stringify(data));
    }

    removeTracedUser(userId: number): { reactions: string[], custom_emojis?: string[], clown_mode?: number, poop_mode?: number, emoji_mode?: { mode: string, count: number } } | null {
        const stmt = this.db.prepare(`SELECT reactions FROM traced_users WHERE user_id = ?`);
        const result = stmt.get(userId) as { reactions: string } | undefined;

        if (result) {
            const deleteStmt = this.db.prepare(`DELETE FROM traced_users WHERE user_id = ?`);
            deleteStmt.run(userId);
            const data = JSON.parse(result.reactions);
            // 兼容旧数据格式
            if (Array.isArray(data)) {
                return { reactions: data, custom_emojis: [], clown_mode: undefined, poop_mode: undefined, emoji_mode: undefined };
            }
            return data;
        }
        return null;
    }

    getTracedUser(userId: number): { reactions: string[], custom_emojis?: string[], clown_mode?: number, poop_mode?: number, emoji_mode?: { mode: string, count: number } } | null {
        const stmt = this.db.prepare(`SELECT reactions FROM traced_users WHERE user_id = ?`);
        const result = stmt.get(userId) as { reactions: string } | undefined;
        if (!result) return null;

        const data = JSON.parse(result.reactions);
        // 兼容旧数据格式
        if (Array.isArray(data)) {
            return { reactions: data, custom_emojis: [], clown_mode: undefined, poop_mode: undefined, emoji_mode: undefined };
        }
        return data;
    }

    getAllTracedUsers(): TracedUser[] {
        const stmt = this.db.prepare(`SELECT user_id, reactions FROM traced_users`);
        const results = stmt.all() as { user_id: number; reactions: string }[];
        return results.map(row => {
            const data = JSON.parse(row.reactions);
            // 兼容旧数据格式
            if (Array.isArray(data)) {
                return {
                    user_id: row.user_id,
                    reactions: data,
                    custom_emojis: [],
                    clown_mode: undefined,
                    poop_mode: undefined,
                    emoji_mode: undefined
                };
            }
            return {
                user_id: row.user_id,
                reactions: data.reactions || [],
                custom_emojis: data.custom_emojis || [],
                clown_mode: data.clown_mode,
                poop_mode: data.poop_mode,
                emoji_mode: data.emoji_mode
            };
        });
    }

    // 清理所有数据
    clearAll(): void {
        this.db.exec(`DELETE FROM traced_users`);
    }

    // 重置所有数据（包括配置）
    resetAll(): void {
        this.db.exec(`DELETE FROM traced_users`);
        this.db.exec(`DELETE FROM config`);
        this.initDefaultConfig();
    }

    close(): void {
        this.db.close();
    }
}

// 全局数据库实例
const traceDB = new TraceDB();

// UTF-8字节偏移转UTF-16字符偏移（修复字符位置Bug）
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function utf8ByteToUtf16CharOffset(text: string, byteOffset: number): number {
    const textEncoder = new TextEncoder();

    console.log(`[Trace] UTF转换: byteOffset=${byteOffset}, 文本="${text}"`);

    if (byteOffset <= 0) {
        console.log(`[Trace] byteOffset<=0，返回0`);
        return 0;
    }

    // 使用更精确的方式：逐个代码点计算
    let currentBytePos = 0;
    let charPos = 0;

    for (const char of text) {
        const charBytes = textEncoder.encode(char).length;
        console.log(`[Trace] 字符'${char}' (位置${charPos}): ${charBytes}字节, 累计${currentBytePos + charBytes}字节`);

        if (currentBytePos === byteOffset) {
            console.log(`[Trace] 精确匹配在字符位置: ${charPos}`);
            return charPos;
        }

        if (currentBytePos + charBytes > byteOffset) {
            // 字节偏移在当前字符内部，返回当前字符的起始位置
            console.log(`[Trace] 字节偏移在字符'${char}'内部，返回起始位置: ${charPos}`);
            return charPos;
        }

        currentBytePos += charBytes;
        charPos++;

        if (currentBytePos === byteOffset) {
            console.log(`[Trace] 精确匹配在字符结束位置: ${charPos}`);
            return charPos;
        }
    }

    console.log(`[Trace] 超出文本范围，返回文本长度: ${text.length}`);
    return text.length;
}

// 简化版表情解析函数 - 先扫描原生表情，再处理自定义表情
function parseEmojis(text: string, entities?: Api.TypeMessageEntity[]): { emojis: string[], customEmojiIds: string[] } {
    const emojis: string[] = [];
    const customEmojiIds: string[] = [];

    if (!text || !text.trim()) {
        console.log(`[Trace] 输入文本为空或只有空格`);
        return { emojis, customEmojiIds };
    }

    console.log(`[Trace] 解析表情: "${text}"`);
    const allNativeEmojis = Array.from(NATIVE_EMOJI).sort((a, b) => b.length - a.length);
    const foundNativeEmojis: Array<{ position: number, emoji: string }> = [];

    let index = 0;
    while (index < text.length) {
        let foundEmoji = false;
        for (const emoji of allNativeEmojis) {
            if (text.substring(index).startsWith(emoji)) {
                // 检查是否是控制字符
                if (!CONTROL_CHARS.includes(emoji)) {
                    foundNativeEmojis.push({ position: index, emoji });
                }
                index += emoji.length;
                foundEmoji = true;
                break;
            }
        }
        if (!foundEmoji) {
            index++;
        }
    }

    if (entities && entities.length > 0) {
        for (const entity of entities) {
            if (entity.className === 'MessageEntityCustomEmoji') {
                const customEmojiId = (entity as any).documentId?.value?.toString() ||
                    (entity as any).documentId?.toString();

                if (customEmojiId) {
                    customEmojiIds.push(customEmojiId);
                }
            }
        }
    }

    // 添加原生表情，但要避免与自定义表情重复
    // 如果有自定义表情实体，优先使用自定义表情而不是原生表情
    const hasCustomEmojis = customEmojiIds.length > 0;

    if (!hasCustomEmojis) {
        // 只有在没有自定义表情时才添加原生表情
        for (const item of foundNativeEmojis) {
            if (emojis.length + customEmojiIds.length >= 3) break;
            if (!emojis.includes(item.emoji)) {
                emojis.push(item.emoji);
            }
        }
    }

    // 限制总数为3
    const totalCount = emojis.length + customEmojiIds.length;
    if (totalCount > 3) {
        const excessCount = totalCount - 3;
        customEmojiIds.splice(-excessCount);
    }

    if (emojis.length > 0 || customEmojiIds.length > 0) {
        console.log(`[Trace] 解析结果 - 原生: [${emojis.join(", ")}], 自定义: [${customEmojiIds.join(", ")}]`);
    }
    return { emojis, customEmojiIds };
}

// 工具函数：生成反应列表
async function generateReactionList(
    emojis: string[],
    customEmojiIds?: string[],
    maxReactions: number = 1
): Promise<Api.TypeReaction[]> {
    console.log(`[Trace] 🔧 生成反应: 原生[${emojis.join(', ')}] 自定义[${(customEmojiIds || []).join(', ')}] 限制=${maxReactions}`);

    // 合并所有表情（普通和自定义）
    const allReactions: Api.TypeReaction[] = [];

    // 处理原生表情
    for (const emoji of emojis) {
        if (emoji && NATIVE_EMOJI.includes(emoji)) {
            try {
                const reaction = new Api.ReactionEmoji({
                    emoticon: emoji
                });
                allReactions.push(reaction);
            } catch (error: any) {
                console.error(`[Trace] 🔧 ❌ 创建原生反应失败 ${emoji}:`, error.message);
            }
        }
    }

    // 处理自定义表情
    if (customEmojiIds && customEmojiIds.length > 0) {
        for (const customId of customEmojiIds) {
            try {
                const reaction = new Api.ReactionCustomEmoji({
                    documentId: BigInt(customId) as any
                });
                allReactions.push(reaction);
            } catch (error: any) {
                console.error(`[Trace] 🔧 ❌ 创建自定义表情失败 ${customId}:`, error.message);
            }
        }
    }

    // 根据maxReactions限制返回的反应数量
    const limitedReactions = allReactions.slice(0, maxReactions);

    if (limitedReactions.length !== allReactions.length) {
        console.log(`[Trace] 🔧 ⚠️ 反应被限制: ${allReactions.length} -> ${limitedReactions.length}`);
    }

    console.log(`[Trace] 🔧 ✅ 生成完成: ${limitedReactions.length} 个反应`);
    return limitedReactions;
}

// 工具函数：发送反应
async function sendReaction(
    client: TelegramClient,
    chatId: number | string,
    messageId: number,
    reactions: Api.TypeReaction[],
    big: boolean = false
): Promise<void> {
    console.log(`[Trace] 📤 发送 ${reactions.length} 个反应到消息 ${messageId}`);

    try {
        const peer = await getEntityWithHash(client, chatId);
        if (!peer || !reactions || reactions.length === 0) {
            console.error(`[Trace] 📤 ❌ 参数无效: peer=${!!peer}, reactions=${reactions?.length}`);
            return;
        }

        try {
            await client.invoke(new Api.messages.SendReaction({
                peer: peer,
                msgId: messageId,
                reaction: reactions,
                big: false,
                addToRecent: true
            }));
            console.log(`[Trace] 📤 ✅ 发送成功`);
        } catch (firstError: any) {
            if (big && !firstError.errorMessage?.includes('REACTION_INVALID')) {
                console.log(`[Trace] 📤 🔄 重试 big=true`);
                await client.invoke(new Api.messages.SendReaction({
                    peer: peer,
                    msgId: messageId,
                    reaction: reactions,
                    big: true,
                    addToRecent: true
                }));
                console.log(`[Trace] 📤 ✅ 重试成功`);
            } else {
                throw firstError;
            }
        }
    } catch (error: any) {
        console.error(`[Trace] 📤 ❌ 发送失败:`, error.message);
    }
}

// 工具函数：编辑并删除消息
async function editAndDelete(
    msg: Api.Message,
    text: string,
    seconds: number = 5,
    keepLog: boolean = false
): Promise<void> {
    try {
        await msg.edit({ text, parseMode: "html" });

        if (seconds === -1 || keepLog) {
            return;
        }

        await sleep(seconds * 1000);
        await msg.delete();
    } catch (error: any) {
        console.error("[Trace] 消息操作失败:", error.message || error);
    }
}

// 工具函数：格式化用户信息
function formatUserInfo(user: any): string {
    let name = "";
    if (user.firstName) name += user.firstName;
    if (user.lastName) name += " " + user.lastName;

    if (user.username) {
        return `@${user.username}`;
    } else if (name.trim()) {
        return name.trim();
    } else {
        return "未知用户";
    }
}

// 工具函数：检测用户是否为Telegram Premium会员
async function checkUserPremium(client: TelegramClient, userId: number): Promise<boolean> {
    try {
        console.log(`[Trace] 检测用户 ${userId} 的会员状态...`);

        // 获取用户完整信息
        const userEntity = await client.getEntity(userId);

        // 检查用户是否有Premium标识
        if ('premium' in userEntity && userEntity.premium) {
            console.log(`[Trace] 用户 ${userId} 是Telegram Premium会员`);
            return true;
        }

        console.log(`[Trace] 用户 ${userId} 不是Telegram Premium会员`);
        return false;
    } catch (error: any) {
        console.error(`[Trace] 检测用户 ${userId} 会员状态失败:`, error.message);
        // 检测失败时默认为非会员
        return false;
    }
}

// 工具函数：自动启用会员模式（如果用户是Premium会员且设置了多个表情）
async function autoEnablePremiumMode(
    client: TelegramClient,
    userId: number,
    emojis: string[],
    customEmojiIds: string[] = []
): Promise<{ enabled: boolean; reason: string }> {
    const totalReactions = emojis.length + customEmojiIds.length;

    // 如果只有1个或没有反应，不需要会员模式
    if (totalReactions <= 1) {
        return { enabled: false, reason: "单个反应无需会员模式" };
    }

    // 检测用户是否为Premium会员
    const isPremium = await checkUserPremium(client, userId);

    if (isPremium) {
        // 自动启用会员模式
        traceDB.setConfig("premium_mode", "true");
        traceDB.setConfig("max_reactions", "3");
        console.log(`[Trace] 检测到Premium会员，自动启用会员模式`);
        return { enabled: true, reason: "检测到Premium会员，自动启用" };
    } else {
        // 非会员用户尝试设置多个反应
        console.log(`[Trace] 非Premium用户尝试设置${totalReactions}个反应，限制为1个`);
        return { enabled: false, reason: `非Premium用户，限制为1个反应` };
    }
}

// 工具函数：格式化反应列表
function formatReactions(reactions: string[] | { reactions: string[], custom_emojis?: string[], clown_mode?: number, poop_mode?: number, emoji_mode?: { mode: string, count: number } }): string {
    // 兼容两种格式
    if (Array.isArray(reactions)) {
        return reactions.length > 0 ? `[${reactions.join(", ")}]` : "[无反应]";
    }

    const normalEmojis = reactions.reactions || [];
    const customEmojis = reactions.custom_emojis || [];
    const clownMode = reactions.clown_mode;
    const poopMode = reactions.poop_mode;
    const emojiMode = reactions.emoji_mode;

    // 优先使用新的通用格式
    if (emojiMode && EMOJI_MODES[emojiMode.mode]) {
        const modeName = EMOJI_MODES[emojiMode.mode].modeName;
        return `[${modeName} x${emojiMode.count}]`;
    }

    // 向后兼容旧格式
    if (clownMode) {
        return `[小丑模式 x${clownMode}]`;
    }

    if (poopMode) {
        return `[大便模式 x${poopMode}]`;
    }

    const allEmojis = [...normalEmojis, ...customEmojis.map(id => `📦${id.slice(-4)}`)]; // 显示自定义表情ID的后4位
    return allEmojis.length > 0 ? `[${allEmojis.join(", ")}]` : "[无反应]";
}

// 帮助文档（等宽处理）
const help_text = `🎭 <b>全局表情追踪插件</b> - 自动为特定用户的消息添加表情反应

<b>📝 功能特性:</b>
• 👥 <b>用户追踪</b> - 对特定用户的消息自动添加表情反应
• 🤖 <b>智能会员检测</b> - 自动检测Telegram Premium会员并启用多反应模式
• 🎨 <b>自定义表情支持</b> - 支持custom emoji（Premium功能）
• 🤡 <b>小丑模式</b> - 每次随机发送不重复的小丑表情
• 💩 <b>大便模式</b> - 每次随机发送不重复的大便表情（包含原生emoji）
• ⚙️ <b>配置管理</b> - 管理日志保留和大表情设置
• 📊 <b>状态查看</b> - 查看所有追踪的用户

<b>🔧 基础用法:</b>
• 回复消息使用 <code>${mainPrefix}trace [表情]</code> - 追踪用户
• 回复消息使用 <code>${mainPrefix}trace</code> - 取消追踪用户
• 回复消息使用 <code>${mainPrefix}trace 小丑 [1|2|3]</code> - 启用小丑模式
• 回复消息使用 <code>${mainPrefix}trace 便便 [1|2|3]</code> - 启用大便模式

<b>🔄 管理命令:</b>
• <code>${mainPrefix}trace status</code> - 查看所有追踪状态
• <code>${mainPrefix}trace clean</code> - 清除所有追踪
• <code>${mainPrefix}trace log [true|false]</code> - 设置日志保留
• <code>${mainPrefix}trace big [true|false]</code> - 设置大表情模式
• <code>${mainPrefix}trace help</code> - 显示此帮助

<b>🎨 可用表情:</b> ${SAFE_EMOJI.join(" ")}\n<b>📝 更多表情:</b> ${Array.from(NATIVE_EMOJI).slice(10, 30).join(" ")}

<b>🎯 智能会员模式:</b>
• 🔍 <b>自动检测</b> - 设置多个表情时自动检测Premium会员状态
• 👑 <b>Premium用户</b> - 自动启用会员模式，可同时显示最多3个反应
• 👤 <b>普通用户</b> - 自动限制为1个反应，确保兼容性
• 🎨 <b>自定义表情</b> - Premium用户支持自定义表情

<b>🤡 小丑模式:</b>
• 使用 <code>${mainPrefix}trace 小丑 1</code> - 每次随机1个小丑表情
• 使用 <code>${mainPrefix}trace 小丑 2</code> - 每次随机2个不重复小丑表情
• 使用 <code>${mainPrefix}trace 小丑 3</code> - 每次随机3个不重复小丑表情
• 包含8个自定义小丑表情 + 1个原生🤡表情，共9种
• 每次随机从原生和自定义表情中选择，确保不重复
• 取消方式和普通模式一样，直接使用 <code>${mainPrefix}trace</code>

<b>💩 大便模式:</b>
• 使用 <code>${mainPrefix}trace 便便 1</code> - 每次随机1个大便表情
• 使用 <code>${mainPrefix}trace 便便 2</code> - 每次随机2个不重复大便表情
• 使用 <code>${mainPrefix}trace 便便 3</code> - 每次随机3个不重复大便表情
• 包含13个自定义大便表情 + 1个原生💩表情，共14种
• 每次随机从原生和自定义表情中选择，确保不重复
• 取消方式和普通模式一样，直接使用 <code>${mainPrefix}trace</code>

<b>⚠️ 注意:</b>
• 插件会自动检测用户Premium状态，无需手动设置
• 非Premium用户设置多个表情时会自动限制为1个
• 支持原生Telegram表情和自定义表情
• Premium检测失败时默认为普通用户模式
• 小丑模式和大便模式会覆盖之前设置的表情模式
• 同一用户同时只能启用一种模式（普通/小丑/大便）`;

class TracePlugin extends Plugin {
    description: string = help_text;

    cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
        trace: async (msg: Api.Message, _trigger?: Api.Message) => {
            const client = await getGlobalClient();
            if (!client) {
                await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
                return;
            }

            // 参数解析（严格按acron.ts模式）
            const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
            const parts = lines?.[0]?.split(/\s+/) || [];
            const [, ...args] = parts; // 跳过命令本身
            const sub = (args[0] || "").toLowerCase();

            const config = traceDB.getTraceConfig();

            try {
                // 无参数时的处理
                if (!sub) {
                    const replyMsg = await msg.getReplyMessage();
                    if (replyMsg && replyMsg.fromId) {
                        // 取消追踪用户
                        const userId = Number(replyMsg.senderId?.toString());
                        if (!userId) {
                            await editAndDelete(
                                msg,
                                "❌ <b>错误:</b> 无法获取用户ID",
                                5,
                                config.keep_log
                            );
                            return;
                        }

                        const prevData = traceDB.removeTracedUser(userId);
                        if (!prevData) {
                            await editAndDelete(
                                msg,
                                "❌ <b>错误:</b> 该用户未在追踪列表中",
                                5,
                                config.keep_log
                            );
                            return;
                        }

                        const userInfo = await client.getEntity(replyMsg.fromId);
                        const formattedUser = formatUserInfo(userInfo);

                        await editAndDelete(
                            msg,
                            `✅ <b>成功取消追踪:</b>\n👤 ${htmlEscape(formattedUser)}\n🎭 ${formatReactions(prevData)}`,
                            5,
                            config.keep_log
                        );
                        return;
                    } else {
                        await msg.edit({
                            text: `❌ <b>参数不足</b>\n\n💡 使用 <code>${mainPrefix}trace help</code> 查看帮助`,
                            parseMode: "html"
                        });
                        return;
                    }
                }

                // 明确请求帮助时才显示
                if (sub === "help" || sub === "h") {
                    await msg.edit({
                        text: help_text,
                        parseMode: "html"
                    });
                    return;
                }

                // 测试表情功能（隐藏命令）
                if (sub === "test" && args.length >= 2) {
                    const testEmoji = args[1];
                    await msg.edit({ text: `🧪 测试表情: ${testEmoji}`, parseMode: "html" });

                    try {
                        const reaction = new Api.ReactionEmoji({ emoticon: testEmoji });
                        const replyMsg = await msg.getReplyMessage();

                        if (replyMsg) {
                            await sendReaction(client, msg.chatId!.toString(), replyMsg.id, [reaction], false);
                            await editAndDelete(
                                msg,
                                `✅ 表情 ${testEmoji} 测试成功`,
                                5,
                                config.keep_log
                            );
                        } else {
                            await editAndDelete(
                                msg,
                                `❌ 请回复一条消息来测试表情`,
                                5,
                                config.keep_log
                            );
                        }
                    } catch (error: any) {
                        await editAndDelete(
                            msg,
                            `❌ 表情 ${testEmoji} 不被支持: ${error.message}`,
                            5,
                            config.keep_log
                        );
                    }
                    return;
                }

                // 状态查看
                if (sub === "status") {
                    await msg.edit({ text: "🔄 正在获取追踪状态...", parseMode: "html" });

                    const tracedUsers = traceDB.getAllTracedUsers();

                    let statusText = "<b>🔍 追踪状态</b>\n\n";

                    // 用户追踪列表
                    statusText += "<b>👥 追踪用户:</b>\n";
                    if (tracedUsers.length === 0) {
                        statusText += "• 暂无追踪用户\n";
                    } else {
                        for (const tracedUser of tracedUsers) {
                            try {
                                const userEntity = await client.getEntity(tracedUser.user_id);
                                const userInfo = formatUserInfo(userEntity);
                                statusText += `• ${htmlEscape(userInfo)} ${formatReactions(tracedUser)}\n`;
                            } catch (error: any) {
                                console.error(`[Trace] 获取用户 ${tracedUser.user_id} 信息失败:`, error.message);
                                statusText += `• 用户ID: ${tracedUser.user_id} ${formatReactions(tracedUser)}\n`;
                            }
                        }
                    }

                    // 配置信息
                    statusText += `\n<b>⚙️ 当前配置:</b>\n`;
                    statusText += `• 保留日志: ${config.keep_log ? '✅ 启用' : '❌ 禁用'}\n`;
                    statusText += `• 大表情模式: ${config.big ? '✅ 启用' : '❌ 禁用'}\n`;
                    statusText += `• 会员模式: ${config.premium_mode ? '✅ 启用' : '❌ 禁用'}\n`;
                    statusText += `• 同时显示反应数: ${config.max_reactions}\n`;
                    statusText += `\n<b>📊 统计信息:</b>\n`;
                    statusText += `• 追踪用户数: ${tracedUsers.length}`;

                    await editAndDelete(msg, statusText, 15, config.keep_log);
                    return;
                }

                // 清除所有追踪
                if (sub === "clean") {
                    await msg.edit({ text: "🧹 正在清除所有追踪...", parseMode: "html" });

                    const tracedUsers = traceDB.getAllTracedUsers();
                    const count = tracedUsers.length;

                    if (count === 0) {
                        await editAndDelete(
                            msg,
                            "⚠️ <b>提示:</b> 当前没有任何追踪项",
                            5,
                            config.keep_log
                        );
                        return;
                    }

                    traceDB.clearAll();

                    await editAndDelete(
                        msg,
                        `✅ <b>清除完成</b>\n\n📊 <b>已清除:</b>\n• 追踪用户: ${count} 个`,
                        5,
                        config.keep_log
                    );
                    return;
                }

                // 日志配置
                if (sub === "log" && args.length >= 2) {
                    const value = args[1].toLowerCase();
                    if (value === "true") {
                        traceDB.setConfig("keep_log", "true");
                        await msg.edit({ text: "✅ <b>日志保留:</b> 已启用", parseMode: "html" });
                    } else if (value === "false") {
                        traceDB.setConfig("keep_log", "false");
                        await msg.edit({ text: "✅ <b>日志保留:</b> 已禁用", parseMode: "html" });
                    } else {
                        await editAndDelete(
                            msg,
                            `❌ <b>参数错误:</b> 请使用 true 或 false\n\n💡 用法: <code>${mainPrefix}trace log [true|false]</code>`,
                            5,
                            config.keep_log
                        );
                    }
                    return;
                }

                // 大表情配置
                if (sub === "big" && args.length >= 2) {
                    const value = args[1].toLowerCase();
                    if (value === "true") {
                        traceDB.setConfig("big", "true");
                        await msg.edit({ text: "✅ <b>大表情模式:</b> 已启用", parseMode: "html" });
                    } else if (value === "false") {
                        traceDB.setConfig("big", "false");
                        await msg.edit({ text: "✅ <b>大表情模式:</b> 已禁用", parseMode: "html" });
                    } else {
                        await editAndDelete(
                            msg,
                            `❌ <b>参数错误:</b> 请使用 true 或 false\n\n💡 用法: <code>${mainPrefix}trace big [true|false]</code>`,
                            5,
                            config.keep_log
                        );
                    }
                    return;
                }

                // 检查是否是表情模式命令（通用处理）
                if (COMMAND_TO_MODE[sub] && args.length >= 2) {
                    const modeKey = COMMAND_TO_MODE[sub];
                    const count = parseInt(args[1]);
                    await handleEmojiModeCommand(msg, client, modeKey, count, config);
                    return;
                }

                // 追踪用户（带表情）- 需要回复消息
                const replyMsg = await msg.getReplyMessage();
                if (replyMsg && replyMsg.fromId) {
                    // 解析表情（支持custom emoji）
                    const allText = args.join(" ");

                    // 计算命令前缀的字节长度，用于调整实体偏移量
                    const lines = msg.text?.trim()?.split(/\r?\n/g) || [];
                    let fullLine = lines[0] || "";

                    // 统一替换第一个字符为 "."（如果第一个字符是 prefixes 中的一个）
                    if (fullLine.length > 0 && prefixes.includes(fullLine[0])) {
                        fullLine = "." + fullLine.substring(1);
                    }

                    // 找到表情文本在完整命令中的起始位置
                    const emojiStartIndex = fullLine.indexOf(allText);
                    const prefixText = emojiStartIndex >= 0 ? fullLine.substring(0, emojiStartIndex) : fullLine.substring(0, fullLine.length - allText.length);
                    const prefixByteLength = new TextEncoder().encode(prefixText).length;

                    console.log(`[Trace] 命令解析:`);
                    console.log(`[Trace]   - 完整命令: "${fullLine}"`);
                    console.log(`[Trace]   - 完整命令字节长度: ${new TextEncoder().encode(fullLine).length}`);
                    console.log(`[Trace]   - 命令前缀: "${prefixText}"`);
                    console.log(`[Trace]   - 表情部分: "${allText}"`);
                    console.log(`[Trace]   - 前缀字节长度: ${prefixByteLength}`);

                    // 调整实体偏移量
                    let adjustedEntities: Api.TypeMessageEntity[] | undefined;
                    if (msg.entities && msg.entities.length > 0) {
                        console.log(`[Trace]   - 原始实体详情:`);
                        msg.entities.forEach((entity: Api.TypeMessageEntity, i: number) => {
                            if (entity.className === 'MessageEntityCustomEmoji') {
                                console.log(`[Trace]     实体${i}: offset=${(entity as any).offset}, length=${(entity as any).length}`);
                            }
                        });

                        adjustedEntities = msg.entities
                            .filter((entity: Api.TypeMessageEntity) => {
                                const entityStart = (entity as any).offset;
                                // const entityEnd = entityStart + (entity as any).length;
                                // 只保留在表情文本范围内的实体
                                const isInRange = entityStart >= prefixByteLength;
                                console.log(`[Trace]     实体 offset=${entityStart} 是否在范围内(>=${prefixByteLength}): ${isInRange}`);
                                return isInRange;
                            })
                            .map((entity: Api.TypeMessageEntity) => {
                                // 调整偏移量
                                const adjustedEntity = { ...entity };
                                const originalOffset = (entity as any).offset;
                                const newOffset = originalOffset - prefixByteLength;
                                (adjustedEntity as any).offset = newOffset;
                                console.log(`[Trace]     调整偏移量: ${originalOffset} -> ${newOffset}`);
                                return adjustedEntity;
                            });

                        console.log(`[Trace]   - 原始实体数量: ${msg.entities.length}`);
                        console.log(`[Trace]   - 调整后实体数量: ${adjustedEntities ? adjustedEntities.length : 0}`);
                    }

                    const { emojis, customEmojiIds } = parseEmojis(allText, adjustedEntities);
                    console.log(`[Trace] 🎨 解析结果 - 原始表情: [${emojis.join(', ')}], 自定义: [${customEmojiIds.join(', ')}]`);

                    // 如果没有找到表情，使用默认的👍
                    if (emojis.length === 0 && customEmojiIds.length === 0) {
                        console.log("[Trace] 没有指定表情，使用默认👍");
                        emojis.push("👍");
                    }

                    const userId = Number(replyMsg.senderId?.toString());
                    if (!userId) {
                        await editAndDelete(
                            msg,
                            "❌ <b>错误:</b> 无法获取用户ID",
                            5,
                            config.keep_log
                        );
                        return;
                    }

                    // 自动检测会员状态并启用会员模式（如果需要）
                    const premiumResult = await autoEnablePremiumMode(client, userId, emojis, customEmojiIds);
                    const updatedConfig = traceDB.getTraceConfig(); // 重新获取可能更新的配置

                    // 如果是非会员用户尝试设置多个反应，限制为1个
                    if (!premiumResult.enabled && (emojis.length + customEmojiIds.length) > 1) {
                        // 修复：保留第一个表情，清空其余的
                        emojis.length = Math.min(emojis.length, 1); // 保留最多1个原生表情
                        customEmojiIds.length = 0; // 清空自定义表情（非会员不支持）
                        console.log(`[Trace] 非Premium用户，限制为1个反应: ${emojis[0] || '👍'}`);
                    }

                    console.log(`[Trace] 💾 最终保存的表情: [${emojis.join(', ')}], 自定义: [${customEmojiIds.join(', ')}]`);

                    // 检查是否已经追踪该用户
                    const existingData = traceDB.getTracedUser(userId);
                    console.log(`[Trace] 📁 现有数据:`, existingData);

                    if (existingData) {
                        // 更新追踪
                        console.log(`[Trace] 🔄 更新用户 ${userId} 的追踪数据`);
                        traceDB.addTracedUser(userId, emojis, customEmojiIds);
                        const userInfo = await client.getEntity(replyMsg.fromId);
                        const formattedUser = formatUserInfo(userInfo);

                        const newData = { reactions: emojis, custom_emojis: customEmojiIds };
                        let statusMessage = `🔄 <b>更新追踪用户:</b>\n👤 ${htmlEscape(formattedUser)}\n🎭 旧: ${formatReactions(existingData)}\n🎭 新: ${formatReactions(newData)}`;

                        // 添加会员检测结果信息
                        if (premiumResult.enabled) {
                            statusMessage += `\n🎯 <b>会员模式:</b> ${premiumResult.reason}`;
                        } else if ((emojis.length + customEmojiIds.length) > 1) {
                            statusMessage += `\n⚠️ <b>提示:</b> ${premiumResult.reason}`;
                        }

                        await editAndDelete(
                            msg,
                            statusMessage,
                            5,
                            config.keep_log
                        );
                    } else {
                        // 新增追踪
                        console.log(`[Trace] ➕ 新增用户 ${userId} 的追踪数据`);
                        traceDB.addTracedUser(userId, emojis, customEmojiIds);
                        const userInfo = await client.getEntity(replyMsg.fromId);
                        const formattedUser = formatUserInfo(userInfo);

                        const newData = { reactions: emojis, custom_emojis: customEmojiIds };
                        let statusMessage = `✅ <b>成功追踪用户:</b>\n👤 ${htmlEscape(formattedUser)}\n🎭 ${formatReactions(newData)}`;

                        // 添加会员检测结果信息
                        if (premiumResult.enabled) {
                            statusMessage += `\n🎯 <b>会员模式:</b> ${premiumResult.reason}`;
                        } else if ((emojis.length + customEmojiIds.length) > 1) {
                            statusMessage += `\n⚠️ <b>提示:</b> ${premiumResult.reason}`;
                        }

                        await editAndDelete(
                            msg,
                            statusMessage,
                            5,
                            config.keep_log
                        );
                    }

                    // 验证保存结果
                    const savedData = traceDB.getTracedUser(userId);
                    console.log(`[Trace] ✅ 保存后验证数据:`, savedData);

                    // 立即发送反应作为演示
                    const reactions = await generateReactionList(emojis, customEmojiIds, updatedConfig.max_reactions);
                    await sendReaction(client, msg.chatId!.toString(), replyMsg.id, reactions, updatedConfig.big);
                    return;
                }

                // 未知命令
                await msg.edit({
                    text: `❌ <b>未知命令:</b> <code>${htmlEscape(sub)}</code>\n\n💡 使用 <code>${mainPrefix}trace help</code> 查看帮助`,
                    parseMode: "html"
                });

            } catch (error: any) {
                console.error("[Trace] 命令处理失败:", error);
                await msg.edit({
                    text: `❌ <b>操作失败:</b> ${htmlEscape(error.message || "未知错误")}`,
                    parseMode: "html"
                });
            }
        }
    };

    // 消息监听器 - 自动反应功能
    listenMessageHandler = async (msg: Api.Message) => {
        if (!msg.fromId || !msg.chatId) return;

        const client = await getGlobalClient();
        if (!client) return;

        const config = traceDB.getTraceConfig();

        try {
            const userId = Number(msg.senderId?.toString());

            // 检查用户追踪
            const userData = traceDB.getTracedUser(userId);
            const hasReactions = userData && (userData.reactions.length > 0 || (userData.custom_emojis && userData.custom_emojis.length > 0) || userData.clown_mode || userData.poop_mode || userData.emoji_mode);

            // 只为追踪用户记录日志
            if (hasReactions && userData) {
                const messageText = msg.text || msg.message || '[媒体消息]';
                console.log(`[Trace] 🎯 捕获追踪用户 ${userId} 消息: "${messageText.slice(0, 30)}${messageText.length > 30 ? '...' : ''}"`);

                let reactions: Api.TypeReaction[];

                // 优先使用新的通用格式
                if (userData.emoji_mode && EMOJI_MODES[userData.emoji_mode.mode]) {
                    const modeConfig = EMOJI_MODES[userData.emoji_mode.mode];
                    const { nativeEmojis, customEmojiIds } = getRandomEmojisForMode(userData.emoji_mode.mode, userData.emoji_mode.count);
                    console.log(`[Trace] ${modeConfig.nativeEmoji} ${modeConfig.modeName} x${userData.emoji_mode.count} - 随机选择: 原生[${nativeEmojis.join(', ')}], 自定义[${customEmojiIds.join(', ')}]`);
                    reactions = await generateReactionList(nativeEmojis, customEmojiIds, config.max_reactions);
                } else if (userData.clown_mode) {
                    // 向后兼容：小丑模式
                    const { nativeEmojis, customEmojiIds } = getRandomEmojisForMode('clown', userData.clown_mode);
                    console.log(`[Trace] 🤡 小丑模式 x${userData.clown_mode} - 随机选择: 原生[${nativeEmojis.join(', ')}], 自定义[${customEmojiIds.join(', ')}]`);
                    reactions = await generateReactionList(nativeEmojis, customEmojiIds, config.max_reactions);
                } else if (userData.poop_mode) {
                    // 向后兼容：大便模式
                    const { nativeEmojis, customEmojiIds } = getRandomEmojisForMode('poop', userData.poop_mode);
                    console.log(`[Trace] 💩 大便模式 x${userData.poop_mode} - 随机选择: 原生[${nativeEmojis.join(', ')}], 自定义[${customEmojiIds.join(', ')}]`);
                    reactions = await generateReactionList(nativeEmojis, customEmojiIds, config.max_reactions);
                } else {
                    // 普通模式
                    console.log(`[Trace] 🎭 准备发送反应 - 原生: [${userData.reactions.join(', ')}], 自定义: [${(userData.custom_emojis || []).join(', ')}]`);
                    reactions = await generateReactionList(
                        userData.reactions,
                        userData.custom_emojis,
                        config.max_reactions
                    );
                }

                if (reactions.length > 0) {
                    await sendReaction(client, msg.chatId!.toString(), msg.id, reactions, config.big);
                    console.log(`[Trace] ✅ 成功发送 ${reactions.length} 个反应`);
                } else {
                    console.error(`[Trace] ❌ 用户 ${userId} 的反应生成失败`);
                }
            }

        } catch (error: any) {
            console.error("[Trace] 消息监听处理失败:", error.message);
        }
    };

    // Echo机制实现
    private async echoMessage(
        originalMsg: Api.Message,
        targetMsg: Api.Message,
        client: TelegramClient
    ): Promise<void> {
        // 将消息中的媒体转换为可发送的 InputMedia
        const toInputMedia = (
            media: Api.TypeMessageMedia
        ): Api.TypeInputMedia | undefined => {
            try {
                if (media instanceof Api.MessageMediaPhoto && media.photo) {
                    if (media.photo instanceof Api.Photo) {
                        const inputPhoto = new Api.InputPhoto({
                            id: media.photo.id,
                            accessHash: media.photo.accessHash,
                            fileReference: media.photo.fileReference,
                        });
                        return new Api.InputMediaPhoto({
                            id: inputPhoto,
                            ...(media.spoiler ? { spoiler: true } : {}),
                            ...(media.ttlSeconds ? { ttlSeconds: media.ttlSeconds } : {}),
                        });
                    }
                }
                if (
                    media instanceof Api.MessageMediaDocument &&
                    media.document &&
                    media.document instanceof Api.Document
                ) {
                    const inputDoc = new Api.InputDocument({
                        id: media.document.id,
                        accessHash: media.document.accessHash,
                        fileReference: media.document.fileReference,
                    });
                    return new Api.InputMediaDocument({
                        id: inputDoc,
                        ...(media.spoiler ? { spoiler: true } : {}),
                        ...(media.ttlSeconds ? { ttlSeconds: media.ttlSeconds } : {}),
                    });
                }
            } catch (e) {
                console.warn("[r.echo] 构造 InputMedia 失败", e);
            }
            return undefined;
        };

        const inputMedia = originalMsg.media ? toInputMedia(originalMsg.media) : undefined;

        // 构造回复信息
        // const replyTo = originalMsg.replyTo
        //     ? new Api.InputReplyToMessage({
        //         replyToMsgId: originalMsg.replyTo.replyToMsgId!,
        //         quoteText: originalMsg.replyTo.quoteText,
        //         quoteEntities: originalMsg.replyTo.quoteEntities,
        //         quoteOffset: originalMsg.replyTo.quoteOffset,
        //         topMsgId: originalMsg.replyTo.replyToTopId,
        //     })
        //     : undefined;
        // const replyTo = targetMsg.messageId;
        const replyTo = new Api.InputReplyToMessage({
            replyToMsgId: targetMsg.id,
            quoteText: targetMsg.text || "",
            quoteEntities: targetMsg.entities,
            quoteOffset: 0,
            topMsgId: targetMsg.id,
        });

        if (inputMedia) {
            // 发送包含媒体的消息
            await client.invoke(
                new Api.messages.SendMedia({
                    peer: targetMsg.chatId!,
                    message: originalMsg.message || "",
                    media: inputMedia,
                    entities: originalMsg.entities,
                    ...(replyTo ? { replyTo } : {}),
                })
            );
        } else {
            // 发送纯文本消息
            await client.invoke(
                new Api.messages.SendMessage({
                    peer: targetMsg.chatId!,
                    message: originalMsg.message || "",
                    entities: originalMsg.entities,
                    ...(replyTo ? { replyTo } : {}),
                })
            );
        }
    }
}

export default new TracePlugin();
