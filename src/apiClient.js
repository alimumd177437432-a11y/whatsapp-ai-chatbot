const fetch = require('node-fetch');
const { API_BASE_URL } = require('./config');

let cachedServices = null;
let cachedBusiness = null;
// 🔥 متغيرين منفصلين (بدل واحد مشترك) — كل مورد إله صلاحية كاش مستقلة عن التاني.
// كانت مشتركة بمتغير واحد قبل، وهذا كان يسبب خطأ: تحديث أحد الموردين كان يخلي
// الكود يحسب المورد التاني "لسا طازة" حتى لو كان قديم فعلاً، فما يتحدّث لما يفترض.
let lastServicesFetchTime = 0;
let lastBusinessFetchTime = 0;
const CACHE_TTL = 300000; // 5 دقائق — يقلل عدد استدعاءات الـ API. استخدم "ريفرش" أو /refresh للتحديث الفوري وقت الحاجة

/**
 * 🔥 إبطال الكاش يدوياً — يُستخدم لما نبي نجبر البوت يجيب أحدث نسخة من الـ API فوراً
 * (زر "تحديث" أو أمر /refresh)
 */
function invalidateCache() {
    cachedServices = null;
    cachedBusiness = null;
    lastServicesFetchTime = 0;
    lastBusinessFetchTime = 0;
}

async function fetchServices() {
    const now = Date.now();
    if (cachedServices && (now - lastServicesFetchTime) < CACHE_TTL) {
        return cachedServices;
    }

    try {
        const response = await fetch(`${API_BASE_URL}/services`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        cachedServices = data.data || [];
        lastServicesFetchTime = now;
        console.log('✅ تم جلب الخدمات بنجاح، عدد الأقسام:', cachedServices.length);
        return cachedServices;
    } catch (error) {
        console.error('❌ خطأ في جلب الخدمات:', error.message);
        return cachedServices || [];
    }
}

async function fetchBusinessInfo() {
    const now = Date.now();
    if (cachedBusiness && (now - lastBusinessFetchTime) < CACHE_TTL) {
        return cachedBusiness;
    }

    try {
        const response = await fetch(`${API_BASE_URL}/business`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        cachedBusiness = data.data || {};
        lastBusinessFetchTime = now;
        console.log('✅ تم جلب معلومات النشاط بنجاح');
        return cachedBusiness;
    } catch (error) {
        console.error('❌ خطأ في جلب معلومات النشاط:', error.message);
        return cachedBusiness || { name: 'نشاطنا', phone: null, google_map_url: null, working_hours: null };
    }
}

/**
 * 🔥 البحث عن منتج في جميع المستويات
 */
function findProductByName(searchText, items) {
    const results = [];
    const searchLower = searchText.toLowerCase();

    function search(items, parentName = '') {
        for (const item of items) {
            const nameLower = item.name.toLowerCase();
            // إذا كان الاسم يحتوي على النص أو العكس
            if (nameLower.includes(searchLower) || searchLower.includes(nameLower)) {
                results.push({ ...item, parentName });
            }
            if (item.children && item.children.length > 0) {
                search(item.children, item.name);
            }
        }
    }

    search(items);
    return results;
}

/**
 * 🔥 جلب المنتج النهائي (بدون أبناء)
 */
function getLeafProducts(items) {
    const leaves = [];
    function traverse(items, parentName = '') {
        for (const item of items) {
            if (!item.children || item.children.length === 0) {
                leaves.push({ ...item, parentName });
            } else {
                traverse(item.children, item.name);
            }
        }
    }
    traverse(items);
    return leaves;
}

/**
 * 🔥 البحث عن منتج بواسطة ID
 */
function findProductById(productId, items) {
    for (const item of items) {
        if (item.id === productId) return item;
        if (item.children) {
            const found = findProductById(productId, item.children);
            if (found) return found;
        }
    }
    return null;
}

/**
 * 🔥 إرسال الطلب المؤكَّد إلى الـ API الخاص بالنشاط (endpoint: /orders)
 * لا يوقف تأكيد الطلب للعميل أبداً حتى لو فشل الاتصال بالـ API — فقط يسجّل الخطأ بالـ console.
 */
async function createOrder({ customerName, customerPhone, details, serviceId }) {
    try {
        const body = new URLSearchParams();
        body.append('customer_name', customerName || '');
        body.append('customer_phone', customerPhone || '');
        body.append('details', typeof details === 'string' ? details : JSON.stringify(details || {}));
        body.append('service_id', String(serviceId ?? ''));

        const response = await fetch(`${API_BASE_URL}/orders`, {
            method: 'POST',
            body,
        });

        const data = await response.json().catch(() => null);

        if (!response.ok) {
            console.error('❌ فشل إرسال الطلب للـ API:', response.status, data);
            return { success: false, status: response.status, data };
        }

        console.log('✅ تم إرسال الطلب للـ API بنجاح:', JSON.stringify(data));
        return { success: true, data: data?.data || data };
    } catch (error) {
        console.error('❌ خطأ أثناء إرسال الطلب للـ API:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * 🔥 جلب طلبات عميل معيّن برقم جواله من endpoint "طلباتي" (my-orders).
 * يرجّع مصفوفة الطلبات (فاضية لو ما فيه طلبات)، أو null لو صار خطأ فعلي بالاتصال بالـ API.
 */
async function fetchMyOrders(phone) {
    try {
        const response = await fetch(`${API_BASE_URL}/my-orders?phone=${encodeURIComponent(phone)}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const json = await response.json();
        return Array.isArray(json.data) ? json.data : [];
    } catch (error) {
        console.error('❌ خطأ في جلب الطلبات (my-orders):', error.message);
        return null;
    }
}

module.exports = {
    fetchServices,
    fetchBusinessInfo,
    findProductByName,
    getLeafProducts,
    findProductById,
    invalidateCache,
    createOrder,
    fetchMyOrders,
};