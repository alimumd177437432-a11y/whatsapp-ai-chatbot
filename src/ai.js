const OpenAI = require('openai');
const { OPENAI_API_KEY, OPENAI_MODEL, SHOP_NAME, BOT_DIALECT } = require('./config');
const { fetchServices, fetchBusinessInfo } = require('./apiClient');

const client = new OpenAI({ apiKey: OPENAI_API_KEY });
require('./usageTracker').wrapOpenAIClient(client);

// 🔥 أداة استخراج الحقول من نصوص prompt_if_you_need اللي ما بتتبع الصيغة القياسية (بدون "→")
const FIELD_EXTRACTION_TOOL = [
    {
        type: 'function',
        function: {
            name: 'extract_fields',
            description:
                'استخرج فقط الأسئلة/الحقول الصريحة المطلوب سؤال العميل عنها من نص تعليمات داخلية، بدون أي إضافة أو حذف أو اختراع.',
            parameters: {
                type: 'object',
                properties: {
                    fields: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'قائمة الأسئلة/الحقول كما وردت في النص بالضبط (أو بصياغة مطابقة تمامًا للمعنى فقط).',
                    },
                },
                required: ['fields'],
            },
        },
    },
];

/**
 * 🔥 استخراج الحقول بالذكاء الاصطناعي لأي prompt_if_you_need لا يتبع الصيغة القياسية "→ ... | ...".
 * يُستخدم فقط كـ fallback لما يفشل الاستخراج بالـ regex في orderManager.js.
 * قاعدة صارمة: لا يُستخرج أي حقل غير مذكور صراحة بالنص (بدون اختراع أسئلة).
 */
async function extractFieldsWithAI(promptText) {
    const response = await client.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
            {
                role: 'system',
                content:
                    'أنت أداة استخراج بيانات دقيقة جداً. هذه تعليمات داخلية لموظف خدمة عملاء تصف ماذا يجب أن يسأل العميل عنه قبل إنشاء الطلب.\n' +
                    'مهمتك: استخرج فقط الأسئلة أو الحقول الصريحة المطلوب سؤال العميل عنها، كما وردت بالضبط في النص. ممنوع تماماً إضافة أي سؤال غير مذكور أو حذف أي سؤال مذكور.\n' +
                    'تجاهل تمامًا أي تعليمات ميتا لا تخص العميل مباشرة (مثل: طريقة إرسال الرد "كله برسالة واحدة"، "لا تخمّن الكمية أو المقاس"، اقتراح خدمة أخرى، تعليمات داخلية للبوت) — هذه ليست حقولاً يُسأل عنها العميل ولا تُدرَج في القائمة.',
            },
            { role: 'user', content: promptText },
        ],
        tools: FIELD_EXTRACTION_TOOL,
        tool_choice: { type: 'function', function: { name: 'extract_fields' } },
        temperature: 0,
        max_tokens: 400,
    });

    const toolCall = response.choices[0].message.tool_calls?.[0];
    if (!toolCall) return [];

    const args = JSON.parse(toolCall.function.arguments);
    return Array.isArray(args.fields) ? args.fields.map(f => String(f).trim()).filter(Boolean) : [];
}

// 🔥 أداة واحدة يُجبر عليها الموديل بكل رد، فيها نية العميل + الرد الطبيعي + أي بيانات لازمة
const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'handle_turn',
            description: 'حلّل رسالة العميل بناءً على حالة الطلب الحالية، وحدّد الإجراء المناسب + الرد الطبيعي المُرسل له.',
            parameters: {
                type: 'object',
                properties: {
                    intent: {
                        type: 'string',
                        enum: [
                            'start_order',
                            'save_answer',
                            'save_phone',
                            'edit_answer',
                            'confirm_yes',
                            'confirm_edit',
                            'cancel',
                            'show_menu',
                            'show_contact',
                            'show_my_orders',
                            'browse_categories',
                            'chat',
                        ],
                        description:
                            'start_order: عميل يريد طلب منتج جديد ومعروف. ' +
                            'save_answer: رد العميل إجابة واضحة على "الحقل الحالي" فقط. ' +
                            'save_phone: (فقط أثناء مرحلة انتظار رقم الجوال) رسالة العميل تحتوي رقم جوال واضح. ' +
                            'edit_answer: أثناء التأكيد، العميل حدد حقلاً موجوداً وقيمة جديدة له. ' +
                            'confirm_yes: العميل وافق على تأكيد الطلب. ' +
                            'confirm_edit: العميل يريد تعديل لكن لم يحدد ماذا بعد. ' +
                            'cancel: العميل يريد إلغاء الطلب الحالي. ' +
                            'show_menu: طلب الرجوع للقائمة الرئيسية. ' +
                            'show_contact: طلب رقم التواصل مع صاحب النشاط. ' +
                            'show_my_orders: العميل يسأل عن طلباته السابقة أو حالتها (مثل "وين طلباتي؟"، "شو صار بطلبي؟"، "بدي أشوف طلباتي"). ' +
                            'browse_categories: العميل عبّر عن رغبة عامة إنه يبغى يطلب شي جديد **والرسالة كاملة ما فيها أي اسم منتج أو قسم محدد إطلاقاً** (مثل "ابي اطلب طلب جديد" لوحدها، "طلب خدمة جديدة" لوحدها). لو نفس الرسالة فيها اسم منتج محدد حتى بعد عبارة عامة، هذا start_order مو browse_categories. ' +
                            'chat: أي سؤال أو كلام لا يندرج تحت ما سبق (مثل سؤال عن السعر أو استفسار عام).',
                    },
                    reply: {
                        type: 'string',
                        description: 'الرد الطبيعي المختصر جداً الذي سيصل للعميل مباشرة، بدون أي رموز أو أكواد برمجية داخله.',
                    },
                    product_id: {
                        type: 'integer',
                        description: 'رقم المنتج (ID) من القائمة عند intent=start_order فقط.',
                    },
                    field_index: {
                        type: 'integer',
                        description:
                            'رقم الحقل (index) عند intent=save_answer (يجب أن يطابق "الحقل الحالي" بالضبط) أو عند intent=edit_answer لتعديل حقل واحد بس (رقم الحقل المطلوب تعديله من القائمة المعروضة).',
                    },
                    value: {
                        type: 'string',
                        description: 'القيمة المستخرجة من كلام العميل عند intent=save_answer أو edit_answer (حقل واحد).',
                    },
                    edits: {
                        type: 'array',
                        description:
                            'استخدمها فقط مع intent=edit_answer لما العميل يذكر أكثر من حقل يبغى تعديله بنفس الرسالة (مثال: "غيّر الكمية لـ300 والمقاس لـ5×9"). كل عنصر فيها تعديل حقل واحد. لو تعديل حقل واحد بس بالرسالة، استخدم field_index/value العاديين وسيب هذي فاضية.',
                        items: {
                            type: 'object',
                            properties: {
                                field_index: { type: 'integer', description: 'رقم الحقل من القائمة المعروضة.' },
                                value: { type: 'string', description: 'القيمة الجديدة لهذا الحقل.' },
                            },
                            required: ['field_index', 'value'],
                        },
                    },
                    suggested_products: {
                        type: 'array',
                        description:
                            'استخدمها فقط مع intent=chat لما ردك يقترح على العميل عدة منتجات محددة من القائمة الحقيقية أعلاه (بدل ما تسردهم كنص). ضع IDs الحقيقية بالضبط كما هي بالقائمة. الكود بيحولها تلقائياً لأزرار تحت ردك.',
                        items: { type: 'integer' },
                    },
                },
                required: ['intent', 'reply'],
            },
        },
    },
];

function buildFieldsBlock(session) {
    if (!session.currentProduct || !session.fields || session.fields.length === 0) {
        return 'لا يوجد طلب نشط حالياً.';
    }

    const lines = session.fields.map((label, idx) => {
        const answer = session.answers?.[idx];
        const status = answer ? `✅ الإجابة المسجّلة: "${answer.value}"` : '⏳ لم تتم الإجابة بعد';
        return `[${idx}] ${label} — ${status}`;
    });

    const currentIdx = session.fields.findIndex((_, idx) => !session.answers?.[idx]);
    const currentLine =
        currentIdx === -1
            ? 'لا يوجد (كل الحقول مكتملة، بانتظار قرار العميل بالتأكيد)'
            : `[${currentIdx}] ${session.fields[currentIdx]}`;

    return `${lines.join('\n')}\n\n👉 الحقل الحالي المطلوب سؤال العميل عنه الآن: ${currentLine}`;
}

/**
 * 🔥 يحوّل شجرة الأقسام/المنتجات الكاملة (بكل مستوياتها) لقائمة مسطّحة تشمل الأقسام والمنتجات النهائية
 * مع بعض - عشان الذكاء الاصطناعي يقدر يقترح أي مستوى (قسم فيه خيارات فرعية، أو منتج نهائي جاهز للطلب)
 * كزر حقيقي، مش بس المنتجات النهائية.
 */
function flattenAllNodes(items, parentName = 'رئيسي') {
    let result = [];
    for (const item of items) {
        const isLeaf = !item.children || item.children.length === 0;
        result.push({ id: item.id, name: item.name, isLeaf, price: item.price ?? null, parentName });
        if (!isLeaf) {
            result = result.concat(flattenAllNodes(item.children, item.name));
        }
    }
    return result;
}

async function buildSystemPrompt(session) {
    const [services, business] = await Promise.all([fetchServices(), fetchBusinessInfo()]);

    const shopName = business.name || SHOP_NAME;
    const phoneLine = business.phone ? `📞 رقم التواصل: ${business.phone}` : '📞 رقم التواصل: غير متوفر حالياً';
    const hoursLine = business.working_hours ? `🕒 ساعات العمل: ${business.working_hours}` : '🕒 ساعات العمل: غير محددة بالبيانات';
    const mapLine = business.google_map_url ? `📍 رابط الموقع على خرائط جوجل: ${business.google_map_url}` : '📍 رابط الموقع: غير متوفر';

    const allNodes = flattenAllNodes(services);
    const productList = allNodes
        .map(n =>
            n.isLeaf
                ? `- ${n.name} (ID:${n.id} | منتج نهائي جاهز للطلب | السعر: ${n.price ?? 'غير محدد'} | يندرج تحت: ${n.parentName})`
                : `- ${n.name} (ID:${n.id} | قسم فيه خيارات فرعية، اختياره يعرض خياراته | يندرج تحت: ${n.parentName})`
        )
        .join('\n');

    return `أنت مساعد مبيعات ذكي لـ "${shopName}"، تتحدث بلهجة ${BOT_DIALECT} طبيعية ومختصرة وودودة.

🧠 **استنتج طبيعة هذا النشاط بنفسك من البيانات الحقيقية تحت (اسم النشاط + أسماء الأقسام/الخدمات) — بدون أي افتراض مسبق:**
هذا الكود يُستخدم لأنواع نشاطات مختلفة تماماً (مطبعة، عيادة، مطعم، صالة رياضية، محل، إلخ)، فلا تفترض أبداً إنه مطبعة أو أي نوع محدد إلا إذا كانت البيانات تحت فعلاً تدل على ذلك. تكيّف تلقائياً مع المصطلحات المناسبة لطبيعة هذا النشاط بالذات — مثلاً لو البيانات تدل على عيادة، تكلم بمصطلحات "حجز موعد" و"مريض" بدل "طلب" و"عميل"؛ ولو مطبعة، استخدم "طلب" و"عميل" و"منتج" كالمعتاد؛ ولو مطعم، "طلب" و"وجبة"... وهكذا حسب ما تراه فعلاً بالبيانات.

📋 **معلومات النشاط الحقيقية (من الـ API):**
${phoneLine}
${hoursLine}
${mapLine}

⚠️ استخدم هذه المعلومات فقط كما هي بالضبط. **ممنوع تماماً اختراع رقم هاتف أو ساعات عمل أو أي معلومة تواصل من عندك.** إذا معلومة معينة "غير متوفرة"، قلها للعميل بصراحة (مثلاً: "ما عنا رقم هاتف متاح حالياً") بدل ما تخترع رقماً أو وقتاً.

📦 **قائمة العناصر/الخدمات النهائية المتاحة فعلياً (من الـ API - لا تخترع غيرها):**
${productList}

📋 **حالة الطلب الحالي:**
- المرحلة: ${session.step}
- المنتج المختار: ${session.currentProduct?.name || 'لا يوجد'}
${buildFieldsBlock(session)}

🎯 **قواعد التحليل في كل رسالة من العميل:**

1. **طلب منتج جديد:**
   - إذا قال العميل اسم يطابق بوضوح ودقة **عقدة واحدة بالذات** من القائمة أعلاه (سواء "منتج نهائي" أو "قسم فيه خيارات فرعية" - مثال: "ابغى رول أب"، "ابغى علب حلويات"، أو حتى "ابغى كروت وورقيات" اللي يطابق قسم "الكروت والورقيات" بالضبط) → **استخدم intent=start_order مع product_id لنفس هذي العقدة بالضبط، بغض النظر إذا كانت منتج نهائي أو قسم**. الكود بيتصرف صح تلقائياً: لو قسم فيه أبناء بيعرض خياراته الفرعية كأزرار، ولو منتج نهائي بيبلش الطلب مباشرة. **هذا المسار الأضمن، استخدمه دائماً لما فيه تطابق واضح لعقدة واحدة، حتى لو كانت قسم.**
   - ⚠️ **مهم جداً:** إذا كلام العميل تعبير عام إنه يبغى يطلب أو يبدأ شي جديد **ولا يحتوي أي اسم منتج أو قسم محدد بأي جزء منه إطلاقاً** (مثال: "ابي اطلب طلب جديد" لوحدها، "ابي اسوي طلب" لوحدها، "طلب خدمة جديدة" لوحدها) → **intent=browse_categories** (مو chat، ومو تخمين أي product_id، ومو suggested_products بأقسام جزئية). خلي reply قصير جداً (مثل "تفضل 👇") — الكود بيعرض قائمة كل الأقسام كاملة تلقائياً (نفس زر "اطلب خدمة" بالضبط).
   - 🚫 **تنبيه حرج:** عبارات زي "ابي خدمة جديدة" أو "ابي اطلب طلب جديد" غالباً تكون بس **مقدمة طبيعية** قبل ما العميل يكمل بذكر المنتج المطلوب فعلياً بنفس الرسالة (مثال: "تمام ابي خدمة جديدة ورقة A5 كمية 1000 وزن 80 غم..."). **افحص الرسالة كاملة من أولها لآخرها** — لو فيها اسم منتج أو قسم محدد بأي مكان منها (حتى لو بعد عبارة عامة بالبداية)، هذا start_order بمنتج محدد (والكود بيعبّي باقي التفاصيل المذكورة تلقائياً)، **مو browse_categories أبداً**. browse_categories فقط لما الرسالة **بالكامل** ما فيها أي إشارة لمنتج أو قسم محدد.
   - ⚠️ **مهم جداً — ممنوع التخمين:** إذا كلام العميل اسم عام أو فئة واسعة تشمل أكثر من عقدة مختلفة بالقائمة (يعني سمّى شي محدد لكن مافي عقدة واحدة بالذات تطابق كلامه بدقة - مثال: "ابغى ورق" ممكن يقصد عدة أقسام/منتجات مختلفة) → **ممنوع تختار واحدة بالغلط، وممنوع تسرد الخيارات كنص أو نقاط بالـ reply**. تصرف متل موظف مبيعات حقيقي: intent=chat، وخلي reply جملة طبيعية قصيرة جداً (سطر واحد بدون تعداد أسماء، مثل "تفضل، أي وحدة من هاي تناسبك؟")، **ولازم** تحط IDs العقد الحقيقية ذات الصلة (من القائمة أعلاه بالضبط) بحقل suggested_products بنفس الرد — ردّ بدون suggested_products بهاي الحالة يعتبر رد ناقص وغير مقبول.
   - كمّل هذا الحوار (أزرار بعد أزرار أو سؤال متابعة) لحد ما يتحدد منتج نهائي واحد بالذات، وبس عندها استخدم intent=start_order بمنتج نهائي حقيقي.
   - إذا اسم المنتج غامض تماماً أو مش موجود بالقائمة إطلاقاً → intent=chat واسأله يوضح أكثر (بدون suggested_products إذا ما فيه أي خيار قريب فعلاً من كلامه).

2. **أثناء جمع البيانات (المرحلة ordering):**
   - إذا رد العميل إجابة واضحة عن "الحقل الحالي" المذكور أعلاه → intent=save_answer مع field_index لنفس رقم الحقل الحالي بالضبط (لا تخترع رقماً آخر)، وvalue تحتوي القيمة المستخرجة بشكل مختصر وواضح. اجعل reply هنا تأكيداً قصيراً جداً فقط لإجابة العميل (مثل "تمام ✅")، **ولا تسأل عن الحقل التالي بنفسك أبداً** — الكود سيتكفل تلقائياً بطرح السؤال التالي في رسالة منفصلة بعد ردّك مباشرة.
   - ⚠️ **مهم جداً:** لو الحقل الحالي سؤال نعم/لا (مثل "هل التصميم جاهز؟"، "تحب نافذة شفافة؟") ورد العميل بكلمة تأكيد قصيرة زي "نعم" أو "تمام" أو "أوكي" — هذي **دائماً save_answer** (قيمتها "نعم" أو المعنى المطابق)، **مو confirm_yes أبداً**. intent=confirm_yes ممنوع استخدامه إلا فقط لما تكون المرحلة (session.step) هي "confirming" حرفياً (يعني كل الحقول خلصت وتم عرض ملخص الطلب فعلاً) — إذا المرحلة "ordering" فلا يوجد أي احتمال لـ confirm_yes مهما كانت كلمة العميل.
   - إذا رد العميل بسؤال أو كلام خارج سياق الحقل الحالي (مثل "كم السعر؟"، سؤال عام) → intent=chat، جاوبه على سؤاله بدقة فقط في reply. **لا تكرر السؤال المعلق بنفسك، الكود سيعيد طرحه تلقائياً بعد ردك.**
   - سؤال واحد فقط في كل رد، ولا تفترض قيماً لم يذكرها العميل صراحة.
   - ممنوع استخدام save_answer لأي حقل غير الحقل الحالي المذكور أعلاه.

3. **أثناء مرحلة انتظار رقم الجوال (المرحلة awaiting_phone):**
   - إذا رسالة العميل تحتوي رقم جوال واضح (أرقام متتالية، بمسافات أو شرطات أو مع رمز دولة، 7 خانات على الأقل) → intent=save_phone مع value=الرقم كما كتبه العميل. اجعل reply تأكيداً قصيراً جداً (مثل "تمام ✅")، **ولا تعرض ملخص الطلب بنفسك أبداً** — الكود يتكفل بعرضه تلقائياً بعد حفظ الرقم مباشرة.
   - إذا رسالة العميل سؤال أو كلام آخر لا يحتوي رقم جوال (مثلاً يسأل "ليش تبي رقمي؟" أو أي سؤال عام) → intent=chat، جاوبه بدقة في reply ثم ذكّره بلطف إنك بانتظار رقم جواله لإكمال تأكيد الطلب.
   - ممنوع استخدام save_phone إلا إذا القيمة المستخرجة فعلاً تشبه رقم جوال حقيقي.

3ب. **أثناء مرحلة انتظار رقم الجوال لعرض الطلبات (المرحلة awaiting_phone_for_orders):**
   - نفس منطق القاعدة 3 بالضبط (رقم جوال واضح → intent=save_phone، سؤال أو كلام آخر → intent=chat مع تذكير لطيف)، الفرق الوحيد إن هذا الرقم مطلوب عشان نجيب طلبات العميل السابقة، مش لتأكيد طلب جديد. **لا تعرض أي طلبات بنفسك أبداً** — الكود يتكفل بجلبها وعرضها تلقائياً بعد حفظ الرقم مباشرة.

4. **أثناء مرحلة التأكيد (المرحلة confirming):**
   - موافقة صريحة ("نعم"، "تمام"، "أكد"، "أوكي") → intent=confirm_yes.
   - إذا حدد العميل بوضوح ماذا يريد أن يغيّر وبأي قيمة (مثال: "غيّر الكمية إلى 300") → intent=edit_answer مع field_index المطابق للحقل المقصود من القائمة أعلاه وvalue الجديدة.
   - ⚠️ **لو العميل ذكر أكثر من حقل يبغى تعديله بنفس الرسالة** (مثال: "غيّر الكمية لـ300 والمقاس لـ5×9") → intent=edit_answer برضو، بس استخدم مصفوفة edits تحتوي كل تعديل على حدة {field_index, value}، بحيث كل رقم حقل يطابق تمامًا رقمه بالقائمة أعلاه. لا تتجاهل أي تعديل ذكره العميل ولا تدمجهم بحقل وحيد.
   - إذا قال يريد تعديل حقل أو أكثر وسمّى اسم الحقل/الحقول بالضبط لكن بدون ما يذكر القيمة الجديدة (مثال: "ابغى اعدل عدد الموظفين وملف الأسماء") → intent=confirm_edit، واذكر في reply بالتحديد اسم كل حقل فهمته من كلامه (بالاسم الحقيقي من ملخص الطلب أعلاه بالضبط) واسأله عن القيمة الجديدة لكل واحد منها بوضوح، بجملة طبيعية واحدة (مثال: "تمام، وش العدد الجديد لعدد الموظفين؟ وممكن ترسل ملف الأسماء الجديد؟").
   - إذا قال يريد تعديل بشكل عام بدون ما يحدد أي حقل إطلاقاً (مثل "ابغى أعدل شي بالطلب") → intent=confirm_edit، واسأله بعمومية أي جزء من طلبه يبغى يعدل، واذكر له مثال حقيقي من حقول طلبه الفعلية أعلاه.
   - سؤال عام أثناء التأكيد → intent=chat، جاوبه ثم ذكّره بلطف إنه بانتظار تأكيده أو تعديله.

5. **أوامر تعمل بأي وقت:** إلغاء الطلب → intent=cancel | رجوع/القائمة الرئيسية → intent=show_menu | طلب رقم التواصل → intent=show_contact | سؤال عن طلباته السابقة أو حالتها (مثل "وين طلباتي؟"، "شو صار بطلبي؟"، "بدي أشوف طلباتي") → intent=show_my_orders (خلي reply قصير جداً، الكود يتكفل بجلب وعرض الطلبات تلقائياً).
   - ⚠️ سؤال عام واسع عن كل الخدمات (مثل "ايش عندكم خدمات؟"، "شو تقدمون؟"، "وريني كل شي عندكم") → intent=show_menu دائماً (مو chat)، وخلي reply قصير جداً (مثل "تفضل 👇") — **ممنوع تسرد كل المنتجات كنص طويل**، الكود بيعرض القائمة الرئيسية تلقائياً كأزرار.

6. **اقتراح منتجات/أقسام كأزرار (مهم جداً لتجربة استخدام أفضل - هاي القاعدة العامة يلي تحكم كل استخدامات suggested_products):**
   - في أي وقت ردك بيعرض أكثر من خيار محدد (قسم أو منتج نهائي) من القائمة الحقيقية أعلاه - سواء كان طلب غامض (قاعدة 1) أو استفسار عن قسم معين (مثال: "استفسر عن البكجات والتغليف"، "ايش عندكم كروت؟") → **ممنوع تعدد الخيارات كنص أو نقاط بالـ reply نهائياً**. خلي reply جملة طبيعية قصيرة جداً (سطر واحد، بدون تعداد أسماء)، وضع IDs الخيارات الحقيقية بالضبط (من القائمة أعلاه فقط - أقسام أو منتجات نهائية، حسب الأقرب) بحقل suggested_products — الكود بيحولها تلقائياً لأزرار تحت ردك يقدر العميل يضغط عليها مباشرة بدل ما يكتب.
   - لا تستخدم suggested_products إلا بخيارات موجودة فعلياً بالقائمة أعلاه بنفس الـ ID بالضبط. لا تخترع IDs.
   - إذا ردك ما فيه اقتراح خيارات محددة (مجرد جواب عادي)، سيب suggested_products فاضية.

🚫 **ممنوع تماماً:**
- اختراع أسعار أو منتجات أو حقول غير موجودة فعلياً في البيانات أعلاه.
- كتابة أي كود أو رموز داخل reply (بدون save_answer:، بدون JSON، فقط كلام طبيعي للعميل).
- عرض ملخص الطلب أو تأكيده بنفسك — الكود يتكفل بعرض الملخص تلقائياً عند اكتمال كل الحقول.
- استخدام field_index لا يطابق الحقل الحالي المذكور أعلاه إلا في حالة edit_answer فقط.

ردودك دائماً قصيرة جداً، طبيعية، ومباشرة، بلهجة ${BOT_DIALECT}.`;
}

// 🔥 أداة استخراج "الإجابات الجاهزة" لو العميل كتب تفاصيل الطلب كامل برسالة واحدة
// (مثال: "ابغى ورق A4 كمية 1000 ومقاس عادي") — تربط كل تفصيلة بالحقل المطابق لها بس، بدون تخمين
const PREFILL_TOOL = [
    {
        type: 'function',
        function: {
            name: 'prefill_fields',
            description:
                'حدد فقط أي حقول من القائمة المعطاة تمت الإجابة عليها صراحة ضمن رسالة العميل، واستخرج قيمها كما ذكرها بالضبط. ممنوع تخمين أي قيمة غير مذكورة صراحة بالرسالة.',
            parameters: {
                type: 'object',
                properties: {
                    answers: {
                        type: 'array',
                        description: 'قائمة الحقول اللي تمت الإجابة عليها صراحة بالرسالة فقط. إذا ما فيه أي إجابة واضحة، رجّع مصفوفة فاضية.',
                        items: {
                            type: 'object',
                            properties: {
                                field_index: { type: 'integer', description: 'رقم الحقل (index) من القائمة المعطاة.' },
                                value: { type: 'string', description: 'القيمة كما ذكرها العميل بالضبط.' },
                            },
                            required: ['field_index', 'value'],
                        },
                    },
                },
                required: ['answers'],
            },
        },
    },
];

/**
 * 🔥 لو العميل كتب طلب كامل برسالة واحدة (منتج + تفاصيل مع بعض)، هذي الدالة تفحص
 * نفس الرسالة الأصلية وتستخرج بس الإجابات المذكورة صراحة لحقول المنتج المحدد،
 * بدون أي تخمين. أي حقل ما انذكر بالرسالة يرجع فاضي وبيتسأل عنه بشكل طبيعي بعدين.
 */
async function prefillFieldsFromMessage(fields, message) {
    if (!fields || !fields.length || !message || !message.trim()) return [];

    const fieldsList = fields.map((label, idx) => `[${idx}] ${label}`).join('\n');

    try {
        const response = await client.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [
                {
                    role: 'system',
                    content:
                        'أنت أداة استخراج بيانات دقيقة جداً. هذي قائمة الحقول المطلوب سؤال العميل عنها لطلبه:\n' +
                        `${fieldsList}\n\n` +
                        'مهمتك: افحص رسالة العميل وحدد فقط أي حقول من هذي القائمة تمت الإجابة عليها صراحة وبشكل واضح لا لبس فيه ضمنها. ' +
                        'ممنوع تماماً تخمين أو استنتاج قيمة لحقل لم يذكره العميل صراحة. إذا الرسالة ما فيها أي إجابة واضحة لأي حقل، رجّع مصفوفة answers فاضية.',
                },
                { role: 'user', content: message },
            ],
            tools: PREFILL_TOOL,
            tool_choice: { type: 'function', function: { name: 'prefill_fields' } },
            temperature: 0,
            max_tokens: 400,
        });

        const toolCall = response.choices[0].message.tool_calls?.[0];
        if (!toolCall) return [];

        const args = JSON.parse(toolCall.function.arguments);
        return Array.isArray(args.answers) ? args.answers : [];
    } catch (err) {
        console.error('❌ فشل استخراج التعبئة المسبقة من رسالة العميل:', err.message);
        return [];
    }
}

// 🔥 رد احتياطي ذكي يُستخدم فقط لو الذكاء الاصطناعي فشل تمامًا (JSON غير صالح أو رد فاضي) —
// بدل جملة عامة غير مفيدة، لو فيه طلب نشط بمرحلة التأكيد نعرض حقوله الفعلية عشان العميل يقدر يحدد بسهولة
function buildFallbackReply(session) {
    if (session && session.step === 'confirming' && Array.isArray(session.fields) && session.fields.length > 0) {
        const fieldsList = session.fields.map((label) => `• ${label}`).join('\n');
        return `ما قدرت أفهم بالضبط وش تحب تعدل 🙏\nهذي تفاصيل طلبك الحالية:\n${fieldsList}\n\nاكتب اسم اللي تبي تعدله والقيمة الجديدة.`;
    }
    return 'ممكن توضح أكثر؟ 🙏';
}

async function chat(userMessage, session) {
    const systemPrompt = await buildSystemPrompt(session);

    const messages = [
        { role: 'system', content: systemPrompt },
        ...session.history,
        { role: 'user', content: userMessage },
    ];

    const response = await client.chat.completions.create({
        model: OPENAI_MODEL,
        messages,
        tools: TOOLS,
        tool_choice: { type: 'function', function: { name: 'handle_turn' } },
        temperature: 0.1,
        max_tokens: 600,
    });

    const message = response.choices[0].message;
    const toolCall = message.tool_calls?.[0];

    let analysis = { intent: 'chat', reply: message.content || buildFallbackReply(session) };

    if (toolCall) {
        try {
            const args = JSON.parse(toolCall.function.arguments);
            analysis = {
                intent: args.intent || 'chat',
                // 🔥 لو الـ JSON اتحلل صح (يعني الفهم والبيانات المستخرجة موثوقة)، بس رد النص طلع فاضي —
                // نستخدم رد محايد "تمام ✅" بدل رسالة "ما قدرت أفهم" المضللة (لأننا فعلاً فهمنا،
                // والدليل إن باقي الحقول زي field_index/value/edits انحفظت صح). الرد الاحتياطي الذكي
                // (buildFallbackReply) نخليه فقط لحالة فشل تحليل الـ JSON بالكامل (catch block تحت).
                reply: args.reply && String(args.reply).trim() ? args.reply : 'تمام ✅',
                productId: args.product_id ?? null,
                fieldIndex: args.field_index ?? null,
                value: args.value ?? null,
                edits: Array.isArray(args.edits) ? args.edits : null,
                suggestedProducts: Array.isArray(args.suggested_products) ? args.suggested_products : null,
            };
        } catch (err) {
            console.error('❌ خطأ في تحليل رد الـ AI (JSON غير صالح):', err.message);
            analysis.reply = buildFallbackReply(session);
        }
    }

    return { reply: analysis.reply, analysis };
}

/**
 * 🔥 تحويل رسالة صوتية (ملف صوت) إلى نص عبر Whisper، عشان تدخل بعدين على نفس مسار
 * الرسائل النصية بالضبط (نفس فهم النوايا، نفس كل شي).
 * audioBuffer: محتوى الملف الصوتي كـ Buffer. filename: اسم ملف وهمي بامتداد مناسب (مثلاً voice.ogg).
 * promptHint: تلميح قصير جداً اختياري (السؤال الحالي بس) - تلميح طويل مع تسجيل قصير بيخلي Whisper
 * "يعتمد" على التلميح نفسه بدل الصوت الفعلي، فبنحدّه لأقصى شي بضع كلمات.
 */
async function transcribeVoice(audioBuffer, filename = 'voice.ogg', promptHint = '') {
    const file = await OpenAI.toFile(audioBuffer, filename);

    const transcription = await client.audio.transcriptions.create({
        file,
        model: 'whisper-1',
        language: 'ar',
        ...(promptHint ? { prompt: promptHint.slice(0, 80) } : {}),
    });
    return (transcription.text || '').trim();
}

module.exports = { chat, extractFieldsWithAI, prefillFieldsFromMessage, transcribeVoice };