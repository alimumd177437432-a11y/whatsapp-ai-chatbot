/**
 * 🔥 حساب السعر بناءً على الـ price والـ prompt_if_you_need
 */
function calculatePrice(product, quantity) {
    if (!product || product.price === null || product.price === undefined || product.price === '') {
        return { price: 0, unit: 'غير محدد', total: 0 };
    }

    const unitPrice = parseFloat(product.price);
    const prompt = product.prompt_if_you_need || '';
    let total = 0;
    let unit = 'قطعة';

    // تحليل الـ prompt لمعرفة وحدة السعر
    if (prompt.includes('لكل 500') || prompt.includes('لكل ٥٠٠')) {
        // السعر لكل 500 قطعة
        const batches = Math.ceil(quantity / 500);
        total = unitPrice * batches;
        unit = `لكل 500 (${batches} × ${unitPrice})`;
    } else if (prompt.includes('لكل 100') || prompt.includes('لكل ١٠٠')) {
        const batches = Math.ceil(quantity / 100);
        total = unitPrice * batches;
        unit = `لكل 100 (${batches} × ${unitPrice})`;
    } else if (prompt.includes('لكل متر') || prompt.includes('لكل متر مربع')) {
        total = unitPrice * quantity;
        unit = 'لكل متر';
    } else if (prompt.includes('للحبة') || prompt.includes('للقطعة')) {
        total = unitPrice * quantity;
        unit = 'للحبة';
    } else {
        // افتراضي: السعر للوحدة
        total = unitPrice * quantity;
        unit = 'للقطعة';
    }

    return {
        price: total,
        unitPrice: unitPrice,
        unit: unit,
        quantity: quantity,
        total: Math.round(total * 100) / 100,
    };
}

module.exports = { calculatePrice };