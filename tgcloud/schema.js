/**
 * The command layer is stateless: feeds, seen articles and admins all live in
 * Cloudflare KV behind the Worker API. This table is reserved for any future
 * Serverless-side state and keeps the project schema valid.
 */

import { table, text } from "sdk/db";

export const state = table("state", {
  key: text("key").primaryKey(),
  value: text("value"),
});
