import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import axios, { AxiosRequestConfig } from "axios";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import * as fs from "fs";
import { createDirectoryInAssets } from "@utils/pathHelpers";

const CMD_CG = "cg";
const help = `🍉 吃瓜插件 - 聊天记录总结

用法:
<code>.cg 1h</code> - 总结最近1小时的聊天记录
<code>.cg 10</code> - 总结最近10条消息
<code>.cg 30m</code> - 总结最近30分钟的聊天记录
<code>.cg 2d</code> - 总结最近2天的聊天记录

时间单位支持: h(小时) m(分钟) d(天)
数量范围: 1-1000条消息

注意: 需要先配置AI服务商才能使用此功能 (ai config add)
`;

type Provider = { apiKey: string; baseUrl: string; compatauth?: Compat; authMethod?: AuthMethod; authConfig?: AuthConfig };
type Compat = "openai" | "gemini" | "claude";
type Models = { chat: string; search: string; image: string; tts: string };
type DB = {
    dataVersion?: number;
    providers: Record<string, Provider>;
    modelCompat?: Record<string, Record<string, Compat>>;
    modelCatalog?: { map: Record<string, Compat>; updatedAt?: string };
    models: Models;
    contextEnabled: boolean;
    collapse: boolean;
    telegraph: any;
    histories: Record<string, { role: string; content: string }[]>;
    histMeta?: Record<string, { lastAt: string }>
};

enum AuthMethod {
    BEARER_TOKEN = "bearer_token",
    API_KEY_HEADER = "api_key_header",
    QUERY_PARAM = "query_param",
    BASIC_AUTH = "basic_auth",
}

type AuthConfig = {
    method: AuthMethod;
    apiKey: string;
    headerName?: string;
    paramName?: string;
    username?: string;
    password?: string;
};

class AIStore {
    static db: any = null;
    static data: DB = {
        providers: {},
        models: { chat: "", search: "", image: "", tts: "" },
        contextEnabled: false,
        collapse: false,
        telegraph: { enabled: false, limit: 0, token: "", posts: [] },
        histories: {}
    };
    static baseDir: string = "";
    static file: string = "";

    static async init() {
        if (this.db) return;
        this.baseDir = createDirectoryInAssets("ai");
        this.file = path.join(this.baseDir, "config.json");
        this.db = await JSONFilePreset<DB>(this.file, {
            providers: {},
            models: { chat: "", search: "", image: "", tts: "" },
            contextEnabled: false,
            collapse: false,
            telegraph: { enabled: false, limit: 0, token: "", posts: [] },
            histories: {}
        });
        this.data = this.db.data;
    }

    static async writeSoon() {
        if (this.db) {
            await this.db.write();
        }
    }
}

class UniversalAuthHandler {
    static buildAuthHeaders(config: AuthConfig): Record<string, string> {
        const headers: Record<string, string> = {};
        switch (config.method) {
            case AuthMethod.BEARER_TOKEN:
                headers["Authorization"] = `Bearer ${config.apiKey}`;
                break;
            case AuthMethod.API_KEY_HEADER:
                const headerName = config.headerName || "X-API-Key";
                headers[headerName] = config.apiKey;
                break;
            case AuthMethod.BASIC_AUTH:
                const credentials = Buffer.from(`${config.username || config.apiKey}:${config.password || ""}`).toString('base64');
                headers["Authorization"] = `Basic ${credentials}`;
                break;
        }
        return headers;
    }
}

function trimBase(url: string): string {
    if (!url) return "";
    let s = url.trim();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s.trim();
}

function buildAuthAttempts(p: Provider, extraHeaders: Record<string, string> = {}) {
    if (p.authConfig) {
        const authHeaders = UniversalAuthHandler.buildAuthHeaders(p.authConfig);
        return [{ headers: { ...extraHeaders, ...authHeaders }, params: {} }];
    }

    const base = trimBase(p.baseUrl || "").toLowerCase();

    // 根据服务商URL确定正确的认证方式
    if (base.includes("moonshot") || base.includes("openai")) {
        // Moonshot和OpenAI使用Bearer Token
        return [{ headers: { ...extraHeaders, "Authorization": `Bearer ${p.apiKey}` }, params: {} }];
    }

    if (base.includes("anthropic") || base.includes("claude")) {
        // Claude使用x-api-key
        return [{ headers: { ...extraHeaders, "x-api-key": p.apiKey }, params: {} }];
    }

    if (base.includes("googleapis") || base.includes("gemini")) {
        // Gemini使用key作为URL参数
        return [{ headers: extraHeaders, params: { key: p.apiKey } }];
    }

    // 默认情况下尝试多种方式
    return [
        { headers: { ...extraHeaders, "Authorization": `Bearer ${p.apiKey}` }, params: {} },
        { headers: { ...extraHeaders, "x-api-key": p.apiKey }, params: {} },
        { headers: extraHeaders, params: { key: p.apiKey } }
    ];
}

function pick(kind: keyof Models): { provider: string; model: string } | null {
    const s = AIStore.data.models[kind];
    if (!s) return null;
    const i = s.indexOf(" ");
    if (i <= 0) return null;
    const provider = s.slice(0, i);
    const model = s.slice(i + 1);
    return { provider, model };
}

function providerOf(name: string): Provider | null {
    return AIStore.data.providers[name] || null;
}

async function resolveCompat(name: string, model: string, p: Provider): Promise<Compat> {
    const ml = String(model || "").toLowerCase();

    if (ml.includes("gpt") || ml.includes("o1") || ml.includes("davinci") || ml.includes("curie")) return "openai";
    if (ml.includes("claude")) return "claude";
    if (ml.includes("gemini")) return "gemini";
    if (ml.includes("kimi") || ml.includes("moonshot")) return "openai";

    const base = trimBase(p.baseUrl || "").toLowerCase();
    if (base.includes("openai") || base.includes("api.openai")) return "openai";
    if (base.includes("anthropic") || base.includes("claude")) return "claude";
    if (base.includes("gemini") || base.includes("googleapis")) return "gemini";
    if (base.includes("moonshot")) return "openai";

    return "openai";
}

async function chatOpenAI(p: Provider, model: string, msgs: { role: string; content: string }[]): Promise<string> {
    const url = trimBase(p.baseUrl) + "/v1/chat/completions";
    const body: any = { model, messages: msgs, max_tokens: 3072 };

    console.log(`[CG] OpenAI请求URL: ${url}`);
    console.log(`[CG] OpenAI请求体:`, JSON.stringify(body, null, 2));

    const attempts = buildAuthAttempts(p);
    let lastErr: any;

    for (const [index, attempt] of attempts.entries()) {
        try {
            const config: AxiosRequestConfig = {
                method: "POST",
                url,
                headers: { "Content-Type": "application/json", ...attempt.headers },
                params: attempt.params,
                data: body,
                timeout: 600000
            };

            console.log(`[CG] OpenAI尝试${index + 1}，请求头:`, config.headers);

            const resp = await axios(config);
            console.log(`[CG] OpenAI响应成功:`, resp.data);
            return resp.data?.choices?.[0]?.message?.content || "";
        } catch (e: any) {
            console.error(`[CG] OpenAI尝试${index + 1}失败:`, e?.message);
            console.error(`[CG] OpenAI响应状态:`, e?.response?.status);
            console.error(`[CG] OpenAI响应数据:`, e?.response?.data);
            lastErr = e;
            continue;
        }
    }
    console.error(`[CG] OpenAI所有尝试均失败，抛出最后错误`);
    throw lastErr;
}

async function chatClaude(p: Provider, model: string, msgs: { role: string; content: string }[]): Promise<string> {
    const url = trimBase(p.baseUrl) + "/v1/messages";
    const body: any = {
        model,
        max_tokens: 3072,
        messages: msgs.map(m => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content
        }))
    };

    console.log(`[CG] Claude请求URL: ${url}`);
    console.log(`[CG] Claude请求体:`, JSON.stringify(body, null, 2));

    const attempts = buildAuthAttempts(p, { "anthropic-version": "2023-06-01" });
    let lastErr: any;

    for (const [index, attempt] of attempts.entries()) {
        try {
            const config: AxiosRequestConfig = {
                method: "POST",
                url,
                headers: { "Content-Type": "application/json", ...attempt.headers },
                params: attempt.params,
                data: body,
                timeout: 600000
            };

            console.log(`[CG] Claude尝试${index + 1}，请求头:`, config.headers);

            const resp = await axios(config);
            console.log(`[CG] Claude响应成功:`, resp.data);
            return resp.data?.content?.[0]?.text || "";
        } catch (e: any) {
            console.error(`[CG] Claude尝试${index + 1}失败:`, e?.message);
            console.error(`[CG] Claude响应状态:`, e?.response?.status);
            console.error(`[CG] Claude响应数据:`, e?.response?.data);
            lastErr = e;
            continue;
        }
    }
    console.error(`[CG] Claude所有尝试均失败，抛出最后错误`);
    throw lastErr;
}

async function chatGemini(p: Provider, model: string, msgs: { role: string; content: string }[]): Promise<string> {
    const path = `/v1/models/${encodeURIComponent(model)}:generateContent`;
    const base = trimBase(p.baseUrl);
    const url = base + path;

    const contents = msgs.map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
    }));

    const body = { contents };

    console.log(`[CG] Gemini请求URL: ${url}`);
    console.log(`[CG] Gemini请求体:`, JSON.stringify(body, null, 2));

    const attempts = buildAuthAttempts(p);
    let lastErr: any;

    for (const [index, attempt] of attempts.entries()) {
        try {
            const config: AxiosRequestConfig = {
                method: "POST",
                url,
                headers: { "Content-Type": "application/json", ...attempt.headers },
                params: attempt.params,
                data: body,
                timeout: 600000
            };

            console.log(`[CG] Gemini尝试${index + 1}，请求头:`, config.headers);

            const resp = await axios(config);
            console.log(`[CG] Gemini响应成功:`, resp.data);
            return resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        } catch (e: any) {
            console.error(`[CG] Gemini尝试${index + 1}失败:`, e?.message);
            console.error(`[CG] Gemini响应状态:`, e?.response?.status);
            console.error(`[CG] Gemini响应数据:`, e?.response?.data);
            lastErr = e;
            continue;
        }
    }
    console.error(`[CG] Gemini所有尝试均失败，抛出最后错误`);
    throw lastErr;
}

async function callAI(msgs: { role: string; content: string }[]): Promise<{ content: string; model: string }> {
    const m = pick("chat");
    if (!m) throw new Error("未设置chat模型，请先配置 (ai config add)");

    console.log(`[CG] 使用模型配置: ${m.provider} - ${m.model}`);

    const p = providerOf(m.provider);
    if (!p) throw new Error(`服务商 ${m.provider} 未配置`);
    if (!p.apiKey) throw new Error("未提供API Key，请先配置 (ai config add/update)");

    console.log(`[CG] 服务商配置: baseUrl=${p.baseUrl}, hasApiKey=${!!p.apiKey}`);

    const compat = await resolveCompat(m.provider, m.model, p);
    console.log(`[CG] 兼容类型: ${compat}`);

    // 预览认证方式
    const authPreview = buildAuthAttempts(p);
    console.log(`[CG] 将尝试 ${authPreview.length} 种认证方式`);

    let content: string;
    if (compat === "openai") {
        content = await chatOpenAI(p, m.model, msgs);
    } else if (compat === "claude") {
        content = await chatClaude(p, m.model, msgs);
    } else if (compat === "gemini") {
        content = await chatGemini(p, m.model, msgs);
    } else {
        throw new Error(`不支持的兼容类型: ${compat}`);
    }

    return { content, model: m.model };
}

function parseTimeOrCount(input: string): { type: "time" | "count"; value: number } | null {
    const trimmed = input.trim();

    if (/^\d+$/.test(trimmed)) {
        const count = parseInt(trimmed, 10);
        if (count > 0 && count <= 1000) {
            return { type: "count", value: count };
        }
        return null;
    }

    const timeMatch = trimmed.match(/^(\d+)(h|m|d)$/i);
    if (timeMatch) {
        const value = parseInt(timeMatch[1], 10);
        const unit = timeMatch[2].toLowerCase();

        if (value <= 0) return null;

        let minutes = 0;
        switch (unit) {
            case "m":
                minutes = value;
                break;
            case "h":
                minutes = value * 60;
                break;
            case "d":
                minutes = value * 60 * 24;
                break;
            default:
                return null;
        }

        if (minutes > 0 && minutes <= 7 * 24 * 60) {
            return { type: "time", value: minutes };
        }
    }

    return null;
}

function formatUsername(user: any): string {
    if (!user) return "未知用户";

    // 优先使用显示名称（firstName + lastName）
    const parts = [];
    if (user.firstName) parts.push(user.firstName);
    if (user.lastName) parts.push(user.lastName);

    if (parts.length > 0) {
        return parts.join(" ");
    }

    // 如果没有firstName/lastName，才用username
    if (user.username) {
        return `@${user.username}`;
    }

    return `用户${user.id}`;
}

function formatTime(date: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function extractText(m: Api.Message | null | undefined): string {
    if (!m) return "";
    const anyM: any = m as any;
    return anyM.text || anyM.message || "";
}

async function sendFinalMessage(msg: Api.Message, text: string): Promise<void> {
    try {
        // 尝试删除原消息并发送新消息
        await msg.delete();
        if (msg.client) {
            await msg.client.sendMessage(msg.peerId, {
                message: text,
                parseMode: "html"
            });
        }
        console.log(`[CG] 成功删除原消息并发送新消息`);
    } catch (deleteError) {
        console.error(`[CG] 无法删除原消息，改为编辑:`, deleteError);
        // 如果删除失败，回退到编辑模式
        await msg.edit({ text, parseMode: "html" });
    }
}

class CgPlugin extends Plugin {
    name = "cg";
    description = `🍉 吃瓜插件 - 聊天记录总结\n\n${help}`;

    cmdHandlers = {
        [CMD_CG]: async (msg: Api.Message) => {
            await AIStore.init();

            const text = (msg as any).text || (msg as any).message || "";
            const parts = text.trim().split(/\s+/);

            if (parts.length < 2) {
                await msg.edit({ text: help, parseMode: "html" });
                return;
            }

            const param = parts[1];
            const parsed = parseTimeOrCount(param);

            if (!parsed) {
                await msg.edit({
                    text: "❌ 参数格式错误\n\n支持格式:\n• 数字 (1-1000): 获取最近N条消息\n• 时间 (如1h, 30m, 2d): 获取指定时间内的消息",
                    parseMode: "html"
                });
                return;
            }

            try {
                await msg.edit({ text: "🍉 正在获取聊天记录...", parseMode: "html" });

                const client = msg.client;
                if (!client) {
                    await msg.edit({ text: "❌ 无法获取Telegram客户端", parseMode: "html" });
                    return;
                }

                let messages: Api.Message[] = [];

                if (parsed.type === "count") {
                    console.log(`[CG] 按数量获取消息: 需要${parsed.value}条`);
                    messages = await client.getMessages(msg.peerId, {
                        limit: parsed.value + 10,
                        offsetId: msg.id
                    });
                    console.log(`[CG] 原始获取${messages.length}条，过滤后准备取${parsed.value}条`);
                    messages = messages.filter(m => m.id !== msg.id).slice(0, parsed.value);
                } else {
                    const cutoffTime = new Date(Date.now() - parsed.value * 60 * 1000);
                    console.log(`[CG] 按时间获取消息: 获取${parsed.value}分钟内的消息，截止时间: ${cutoffTime.toLocaleString()}`);
                    let allMessages: Api.Message[] = [];
                    let offsetId = msg.id;

                    for (let i = 0; i < 20; i++) {
                        const batch = await client.getMessages(msg.peerId, {
                            limit: 100,
                            offsetId: offsetId
                        });

                        if (!batch.length) {
                            console.log(`[CG] 第${i + 1}次获取: 无更多消息，停止`);
                            break;
                        }

                        const validMessages = batch.filter(m => {
                            if (m.id === msg.id) return false;
                            return m.date && m.date >= Math.floor(cutoffTime.getTime() / 1000);
                        });

                        console.log(`[CG] 第${i + 1}次获取: 原始${batch.length}条，有效${validMessages.length}条`);
                        allMessages.push(...validMessages);

                        const oldestInBatch = batch[batch.length - 1];
                        if (!oldestInBatch.date || oldestInBatch.date < Math.floor(cutoffTime.getTime() / 1000)) {
                            console.log(`[CG] 第${i + 1}次获取: 达到时间边界，停止`);
                            break;
                        }

                        offsetId = oldestInBatch.id;
                    }

                    console.log(`[CG] 按时间获取完毕: 总共${allMessages.length}条，截取前1000条`);
                    messages = allMessages.slice(0, 1000);
                }

                if (messages.length === 0) {
                    await msg.edit({ text: "❌ 未找到符合条件的聊天记录", parseMode: "html" });
                    return;
                }

                console.log(`[CG] 获取到 ${messages.length} 条消息`);
                await msg.edit({ text: `🍉 正在分析 ${messages.length} 条聊天记录...`, parseMode: "html" });

                const chatHistory = [];
                console.log(`[CG] 开始处理消息，按时间顺序排列...`);
                for (const [index, m] of messages.reverse().entries()) {
                    const sender = await m.getSender();
                    const username = formatUsername(sender);
                    const time = formatTime(new Date(m.date! * 1000));
                    const content = extractText(m);

                    // 添加用户名格式化信息（仅第一次显示）
                    if (index === 0 && sender) {
                        console.log(`[CG] 用户名格式化示例: firstName="${sender.firstName || ''}" lastName="${sender.lastName || ''}" username="${sender.username || ''}" -> "${username}"`);
                    }

                    console.log(`[CG] 消息${index + 1}: ${username} - ${time} - "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"`);

                    if (content.trim()) {
                        chatHistory.push(`${username} - ${time} - ${content}`);
                    } else {
                        console.log(`[CG] 消息${index + 1}: 内容为空，跳过`);
                    }
                }

                if (chatHistory.length === 0) {
                    await msg.edit({ text: "❌ 聊天记录中没有有效的文本内容", parseMode: "html" });
                    return;
                }

                console.log(`[CG] 处理后有效消息数: ${chatHistory.length}`);

                // 智能截断：确保prompt不会过长（大约保持在8000个字符以内给AI留足够的回复空间）
                const maxPromptLength = 100000;
                const promptPrefix = `这是一段聊天记录，请你总结一下大家具体聊了什么内容。请仔细总结，这段聊天记录主要有几件事，每件事具体讲了什么，前后始末又是什么：\n\n`;

                const promptSuffix = `\n\n开始概括，特别要注意聊天记录的时间顺序。概括结果一定要让人能够只通过聊天记录，就能比较清楚的了解这段时间发生了什么。`;
                let historyText = chatHistory.join('\n');
                let finalHistory = chatHistory;

                if (promptPrefix.length + historyText.length > maxPromptLength) {
                    console.log(`[CG] Prompt过长 (${promptPrefix.length + historyText.length} 字符)，进行智能截断...`);
                    let totalLength = promptPrefix.length;
                    finalHistory = [];

                    for (const entry of chatHistory) {
                        if (totalLength + entry.length + 1 > maxPromptLength) { // +1 for newline
                            console.log(`[CG] 达到长度限制，最终保留 ${finalHistory.length} 条消息`);
                            break;
                        }
                        finalHistory.push(entry);
                        totalLength += entry.length + 1;
                    }
                    historyText = finalHistory.join('\n');
                }

                const prompt = promptPrefix + historyText + promptSuffix;
                console.log(`[CG] 最终处理消息数: ${finalHistory.length}, Prompt长度: ${prompt.length} 字符`);
                console.log(`[CG] 发送给AI的prompt:`);
                console.log(`--- PROMPT START ---`);
                console.log(prompt);
                console.log(`--- PROMPT END ---`);

                const aiMessages = [
                    { role: "user", content: prompt }
                ];

                const result = await callAI(aiMessages);
                console.log(`[CG] AI响应: ${result.content}`);

                const summary = `🍉 <b>聊天记录总结</b>\n\n📊 <b>统计信息:</b>\n• 获取消息: ${messages.length} 条\n• 有效消息: ${chatHistory.length} 条\n• 分析消息: ${finalHistory.length} 条\n• 时间范围: ${parsed.type === "time" ? `最近${param}` : `最近${param}条消息`}\n\n📝 <b>内容总结:</b>\n${result.content}\n\n<i>Powered by ${result.model}</i>`;

                await sendFinalMessage(msg, summary);

            } catch (error: any) {
                console.error("=== CG Plugin 完整错误信息 ===");
                console.error("错误对象:", error);
                console.error("错误消息:", error?.message);
                console.error("错误状态码:", error?.response?.status);
                console.error("错误状态文本:", error?.response?.statusText);
                console.error("错误响应头:", error?.response?.headers);
                console.error("错误响应数据:", error?.response?.data);
                console.error("请求配置:", error?.config);
                console.error("请求URL:", error?.config?.url);
                console.error("请求方法:", error?.config?.method);
                console.error("请求头:", error?.config?.headers);
                console.error("请求数据:", error?.config?.data);
                console.error("完整错误堆栈:", error?.stack);
                console.error("=== CG Plugin 错误信息结束 ===");

                let errorMsg = error?.message || String(error);

                // 如果有响应数据，也包含在错误消息中
                if (error?.response?.data) {
                    try {
                        const responseText = typeof error.response.data === 'string'
                            ? error.response.data
                            : JSON.stringify(error.response.data, null, 2);
                        errorMsg += `\n\n响应详情: ${responseText}`;
                    } catch (e) {
                        errorMsg += `\n\n响应数据: ${String(error.response.data)}`;
                    }
                }

                await msg.edit({
                    text: `❌ 处理失败: ${errorMsg}`,
                    parseMode: "html"
                });
            }
        }
    };
}

export default new CgPlugin();
