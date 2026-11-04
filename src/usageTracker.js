const { AsyncLocalStorage } = require('async_hooks');

// 🔥 عدّاد استهلاك التوكنز لكل محادثة (لكل رقم واتساب لحاله)
// - بيعدّ توكنز الإدخال (prompt) والإخراج (completion) من كل استدعاء لـ OpenAI تلقائياً
// - بيطبع سطر بعد كل استدعاء + ملخص كامل لما الطلب يتأكد
// - الأسعار تحت تقدر تغيّرها من ملف .env (سعر كل مليون توكن بالدولار)، والقيم الافتراضية
//   هي فقط تقدير تقريبي — راجع صفحة أسعار OpenAI الرسمية للموديل المستخدم عندك.
const PRICE_INPUT_PER_1M = parseFloat(process.env.PRICE_INPUT_PER_1M) || 0.15;
const PRICE_OUTPUT_PER_1M = parseFloat(process.env.PRICE_OUTPUT_PER_1M) || 0.6;

const als = new AsyncLocalStorage();
const buckets = new Map(); // chatId -> إحصائيات المحادثة

function bindChat(chatId) {
    // يربط باقي معالجة هذه الرسالة (كل الـ await اللي بعدها) بنفس المحادثة
    als.enterWith({ chatId });
}

function getBucket(chatId) {
    if (!buckets.has(chatId)) {
        buckets.set(chatId, { input: 0, output: 0, cached: 0, calls: 0, voiceCalls: 0, byLabel: {} });
    }
    return buckets.get(chatId);
}

function record(label, usage) {
    if (!usage) return;
    const chatId = als.getStore()?.chatId || 'غير معروف';
    const b = getBucket(chatId);

    const input = usage.prompt_tokens || 0;
    const output = usage.completion_tokens || 0;
    const cached = usage.prompt_tokens_details?.cached_tokens || 0;

    b.input += input;
    b.output += output;
    b.cached += cached;
    b.calls += 1;
    b.byLabel[label] = b.byLabel[label] || { calls: 0, input: 0, output: 0 };
    b.byLabel[label].calls += 1;
    b.byLabel[label].input += input;
    b.byLabel[label].output += output;

    console.log(
        `🔢 [${label}] إدخال: ${input} | إخراج: ${output}  ← المجموع لهالمحادثة لحد الآن: ${b.input} إدخال / ${b.output} إخراج`
    );
}

function wrapOpenAIClient(client) {
    const completions = client.chat.completions;
    const originalCreate = completions.create.bind(completions);
    completions.create = async (params, options) => {
        const response = await originalCreate(params, options);
        try {
            const label = params?.tool_choice?.function?.name || 'chat';
            record(label, response?.usage);
        } catch (_) {
            // العدّاد ما لازم يكسر البوت أبداً
        }
        return response;
    };

    // Whisper (الرسائل الصوتية) بيتحاسب بالدقيقة مو بالتوكن — منعدّ بس عدد المرات
    const transcriptions = client.audio?.transcriptions;
    if (transcriptions) {
        const originalTranscribe = transcriptions.create.bind(transcriptions);
        transcriptions.create = async (params, options) => {
            const result = await originalTranscribe(params, options);
            try {
                const chatId = als.getStore()?.chatId || 'غير معروف';
                getBucket(chatId).voiceCalls += 1;
            } catch (_) {}
            return result;
        };
    }
}

function printSummary(chatId, { reset = true } = {}) {
    const b = buckets.get(chatId);
    if (!b || b.calls === 0) {
        console.log('🔢 ما في استهلاك مسجّل لهالمحادثة.');
        return null;
    }

    const cost = (b.input * PRICE_INPUT_PER_1M + b.output * PRICE_OUTPUT_PER_1M) / 1_000_000;

    console.log('\n==================== 🧮 ملخص استهلاك المحادثة ====================');
    console.log(`👤 المحادثة: ${chatId}`);
    console.log(`📞 عدد استدعاءات الذكاء الاصطناعي: ${b.calls}`);
    console.log(`⬇️  توكنز الإدخال  (Input) : ${b.input}${b.cached ? `  (منها ${b.cached} مخزّنة/Cached)` : ''}`);
    console.log(`⬆️  توكنز الإخراج  (Output): ${b.output}`);
    console.log(`∑  الإجمالي: ${b.input + b.output}`);
    for (const [label, s] of Object.entries(b.byLabel)) {
        console.log(`   • ${label}: ${s.calls} استدعاء — إدخال ${s.input} / إخراج ${s.output}`);
    }
    if (b.voiceCalls) {
        console.log(`🎤 رسائل صوتية (Whisper): ${b.voiceCalls} — تتحاسب بالدقيقة مو بالتوكن`);
    }
    console.log(
        `💵 التكلفة التقريبية: $${cost.toFixed(5)}  (على أساس $${PRICE_INPUT_PER_1M} إدخال و $${PRICE_OUTPUT_PER_1M} إخراج لكل مليون توكن)`
    );
    console.log('===================================================================\n');

    const result = { calls: b.calls, input: b.input, output: b.output, cost };
    if (reset) buckets.delete(chatId);
    return result;
}

module.exports = { bindChat, wrapOpenAIClient, printSummary };