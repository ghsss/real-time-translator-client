import * as fluentFfmpeg from 'fluent-ffmpeg';
import { Message, ParseMode } from 'node-telegram-bot-api';
import * as TelegramBot from 'node-telegram-bot-api';
import TimingUtil from '../utils/TimingUtil';
import { config } from 'dotenv';
import { Stream } from "stream";
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

config();

const TELEGRAM_BOT_TOKEN: string = String(process.env.TELEGRAM_BOT_TOKEN);
const TRANSLATION_API_BASE_URL: string = String(process.env.TRANSLATION_API_BASE_URL);

if (!TELEGRAM_BOT_TOKEN) {
    throw 'Telegram bot token is required! Please setup .env file';
}
if (!TRANSLATION_API_BASE_URL) {
    throw 'Translation API base URL is required! Please setup .env file';
}

class TelegramService {

    private telegramBot: TelegramBot = new TelegramBot.default(TELEGRAM_BOT_TOKEN, { polling: true });
    activeChats: any = {};
    activeChatsLimit: number = 10;
    activeChatsCount: number = 0;
    runningChatUsers: any[] = [];
    waitingChatQueue: any[] = [];
    runningSnapshotUsers: any[] = [];

    handleBotErrors() {

        this.telegramBot.addListener('polling_error', (polling_error) => {

            console.log('POLLING ERROR: ', polling_error);

        });

        this.telegramBot.addListener('webhook_error', (webhook_error) => {

            console.log('WEBHOOK ERROR: ', webhook_error);

        });

    }

    async start() {

        try {
            this.handleBotErrors();
        } catch (error) {

        }

        try {
            await this.verifyActiveChatsChange();
        } catch (error) {
            console.log('Error notifying waiting Chat queue subscribers ! ! !\n', error);
        }

        try {
            await this.deleteInactiveChats();
        } catch (error) {
            console.log('Error deleting inactive chats ! ! !\n', error);
        }


        this.telegramBot.on('message', async (msg) => {
            await this.onMessage(msg).catch(async onmsgError => {
                const chatId = msg.chat.id.toString();
                await this.sendTextMessage(chatId, '<b><em>Error to process your message: \n' + onmsgError + '\n\n\nTry again later.</em></b>');
                await this.resetChat(chatId);
                const idx = this.runningSnapshotUsers.indexOf(chatId);
                if (idx != -1) {
                    this.runningSnapshotUsers.splice(idx, 1);
                }
                console.log('onMessage error: ', onmsgError);
            });
        });

    }

    async resetChat(chatId: string | number) {
        delete this.activeChats[chatId];
        if (chatId.toString().indexOf('-') == -1) {
            await this.sendTextMessage(chatId, '<b><em>Chat restarted.</em></b>');
        }
    }

    async deleteInactiveChats() {

        setInterval(async () => {

            if (Object.keys(this.activeChats).length > 0) {
                try {
                    const activeChatsCopy = this.activeChats;
                    for (const chatId in activeChatsCopy) {
                        if (Object.prototype.hasOwnProperty.call(this.activeChats, chatId)) {
                            const chatInfo = this.activeChats[chatId];
                            if (Date.now() - chatInfo.lastInteractionTimestamp >= (1000 * 60 * 10)) {
                                if (chatId.indexOf('-') == -1) {
                                    await this.sendTextMessage(chatId, '<b><em>Reseting chat because of inactivity . . .</em></b>');
                                    await this.resetChat(chatId);
                                    await TimingUtil.waitSeconds(.1);
                                } else {
                                    await this.resetChat(chatId);
                                    await TimingUtil.waitSeconds(.1);

                                }
                            }

                        }
                    }
                } catch (error) {
                    // console.log('error sending message of chat inactivity to: ', chatId);
                }

            }

        }, 1000 * 10);

    }

    async verifyActiveChatsChange() {

        let isNotifyingWaitingChatQueueChat = false;

        let activeChatsCountOldRef = this.activeChatsCount;

        setInterval(async () => {

            const activeChatsCountChanged = activeChatsCountOldRef != this.activeChatsCount;

            console.log('activeChatsCountChanged: ', activeChatsCountChanged);

            activeChatsCountOldRef = this.activeChatsCount;

            if (activeChatsCountChanged && this.activeChatsCount < this.activeChatsLimit) {

                if (this.waitingChatQueue.length > 0 && !isNotifyingWaitingChatQueueChat) {
                    console.log('NOTIFYING ' + this.waitingChatQueue.length + ' SUBS ABOUT activeChatsCountChange');
                    isNotifyingWaitingChatQueueChat = true;
                    try {
                        await TimingUtil.waitSeconds(15);
                        const waitingChatQueueCopy = this.waitingChatQueue;
                        for await (const waitingChatQueueChat of waitingChatQueueCopy) {
                            await TimingUtil.waitSeconds(.3);
                            await this.sendTextMessage(waitingChatQueueChat, '<b><em>Bot active running chats decreased: (' + this.activeChatsCount + '/' + this.activeChatsLimit + ')\n\nNow you can try again and start your translation! ✅</em></b>');
                            const idxOfwaitingChatQueueChat = this.waitingChatQueue.indexOf(waitingChatQueueChat);
                            if (idxOfwaitingChatQueueChat) {
                                this.waitingChatQueue.splice(idxOfwaitingChatQueueChat, 1);
                            }
                        }
                        this.waitingChatQueue = [];
                    } catch (error) {
                        console.log('ERROR NOTIFYING WAITING CHAT: ', error);
                    }
                    isNotifyingWaitingChatQueueChat = false;
                }

            }

        }, 1000);

    }

    async onMessage(message: Message) {

        const chatId = message.chat.id;

        const audio = message.audio || message.voice;

        const hasAudio = typeof audio !== 'undefined';

        if (hasAudio) {

            if (this.runningSnapshotUsers.indexOf(chatId) != -1) {

                const message = '<b><em>Each bot subscriber can run only 1 translation at time! 🫡\n\nBot limits, sorry . . .</em></b>';

                await this.sendTextMessage(chatId, message);

                await this.resetChat(chatId);

                return;

            }

            if (typeof this.activeChats[chatId] === 'undefined') {

                this.activeChats[chatId] = { lastInteractionTimestamp: new Date().getTime() };

            } else {

                const now = new Date().getTime();
                const messageMinimumIntervalInMS = 1000 * 30;

                if (now - this.activeChats[chatId].lastInteractionTimestamp < messageMinimumIntervalInMS) {

                    const message = '<b><em>Wait at least 30 seconds to send your next audio! 🫡</em></b>';

                    await this.sendTextMessage(chatId, message);

                    return;

                }

            }

            if (this.activeChatsCount >= this.activeChatsLimit) {

                if (this.waitingChatQueue.indexOf(chatId) == -1) {

                    const message = '<b><em>Bot reached its limit of active running translations (' + this.activeChatsCount + '/' + this.activeChatsLimit + '). \n\n🥵🥵🥵🥵🥵🥵\n\nYou\'ll be notified when some running translation finish! 🫡</em></b>';

                    await this.sendTextMessage(chatId, message);

                    await this.resetChat(chatId);

                    this.waitingChatQueue.push(chatId);

                } else {

                    const message = '<b><em>Bot reached its limit of active running translations (' + this.activeChatsCount + '/' + this.activeChatsLimit + '). \n\n🥵🥵🥵🥵🥵🥵\n\nYou are already at waiting translation queue! ✅\n\nYou\'ll be notified when some running translation finish! 🫡</em></b>';

                    await this.sendTextMessage(chatId, message);

                    await this.resetChat(chatId);

                }

                return

            }

            const file_size_limit = 1020 * 1000 * 10;

            if (isNaN(Number(audio.file_size)) || Number(audio.file_size) > file_size_limit) {

                const message = '<b><em>Maximum file size is 10MB.</em></b>';

                await this.sendTextMessage(chatId, message);

                return;

            }

            try {

                this.runningSnapshotUsers.push(chatId);

                console.log('audio: ', audio);

                const fileStream = this.telegramBot.getFileStream(audio.file_id);

                const fileName = `${randomUUID()}.ogg`;

                const filePath = path.resolve(__dirname, '../../assets/' + fileName);

                const audioArrayBufferPromise = new Promise<string>((resolve, reject) => {

                    const fileWriteStream = fs.createWriteStream(filePath);

                    fileStream.pipe(fileWriteStream);

                    fileWriteStream.on('finish', () => resolve(filePath)); // Resolve with the fileName
                    fileWriteStream.on('error', (err) => reject(err));


                });

                const audioArrayBuffer = await Promise.all([audioArrayBufferPromise]);

                console.log('fileContent: ', audioArrayBuffer[0]);

                async function convertOggToMP3() {

                    return new Promise<void>((resolve, reject) => {

                        var outStream = fs.createWriteStream(audioArrayBuffer[0].replace(`.ogg`, `.mp3`));

                        fluentFfmpeg.default()
                            .input(filePath)
                            .audioQuality(96)
                            .toFormat("mp3")
                            .on('error', error => { console.log(`Encoding Error: ${error.message}`); reject(error) })
                            .on('end', () => { console.log('Audio Transcoding succeeded !'); resolve() })
                            .pipe(outStream, { end: true });

                    });

                }

                await convertOggToMP3();

                // Request translation ✅
                const speech2Text = await fetch(TRANSLATION_API_BASE_URL+'/speech-to-text', {
                    body: fs.readFileSync(filePath),
                    method: 'POST',
                    headers: {
                        'Content-Type': 'text/plain'
                    }
                });

                fs.unlinkSync(filePath.replace(`.mp3`, `.ogg`));
                fs.unlinkSync(filePath.replace(`.ogg`, `.mp3`));

                console.log(`speech2Text: `, speech2Text.status);

                if ([200, 201].includes(speech2Text.status)) {

                    const speech2TextR = await speech2Text.text();
                    console.log(`speech2Text response: `, speech2TextR);

                    const text2Speech = await fetch(TRANSLATION_API_BASE_URL+'/text-to-speech', {
                        body: speech2TextR,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'text/plain'
                        }
                    });

                    if ([200, 201].includes(text2Speech.status)) {

                        const AISpeechBody = await text2Speech.text();

                        const AISpeechBuffer = Buffer.from(AISpeechBody, 'binary');

                        await this.sendTextMessage(chatId, `<b>Translation finished! ✅</b>`);

                        await this.sendAudio(chatId, AISpeechBuffer, speech2TextR, message.message_id);

                        this.runningSnapshotUsers.splice(this.runningSnapshotUsers.indexOf(chatId), 1);

                        return;

                    } else {

                        const idx = this.runningSnapshotUsers.indexOf(chatId);
                        if (idx != -1) {
                            this.runningSnapshotUsers.splice(idx, 1);
                        }

                        await this.sendTextMessage(chatId, '<b>Could not process AI response... Please, try again later!</b>')
                        console.log(`API error: `, await text2Speech.text());

                    }

                } else {

                    const idx = this.runningSnapshotUsers.indexOf(chatId);
                    if (idx != -1) {
                        this.runningSnapshotUsers.splice(idx, 1);
                    }

                    await this.sendTextMessage(chatId, '<b>Could not process AI response... Please, try again later!</b>')
                    
                    console.log(`API error: `, await speech2Text.text());

                }
                
            } catch (error) {
                
                const idx = this.runningSnapshotUsers.indexOf(chatId);
                if (idx != -1) {
                    this.runningSnapshotUsers.splice(idx, 1);
                }
                
                await this.sendTextMessage(chatId, '<b>Could not process AI response... Please, try again later!</b>')
                throw error;

            }

        } else {

            await this.sendTextMessage(chatId, `<b>I can only process audio! Sorry.</b>`);
            return;

        }

    }

    async sendTextMessage(chatId: string | number, textMessage: string, replyToMessageId?: number | undefined, pinMessage?: boolean, parse_mode?: ParseMode | undefined) {

        let messageId = null;

        if (!parse_mode || parse_mode == null) {
            parse_mode = `HTML`;
        }

        try {

            if (!replyToMessageId || replyToMessageId == null) {

                const message = await this.telegramBot.sendMessage(chatId, textMessage, { parse_mode });

                messageId = message.message_id;

            } else {

                const message = await this.telegramBot.sendMessage(chatId, textMessage, { reply_to_message_id: replyToMessageId, parse_mode });

                messageId = message.message_id;

            }

            if (pinMessage) {
                await this.pinChatMessage(chatId, messageId);
            }

        } catch (error) {

            // log error in db?
            console.log('error to send TG text message: ', error);

        }

        return messageId;

    }

    async pinChatMessage(chatId: string | number, messageId: number) {
        try {
            const pinned = await this.telegramBot.pinChatMessage(chatId, messageId);
        } catch (error) {
            console.log('error pinning message: ', messageId, '\n', error);
        }
    }

    async sendAudio(chatId: string | number, audio: string | Stream | Buffer, transcription?: string, reply_to_message_id?: number) {

        const options: TelegramBot.SendDocumentOptions = {}

        if (transcription) {
            options.caption = transcription;
        }

        if (reply_to_message_id) {
            options.reply_to_message_id = reply_to_message_id;
        }

        const documentMsg = await this.telegramBot.sendDocument(chatId, audio, options, {
            contentType: 'audio/mp3',
            filename: 'Translation-' + randomUUID() + '.mp3'
        });

        if (documentMsg.document) {

            await this.telegramBot.sendVoice(chatId, String(documentMsg.document?.file_unique_id), {},
                { contentType: 'audio/mp3' }
            );

        }

    }

}


export default new TelegramService();