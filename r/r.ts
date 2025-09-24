import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { Api, client, TelegramClient } from "telegram";
import { RPCError } from "telegram/errors";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

class RPlugin extends Plugin {
    description: string = `复读\n回复一条消息即可复读\n<code>${mainPrefix}r [消息数] [复读次数]</code>`;
    cmdHandlers: Record<
        string,
        (msg: Api.Message, trigger?: Api.Message) => Promise<void>
    > = {
            r: async (msg, trigger) => {
                const [, ...args] = msg.text.slice(1).split(" ");
                const count = parseInt(args[0]) || 1;
                const repeat = parseInt(args[1]) || 1;

                try {
                    if (!msg.isReply) {
                        await msg.edit({ text: "你必须回复一条消息才能够进行复读" });
                        return;
                    }

                    let replied = await msg.getReplyMessage();
                    const messages = await msg.client?.getMessages(replied?.peerId, {
                        offsetId: replied!.id - 1,
                        limit: count,
                        reverse: true,
                    });

                    await msg.delete();

                    if (!messages || messages.length === 0) {
                        return;
                    }

                    for (let i = 0; i < repeat; i++) {
                        // 首先尝试正常转发
                        try {
                            const toPeer = await msg.getInputChat();
                            const fromPeer = await replied!.getInputChat();
                            const ids = messages.map((m) => m.id);
                            const topMsgId =
                                replied?.replyTo?.replyToTopId || replied?.replyTo?.replyToMsgId;

                            await msg.client?.invoke(
                                new Api.messages.ForwardMessages({
                                    fromPeer,
                                    id: ids,
                                    toPeer,
                                    ...(topMsgId ? { topMsgId } : {}),
                                })
                            );
                        } catch (forwardError) {
                            // 转发失败，尝试使用echo机制
                            console.log("转发失败，尝试echo机制:", forwardError);

                            for (const message of messages) {
                                try {
                                    await this.echoMessage(message, msg.chatId, msg.client!);
                                } catch (echoError) {
                                    console.error("Echo失败:", echoError);
                                    // 如果echo也失败，发送错误信息（仅第一次重复时）
                                    if (i === 0) {
                                        await msg.client?.sendMessage(msg.chatId, {
                                            message: `无法复读消息 ID ${message.id}: ${echoError instanceof Error ? echoError.message : '未知错误'}`,
                                        });
                                    }
                                }
                            }
                        }
                    }
                } catch (error) {
                    if (error instanceof RPCError) {
                        if (error.errorMessage == "CHAT_FORWARDS_RESTRICTED") {
                            await msg.edit({
                                text: "无法复读消息，群组设置禁止复读消息。",
                            });
                        } else {
                            await msg.edit({
                                text: error.message || "发生错误，无法复读消息。请稍后再试。",
                            });
                        }
                    } else {
                        await msg.edit({
                            text: "发生未知错误，无法转发消息。请稍后再试。",
                        });
                    }
                }

                if (trigger) {
                    try {
                        await trigger.delete();
                    } catch (e) { }
                }
            },
        };

    // Echo机制实现
    private async echoMessage(
        originalMsg: Api.Message,
        targetChatId: any,
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
        const replyTo = originalMsg.replyTo
            ? new Api.InputReplyToMessage({
                replyToMsgId: originalMsg.replyTo.replyToMsgId!,
                quoteText: originalMsg.replyTo.quoteText,
                quoteEntities: originalMsg.replyTo.quoteEntities,
                quoteOffset: originalMsg.replyTo.quoteOffset,
                topMsgId: originalMsg.replyTo.replyToTopId,
            })
            : undefined;

        if (inputMedia) {
            // 发送包含媒体的消息
            await client.invoke(
                new Api.messages.SendMedia({
                    peer: targetChatId,
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
                    peer: targetChatId,
                    message: originalMsg.message || "",
                    entities: originalMsg.entities,
                    ...(replyTo ? { replyTo } : {}),
                })
            );
        }
    }
}

const plugin = new RPlugin();

export default plugin;
