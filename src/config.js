require('dotenv').config();

function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        console.error(`❌ متغير البيئة مفقود: ${name}`);
        process.exit(1);
    }
    return value;
}

module.exports = {
    // 🔥 تيليجرام - أصبح اختيارياً (مو مطلوب) بعد التحويل لواتساب.
    // لو حبيت ترجع تشغل نسخة تيليجرام القديمة (index.js) بنفس الوقت، حط القيمة بالـ .env وبتشتغل عادي.
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || null,

    // 🔥 واتساب (WhatsApp Cloud API - ميتا مباشرة) - الجديد
    WHATSAPP_TOKEN: requireEnv('WHATSAPP_TOKEN'),
    WHATSAPP_PHONE_NUMBER_ID: requireEnv('WHATSAPP_PHONE_NUMBER_ID'),
    WHATSAPP_VERIFY_TOKEN: requireEnv('WHATSAPP_VERIFY_TOKEN'),
    GRAPH_API_VERSION: process.env.GRAPH_API_VERSION || 'v21.0',
    PORT: parseInt(process.env.PORT) || 3000,

    OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    API_BASE_URL: process.env.API_BASE_URL || 'https://darkorange-manatee-851282.hostingersite.com/api/mtbaa-fkr-ork-alrkmys-team',
    OWNER_PHONE: process.env.OWNER_PHONE || '0500000000',
    SHOP_NAME: process.env.SHOP_NAME || 'نشاطنا التجاري',
    CURRENCY: process.env.CURRENCY || 'ريال',
    BOT_DIALECT: process.env.BOT_DIALECT || 'سعودية',
    MAX_HISTORY: parseInt(process.env.MAX_HISTORY) || 30,
};