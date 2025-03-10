// وارد کردن ماژول‌های مورد نیاز
require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const Database = require('better-sqlite3');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');

// ایجاد اتصال به پایگاه داده SQLite
const db = new Database('users.db');

// ایجاد جدول‌های مورد نیاز
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    phone_number TEXT,
    first_name TEXT,
    last_name TEXT,
    username TEXT,
    registered_at TEXT,
    subscription_type TEXT,
    subscription_expiry TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    message TEXT,
    sent_at TEXT,
    is_read INTEGER DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount INTEGER,
    track_id TEXT,
    order_id TEXT,
    subscription_type TEXT,
    subscription_months INTEGER,
    status TEXT DEFAULT 'pending',
    created_at TEXT,
    updated_at TEXT
  )
`);

// تهیه statements برای استفاده مکرر
const getUserStmt = db.prepare('SELECT * FROM users WHERE user_id = ?');
const insertUserStmt = db.prepare('INSERT OR REPLACE INTO users (user_id, phone_number, first_name, last_name, username, registered_at) VALUES (?, ?, ?, ?, ?, ?)');
const updateSubscriptionStmt = db.prepare('UPDATE users SET subscription_type = ?, subscription_expiry = ? WHERE user_id = ?');
const saveMessageStmt = db.prepare('INSERT INTO messages (user_id, message, sent_at) VALUES (?, ?, ?)');
const saveTransactionStmt = db.prepare('INSERT INTO transactions (user_id, amount, track_id, order_id, subscription_type, subscription_months, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const updateTransactionStmt = db.prepare('UPDATE transactions SET status = ?, updated_at = ? WHERE track_id = ?');
const getTransactionByTrackIdStmt = db.prepare('SELECT * FROM transactions WHERE track_id = ?');

// ایجاد نمونه ربات با توکن
const bot = new Telegraf(process.env.BOT_TOKEN);

// استفاده از session با مقداردهی اولیه
bot.use(session({
  defaultSession: () => ({
    waitingForAdminMessage: false,
    selectedSubscription: null,
    replyToUser: null
  })
}));

// تابع برای فعال‌سازی اشتراک کاربر
async function activateSubscription(trackId) {
  const transaction = getTransactionByTrackIdStmt.get(trackId);
  
  if (!transaction || transaction.status === 'success') {
    return false;
  }
  
  // به‌روزرسانی وضعیت تراکنش
  updateTransactionStmt.run('success', new Date().toISOString(), trackId);
  
  // محاسبه تاریخ انقضای اشتراک
  const expiryDate = new Date();
  expiryDate.setMonth(expiryDate.getMonth() + transaction.subscription_months);
  const subscriptionExpiry = expiryDate.toISOString().split('T')[0]; // فرمت YYYY-MM-DD
  
  // به‌روزرسانی اشتراک کاربر
  updateSubscriptionStmt.run(transaction.subscription_type, subscriptionExpiry, transaction.user_id);
  
  // اطلاع‌رسانی به کاربر
  try {
    await bot.telegram.sendMessage(
      transaction.user_id,
      `🎉 تبریک! پرداخت شما با موفقیت انجام شد و اشتراک ${transaction.subscription_type} شما فعال شد.\n\nتاریخ انقضا: ${subscriptionExpiry}`
    );
  } catch (error) {
    console.error('خطا در ارسال پیام به کاربر:', error);
  }
  
  return true;
}

// ====== کد ربات تلگرام (همان کد قبلی) ======

// ... (کد قبلی ربات تلگرام)

// ====== راه‌اندازی سرور Express برای مدیریت کال‌بک زیبال ======

const app = express();
const PORT = process.env.PORT || 3000;

// پارس کردن درخواست‌های JSON
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// صفحه اصلی
app.get('/', (req, res) => {
  res.send('سرور پرداخت فعال است.');
});

// مسیر کال‌بک زیبال (GET)
app.get('/payment/callback', async (req, res) => {
  const { trackId, success, orderId } = req.query;
  
  if (!trackId) {
    return res.status(400).send('پارامتر trackId الزامی است.');
  }
  
  try {
    // بررسی وضعیت تراکنش در زیبال
    const response = await axios.post('https://gateway.zibal.ir/v1/verify', {
      merchant: process.env.ZIBAL_MERCHANT,
      trackId: trackId
    });
    
    if (response.data.result === 100) {
      // تراکنش موفق
      await activateSubscription(trackId);
      
      // هدایت کاربر به صفحه موفقیت
      return res.send(`
        <html dir="rtl">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>پرداخت موفق</title>
            <style>
              body {
                font-family: Tahoma, Arial, sans-serif;
                background-color: #f5f5f5;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
              }
              .container {
                background-color: white;
                border-radius: 10px;
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
                padding: 30px;
                text-align: center;
                max-width: 500px;
                width: 90%;
              }
              .success-icon {
                color: #4CAF50;
                font-size: 60px;
                margin-bottom: 20px;
              }
              h1 {
                color: #333;
                margin-bottom: 15px;
              }
              p {
                color: #666;
                line-height: 1.6;
              }
              .btn {
                background-color: #4CAF50;
                color: white;
                border: none;
                padding: 10px 20px;
                text-align: center;
                text-decoration: none;
                display: inline-block;
                font-size: 16px;
                margin-top: 20px;
                cursor: pointer;
                border-radius: 5px;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="success-icon">✓</div>
              <h1>پرداخت با موفقیت انجام شد</h1>
              <p>اشتراک شما با موفقیت فعال شد. می‌توانید به ربات تلگرام بازگردید و از خدمات استفاده کنید.</p>
              <a class="btn" href="https://t.me/${bot.botInfo.username}">بازگشت به ربات</a>
            </div>
          </body>
        </html>
      `);
    } else {
      // تراکنش ناموفق
      return res.send(`
        <html dir="rtl">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>خطا در پرداخت</title>
            <style>
              body {
                font-family: Tahoma, Arial, sans-serif;
                background-color: #f5f5f5;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
              }
              .container {
                background-color: white;
                border-radius: 10px;
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
                padding: 30px;
                text-align: center;
                max-width: 500px;
                width: 90%;
              }
              .error-icon {
                color: #F44336;
                font-size: 60px;
                margin-bottom: 20px;
              }
              h1 {
                color: #333;
                margin-bottom: 15px;
              }
              p {
                color: #666;
                line-height: 1.6;
              }
              .btn {
                background-color: #2196F3;
                color: white;
                border: none;
                padding: 10px 20px;
                text-align: center;
                text-decoration: none;
                display: inline-block;
                font-size: 16px;
                margin-top: 20px;
                cursor: pointer;
                border-radius: 5px;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="error-icon">✗</div>
              <h1>خطا در پرداخت</h1>
              <p>متأسفانه پرداخت شما با موفقیت انجام نشد. می‌توانید دوباره تلاش کنید.</p>
              <a class="btn" href="https://t.me/${bot.botInfo.username}">بازگشت به ربات</a>
            </div>
          </body>
        </html>
      `);
    }
  } catch (error) {
    console.error('خطا در بررسی وضعیت پرداخت:', error);
    return res.status(500).send('خطا در بررسی وضعیت پرداخت.');
  }
});

// مسیر کال‌بک زیبال (POST)
app.post('/payment/callback', async (req, res) => {
  const { trackId, success, orderId } = req.body;
  
  if (!trackId) {
    return res.status(400).json({ error: 'پارامتر trackId الزامی است.' });
  }
  
  try {
    // بررسی وضعیت تراکنش در زیبال
    const response = await axios.post('https://gateway.zibal.ir/v1/verify', {
      merchant: process.env.ZIBAL_MERCHANT,
      trackId: trackId
    });
    
    if (response.data.result === 100) {
      // تراکنش موفق
      const activated = await activateSubscription(trackId);
      return res.json({ success: true, activated });
    } else {
      // تراکنش ناموفق
      return res.json({ success: false, error: `خطای زیبال: ${response.data.result}` });
    }
  } catch (error) {
    console.error('خطا در بررسی وضعیت پرداخت:', error);
    return res.status(500).json({ error: 'خطا در بررسی وضعیت پرداخت.' });
  }
});

// راه‌اندازی همزمان ربات تلگرام و سرور Express
async function startServices() {
  try {
    // راه‌اندازی ربات تلگرام
    await bot.launch();
    console.log('ربات با موفقیت راه‌اندازی شد!');
    
    // راه‌اندازی سرور Express
    app.listen(PORT, () => {
      console.log(`سرور Express در پورت ${PORT} راه‌اندازی شد.`);
      console.log(`آدرس کال‌بک: ${process.env.CALLBACK_URL}`);
    });
  } catch (error) {
    console.error('خطا در راه‌اندازی سرویس‌ها:', error);
  }
}

// شروع سرویس‌ها
startServices();

// مدیریت خروج بدون خطا
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  db.close();
  console.log('ربات متوقف شد و اتصال به پایگاه داده بسته شد.');
  process.exit(0);
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  db.close();
  console.log('ربات متوقف شد و اتصال به پایگاه داده بسته شد.');
  process.exit(0);
});