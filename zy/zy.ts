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
    description: string = `\n造谣插件 - 生成带有自定义文本的语录贴纸\n\n${help_text}`;
    cmdHandlers: Record<
        string,
        (msg: Api.Message, trigger?: Api.Message) => Promise<void>
    > = {
            zy: async (msg: Api.Message, trigger?: Api.Message) => {
                const start = Date.now();

                // 解析命令参数
                const msgText = msg.message.trim();
                const args = msgText.split(/\s+/);

                // 提取自定义文本（除了命令本身的所有内容）
                const customText = msgText.substring(args[0].length).trim();
                const hasCustomText = customText.length > 0;

                let replied = await msg.getReplyMessage();
                if (!replied) {
                    await msg.edit({ text: "请回复一条消息" });
                    return;
                }

                await msg.edit({ text: hasCustomText ? "正在生成造谣贴纸..." : "正在生成语录贴纸..." });

                try {
                    const client = await getGlobalClient();

                    // 获取被回复的消息发送者信息
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

                    const items = [{
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
                    }];

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
                    console.log(`${hasCustomText ? '造谣' : '语录'}生成耗时: ${end - start}ms`);
                } catch (error) {
                    console.error(`${hasCustomText ? '造谣' : '语录'}生成失败: ${error}`);
                    await msg.edit({ text: `${hasCustomText ? '造谣' : '语录'}生成失败: ${error}` });
                }
            },
        };
}

export default new ZyPlugin();
