import { Telegraf, Markup } from "telegraf";
import fetch from "node-fetch";
import FormData from "form-data";
import pkg from "pg";
import 'dotenv/config';

const { Pool } = pkg;

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = Number(process.env.ADMIN_ID);
const CHANNEL_ID = process.env.CHANNEL_ID;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ===== DB Setup =====
await pool.query(`
CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY,
  credits INT DEFAULT 50,
  daily_used INT DEFAULT 0,
  referred_by BIGINT
);
`);

// ===== Helpers =====
async function getUser(id) {
  const res = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return res.rows[0];
}
async function addUser(id, referredBy = null) {
  await pool.query(
    `INSERT INTO users (id, credits, daily_used, referred_by)
     VALUES ($1, 50, 0, $2) ON CONFLICT (id) DO NOTHING`,
    [id, referredBy]
  );
}
async function updateCredits(id, amount) {
  await pool.query(`UPDATE users SET credits = $1 WHERE id = $2`, [amount, id]);
}
async function updateDailyUsed(id, amount) {
  await pool.query(`UPDATE users SET daily_used = $1 WHERE id = $2`, [amount, id]);
}

// ===== Daily Reset =====
setInterval(async () => {
  const now = new Date();
  if (now.getUTCHours() === 0 && now.getUTCMinutes() === 0) {
    await pool.query(`UPDATE users SET daily_used = 0`);
    console.log("✅ Daily credits reset");
  }
}, 60 * 1000);

// ===== Bot Start =====
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const args = ctx.message.text.split(" ");
  let referredBy = null;

  if (args[1] && args[1].startsWith("ref_")) {
    referredBy = args[1].replace("ref_", "");
    if (Number(referredBy) === userId) referredBy = null;
  }

  await addUser(userId, referredBy);

  // Referral bonus
  if (referredBy) {
    const refUser = await getUser(referredBy);
    if (refUser) {
      await updateCredits(referredBy, refUser.credits + 30);
      await ctx.telegram.sendMessage(
        referredBy,
        "🎉 তুমি একজন নতুন ইউজার রেফার করেছো! +30 ক্রেডিট পেয়েছো!"
      );
    }
  }

  const user = await getUser(userId);
  const refLink = `https://t.me/${ctx.botInfo.username}?start=ref_${userId}`;

  await ctx.reply(
    `👋 হ্যালো ${ctx.from.first_name}!\n\nতোমার আছে ${user.credits} ক্রেডিট (প্রতিদিন ৫০টা ফ্রি)\n\nতোমার রেফার লিংক:\n${refLink}`,
    Markup.inlineKeyboard([[Markup.button.callback("💳 আমার ক্রেডিট", "mycredits")]])
  );
});

// ===== User Commands =====
bot.action("mycredits", async (ctx) => {
  const user = await getUser(ctx.from.id);
  ctx.answerCbQuery();
  ctx.reply(`💳 তোমার ক্রেডিট: ${user.credits}`);
});

// ===== Admin Panel =====
bot.command("admin", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply("❌ অনুমতি নেই");
  await ctx.reply(
    "🛠 Admin Panel",
    Markup.inlineKeyboard([
      [Markup.button.callback("📊 Stats", "stats")],
      [Markup.button.callback("📢 Broadcast", "broadcast")],
      [Markup.button.callback("➕ Add Credit", "addcredit")],
      [Markup.button.callback("➖ Remove Credit", "remcredit")]
    ])
  );
});

bot.action("stats", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const res = await pool.query("SELECT COUNT(*) FROM users");
  ctx.reply(`📊 মোট ইউজার: ${res.rows[0].count}`);
});

bot.action("broadcast", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.reply("✉️ Broadcast message লিখে reply করো।");
  bot.once("message", async (msgCtx) => {
    const text = msgCtx.message.text || msgCtx.message.caption;
    const res = await pool.query("SELECT id FROM users");
    for (const row of res.rows) {
      try { await bot.telegram.sendMessage(row.id, text); } catch {}
    }
    msgCtx.reply("✅ Broadcast পাঠানো হয়েছে!");
  });
});

bot.action("addcredit", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply("User ID এবং Credit লিখে reply করো।\nFormat: 123456789 50");
  bot.once("message", async (msgCtx) => {
    const parts = msgCtx.message.text.split(" ");
    const uid = Number(parts[0]);
    const credit = Number(parts[1]);
    const user = await getUser(uid);
    if (!user) return msgCtx.reply("❌ User পাওয়া যায়নি।");
    await updateCredits(uid, user.credits + credit);
    msgCtx.reply(`✅ ${credit} credits add করা হলো ${uid} কে।`);
  });
});

bot.action("remcredit", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply("User ID এবং Credit লিখে reply করো।\nFormat: 123456789 20");
  bot.once("message", async (msgCtx) => {
    const parts = msgCtx.message.text.split(" ");
    const uid = Number(parts[0]);
    const credit = Number(parts[1]);
    const user = await getUser(uid);
    if (!user) return msgCtx.reply("❌ User পাওয়া যায়নি।");
    await updateCredits(uid, Math.max(user.credits - credit,0));
    msgCtx.reply(`✅ ${credit} credits remove করা হলো ${uid} থেকে।`);
  });
});

// ===== Photo Enhance =====
bot.on("photo", async (ctx) => {
  const user = await getUser(ctx.from.id);
  if (!user) return ctx.reply("❌ আগে /start দাও");
  if (user.credits <= 0) return ctx.reply("🚫 ক্রেডিট শেষ!");
  if (user.daily_used >= 50) return ctx.reply("⏳ আজকের ৫০টা ফ্রি শেষ!");

  await updateCredits(ctx.from.id, user.credits - 1);
  await updateDailyUsed(ctx.from.id, user.daily_used + 1);

  const fileId = ctx.message.photo.pop().file_id;
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const userHash = `user_${ctx.from.id}`;

  try {
    // Catbox upload
    const form = new FormData();
    form.append("reqtype", "urlupload");
    form.append("url", fileLink.href);
    form.append("userhash", userHash);
    const catRes = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: form });
    const catboxUrl = await catRes.text();

    // Forward original to channel
    await ctx.telegram.sendPhoto(CHANNEL_ID, fileId, {
      caption: `🆔 User: ${ctx.from.username || ctx.from.first_name} (${ctx.from.id})\n📦 Userhash: ${userHash}`
    });

    // Remini API
    const apiUrl = `https://romek-xd-api.vercel.app/imagecreator/remini?url=${encodeURIComponent(catboxUrl)}`;
    const res = await fetch(apiUrl);
    const data = await res.json();
    if (!data?.result) throw new Error("Invalid API response");

    // Reply enhanced photo
    await ctx.replyWithPhoto(data.result, {
      caption: "✨ তোমার Enhanced ছবি তৈরি!",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("📥 Download", `download_${data.result}`),
          Markup.button.callback("🔗 Get Link", `getlink_${data.result}`)
        ]
      ])
    });

  } catch (err) {
    console.error(err);
    ctx.reply("❌ কোনো সমস্যা হয়েছে, আবার চেষ্টা করো!");
  }
});

// ===== Download & Get Link =====
bot.action(/^download_(.+)/, async (ctx) => {
  const url = ctx.match[1];
  await ctx.answerCbQuery("📥 ডাউনলোড তৈরি হচ্ছে...");
  await ctx.replyWithDocument({ url, filename: "Enhanced_Photo.jpg" });
});

bot.action(/^getlink_(.+)/, async (ctx) => {
  const url = ctx.match[1];
  await ctx.answerCbQuery("🔗 লিংক তৈরি হচ্ছে...");
  const form = new FormData();
  form.append("reqtype", "urlupload");
  form.append("url", url);
  const catRes = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: form });
  const catboxUrl = await catRes.text();
  await ctx.reply(
    `🔗 Direct Link:\n${catboxUrl}`,
    Markup.inlineKeyboard([[Markup.button.url("🌐 Open in Browser", catboxUrl)]])
  );
});

bot.launch();
console.log("🚀 Remini Bot full-featured running...");
