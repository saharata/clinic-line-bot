import crypto from "crypto";
import express from "express";

const app = express();
const port = process.env.PORT || 3000;
const channelSecret = process.env.LINE_CHANNEL_SECRET;
const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

if (!channelSecret || !channelAccessToken) {
  console.warn("Missing LINE_CHANNEL_SECRET or LINE_CHANNEL_ACCESS_TOKEN");
}

app.get("/", (req, res) => {
  res.status(200).send("LINE bot is running");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.get("x-line-signature") || "";
      const bodyBuffer = req.body;
      const bodyText = bodyBuffer.toString("utf8");

      if (!verifySignature(bodyText, signature, channelSecret)) {
        return res.status(401).send("Invalid signature");
      }

      const body = JSON.parse(bodyText);
      const events = body.events || [];

      await Promise.all(events.map(handleEvent));
      res.status(200).send("OK");
    } catch (error) {
      console.error("webhook error", error);
      res.status(500).send("Internal Server Error");
    }
  }
);

async function handleEvent(event) {
  if (event.type !== "message") return;
  if (event.message?.type !== "text") return;
  if (!event.replyToken) return;

  const userText = event.message.text?.trim() || "";
  const replyText = buildReply(userText);

  await replyMessage(event.replyToken, replyText);
}

function buildReply(userText) {
  if (!userText) return "ส่งข้อความมาได้เลย";

  return `ได้รับข้อความแล้ว: ${userText}`;
}

function verifySignature(body, signature, secret) {
  if (!secret || !signature) return false;

  const digest = crypto
    .createHmac("SHA256", secret)
    .update(body)
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(signature)
  );
}

async function replyMessage(replyToken, text) {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${channelAccessToken}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [
        {
          type: "text",
          text,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LINE reply failed: ${response.status} ${errorText}`);
  }
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
