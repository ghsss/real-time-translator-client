import TelegramService from "./services/Telegram.service";

async function main(): Promise<void> {

    await TelegramService.start();
    
}

main();