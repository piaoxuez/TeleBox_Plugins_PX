import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api } from "telegram";
import { getGlobalClient } from "@utils/globalClient";
import { sleep } from "telegram/Helpers";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

const pluginName = "dc";
const commandName = `${mainPrefix}${pluginName}`;

// bot的username
const BOT_USERNAME = "testdckbot";

const help_text = `
- 调查用户（当前群组）
使用 <code>${commandName} [关键词]</code> 回复一条消息，搜索该用户在当前群组的聊天记录

示例：<code>${commandName} 敏感词</code>

- 调查用户（全部群组）
使用 <code>${commandName} f [关键词]</code> 回复一条消息，搜索该用户在全部群组的聊天记录

示例：<code>${commandName} f 敏感词</code>

- 调查群组（不指定用户）
使用 <code>${commandName} [关键词]</code> 不回复消息，搜索当前群组内所有人的聊天记录

示例：<code>${commandName} 敏感词</code>
`;

class DcPlugin extends Plugin {
    description: string = `\n调查科插件 - 调查你！\n\n${help_text}`;
    cmdHandlers: Record<
        string,
        (msg: Api.Message, trigger?: Api.Message) => Promise<void>
    > = {
            dc: async (msg: Api.Message, trigger?: Api.Message) => {
                console.log("🚀 DC插件开始执行，消息ID:", msg.id);

                // 解析命令参数
                const msgText = msg.message;
                const trimmedText = msgText.trim();
                const args = trimmedText.split(/\s+/);

                // 检查是否为全局搜索模式（.dc f xxx）
                const isGlobalSearch = args[1] === "f";

                // 提取搜索关键词
                let keyword = "";
                if (isGlobalSearch) {
                    // .dc f xxx - 跳过命令和f参数
                    keyword = trimmedText.substring(args[0].length).trim().substring(1).trim();
                } else {
                    // .dc xxx - 跳过命令
                    keyword = trimmedText.substring(args[0].length).trim();
                }

                if (!keyword) {
                    await msg.edit({
                        text: help_text,
                        parseMode: "html",
                    });
                    return;
                }

                // 检查是否回复了消息
                let replied = await msg.getReplyMessage();
                const isGroupSearch = !replied && !isGlobalSearch; // 没有回复消息且不是全局搜索，则为群组搜索

                // 如果是全局搜索但没有回复消息，则报错
                if (isGlobalSearch && !replied) {
                    await msg.edit({ text: "全局搜索必须回复一条消息以指定用户" });
                    return;
                }

                try {
                    const client = await getGlobalClient();

                    let userId = "";
                    let userName = "";

                    // 如果不是群组搜索，获取被调查用户信息
                    if (!isGroupSearch) {
                        let sender = (await replied!.forward?.getSender()) || (await replied!.getSender());

                        // 处理频道消息
                        if (!sender && replied!.fromId === null && replied!.peerId?.channelId) {
                            try {
                                const channel = await client.getEntity(replied!.peerId);
                                sender = {
                                    id: { toString: () => "channel_" + replied!.peerId.channelId.toString() },
                                    firstName: (channel as any).title || "频道",
                                    lastName: "",
                                    username: (channel as any).username || "",
                                };
                            } catch (e) {
                                sender = {
                                    id: { toString: () => "channel_" + replied!.peerId.channelId.toString() },
                                    firstName: replied!.postAuthor || "频道用户",
                                    lastName: "",
                                    username: "",
                                };
                            }
                        }

                        if (!sender) {
                            await msg.edit({ text: "无法获取消息发送者信息" });
                            return;
                        }

                        userId = sender.id.toString();
                        userName = (sender as any).firstName || (sender as any).username || "用户";
                    }

                    // 正确提取群组ID
                    let groupId = "";
                    if (msg.peerId) {
                        if ((msg.peerId as any).channelId) {
                            // 超级群组或频道: -100 + channelId
                            groupId = "-100" + (msg.peerId as any).channelId.toString();
                        } else if ((msg.peerId as any).chatId) {
                            // 普通群组: - + chatId
                            groupId = "-" + (msg.peerId as any).chatId.toString();
                        } else if ((msg.peerId as any).userId) {
                            // 私聊: userId
                            groupId = (msg.peerId as any).userId.toString();
                        }
                    }

                    console.log(`📝 准备调查: 用户=${userName}(${userId}), 群组=${groupId}, 关键词=${keyword}, 全局=${isGlobalSearch}, 群组搜索=${isGroupSearch}`);

                    // 显示临时消息
                    let tempMessage = "";
                    if (isGroupSearch) {
                        tempMessage = `正在对本群进行调查...`;
                    } else {
                        const searchScope = isGlobalSearch ? "全部群组" : "本群";
                        tempMessage = `正在对 ${userName} 在${searchScope}进行调查...`;
                    }
                    await msg.edit({ text: tempMessage });

                    // 获取bot实体
                    let botEntity;
                    try {
                        botEntity = await client.getEntity(BOT_USERNAME);
                    } catch (e) {
                        console.error("获取bot实体失败:", e);
                        await msg.edit({ text: `无法找到 @${BOT_USERNAME}` });
                        return;
                    }

                    // 构造发送给bot的命令
                    let botCommand = "";
                    if (isGroupSearch) {
                        // 群组搜索: sg keyword groupid
                        botCommand = `sg ${keyword} ${groupId}`;
                    } else if (isGlobalSearch) {
                        // 全局用户搜索: su keyword userid
                        botCommand = `su ${keyword} ${userId}`;
                    } else {
                        // 指定用户群组搜索: ss keyword userid groupid
                        botCommand = `ss ${keyword} ${userId} ${groupId}`;
                    }
                    console.log(`📤 发送给bot的命令: ${botCommand}`);

                    // 发送命令给bot
                    await client.sendMessage(botEntity, {
                        message: botCommand,
                    });

                    console.log("⏳ 等待bot回复...");

                    // 等待bot回复（最多等待30秒）
                    let botResponse: Api.Message | null = null;
                    const maxAttempts = 30;

                    for (let i = 0; i < maxAttempts; i++) {
                        await sleep(1000); // 每秒检查一次

                        // 获取与bot的最新消息
                        const messages = await client.getMessages(botEntity, {
                            limit: 10,
                        });

                        // 查找bot的回复（不是我们发送的消息）
                        for (const message of messages) {
                            if (
                                message.senderId?.toString() === botEntity.id?.toString() &&
                                message.date > Math.floor(Date.now() / 1000) - 35
                            ) {
                                botResponse = message;
                                break;
                            }
                        }

                        if (botResponse) {
                            console.log("✅ 收到bot回复");
                            break;
                        }
                    }

                    if (!botResponse) {
                        await msg.edit({ text: `调查超时，@${BOT_USERNAME} 未在30秒内回复` });
                        return;
                    }

                    // 获取bot的回复内容和实体（包含格式信息）
                    const botReplyText = botResponse.message || "（无文本内容）";
                    const botReplyEntities = botResponse.entities || [];

                    // 输出调查结果
                    let headerText = "";
                    if (isGroupSearch) {
                        headerText = `对本群调查关键词"${keyword}"的结果如下：\n\n`;
                    } else {
                        const scopeText = isGlobalSearch ? "全部群组" : "本群";
                        headerText = `对 ${userName} 在${scopeText}调查关键词"${keyword}"的结果如下：\n\n`;
                    }
                    const resultText = headerText + botReplyText;

                    // 调整实体偏移量（因为添加了头部文本）
                    const headerOffset = headerText.length;
                    const adjustedEntities = botReplyEntities.map((entity: any) => {
                        // 克隆实体并调整偏移量
                        const cloned = Object.create(Object.getPrototypeOf(entity));
                        Object.assign(cloned, entity);
                        cloned.offset = entity.offset + headerOffset;
                        return cloned;
                    });

                    // 直接使用实体，不使用 parseMode
                    await msg.edit({
                        text: resultText,
                        linkPreview: false,
                        formattingEntities: adjustedEntities
                    });

                    console.log("✅ DC插件执行完成");
                } catch (error) {
                    console.error(`DC插件执行失败: ${error}`);
                    await msg.edit({ text: `调查失败: ${error}` });
                }
            },
        };
}

export default new DcPlugin();
