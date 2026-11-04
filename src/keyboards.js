const { fetchServices, findProductById } = require('./apiClient');

/**
 * 🔥 كل دالة هون بترجع "وصف" بسيط للوحة الأزرار/القائمة (مش JSON نهائي جاهز للإرسال) -
 * الإرسال الفعلي بيصير عبر whatsappClient.js (sendButtons / sendList)، بحيث لو احتجنا
 * نغيّر تفاصيل الإرسال لاحقاً، نغيّرها بمكان واحد بس.
 *
 * شكل الوصف:
 *   { type: 'list', buttonLabel, rows: [{ id, title }] }
 *   { type: 'button', buttons: [{ id, title }] }
 */

/**
 * 🔥 التيمبلت الرئيسي - 4 خيارات، فلازم List (الأزرار السريعة بواتساب حد أقصاها 3)
 */
async function mainTemplateKeyboard() {
    return {
        type: 'list',
        buttonLabel: 'القائمة',
        rows: [
            { id: 'menu:order_service', title: '📋 اطلب خدمة' },
            { id: 'menu:my_orders', title: '📋 طلباتي' },
            { id: 'menu:location', title: '📍 موقعنا' },
            { id: 'menu:contact', title: '👨‍💼 تواصل معنا' },
        ],
    };
}

/**
 * 🔥 قائمة الأقسام (الخدمات) - تظهر لما يضغط العميل "📋 اطلب خدمة"
 */
async function categoriesKeyboard() {
    const services = await fetchServices();
    if (!services || services.length === 0) {
        return {
            type: 'list',
            buttonLabel: 'إعادة تحميل',
            rows: [{ id: 'retry_load', title: '🔄 إعادة تحميل' }],
        };
    }

    const rows = services.map((cat) => ({ id: `service:${cat.id}`, title: cat.name }));
    rows.push({ id: 'general_inquiry', title: '❓ استفسار عام' });

    return { type: 'list', buttonLabel: 'اختر خدمة', rows };
}

/**
 * 🔥 أزرار التأكيد - بالظبط 3 (الحد الأقصى المسموح لـ Reply Buttons)
 */
function confirmationKeyboard() {
    return {
        type: 'button',
        buttons: [
            { id: 'confirm:yes', title: '✅ تأكيد' },
            { id: 'confirm:edit', title: '❌ تعديل' },
            { id: 'confirm:contact', title: '📞 تواصل معنا' },
        ],
    };
}

/**
 * 🔥 عرض أزرار أبناء قسم/منتج
 */
function buildChildrenKeyboard(children) {
    const rows = children.map((child) => ({ id: `product:${child.id}`, title: child.name }));
    rows.push({ id: 'back_to_main', title: '🏠 رجوع' });
    return { type: 'list', buttonLabel: 'اختر', rows };
}

/**
 * 🔥 تحويل قائمة IDs منتجات مقترحة من الذكاء الاصطناعي لقائمة قابلة للنقر
 */
async function buildSuggestedProductsKeyboard(productIds) {
    if (!Array.isArray(productIds) || productIds.length === 0) return null;

    const services = await fetchServices();
    const rows = [];
    for (const id of productIds) {
        const product = findProductById(id, services);
        if (product) rows.push({ id: `product:${product.id}`, title: product.name });
    }
    if (!rows.length) return null;

    return { type: 'list', buttonLabel: 'اختر', rows };
}

module.exports = {
    mainTemplateKeyboard,
    categoriesKeyboard,
    confirmationKeyboard,
    buildChildrenKeyboard,
    buildSuggestedProductsKeyboard,
};