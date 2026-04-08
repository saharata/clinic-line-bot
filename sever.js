const express = require("express");

const app = express();
const port = process.env.PORT || 3000;

// ใช้รับ JSON จาก LINE webhook
app.use(express.json());

// หน้าแรกไว้เช็กว่า server ตื่นอยู่
app.get("/", (req, res) => {
  res.status(200).send("Clinic LINE bot is running");
});

// LINE webhook endpoint
app.post("/line/webhook", (req, res) => {
  console.log("LINE webhook event:", JSON.stringify(req.body, null, 2));

  // ตอนเริ่มต้นตอบ 200 ไว้ก่อน เพื่อให้ LINE รู้ว่า webhook ใช้งานได้
  res.status(200).json({ ok: true });
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});