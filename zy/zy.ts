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

                // 检查是否为多行模式：.zy后面直接是换行
                const commandMatch = msgText.match(/^\.[a-zA-Z0-9]+(\r?\n)/);
                if (commandMatch) {
                    // 多行模式
                    const lines = msgText.split(/\r?\n/).slice(1); // 去掉第一行的.zy命令
                    multilineTexts = lines.filter(line => line.trim().length > 0).map(line => line.trim());
                    if (multilineTexts.length > 0) {
                        isMultilineMode = true;
                        valid = true;
                    }
                }

                // 如果不是多行模式，则执行原有的参数判断逻辑
                if (!isMultilineMode) {
                    // 判断参数类型
                    if (!args[1]) {
                        // 没有参数，原有的复刻原消息功能
                        valid = true;
                    } else if (/^\d+$/.test(args[1])) {
                        // 第一个参数是纯数字
                        count = parseInt(args[1]);
                        if (args[2] === "f") {
                            // .zy n f - 记录群内最新n条消息（类似yvlu n）
                            isMultipleMessages = true;
                            isSamePerson = false;
                        } else if (!args[2]) {
                            // .zy n - 记录同一人最新n条消息
                            isMultipleMessages = true;
                            isSamePerson = true;
                        } else {
                            // .zy n xxx - 当作自定义文本处理
                            customText = trimmedText.substring(args[0].length).trim();
                        }
                        valid = true;
                    } else {
                        // 第一个参数不是纯数字，当作自定义文本
                        customText = trimmedText.substring(args[0].length).trim();
                        valid = true;
                    }
                }

                if (valid) {
                    let replied = await msg.getReplyMessage();
                    if (!replied) {
                        await msg.edit({ text: "请回复一条消息" });
                        return;
                    }

                    if (isMultipleMessages && count > 10) {
                        await msg.edit({ text: "太多了 哒咩" });
                        return;
                    }

                    const hasCustomText = customText.length > 0;
                    await msg.edit({
                        text: isMultilineMode
                            ? `正在生成${multilineTexts.length}个造谣贴纸...`
                            : isMultipleMessages
                                ? "正在生成语录贴纸..."
                                : hasCustomText
                                    ? "正在生成造谣贴纸..."
                                    : "正在生成语录贴纸..."
                    });

                    try {
                        const client = await getGlobalClient();

                        if (isMultilineMode) {
                            // 多行造谣模式 - 为同一个用户生成一张包含多个消息的贴纸
                            const sender = (await replied.forward?.getSender()) || (await replied.getSender());
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
                                const buffer = await client.downloadProfilePhoto(sender as any, {
                                    isBig: false,
                                });
                                if (Buffer.isBuffer(buffer)) {
                                    const base64 = buffer.toString("base64");
                                    photo = {
                                        url: `data:image/jpeg;base64,${base64}`,
                                    };
                                }
                            } catch (e) {
                                console.warn("下载用户头像失败", e);
                            }

                            // 为每一行文本创建消息项
                            const items = [];
                            for (const textLine of multilineTexts) {
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
                                    alt: "fake_quote",
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
                            console.log(`多行造谣生成耗时: ${end - start}ms，共${multilineTexts.length}条消息`);
                            return;
                        } else {
                            // 原有的单条消息或多条消息模式
                            const items = [] as any[];

                            if (isMultipleMessages) {
                                // 多条消息模式
                                let messages: Api.Message[];

                                if (isSamePerson) {
                                    // 同一人的多条消息 - 从回复的消息开始往前获取该人的消息
                                    const originalSender = (await replied.forward?.getSender()) || (await replied.getSender());
                                    if (!originalSender) {
                                        await msg.edit({ text: "无法获取消息发送者信息" });
                                        return;
                                    }
                                    const originalSenderId = originalSender.id;

                                    // 从回复的消息开始往前获取更多消息来筛选同一人的
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
                                } else {
                                    // 群内的多条消息 - 从回复的消息开始往前获取
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

                                // 处理每条消息
                                for await (const [i, message] of messages.entries()) {
                                    const sender = (await message.forward?.getSender()) || (await message.getSender());
                                    if (!sender) continue;

                                    // 准备用户数据
                                    const userId = sender.id.toString();
                                    const firstName = (sender as any).firstName || (sender as any).title || "";
                                    const lastName = (sender as any).lastName || "";
                                    const username = (sender as any).username || "";
                                    const emojiStatus = (sender as any).emojiStatus?.documentId?.toString() || null;

                                    let photo = undefined;
                                    try {
                                        const buffer = await client.downloadProfilePhoto(sender as any, {
                                            isBig: false,
                                        });
                                        if (Buffer.isBuffer(buffer)) {
                                            const base64 = buffer.toString("base64");
                                            photo = {
                                                url: `data:image/jpeg;base64,${base64}`,
                                            };
                                        }
                                    } catch (e) {
                                        console.warn("下载用户头像失败", e);
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
                                const sender = (await replied.forward?.getSender()) || (await replied.getSender());
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
                                    const buffer = await client.downloadProfilePhoto(sender as any, {
                                        isBig: false,
                                    });
                                    if (Buffer.isBuffer(buffer)) {
                                        const base64 = buffer.toString("base64");
                                        photo = {
                                            url: `data:image/jpeg;base64,${base64}`,
                                        };
                                    }
                                } catch (e) {
                                    console.warn("下载用户头像失败", e);
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
