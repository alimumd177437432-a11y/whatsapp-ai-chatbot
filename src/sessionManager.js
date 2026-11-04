const { MAX_HISTORY } = require('./config');

const sessions = new Map();
let orderCounter = 1000;

function getSession(chatId) {
    if (!sessions.has(chatId)) {
        sessions.set(chatId, createEmptySession());
    }
    return sessions.get(chatId);
}

// 🔥 إضافة جديدة فقط لنسخة واتساب: تيليجرام عنده أمر /start صريح يعرف متى "يبدأ" العميل،
// واتساب ما عندها هذا المفهوم - أول رسالة توصل من رقم جديد نتعرف عليها عبر هذه الدالة
// (session ما كانت موجودة قبل)، بدل ما نتعرف عليها عبر أمر خاص.
function hasSession(chatId) {
    return sessions.has(chatId);
}

function createEmptySession() {
    return {
        history: [],           // تاريخ المحادثة
        fields: [],            // نصوص الحقول المطلوبة للمنتج الحالي (بالترتيب)
        answers: {},           // الإجابات المحفوظة: { fieldIndex: { label, value } }
        currentProduct: null,  // المنتج الحالي
        currentProductId: null,
        step: 'idle',          // idle | ordering | awaiting_phone | awaiting_phone_for_orders | confirming | confirmed
        orderNumber: null,
        lastSummary: null,
        customerPhone: null,   // رقم جوال العميل — يُطلب مرة واحدة بعد اكتمال بيانات المنتج وقبل التأكيد
    };
}

function resetSession(chatId) {
    sessions.set(chatId, createEmptySession());
    return sessions.get(chatId);
}

function pushHistory(chatId, role, content) {
    const session = getSession(chatId);
    session.history.push({ role, content });
    if (session.history.length > MAX_HISTORY) {
        session.history.shift();
    }
}

function nextOrderNumber() {
    orderCounter += 1;
    return `TRX-${orderCounter}`;
}

// ==================================================================
// 🔥 حد أقصى بسيط لعدد الرسائل لكل محادثة (حماية من استهلاك مفرط لرصيد
// الذكاء الاصطناعي المشترك بين كل العملاء - سواء سوء استخدام مقصود أو غير مقصود).
// نافذة متحركة: لو تجاوز المستخدم الحد خلال آخر دقيقة، تُرفض رسالته مؤقتاً
// بدون ما توصل لأي استدعاء AI أو Whisper (يعني بدون أي تكلفة فعلية).
// ==================================================================
const rateLimitMap = new Map(); // chatId -> [timestamps]
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60000; // دقيقة وحدة

function checkRateLimit(chatId) {
    const now = Date.now();
    const timestamps = (rateLimitMap.get(chatId) || []).filter(
        (t) => now - t < RATE_LIMIT_WINDOW_MS
    );

    if (timestamps.length >= RATE_LIMIT_MAX) {
        rateLimitMap.set(chatId, timestamps);
        return false;
    }

    timestamps.push(now);
    rateLimitMap.set(chatId, timestamps);
    return true;
}

module.exports = {
    getSession,
    resetSession,
    hasSession,
    pushHistory,
    nextOrderNumber,
    checkRateLimit,
};