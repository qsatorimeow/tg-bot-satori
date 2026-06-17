import { Bot, InlineKeyboard, webhookCallback } from "npm:grammy@1.21.1";

// 1. Инициализация переменных окружения
const TG_TOKEN = Deno.env.get("TG_TOKEN");
const CATBOX_USERHASH = Deno.env.get("CATBOX_USERHASH");
const UPSTASH_REDIS_REST_URL = Deno.env.get("UPSTASH_REDIS_REST_URL");
const UPSTASH_REDIS_REST_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");

if (!TG_TOKEN || !CATBOX_USERHASH || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error("Критическая ошибка: Заданы не все Environment Variables!");
  Deno.exit(1);
}

const OWNER_ID = 8612571650;
const bot = new Bot(TG_TOKEN);
const MAIN_DOMAIN = "tg-bot-satori.qsatorimeow.deno.net";

// Глобальный перехватчик ошибок
bot.catch((err) => {
  console.error(`[Ошибка в работе бота]:`, err.error);
});

// --- Вспомогательные функции для работы с Upstash Redis ---
async function redisFetch(command: string, args: (string | number)[]) {
  const response = await fetch(`${UPSTASH_REDIS_REST_URL}/${command}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
    body: JSON.stringify(args),
  });
  const data = await response.json();
  return data.result;
}

// Проверка доступа пользователя
async function hasAccess(userId: number): Promise<boolean> {
  if (userId === OWNER_ID) return true;
  const res = await redisFetch("SISMEMBER", ["allowed_users", userId.toString()]);
  return res === 1;
}

// Функции управления доступом
async function grantAccess(userId: number) {
  await redisFetch("SADD", ["allowed_users", userId.toString()]);
}

async function revokeAccess(userId: number) {
  await redisFetch("SREM", ["allowed_users", userId.toString()]);
}

// Хранение и получение временно загружаемых фото пользователя
async function getUserPhotos(userId: number): Promise<string[]> {
  const list = await redisFetch("LRANGE", [`photos:${userId}`, 0, -1]);
  return list || [];
}

async function addUserPhoto(userId: number, fileId: string) {
  await redisFetch("RPUSH", [`photos:${userId}`, fileId]);
}

async function clearUserPhotos(userId: number) {
  await redisFetch("DEL", [`photos:${userId}`]);
}

// Сохранение и получение текущего состояния (активен ли режим /load)
async function getUserState(userId: number): Promise<string | null> {
  return await redisFetch("GET", [`state:${userId}`]);
}

async function setUserState(userId: number, state: string | null) {
  if (state === null) {
    await redisFetch("DEL", [`state:${userId}`]);
  } else {
    await redisFetch("SET", [`state:${userId}`, state]);
  }
}

// --- Функция загрузки файла на Catbox ---
async function uploadToCatbox(fileUrl: string): Promise<string> {
  const formData = new FormData();
  formData.append("reqtype", "urlupload");
  formData.append("userhash", CATBOX_USERHASH!);
  formData.append("url", fileUrl);

  const res = await fetch("https://catbox.moe", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`Ошибка Catbox API: ${res.statusText}`);
  }
  return await res.text();
}

// --- МИДЛВАРЬ: Проверка ЛС и прав доступа ---
bot.use(async (ctx, next) => {
  if (!ctx.chat || ctx.chat.type !== "private") {
    return; 
  }

  const userId = ctx.from?.id;
  if (!userId) return;

  if (ctx.message?.text === "/start") {
    await next();
    return;
  }

  const allowed = await hasAccess(userId);
  if (!allowed) {
    return; 
  }

  await next();
});

// --- КОМАНДЫ ---

// /start
bot.command("start", async (ctx) => {
  await ctx.reply(
    "Здравствуйте!\nЗаполните данную форму для получение доступа.\nhttps://google.com"
  );
});

// /help
bot.command("help", async (ctx) => {
  let helpText = "📚 *Доступные команды:*\n\n" +
    "/load — Начать загрузку фотографий\n" +
    "/id — Узнать ID пользователя (отправьте команду или перешлите сообщение пользователя)\n" +
    "/help — Показать это меню\n";

  if (ctx.from?.id === OWNER_ID) {
    helpText += "\n👑 *Админ-команды:*\n" +
      "/setaccess `ID` — Выдать доступ пользователю\n" +
      "/delaccess `ID` — Забрать доступ у пользователя\n";
  }

  await ctx.reply(helpText, { parse_mode: "Markdown" });
});

// /load
bot.command("load", async (ctx) => {
  const userId = ctx.from!.id;
  await clearUserPhotos(userId);
  await setUserState(userId, "loading_photos");

  const keyboard = new InlineKeyboard().text("✅ Готово", "done_uploading");

  await ctx.reply("Отправьте фотографии:", { reply_markup: keyboard });
});

// /setaccess (Только для владельца)
bot.command("setaccess", async (ctx) => {
  if (ctx.from!.id !== OWNER_ID) return;
  const targetId = parseInt(ctx.match.trim());

  if (isNaN(targetId)) {
    return ctx.reply("Укажите числовой Telegram ID. Пример: `/setaccess 12345678`", { parse_mode: "Markdown" });
  }

  await grantAccess(targetId);
  await ctx.reply(`Права пользователю ${targetId} успешно выданы.`);

  try {
    await bot.api.sendMessage(targetId, "Доступ выдан, напишите /help");
  } catch (_e) {
    await ctx.reply("⚠️ Доступ выдан в базе, но бот не смог написать пользователю в ЛС (возможно, он ещё не запускал бота).");
  }
});

// /delaccess (Только для владельца)
bot.command("delaccess", async (ctx) => {
  if (ctx.from!.id !== OWNER_ID) return;
  const targetId = parseInt(ctx.match.trim());

  if (isNaN(targetId)) {
    return ctx.reply("Укажите числовой Telegram ID. Пример: `/delaccess 12345678`", { parse_mode: "Markdown" });
  }

  await revokeAccess(targetId);
  await ctx.reply(`Права у пользователя ${targetId} успешно отозваны.`);
});

// /id (Улучшенная версия: выдает ваш ID или ID автора пересланного сообщения)
bot.command("id", async (ctx) => {
  if (ctx.message?.reply_to_message?.from) {
    const replyId = ctx.message.reply_to_message.from.id;
    return await ctx.reply(`Telegram ID пользователя из ответа: \`${replyId}\``, { parse_mode: "Markdown" });
  }
  
  await ctx.reply(`Ваш Telegram ID: \`${ctx.from!.id}\`\n\n💡 *Как узнать ID другого человека:* Просто перешлите сюда любое его сообщение и напишите /id в ответ на него.`, { parse_mode: "Markdown" });
});

// Логика перехвата пересланных сообщений без команды
bot.on("message", async (ctx, next) => {
  if (ctx.message?.forward_from) {
    return await ctx.reply(`ID автора пересланного сообщения: \`${ctx.message.forward_from.id}\``, { parse_mode: "Markdown" });
  }
  await next();
});

// --- ОБРАБОТКА МЕДИАФАЙЛОВ ---
bot.on("message:photo", async (ctx) => {
  const userId = ctx.from!.id;
  const state = await getUserState(userId);

  if (state !== "loading_photos") return;

  const photo = ctx.message.photo.pop()!;
  await addUserPhoto(userId, photo.file_id);
});

// --- ОБРАБОТКА КНОПКИ «ГОТОВО» ---
bot.on("callback_query:data", async (ctx) => {
  if (ctx.callbackQuery.data !== "done_uploading") return;

  const userId = ctx.from.id;
  const state = await getUserState(userId);

  if (state !== "loading_photos") {
    try {
      await ctx.answerCallbackQuery("Вы уже завершили отправку или не начинали её.");
    } catch (_e) { /* Игнорируем */ }
    return;
  }

  const photos = await getUserPhotos(userId);

  if (photos.length === 0) {
    try {
      await ctx.answerCallbackQuery("Вы не отправили ни одной фотографии!");
    } catch (_e) { /* Игнорируем */ }
    return;
  }

  try {
    await ctx.answerCallbackQuery();
  } catch (_e) { /* Игнорируем */ }
  
  await setUserState(userId, null);

  const statusMessage = await ctx.editMessageText("Загрузка...");

  try {
    const urls: string[] = [];

    for (const fileId of photos) {
      const file = await bot.api.getFile(fileId);
      const fileUrl = `https://telegram.org{TG_TOKEN}/${file.file_path}`;
      const catboxUrl = await uploadToCatbox(fileUrl);
      urls.push(catboxUrl.trim());
    }

    const chunks: string[][] = [];
    for (let i = 0; i < urls.length; i += 14) {
      chunks.push(urls.slice(i, i + 14));
    }

    let resultMessage = "✅ Готово!\n";
    chunks.forEach((chunk, index) => {
      resultMessage += `\n*Ссылка №${index + 1}*:\n`;
      chunk.forEach(link => {
        resultMessage += `${link}\n`;
      });
    });

    await bot.api.editMessageText(ctx.chat!.id, statusMessage.message_id, resultMessage, {
      parse_mode: "Markdown",
      disable_web_page_preview: true
    });

  } catch (error) {
    console.error(error);
    try {
      await bot.api.editMessageText(ctx.chat!.id, statusMessage.message_id, "❌ Произошла ошибка во время загрузки файлов на Catbox.");
    } catch (_e) { /* Игнорируем */ }
  } finally {
    await clearUserPhotos(userId);
  }
});

// --- АНТИ-СОН ---
setInterval(async () => {
  try {
    await redisFetch("PING", []);
    console.log("Пинг Upstash Redis выполнен успешно.");
  } catch (e) {
    console.error("Ошибка пинга Upstash:", e);
  }
}, 5 * 60 * 1000);

// --- ЗАПУСК НАДЕЖНОГО ВЕБ-СЕРВЕРА WEBHOOK ---
const handleUpdate = webhookCallback(bot, "std/http");
let webhookSet = false;

console.log("Бот инициализирован. Запуск открытого веб-сервера...");

Deno.serve({ port: 8000 }, async (req) => {
  // При самом первом входящем запросе жестко ставим правильный вебхук
  if (!webhookSet) {
    try {
      const targetWebhook = `https://${MAIN_DOMAIN}/webhook-routing`;
      await bot.api.setWebhook(targetWebhook, { drop_pending_updates: true });
      console.log(`[Успех] Постоянный вебхук успешно привязан к Telegram: ${targetWebhook}`);
      webhookSet = true;
    } catch (err) {
      console.error("[Ошибка] Не удалось привязать вебхук:", err);
    }
  }

  // Принимаем абсолютно любые POST-запросы от серверов Telegram без проверки путей
  if (req.method === "POST") {
    try {
      return await handleUpdate(req);
    } catch (err) {
      console.error("Ошибка обработки апдейта grammY:", err);
      return new Response("Update Error", { status: 200 }); // Всегда отдаем 200, чтобы TG не спамил запросами
    }
  }
  
