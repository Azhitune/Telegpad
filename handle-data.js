// =================================================================
// handle-data worker
// =================================================================

function parseInitData(initData) {
    const data = {};
    const pairs = initData.split('&');
    for (const pair of pairs) {
        const [key, encodedValue] = pair.split('=');
        const value = encodedValue ? decodeURIComponent(encodedValue) : '';
        data[key] = value;
    }
    return data;
}

async function verifyInitData(initData, botToken) {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get("hash");

    if (!hash) return null;

    const params = [];
    for (const [key, value] of urlParams.entries()) {
        if (key !== 'hash') {
            params.push(`${key}=${value}`);
        }
    }
	
    const dataCheckString = params.sort().join('\n');
    const encoder = new TextEncoder();
    const HMAC_ALGO = { name: 'HMAC', hash: 'SHA-256' };

    const keyMaterial = await crypto.subtle.importKey(
        'raw', encoder.encode("WebAppData"), HMAC_ALGO, false, ['sign']
    );
    const secretKey = await crypto.subtle.sign(
        'HMAC', keyMaterial, encoder.encode(botToken)
    );
    const signatureKey = await crypto.subtle.importKey(
        'raw', secretKey, HMAC_ALGO, false, ['sign']
    );

    const hmacBuffer = await crypto.subtle.sign(
        'HMAC', signatureKey, encoder.encode(dataCheckString)
    );

    const computedHash = Array.from(new Uint8Array(hmacBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    if (computedHash === hash) {
        return JSON.parse(urlParams.get("user"));
    }

    return null;
}

async function hashPin(pin) {
    if (!pin) return null;
    const data = new TextEncoder().encode(pin);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const headers = {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        };

        if (request.method === 'OPTIONS') return new Response(null, { headers });

        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return new Response(JSON.stringify({ error: 'Auth header missing' }), { status: 401, headers });
        }
        const initData = authHeader.split(' ')[1];

        const user = await verifyInitData(initData, env.BOT_TOKEN);

        if (!user) {
            return new Response(JSON.stringify({ error: 'Invalid Telegram Init Data (All Strategies Failed)' }), { status: 401, headers });
        }

        const user_id = user.id.toString();

        if (url.pathname === '/notes') {
            try {
                // GET
                if (request.method === 'GET') {
                    const { results } = await env.DB.prepare(
                        `SELECT * FROM notes WHERE user_id = ? ORDER BY updated_at DESC`
                    ).bind(user_id).all();
                    const parsed = results.map(n => ({ ...n, content: JSON.parse(n.content) }));
                    return new Response(JSON.stringify(parsed), { headers });
                }

                if (request.method === 'POST') {
                    const note = await request.json();
                    const pinHash = note.is_locked && note.pin ? await hashPin(note.pin) : null;
                    const contentJson = JSON.stringify(note.content);

                    if (note.id) {
                        let q = `UPDATE notes SET title=?, is_locked=?, content=?, updated_at=CURRENT_TIMESTAMP`;
                        const params = [note.title, note.is_locked ? 1 : 0, contentJson];
                        if (pinHash !== null) { q += `, pin_hash=?`; params.push(pinHash); }
                        q += ` WHERE id=? AND user_id=?`;
                        params.push(note.id, user_id);

                        const res = await env.DB.prepare(q).bind(...params).run();
                        if (!res.changes) return new Response(JSON.stringify({ error: 'Not found' }), { status: 403, headers });
                        return new Response(JSON.stringify({ message: 'Updated' }), { headers });
                    } else {
                        const res = await env.DB.prepare(
                            `INSERT INTO notes (user_id, title, is_locked, pin_hash, content) VALUES (?,?,?,?,?)`
                        ).bind(user_id, note.title, note.is_locked ? 1 : 0, pinHash, contentJson).run();
                        return new Response(JSON.stringify({ message: 'Created', id: res.meta.last_row_id }), { headers, status: 201 });
                    }
                }

                if (request.method === 'DELETE') {
                    const id = url.searchParams.get('id');
                    const res = await env.DB.prepare(`DELETE FROM notes WHERE id=? AND user_id=?`).bind(id, user_id).run();
                    if (!res.changes) return new Response(JSON.stringify({ error: 'Not found' }), { status: 403, headers });
                    return new Response(JSON.stringify({ message: 'Deleted' }), { headers });
                }

            } catch (e) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
            }
        }

        if (url.pathname === '/verify-pin' && request.method === 'POST') {
            const { noteId, pin } = await request.json();
            const pinHash = await hashPin(pin);

            const note = await env.DB.prepare(
                `SELECT pin_hash FROM notes WHERE id = ? AND user_id = ?`
            ).bind(noteId, user_id).first();

            if (note && note.pin_hash === pinHash) {
                return new Response(JSON.stringify({ success: true }), { headers });
            } else {
                return new Response(JSON.stringify({ success: false, error: 'Pin Wrong!' }), { status: 403, headers });
            }
        }

        return new Response('Not Found', { status: 404, headers });
    },
};
