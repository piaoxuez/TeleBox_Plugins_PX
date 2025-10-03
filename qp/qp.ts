import axios from "axios";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { sleep } from "telegram/Helpers";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as path from "path";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// TMDB配置
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// 配置键定义
const CONFIG_KEYS = {
    TMDB_API_KEY: "tmdb_api_key",
};

// 默认配置
const DEFAULT_CONFIG: Record<string, string> = {
    [CONFIG_KEYS.TMDB_API_KEY]: "",
};

// 配置管理器类
class ConfigManager {
    private static db: any = null;
    private static initialized = false;
    private static configPath: string;

    private static async init(): Promise<void> {
        if (this.initialized) return;

        try {
            // 使用插件专用目录
            this.configPath = path.join(
                createDirectoryInAssets("qp"),
                "config.json"
            );

            // 以扁平结构初始化
            this.db = await JSONFilePreset<Record<string, any>>(
                this.configPath,
                { ...DEFAULT_CONFIG }
            );
            this.initialized = true;
        } catch (error) {
            console.error("[qp] 初始化配置失败:", error);
        }
    }

    static async get(key: string, defaultValue?: string): Promise<string> {
        await this.init();
        if (!this.db) return defaultValue || DEFAULT_CONFIG[key] || "";

        // 直接从顶级键读取
        const value = this.db.data[key];
        return value ?? defaultValue ?? DEFAULT_CONFIG[key] ?? "";
    }

    static async set(key: string, value: string): Promise<boolean> {
        await this.init();
        if (!this.db) return false;

        try {
            this.db.data[key] = value;
            await this.db.write();
            return true;
        } catch (error) {
            console.error(`[qp] 设置配置失败 ${key}:`, error);
            return false;
        }
    }

    static async remove(key: string): Promise<boolean> {
        await this.init();
        if (!this.db) return false;

        try {
            delete this.db.data[key];
            await this.db.write();
            return true;
        } catch (error) {
            console.error(`[qp] 删除配置失败 ${key}:`, error);
            return false;
        }
    }
}

// HTML转义函数
const htmlEscape = (text: string): string =>
    text.replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;',
        '"': '&quot;', "'": '&#x27;'
    }[m] || m));

// 搜索结果接口
interface SearchResult {
    id: number;
    title?: string;
    name?: string;
    overview: string;
    type: 'movie' | 'tv';
}

// 用户搜索状态
interface UserSearchState {
    userId: string;
    chatId: string;
    messageId: number;
    results: SearchResult[];
    query: string;
    timestamp: number;
    commandType: 'qp' | 'xb'; // 添加命令类型，区分求片和洗版
}

// 状态管理器
class SearchStateManager {
    private static db: any = null;
    private static initialized = false;

    private static async init(): Promise<void> {
        if (this.initialized) return;

        try {
            const configPath = path.join(
                createDirectoryInAssets("qp"),
                "search_states.json"
            );

            this.db = await JSONFilePreset<Record<string, UserSearchState>>(
                configPath,
                {}
            );
            this.initialized = true;
        } catch (error) {
            console.error("[qp] 初始化状态管理失败:", error);
        }
    }

    static async setState(key: string, state: UserSearchState): Promise<void> {
        await this.init();
        if (!this.db) return;

        try {
            this.db.data[key] = state;
            await this.db.write();
        } catch (error) {
            console.error("[qp] 保存状态失败:", error);
        }
    }

    static async getState(key: string): Promise<UserSearchState | null> {
        await this.init();
        if (!this.db) return null;

        return this.db.data[key] || null;
    }

    static async removeState(key: string): Promise<void> {
        await this.init();
        if (!this.db) return;

        try {
            delete this.db.data[key];
            await this.db.write();
        } catch (error) {
            console.error("[qp] 删除状态失败:", error);
        }
    }

    // 清理过期状态（超过1小时）
    static async cleanExpiredStates(): Promise<void> {
        await this.init();
        if (!this.db) return;

        const now = Date.now();
        const expireTime = 60 * 60 * 1000; // 1小时

        for (const [key, state] of Object.entries(this.db.data)) {
            if (now - (state as UserSearchState).timestamp > expireTime) {
                delete this.db.data[key];
            }
        }

        try {
            await this.db.write();
        } catch (error) {
            console.error("[qp] 清理过期状态失败:", error);
        }
    }
}

const help_text = `⭐ <b>求片/洗版插件</b>

<b>📝 功能描述:</b>
• 🔍 <b>搜索影视作品</b>：在TMDB数据库中搜索电影和/或电视剧
• 📋 <b>智能选择</b>：多种便捷方式选择作品
• 🎬 <b>生成信息</b>：自动生成求片或洗版格式并附上TMDB链接

<b>🔑 首次设置:</b>
• <code>${mainPrefix}qp key 你的TMDB_API_KEY</code> - 设置API密钥
• 获取API Key：https://www.themoviedb.org/settings/api
• 必须先设置API Key才能使用搜索功能

<b>🔧 搜索命令:</b>
• <code>${mainPrefix}qp 搜索关键词</code> - 求片搜索（输出#求片）
• <code>${mainPrefix}qp 洗版 搜索关键词</code> - 洗版搜索（输出#洗版）
• 可选择类型：<code>电影</code> 或 <code>电视</code>，不指定则搜索全部

<b>✨ 选择方法（任选其一）:</b>
• 直接发送 <code>序号 备注</code>（如：<code>3 蓝光版本</code>）
• 回复搜索结果发送 <code>序号 备注</code>

<b>💡 使用示例:</b>
• <code>${mainPrefix}qp key abcd1234...</code> - 设置API密钥
• <code>${mainPrefix}qp 心理测量者</code> - 求片搜索所有类型
• <code>${mainPrefix}qp 洗版 权力的游戏 电视</code> - 洗版搜索电视剧
• 然后发送：<code>1 蓝光版本</code> 或 <code>2</code>

<b>📌 注意事项:</b>
• 首次使用前必须设置TMDB API Key
• 搜索结果有效期为10分钟
• 备注可以为空，直接发送序号即可
• 默认输出#求片，加"洗版"前缀输出#洗版
`;

class QpPlugin extends Plugin {
    description: string = help_text;

    cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
        qp: async (msg: Api.Message) => await this.handleQp(msg),
    };

    // 监听所有消息以处理简化的用户交互
    listenMessageHandler = async (msg: Api.Message): Promise<void> => {
        // 只处理文本消息
        if (!msg.message) return;

        const userId = msg.senderId?.toString() || '';
        const chatId = msg.chatId?.toString() || '';
        const stateKey = `${userId}_${chatId}`;

        // 获取用户的搜索状态
        const state = await SearchStateManager.getState(stateKey);
        if (!state) return; // 用户没有活跃的搜索状态

        // 检查消息时间是否在合理范围内（10分钟内）
        const now = Date.now();
        const elapsed = now - state.timestamp;
        if (elapsed > 10 * 60 * 1000) {
            await SearchStateManager.removeState(stateKey);
            return;
        }

        // 检查两种模式：
        // 1. 用户在同群的下一条消息直接是"序号 备注"格式
        // 2. 用户回复搜索结果消息且格式是"序号 备注"

        let isValidSelection = false;
        let isReplyToSearchResult = false;

        // 检查是否是回复搜索结果消息
        if (msg.isReply) {
            const repliedMsg = await msg.getReplyMessage();
            if (repliedMsg && repliedMsg.id === state.messageId) {
                isReplyToSearchResult = true;
                isValidSelection = true;
            }
        } else {
            // 检查是否是同群的下一条消息，且格式正确
            if (msg.chatId?.toString() === state.chatId) {
                isValidSelection = true;
            }
        }

        if (!isValidSelection) return;

        // 解析消息内容，看是否是"序号 备注"格式
        const messageText = msg.message.trim();
        const parts = messageText.split(/\s+/);

        // 第一个部分必须是数字（序号）
        const indexStr = parts[0];
        const index = parseInt(indexStr);

        if (isNaN(index) || index < 1 || index > state.results.length) {
            return;
        }

        // 这确实是一个选择操作
        console.log(`[qp] 用户选择 ${index} - ${state.commandType === 'xb' ? '洗版' : '求片'}模式`);
        const remark = parts.slice(1).join(' ');
        const selectedResult = state.results[index - 1];
        const tmdbUrl = `https://www.themoviedb.org/${selectedResult.type}/${selectedResult.id}`;

        // 生成最终消息（根据命令类型）
        const prefix = state.commandType === 'xb' ? '#洗版' : '#求片';
        let finalMessage = `${prefix} ${tmdbUrl}`;
        if (remark) {
            finalMessage += ` ${remark}`;
        }

        try {
            // 删除用户的消息
            await msg.delete();

            // 如果是回复模式，还要删除搜索结果消息
            if (isReplyToSearchResult) {
                const repliedMsg = await msg.getReplyMessage();
                if (repliedMsg) {
                    await repliedMsg.delete();
                }
            } else {
                // 不是回复模式，查找并删除搜索结果消息
                const client = await getGlobalClient();
                if (client) {
                    try {
                        const messages = await client.getMessages(msg.chatId, {
                            ids: [state.messageId]
                        });
                        if (messages && messages.length > 0) {
                            await messages[0].delete();
                        }
                    } catch (error) {
                        console.log("[qp] 删除搜索结果消息失败（可能已被删除）:", error);
                    }
                }
            }

            // 发送最终消息
            const client = await getGlobalClient();
            if (client) {
                // 特定群组处理：让求片消息回复指定消息
                const chatId = msg.chatId?.toString();
                let replyToId: number | undefined = undefined;

                if (chatId === '-1002303235860' || chatId === '2303235860') {
                    replyToId = 16387; // 指定的消息ID
                }

                if (chatId === '-1002302686639' || chatId === '2302686639') {
                    // https://t.me/IrisEmby_Group/123247
                    if (prefix === "#求片") {
                        replyToId = 123244; // 指定的消息ID
                    } else if (prefix === "#洗版") {
                        replyToId = 123247; // 指定的消息ID
                    }
                }

                await client.sendMessage(msg.chatId, {
                    message: finalMessage,
                    replyTo: replyToId,
                });
            }
        } catch (error) {
            console.error("[qp] 处理简化选择失败:", error);
        }

        // 清理状态
        await SearchStateManager.removeState(stateKey);
    };


    private async handleQp(msg: Api.Message): Promise<void> {
        try {
            // 解析命令参数
            const text = msg.message?.trim() || '';
            const parts = text.split(/\s+/).slice(1); // 去掉命令本身

            if (parts.length === 0) {
                await msg.edit({
                    text: help_text,
                    parseMode: "html",
                    linkPreview: false
                });
                return;
            }

            // 检查是否是回复搜索结果消息（选择操作）
            if (msg.isReply) {
                const repliedMsg = await msg.getReplyMessage();
                if (repliedMsg) {
                    const stateKey = `${msg.senderId}_${msg.chatId}`;
                    const state = await SearchStateManager.getState(stateKey);

                    if (state && state.messageId === repliedMsg.id) {
                        // 这是选择操作，使用简化格式
                        await this.handleDirectSelection(msg, state, parts);
                        return;
                    }
                }
            }

            // 检查是否是key配置命令
            if (parts[0] === 'key') {
                await this.handleKeyCommand(msg, parts);
                return;
            }

            // 检查API key是否已配置
            const apiKey = await ConfigManager.get(CONFIG_KEYS.TMDB_API_KEY);
            if (!apiKey) {
                await msg.edit({
                    text: `❌ <b>TMDB API Key未配置</b>\n\n请先设置API Key：\n<code>${mainPrefix}qp key 你的TMDB_API_KEY</code>\n\n获取API Key请访问：https://www.themoviedb.org/settings/api`,
                    parseMode: "html",
                    linkPreview: false
                });
                return;
            }

            // 检查第一个参数是否是"洗版"
            let commandType: 'qp' | 'xb' = 'qp';
            let searchParts = parts;

            console.log(`[qp] 解析参数: [${parts.join(', ')}]`);
            console.log(`[qp] 第一个参数: "${parts[0]}", 是否为洗版: ${parts[0] === '洗版'}`);

            if (parts[0] === '洗版' || parts[0] === '洗板') {
                commandType = 'xb';
                searchParts = parts.slice(1); // 移除"洗版"参数
                console.log(`[qp] 检测到洗版模式，剩余搜索参数: [${searchParts.join(', ')}]`);
            } else {
                console.log(`[qp] 使用默认求片模式`);
            }

            // 这是搜索操作
            await this.handleSearchCommand(msg, searchParts, commandType);

        } catch (error: any) {
            console.error(`[qp] 处理qp命令失败:`, error);
            await msg.edit({
                text: `❌ <b>操作失败：</b>${htmlEscape(error.message || '未知错误')}`,
                parseMode: "html"
            });
        }
    }

    private async handleKeyCommand(msg: Api.Message, parts: string[]): Promise<void> {
        if (parts.length !== 2) {
            await msg.edit({
                text: `❌ <b>参数错误</b>\n\n使用格式：<code>${mainPrefix}qp key 你的TMDB_API_KEY</code>\n\n获取API Key请访问：https://www.themoviedb.org/settings/api`,
                parseMode: "html",
                linkPreview: false
            });
            return;
        }

        const apiKey = parts[1];

        // 验证API Key格式（基本验证）
        if (apiKey.length < 20 || !/^[a-zA-Z0-9]+$/.test(apiKey)) {
            await msg.edit({
                text: `❌ <b>API Key格式错误</b>\n\nAPI Key应该是20位以上的字母数字组合\n请检查后重新输入`,
                parseMode: "html"
            });
            return;
        }

        // 测试API Key是否有效
        await msg.edit({
            text: `🔍 <b>正在验证API Key...</b>`,
            parseMode: "html"
        });

        try {
            const testResponse = await axios.get(`${TMDB_BASE_URL}/configuration`, {
                params: {
                    api_key: apiKey
                },
                timeout: 10000
            });

            if (testResponse.status === 200) {
                // API Key有效，保存配置
                const success = await ConfigManager.set(CONFIG_KEYS.TMDB_API_KEY, apiKey);

                if (success) {
                    await msg.edit({
                        text: `✅ <b>API Key设置成功！</b>\n\n现在可以使用求片和洗版功能了`,
                        parseMode: "html"
                    });
                } else {
                    await msg.edit({
                        text: `❌ <b>保存配置失败</b>\n\nAPI Key验证通过但保存时出错，请重试`,
                        parseMode: "html"
                    });
                }
            } else {
                await msg.edit({
                    text: `❌ <b>API Key无效</b>\n\n请检查API Key是否正确`,
                    parseMode: "html"
                });
            }
        } catch (error: any) {
            console.error("[qp] API Key验证失败:", error);
            await msg.edit({
                text: `❌ <b>API Key验证失败</b>\n\n${error.response?.status === 401 ? 'API Key无效或过期' : '网络连接错误，请稍后重试'}`,
                parseMode: "html"
            });
        }
    }

    private async handleSearchCommand(msg: Api.Message, parts: string[], commandType: 'qp' | 'xb'): Promise<void> {
        if (parts.length < 1) {
            const formatExample = commandType === 'xb'
                ? `<code>${mainPrefix}qp 洗版 搜索关键词 [电影/电视]</code>`
                : `<code>${mainPrefix}qp 搜索关键词 [电影/电视]</code>`;
            await msg.edit({
                text: `❌ <b>参数错误</b>\n\n使用格式：${formatExample}\n如果不指定类型，将同时搜索电影和电视剧`,
                parseMode: "html"
            });
            return;
        }

        let query: string;
        let searchTypes: ('movie' | 'tv')[] = [];

        // 检查最后一个参数是否是类型指定
        const lastPart = parts[parts.length - 1].toLowerCase();
        if (lastPart === '电影') {
            query = parts.slice(0, -1).join(' ');
            searchTypes = ['movie'];
        } else if (lastPart === '电视') {
            query = parts.slice(0, -1).join(' ');
            searchTypes = ['tv'];
        } else {
            // 没有指定类型，搜索所有内容
            query = parts.join(' ');
            searchTypes = ['movie', 'tv'];
        }

        if (!query.trim()) {
            await msg.edit({
                text: `❌ <b>搜索关键词不能为空</b>`,
                parseMode: "html"
            });
            return;
        }

        // 更新消息状态
        const typeText = searchTypes.length === 1
            ? (searchTypes[0] === 'movie' ? '电影' : '电视剧')
            : '电影和电视剧';
        await msg.edit({
            text: `🔍 <b>正在搜索 ${typeText}：${htmlEscape(query)}...</b>`,
            parseMode: "html"
        });

        // 搜索TMDB（可能搜索多种类型）
        const allResults: SearchResult[] = [];
        for (const type of searchTypes) {
            const results = await this.searchTMDB(query, type);
            allResults.push(...results);
        }

        if (allResults.length === 0) {
            await msg.edit({
                text: `❌ <b>未找到相关结果</b>\n\n关键词：${htmlEscape(query)}`,
                parseMode: "html"
            });
            return;
        }

        // 按类型分组显示结果
        let resultText = `🎬 <b>搜索结果：${htmlEscape(query)}</b>\n\n`;

        let index = 1;
        if (searchTypes.includes('movie')) {
            const movieResults = allResults.filter(r => r.type === 'movie');
            if (movieResults.length > 0) {
                resultText += `📽️ <b>电影</b>\n`;
                movieResults.forEach((result) => {
                    const title = result.title || result.name || '';
                    const overview = result.overview || '暂无简介';
                    const shortOverview = overview.length > 60 ? overview.substring(0, 60) + '...' : overview;
                    const tmdbUrl = `https://www.themoviedb.org/${result.type}/${result.id}`;

                    resultText += `<b>${index}.</b> ${htmlEscape(title)} <a href="${tmdbUrl}">🔗</a>\n`;
                    resultText += `   ${htmlEscape(shortOverview)}\n\n`;
                    index++;
                });
            }
        }

        if (searchTypes.includes('tv')) {
            const tvResults = allResults.filter(r => r.type === 'tv');
            if (tvResults.length > 0) {
                resultText += `📺 <b>电视剧</b>\n`;
                tvResults.forEach((result) => {
                    const title = result.title || result.name || '';
                    const overview = result.overview || '暂无简介';
                    const shortOverview = overview.length > 60 ? overview.substring(0, 60) + '...' : overview;
                    const tmdbUrl = `https://www.themoviedb.org/${result.type}/${result.id}`;

                    resultText += `<b>${index}.</b> ${htmlEscape(title)} <a href="${tmdbUrl}">🔗</a>\n`;
                    resultText += `   ${htmlEscape(shortOverview)}\n\n`;
                    index++;
                });
            }
        }

        resultText += `💡 <b>选择方式：</b>\n`;
        resultText += `• 直接发送 <code>序号 备注</code>（如：<code>3 蓝光版本</code>）\n`;
        resultText += `• 回复此消息发送 <code>序号 备注</code>\n`;
        resultText += `• 或回复此消息：<code>序号 备注</code>`;

        // 更新消息为搜索结果
        const updatedMsg = await msg.edit({
            text: resultText,
            parseMode: "html",
            linkPreview: false
        });

        // 保存搜索状态
        const stateKey = `${msg.senderId}_${msg.chatId}`;
        const searchState = {
            userId: msg.senderId?.toString() || '',
            chatId: msg.chatId?.toString() || '',
            messageId: updatedMsg ? (updatedMsg as Api.Message).id : msg.id,
            results: allResults,
            query: query,
            timestamp: Date.now(),
            commandType: commandType
        };
        console.log(`[qp] 保存搜索状态 - stateKey: ${stateKey}, messageId: ${searchState.messageId}, results: ${allResults.length}个`);
        console.log(`[qp] 命令类型: ${commandType} (${commandType === 'xb' ? '洗版模式' : '求片模式'})`);
        await SearchStateManager.setState(stateKey, searchState);
    }

    private async handleDirectSelection(
        msg: Api.Message,
        state: UserSearchState,
        parts: string[]
    ): Promise<void> {
        if (parts.length === 0) {
            await msg.edit({
                text: `❌ <b>请提供序号</b>\n\n格式：<code>序号 备注</code>`,
                parseMode: "html"
            });
            return;
        }

        // 解析用户选择（序号 + 可选备注）
        const indexStr = parts[0];
        const remark = parts.slice(1).join(' ');

        // 验证序号
        const index = parseInt(indexStr);
        if (isNaN(index) || index < 1 || index > state.results.length) {
            await msg.edit({
                text: `❌ <b>无效的序号</b>\n\n请选择 1-${state.results.length} 之间的数字`,
                parseMode: "html"
            });
            return;
        }

        const selectedResult = state.results[index - 1];
        const tmdbUrl = `https://www.themoviedb.org/${selectedResult.type}/${selectedResult.id}`;

        // 生成最终消息（根据命令类型）
        const prefix = state.commandType === 'xb' ? '#洗版' : '#求片';
        let finalMessage = `${prefix} ${tmdbUrl}`;
        if (remark) {
            finalMessage += ` ${remark}`;
        }

        try {
            // 删除用户的消息
            await msg.delete();

            // 查找并删除搜索结果消息
            const client = await getGlobalClient();
            if (client) {
                try {
                    const messages = await client.getMessages(msg.chatId, {
                        ids: [state.messageId]
                    });
                    if (messages && messages.length > 0) {
                        await messages[0].delete();
                    }
                } catch (error) {
                    console.log("[qp] 删除搜索结果消息失败（可能已被删除）:", error);
                }
            }

            // 发送最终消息
            if (client) {
                // 特定群组处理：让求片消息回复指定消息
                const chatId = msg.chatId?.toString();
                let replyToId: number | undefined = undefined;

                if (chatId === '-1002303235860' || chatId === '2303235860') {
                    replyToId = 16387; // 指定的消息ID
                }

                await client.sendMessage(msg.chatId, {
                    message: finalMessage,
                    replyTo: replyToId,
                });
            }
        } catch (error) {
            console.error("[qp] 处理简化选择失败:", error);
        }

        // 清理状态
        const stateKey = `${msg.senderId}_${msg.chatId}`;
        await SearchStateManager.removeState(stateKey);
    }

    private async handleSelection(
        msg: Api.Message,
        repliedMsg: Api.Message,
        state: UserSearchState,
        parts: string[]
    ): Promise<void> {
        if (parts.length === 0) {
            await msg.edit({
                text: `❌ <b>请提供序号</b>\n\n格式：<code>${mainPrefix}qp 序号 备注</code>`,
                parseMode: "html"
            });
            return;
        }

        // 解析用户选择（序号 + 可选备注）
        const indexStr = parts[0];
        const remark = parts.slice(1).join(' ');

        // 验证序号
        const index = parseInt(indexStr);
        if (isNaN(index) || index < 1 || index > state.results.length) {
            await msg.edit({
                text: `❌ <b>无效的序号</b>\n\n请选择 1-${state.results.length} 之间的数字`,
                parseMode: "html"
            });
            return;
        }

        const selectedResult = state.results[index - 1];
        const title = selectedResult.title || selectedResult.name || '';
        const tmdbUrl = `https://www.themoviedb.org/${selectedResult.type}/${selectedResult.id}`;

        // 生成最终求片消息
        let finalMessage = `#求片 ${tmdbUrl}`;
        if (remark) {
            finalMessage += ` ${remark}`;
        }

        try {
            // 删除用户的两条消息
            await msg.delete();
            await repliedMsg.delete();

            // 发送求片消息
            const client = await getGlobalClient();
            if (client) {
                await client.sendMessage(msg.chatId, {
                    message: finalMessage,
                });
            }
        } catch (error) {
            console.error("[qp] 处理选择结果失败:", error);
        }

        // 清理状态
        const stateKey = `${msg.senderId}_${msg.chatId}`;
        await SearchStateManager.removeState(stateKey);
    }

    private async searchTMDB(query: string, type: 'movie' | 'tv'): Promise<SearchResult[]> {
        try {
            const apiKey = await ConfigManager.get(CONFIG_KEYS.TMDB_API_KEY);
            if (!apiKey) {
                throw new Error("TMDB API Key未配置");
            }

            const url = `${TMDB_BASE_URL}/search/${type}`;
            const response = await axios.get(url, {
                params: {
                    api_key: apiKey,
                    query: query,
                    language: 'zh-CN',
                    page: 1
                },
                timeout: 10000
            });

            if (response.status !== 200) {
                throw new Error(`TMDB API请求失败: ${response.status}`);
            }

            const results = response.data.results || [];
            return results.slice(0, 10).map((item: any) => ({
                id: item.id,
                title: item.title,
                name: item.name,
                overview: item.overview || '',
                type: type
            }));

        } catch (error: any) {
            console.error("[qp] TMDB搜索失败:", error);
            if (axios.isAxiosError(error)) {
                throw new Error(`网络请求失败: ${error.message}`);
            }
            throw error;
        }
    }
}

// 清理过期状态（每小时执行一次）
setInterval(() => {
    SearchStateManager.cleanExpiredStates();
}, 60 * 60 * 1000);

export default new QpPlugin();
