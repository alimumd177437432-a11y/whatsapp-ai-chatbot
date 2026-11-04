console.log("🚀 جاري بدء تشغيل بوت الواتساب...");
const express = require('express');
const config = require('./config');
const usage = require('./usageTracker');
const {
    mainTemplateKeyboard,
    categoriesKeyboard,
    confirmationKeyboard,
    buildChildrenKeyboard,
    buildSuggestedProductsKeyboard,
} = require('./keyboards');
const { getSession, resetSession, hasSession, pushHistory, checkRateLimit } = require('./sessionManager');
const { fetchServices, fetchBusinessInfo, findProductById, invalidateCache, fetchMyOrders } = require('./apiClient');
const { chat, prefillFieldsFromMessage, transcribeVoice } = require('./ai');
const {
    startOrderFields,
    getCurrentFieldIndex,
    saveAnswer,
    applyEdit,
    buildOrderSummary,
    confirmOrder,
} = require('./orderManager');
const wa = require('./whatsappClient');

const app = express();
app.use(express.json());

// ==================================================================
// 🔥 طبقة توافق بسيطة: بدل ما نعيد كتابة كل دالة من الصفر بأسلوب مختلف،
// نبني "ctx" مبسّط بنفس الأسماء اللي كانت مستخدمة بنسخة تيليجرام (ctx.reply, ctx.chat.id...)
// بحيث كل منطق القرار (اللي ما إله علاقة بالمنصة أصلاً) ينسخ كما هو تماماً بدون أي تغيير.
// ==================================================================
function makeCtx(waId, customerName) {
    return {
        chat: { id: waId },
        from: { username: null, first_name: customerName || null, last_name: null },
        reply: (text, keyboard) => sendReply(waId, text, keyboard),
        sendChatAction: async () => {}, // واتساب ما عندها "يكتب الآن" بنفس آلية تيليجرام - تجاهل بأمان
    };
}

// 🔥 يحول وصف اللوحة (من keyboards.js) لاستدعاء فعلي بـ whatsappClient حسب نوعها
async function sendReply(waId, text, keyboard) {
    if (!keyboard) return wa.sendText(waId, text);
    if (keyboard.type === 'list') {
        return wa.sendList(waId, text || ' ', keyboard.buttonLabel, keyboard.rows);
    }
    if (keyboard.type === 'button') {
        return wa.sendButtons(waId, text, keyboard.buttons);
    }
    return wa.sendText(waId, text);
}

// ==================================================================
// 🔥 اسم العميل يُؤخذ تلقائياً من بروفايل واتساب (contacts[0].profile.name بالحمولة الواردة)
// ==================================================================
function getCustomerDisplayName(ctx) {
    return ctx.from?.first_name || 'عميل واتساب';
}

// ==================================================================
// عرض أزرار أبناء قسم/منتج
// ==================================================================
// (منقولة إلى keyboards.js كـ buildChildrenKeyboard - بدون أي تغيير بالمنطق، فقط الشكل النهائي يبنى بواتساب)

// ==================================================================
// اسأل عن "الحقل الحالي" بأسلوب طبيعي — نستخدمها لأول سؤال ولإكمال بقية الأسئلة
// ==================================================================
function formatFieldQuestion(fieldLabel) {
    const trimmed = String(fieldLabel || '').trim();
    if (trimmed.endsWith('؟') || trimmed.endsWith('?')) {
        return `📝 ${trimmed}`;
    }
    return `📝 ${trimmed}؟`;
}

async function askCurrentField(ctx, session) {
    const idx = getCurrentFieldIndex(session);
    if (idx === -1) return;

    const questionText = formatFieldQuestion(session.fields[idx]);

    pushHistory(ctx.chat.id, 'assistant', questionText);
    await ctx.reply(questionText);
}

// ==================================================================
// 🔥 حفظ إجابة الحقل الحالي والانتقال للخطوة التالية
// ==================================================================
async function advanceAfterFieldSaved(ctx, session) {
    const nextIndex = getCurrentFieldIndex(session);
    if (nextIndex === -1) {
        if (session.customerPhone) {
            session.step = 'confirming';
            const summary = buildOrderSummary(session);
            await ctx.reply(summary, confirmationKeyboard());
        } else {
            session.step = 'awaiting_phone';
            await ctx.reply('📱 قبل ما أأكد لك الطلب، أحتاج رقم جوالك للتواصل معك. ممكن ترسله؟');
        }
    } else {
        await askCurrentField(ctx, session);
    }
}

// ==================================================================
// معالجة اختيار منتج نهائي (بدون أبناء) - يبدأ جمع البيانات
// ==================================================================
async function handleProductSelection(ctx, session, product, originalText) {
    await startOrderFields(session, product);

    let prefilledCount = 0;
    if (originalText && originalText.trim()) {
        try {
            const preAnswers = await prefillFieldsFromMessage(session.fields, originalText);
            for (const a of preAnswers) {
                if (
                    a &&
                    typeof a.field_index === 'number' &&
                    a.field_index >= 0 &&
                    a.field_index < session.fields.length &&
                    a.value
                ) {
                    saveAnswer(session, a.field_index, a.value);
                    prefilledCount += 1;
                }
            }
        } catch (err) {
            console.error('❌ خطأ أثناء التعبئة المسبقة للحقول:', err.message);
        }
    }

    if (prefilledCount > 0) {
        const result = await chat(
            '[نظام داخلي] فهمنا من رسالة العميل تفاصيل عن طلبه محفوظة بحالة الطلب أعلاه (الحقول المؤكدة ✅ بقائمة الحقول). ' +
                'رحّب فيه ترحيباً قصيراً، وأكد له بجملة طبيعية ومختصرة إنك سجّلت اللي ذكره، وإنك بتكمل معه باقي التفاصيل الناقصة. ' +
                'لا تسأل عن أي حقل محدد بنفسك، فقط ترحيب وتأكيد عام مختصر.',
            session
        );
        pushHistory(ctx.chat.id, 'assistant', result.reply);
        await ctx.reply(result.reply);
    }

    await advanceAfterFieldSaved(ctx, session);
}

// ==================================================================
// بناء رد بيانات التواصل / الموقع من الـ API الحقيقية (بدون اختراع)
// ==================================================================
function buildContactReply(business) {
    const lines = [];
    lines.push(business.phone ? `📞 رقم التواصل: ${business.phone}` : '📞 ما عنا رقم هاتف متاح حالياً.');
    if (business.working_hours) lines.push(`🕒 ساعات العمل: ${business.working_hours}`);
    if (business.google_map_url) lines.push(`📍 الموقع: ${business.google_map_url}`);
    return lines.join('\n');
}

function buildLocationReply(business) {
    if (business.google_map_url) {
        return `📍 موقعنا على خرائط جوجل:\n${business.google_map_url}`;
    }
    return '📍 عذراً، ما عنا رابط موقع متاح حالياً. تقدر تتواصل معنا مباشرة وناخذ لك التفاصيل.';
}

// ==================================================================
// "طلباتي"
// ==================================================================
const ORDER_STATUS_EMOJI = {
    pending: '⏳',
    processing: '🔄',
    completed: '✅',
    delivered: '✅',
    cancelled: '❌',
    rejected: '❌',
};

function formatMyOrdersReply(orders) {
    if (!orders || orders.length === 0) {
        return '📋 ما لقينا أي طلبات مسجلة على رقمك حالياً.';
    }

    const shown = orders.slice(0, 10);

    const lines = shown.map((order) => {
        let total = null;
        try {
            const parsed = JSON.parse(order.details);
            total = parsed?.price?.total ?? null;
        } catch (_) {
            // تجاهل
        }

        const emoji = ORDER_STATUS_EMOJI[order.status] || '📌';
        const dateOnly = order.created_at ? String(order.created_at).split('T')[0] : '';
        const priceText = total !== null && total !== undefined ? ` — 💰 ${total} ${config.CURRENCY}` : '';

        return `${emoji} *${order.reference}*\n📦 ${order.service_name}${priceText}\n${order.status_label || order.status} • ${dateOnly}`;
    });

    let text = `📋 *آخر ${shown.length} من طلباتك:*\n\n${lines.join('\n\n')}`;
    if (orders.length > shown.length) {
        text += `\n\nℹ️ وعندك ${orders.length - shown.length} طلب أقدم من هذي.`;
    }
    return text;
}

async function sendMyOrders(ctx) {
    const session = getSession(ctx.chat.id);

    if (!session.customerPhone) {
        if (session.step === 'ordering' || session.step === 'confirming' || session.step === 'awaiting_phone') {
            await ctx.reply('📋 خلينا نكمل طلبك الحالي أول، وبعد ما تخلصه وتعطيني رقم جوالك بنقدر نجيب لك طلباتك القديمة كمان.');
            return;
        }

        session.step = 'awaiting_phone_for_orders';
        await ctx.reply('📋 ما لقينا رقم جوال محفوظ عندك بعد. ممكن تعطيني رقم جوالك عشان أدور على طلباتك؟ 📱');
        return;
    }

    await ctx.sendChatAction('typing');
    const orders = await fetchMyOrders(session.customerPhone);

    if (orders === null) {
        await ctx.reply('⚠️ صار خطأ بسيط بجلب طلباتك، جرب مرة ثانية بعد شوي.');
        return;
    }

    await ctx.reply(formatMyOrdersReply(orders));
}

// ==================================================================
// 🔥 توجيه ضغطات الأزرار/القوائم (بديل bot.action(...) من نسخة تيليجرام)
// ==================================================================
async function handleInteractiveId(ctx, id) {
    const session = getSession(ctx.chat.id);

    if (id === 'menu:order_service') {
        await ctx.reply('تفضل، شو الخدمة اللي تحتاجها؟ 👇', await categoriesKeyboard());
        return;
    }
    if (id === 'menu:my_orders') {
        await sendMyOrders(ctx);
        return;
    }
    if (id === 'menu:location') {
        const business = await fetchBusinessInfo();
        await ctx.reply(buildLocationReply(business));
        return;
    }
    if (id === 'menu:contact') {
        await ctx.reply('تفضل، اكتب اللي تحب تسأل عنه أو تحتاجه وبساعدك على طول 💬');
        return;
    }
    if (id === 'general_inquiry') {
        await ctx.reply('تفضل، اكتب لي سؤالك وأنا أجيبك 😊');
        return;
    }
    if (id === 'back_to_main') {
        resetSession(ctx.chat.id);
        await ctx.reply('🏠 القائمة الرئيسية:', await mainTemplateKeyboard());
        return;
    }
    if (id === 'retry_load') {
        invalidateCache();
        await fetchServices();
        await fetchBusinessInfo();
        await ctx.reply('تم تحديث الخدمات ✅', await mainTemplateKeyboard());
        return;
    }

    if (id === 'confirm:yes') {
        if (session.step !== 'confirming') {
            await ctx.reply('ما فيه طلب نشط حالياً.', await mainTemplateKeyboard());
            return;
        }
        if (!session.customerPhone) {
            session.step = 'awaiting_phone';
            await ctx.reply('📱 قبل التأكيد، أحتاج رقم جوالك للتواصل معك. تكتبه لي؟');
            return;
        }
        const { orderNumber } = await confirmOrder(session, {
            name: getCustomerDisplayName(ctx),
            phone: session.customerPhone,
        });
        usage.printSummary(ctx.chat.id);
        await ctx.reply(`✅ *تم تأكيد طلبك بنجاح!*\n\n🔢 رقم الطلب: ${orderNumber}\nراح يتواصل معك فريقنا قريباً 🙌`);
        await ctx.reply('تحب تسوي طلب جديد؟', await mainTemplateKeyboard());
        return;
    }

    if (id === 'confirm:edit') {
        if (session.step !== 'confirming') {
            await ctx.reply('ما فيه طلب نشط حالياً.', await mainTemplateKeyboard());
            return;
        }
        const result = await chat(
            '[نظام داخلي] العميل ضغط زر "تعديل". اسأله بأسلوب طبيعي ومختصر وش يبغى يعدل بالضبط من طلبه، ' +
                'واذكر له كمثال حقيقي واحد أو حقلين من حقول طلبه الفعلية المذكورة أعلاه (وليس مثالاً عاماً غير متعلق بطلبه).',
            session
        );
        pushHistory(ctx.chat.id, 'assistant', result.reply);
        await ctx.reply(result.reply);
        return;
    }

    if (id === 'confirm:contact') {
        const business = await fetchBusinessInfo();
        await ctx.reply(buildContactReply(business));
        return;
    }

    const serviceMatch = id.match(/^service:(\d+)$/);
    if (serviceMatch) {
        const serviceId = parseInt(serviceMatch[1]);
        const services = await fetchServices();
        const service = findProductById(serviceId, services);
        if (!service) {
            await ctx.reply('عذراً، هذه الخدمة غير متوفرة.', await mainTemplateKeyboard());
            return;
        }
        if (service.children && service.children.length > 0) {
            await ctx.reply(`اختر من قسم "${service.name}":`, buildChildrenKeyboard(service.children));
            return;
        }
        await handleProductSelection(ctx, session, service);
        return;
    }

    const productMatch = id.match(/^product:(\d+)$/);
    if (productMatch) {
        const productId = parseInt(productMatch[1]);
        const services = await fetchServices();
        const product = findProductById(productId, services);
        if (!product) {
            await ctx.reply('عذراً، هذا الخيار غير متوفر.', await mainTemplateKeyboard());
            return;
        }
        if (product.children && product.children.length > 0) {
            await ctx.reply(`اختر من قسم "${product.name}":`, buildChildrenKeyboard(product.children));
            return;
        }
        await handleProductSelection(ctx, session, product);
        return;
    }

    console.warn('⚠️ id غير معروف من زر/قائمة واتساب:', id);
}

// ==================================================================
// 🔥 المعالج المشترك لأي رسالة نصية (نفس منطق تيليجرام حرفياً - صفر تغيير هنا)
// ==================================================================
async function handleIncomingMessage(ctx, text) {
    const session = getSession(ctx.chat.id);

    const refreshKeywords = ['ريفرش', 'رفرش', 'تحديث', 'حدث البيانات', 'refresh'];
    if (refreshKeywords.includes(text.toLowerCase())) {
        invalidateCache();
        await fetchServices();
        await fetchBusinessInfo();
        await ctx.reply('✅ تم تحديث بيانات الخدمات من الـ API.', await mainTemplateKeyboard());
        return;
    }

    pushHistory(ctx.chat.id, 'user', text);
    await ctx.sendChatAction('typing');

    const { analysis } = await chat(text, session);
    pushHistory(ctx.chat.id, 'assistant', analysis.reply);

    switch (analysis.intent) {
        case 'start_order': {
            if (!analysis.productId) {
                await ctx.reply(analysis.reply);
                return;
            }
            const services = await fetchServices();
            const product = findProductById(analysis.productId, services);
            if (!product) {
                await ctx.reply('عذراً، ما لقيت هذا الخيار بالضبط، ممكن توضح أكثر؟');
                return;
            }
            if (product.children && product.children.length > 0) {
                await ctx.reply(`اختر من قسم "${product.name}":`, buildChildrenKeyboard(product.children));
                return;
            }
            await handleProductSelection(ctx, session, product, text);
            return;
        }

        case 'save_answer': {
            const expectedIndex = getCurrentFieldIndex(session);

            if (expectedIndex === -1) {
                await ctx.reply(analysis.reply);
                return;
            }

            if (!analysis.value || !String(analysis.value).trim()) {
                await ctx.reply(analysis.reply);
                await askCurrentField(ctx, session);
                return;
            }

            saveAnswer(session, expectedIndex, analysis.value);
            await ctx.reply(analysis.reply);
            await advanceAfterFieldSaved(ctx, session);
            return;
        }

        case 'save_phone': {
            const digitsOnly = String(analysis.value || text).replace(/[^0-9+]/g, '');

            if (session.step === 'awaiting_phone_for_orders') {
                if (digitsOnly.replace(/\+/g, '').length < 7) {
                    await ctx.reply('يرجى إرسال رقم جوال صحيح 📱 (بحد أدنى 7 أرقام)');
                    return;
                }
                session.customerPhone = digitsOnly;
                session.step = 'idle';
                await ctx.reply(analysis.reply);
                await sendMyOrders(ctx);
                return;
            }

            if (session.step !== 'awaiting_phone') {
                await ctx.reply(analysis.reply);
                return;
            }

            if (digitsOnly.replace(/\+/g, '').length < 7) {
                await ctx.reply('يرجى إرسال رقم جوال صحيح للتواصل معك 📱 (بحد أدنى 7 أرقام)');
                return;
            }

            session.customerPhone = digitsOnly;
            session.step = 'confirming';
            await ctx.reply(analysis.reply);
            const summary = buildOrderSummary(session);
            await ctx.reply(summary, confirmationKeyboard());
            return;
        }

        case 'edit_answer': {
            const editsList = Array.isArray(analysis.edits) && analysis.edits.length > 0
                ? analysis.edits
                : [{ field_index: analysis.fieldIndex, value: analysis.value }];

            let successCount = 0;
            for (const edit of editsList) {
                const ok = applyEdit(session, edit?.field_index, edit?.value ?? '');
                if (ok) successCount += 1;
            }

            if (successCount === 0) {
                await ctx.reply('ما قدرت أحدد الحقل المطلوب تعديله بالضبط، وضحه أكثر لو سمحت.');
                return;
            }

            await ctx.reply(analysis.reply);
            session.step = 'confirming';
            const summary = buildOrderSummary(session);
            await ctx.reply(summary, confirmationKeyboard());
            return;
        }

        case 'confirm_yes': {
            if (session.step === 'ordering' && getCurrentFieldIndex(session) !== -1) {
                const expectedIndex = getCurrentFieldIndex(session);
                saveAnswer(session, expectedIndex, analysis.value || text);
                await ctx.reply('تمام ✅');
                await advanceAfterFieldSaved(ctx, session);
                return;
            }

            if (session.step !== 'confirming') {
                await ctx.reply('تسلم! 🙏 لو احتجت أي شي ثاني، أنا موجود.', await mainTemplateKeyboard());
                return;
            }

            if (!session.customerPhone) {
                session.step = 'awaiting_phone';
                await ctx.reply('📱 قبل التأكيد، أحتاج رقم جوالك للتواصل معك. تكتبه لي؟');
                return;
            }

            const { orderNumber } = await confirmOrder(session, {
                name: getCustomerDisplayName(ctx),
                phone: session.customerPhone,
            });
            usage.printSummary(ctx.chat.id);
            await ctx.reply(`✅ *تم تأكيد طلبك بنجاح!*\n\n🔢 رقم الطلب: ${orderNumber}\nراح يتواصل معك فريقنا قريباً 🙌`);
            await ctx.reply('تحب تسوي طلب جديد؟', await mainTemplateKeyboard());
            return;
        }

        case 'confirm_edit': {
            await ctx.reply(analysis.reply);
            return;
        }

        case 'cancel': {
            resetSession(ctx.chat.id);
            await ctx.reply('تم إلغاء الطلب. كيف أقدر أخدمك؟', await mainTemplateKeyboard());
            return;
        }

        case 'show_menu': {
            await ctx.reply('🏠 القائمة الرئيسية:', await mainTemplateKeyboard());
            return;
        }

        case 'show_contact': {
            const business = await fetchBusinessInfo();
            await ctx.reply(buildContactReply(business));
            return;
        }

        case 'show_my_orders': {
            await sendMyOrders(ctx);
            return;
        }

        case 'browse_categories': {
            await ctx.reply('تفضل، شو الخدمة اللي تحتاجها؟ 👇', await categoriesKeyboard());
            return;
        }

        default: {
            await ctx.reply(analysis.reply);

            if (Array.isArray(analysis.suggestedProducts) && analysis.suggestedProducts.length > 0) {
                const kb = await buildSuggestedProductsKeyboard(analysis.suggestedProducts);
                if (kb) {
                    await ctx.reply('👇 اختر اللي يناسبك:', kb);
                }
            }

            if (session.step === 'ordering') {
                await askCurrentField(ctx, session);
            }
            return;
        }
    }
}

// ==================================================================
// 🔥 معالجة رسالة صوتية - نفس منطق تيليجرام تماماً، الفرق الوحيد هو طريقة تنزيل الملف
// (Media API بخطوتين بدل ctx.telegram.getFileLink المباشر)
// ==================================================================
async function handleVoiceMessage(ctx, mediaId) {
    if (!checkRateLimit(ctx.chat.id)) {
        await ctx.reply('تمهل شوي 🙏 وبعدين اكتب/سجّل، وبرد عليك على طول.');
        return;
    }
    try {
        await ctx.sendChatAction('typing');
        const session = getSession(ctx.chat.id);

        let promptHint = '';
        const currentIdx = getCurrentFieldIndex(session);
        if (currentIdx !== -1 && session.fields?.[currentIdx]) {
            const fieldLabel = session.fields[currentIdx];
            promptHint = fieldLabel;
            if (/كمية|عدد/.test(fieldLabel)) {
                promptHint += ' مثلاً: 200';
            }
        } else {
            const services = await fetchServices();
            promptHint = (services || []).map((s) => s.name).join('، ');
        }

        const audioBuffer = await wa.downloadMedia(mediaId);
        const transcribedText = await transcribeVoice(audioBuffer, 'voice.ogg', promptHint);

        if (!transcribedText) {
            await ctx.reply('ما قدرت أفهم الرسالة الصوتية 🙏، ممكن تعيد إرسالها أو تكتبها نص؟');
            return;
        }

        await handleIncomingMessage(ctx, transcribedText);
    } catch (err) {
        console.error('❌ خطأ أثناء معالجة الرسالة الصوتية:', err.message);
        await ctx.reply('صار خطأ بسيط بمعالجة الرسالة الصوتية 🙏، جرب مرة ثانية أو اكتبها نص.');
    }
}

// ==================================================================
// 🔥 الترحيب - بديل bot.start() : واتساب ما عندها أمر /start، فنكتشف "أول رسالة"
// عبر عدم وجود session سابقة لهذا الرقم
// ==================================================================
async function sendWelcome(ctx) {
    resetSession(ctx.chat.id);
    const business = await fetchBusinessInfo();
    await ctx.reply(
        `يا هلا بك في ${business.name || config.SHOP_NAME}! 👋\nكيف نقدر نخدمك اليوم؟`,
        await mainTemplateKeyboard()
    );
}

// ==================================================================
// 🌐 الويب هوك
// ==================================================================

// GET - خطوة التحقق (verification) اللي تطلبها ميتا مرة وحدة وقت تسجيل الرابط
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.WHATSAPP_VERIFY_TOKEN) {
        console.log('✅ تم التحقق من الـ webhook بنجاح');
        return res.status(200).send(challenge);
    }
    console.warn('⚠️ محاولة تحقق فاشلة على الـ webhook (verify token غير مطابق)');
    return res.sendStatus(403);
});

// POST - استقبال الرسائل الفعلية من العملاء
app.post('/webhook', async (req, res) => {
    // 🔥 لازم نرد 200 فوراً لواتساب - وإلا بتعتبر التسليم فشل وبتعيد إرسال نفس الحدث بشكل متكرر
    res.sendStatus(200);

    try {
        // 🔎 تشخيص مؤقت - يوري كامل الحمولة الواردة من واتساب بالتيرمنال
        console.log('📥 وصلت حمولة webhook:', JSON.stringify(req.body, null, 2));

        const value = req.body?.entry?.[0]?.changes?.[0]?.value;
        const message = value?.messages?.[0];
        if (!message) {
            console.log('ℹ️ ما فيه message فعلي بهاي الحمولة (غالباً إشعار حالة delivered/read) - تم تجاهلها');
            return;
        }

        const waId = message.from;
        usage.bindChat(waId);
        const contact = value.contacts?.[0];
        const customerName = contact?.profile?.name || null;
        const ctx = makeCtx(waId, customerName);

        wa.markAsRead(message.id).catch(() => {});

        // أول رسالة توصل من رقم جديد بالكامل = ترحيب (بديل /start)
        if (!hasSession(waId)) {
            await sendWelcome(ctx);
            return;
        }

        if (message.type === 'text') {
            if (!checkRateLimit(waId)) {
                await ctx.reply('تمهل شوي 🙏 وبعدين اكتب، وبرد عليك على طول.');
                return;
            }
            await handleIncomingMessage(ctx, message.text.body.trim());
            return;
        }

        if (message.type === 'interactive') {
            const id = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
            if (id) await handleInteractiveId(ctx, id);
            return;
        }

        if (message.type === 'audio') {
            await handleVoiceMessage(ctx, message.audio.id);
            return;
        }

        if (message.type === 'image') {
            await ctx.reply('📷 وصلتني الصورة! اكتب لي شو تحتاج بخصوصها وبساعدك 🙂');
            return;
        }

        await ctx.reply('استلمت رسالتك، اكتب لي كيف أقدر أساعدك 🙂');
    } catch (err) {
        console.error('❌ خطأ أثناء معالجة رسالة واتساب:', err);
    }
});

// ==================================================================
// شبكة أمان أخيرة لأي خطأ غير متوقع - نفس فلسفة نسخة تيليجرام
// ==================================================================
process.on('unhandledRejection', (err) => {
    console.error('❌ خطأ غير متوقع (unhandledRejection):', err);
});
process.on('uncaughtException', (err) => {
    console.error('❌ خطأ غير متوقع (uncaughtException):', err);
});

app.listen(config.PORT, () => {
    console.log(`🤖 بوت واتساب يعمل الآن على المنفذ ${config.PORT}`);
    console.log(`📡 رابط الـ webhook (بعد نشره): https://your-domain-or-ngrok/webhook`);
});