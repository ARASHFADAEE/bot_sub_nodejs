// وارد کردن ماژول‌های مورد نیاز
require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const { HttpsProxyAgent } = require('https-proxy-agent');

// تنظیم log های اولیه
console.log('شروع اجرای برنامه...');
console.log('متغیرهای محیطی بارگذاری شدند:', {
  BOT_TOKEN: process.env.BOT_TOKEN ? (process.env.BOT_TOKEN.substring(0, 10) + '...') : 'تنظیم نشده',
  ADMIN_ID: process.env.ADMIN_ID || 'تنظیم نشده',
  ZIBAL_MERCHANT: process.env.ZIBAL_MERCHANT || 'تنظیم نشده',
  CALLBACK_URL: process.env.CALLBACK_URL || 'تنظیم نشده',
  PORT: process.env.PORT || '3000'
});

// ایجاد اتصال به پایگاه داده SQLite
console.log('در حال اتصال به پایگاه داده...');
const db = new sqlite3.Database('users.db', (err) => {
  if (err) {
    console.error('خطا در اتصال به پایگاه داده:', err);
  } else {
    console.log('اتصال به پایگاه داده با موفقیت برقرار شد.');
  }
});

// ایجاد جدول‌های مورد نیاز
console.log('در حال ایجاد جداول پایگاه داده...');
db.serialize(() => {
  db.run(`
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
  
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      message TEXT,
      sent_at TEXT,
      is_read INTEGER DEFAULT 0
    )
  `);
  
  db.run(`
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
  
  console.log('جداول پایگاه داده با موفقیت ایجاد شدند.');
});

// تعریف توابع دسترسی به دیتابیس
async function getUser(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE user_id = ?', [userId], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function insertUser(userId, phoneNumber, firstName, lastName, username, registeredAt) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR REPLACE INTO users (user_id, phone_number, first_name, last_name, username, registered_at) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, phoneNumber, firstName, lastName, username, registeredAt],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

async function updateSubscription(subscriptionType, subscriptionExpiry, userId) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET subscription_type = ?, subscription_expiry = ? WHERE user_id = ?',
      [subscriptionType, subscriptionExpiry, userId],
      function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

async function saveMessage(userId, message, sentAt) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO messages (user_id, message, sent_at) VALUES (?, ?, ?)',
      [userId, message, sentAt],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

async function saveTransaction(userId, amount, trackId, orderId, subscriptionType, subscriptionMonths, createdAt, updatedAt) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO transactions (user_id, amount, track_id, order_id, subscription_type, subscription_months, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, amount, trackId, orderId, subscriptionType, subscriptionMonths, createdAt, updatedAt],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

async function updateTransaction(status, updatedAt, trackId) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE transactions SET status = ?, updated_at = ? WHERE track_id = ?',
      [status, updatedAt, trackId],
      function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

async function getTransactionByTrackId(trackId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM transactions WHERE track_id = ?', [trackId], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// تنظیم پروکسی برای اتصال به API تلگرام (اختیاری - در صورت نیاز فعال کنید)
// const agent = new HttpsProxyAgent('http://127.0.0.1:8080'); // آدرس و پورت پروکسی خود را وارد کنید

// ایجاد نمونه ربات با توکن
console.log('در حال ایجاد نمونه ربات تلگرام...');
const bot = new Telegraf(process.env.BOT_TOKEN || '7677217623:AAF9xefFfomTQ0BtQS20VbhtPM6fbWuVUvw', {
  // اگر به پروکسی نیاز دارید، خط زیر را از حالت کامنت خارج کنید
  // telegram: { agent }
});

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
  console.log(`در حال فعال‌سازی اشتراک برای trackId: ${trackId}...`);
  const transaction = await getTransactionByTrackId(trackId);
  
  if (!transaction || transaction.status === 'success') {
    console.log('تراکنش یافت نشد یا قبلاً تایید شده است.');
    return false;
  }
  
  // به‌روزرسانی وضعیت تراکنش
  await updateTransaction('success', new Date().toISOString(), trackId);
  
  // محاسبه تاریخ انقضای اشتراک
  const expiryDate = new Date();
  expiryDate.setMonth(expiryDate.getMonth() + transaction.subscription_months);
  const subscriptionExpiry = expiryDate.toISOString().split('T')[0]; // فرمت YYYY-MM-DD
  
  // به‌روزرسانی اشتراک کاربر
  await updateSubscription(transaction.subscription_type, subscriptionExpiry, transaction.user_id);
  
  // اطلاع‌رسانی به کاربر
  try {
    await bot.telegram.sendMessage(
      transaction.user_id,
      `🎉 تبریک! پرداخت شما با موفقیت انجام شد و اشتراک ${transaction.subscription_type} شما فعال شد.\n\nتاریخ انقضا: ${subscriptionExpiry}`
    );
    console.log(`پیام تایید پرداخت به کاربر ${transaction.user_id} ارسال شد.`);
  } catch (error) {
    console.error('خطا در ارسال پیام به کاربر:', error);
  }
  
  console.log(`اشتراک برای کاربر ${transaction.user_id} با موفقیت فعال شد.`);
  return true;
}

// تعریف دستور /start
bot.start(async (ctx) => {
  console.log(`دستور /start از کاربر ${ctx.from.id} دریافت شد.`);
  const userId = ctx.from.id;
  
  // بررسی اینکه آیا کاربر قبلاً در پایگاه داده وجود دارد
  const user = await getUser(userId);
  
  if (user && user.phone_number) {
    // کاربر قبلاً احراز هویت شده است
    console.log(`کاربر ${userId} قبلاً ثبت‌نام کرده است.`);
    return showMainMenu(ctx);
  }
  
  // درخواست شماره تلفن از کاربر
  console.log(`درخواست شماره تلفن از کاربر ${userId}...`);
  ctx.reply('به ربات ما خوش آمدید! 🤖\n\nبرای استفاده از خدمات ربات، لطفاً شماره تلفن خود را به اشتراک بگذارید.',
    Markup.keyboard([
      [Markup.button.contactRequest('ارسال شماره تلفن 📱')]
    ]).resize().oneTime()
  );
});

// دستور مخصوص ادمین
bot.command('admin', async (ctx) => {
  const userId = ctx.from.id;
  const adminId = process.env.ADMIN_ID;
  
  console.log(`دستور /admin از کاربر ${userId} دریافت شد.`);
  
  // بررسی اینکه آیا کاربر ادمین است
  if (userId.toString() === adminId) {
    console.log('دسترسی ادمین تایید شد.');
    await ctx.reply('پنل مدیریت ادمین:', 
      Markup.inlineKeyboard([
        [Markup.button.callback('گزارش کاربران 👥', 'admin_users')],
        [Markup.button.callback('پیام‌های دریافتی 📨', 'admin_messages')],
        [Markup.button.callback('گزارش تراکنش‌ها 💰', 'admin_transactions')]
      ])
    );
  } else {
    console.log('دسترسی ادمین رد شد.');
    await ctx.reply('شما دسترسی به این بخش را ندارید.');
  }
});

// پاسخ به دکمه‌های پنل ادمین
bot.action('admin_users', async (ctx) => {
  const userId = ctx.from.id;
  const adminId = process.env.ADMIN_ID;
  
  if (userId.toString() !== adminId) {
    await ctx.answerCbQuery('شما دسترسی به این بخش را ندارید.');
    return;
  }
  
  await ctx.answerCbQuery();
  
  console.log('درخواست گزارش کاربران از ادمین دریافت شد.');
  
  // دریافت تعداد کاربران
  const userCountPromise = new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM users', [], (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
  
  // دریافت تعداد کاربران با اشتراک فعال
  const activeSubsPromise = new Promise((resolve, reject) => {
    db.get("SELECT COUNT(*) as count FROM users WHERE subscription_expiry >= date('now')", [], (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
  
  try {
    const userCount = await userCountPromise;
    const activeSubsCount = await activeSubsPromise;
    
    await ctx.reply(`📊 گزارش کاربران:\n\n👥 تعداد کل کاربران: ${userCount}\n✅ اشتراک‌های فعال: ${activeSubsCount}`);
  } catch (error) {
    console.error('خطا در دریافت گزارش کاربران:', error);
    await ctx.reply('خطا در دریافت اطلاعات کاربران.');
  }
});

bot.action('admin_messages', async (ctx) => {
  const userId = ctx.from.id;
  const adminId = process.env.ADMIN_ID;
  
  if (userId.toString() !== adminId) {
    await ctx.answerCbQuery('شما دسترسی به این بخش را ندارید.');
    return;
  }
  
  await ctx.answerCbQuery();
  
  console.log('درخواست مشاهده پیام‌های دریافتی از ادمین دریافت شد.');
  
  // دریافت پیام‌های خوانده نشده
  const unreadMessagesPromise = new Promise((resolve, reject) => {
    db.all(`
      SELECT m.*, u.first_name, u.last_name, u.username, u.phone_number
      FROM messages m
      JOIN users u ON m.user_id = u.user_id
      WHERE m.is_read = 0
      ORDER BY m.sent_at DESC
      LIMIT 10
    `, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
  
  try {
    const unreadMessages = await unreadMessagesPromise;
    
    if (unreadMessages.length === 0) {
      await ctx.reply('پیام خوانده نشده‌ای وجود ندارد.');
      return;
    }
    
    for (const msg of unreadMessages) {
      const userName = `${msg.first_name} ${msg.last_name || ''}`.trim();
      const userInfo = `👤 ${userName} ${msg.username ? `(@${msg.username})` : ''}\n📱 ${msg.phone_number}\n🆔 ${msg.user_id}`;
      
      await ctx.reply(`📨 پیام جدید:\n\n${userInfo}\n\n💬 ${msg.message}\n\n📅 ${new Date(msg.sent_at).toLocaleString('fa-IR')}`, 
        Markup.inlineKeyboard([
          [Markup.button.callback(`علامت‌گذاری به عنوان خوانده شده ✓`, `read_msg_${msg.id}`)],
          [Markup.button.callback(`پاسخ به کاربر ↩️`, `reply_user_${msg.user_id}`)]
        ])
      );
    }
  } catch (error) {
    console.error('خطا در دریافت پیام‌های خوانده نشده:', error);
    await ctx.reply('خطا در دریافت پیام‌های خوانده نشده.');
  }
});

bot.action(/^read_msg_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const adminId = process.env.ADMIN_ID;
  
  if (userId.toString() !== adminId) {
    await ctx.answerCbQuery('شما دسترسی به این بخش را ندارید.');
    return;
  }
  
  const messageId = ctx.match[1];
  console.log(`درخواست علامت‌گذاری پیام ${messageId} به عنوان خوانده شده.`);
  
  // علامت‌گذاری پیام به عنوان خوانده شده
  const markAsReadPromise = new Promise((resolve, reject) => {
    db.run('UPDATE messages SET is_read = 1 WHERE id = ?', [messageId], function(err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
  
  try {
    await markAsReadPromise;
    await ctx.answerCbQuery('پیام به عنوان خوانده شده علامت‌گذاری شد.');
    await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([
      [Markup.button.callback(`خوانده شده ✓`, `noop`)]
    ]));
  } catch (error) {
    console.error('خطا در علامت‌گذاری پیام:', error);
    await ctx.answerCbQuery('خطا در علامت‌گذاری پیام.');
  }
});

bot.action(/^reply_user_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const adminId = process.env.ADMIN_ID;
  
  if (userId.toString() !== adminId) {
    await ctx.answerCbQuery('شما دسترسی به این بخش را ندارید.');
    return;
  }
  
  const targetUserId = ctx.match[1];
  console.log(`ادمین در حال پاسخ به کاربر ${targetUserId}...`);
  
  // تنظیم حالت پاسخ به کاربر
  ctx.session.replyToUser = targetUserId;
  
  await ctx.answerCbQuery();
  await ctx.reply(`لطفاً پیام خود را برای کاربر با آیدی ${targetUserId} بنویسید:`);
});

bot.action('admin_transactions', async (ctx) => {
  const userId = ctx.from.id;
  const adminId = process.env.ADMIN_ID;
  
  if (userId.toString() !== adminId) {
    await ctx.answerCbQuery('شما دسترسی به این بخش را ندارید.');
    return;
  }
  
  await ctx.answerCbQuery();
  
  console.log('درخواست گزارش تراکنش‌ها از ادمین دریافت شد.');
  
  // دریافت آمار تراکنش‌ها
  const totalTransactionsPromise = new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count, SUM(amount) as total FROM transactions WHERE status = "success"', [], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
  
  const todayTransactionsPromise = new Promise((resolve, reject) => {
    db.get(`
      SELECT COUNT(*) as count, SUM(amount) as total 
      FROM transactions 
      WHERE status = "success" AND date(created_at) = date('now')
    `, [], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
  
  try {
    const totalTransactions = await totalTransactionsPromise;
    const todayTransactions = await todayTransactionsPromise;
    
    await ctx.reply(`📊 گزارش تراکنش‌ها:\n\n💰 مجموع تراکنش‌ها: ${totalTransactions.total?.toLocaleString() || 0} تومان\n🔢 تعداد تراکنش‌ها: ${totalTransactions.count}\n\n📅 امروز:\n💰 مبلغ: ${todayTransactions.total?.toLocaleString() || 0} تومان\n🔢 تعداد: ${todayTransactions.count}`);
  } catch (error) {
    console.error('خطا در دریافت گزارش تراکنش‌ها:', error);
    await ctx.reply('خطا در دریافت گزارش تراکنش‌ها.');
  }
});

// دریافت شماره تلفن کاربر
bot.on('contact', async (ctx) => {
  console.log(`اطلاعات تماس از کاربر ${ctx.from.id} دریافت شد.`);
  
  // بررسی اینکه آیا شماره تلفن متعلق به همین کاربر است
  if(ctx.message.contact.user_id === ctx.from.id) {
    const userId = ctx.from.id;
    const phoneNumber = ctx.message.contact.phone_number;
    const firstName = ctx.from.first_name || '';
    const lastName = ctx.from.last_name || '';
    const username = ctx.from.username || '';
    const registeredAt = new Date().toISOString();
    
    // ذخیره اطلاعات کاربر در پایگاه داده
    try {
      await insertUser(userId, phoneNumber, firstName, lastName, username, registeredAt);
      console.log(`اطلاعات کاربر ${userId} با موفقیت در پایگاه داده ذخیره شد.`);
      
      // تایید ثبت شماره تلفن
      await ctx.reply(`ممنون از شما ${firstName}! شماره تلفن شما با موفقیت ثبت شد. ✅`);
      
      // نمایش منوی اصلی
      showMainMenu(ctx);
    } catch (error) {
      console.error('خطا در ذخیره اطلاعات کاربر:', error);
      await ctx.reply('متأسفانه خطایی در ثبت اطلاعات شما رخ داد. لطفاً دوباره تلاش کنید.');
    }
  } else {
    ctx.reply('لطفاً شماره تلفن خود را به اشتراک بگذارید، نه شماره دیگران را.');
  }
});

// تابع نمایش منوی اصلی
async function showMainMenu(ctx) {
  console.log(`نمایش منوی اصلی برای کاربر ${ctx.from.id}...`);
  
  await ctx.reply('منوی اصلی:', 
    Markup.keyboard([
      ['منوی اصلی 🏠']
    ]).resize()
  );
  
  // دریافت اطلاعات اشتراک کاربر
  const userId = ctx.from.id;
  
  try {
    const user = await getUser(userId);
    
    let subscriptionInfo = '';
    if (user && user.subscription_type) {
      // بررسی اعتبار اشتراک
      const today = new Date().toISOString().split('T')[0];
      const isActive = user.subscription_expiry >= today;
      
      subscriptionInfo = `\n\nاشتراک فعلی شما: ${user.subscription_type}`;
      if (user.subscription_expiry) {
        subscriptionInfo += `\nتاریخ انقضا: ${user.subscription_expiry}`;
        subscriptionInfo += isActive ? ' (فعال ✅)' : ' (منقضی شده ❌)';
      }
    }
    
    await ctx.reply(`لطفاً یکی از گزینه‌های زیر را انتخاب کنید:${subscriptionInfo}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('خرید اشتراک 💳', 'buy_subscription')],
        [Markup.button.callback('ارتباط با ادمین 👨‍💼', 'contact_admin')]
      ])
    );
  } catch (error) {
    console.error('خطا در دریافت اطلاعات کاربر:', error);
    await ctx.reply('متأسفانه خطایی در نمایش منو رخ داد. لطفاً دوباره تلاش کنید.');
  }
}

// پاسخ به دکمه‌های callback
bot.action('buy_subscription', async (ctx) => {
  await ctx.answerCbQuery();
  console.log(`کاربر ${ctx.from.id} وارد بخش خرید اشتراک شد.`);
  
  await ctx.reply('به بخش خرید اشتراک خوش آمدید! 💳\n\nلیست اشتراک‌های موجود:');
  
  // نمایش لیست اشتراک‌ها با قیمت‌های جدید
  await ctx.reply('🔹 اشتراک یک ماهه: ۴۰۰,۰۰۰ تومان\n🔸 اشتراک سه ماهه: ۱,۲۰۰,۰۰۰ تومان',
    Markup.inlineKeyboard([
      [Markup.button.callback('اشتراک یک ماهه 🔹', 'sub_one_month')],
      [Markup.button.callback('اشتراک سه ماهه 🔸', 'sub_three_month')],
      [Markup.button.callback('بازگشت به منوی اصلی 🔙', 'back_to_main')]
    ])
  );
});

bot.action('contact_admin', async (ctx) => {
  await ctx.answerCbQuery();
  console.log(`کاربر ${ctx.from.id} وارد بخش ارتباط با ادمین شد.`);
  
  await ctx.reply('برای ارتباط با پشتیبانی می‌توانید از طریق آیدی زیر اقدام کنید:\n\n👨‍💼 @AdminUsername\n\nیا می‌توانید پیام خود را همینجا تایپ کنید تا به دست ادمین برسانیم.');
  
  // تنظیم وضعیت کاربر برای دریافت پیام به ادمین
  ctx.session.waitingForAdminMessage = true;
  
  await ctx.reply('لطفاً پیام خود را بنویسید یا روی دکمه زیر کلیک کنید:',
    Markup.inlineKeyboard([
      [Markup.button.callback('بازگشت به منوی اصلی 🔙', 'back_to_main')]
    ])
  );
});

// بازگشت به منوی اصلی
bot.action('back_to_main', async (ctx) => {
  await ctx.answerCbQuery();
  console.log(`کاربر ${ctx.from.id} به منوی اصلی بازگشت.`);
  
  ctx.session.waitingForAdminMessage = false;
  showMainMenu(ctx);
});

// پاسخ به انتخاب اشتراک‌ها
bot.action(['sub_one_month', 'sub_three_month'], async (ctx) => {
  await ctx.answerCbQuery();
  
  let planName = '';
  let price = 0;
  let months = 0;
  
  switch(ctx.match[0]) {
    case 'sub_one_month':
      planName = 'یک ماهه';
      price = 400000;
      months = 1;
      break;
    case 'sub_three_month':
      planName = 'سه ماهه';
      price = 1200000;
      months = 3;
      break;
  }
  
  console.log(`کاربر ${ctx.from.id} اشتراک ${planName} را انتخاب کرد.`);
  
  // ذخیره اطلاعات اشتراک انتخابی در session
  ctx.session.selectedSubscription = {
    type: planName,
    price: price,
    months: months
  };
  
  // ایجاد یک شناسه سفارش منحصر به فرد
  const orderId = `order_${Date.now()}_${ctx.from.id}`;
  
  try {
    console.log(`در حال ارسال درخواست به درگاه زیبال برای کاربر ${ctx.from.id}...`);
    // درخواست ایجاد تراکنش به زیبال
    const response = await axios.post('https://gateway.zibal.ir/v1/request', {
      merchant: process.env.ZIBAL_MERCHANT,
      amount: price,  // مبلغ به تومان
      callbackUrl: process.env.CALLBACK_URL,
      orderId: orderId,
      description: `خرید اشتراک ${planName}`
    });
    
    console.log(`پاسخ زیبال دریافت شد:`, response.data);
    
    if (response.data.result === 100) {
      const trackId = response.data.trackId;
      
      // ذخیره اطلاعات تراکنش در پایگاه داده
      const now = new Date().toISOString();
      await saveTransaction(
        ctx.from.id,
        price,
        trackId,
        orderId,
        planName,
        months,
        now,
        now
      );
      
      // ساخت لینک پرداخت
      const paymentUrl = `https://gateway.zibal.ir/start/${trackId}`;
      
      console.log(`لینک پرداخت برای کاربر ${ctx.from.id} ایجاد شد: ${paymentUrl}`);
      
      await ctx.reply(`شما اشتراک ${planName} به مبلغ ${price.toLocaleString()} تومان را انتخاب کرده‌اید.\n\nبرای پرداخت و فعال‌سازی اشتراک، لطفاً روی دکمه زیر کلیک کنید:`,
        Markup.inlineKeyboard([
          [Markup.button.url('پرداخت آنلاین 💰', paymentUrl)],
          [Markup.button.callback('بررسی وضعیت پرداخت 🔄', `check_payment_${trackId}`)],
          [Markup.button.callback('بازگشت به لیست اشتراک‌ها 🔙', 'buy_subscription')]
        ])
      );
    } else {
      console.log(`خطا در ایجاد لینک پرداخت برای کاربر ${ctx.from.id}: ${response.data.result}`);
      await ctx.reply(`متأسفانه خطایی در ایجاد لینک پرداخت رخ داد. لطفاً دوباره تلاش کنید.\n\nکد خطا: ${response.data.result}`);
    }
  } catch (error) {
    console.error('خطا در ارتباط با درگاه پرداخت:', error);
    await ctx.reply('متأسفانه خطایی در ارتباط با درگاه پرداخت رخ داد. لطفاً دوباره تلاش کنید.');
  }
});

// بررسی وضعیت پرداخت
bot.action(/^check_payment_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const trackId = ctx.match[1];
  console.log(`کاربر ${ctx.from.id} در حال بررسی وضعیت پرداخت با trackId: ${trackId}`);
  
  try {
    // بررسی وضعیت تراکنش در زیبال
    console.log(`ارسال درخواست بررسی وضعیت به زیبال برای trackId: ${trackId}...`);
    const response = await axios.post('https://gateway.zibal.ir/v1/verify', {
      merchant: process.env.ZIBAL_MERCHANT,
      trackId: trackId
    });
    
    console.log(`پاسخ بررسی وضعیت از زیبال دریافت شد:`, response.data);
    
    if (response.data.result === 100) {
      // تراکنش موفق
      console.log(`تراکنش ${trackId} موفق بود. در حال فعال‌سازی اشتراک...`);
      const transaction = await getTransactionByTrackId(trackId);
      
      if (!transaction) {
        await ctx.reply('تراکنشی با این شناسه یافت نشد.');
        return;
      }
      
      if (transaction.status === 'success') {
        await ctx.reply('این تراکنش قبلاً تایید شده و اشتراک شما فعال است.');
        return;
      }
      
      // به‌روزرسانی وضعیت تراکنش
      await updateTransaction('success', new Date().toISOString(), trackId);
      
      // محاسبه تاریخ انقضای اشتراک
      const expiryDate = new Date();
      expiryDate.setMonth(expiryDate.getMonth() + transaction.subscription_months);
      const subscriptionExpiry = expiryDate.toISOString().split('T')[0]; // فرمت YYYY-MM-DD
      
      // به‌روزرسانی اشتراک کاربر
      await updateSubscription(transaction.subscription_type, subscriptionExpiry, transaction.user_id);
      
      console.log(`اشتراک برای کاربر ${transaction.user_id} با موفقیت فعال شد.`);
      
      await ctx.reply(`🎉 تبریک! پرداخت شما با موفقیت انجام شد و اشتراک ${transaction.subscription_type} شما فعال شد.\n\nتاریخ انقضا: ${subscriptionExpiry}`);
      
      // بازگشت به منوی اصلی
      showMainMenu(ctx);
    } else if (response.data.result === 201) {
      // تراکنش قبلاً تایید شده است
      console.log(`تراکنش ${trackId} قبلاً تایید شده است.`);
      await ctx.reply('این تراکنش قبلاً تایید شده و اشتراک شما فعال است.');
    } else if (response.data.result === 202) {
      // تراکنش ناموفق
      console.log(`تراکنش ${trackId} هنوز انجام نشده است.`);
      await ctx.reply('پرداخت هنوز انجام نشده است. لطفاً ابتدا پرداخت را انجام دهید.');
    } else {
      console.log(`خطا در بررسی وضعیت تراکنش ${trackId}: ${response.data.result}`);
      await ctx.reply(`متأسفانه خطایی در بررسی وضعیت پرداخت رخ داد. لطفاً دوباره تلاش کنید.\n\nکد خطا: ${response.data.result}`);
    }
  } catch (error) {
    console.error('خطا در بررسی وضعیت پرداخت:', error);
    await ctx.reply('متأسفانه خطایی در بررسی وضعیت پرداخت رخ داد. لطفاً دوباره تلاش کنید.');
  }
});

// پاسخ به دکمه noop (بدون عملکرد)
bot.action('noop', async (ctx) => {
  await ctx.answerCbQuery();
});

// مدیریت خطاها
bot.catch((err, ctx) => {
  console.error('خطای ربات:', err);
  ctx.reply('متأسفانه خطایی رخ داد. لطفاً دوباره تلاش کنید یا با ادمین تماس بگیرید.');
});

// دریافت پیام متنی برای ارسال به ادمین یا پاسخ ادمین به کاربر
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const adminId = process.env.ADMIN_ID;
  
  // اگر ادمین در حال پاسخ به یک کاربر است
  if (userId.toString() === adminId && ctx.session && ctx.session.replyToUser) {
    const targetUserId = ctx.session.replyToUser;
    const message = ctx.message.text;
    
    console.log(`ادمین در حال ارسال پاسخ به کاربر ${targetUserId}...`);
    
    try {
      // ارسال پیام ادمین به کاربر
      await bot.telegram.sendMessage(targetUserId, `📨 پیام از پشتیبانی:\n\n${message}`);
      await ctx.reply(`✅ پیام شما با موفقیت به کاربر ارسال شد.`);
      console.log(`پاسخ ادمین به کاربر ${targetUserId} با موفقیت ارسال شد.`);
    } catch (error) {
      console.error('خطا در ارسال پیام به کاربر:', error);
      await ctx.reply('متأسفانه خطایی در ارسال پیام به کاربر رخ داد.');
    }
    
    // پاک کردن حالت پاسخ به کاربر
    ctx.session.replyToUser = null;
    return;
  }
  
  // اگر کاربر در حالت ارسال پیام به ادمین است
  if (ctx.session && ctx.session.waitingForAdminMessage) {
    // ذخیره پیام در دیتابیس
    const message = ctx.message.text;
    const sentAt = new Date().toISOString();
    
    console.log(`دریافت پیام برای ادمین از کاربر ${userId}...`);
    
    try {
      await saveMessage(userId, message, sentAt);
      
      // ارسال پیام به ادمین (اگر آیدی ادمین تنظیم شده باشد)
      if (adminId) {
        try {
          await bot.telegram.sendMessage(adminId, 
            `📨 پیام جدید از کاربر:\n\nنام: ${ctx.from.first_name} ${ctx.from.last_name || ''}\nیوزرنیم: @${ctx.from.username || 'ندارد'}\nآیدی: ${ctx.from.id}\n\nمتن پیام:\n${message}`,
            Markup.inlineKeyboard([
              [Markup.button.callback(`پاسخ به کاربر ↩️`, `reply_user_${userId}`)]
            ])
          );
          console.log(`پیام کاربر ${userId} به ادمین ارسال شد.`);
        } catch (error) {
          console.error('خطا در ارسال پیام به ادمین:', error);
        }
      }
      
      ctx.reply('پیام شما با موفقیت به ادمین ارسال شد. ✅\nدر اسرع وقت با شما تماس خواهیم گرفت.');
      
      // خارج کردن کاربر از حالت انتظار برای پیام ادمین
      ctx.session.waitingForAdminMessage = false;
      
      // بازگشت به منوی اصلی
      showMainMenu(ctx);
    } catch (error) {
      console.error('خطا در ذخیره پیام:', error);
      await ctx.reply('متأسفانه خطایی در ارسال پیام به ادمین رخ داد. لطفاً دوباره تلاش کنید.');
    }
    return;
  }
  
  // پاسخ به کلمه "منوی اصلی"
  if (ctx.message.text === 'منوی اصلی 🏠') {
    console.log(`کاربر ${userId} درخواست منوی اصلی کرده است.`);
    showMainMenu(ctx);
    return;
  }
  
  // بررسی اینکه آیا کاربر در پایگاه داده وجود دارد
  try {
    const user = await getUser(userId);
    
    // اگر کاربر هنوز احراز هویت نشده است
    if (!user || !user.phone_number) {
      ctx.reply('لطفاً ابتدا با استفاده از دستور /start ثبت‌نام کنید.');
      return;
    }
    
    // پاسخ پیش‌فرض به سایر پیام‌ها
    ctx.reply('دستور نامشخص. لطفاً از منوی زیر استفاده کنید:');
    showMainMenu(ctx);
  } catch (error) {
    console.error('خطا در بررسی اطلاعات کاربر:', error);
    ctx.reply('متأسفانه خطایی رخ داد. لطفاً دوباره تلاش کنید.');
  }
});

// ====== راه‌اندازی سرور Express برای مدیریت کال‌بک زیبال ======

const app = express();
const PORT = process.env.PORT || 3000;
let botUsername = '';

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
  
  console.log(`درخواست کال‌بک GET از زیبال دریافت شد:`, req.query);
  
  if (!trackId) {
    console.log('خطا: پارامتر trackId در درخواست کال‌بک یافت نشد.');
    return res.status(400).send('پارامتر trackId الزامی است.');
  }
  
  try {
    // بررسی وضعیت تراکنش در زیبال
    console.log(`بررسی وضعیت تراکنش ${trackId} در زیبال...`);
    const response = await axios.post('https://gateway.zibal.ir/v1/verify', {
      merchant: process.env.ZIBAL_MERCHANT,
      trackId: trackId
    });
    
    console.log(`پاسخ بررسی وضعیت از زیبال:`, response.data);
    
    if (response.data.result === 100) {
      // تراکنش موفق
      console.log(`تراکنش ${trackId} موفق بود. در حال فعال‌سازی اشتراک...`);
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
              <a class="btn" href="https://t.me/${botUsername}">بازگشت به ربات</a>
            </div>
          </body>
        </html>
      `);
    } else {
      // تراکنش ناموفق
      console.log(`تراکنش ${trackId} ناموفق بود. کد خطا: ${response.data.result}`);
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
              <a class="btn" href="https://t.me/${botUsername}">بازگشت به ربات</a>
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
  
  console.log(`درخواست کال‌بک POST از زیبال دریافت شد:`, req.body);
  
  if (!trackId) {
    console.log('خطا: پارامتر trackId در درخواست کال‌بک یافت نشد.');
    return res.status(400).json({ error: 'پارامتر trackId الزامی است.' });
  }
  
  try {
    // بررسی وضعیت تراکنش در زیبال
    console.log(`بررسی وضعیت تراکنش ${trackId} در زیبال...`);
    const response = await axios.post('https://gateway.zibal.ir/v1/verify', {
      merchant: process.env.ZIBAL_MERCHANT,
      trackId: trackId
    });
    
    console.log(`پاسخ بررسی وضعیت از زیبال:`, response.data);
    
    if (response.data.result === 100) {
      // تراکنش موفق
      console.log(`تراکنش ${trackId} موفق بود. در حال فعال‌سازی اشتراک...`);
      const activated = await activateSubscription(trackId);
      return res.json({ success: true, activated });
    } else {
      // تراکنش ناموفق
      console.log(`تراکنش ${trackId} ناموفق بود. کد خطا: ${response.data.result}`);
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
    console.log('در حال راه‌اندازی سرویس‌ها...');
    
    // راه‌اندازی سرور Express
    console.log('در حال راه‌اندازی سرور Express...');
    app.listen(PORT, () => {
      console.log(`سرور Express در پورت ${PORT} راه‌اندازی شد.`);
      console.log(`آدرس کال‌بک: ${process.env.CALLBACK_URL}`);
    });
    
    // راه‌اندازی ربات تلگرام با timeout
    console.log('در حال راه‌اندازی ربات تلگرام...');
    
    const launchPromise = bot.launch();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('زمان راه‌اندازی ربات به پایان رسید')), 15000)
    );
    
    try {
      await Promise.race([launchPromise, timeoutPromise]);
      console.log('ربات با موفقیت راه‌اندازی شد!');
      
      const botInfo = await bot.telegram.getMe();
      botUsername = botInfo.username;
      console.log(`اطلاعات ربات: @${botUsername}`);
    } catch (error) {
      console.error('خطا در راه‌اندازی ربات:', error);
      console.log('ادامه اجرا با وجود خطا در راه‌اندازی ربات...');
    }
    
    console.log('همه سرویس‌ها با موفقیت راه‌اندازی شدند!');
  } catch (error) {
    console.error('خطا در راه‌اندازی سرویس‌ها:', error);
    process.exit(1);
  }
}

// شروع سرویس‌ها
startServices();

// مدیریت خروج بدون خطا
process.once('SIGINT', () => {
  console.log('در حال توقف ربات...');
  bot.stop('SIGINT');
  console.log('در حال بستن اتصال به دیتابیس...');
  db.close();
  console.log('ربات متوقف شد و اتصال به پایگاه داده بسته شد.');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('در حال توقف ربات...');
  bot.stop('SIGTERM');
  console.log('در حال بستن اتصال به دیتابیس...');
  db.close();
  console.log('ربات متوقف شد و اتصال به پایگاه داده بسته شد.');
  process.exit(0);
});