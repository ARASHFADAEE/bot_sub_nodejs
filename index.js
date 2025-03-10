// وارد کردن ماژول‌های مورد نیاز
require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const { Pool } = require('pg');
const format = require('pg-format');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');

// ایجاد اتصال به دیتابیس PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// اطمینان از ایجاد جداول مورد نیاز
async function initDatabase() {
  const client = await pool.connect();
  try {
    // ایجاد جدول کاربران
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id BIGINT PRIMARY KEY,
        phone_number TEXT,
        first_name TEXT,
        last_name TEXT,
        username TEXT,
        registered_at TIMESTAMP WITH TIME ZONE,
        subscription_type TEXT,
        subscription_expiry DATE
      )
    `);
    
    // ایجاد جدول پیام‌ها
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        user_id BIGINT,
        message TEXT,
        sent_at TIMESTAMP WITH TIME ZONE,
        is_read BOOLEAN DEFAULT FALSE
      )
    `);
    
    // ایجاد جدول تراکنش‌ها
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id BIGINT,
        amount INTEGER,
        track_id TEXT,
        order_id TEXT,
        subscription_type TEXT,
        subscription_months INTEGER,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP WITH TIME ZONE,
        updated_at TIMESTAMP WITH TIME ZONE
      )
    `);
    
    console.log('دیتابیس با موفقیت راه‌اندازی شد.');
  } catch (err) {
    console.error('خطا در راه‌اندازی دیتابیس:', err);
    throw err;
  } finally {
    client.release();
  }
}

// تعریف توابع دسترسی به دیتابیس
async function getUser(userId) {
  const result = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
  return result.rows[0];
}

async function insertUser(userId, phoneNumber, firstName, lastName, username, registeredAt) {
  await pool.query(
    'INSERT INTO users (user_id, phone_number, first_name, last_name, username, registered_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_id) DO UPDATE SET phone_number = $2, first_name = $3, last_name = $4, username = $5',
    [userId, phoneNumber, firstName, lastName, username, registeredAt]
  );
}

async function updateSubscription(subscriptionType, subscriptionExpiry, userId) {
  await pool.query(
    'UPDATE users SET subscription_type = $1, subscription_expiry = $2 WHERE user_id = $3',
    [subscriptionType, subscriptionExpiry, userId]
  );
}

async function saveMessage(userId, message, sentAt) {
  await pool.query(
    'INSERT INTO messages (user_id, message, sent_at) VALUES ($1, $2, $3)',
    [userId, message, sentAt]
  );
}

async function saveTransaction(userId, amount, trackId, orderId, subscriptionType, subscriptionMonths, createdAt, updatedAt) {
  await pool.query(
    'INSERT INTO transactions (user_id, amount, track_id, order_id, subscription_type, subscription_months, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [userId, amount, trackId, orderId, subscriptionType, subscriptionMonths, createdAt, updatedAt]
  );
}

async function updateTransaction(status, updatedAt, trackId) {
  await pool.query(
    'UPDATE transactions SET status = $1, updated_at = $2 WHERE track_id = $3',
    [status, updatedAt, trackId]
  );
}

async function getTransactionByTrackId(trackId) {
  const result = await pool.query('SELECT * FROM transactions WHERE track_id = $1', [trackId]);
  return result.rows[0];
}

// ایجاد نمونه ربات با توکن
const bot = new Telegraf(process.env.BOT_TOKEN || '7677217623:AAF9xefFfomTQ0BtQS20VbhtPM6fbWuVUvw');

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
  const transaction = await getTransactionByTrackId(trackId);
  
  if (!transaction || transaction.status === 'success') {
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
  } catch (error) {
    console.error('خطا در ارسال پیام به کاربر:', error);
  }
  
  return true;
}

// تعریف دستور /start
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  
  // بررسی اینکه آیا کاربر قبلاً در پایگاه داده وجود دارد
  const user = await getUser(userId);
  
  if (user && user.phone_number) {
    // کاربر قبلاً احراز هویت شده است
    return showMainMenu(ctx);
  }
  
  // درخواست شماره تلفن از کاربر
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
  
  // بررسی اینکه آیا کاربر ادمین است
  if (userId.toString() === adminId) {
    await ctx.reply('پنل مدیریت ادمین:', 
      Markup.inlineKeyboard([
        [Markup.button.callback('گزارش کاربران 👥', 'admin_users')],
        [Markup.button.callback('پیام‌های دریافتی 📨', 'admin_messages')],
        [Markup.button.callback('گزارش تراکنش‌ها 💰', 'admin_transactions')]
      ])
    );
  } else {
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
  
  // دریافت تعداد کاربران
  const userCountResult = await pool.query('SELECT COUNT(*) as count FROM users');
  const userCount = userCountResult.rows[0].count;
  
  // دریافت تعداد کاربران با اشتراک فعال
  const activeSubsResult = await pool.query("SELECT COUNT(*) as count FROM users WHERE subscription_expiry >= CURRENT_DATE");
  const activeSubsCount = activeSubsResult.rows[0].count;
  
  await ctx.reply(`📊 گزارش کاربران:\n\n👥 تعداد کل کاربران: ${userCount}\n✅ اشتراک‌های فعال: ${activeSubsCount}`);
});

bot.action('admin_messages', async (ctx) => {
  const userId = ctx.from.id;
  const adminId = process.env.ADMIN_ID;
  
  if (userId.toString() !== adminId) {
    await ctx.answerCbQuery('شما دسترسی به این بخش را ندارید.');
    return;
  }
  
  await ctx.answerCbQuery();
  
  // دریافت پیام‌های خوانده نشده
  const unreadMessagesResult = await pool.query(`
    SELECT m.*, u.first_name, u.last_name, u.username, u.phone_number
    FROM messages m
    JOIN users u ON m.user_id = u.user_id
    WHERE m.is_read = false
    ORDER BY m.sent_at DESC
    LIMIT 10
  `);
  
  const unreadMessages = unreadMessagesResult.rows;
  
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
});

bot.action(/^read_msg_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const adminId = process.env.ADMIN_ID;
  
  if (userId.toString() !== adminId) {
    await ctx.answerCbQuery('شما دسترسی به این بخش را ندارید.');
    return;
  }
  
  const messageId = ctx.match[1];
  
  // علامت‌گذاری پیام به عنوان خوانده شده
  await pool.query('UPDATE messages SET is_read = true WHERE id = $1', [messageId]);
  
  await ctx.answerCbQuery('پیام به عنوان خوانده شده علامت‌گذاری شد.');
  await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([
    [Markup.button.callback(`خوانده شده ✓`, `noop`)]
  ]));
});

bot.action(/^reply_user_(\d+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const adminId = process.env.ADMIN_ID;
  
  if (userId.toString() !== adminId) {
    await ctx.answerCbQuery('شما دسترسی به این بخش را ندارید.');
    return;
  }
  
  const targetUserId = ctx.match[1];
  
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
  
  // دریافت آمار تراکنش‌ها
  const totalTransactionsResult = await pool.query('SELECT COUNT(*) as count, SUM(amount) as total FROM transactions WHERE status = $1', ['success']);
  const totalTransactions = totalTransactionsResult.rows[0];
  
  const todayTransactionsResult = await pool.query(`
    SELECT COUNT(*) as count, SUM(amount) as total 
    FROM transactions 
    WHERE status = $1 AND DATE(created_at) = CURRENT_DATE
  `, ['success']);
  const todayTransactions = todayTransactionsResult.rows[0];
  
  await ctx.reply(`📊 گزارش تراکنش‌ها:\n\n💰 مجموع تراکنش‌ها: ${totalTransactions.total?.toLocaleString() || 0} تومان\n🔢 تعداد تراکنش‌ها: ${totalTransactions.count}\n\n📅 امروز:\n💰 مبلغ: ${todayTransactions.total?.toLocaleString() || 0} تومان\n🔢 تعداد: ${todayTransactions.count}`);
});

// دریافت شماره تلفن کاربر
bot.on('contact', async (ctx) => {
  // بررسی اینکه آیا شماره تلفن متعلق به همین کاربر است
  if(ctx.message.contact.user_id === ctx.from.id) {
    const userId = ctx.from.id;
    const phoneNumber = ctx.message.contact.phone_number;
    const firstName = ctx.from.first_name || '';
    const lastName = ctx.from.last_name || '';
    const username = ctx.from.username || '';
    const registeredAt = new Date().toISOString();
    
    // ذخیره اطلاعات کاربر در پایگاه داده
    await insertUser(userId, phoneNumber, firstName, lastName, username, registeredAt);
    
    // تایید ثبت شماره تلفن
    await ctx.reply(`ممنون از شما ${firstName}! شماره تلفن شما با موفقیت ثبت شد. ✅`);
    
    // نمایش منوی اصلی
    showMainMenu(ctx);
  } else {
    ctx.reply('لطفاً شماره تلفن خود را به اشتراک بگذارید، نه شماره دیگران را.');
  }
});

// تابع نمایش منوی اصلی
async function showMainMenu(ctx) {
  await ctx.reply('منوی اصلی:', 
    Markup.keyboard([
      ['منوی اصلی 🏠']
    ]).resize()
  );
  
  // دریافت اطلاعات اشتراک کاربر
  const userId = ctx.from.id;
  const user = await getUser(userId);
  
  let subscriptionInfo = '';
  if (user && user.subscription_type) {
    // بررسی اعتبار اشتراک
    const today = new Date().toISOString().split('T')[0];
    const isActive = user.subscription_expiry >= today;
    
    subscriptionInfo = `\n\nاشتراک فعلی شما: ${user.subscription_type}`;
    if (user.subscription_expiry) {
      subscriptionInfo += `\nتاریخ انقضا: ${user.subscription_expiry.toISOString().split('T')[0]}`;
      subscriptionInfo += isActive ? ' (فعال ✅)' : ' (منقضی شده ❌)';
    }
  }
  
  await ctx.reply(`لطفاً یکی از گزینه‌های زیر را انتخاب کنید:${subscriptionInfo}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('خرید اشتراک 💳', 'buy_subscription')],
      [Markup.button.callback('ارتباط با ادمین 👨‍💼', 'contact_admin')]
    ])
  );
}

// پاسخ به دکمه‌های callback
bot.action('buy_subscription', async (ctx) => {
  await ctx.answerCbQuery();
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
  
  // ذخیره اطلاعات اشتراک انتخابی در session
  ctx.session.selectedSubscription = {
    type: planName,
    price: price,
    months: months
  };
  
  // ایجاد یک شناسه سفارش منحصر به فرد
  const orderId = `order_${Date.now()}_${ctx.from.id}`;
  
  try {
    // درخواست ایجاد تراکنش به زیبال
    const response = await axios.post('https://gateway.zibal.ir/v1/request', {
      merchant: process.env.ZIBAL_MERCHANT,
      amount: price,  // مبلغ به تومان
      callbackUrl: process.env.CALLBACK_URL,
      orderId: orderId,
      description: `خرید اشتراک ${planName}`
    });
    
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
      
      await ctx.reply(`شما اشتراک ${planName} به مبلغ ${price.toLocaleString()} تومان را انتخاب کرده‌اید.\n\nبرای پرداخت و فعال‌سازی اشتراک، لطفاً روی دکمه زیر کلیک کنید:`,
        Markup.inlineKeyboard([
          [Markup.button.url('پرداخت آنلاین 💰', paymentUrl)],
          [Markup.button.callback('بررسی وضعیت پرداخت 🔄', `check_payment_${trackId}`)],
          [Markup.button.callback('بازگشت به لیست اشتراک‌ها 🔙', 'buy_subscription')]
        ])
      );
    } else {
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
  
  try {
    // بررسی وضعیت تراکنش در زیبال
    const response = await axios.post('https://gateway.zibal.ir/v1/verify', {
      merchant: process.env.ZIBAL_MERCHANT,
      trackId: trackId
    });
    
    if (response.data.result === 100) {
      // تراکنش موفق
      const activated = await activateSubscription(trackId);
      
      if (activated) {
        await ctx.reply('🎉 پرداخت شما با موفقیت انجام شد و اشتراک شما فعال شد.');
        // بازگشت به منوی اصلی
        showMainMenu(ctx);
      } else {
        await ctx.reply('این تراکنش قبلاً تایید شده و اشتراک شما فعال است.');
      }
    } else if (response.data.result === 201) {
      // تراکنش قبلاً تایید شده است
      await ctx.reply('این تراکنش قبلاً تایید شده و اشتراک شما فعال است.');
    } else if (response.data.result === 202) {
      // تراکنش ناموفق
      await ctx.reply('پرداخت هنوز انجام نشده است. لطفاً ابتدا پرداخت را انجام دهید.');
    } else {
      await ctx.reply(`متأسفانه خطایی در بررسی وضعیت پرداخت رخ داد. لطفاً دوباره تلاش کنید.\n\nکد خطا: ${response.data.result}`);
    }
  } catch (error) {
    console.error('خطا در بررسی وضعیت پرداخت:', error);
    await ctx.reply('متأسفانه خطایی در بررسی وضعیت پرداخت رخ داد. لطفاً دوباره تلاش کنید.');
  }
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
    
    try {
      // ارسال پیام ادمین به کاربر
      await bot.telegram.sendMessage(targetUserId, `📨 پیام از پشتیبانی:\n\n${message}`);
      await ctx.reply(`✅ پیام شما با موفقیت به کاربر ارسال شد.`);
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
      } catch (error) {
        console.error('خطا در ارسال پیام به ادمین:', error);
      }
    }
    
    ctx.reply('پیام شما با موفقیت به ادمین ارسال شد. ✅\nدر اسرع وقت با شما تماس خواهیم گرفت.');
    
    // خارج کردن کاربر از حالت انتظار برای پیام ادمین
    ctx.session.waitingForAdminMessage = false;
    
    // بازگشت به منوی اصلی
    showMainMenu(ctx);
    return;
  }
  
  // پاسخ به کلمه "منوی اصلی"
  if (ctx.message.text === 'منوی اصلی 🏠') {
    showMainMenu(ctx);
    return;
  }
  
  // بررسی اینکه آیا کاربر در پایگاه داده وجود دارد
  const user = await getUser(userId);
  
  // اگر کاربر هنوز احراز هویت نشده است
  if (!user || !user.phone_number) {
    ctx.reply('لطفاً ابتدا با استفاده از دستور /start ثبت‌نام کنید.');
    return;
  }
  
  // پاسخ پیش‌فرض به سایر پیام‌ها
  ctx.reply('دستور نامشخص. لطفاً از منوی زیر استفاده کنید:');
  showMainMenu(ctx);
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
              <a class="btn" href="https://t.me/${botUsername}">بازگشت به ربات</a>
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
    // راه‌اندازی دیتابیس
    await initDatabase();
    
    // راه‌اندازی ربات تلگرام
    await bot.launch();
    const botInfo = await bot.telegram.getMe();
    botUsername = botInfo.username;
    console.log(`ربات با نام @${botUsername} با موفقیت راه‌اندازی شد!`);
    
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
  pool.end();
  console.log('ربات متوقف شد و اتصال به پایگاه داده بسته شد.');
  process.exit(0);
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  pool.end();
  console.log('ربات متوقف شد و اتصال به پایگاه داده بسته شد.');
  process.exit(0);
});