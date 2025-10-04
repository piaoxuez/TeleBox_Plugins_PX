import axios from "axios";
import _ from "lodash";
import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import {
    createDirectoryInAssets,
    createDirectoryInTemp,
} from "@utils/pathHelpers";
import { cronManager } from "@utils/cronManager";
import * as cron from "cron";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import * as fs from "fs";
import { getGlobalClient } from "@utils/globalClient";
import { reviveEntities } from "@utils/tlRevive";
import {
    dealCommandPluginWithMessage,
    getCommandFromMessage,
} from "@utils/pluginManager";
import { sleep } from "telegram/Helpers";
import dayjs from "dayjs";
import { CustomFile } from "telegram/client/uploads.js";

const timeout = 60000; // 超时

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const pluginName = "zy";

const commandName = `${mainPrefix}${pluginName}`;

const help_text = `
- 复刻原消息文本
使用 <code>${commandName}</code> 回复一条消息

- 替换消息文本
使用 <code>${commandName} [自定义文本]</code> 回复一条消息，将原消息文本替换为自定义文本

- 多句造谣
使用 <code>${commandName}</code> 换行后输入多行文本，每行生成一个造谣贴纸（造谣同一个用户）

- 记录同一人的多条消息
使用 <code>${commandName} [消息数]</code> 回复一条消息，从该消息开始往前记录该用户的多条消息 ⚠️ 不得超过 10 条

- 记录群内多条消息
使用 <code>${commandName} [消息数] f</code> 回复一条消息，从该消息开始往前记录群内多条消息 ⚠️ 不得超过 10 条

- 记录同一人的指定多条消息
使用 <code>${commandName} [n1] [n2] ...</code> 回复一条消息，记录从该消息开始往前的第n1、n2...条该用户的消息 ⚠️ 最多 10 个数字，最小为 1

- 记录群内指定多条消息
使用 <code>${commandName} [n1] [n2] ... f</code> 回复一条消息，记录从该消息开始往前的第n1、n2...条消息（不限用户） ⚠️ 最多 10 个数字，最小为 1
`;

// 转换Telegram消息实体为quote-api格式
function convertEntities(entities: Api.TypeMessageEntity[]): any[] {
    if (!entities) return [];

    return entities.map((entity) => {
        const baseEntity = {
            offset: entity.offset,
            length: entity.length,
        };

        if (entity instanceof Api.MessageEntityBold) {
            return { ...baseEntity, type: "bold" };
        } else if (entity instanceof Api.MessageEntityItalic) {
            return { ...baseEntity, type: "italic" };
        } else if (entity instanceof Api.MessageEntityUnderline) {
            return { ...baseEntity, type: "underline" };
        } else if (entity instanceof Api.MessageEntityStrike) {
            return { ...baseEntity, type: "strikethrough" };
        } else if (entity instanceof Api.MessageEntityCode) {
            return { ...baseEntity, type: "code" };
        } else if (entity instanceof Api.MessageEntityPre) {
            return { ...baseEntity, type: "pre" };
        } else if (entity instanceof Api.MessageEntityCustomEmoji) {
            const documentId = (entity as any).documentId;
            const custom_emoji_id =
                documentId?.value?.toString() || documentId?.toString() || "";
            return {
                ...baseEntity,
                type: "custom_emoji",
                custom_emoji_id,
            };
        } else if (entity instanceof Api.MessageEntityUrl) {
            return { ...baseEntity, type: "url" };
        } else if (entity instanceof Api.MessageEntityTextUrl) {
            return {
                ...baseEntity,
                type: "text_link",
                url: (entity as any).url || "",
            };
        } else if (entity instanceof Api.MessageEntityMention) {
            return { ...baseEntity, type: "mention" };
        } else if (entity instanceof Api.MessageEntityMentionName) {
            return {
                ...baseEntity,
                type: "text_mention",
                user: { id: (entity as any).userId },
            };
        } else if (entity instanceof Api.MessageEntityHashtag) {
            return { ...baseEntity, type: "hashtag" };
        } else if (entity instanceof Api.MessageEntityCashtag) {
            return { ...baseEntity, type: "cashtag" };
        } else if (entity instanceof Api.MessageEntityBotCommand) {
            return { ...baseEntity, type: "bot_command" };
        } else if (entity instanceof Api.MessageEntityEmail) {
            return { ...baseEntity, type: "email" };
        } else if (entity instanceof Api.MessageEntityPhone) {
            return { ...baseEntity, type: "phone_number" };
        } else if (entity instanceof Api.MessageEntitySpoiler) {
            return { ...baseEntity, type: "spoiler" };
        }

        return baseEntity;
    });
}

// 调用quote-api生成语录
async function generateQuote(
    quoteData: any
): Promise<{ buffer: Buffer; ext: string }> {
    try {
        const response = await axios({
            method: "post",
            timeout,
            data: quoteData,
            responseType: "arraybuffer",
            ...JSON.parse(
                Buffer.from(
                    "eyJ1cmwiOiJodHRwczovL3F1b3RlLWFwaS1lbmhhbmNlZC56aGV0ZW5nc2hhLmV1Lm9yZy9nZW5lcmF0ZS53ZWJwIiwiaGVhZGVycyI6eyJDb250ZW50LVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIiwiVXNlci1BZ2VudCI6IlRlbGVCb3gvMC4yLjEifX0=",
                    "base64"
                ).toString("utf-8")
            ),
        });

        console.log("quote-api响应状态:", response.status);
        return { buffer: response.data, ext: "webp" };
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error(`quote-api请求失败:`, {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
            });
        } else {
            console.error(`调用quote-api失败: ${error}`);
        }
        throw error;
    }
}

class ZyPlugin extends Plugin {
    description: string = `\n语录/造谣插件 - 生成语录贴纸，支持多种模式\n\n${help_text}`;
    cmdHandlers: Record<
        string,
        (msg: Api.Message, trigger?: Api.Message) => Promise<void>
    > = {
            zy: async (msg: Api.Message, trigger?: Api.Message) => {
                const start = Date.now();
                console.log("🚀 ZY插件开始执行，消息ID:", msg.id);

                // 解析命令参数
                const msgText = msg.message;
                const trimmedText = msgText.trim();
                const args = trimmedText.split(/\s+/);

                let count = 1;
                let isSamePerson = false;
                let isMultipleMessages = false;
                let customText = "";
                let isMultilineMode = false;
                let multilineTexts: string[] = [];
                let valid = false;
                let messageIndices: number[] = []; // 用于存储多个消息索引
                let isIndicesMode = false; // 是否为指定索引模式

                // 检查是否为多行模式：命令后面直接是换行
                console.log("🔍 检查多行模式 - 原始消息文本:", JSON.stringify(msgText));
                const escapedPrefixes = prefixes.map(prefix => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                console.log("🔍 转义后的前缀列表:", escapedPrefixes);
                const commandRegex = new RegExp(`^(${escapedPrefixes.join('|')})[a-zA-Z0-9]+(\\r?\\n)`);
                console.log("🔍 使用正则:", commandRegex.source);
                const commandMatch = msgText.match(commandRegex);
                console.log("🔍 正则匹配结果:", commandMatch);
                if (commandMatch) {
                    console.log("✅ 检测到多行模式");
                    // 多行模式
                    const lines = msgText.split(/\r?\n/).slice(1); // 去掉第一行的命令
                    console.log("🔍 分割后的行数组:", lines);
                    multilineTexts = lines.filter(line => line.trim().length > 0).map(line => line.trim());
                    console.log("🔍 过滤后的文本行:", multilineTexts);
                    if (multilineTexts.length > 0) {
                        isMultilineMode = true;
                        valid = true;
                        console.log("✅ 多行模式激活，有效文本行数:", multilineTexts.length);
                    } else {
                        console.log("❌ 多行模式检测到但没有有效文本行");
                    }
                } else {
                    console.log("❌ 未检测到多行模式格式");
                }

                // 如果不是多行模式，则执行原有的参数判断逻辑
                if (!isMultilineMode) {
                    // 判断参数类型
                    if (!args[1]) {
                        // 没有参数，原有的复刻原消息功能
                        valid = true;
                    } else if (/^\d+$/.test(args[1])) {
                        // 第一个参数是纯数字
                        // 检查是否有多个数字参数（.zy n1 n2 ... 或 .zy n1 n2 ... f）
                        const numberArgs: number[] = [];
                        let hasNonNumberArg = false;
                        let lastArgIsF = false;

                        for (let i = 1; i < args.length; i++) {
                            if (/^\d+$/.test(args[i])) {
                                const num = parseInt(args[i]);
                                if (num < 1) {
                                    await msg.edit({ text: "消息索引必须大于等于1" });
                                    return;
                                }
                                numberArgs.push(num);
                            } else if (args[i] === "f" && i === args.length - 1) {
                                lastArgIsF = true;
                                break;
                            } else {
                                hasNonNumberArg = true;
                                break;
                            }
                        }

                        // 判断是哪种模式
                        if (numberArgs.length > 1 && !hasNonNumberArg) {
                            // .zy n1 n2 ... 或 .zy n1 n2 ... f - 指定索引模式
                            if (numberArgs.length > 10) {
                                await msg.edit({ text: "最多只能指定10个数字" });
                                return;
                            }
                            messageIndices = numberArgs;
                            isIndicesMode = true;
                            isMultipleMessages = true;
                            isSamePerson = !lastArgIsF;
                            valid = true;
                        } else if (numberArgs.length === 1 && !hasNonNumberArg) {
                            // .zy n 或 .zy n f - 原有的连续模式
                            count = numberArgs[0];
                            if (lastArgIsF) {
                                // .zy n f - 记录群内最新n条消息
                                isMultipleMessages = true;
                                isSamePerson = false;
                            } else {
                                // .zy n - 记录同一人最新n条消息
                                isMultipleMessages = true;
                                isSamePerson = true;
                            }
                            valid = true;
                        } else {
                            // .zy n xxx - 当作自定义文本处理
                            customText = trimmedText.substring(args[0].length).trim();
                            valid = true;
                        }
                    } else {
                        // 第一个参数不是纯数字，当作自定义文本
                        customText = trimmedText.substring(args[0].length).trim();
                        valid = true;
                    }
                }

                console.log("🔍 解析结果: valid=" + valid + ", multiline=" + isMultilineMode + ", lines=" + multilineTexts.length);

                if (valid) {
                    console.log("✅ 命令有效，开始处理");
                    let replied = await msg.getReplyMessage();
                    if (!replied) {
                        console.log("❌ 没有回复消息");
                        await msg.edit({ text: "请回复一条消息" });
                        return;
                    }
                    console.log("✅ 找到回复消息，ID:", replied.id);

                    if (isMultipleMessages && !isIndicesMode && count > 10) {
                        await msg.edit({ text: "太多了 哒咩" });
                        return;
                    }

                    const hasCustomText = customText.length > 0;
                    await msg.edit({
                        text: isMultilineMode
                            ? `正在生成${multilineTexts.length}个语录...`
                            : isMultipleMessages
                                ? "正在生成语录贴纸..."
                                : hasCustomText
                                    ? "正在生成语录贴纸..."
                                    : "正在生成语录贴纸..."
                    });

                    try {
                        const client = await getGlobalClient();

                        if (isMultilineMode) {
                            console.log("🚀 开始处理多行造谣模式");
                            // 多行造谣模式 - 为同一个用户生成一张包含多个消息的贴纸
                            let sender = (await replied.forward?.getSender()) || (await replied.getSender());

                            // 处理频道消息
                            if (!sender && replied.fromId === null && replied.peerId?.channelId) {
                                try {
                                    const channel = await client.getEntity(replied.peerId);
                                    sender = {
                                        id: { toString: () => "channel_" + replied.peerId.channelId.toString() },
                                        firstName: (channel as any).title || "频道",
                                        lastName: "",
                                        username: (channel as any).username || "",
                                        emojiStatus: null
                                    };
                                } catch (e) {
                                    sender = {
                                        id: { toString: () => "channel_" + replied.peerId.channelId.toString() },
                                        firstName: replied.postAuthor || "频道用户",
                                        lastName: "",
                                        username: "",
                                        emojiStatus: null
                                    };
                                }
                            }

                            if (!sender) {
                                await msg.edit({ text: "无法获取消息发送者信息" });
                                return;
                            }

                            // 准备用户数据
                            const userId = sender.id.toString();
                            const firstName = (sender as any).firstName || (sender as any).title || "";
                            const lastName = (sender as any).lastName || "";
                            const username = (sender as any).username || "";
                            const emojiStatus = (sender as any).emojiStatus?.documentId?.toString() || null;

                            let photo = undefined;
                            try {
                                let buffer;
                                // 检查是否为频道消息，需要下载频道头像
                                if (replied.fromId === null && replied.peerId?.channelId) {
                                    const channel = await client.getEntity(replied.peerId);
                                    buffer = await client.downloadProfilePhoto(channel, {
                                        isBig: false,
                                    });
                                } else {
                                    buffer = await client.downloadProfilePhoto(sender as any, {
                                        isBig: false,
                                    });
                                }

                                if (Buffer.isBuffer(buffer)) {
                                    const base64 = buffer.toString("base64");
                                    photo = {
                                        url: `data:image/jpeg;base64,${base64}`,
                                    };
                                }
                            } catch (e) {
                                console.warn("下载头像失败", e);
                            }

                            // 为每一行文本创建消息项
                            console.log("📝 开始创建消息项，用户:", firstName || username || userId);
                            const items = [];
                            for (const textLine of multilineTexts) {
                                console.log("📝 添加文本行:", textLine);
                                items.push({
                                    from: {
                                        id: parseInt(userId),
                                        first_name: firstName,
                                        last_name: lastName || undefined,
                                        username: username || undefined,
                                        photo,
                                        emoji_status: emojiStatus || undefined,
                                    },
                                    text: textLine,
                                    entities: [], // 多行造谣模式不支持实体
                                    avatar: true,
                                    media: undefined, // 多行造谣模式不包含媒体
                                });
                            }
                            console.log("📝 消息项创建完成，总数:", items.length);

                            const quoteData = {
                                type: "quote",
                                format: "webp",
                                backgroundColor: "#1b1429",
                                width: 512,
                                height: 768,
                                scale: 2,
                                emojiBrand: "apple",
                                messages: items,
                            };
                            console.log("🎨 开始调用quote API，消息数:", items.length);

                            // 生成语录贴纸
                            const quoteResult = await generateQuote(quoteData);
                            console.log("🎨 quote API调用完成，图片长度:", quoteResult.buffer?.length);
                            const imageBuffer = quoteResult.buffer;
                            const imageExt = quoteResult.ext;

                            // 验证图片数据
                            console.log("🔍 验证图片数据，长度:", imageBuffer?.length);
                            if (!imageBuffer || imageBuffer.length === 0) {
                                console.error("❌ 图片数据为空");
                                await msg.edit({ text: "生成的图片数据为空" });
                                return;
                            }

                            try {
                                console.log("📤 准备发送贴纸文件");
                                const file = new CustomFile(
                                    `sticker.${imageExt}`,
                                    imageBuffer.length,
                                    "",
                                    imageBuffer
                                );

                                // 发送贴纸
                                const stickerAttr = new Api.DocumentAttributeSticker({
                                    alt: "fake_quote",
                                    stickerset: new Api.InputStickerSetEmpty(),
                                });

                                console.log("📤 开始发送文件到Telegram");
                                await client.sendFile(msg.peerId, {
                                    file,
                                    forceDocument: false,
                                    attributes: [stickerAttr],
                                    replyTo: replied?.id,
                                });
                                console.log("✅ 贴纸发送成功");
                            } catch (fileError) {
                                console.error(`❌ 发送文件失败: ${fileError}`);
                                await msg.edit({ text: `发送文件失败: ${fileError}` });
                                return;
                            }

                            console.log("🗑️ 删除原始命令消息");
                            await msg.delete();

                            const end = Date.now();
                            console.log(`✅ 多行造谣生成完成，耗时: ${end - start}ms，共${multilineTexts.length}条消息`);
                            return;
                        } else {
                            // 原有的单条消息或多条消息模式
                            const items = [] as any[];

                            if (isMultipleMessages) {
                                // 多条消息模式
                                let messages: Api.Message[];

                                if (isSamePerson) {
                                    // 同一人的多条消息 - 从回复的消息开始往前获取该人的消息
                                    let originalSender = (await replied.forward?.getSender()) || (await replied.getSender());

                                    // 处理频道消息
                                    if (!originalSender && replied.fromId === null && replied.peerId?.channelId) {
                                        try {
                                            const channel = await client.getEntity(replied.peerId);
                                            originalSender = {
                                                id: { toString: () => "channel_" + replied.peerId.channelId.toString() },
                                                firstName: (channel as any).title || "频道",
                                                lastName: "",
                                                username: (channel as any).username || "",
                                                emojiStatus: null
                                            };
                                        } catch (e) {
                                            originalSender = {
                                                id: { toString: () => "channel_" + replied.peerId.channelId.toString() },
                                                firstName: replied.postAuthor || "频道用户",
                                                lastName: "",
                                                username: "",
                                                emojiStatus: null
                                            };
                                        }
                                    }

                                    if (!originalSender) {
                                        await msg.edit({ text: "无法获取消息发送者信息" });
                                        return;
                                    }
                                    const originalSenderId = originalSender.id;

                                    if (isIndicesMode) {
                                        // 指定索引模式 - 获取指定位置的消息
                                        const maxIndex = Math.max(...messageIndices);
                                        const allMessages = await msg.client?.getMessages(replied?.peerId, {
                                            offsetId: replied!.id + 1,
                                            limit: maxIndex * 20, // 获取足够多的消息
                                        });

                                        if (!allMessages || allMessages.length === 0) {
                                            await msg.edit({ text: "未找到消息" });
                                            return;
                                        }

                                        // 筛选出同一个人的消息
                                        const userMessages: Api.Message[] = [];
                                        for (const message of allMessages) {
                                            const msgSender = (await message.forward?.getSender()) || (await message.getSender());
                                            if (msgSender && msgSender.id.eq(originalSenderId)) {
                                                userMessages.push(message);
                                            }
                                        }

                                        if (userMessages.length === 0) {
                                            await msg.edit({ text: "未找到该用户的更多消息" });
                                            return;
                                        }

                                        // 根据索引提取消息
                                        messages = [];
                                        for (const idx of messageIndices) {
                                            if (idx <= userMessages.length) {
                                                messages.push(userMessages[idx - 1]);
                                            }
                                        }

                                        if (messages.length === 0) {
                                            await msg.edit({ text: "指定的索引超出范围" });
                                            return;
                                        }

                                        // 将消息按时间正序排列
                                        messages.reverse();
                                    } else {
                                        // 连续模式 - 从回复的消息开始往前获取更多消息来筛选同一人的
                                        const allMessages = await msg.client?.getMessages(replied?.peerId, {
                                            offsetId: replied!.id + 1, // 从回复消息开始往前获取
                                            limit: count * 20, // 获取更多消息以便筛选，考虑到可能有很多其他人的消息
                                        });

                                        if (!allMessages || allMessages.length === 0) {
                                            await msg.edit({ text: "未找到消息" });
                                            return;
                                        }

                                        // 筛选出同一个人的消息，按时间倒序排列
                                        messages = [];
                                        for (const message of allMessages) {
                                            const msgSender = (await message.forward?.getSender()) || (await message.getSender());
                                            if (msgSender && msgSender.id.eq(originalSenderId)) {
                                                messages.push(message);
                                                if (messages.length >= count) break;
                                            }
                                        }

                                        if (messages.length === 0) {
                                            await msg.edit({ text: "未找到该用户的更多消息" });
                                            return;
                                        }

                                        // 将消息按时间正序排列，确保最早的消息在前面
                                        messages.reverse();
                                    }
                                } else {
                                    // 群内的多条消息 - 从回复的消息开始往前获取
                                    if (isIndicesMode) {
                                        // 指定索引模式
                                        const maxIndex = Math.max(...messageIndices);
                                        const allMessages = await msg.client?.getMessages(replied?.peerId, {
                                            offsetId: replied!.id + 1,
                                            limit: maxIndex,
                                        });

                                        if (!allMessages || allMessages.length === 0) {
                                            await msg.edit({ text: "未找到消息" });
                                            return;
                                        }

                                        // 根据索引提取消息
                                        messages = [];
                                        for (const idx of messageIndices) {
                                            if (idx <= allMessages.length) {
                                                messages.push(allMessages[idx - 1]);
                                            }
                                        }

                                        if (messages.length === 0) {
                                            await msg.edit({ text: "指定的索引超出范围" });
                                            return;
                                        }

                                        // 将消息按时间正序排列
                                        messages.reverse();
                                    } else {
                                        // 连续模式
                                        messages = await msg.client?.getMessages(replied?.peerId, {
                                            offsetId: replied!.id + 1, // 从回复消息开始往前获取
                                            limit: count,
                                        });

                                        if (!messages || messages.length === 0) {
                                            await msg.edit({ text: "未找到消息" });
                                            return;
                                        }

                                        // 将消息按时间正序排列，确保最早的消息在前面
                                        messages.reverse();
                                    }
                                }

                                // 处理每条消息
                                for await (const [i, message] of messages.entries()) {
                                    let sender = (await message.forward?.getSender()) || (await message.getSender());

                                    // 处理频道消息
                                    if (!sender && message.fromId === null && message.peerId?.channelId) {
                                        try {
                                            const channel = await client.getEntity(message.peerId);
                                            sender = {
                                                id: { toString: () => "channel_" + message.peerId.channelId.toString() },
                                                firstName: (channel as any).title || "频道",
                                                lastName: "",
                                                username: (channel as any).username || "",
                                                emojiStatus: null
                                            };
                                        } catch (e) {
                                            sender = {
                                                id: { toString: () => "channel_" + message.peerId.channelId.toString() },
                                                firstName: message.postAuthor || "频道用户",
                                                lastName: "",
                                                username: "",
                                                emojiStatus: null
                                            };
                                        }
                                    }

                                    if (!sender) continue;

                                    // 准备用户数据
                                    const userId = sender.id.toString();
                                    const firstName = (sender as any).firstName || (sender as any).title || "";
                                    const lastName = (sender as any).lastName || "";
                                    const username = (sender as any).username || "";
                                    const emojiStatus = (sender as any).emojiStatus?.documentId?.toString() || null;

                                    let photo = undefined;
                                    try {
                                        let buffer;
                                        // 检查是否为频道消息，需要下载频道头像
                                        if (message.fromId === null && message.peerId?.channelId) {
                                            const channel = await client.getEntity(message.peerId);
                                            buffer = await client.downloadProfilePhoto(channel, {
                                                isBig: false,
                                            });
                                        } else {
                                            buffer = await client.downloadProfilePhoto(sender as any, {
                                                isBig: false,
                                            });
                                        }

                                        if (Buffer.isBuffer(buffer)) {
                                            const base64 = buffer.toString("base64");
                                            photo = {
                                                url: `data:image/jpeg;base64,${base64}`,
                                            };
                                        }
                                    } catch (e) {
                                        console.warn("下载头像失败", e);
                                    }

                                    // 处理引用文本
                                    if (i === 0) {
                                        let replyTo = (trigger || msg)?.replyTo;
                                        if (replyTo?.quoteText) {
                                            message.message = replyTo.quoteText;
                                            message.entities = replyTo.quoteEntities;
                                        }
                                    }

                                    // 转换消息实体
                                    const entities = convertEntities(message.entities || []);

                                    // 处理媒体
                                    let media = undefined;
                                    try {
                                        if (message.media) {
                                            let mediaTypeForQuote: string | undefined = undefined;

                                            // 判断是否为贴纸
                                            const isSticker =
                                                message.media instanceof Api.MessageMediaDocument &&
                                                (message.media as Api.MessageMediaDocument).document &&
                                                (
                                                    (message.media as Api.MessageMediaDocument).document as any
                                                ).attributes?.some(
                                                    (a: any) => a instanceof Api.DocumentAttributeSticker
                                                );

                                            if (isSticker) {
                                                mediaTypeForQuote = "sticker";
                                            } else {
                                                mediaTypeForQuote = "photo";
                                            }

                                            const mimeType = (message.media as any).document?.mimeType;
                                            const buffer = await (message as any).downloadMedia({
                                                thumb: ["video/webm"].includes(mimeType) ? 0 : 1,
                                            });
                                            if (Buffer.isBuffer(buffer)) {
                                                const mime =
                                                    mediaTypeForQuote === "sticker"
                                                        ? "image/webp"
                                                        : "image/jpeg";
                                                const base64 = buffer.toString("base64");
                                                media = { url: `data:${mime};base64,${base64}` };
                                            }
                                        }
                                    } catch (e) {
                                        console.error("下载媒体失败", e);
                                    }

                                    items.push({
                                        from: {
                                            id: parseInt(userId),
                                            first_name: firstName,
                                            last_name: lastName || undefined,
                                            username: username || undefined,
                                            photo,
                                            emoji_status: emojiStatus || undefined,
                                        },
                                        text: message.message || "",
                                        entities: entities,
                                        avatar: true,
                                        media,
                                    });
                                }
                            } else {
                                // 单条消息模式（原有功能）
                                let sender = (await replied.forward?.getSender()) || (await replied.getSender());

                                // 处理频道消息
                                if (!sender && replied.fromId === null && replied.peerId?.channelId) {
                                    try {
                                        const channel = await client.getEntity(replied.peerId);
                                        sender = {
                                            id: { toString: () => "channel_" + replied.peerId.channelId.toString() },
                                            firstName: (channel as any).title || "频道",
                                            lastName: "",
                                            username: (channel as any).username || "",
                                            emojiStatus: null
                                        };
                                    } catch (e) {
                                        sender = {
                                            id: { toString: () => "channel_" + replied.peerId.channelId.toString() },
                                            firstName: replied.postAuthor || "频道用户",
                                            lastName: "",
                                            username: "",
                                            emojiStatus: null
                                        };
                                    }
                                }

                                if (!sender) {
                                    await msg.edit({ text: "无法获取消息发送者信息" });
                                    return;
                                }

                                // 准备用户数据
                                const userId = sender.id.toString();
                                const firstName = (sender as any).firstName || (sender as any).title || "";
                                const lastName = (sender as any).lastName || "";
                                const username = (sender as any).username || "";
                                const emojiStatus = (sender as any).emojiStatus?.documentId?.toString() || null;

                                let photo = undefined;
                                try {
                                    let buffer;
                                    // 检查是否为频道消息，需要下载频道头像
                                    if (replied.fromId === null && replied.peerId?.channelId) {
                                        const channel = await client.getEntity(replied.peerId);
                                        buffer = await client.downloadProfilePhoto(channel, {
                                            isBig: false,
                                        });
                                    } else {
                                        buffer = await client.downloadProfilePhoto(sender as any, {
                                            isBig: false,
                                        });
                                    }

                                    if (Buffer.isBuffer(buffer)) {
                                        const base64 = buffer.toString("base64");
                                        photo = {
                                            url: `data:image/jpeg;base64,${base64}`,
                                        };
                                    }
                                } catch (e) {
                                    console.warn("下载头像失败", e);
                                }

                                // 决定使用的文本和实体
                                let messageText: string;
                                let messageEntities: any[];

                                if (hasCustomText) {
                                    // 使用自定义文本，清空实体（因为原实体偏移量不再匹配）
                                    messageText = customText;
                                    messageEntities = [];
                                } else {
                                    // 使用原消息文本和实体
                                    let replyTo = (trigger || msg)?.replyTo;
                                    if (replyTo?.quoteText) {
                                        messageText = replyTo.quoteText;
                                        messageEntities = convertEntities(replyTo.quoteEntities || []);
                                    } else {
                                        messageText = replied.message || "";
                                        messageEntities = convertEntities(replied.entities || []);
                                    }
                                }

                                // 处理媒体 - 只有在没有自定义文本时才包含媒体
                                let media = undefined;
                                if (!hasCustomText) {
                                    try {
                                        if (replied.media) {
                                            let mediaTypeForQuote: string | undefined = undefined;

                                            // 判断是否为贴纸
                                            const isSticker =
                                                replied.media instanceof Api.MessageMediaDocument &&
                                                (replied.media as Api.MessageMediaDocument).document &&
                                                (
                                                    (replied.media as Api.MessageMediaDocument).document as any
                                                ).attributes?.some(
                                                    (a: any) => a instanceof Api.DocumentAttributeSticker
                                                );

                                            if (isSticker) {
                                                mediaTypeForQuote = "sticker";
                                            } else {
                                                mediaTypeForQuote = "photo";
                                            }

                                            const mimeType = (replied.media as any).document?.mimeType;
                                            const buffer = await (replied as any).downloadMedia({
                                                thumb: ["video/webm"].includes(mimeType) ? 0 : 1,
                                            });
                                            if (Buffer.isBuffer(buffer)) {
                                                const mime =
                                                    mediaTypeForQuote === "sticker"
                                                        ? "image/webp"
                                                        : "image/jpeg";
                                                const base64 = buffer.toString("base64");
                                                media = { url: `data:${mime};base64,${base64}` };
                                            }
                                        }
                                    } catch (e) {
                                        console.error("下载媒体失败", e);
                                    }
                                }

                                items.push({
                                    from: {
                                        id: parseInt(userId),
                                        first_name: firstName,
                                        last_name: lastName || undefined,
                                        username: username || undefined,
                                        photo,
                                        emoji_status: emojiStatus || undefined,
                                    },
                                    text: messageText,
                                    entities: messageEntities,
                                    avatar: true,
                                    media, // 有自定义文本时为 undefined，无自定义文本时为原媒体
                                });
                            }

                            const quoteData = {
                                type: "quote",
                                format: "webp",
                                backgroundColor: "#1b1429",
                                width: 512,
                                height: 768,
                                scale: 2,
                                emojiBrand: "apple",
                                messages: items,
                            };

                            // 生成语录贴纸
                            const quoteResult = await generateQuote(quoteData);
                            const imageBuffer = quoteResult.buffer;
                            const imageExt = quoteResult.ext;

                            // 验证图片数据
                            if (!imageBuffer || imageBuffer.length === 0) {
                                await msg.edit({ text: "生成的图片数据为空" });
                                return;
                            }

                            try {
                                const file = new CustomFile(
                                    `sticker.${imageExt}`,
                                    imageBuffer.length,
                                    "",
                                    imageBuffer
                                );

                                // 发送贴纸
                                const stickerAttr = new Api.DocumentAttributeSticker({
                                    alt: hasCustomText ? "fake_quote" : "quote",
                                    stickerset: new Api.InputStickerSetEmpty(),
                                });

                                await client.sendFile(msg.peerId, {
                                    file,
                                    forceDocument: false,
                                    attributes: [stickerAttr],
                                    replyTo: replied?.id,
                                });
                            } catch (fileError) {
                                console.error(`发送文件失败: ${fileError}`);
                                await msg.edit({ text: `发送文件失败: ${fileError}` });
                                return;
                            }

                            await msg.delete();

                            const end = Date.now();
                            const mode = isMultipleMessages ? '语录' : (hasCustomText ? '造谣' : '语录');
                            console.log(`${mode}生成耗时: ${end - start}ms`);
                        }
                    } catch (error) {
                        console.error(`语录生成失败: ${error}`);
                        await msg.edit({ text: `语录生成失败: ${error}` });
                    }
                } else {
                    await msg.edit({
                        text: help_text,
                        parseMode: "html",
                    });
                }
            },
        };
}

export default new ZyPlugin();
