const { Telegraf, Markup } = require('telegraf');
const fetch = require('node-fetch');
const config = require('./config');
const { mainTemplateKeyboard, categoriesKeyboard, confirmationKeyboard } = require('./keyboards');
const { getSession, resetSession, pushHistory, checkRateLimit } = require('./sessionManager');
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

const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

// ==================================================================
// 🔥 رد آمن على الزر: لو الـ callback query صارت قديمة (المستخدم انتظر
// كثير أو ضغط زر تاني بسرعة أثناء ما البوت مشغول برد سابق)، تيليجرام
// بيرفض الرد عليها ويرمي خطأ. هذه الدالة تمسك هذا الخطأ بالذات وتكمل
// عادي، بدل ما توقف باقي كود الزر (فتح المنتج، عرض الأسعار...).
// ==================================================================
async function safeAnswerCbQuery(ctx, text) {
    try {
        await ctx.answerCbQuery(text);
    } catch (err) {
        console.warn('⚠️ تجاهل: query انتهت صلاحيتها قبل الرد عليها —', err.description || err.message);
    }
}

// ==================================================================
// 🔥 اسم العميل يُؤخذ تلقائياً من حساب تيليجرام (بدون سؤاله) — يوزرنيم أولاً، وإلا الاسم الظاهر
// ==================================================================
function getCustomerDisplayName(ctx) {
    if (ctx.from?.username) return `@${ctx.from.username}`;
    const fullName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ');
    return fullName || 'عميل تيليجرام';
}

// ==================================================================
// /start
// ==================================================================
bot.start(async (ctx) => {
    resetSession(ctx.chat.id);
    const business = await fetchBusinessInfo();
    await ctx.reply(
        `يا هلا بك في ${business.name || config.SHOP_NAME}! 👋\nكيف نقدر نخدمك اليوم؟`,
        await mainTemplateKeyboard()
    );
});

// ==================================================================
// /refresh — إجبار البوت يجيب أحدث نسخة من الـ API فوراً (مفيد بعد إضافة/تعديل منتج)
// ==================================================================
bot.command('refresh', async (ctx) => {
    invalidateCache();
    await fetchServices();
    await fetchBusinessInfo();
    await ctx.reply('✅ تم تحديث بيانات الخدمات من الـ API.', await mainTemplateKeyboard());
});

// ==================================================================
// عرض أزرار أبناء قسم/منتج
// ==================================================================
function buildChildrenKeyboard(children) {
    const buttons = children.map(child => Markup.button.callback(child.name, `product:${child.id}`));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) {
        rows.push(buttons.slice(i, i + 2));
    }
    rows.push([Markup.button.callback('🏠 رجوع', 'back_to_main')]);
    return Markup.inlineKeyboard(rows);
}

// ==================================================================
// 🔥 تحويل قائمة IDs منتجات مقترحة من الذكاء الاصطناعي لأزرار حقيقية (بدل سردها كنص)
// تستخدم نفس مسار "product:ID" الموجود أصلاً، فأي منتج (نهائي أو قسم فيه أبناء) بيشتغل تلقائياً
// ==================================================================
async function buildSuggestedProductsKeyboard(productIds) {
    if (!Array.isArray(productIds) || productIds.length === 0) return null;

    const services = await fetchServices();
    const buttons = [];
    for (const id of productIds) {
        const product = findProductById(id, services);
        if (product) {
            buttons.push(Markup.button.callback(product.name, `product:${product.id}`));
        }
    }
    if (!buttons.length) return null;

    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) {
        rows.push(buttons.slice(i, i + 2));
    }
    return Markup.inlineKeyboard(rows);
}

// ==================================================================
// القائمة الرئيسية - اختيار قسم
// ==================================================================
bot.action(/^service:(\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const serviceId = parseInt(ctx.match[1]);
    const session = getSession(ctx.chat.id);
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
});

// ==================================================================
// اختيار منتج (يشمل التنقل داخل الأقسام الفرعية)
// ==================================================================
bot.action(/^product:(\d+)$/, async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const productId = parseInt(ctx.match[1]);
    const session = getSession(ctx.chat.id);
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
});

// ==================================================================
// اسأل عن "الحقل الحالي" بأسلوب طبيعي — نستخدمها لأول سؤال ولإكمال بقية الأسئلة
// (مقصود عن قصد تكون خطوة منفصلة عن تحليل رد العميل، عشان تضمن دايماً استمرار الأسئلة)
// ==================================================================
// ==================================================================
// 🔥 يصيغ نص الحقل كسؤال جاهز — يضيف "؟" فقط لو النص ما ينتهي بعلامة استفهام أصلاً
// ==================================================================
function formatFieldQuestion(fieldLabel) {
    const trimmed = String(fieldLabel || '').trim();
    if (trimmed.endsWith('؟') || trimmed.endsWith('?')) {
        return `📝 ${trimmed}`;
    }
    return `📝 ${trimmed}؟`;
}

// ==================================================================
// اسأل عن "الحقل الحالي" — نص ثابت مسحوب مباشرة من بيانات المنتج الحقيقية (بدون أي استدعاء AI).
// هذا يمنع نهائياً مشكلة "توقف البوت" اللي كانت تصير أحياناً لو الذكاء الاصطناعي التبس بين
// تعليمات صياغة سؤال جديد وتعليمات "رد قصير تمام" المخصصة لحالات ثانية، فيطلع رد فاضي بدل السؤال.
// ==================================================================
async function askCurrentField(ctx, session) {
    const idx = getCurrentFieldIndex(session);
    if (idx === -1) return;

    const questionText = formatFieldQuestion(session.fields[idx]);

    pushHistory(ctx.chat.id, 'assistant', questionText);
    await ctx.reply(questionText);
}

// ==================================================================
// 🔥 حفظ إجابة الحقل الحالي والانتقال للخطوة التالية (سؤال جديد / رقم الجوال / ملخص التأكيد)
// دالة مشتركة تُستخدم من save_answer العادي، وأيضاً كشبكة أمان لو الذكاء الاصطناعي
// صنّف رد على حقل معلّق (زي "نعم" على "هل التصميم جاهز؟") على إنه تأكيد نهائي بالغلط.
// ==================================================================
async function advanceAfterFieldSaved(ctx, session) {
    const nextIndex = getCurrentFieldIndex(session);
    if (nextIndex === -1) {
        // 🔥 اكتملت بيانات المنتج — قبل عرض ملخص التأكيد، لازم نأخذ رقم جوال العميل أولاً (مرة واحدة فقط)
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

    // 🔥 لو العميل كتب طلبه كامل برسالة واحدة (منتج + تفاصيل مع بعض)، نحاول نستخرج
    // أي إجابات مذكورة صراحة بنفس الرسالة ونحفظها تلقائياً، بحيث نسأل بس عن الناقص فعلاً.
    // (متاحة فقط لما يجي الاختيار من رسالة نص العميل - مو من ضغط زر، اللي ما فيه نص إضافي أصلاً)
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

    // 🔥 لو فهمنا تفاصيل من نفس رسالة العميل الأولى، نرحب فيه ونأكد له بأسلوب طبيعي
    // شو فهمناه (عبر الذكاء الاصطناعي) قبل ما نكمل بباقي الأسئلة الناقصة
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
// 🔥 أزرار القائمة الرئيسية الجديدة (التيمبلت الأول)
// ==================================================================
bot.action('menu:order_service', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.reply('تفضل، شو الخدمة اللي تحتاجها؟ 👇', await categoriesKeyboard());
});

bot.action('menu:my_orders', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await sendMyOrders(ctx);
});

bot.action('menu:location', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const business = await fetchBusinessInfo();
    await ctx.reply(buildLocationReply(business));
});

bot.action('menu:contact', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    // 🔥 "التواصل معنا مباشرة" = فتح دردشة حرة مع المساعد الذكي (مش عرض رقم هاتف)
    await ctx.reply('تفضل، اكتب اللي تحب تسأل عنه أو تحتاجه وبساعدك على طول 💬');
});

// ==================================================================
// استفسار عام
// ==================================================================
bot.action('general_inquiry', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    await ctx.reply('تفضل، اكتب لي سؤالك وأنا أجيبك 😊');
});

// ==================================================================
// رجوع للقائمة الرئيسية
// ==================================================================
bot.action('back_to_main', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    resetSession(ctx.chat.id);
    await ctx.reply('🏠 القائمة الرئيسية:', await mainTemplateKeyboard());
});

// ==================================================================
// تأكيد الطلب (زر)
// ==================================================================
bot.action('confirm:yes', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const session = getSession(ctx.chat.id);

    if (session.step !== 'confirming') {
        await ctx.reply('ما فيه طلب نشط حالياً.', await mainTemplateKeyboard());
        return;
    }

    // 🔒 لا تأكيد بدون رقم جوال العميل — شرط أساسي قبل إرسال الطلب
    if (!session.customerPhone) {
        session.step = 'awaiting_phone';
        await ctx.reply('📱 قبل التأكيد، أحتاج رقم جوالك للتواصل معك. تكتبه لي؟');
        return;
    }

    const { orderNumber } = await confirmOrder(session, {
        name: getCustomerDisplayName(ctx),
        phone: session.customerPhone,
    });
    await ctx.reply(
        `✅ **تم تأكيد طلبك بنجاح!**\n\n🔢 رقم الطلب: ${orderNumber}\nراح يتواصل معك فريقنا قريباً 🙌`
    );
    await ctx.reply('تحب تسوي طلب جديد؟', await mainTemplateKeyboard());
});

// ==================================================================
// تعديل الطلب (زر) - يبقى بمرحلة confirming وينتظر تفاصيل التعديل كنص حر
// ==================================================================
bot.action('confirm:edit', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const session = getSession(ctx.chat.id);

    if (session.step !== 'confirming') {
        await ctx.reply('ما فيه طلب نشط حالياً.', await mainTemplateKeyboard());
        return;
    }

    // 🔥 سؤال ديناميكي مبني على تفاصيل الطلب الفعلية (بدل رسالة ثابتة بمثال قد لا يمت لحقول هذا الطلب بصلة)
    const result = await chat(
        '[نظام داخلي] العميل ضغط زر "تعديل". اسأله بأسلوب طبيعي ومختصر وش يبغى يعدل بالضبط من طلبه، ' +
            'واذكر له كمثال حقيقي واحد أو حقلين من حقول طلبه الفعلية المذكورة أعلاه (وليس مثالاً عاماً غير متعلق بطلبه).',
        session
    );
    pushHistory(ctx.chat.id, 'assistant', result.reply);
    await ctx.reply(result.reply);
});

// ==================================================================
// بناء رد بيانات التواصل الحقيقية من الـ API (بدون اختراع أرقام أو أوقات وهمية)
// ==================================================================
function buildContactReply(business) {
    const lines = [];
    lines.push(business.phone ? `📞 رقم التواصل: ${business.phone}` : '📞 ما عنا رقم هاتف متاح حالياً.');
    if (business.working_hours) lines.push(`🕒 ساعات العمل: ${business.working_hours}`);
    if (business.google_map_url) lines.push(`📍 الموقع: ${business.google_map_url}`);
    return lines.join('\n');
}

// ==================================================================
// 🔥 بناء رد الموقع فقط (زر "📍 موقعنا") - من بيانات الـ API الحقيقية بدون اختراع
// ==================================================================
function buildLocationReply(business) {
    if (business.google_map_url) {
        return `📍 موقعنا على خرائط جوجل:\n${business.google_map_url}`;
    }
    return '📍 عذراً، ما عنا رابط موقع متاح حالياً. تقدر تتواصل معنا مباشرة وناخذ لك التفاصيل.';
}

// ==================================================================
// 🔥 "طلباتي" - عرض نظيف: بس المعلومات المفيدة للعميل (رقم مرجعي حقيقي، المنتج، الحالة، السعر، التاريخ)
// وبدون تفاصيل داخلية (لا الـ id الداخلي، لا رقم TRX الداخلي غير الفريد، لا كل إجابات الحقول).
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
            // تجاهل - السعر تفصيل إضافي مش أساسي لعرض القائمة
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
        // 🔒 ما نقاطع طلب نشط قيد التعبئة عشان نطلب رقم لعرض الطلبات القديمة - نكمل الحالي أولاً
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
// التواصل مع صاحب النشاط
// ==================================================================
bot.action('confirm:contact', async (ctx) => {
    await safeAnswerCbQuery(ctx);
    const business = await fetchBusinessInfo();
    await ctx.reply(buildContactReply(business));
});

// ==================================================================
// إعادة تحميل الخدمات
// ==================================================================
bot.action('retry_load', async (ctx) => {
    await safeAnswerCbQuery(ctx, 'جاري إعادة التحميل...');
    invalidateCache();
    await fetchServices();
    await fetchBusinessInfo();
    await ctx.reply('تم تحديث الخدمات ✅', await mainTemplateKeyboard());
});

// ==================================================================
// الصور
// ==================================================================
bot.on('photo', async (ctx) => {
    await ctx.reply('📷 وصلتني الصورة! اكتب لي شو تحتاج بخصوصها وبساعدك 🙂');
});

// ==================================================================
// النصوص - قلب البوت: كل رسالة تمر على الـ AI وهو من يقرر الإجراء
// ==================================================================
bot.on('text', async (ctx) => {
    // 🔥 حد أقصى للرسائل قبل أي استدعاء AI (حماية من استهلاك مفرط للرصيد المشترك)
    if (!checkRateLimit(ctx.chat.id)) {
        await ctx.reply('تمهل شوي 🙏 وبعدين اكتب، وبرد عليك على طول.');
        return;
    }
    const text = ctx.message.text.trim();
    await handleIncomingMessage(ctx, text);
});

// ==================================================================
// 🔥 دعم الرسائل الصوتية (Voice) - يشتغل بأي مكان بالمحادثة (سؤال، جواب، استفسار...)
// نحمّل الملف الصوتي من تيليجرام، نحوّله لنص عبر Whisper، وبعدها نمرره لنفس
// مسار معالجة الرسائل النصية بالضبط - بدون أي فرق بالمنطق أو الدقة.
// ==================================================================
bot.on('voice', async (ctx) => {
    // 🔥 نفس حد الرسائل الأقصى - قبل أي تكلفة فعلية (حتى قبل تحميل/تحويل الصوت نفسه)
    if (!checkRateLimit(ctx.chat.id)) {
        await ctx.reply('تمهل شوي 🙏 وبعدين اكتب/سجّل، وبرد عليك على طول.');
        return;
    }
    try {
        await ctx.sendChatAction('typing');

        const session = getSession(ctx.chat.id);

        // 🔥 تلميح قصير جداً لـ Whisper: السؤال الحالي المطروح فعلياً لو فيه طلب نشط، وإلا تلميح
        // ديناميكي مبني من أسماء الأقسام الحقيقية لهذا النشاط بالذات (من الـ API مباشرة - بدون
        // أي قائمة مصطلحات ثابتة بالكود، فيشتغل صح تلقائياً لأي نوع نشاط: مطبعة، عيادة، أي شي).
        // خلي التلميح قصير جداً دايماً - تلميح طويل مع تسجيل صوتي قصير بيخلي Whisper "يعتمد" عليه
        // بدل الصوت الفعلي.
        let promptHint = '';
        const currentIdx = getCurrentFieldIndex(session);
        if (currentIdx !== -1 && session.fields?.[currentIdx]) {
            const fieldLabel = session.fields[currentIdx];
            promptHint = fieldLabel;
            // 🔥 لو الحقل رقمي (كمية/عدد)، نضيف مثال رقمي قصير يساعد Whisper يتوقع رقماً
            // بدل ما يسمع كلمة قريبة الصوت غلط (زي "200" تنسمع "ممتاز").
            if (/كمية|عدد/.test(fieldLabel)) {
                promptHint += ' مثلاً: 200';
            }
        } else {
            const services = await fetchServices();
            promptHint = (services || []).map((s) => s.name).join('، ');
        }

        const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
        const fileUrl = typeof fileLink === 'string' ? fileLink : fileLink.href;
        const response = await fetch(fileUrl);
        const audioBuffer = Buffer.from(await response.arrayBuffer());

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
});

// ==================================================================
// 🔥 المعالج المشترك لأي رسالة نصية توصل للبوت - سواء مكتوبة مباشرة من العميل،
// أو نص ناتج عن تحويل رسالة صوتية (Voice) لنص. نفس المنطق بالضبط بدون أي فرق،
// عشان الصوت يشتغل بنفس دقة وسلوك النص تمامًا.
// ==================================================================
async function handleIncomingMessage(ctx, text) {
    const session = getSession(ctx.chat.id);

    // اختصار سريع للتحديث بدون المرور على الـ AI (توفير استدعاء API غير ضروري)
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
        // ------------------------------------------------------------
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

        // ------------------------------------------------------------
        case 'save_answer': {
            const expectedIndex = getCurrentFieldIndex(session);

            if (expectedIndex === -1) {
                // ما فيه حقل معلّق أصلاً (اكتملت البيانات أو ما فيه طلب نشط)
                await ctx.reply(analysis.reply);
                return;
            }

            if (!analysis.value || !String(analysis.value).trim()) {
                // صنّف الـ AI الرد كإجابة لكن ما قدر يستخرج قيمة واضحة منه - نعيد طرح نفس السؤال بدل ما نتخطاه بقيمة فاضية
                await ctx.reply(analysis.reply);
                await askCurrentField(ctx, session);
                return;
            }

            // 🔥 نثق دائماً بالحقل الحالي المحسوب برمجياً (expectedIndex) بدل رقم الحقل اللي يرجعه الذكاء الاصطناعي —
            // هذا يمنع مشكلة "تكرار نفس السؤال" اللي تصير لو الموديل أخطأ برقم الحقل (field_index) عرضياً رغم إن قيمة العميل صحيحة
            saveAnswer(session, expectedIndex, analysis.value);
            await ctx.reply(analysis.reply);
            await advanceAfterFieldSaved(ctx, session);
            return;
        }

        // ------------------------------------------------------------
        case 'save_phone': {
            const digitsOnly = String(analysis.value || text).replace(/[^0-9+]/g, '');

            // 🔥 حالة "طلباتي": ننتظر رقم الجوال بس عشان نجيب طلباته، مش عشان نأكد طلب جديد
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
                // إجراء احتياطي: ما فيه طلب ينتظر رقم جوال حالياً
                await ctx.reply(analysis.reply);
                return;
            }

            if (digitsOnly.replace(/\+/g, '').length < 7) {
                // الذكاء الاصطناعي صنّفها كرقم جوال لكنها غير صالحة فعلياً - نطلب رقماً صحيحاً
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

        // ------------------------------------------------------------
        case 'edit_answer': {
            // 🔥 يدعم تعديل أكثر من حقل بنفس الرسالة (لو الـ AI رجّع مصفوفة edits)،
            // وإذا مافيه مصفوفة يرجع للسلوك القديم: تعديل حقل واحد من field_index/value
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

        // ------------------------------------------------------------
        case 'confirm_yes': {
            // 🛡️ شبكة أمان: لو الذكاء الاصطناعي غلط وفسّر رد على حقل معلّق (زي "نعم" على "هل التصميم جاهز؟")
            // على إنه تأكيد نهائي للطلب، نعالجه كإجابة عادية على الحقل الحالي بدل ما نوقف العميل
            // بردّ "ما فيه طلب نشط" (وهي بالضبط مشكلة كانت تصير قبل هالتعديل).
            if (session.step === 'ordering' && getCurrentFieldIndex(session) !== -1) {
                const expectedIndex = getCurrentFieldIndex(session);
                saveAnswer(session, expectedIndex, analysis.value || text);
                await ctx.reply('تمام ✅');
                await advanceAfterFieldSaved(ctx, session);
                return;
            }

            if (session.step !== 'confirming') {
                // 🔥 الذكاء الاصطناعي أحياناً يصنّف كلام عادي (زي "تمام" أو "شكراً") كـ confirm_yes
                // حتى لو ما فيه طلب فعلي ينتظر تأكيد (مثلاً بعد ما يخلص الطلب، أو بمحادثة عادية).
                // بدل رد سلبي "ما فيه طلب نشط" اللي يبان وكأنه صار خطأ، نرد برد ودّي طبيعي.
                await ctx.reply('تسلم! 🙏 لو احتجت أي شي ثاني، أنا موجود.', await mainTemplateKeyboard());
                return;
            }

            // 🔒 لا تأكيد بدون رقم جوال العميل — شرط أساسي قبل إرسال الطلب
            if (!session.customerPhone) {
                session.step = 'awaiting_phone';
                await ctx.reply('📱 قبل التأكيد، أحتاج رقم جوالك للتواصل معك. تكتبه لي؟');
                return;
            }

            const { orderNumber } = await confirmOrder(session, {
                name: getCustomerDisplayName(ctx),
                phone: session.customerPhone,
            });
            await ctx.reply(
                `✅ **تم تأكيد طلبك بنجاح!**\n\n🔢 رقم الطلب: ${orderNumber}\nراح يتواصل معك فريقنا قريباً 🙌`
            );
            await ctx.reply('تحب تسوي طلب جديد؟', await mainTemplateKeyboard());
            return;
        }

        // ------------------------------------------------------------
        case 'confirm_edit': {
            await ctx.reply(analysis.reply);
            return;
        }

        // ------------------------------------------------------------
        case 'cancel': {
            resetSession(ctx.chat.id);
            await ctx.reply('تم إلغاء الطلب. كيف أقدر أخدمك؟', await mainTemplateKeyboard());
            return;
        }

        // ------------------------------------------------------------
        case 'show_menu': {
            await ctx.reply('🏠 القائمة الرئيسية:', await mainTemplateKeyboard());
            return;
        }

        // ------------------------------------------------------------
        case 'show_contact': {
            const business = await fetchBusinessInfo();
            await ctx.reply(buildContactReply(business));
            return;
        }

        // ------------------------------------------------------------
        case 'show_my_orders': {
            await sendMyOrders(ctx);
            return;
        }

        // ------------------------------------------------------------
        case 'browse_categories': {
            // 🔥 طلب عام تماماً بدون أي تحديد منتج/قسم - نفس سلوك زر "📋 اطلب خدمة" بالضبط
            await ctx.reply('تفضل، شو الخدمة اللي تحتاجها؟ 👇', await categoriesKeyboard());
            return;
        }

        // ------------------------------------------------------------
        default: {
            // chat / أي كلام خارج السياق: نجاوب على كلام العميل، وإذا فيه طلب نشط نعيد السؤال المعلّق بأسلوب طبيعي
            await ctx.reply(analysis.reply);

            // 🔥 لو الذكاء الاصطناعي اقترح منتجات محددة، نحولها لأزرار حقيقية بدل ما تضل نص
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
// الأخطاء
// ==================================================================
bot.catch((err, ctx) => {
    console.error(`❌ خطأ:`, err);
    ctx.reply('عذراً، صار خطأ بسيط. جرب مرة ثانية.').catch(() => {});
});

// 🔥 شبكة أمان أخيرة: أي خطأ غير متوقع بأي مكان بالمشروع (خارج نطاق
// bot.catch نفسه) بيتسجل بس بالـ console ولا يوقف عملية Node.js نهائياً.
process.on('unhandledRejection', (err) => {
    console.error('❌ خطأ غير متوقع (unhandledRejection):', err);
});
process.on('uncaughtException', (err) => {
    console.error('❌ خطأ غير متوقع (uncaughtException):', err);
});

// ==================================================================
// الإطلاق
// ==================================================================
bot.launch().then(() => {
    console.log('🤖 البوت يعمل الآن...');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));