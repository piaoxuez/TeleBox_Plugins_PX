import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { Api, TelegramClient } from "telegram";
import { sleep } from "telegram/Helpers";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";

const PARSE_BOT_USERNAME = "ParseHubot";
const TIMEOUT_MS = 60000; // 1分钟超时

class VideoPlugin extends Plugin {
    description: string = `视频解析插件\n用法: <code>${mainPrefix}video &lt;链接&gt;</code>\n自动通过 @${PARSE_BOT_USERNAME} 解析视频链接`;

    cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
        video: async (msg: Api.Message) => await this.handleVideo(msg),
    };

    private async handleVideo(msg: Api.Message): Promise<void> {
        const client = await getGlobalClient();
        if (!client) {
            await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
            return;
        }

        try {
            // 解析命令参数
            const text = msg.text?.trim() || "";
            const parts = text.split(/\s+/);
            const [, ...args] = parts;

            if (args.length === 0) {
                await msg.edit({
                    text: `用法: <code>${mainPrefix}video &lt;链接&gt;</code>`,
                    parseMode: "html"
                });
                return;
            }

            const videoUrl = args.join(" ");

            // 先将消息改为"解析中..."
            await msg.edit({ text: "解析中...", parseMode: "html" });

            // 发送消息给 ParseHubot
            const sentMsg = await client.sendMessage(PARSE_BOT_USERNAME, {
                message: videoUrl,
            });

            // 等待机器人回复（最多1分钟）
            const startTime = Date.now();
            let videoMessage: Api.Message | null = null;

            while (Date.now() - startTime < TIMEOUT_MS) {
                await sleep(2000); // 每2秒检查一次

                // 获取最新的消息
                const messages = await client.getMessages(PARSE_BOT_USERNAME, {
                    limit: 10,
                });

                // 查找在我们发送消息之后，机器人回复的带视频的消息
                for (const message of messages) {
                    if (
                        message.id > sentMsg.id &&
                        message.fromId &&
                        message.media &&
                        this.hasVideo(message)
                    ) {
                        videoMessage = message;
                        break;
                    }
                }

                if (videoMessage) {
                    break;
                }
            }

            if (!videoMessage) {
                // 超时，将消息改为"解析超时"
                await msg.edit({ text: "解析超时", parseMode: "html" });
                return;
            }

            // 复制视频消息到当前聊天
            await this.copyVideoMessage(videoMessage, msg, client);

        } catch (error: any) {
            console.error("[video] 插件执行失败:", error);
            await msg.edit({
                text: `❌ 解析失败: ${error.message || "未知错误"}`,
                parseMode: "html",
            });
        }
    }

    private hasVideo(message: Api.Message): boolean {
        if (!message.media) return false;

        // 检查是否为视频文档
        if (
            message.media instanceof Api.MessageMediaDocument &&
            message.media.document instanceof Api.Document
        ) {
            const mimeType = message.media.document.mimeType || "";
            // 检查是否为视频类型
            return mimeType.startsWith("video/");
        }

        return false;
    }

    private async copyVideoMessage(
        videoMsg: Api.Message,
        targetMsg: Api.Message,
        client: TelegramClient
    ): Promise<void> {
        // 将视频消息中的媒体转换为可发送的 InputMedia
        const toInputMedia = (
            media: Api.TypeMessageMedia
        ): Api.TypeInputMedia | undefined => {
            try {
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
                console.warn("[video] 构造 InputMedia 失败", e);
            }
            return undefined;
        };

        const inputMedia = videoMsg.media ? toInputMedia(videoMsg.media) : undefined;

        if (inputMedia) {
            // 删除原来的"解析中..."消息
            await targetMsg.delete();

            // 发送视频到目标聊天
            await client.invoke(
                new Api.messages.SendMedia({
                    peer: targetMsg.chatId,
                    message: videoMsg.message || "",
                    media: inputMedia,
                    entities: videoMsg.entities,
                })
            );
        } else {
            throw new Error("无法提取视频媒体信息");
        }
    }
}

export default new VideoPlugin();
