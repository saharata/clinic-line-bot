require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

// ─── Google Sheets Config ───────────────────────────────────
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1';

// Google Service Account credentials (JSON string ใน .env)
let sheetsAuth = null;

async function getSheetsClient(writeAccess = false) {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const scopes = writeAccess
    ? ['https://www.googleapis.com/auth/spreadsheets']
    : ['https://www.googleapis.com/auth/spreadsheets.readonly'];
  const auth = new google.auth.GoogleAuth({ credentials, scopes });
  return google.sheets({ version: 'v4', auth });
}

// ─── Clinic Links ───────────────────────────────────────────
const HEALTH_FORM_URL = 'https://forms.gle/PASTE_YOUR_FORM_LINK';
const CLINIC_MAP_URL = 'https://maps.app.goo.gl/jAf7xx3wBnfdprv89';
const CLINIC_PHONE = '0654808771';

// ─── LINE Messaging Functions ───────────────────────────────

// ตอบกลับข้อความ (ใช้ replyToken)
async function replyMessage(replyToken, messages) {
  await axios.post(
    'https://api.line.me/v2/bot/message/reply',
    { replyToken, messages },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`
      }
    }
  );
}

// ส่งข้อความเชิงรุก (Push Message) โดยใช้ userId
async function pushMessage(userId, messages) {
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to: userId, messages },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`
        }
      }
    );
    console.log(`✅ Push message sent to ${userId}`);
  } catch (error) {
    console.error(`❌ Push message failed for ${userId}:`, error.response?.data || error.message);
  }
}

// ─── Google Sheets: ดึงข้อมูลนัดหมาย ───────────────────────

/**
 * อ่านข้อมูลจาก Google Sheets (FormData)
 * โครงสร้างคอลัมน์จริง:
 *   A: timestamp              B: consentStatus
 *   C: lineUserId             D: lineDisplayName
 *   E: fullName               F: hn
 *   G: phone                  H: weight
 *   I: heightCm               J: BMI
 *   K: systolic               L: diastolic
 *   M: migrainePain           N: symptoms
 *   O: nextAppointmentDate    P: nextAppointmentTime
 *   Q: appointmentNote        R: reminderOptIn
 *   S: reminderSentAt         T: reminderStatus
 */
async function getAppointments() {
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A2:T` // คอลัมน์ A ถึง T, เริ่มแถว 2 (ข้าม header)
    });

    const rows = res.data.values || [];
    return rows.map((row, index) => ({
      rowIndex: index + 2,             // แถวจริงใน sheet
      lineUserId: row[2] || '',        // C: lineUserId
      displayName: row[3] || '',       // D: lineDisplayName
      fullName: row[4] || '',          // E: fullName
      phone: row[6] || '',             // G: phone
      appointmentDate: row[14] || '',  // O: nextAppointmentDate
      appointmentTime: row[15] || '',  // P: nextAppointmentTime
      appointmentNote: row[16] || '',  // Q: appointmentNote
      reminderOptIn: row[17] || '',    // R: reminderOptIn (yes/no)
      reminderSentAt: row[18] || '',   // S: reminderSentAt
      reminderStatus: row[19] || ''    // T: reminderStatus (sent/ว่าง)
    }));
  } catch (error) {
    console.error('❌ Error reading Google Sheets:', error.message);
    return [];
  }
}

// แปลงวันที่จากหลายรูปแบบเป็น YYYY-MM-DD
function normalizeDate(dateStr) {
  if (!dateStr) return null;

  // รูปแบบ YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }

  // รูปแบบ DD/MM/YYYY
  const match = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3];
    return `${year}-${month}-${day}`;
  }

  return null;
}

// ─── ระบบแจ้งเตือนนัดหมาย ────────────────────────────────

async function sendAppointmentReminders() {
  console.log('🔔 เริ่มตรวจสอบนัดหมายสำหรับแจ้งเตือน...');

  const appointments = await getAppointments();
  if (appointments.length === 0) {
    console.log('ℹ️ ไม่พบข้อมูลนัดหมายใน Google Sheets');
    return;
  }

  // คำนวณวันพรุ่งนี้ (timezone Bangkok)
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0]; // YYYY-MM-DD

  console.log(`📅 กำลังหานัดหมายสำหรับวันที่: ${tomorrowStr}`);

  let sentCount = 0;

  for (const appt of appointments) {
    const apptDate = normalizeDate(appt.appointmentDate);

    // ข้ามถ้าไม่ใช่วันพรุ่งนี้
    if (apptDate !== tomorrowStr) continue;

    // ข้ามถ้าแจ้งเตือนไปแล้ว
    if (appt.reminderStatus === 'sent') continue;

    // ข้ามถ้าผู้ป่วยไม่ต้องการรับแจ้งเตือน
    if (appt.reminderOptIn !== 'yes') {
      console.log(`⏭️ ข้าม "${appt.fullName || appt.displayName}" - ไม่ได้เลือกรับแจ้งเตือน`);
      continue;
    }

    // ข้ามถ้าไม่มี LINE User ID
    if (!appt.lineUserId) {
      console.log(`⚠️ ข้าม "${appt.fullName || appt.displayName}" - ไม่มี LINE User ID`);
      continue;
    }

    // ใช้ชื่อที่มี: fullName > displayName > "ท่าน"
    const patientName = appt.fullName || appt.displayName || 'ท่าน';

    // สร้างข้อความแจ้งเตือน
    let reminderText =
      `🔔 แจ้งเตือนนัดหมาย - คลินิกสหวรรณ\n\n` +
      `สวัสดีครับ คุณ${patientName}\n` +
      `คุณมีนัดหมายในวันพรุ่งนี้:\n\n` +
      `📅 วันที่: ${appt.appointmentDate}\n` +
      `🕐 เวลา: ${appt.appointmentTime}\n`;

    if (appt.appointmentNote) {
      reminderText += `📋 หมายเหตุ: ${appt.appointmentNote}\n`;
    }

    reminderText +=
      `\nกรุณามาตามเวลานัดหมายครับ\n` +
      `หากต้องการเลื่อนนัด กรุณาโทร ${CLINIC_PHONE}\n` +
      `แผนที่: ${CLINIC_MAP_URL}`;

    await pushMessage(appt.lineUserId, [{ type: 'text', text: reminderText }]);

    // อัปเดตสถานะแจ้งเตือนใน Google Sheets (คอลัมน์ S และ T)
    await markNotified(appt.rowIndex);
    sentCount++;
  }

  console.log(`✅ ส่งแจ้งเตือนเสร็จสิ้น: ${sentCount} รายการ`);
}

// อัปเดตคอลัมน์ S (reminderSentAt) และ T (reminderStatus)
async function markNotified(rowIndex) {
  try {
    const sheets = await getSheetsClient(true); // writeAccess = true
    const now = new Date().toISOString();

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!S${rowIndex}:T${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[now, 'sent']] }
    });
    console.log(`📝 อัปเดตแถว ${rowIndex}: reminderSentAt=${now}, reminderStatus=sent`);
  } catch (error) {
    console.error(`❌ อัปเดตสถานะแถว ${rowIndex} ล้มเหลว:`, error.message);
  }
}

// ─── Cron Job: ตรวจสอบทุกวัน เวลา 09:00 น. (Bangkok) ──────
cron.schedule('0 9 * * *', () => {
  console.log('⏰ Cron job triggered: ตรวจสอบนัดหมาย');
  sendAppointmentReminders();
}, {
  timezone: 'Asia/Bangkok'
});

console.log('📋 Cron job ตั้งค่าแล้ว: ตรวจสอบนัดหมายทุกวัน 09:00 น. (Bangkok)');

// ─── Menu Text ──────────────────────────────────────────────

function getMenuText() {
  return (
    'สวัสดีครับ คลินิกสหวรรณ ยินดีให้บริการ\n\n' +
    'พิมพ์คำสั่งได้ดังนี้:\n' +
    '• นัดหมาย\n' +
    '• สุขภาพ\n' +
    '• ติดต่อ\n\n' +
    'ตัวอย่าง:\n' +
    '- พิมพ์ "นัดหมาย" เพื่อติดต่อเรื่องการนัด\n' +
    '- พิมพ์ "สุขภาพ" เพื่อกรอกข้อมูลสุขภาพ\n' +
    '- พิมพ์ "ติดต่อ" เพื่อดูเบอร์และแผนที่คลินิก'
  );
}

// ─── Webhook (รับข้อความจากผู้ใช้) ─────────────────────────

app.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events || [];

    for (const event of events) {
      if (event.type !== 'message' || event.message.type !== 'text') {
        continue;
      }

      const replyToken = event.replyToken;
      const userText = (event.message.text || '').trim().toLowerCase();

      if (userText === 'hello' || userText === 'hi' || userText === 'สวัสดี') {
        await replyMessage(replyToken, [{ type: 'text', text: getMenuText() }]);
        continue;
      }

      if (userText === 'นัดหมาย') {
        await replyMessage(replyToken, [
          {
            type: 'text',
            text:
              'สำหรับการนัดหมาย กรุณาส่งข้อมูลตามแบบฟอร์มนี้ครับ\n\n' +
              'ชื่อ-นามสกุล:\n' +
              'เบอร์โทร:\n' +
              'ความต้องการ: เจาะเลือด / ตรวจกับแพทย์สหรัฐ / ตรวจกับหมอเด็ก วรรณวรา\n' +
              'วันที่สะดวก:\n' +
              'เวลาที่สะดวก:\n' +
              'หมายเหตุเพิ่มเติม:\n\n' +
              'เจ้าหน้าที่จะติดต่อกลับโดยเร็วครัพ'
          }
        ]);
        continue;
      }

      if (userText === 'สุขภาพ') {
        await replyMessage(replyToken, [
          {
            type: 'text',
            text:
              'กรุณากรอกบันทึกสุขภาพได้ที่ลิงก์นี้ครับ:\n' +
              HEALTH_FORM_URL +
              '\n\nใช้เวลาไม่นาน และช่วยให้คลินิกติดตามอาการได้ดีขึ้นครับ'
          }
        ]);
        continue;
      }

      if (userText === 'ติดต่อ') {
        await replyMessage(replyToken, [
          {
            type: 'text',
            text:
              'ติดต่อคลินิกสหวรรณ\n' +
              `โทร: ${CLINIC_PHONE}\n` +
              `แผนที่: ${CLINIC_MAP_URL}\n\n` +
              'หากต้องการนัดหมาย สามารถพิมพ์ "นัดหมาย" ได้เลยครับ'
          }
        ]);
        continue;
      }

      // ข้อความอื่นๆ → แสดงเมนู
      await replyMessage(replyToken, [{ type: 'text', text: getMenuText() }]);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error.response?.data || error.message);
    res.sendStatus(200);
  }
});

// ─── Endpoint: ทดสอบส่งแจ้งเตือนด้วยมือ ────────────────────
app.get('/test-reminder', async (req, res) => {
  try {
    await sendAppointmentReminders();
    res.send('✅ ส่งแจ้งเตือนเสร็จสิ้น — ดู log เพิ่มเติมใน console');
  } catch (error) {
    console.error('Test reminder error:', error.message);
    res.status(500).send('❌ Error: ' + error.message);
  }
});

app.get('/', (req, res) => {
  res.send('LINE BOT RUNNING — Reminder system active 🔔');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
