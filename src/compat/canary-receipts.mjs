import fs from "node:fs";
import path from "node:path";
import { atomicJson, readJson } from "./compatibility.mjs";

export function canaryReceipt(directory, route, data) {
  if (!["/v1/ack", "/v1/message", "/v1/reply"].includes(route)) return null;
  const id = route === "/v1/message" ? data.id : data.messageId;
  const match =
    /^canary-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})-([123])$/.exec(
      id,
    );
  if (!match) return null;
  const folder = path.join(directory, "canary", match[1]),
    file = path.join(folder, match[2] + ".json");
  const row = readJson(file, null);
  if (!row) return null;
  if (
    row.id !== id ||
    Date.now() >= row.expiresAt ||
    !fs.existsSync(path.join(folder, "open"))
  )
    throw Error("Validation channel closed");
  if (route === "/v1/message") return { message: row };
  if (data.from?.app !== row.to.app || data.from.threadId !== row.to.threadId)
    throw Error("Only the addressed validation chat can acknowledge or reply");
  if (route === "/v1/ack") row.acknowledgedAt ??= new Date().toISOString();
  else {
    if (!row.acknowledgedAt || !row.expectReply || data.text !== row.expected)
      throw Error("Validation reply does not match the acknowledged challenge");
    row.repliedAt ??= new Date().toISOString();
    row.replyText = data.text;
  }
  atomicJson(file, row);
  return {
    accepted: true,
    messageId: id,
    acknowledgedAt: row.acknowledgedAt,
    repliedAt: row.repliedAt,
  };
}
