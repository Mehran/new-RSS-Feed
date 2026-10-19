/**
 * Command routing for the Telegram Serverless layer.
 *
 * `api` (the Bot API) and `worker` (the Cloudflare client) are injected so the
 * whole routing table can be tested with fakes.
 */

import {
  formatAdmin,
  formatCheck,
  formatFeedList,
  formatRemoved,
  parseCommand,
  USAGE_TEXT,
} from "./format.js";

const ADMIN_COMMANDS = new Set(["add", "remove", "list", "check", "admin", "unadmin"]);

async function isAdmin(worker, userId) {
  if (!Number.isInteger(userId)) return false;
  const admins = await worker.getAdmins();
  return admins.includes(userId);
}

export async function handleMessage(message, { api, worker }) {
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (!text) return;

  // Never answer another bot: Telegram can deliver bot-to-bot messages, and a
  // reply loop would burn the platform's execution budget.
  if (message.from?.is_bot) return;

  const chatId = message.chat?.id;
  if (!chatId) return;

  const fromId = message.from?.id;
  const { command, args } = parseCommand(text);
  if (!command) return;

  const reply = (replyText, extra = {}) =>
    api.sendMessage({ chat_id: chatId, text: replyText, ...extra });

  try {
    if (command === "start" || command === "help") {
      return await reply(USAGE_TEXT, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    }

    if (!ADMIN_COMMANDS.has(command)) return;

    if (!(await isAdmin(worker, fromId))) {
      return await reply("⛔ You are not authorized to use this command.");
    }

    switch (command) {
      case "add": {
        if (!args) return await reply("Usage: /add <url>");
        // The Worker stores the feed and sends the confirmation + preview card.
        await worker.addFeed(args, chatId);
        return;
      }

      case "remove": {
        if (!args) return await reply("Usage: /remove <url> or /remove <index>");
        const removed = await worker.removeFeed(args, chatId);
        return await reply(formatRemoved(removed), { parse_mode: "HTML" });
      }

      case "list": {
        const feeds = await worker.listFeeds();
        if (feeds.length === 0) {
          return await reply("No feeds added. Use /add <url>.");
        }
        for (const chunk of formatFeedList(feeds)) {
          await reply(chunk, { parse_mode: "HTML", disable_web_page_preview: true });
        }
        return;
      }

      case "check": {
        await reply("🔍 Checking all feeds…");
        const summary = await worker.check(chatId);
        return await reply(formatCheck(summary));
      }

      case "admin":
      case "unadmin": {
        const userId = Number(args);
        if (!Number.isInteger(userId) || userId <= 0) {
          return await reply(`Usage: /${command} <user_id>`);
        }
        const admins = await worker.setAdmin(userId, command === "admin");
        // ADMIN_USER_ID is always unioned in by the Worker, so an env-based
        // bootstrap admin cannot be removed here. Say so instead of lying.
        if (command === "unadmin" && Array.isArray(admins) && admins.includes(userId)) {
          return await reply(
            `⚠️ <code>${userId}</code> is configured through ADMIN_USER_ID and stays an admin. Remove that Worker secret to revoke it.`,
            { parse_mode: "HTML", disable_web_page_preview: true },
          );
        }
        return await reply(formatAdmin(userId, command === "admin"), {
          parse_mode: "HTML",
        });
      }

      default:
        return;
    }
  } catch (err) {
    // Worker/Telegram failures are reported to the user; the platform logs the
    // rest. Never let a throw stop the handler without a reply.
    await reply(`⚠️ ${err?.message || "Something went wrong."}`).catch(() => {});
  }
}
