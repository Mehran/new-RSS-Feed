/**
 * Telegram Serverless entry point for bot commands.
 *
 * Telegram routes every `message` update here. Feeds, seen items and admins
 * live in this platform's SQLite database; the Worker only handles the feed
 * engine (fetch/parse/send/poll).
 */

import { api } from "sdk";
import { handleMessage } from "../lib/command.js";
import { worker } from "../lib/store.js";

export default async function (message) {
  await handleMessage(message, { api, worker });
}
