const { calculatePrice } = require('./priceCalculator');
const { nextOrderNumber } = require('./sessionManager');
const { extractFieldsWithAI } = require('./ai');
const { createOrder } = require('./apiClient');
const { CURRENCY } = require('./config');

/**
 * 🔥 استخراج الحقول من prompt_if_you_need بصيغته القياسية فقط (بوجود "→")
 * كل حقل يُحفظ كما كُتب بالضبط (بدون تبسيط أو قاموس ترجمة).
 * الصيغة المتوقعة: "... → حقل1 | حقل2 | حقل3 . بعد اكتمال البيانات ..."
 * يرجع null إذا النص ما بيتبع هالصيغة (بدل ما يرجع تخمين خاطئ) — عشان يروح للـ fallback الذكي.
 */
function extractFieldsRegex(promptText) {
    if (!promptText || !promptText.trim()) return null;

    const arrowSplit = promptText.split('→');
    if (arrowSplit.length < 2) return null;

    const afterArrow = arrowSplit.slice(1).join('→');
    const stopMatch = afterArrow.match(/^([\s\S]*?)\.\s*بعد\s*اكتمال/);
    const part = stopMatch ? stopMatch[1] : afterArrow.split('.')[0];

    const fields = part
        .split('|')
        .map(f => f.trim().replace(/\.+$/, '').trim())
        .filter(Boolean);

    return fields.length ? fields : null;
}

/**
 * 🔥 استخراج ذكي: يجرب الصيغة القياسية أولاً (سريع، بدون أي استدعاء API)،
 * وإذا النص ما بيتبعها (زي تعليمات حرة بدون "→") يستخدم الذكاء الاصطناعي
 * لاستخراج الأسئلة الفعلية المذكورة بالنص فقط — بدون اختراع ولا حذف.
 */
async function resolveFields(promptText) {
    const regexFields = extractFieldsRegex(promptText);
    if (regexFields) return regexFields;

    if (!promptText || !promptText.trim()) return ['الكمية'];

    try {
        const aiFields = await extractFieldsWithAI(promptText);
        if (aiFields && aiFields.length) return aiFields;
    } catch (err) {
        console.error('❌ فشل استخراج الحقول بالذكاء الاصطناعي:', err.message);
    }

    return ['الكمية']; // fallback أخير فقط إذا فشل كل شي
}

// للاستخدام الخارجي (اختبارات، توافق) — استخراج سريع بدون AI
function extractFields(promptText) {
    return extractFieldsRegex(promptText) || ['الكمية'];
}

/**
 * 🔥 بدء جمع بيانات الطلب لمنتج نهائي (بدون أبناء)
 */
async function startOrderFields(session, product) {
    session.currentProduct = product;
    session.currentProductId = product.id;
    session.step = 'ordering';
    session.fields = await resolveFields(product.prompt_if_you_need || '');
    session.answers = {};
    session.lastSummary = null;
    // 🔥 مسح تاريخ المحادثة القديم عند بدء طلب منتج جديد — يمنع اختلاط أسئلة/تفاصيل
    // طلب سابق (مكتمل أو ملغي) بالطلب الجديد، ويخلي سياق الذكاء الاصطناعي مركّز فقط على الطلب الحالي.
    session.history = [];
}

/**
 * 🔥 أول حقل لسه ما انجاوب عليه (index) أو -1 إذا كل الحقول مكتملة
 */
function getCurrentFieldIndex(session) {
    if (!session.fields || session.fields.length === 0) return -1;
    for (let i = 0; i < session.fields.length; i++) {
        if (!session.answers?.[i]) return i;
    }
    return -1;
}

/**
 * 🔥 حفظ إجابة العميل لحقل معيّن
 */
function saveAnswer(session, fieldIndex, value) {
    if (!session.answers) session.answers = {};
    const label = session.fields?.[fieldIndex] || `حقل ${fieldIndex}`;
    session.answers[fieldIndex] = { label, value };
}

/**
 * 🔥 تعديل إجابة حقل سبق تعبئته (أثناء مرحلة التأكيد)
 */
function applyEdit(session, fieldIndex, value) {
    if (
        !session.fields ||
        fieldIndex === null ||
        fieldIndex === undefined ||
        fieldIndex < 0 ||
        fieldIndex >= session.fields.length
    ) {
        return false;
    }
    saveAnswer(session, fieldIndex, value);
    return true;
}

/**
 * 🔥 استخراج قيمة "الكمية" من الإجابات المحفوظة (أي حقل يحتوي كلمة كمية/عدد)
 * إذا ما فيه حقل كمية بالمنتج (مثل طلبات التصميم)، تُحسب كأنها قطعة واحدة.
 */
function extractQuantity(session) {
    const answers = session.answers || {};
    for (const key of Object.keys(answers)) {
        const { label, value } = answers[key];
        if (/كمي|عدد/.test(label)) {
            const digits = String(value).replace(/[^0-9]/g, '');
            if (digits) return parseInt(digits, 10);
        }
    }
    return 1;
}

/**
 * 🔥 حساب السعر النهائي بالاعتماد على calculatePrice (يفهم "لكل 500"، "لكل 100"، "للمتر"، إلخ)
 */
function getFinalPrice(session) {
    if (!session.currentProduct) {
        return { total: 0, unitPrice: 0, quantity: 0, unit: 'غير محدد' };
    }
    const quantity = extractQuantity(session);
    return calculatePrice(session.currentProduct, quantity);
}

/**
 * 🔥 بناء ملخص الطلب (تيمبلت التأكيد) — يُبنى بالكود دائماً وليس بحرية الـ AI
 */
function buildOrderSummary(session) {
    const productName = session.currentProduct?.name || 'غير محدد';
    const fields = session.fields || [];
    const answers = session.answers || {};

    let detailsList = '';
    fields.forEach((label, idx) => {
        const ans = answers[idx];
        if (ans && ans.value) {
            detailsList += `• ${label}: ${ans.value}\n`;
        }
    });

    const priceInfo = getFinalPrice(session);

    const summary =
        `📋 *ملخص طلبك:*\n\n` +
        `📦 *العنصر/الخدمة:* ${productName}\n` +
        `${detailsList || '—'}\n` +
        `💰 *السعر الإجمالي:* ${priceInfo.total} ${CURRENCY}${priceInfo.unit ? ' (' + priceInfo.unit + ')' : ''}\n\n` +
        `هل تؤكد الطلب؟`;

    session.lastSummary = summary;
    return summary;
}

/**
 * 🔥 تأكيد الطلب نهائياً + طباعة بيانات الطلب كاملة على التيرمنال + إرسالها لواجهة الـ API الخاصة بالنشاط.
 * customerInfo: { name, phone } — تُستخرج تلقائياً في index.js (الاسم من تيليجرام، والجوال من الجلسة).
 * إرسال الـ API لا يوقف تأكيد الطلب للعميل أبداً حتى لو فشل الاتصال — فقط يُسجَّل الخطأ بالـ console.
 */
async function confirmOrder(session, customerInfo = {}) {
    const orderNumber = nextOrderNumber();
    session.orderNumber = orderNumber;
    session.step = 'confirmed';

    const priceInfo = getFinalPrice(session);
    const orderRecord = {
        orderNumber,
        productId: session.currentProduct?.id,
        productName: session.currentProduct?.name,
        details: Object.fromEntries(
            Object.entries(session.answers || {}).map(([, a]) => [a.label, a.value])
        ),
        price: priceInfo,
        confirmedAt: new Date().toISOString(),
    };

    console.log('🧾 طلب جديد مؤكد:\n' + JSON.stringify(orderRecord, null, 2));

    const apiResult = await createOrder({
        customerName: customerInfo.name || 'عميل تيليجرام',
        customerPhone: customerInfo.phone || session.customerPhone || '',
        details: orderRecord,
        serviceId: session.currentProduct?.id,
    });

    return { orderNumber, orderRecord, apiResult };
}

module.exports = {
    extractFields,
    startOrderFields,
    getCurrentFieldIndex,
    saveAnswer,
    applyEdit,
    getFinalPrice,
    buildOrderSummary,
    confirmOrder,
};