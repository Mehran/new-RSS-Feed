/**
 * Telegram Serverless entry point for bot commands.
 *
 * Telegram routes every `message` update here. All state lives in Cloudflare
 * KV behind the Worker API, so this handler is stateless.
 */

import { api } from "sdk";
import { handleMessage } from "../lib/command.js";
import { worker } from "../lib/worker-api.js";

export default async function (message) {
  await handleMessage(message, { api, worker });
}
