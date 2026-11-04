const fetch = require('node-fetch');
const { WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, GRAPH_API_VERSION } = require('./config');

const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const MESSAGES_URL = `${GRAPH_BASE}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

/**
 * 🔥 دالة أساسية مشتركة لكل استدعاءات إرسال رسائل واتساب.
 * لا توقف تنفيذ البوت أبداً حتى لو فشل الإرسال (نفس فلسفة apiClient.js) - فقط تسجّل الخطأ بالـ console.
 */
async function callGraphAPI(body) {
    try {
        const response = await fetch(MESSAGES_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
            console.error('❌ خطأ من WhatsApp API:', response.status, JSON.stringify(data));
        } else {
            // 🔎 تشخيص مؤقت - تأكيد إن الرسالة فعلاً قُبلت من واتساب (message id يرجع لو نجح الإرسال)
            console.log('📤 رد واتساب على الإرسال:', JSON.stringify(data));
        }
        return data;
    } catch (error) {
        console.error('❌ خطأ بالاتصال بـ WhatsApp API:', error.message);
        return null;
    }
}

/**
 * 🔥 رسالة نصية عادية
 */
async function sendText(to, text) {
    if (!text || !String(text).trim()) return null;
    return callGraphAPI({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: String(text), preview_url: false },
    });
}

/**
 * 🔥 أزرار سريعة (Reply Buttons) - حد أقصى 3 أزرار، كل عنوان حد أقصى 20 حرف (فرض من واتساب نفسها)
 * buttons: [{ id, title }]
 */
async function sendButtons(to, bodyText, buttons) {
    const limited = (buttons || []).slice(0, 3).map((b) => ({
        type: 'reply',
        reply: { id: b.id, title: String(b.title).slice(0, 20) },
    }));
    if (!limited.length) return sendText(to, bodyText);

    return callGraphAPI({
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: bodyText || ' ' },
            action: { buttons: limited },
        },
    });
}

/**
 * 🔥 قائمة منسدلة (List Message) - حد أقصى 10 عناصر إجمالي، عنوان كل عنصر حد أقصى 24 حرف
 * rows: [{ id, title, description? }]
 */
async function sendList(to, bodyText, buttonLabel, rows, sectionTitle = 'الخيارات') {
    if (!rows || !rows.length) return sendText(to, bodyText);

    if (rows.length > 10) {
        console.warn(`⚠️ تم اقتصاص قائمة من ${rows.length} إلى 10 عناصر (حد واتساب الأقصى للقائمة الواحدة)`);
    }
    const limited = rows.slice(0, 10).map((r) => ({
        id: r.id,
        title: String(r.title).slice(0, 24),
        ...(r.description ? { description: String(r.description).slice(0, 72) } : {}),
    }));

    return callGraphAPI({
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'list',
            body: { text: bodyText || ' ' },
            action: {
                button: String(buttonLabel || 'اختر').slice(0, 20),
                sections: [{ title: sectionTitle, rows: limited }],
            },
        },
    });
}

/**
 * 🔥 تعليم الرسالة كمقروءة - أقرب شي متوفر بواتساب لمفهوم "يكتب الآن" بتيليجرام
 */
async function markAsRead(messageId) {
    if (!messageId) return null;
    return callGraphAPI({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
    });
}

/**
 * 🔥 تنزيل ملف وسائط (رسالة صوتية مثلاً) من واتساب - خطوتين إلزاميتين:
 * 1) نجيب رابط تنزيل مؤقت من الـ media_id
 * 2) ننزل محتوى الملف الفعلي من هذا الرابط (يحتاج نفس التوكن بالهيدر)
 */
async function downloadMedia(mediaId) {
    const metaRes = await fetch(`${GRAPH_BASE}/${mediaId}`, {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    const meta = await metaRes.json();
    if (!meta || !meta.url) {
        throw new Error('ما قدرت أجيب رابط تنزيل الملف من واتساب');
    }

    const fileRes = await fetch(meta.url, {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    return Buffer.from(await fileRes.arrayBuffer());
}

module.exports = {
    sendText,
    sendButtons,
    sendList,
    markAsRead,
    downloadMedia,
};