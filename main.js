const https = require("https");

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN   = "YOUR_DISCORD_TOKEN";
const OPENROUTER_KEY  = "YOUR_OPENROUTER_API_KEY";
const MODEL           = "openai/gpt-4o-mini";
const SYSTEM_PROMPT   = "You Are A HelpFul Assistent!";
// ───────────────────────────────────────────────────────────────────────────────

const histories = {};

// ── OpenRouter call ────────────────────────────────────────────────────────────
async function askGPT(history) {
    const body = JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
        max_tokens: 512,
        temperature: 0.7,
    });

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: "openrouter.ai",
            path: "/api/v1/chat/completions",
            method: "POST",
            headers: {
                "Authorization": `Bearer ${OPENROUTER_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://discord-selfbot",
                "X-Title": "Discord AutoReply",
                "Content-Length": Buffer.byteLength(body),
            },
        }, (res) => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed.choices[0].message.content.trim());
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// ── Discord Gateway WebSocket ──────────────────────────────────────────────────
const WebSocket = require("ws");

let ws;
let heartbeatInterval;
let sessionId;
let sequence = null;
let selfId;

function send(ws, data) {
    ws.send(JSON.stringify(data));
}

function startHeartbeat(interval) {
    heartbeatInterval = setInterval(() => {
        send(ws, { op: 1, d: sequence });
    }, interval);
}

async function sendDiscordMessage(channelId, content, replyToId = null) {
    const body = JSON.stringify({
        content,
        ...(replyToId ? {
            message_reference: { message_id: replyToId },
            allowed_mentions: { replied_user: false }
        } : {})
    });

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: "discord.com",
            path: `/api/v9/channels/${channelId}/messages`,
            method: "POST",
            headers: {
                "Authorization": DISCORD_TOKEN,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
                "User-Agent": "Mozilla/5.0",
            },
        }, (res) => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => resolve(JSON.parse(data)));
        });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

async function sendTyping(channelId) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: "discord.com",
            path: `/api/v9/channels/${channelId}/typing`,
            method: "POST",
            headers: {
                "Authorization": DISCORD_TOKEN,
                "Content-Length": 0,
                "User-Agent": "Mozilla/5.0",
            },
        }, res => { res.resume(); resolve(); });
        req.on("error", reject);
        req.end();
    });
}

function connect() {
    ws = new WebSocket("wss://gateway.discord.gg/?v=9&encoding=json");

    ws.on("open", () => console.log("[+] WebSocket connected"));

    ws.on("message", async (raw) => {
        const payload = JSON.parse(raw);
        const { op, d, t, s } = payload;

        if (s) sequence = s;

        // ── HELLO ──────────────────────────────────────────────────────────
        if (op === 10) {
            startHeartbeat(d.heartbeat_interval);
            send(ws, {
                op: 2,
                d: {
                    token: DISCORD_TOKEN,
                    properties: {
                        os: "windows",
                        browser: "Chrome",
                        device: ""
                    },
                    presence: { status: "onlin", afk: false },
                    compress: false,
                    intents: 0   // user tokens don't use intents
                }
            });
        }

        // ── HEARTBEAT ACK ──────────────────────────────────────────────────
        if (op === 11) process.stdout.write(".");

        // ── READY ──────────────────────────────────────────────────────────
        if (t === "READY") {
            selfId    = d.user.id;
            sessionId = d.session_id;
            console.log(`\n[+] Logged in as ${d.user.username}#${d.user.discriminator}`);
        }

        // ── MESSAGE CREATE ─────────────────────────────────────────────────
        if (t === "MESSAGE_CREATE") {
            const msg = d;

            // ignore own messages
            if (msg.author.id === selfId) return;

            const isDM      = !msg.guild_id;
            const mentioned = msg.mentions?.some(u => u.id === selfId);

            if (!mentioned) return;

            // strip mention noise
            let content = msg.content.replace(/<@!?(\d+)>/g, "").trim();
            if (!content) return;

            const cid = msg.channel_id;
            if (!histories[cid]) histories[cid] = [];

            histories[cid].push({ role: "user", content });
            if (histories[cid].length > 20)
                histories[cid] = histories[cid].slice(-20);

            console.log(`[←] ${msg.author.username}: ${content.slice(0, 60)}`);

            try {
                await sendTyping(cid);
                const reply = await askGPT(histories[cid]);
                histories[cid].push({ role: "assistant", content: reply });
                await sendDiscordMessage(cid, reply, msg.id);
                console.log(`[→] GPT-4: ${reply.slice(0, 80)}`);
            } catch (e) {
                console.error("[-] Error:", e.message);
            }
        }
    });

    ws.on("close", (code) => {
        console.log(`[!] Disconnected (${code}) — reconnecting in 5s`);
        clearInterval(heartbeatInterval);
        setTimeout(connect, 5000);
    });

    ws.on("error", (e) => console.error("[-] WS Error:", e.message));
}

// ── boot ───────────────────────────────────────────────────────────────────────
console.log("[*] Starting Discord AutoReply...");
connect();
