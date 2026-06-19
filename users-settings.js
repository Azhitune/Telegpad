// =================================================================
// users-settings worker
// =================================================================

async function verifyInitData(initData, botToken) {
    if (!initData) return null;
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get("hash");
    if (!hash) return null;

    const params = [];
    for (const [key, value] of urlParams.entries()) {
        if (key !== 'hash') params.push(`${key}=${value}`);
    }
    const dataCheckString = params.sort().join('\n');

    const encoder = new TextEncoder();
    const HMAC_ALGO = { name: 'HMAC', hash: 'SHA-256' };
    const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode("WebAppData"), HMAC_ALGO, false, ['sign']);
    const secretKey = await crypto.subtle.sign('HMAC', keyMaterial, encoder.encode(botToken));
    const signatureKey = await crypto.subtle.importKey('raw', secretKey, HMAC_ALGO, false, ['sign']);
    const hmacBuffer = await crypto.subtle.sign('HMAC', signatureKey, encoder.encode(dataCheckString));
    const computedHash = Array.from(new Uint8Array(hmacBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    if (computedHash === hash) {
        const userStr = urlParams.get("user");
        return userStr ? JSON.parse(userStr) : null;
    }
    return null;
}

async function callGemini(apiKey, prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
        })
    });
    const data = await response.json();
    if (data.candidates && data.candidates[0].content.parts[0].text) {
        return data.candidates[0].content.parts[0].text;
    }
    return "Sorry! No Response :(";
    ;
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const headers = {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Max-Age': '86400',
        };

        if (request.method === 'OPTIONS') return new Response(null, { headers });

        if (request.method === 'POST' && (url.pathname === '/webhook' || url.pathname === '/')) {
            const update = await request.json();

            if (update.pre_checkout_query) {
                const resp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerPreCheckoutQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        pre_checkout_query_id: update.pre_checkout_query.id,
                        ok: true
                    })
                });
                return new Response('OK', { status: 200 });
            }

            if (update.message && update.message.successful_payment) {
                const payment = update.message.successful_payment;
                const payload = payment.invoice_payload;
                const buyerId = update.message.from.id.toString();

                if (payload === 'buy_7_tokens') {
                    await env.DB.prepare('UPDATE UserSettings SET tokens = tokens + 7 WHERE user_id = ?').bind(buyerId).run();
                }
                else if (payload === 'buy_16_tokens') {
                    await env.DB.prepare('UPDATE UserSettings SET tokens = tokens + 16 WHERE user_id = ?').bind(buyerId).run();
                }
                else if (payload === 'buy_27_tokens') {
                    await env.DB.prepare('UPDATE UserSettings SET tokens = tokens + 27 WHERE user_id = ?').bind(buyerId).run();
                }
                else if (payload === 'buy_infinity_month') {
                    const expiry = new Date();
                    expiry.setDate(expiry.getDate() + 30);
                    await env.DB.prepare('UPDATE UserSettings SET is_infinity = 1, infinity_expiry = ? WHERE user_id = ?')
                        .bind(expiry.toISOString(), buyerId).run();
                }

                await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: buyerId, text: "🎉 Your purchase was successful and your account status has been updated! 🎉" })
                });
                return new Response('OK', { status: 200 });
            }
        }

        const authHeader = request.headers.get('Authorization');
        const initData = authHeader?.split(' ')[1];
        const user = await verifyInitData(initData, env.BOT_TOKEN);

        if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });

        const user_id = user.id.toString();
        const today = new Date().toISOString().split('T')[0];

        if (url.pathname === '/analyze-note' && request.method === 'POST') {
            let { noteContent } = await request.json();
            const userData = await env.DB.prepare('SELECT is_infinity, tokens, daily_analysis_count, last_analysis_date FROM UserSettings WHERE user_id = ?').bind(user_id).first();

            if (!userData) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404, headers });

            if (userData.is_infinity === 0 && userData.tokens < 3) {
                return new Response(JSON.stringify({ error: 'Need at least 3 tokens!', needs_upgrade: true }), { status: 403, headers });
            }

            let count = userData.last_analysis_date === today ? userData.daily_analysis_count : 0;
            if (count >= 10) {
                return new Response(JSON.stringify({ error: 'Daily limit reached!' }), { status: 429, headers });
            }

            if (userData.is_infinity === 0) {
                await env.DB.prepare('UPDATE UserSettings SET tokens = tokens - 3 WHERE user_id = ?').bind(user_id).run();
            }

            const systemPrompt = `
You are an expert AI assistant for "Telegpad", a minimalist note-taking app.
Your task is to summarize the user's note accurately and concisely.

Rules:
1. Detect the language of the note automatically (Persian, English, etc.).
2. Provide the summary IN THE SAME LANGUAGE as the note.
3. If the note is a "Checklist" or "To-Do", extract pending items.
4. Keep the tone professional but friendly.
5. Format the output using Markdown (bolding key points).
6. Maximum output length: 320 characters (to save user's reading time).

Input Note:
"${noteContent}"
`;
            try {
                const analysis = await callGemini(env.GEMINI_API_KEY, systemPrompt);

                await env.DB.prepare('UPDATE UserSettings SET daily_analysis_count = ?, last_analysis_date = ? WHERE user_id = ?').bind(count + 1, today, user_id).run();

                return new Response(JSON.stringify({ analysis }), { headers });
            } catch (error) {
                if (userData.is_infinity === 0) {
                    await env.DB.prepare('UPDATE UserSettings SET tokens = tokens + 3 WHERE user_id = ?').bind(user_id).run();
                }
                return new Response(JSON.stringify({ error: 'AI is not response. Please try again!' }), { status: 500, headers });
            }

        }

        if (url.pathname === '/chat-gemini' && request.method === 'POST') {

            const { topic, contentType, language } = await request.json();
            const userData = await env.DB.prepare(
                'SELECT is_infinity, tokens, chat_msg_counter FROM UserSettings WHERE user_id = ?'
            ).bind(user_id).first();

            if (!userData) {
                return new Response(JSON.stringify({ error: 'User not found!' }), { status: 404, headers });
            }

            if (userData.is_infinity === 0 && userData.tokens < 2) {
                return new Response(
                    JSON.stringify({
                        error: 'Need at least 2 tokens!',
                        needs_upgrade: true
                    }),
                    { status: 403, headers }
                );
            }
            let count = userData.last_analysis_date === today ? userData.daily_analysis_count : 0;
            if (count >= 10) {
                return new Response(JSON.stringify({ error: 'Daily limit reached!' }), { status: 429, headers });
            }
			
            if (userData.is_infinity === 0) {
                await env.DB.prepare('UPDATE UserSettings SET tokens = tokens - 2 WHERE user_id = ?').bind(user_id).run();
            }

            const assistantPrompt = `
You are an advanced Smart Content Assistant integrated into "Telegpad", a professional note-taking app.
Your task is to generate high-quality, ready-to-use content based on the user's request.

Specifications:
- Topic/Idea: "${topic}"
- Type of Content: "${contentType}" (e.g., business email, instagram caption, short article, creative writing/lyrics, brainstorming)
- Output Language: "${language}"

Critical Rules:
1. DO NOT write conversational intros or outros like "Sure, here is your text:" or "Hope this helps!". Write ONLY the final generated content.
2. Structure the content beautifully using clean Markdown (clear paragraphs, bullet points, or bold headings where appropriate).
3. Keep the tone perfectly matched with the requested content type (e.g., professional for emails, energetic/creative for social media or lyrics).
4. If the content type is social media or creative, you may add relevant emojis or hashtags at the end.
`;

            try {
                const reply = await callGemini(env.GEMINI_API_KEY, assistantPrompt);

                await env.DB.prepare('UPDATE UserSettings SET chat_msg_counter = chat_msg_counter + 1 WHERE user_id = ?').bind(user_id).run();

                return new Response(JSON.stringify({ reply }), { headers });

            } catch (apiError) {
                if (userData.is_infinity === 0) {
                    await env.DB.prepare('UPDATE UserSettings SET tokens = tokens + 2 WHERE user_id = ?').bind(user_id).run();
                }
                return new Response(JSON.stringify({ error: 'AI is not response. Please try again!' }), { status: 500, headers });
            }
        }

        if (url.pathname === '/init' && request.method === 'GET') {
            let settings = await env.DB.prepare('SELECT * FROM UserSettings WHERE user_id = ?').bind(user_id).first();
            let isFirstTime = false;

            if (!settings) {
                isFirstTime = true;
				
                const urlParams = new URLSearchParams(initData);
                const startParam = urlParams.get("start_param"); // حاوی آی‌دی دعوت‌کننده

                let inviterId = null;
                if (startParam && startParam.startsWith('ref_')) {
                    inviterId = startParam.replace('ref_', '');
                }

                await env.DB.prepare('INSERT INTO UserSettings (user_id, language, theme, tokens) VALUES (?, ?, ?, ?)')
                    .bind(user_id, 'en', 'system', 5).run();

                if (inviterId && inviterId !== user_id) {
                    await env.DB.prepare('UPDATE UserSettings SET tokens = tokens + 3 WHERE user_id = ?').bind(inviterId).run();
                    await env.DB.prepare('UPDATE UserSettings SET tokens = tokens + 2 WHERE user_id = ?').bind(user_id).run();

                    try {
                        await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                chat_id: inviterId,
                                text: "🎉 A new Refral! You will receive 3 TOKENs for this invitation 🎉"
                            })
                        });
                    } catch (e) { }
                }

                settings = { language: 'en', theme: 'system', is_infinity: 0, tokens: inviterId ? 7 : 5 };
            }

            if (settings && settings.is_infinity === 1 && settings.infinity_expiry) {
                const now = new Date();
                const expiry = new Date(settings.infinity_expiry);
                if (now > expiry) {
                    await env.DB.prepare('UPDATE UserSettings SET is_infinity = 0 WHERE user_id = ?').bind(user_id).run();
                    settings.is_infinity = 0;
                }
            }

            return new Response(JSON.stringify({ settings, is_first_time: isFirstTime }), { headers });
        }

        if (url.pathname === '/create-invoice' && request.method === 'POST') {
            const { itemId } = await request.json();
            let config = {
                tokens_7: { title: "7 Telegpad TOKENs 🪙", price: 1, payload: "buy_7_tokens" },
                tokens_16: { title: "16 Telegpad TOKENs 🪙", price: 2, payload: "buy_16_tokens" },
                tokens_27: { title: "27 Telegpad TOKENs 🪙", price: 3, payload: "buy_27_tokens" },
                infinity_month: { title: "Infininty♾️: 30-Days unlimited", price: 10, payload: "buy_infinity_month" }
            }[itemId];

            if (!config) return new Response(JSON.stringify({ error: 'Item not found :(' }), { status: 400, headers });

            const resp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/createInvoiceLink`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: config.title,
                    description: "Buy from Telegpad",
                    payload: config.payload,
                    currency: "XTR",
                    prices: [{ label: config.title, amount: config.price }]
                })
            });

            const result = await resp.json();
            return new Response(JSON.stringify({ invoiceLink: result.result }), { headers });
        }

        return new Response('Not Found', { status: 404, headers });
    }
};