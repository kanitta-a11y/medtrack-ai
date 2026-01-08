//const fetch = require('node-fetch');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const token = 'LINK-' + Math.random().toString(36).substring(2, 8).toUpperCase();

// --- เพิ่ม Library AI ---
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const db = new sqlite3.Database('./database.db');

// --- การตั้งค่า LINE Messaging API (ใช้แบบ Client ตัวเดียวจบ) ---
const line = require('@line/bot-sdk');

const lineConfig = {
    channelAccessToken: 'JJkOkmi9CacIN1ojZpBF2bLer+vAUch5y64vSx5Z6IszLVItfgdndZB3lFBp70egBPB0CjL18cSRIByqYNwgKzwT5CFm+BwiTAj8mtX9UQ3vusgCMzLIjUt10jrBUSCi0WiCBBdxTErowivFfn3yDQdB04t89/1O/w1cDnyilFU=', 
    channelSecret: 'c7930f4898a69831d06674c7f0145291'
};

const lineClient = new line.Client(lineConfig); // ใช้ตัวนี้ตัวเดียวพอครับ
//const myLineId = 'Ub93df2f838d5756fa7c9e8040b65530f';
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/callback', line.middleware(lineConfig), (req, res) => {
    try {
        const events = req.body.events || [];

        events.forEach(event => {

            if (event.type === 'follow' && event.replyToken) {
                lineClient.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'สวัสดีครับ 👋\nกรุณาพิมพ์โค้ดจากหน้าเว็บ เพื่อเชื่อมบัญชี MedTrack'
                });
            }

            if (event.type === 'message'
                && event.message.type === 'text'
                && event.replyToken) {

                const text = event.message.text.trim();
                const lineUserId = event.source.userId;

                if (text.startsWith('LINK-')) {
                    db.run(
                        "UPDATE users SET lineUserId=? WHERE linkToken=?",
                        [lineUserId, text],
                        function () {
                            lineClient.replyMessage(event.replyToken, {
                                type: 'text',
                                text: this.changes > 0
                                    ? '✅ เชื่อมบัญชีสำเร็จแล้ว'
                                    : '❌ โค้ดไม่ถูกต้อง'
                            });
                        }
                    );
                }
            }
        });

        res.sendStatus(200);
    } catch (err) {
        console.error('Webhook Error:', err);
        res.sendStatus(200); // สำคัญ! ห้ามปล่อย 500
    }
});

app.use(express.static('public'));
// --- 1. SETTINGS & MIDDLEWARE ---
// ใส่ Gemini API Key ของคุณที่นี่
const genAI = new GoogleGenerativeAI("AIzaSyAlyfGADObdnOiVzygM80mxLIS7UpptG3A");

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });



app.use(session({ secret: 'medtrack-gentle-ui', resave: false, saveUninitialized: false }));

// --- 2. DATABASE INIT ---
db.serialize(() => {
    db.run(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE,
    password TEXT,
    lineUserId TEXT,
    linkToken TEXT
)`);

    db.run("CREATE TABLE IF NOT EXISTS medicines (id INTEGER PRIMARY KEY, userId INTEGER, name TEXT, info TEXT, image TEXT, time TEXT, stock REAL DEFAULT 0, unit TEXT, dosage REAL DEFAULT 1)");
    db.run("CREATE TABLE IF NOT EXISTS medicine_logs (id INTEGER PRIMARY KEY, userId INTEGER, medicineId INTEGER, medName TEXT, takenAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

// ฟังก์ชันแจ้งเตือนเมื่อยาใกล้หมด
function checkLowStock(userId, medName, currentStock) {
    if (currentStock <= 5) {

        db.get(
            "SELECT lineUserId FROM users WHERE id = ?",
            [userId],
            (err, user) => {
                if (user && user.lineUserId) {
                    lineClient.pushMessage(user.lineUserId, [{
                        type: 'text',
                        text: `⚠️ ยา ${medName} ใกล้หมดแล้ว (เหลือ ${currentStock})`
                    }]);
                }
            }
        );
    }
}

// --- 3. UI LAYOUT (เพิ่มส่วน AI Chatbot เข้าไป) ---
function layout(content, userId = null, activePage = 'dashboard') {
    return `
    <!DOCTYPE html>
    <html lang="th">
    <head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>MedTrack | บันทึกการทานยา</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
        <link href="https://fonts.googleapis.com/css2?family=Kanit:wght@300;400;500;700&display=swap" rel="stylesheet">
        <style>
            body { font-family: 'Kanit', sans-serif; background-color: #f0f9ff; color: #1e293b; }
            .blue-gradient { background: linear-gradient(135deg, #0ea5e9 0%, #2dd4bf 100%); }
            .soft-card { background: #ffffff; border-radius: 2rem; box-shadow: 0 4px 20px rgba(14, 165, 233, 0.08); border: 1px solid #e0f2fe; position: relative; overflow: hidden; }
            .nav-link-active { background-color: #0ea5e9; color: white !important; box-shadow: 0 4px 12px rgba(14, 165, 233, 0.3); }
            /* สไตล์สำหรับ Chat AI */
            #chat-content::-webkit-scrollbar { width: 4px; }
            #chat-content::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
        </style>
    </head>
    <body>
        ${userId ? `
       <aside id="main-sidebar" class="fixed top-0 left-0 z-40 w-64 h-screen transition-transform -translate-x-full sm:translate-x-0 bg-white border-r border-blue-50">
            <button onclick="toggleSidebar()" class="sm:hidden absolute top-4 right-4 text-slate-400">✕</button>
            
            <div class="p-8 text-2xl font-bold text-sky-600 flex items-center gap-2"><span class="text-3xl">🛡️</span> MedTrack</div>
            <div class="px-6 mb-4">
                <div class="bg-sky-50 p-3 rounded-2xl border border-sky-100">
                    <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">ผู้ใช้งาน</p>
                    <p id="user-email-display" class="text-xs font-medium text-sky-700 truncate">กำลังโหลด...</p>
                </div>
            </div>
            <nav class="px-4 space-y-2">
                <a href="/dashboard" class="flex items-center gap-3 p-4 rounded-xl font-medium transition ${activePage === 'dashboard' ? 'nav-link-active' : 'text-slate-500 hover:bg-sky-50 hover:text-sky-600'}">🏠 หน้าแรก</a>
                <a href="/logs" class="flex items-center gap-3 p-4 rounded-xl font-medium transition ${activePage === 'logs' ? 'nav-link-active' : 'text-slate-500 hover:bg-sky-50 hover:text-sky-600'}">📋 ประวัติการทาน</a>
                <a href="/add" class="flex items-center gap-3 p-4 rounded-xl font-medium transition ${activePage === 'add' ? 'nav-link-active' : 'text-slate-500 hover:bg-sky-50 hover:text-sky-600'}">➕ เพิ่มยาใหม่</a>
                <div id="admin-menu"></div>
                <div class="pt-8"><a href="/logout" class="flex items-center gap-3 p-4 text-rose-500 hover:bg-rose-50 rounded-xl font-medium transition italic">🚪 ออกจากระบบ</a></div>
            </nav>
        </aside>

        <div id="chat-widget" class="fixed bottom-6 right-6 z-50">
            <button onclick="toggleChat()" class="blue-gradient w-14 h-14 rounded-full shadow-2xl flex items-center justify-center text-2xl hover:scale-110 transition-transform border-4 border-white">🤖</button>
            <div id="chat-box" class="hidden absolute bottom-20 right-0 w-[320px] sm:w-[380px] bg-white rounded-3xl shadow-2xl border border-blue-50 overflow-hidden flex flex-col">
                <div class="blue-gradient p-5 text-white flex justify-between items-center">
                    <div>
                        <p class="font-bold">MedBot AI</p>
                        <p class="text-[10px] opacity-80">ถามข้อมูลจากบันทึกยาของคุณ</p>
                    </div>
                    <button onclick="toggleChat()" class="hover:rotate-90 transition">✕</button>
                </div>
                <div id="chat-content" class="h-96 overflow-y-auto p-4 space-y-4 bg-slate-50 flex flex-col text-sm">
                    <div class="bg-white p-3 rounded-2xl rounded-tl-none shadow-sm border border-slate-100 self-start max-w-[80%]">สวัสดีครับ ผมคือ AI ผู้ช่วย มีอะไรให้ตรวจสอบเกี่ยวกับยาของคุณไหมครับ?</div>
                </div>
                <div class="p-4 bg-white border-t flex gap-2">
                    <input id="chat-input" type="text" placeholder="ยานี้กินตอนไหน..." class="flex-1 bg-slate-100 p-3 rounded-xl outline-none text-sm focus:ring-2 ring-sky-400 transition" onkeypress="if(event.key==='Enter') askAI()">
                    <button onclick="askAI()" class="blue-gradient text-white px-4 rounded-xl font-bold">ส่ง</button>
                </div>
            </div>
        </div>

        <script>
            function toggleChat() { document.getElementById('chat-box').classList.toggle('hidden'); }
            
function toggleSidebar() {
                const sidebar = document.getElementById('main-sidebar');
                const overlay = document.getElementById('sidebar-overlay');
                
                sidebar.classList.toggle('-translate-x-full');
                overlay.classList.toggle('hidden');
            }
            
            // ปิดเมนูอัตโนมัติเมื่อกด Link (กรณีเปิดบนมือถือ)
            document.querySelectorAll('#main-sidebar a').forEach(link => {
                link.addEventListener('click', () => {
                    if (window.innerWidth < 640) toggleSidebar();
                });
            });


            async function askAI() {
                const input = document.getElementById('chat-input');
                const content = document.getElementById('chat-content');
                if(!input.value.trim()) return;

                const userMsg = input.value;
                content.innerHTML += \`<div class="bg-sky-500 text-white p-3 rounded-2xl rounded-tr-none self-end max-w-[80%] shadow-md shadow-sky-100">\${userMsg}</div>\`;
                input.value = '';
                content.scrollTop = content.scrollHeight;

                try {
                    const res = await fetch('/api/ai-chat', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                        body: 'query=' + encodeURIComponent(userMsg)
                    });
                    const data = await res.json();
                    content.innerHTML += \`<div class="bg-white p-3 rounded-2xl rounded-tl-none shadow-sm border border-slate-100 self-start max-w-[80%] text-slate-700">🤖: \${data.reply}</div>\`;
                } catch(e) {
                    content.innerHTML += \`<div class="text-rose-500 text-xs italic text-center">เกิดข้อผิดพลาดในการเชื่อมต่อ</div>\`;
                }
                content.scrollTop = content.scrollHeight;
            }

            fetch('/api/user-info').then(r => r.json()).then(user => {
                if(user.email) document.getElementById('user-email-display').innerText = user.email;
                if(user.email === 'adminadmin@gmail.com') {
                    document.getElementById('admin-menu').innerHTML = \`
                        <div class="mt-4 pt-4 border-t border-slate-100">
                            <p class="px-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Admin Section</p>
                            <a href="/admin/users" class="flex items-center gap-3 p-4 rounded-xl font-medium text-rose-600 hover:bg-rose-50 transition">🔑 จัดการผู้ใช้งาน</a>
                        </div>\`;
                }
            });
        </script>
        ` : ''}

<div class="sm:hidden flex items-center justify-between p-4 bg-white border-b sticky top-0 z-30">
            <div class="text-xl font-bold text-sky-600 flex items-center gap-2">🛡️ MedTrack</div>
            <button onclick="toggleSidebar()" class="p-2 text-slate-600 hover:bg-slate-100 rounded-lg">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16m-7 6h7" />
                </svg>
            </button>
        </div>

        <div id="sidebar-overlay" onclick="toggleSidebar()" class="fixed inset-0 bg-slate-900/50 z-30 hidden sm:hidden"></div>

        <main class="${userId ? 'sm:ml-64' : ''} p-5 pb-24 sm:pb-10"><div class="max-w-4xl mx-auto">${content}</div></main>
        <script>
            function confirmAction(e, title, text, confirmBtnText = 'ตกลง', icon = 'question') {
                e.preventDefault();
                const form = e.target;
                Swal.fire({ title, text, icon, showCancelButton: true, confirmButtonColor: '#0ea5e9', cancelButtonColor: '#94a3b8', confirmButtonText: confirmBtnText, cancelButtonText: 'ยกเลิก', reverseButtons: true }).then((result) => { if (result.isConfirmed) form.submit(); });
            }
        </script>
    </body>
    </html>`;
}

// --- 4. API & ROUTES ---


// --- API AI CHATBOT (เวอร์ชันแก้ไขจุดขัดข้อง) ---
app.post('/api/ai-chat', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const userQuery = req.body.query;
    
    // 1. เปลี่ยน API Key เป็นของคุณที่เพิ่งสร้างใหม่
    const apiKey = "AIzaSyAlyfGADObdnOiVzygM80mxLIS7UpptG3A"; 

    const getData = (sql, params) => new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });

    try {
        const meds = await getData("SELECT name, time, stock, unit, dosage, info FROM medicines WHERE userId = ?", [req.session.userId]);
        const logs = await getData("SELECT medName, takenAt FROM medicine_logs WHERE userId = ? ORDER BY takenAt DESC LIMIT 10", [req.session.userId]);

        const context = `คุณคือ MedBot ผู้ช่วยจัดการยา ตอบเป็นภาษาไทยอย่างสุภาพ ข้อมูลยาผู้ใช้: ${JSON.stringify(meds)} ประวัติการทาน: ${JSON.stringify(logs)} คำถามจากผู้ใช้: "${userQuery}"`;

        // เปลี่ยน URL ในส่วน fetch เป็นตัวนี้ครับ:
// --- ส่วนที่ต้องแก้ไขใน app.js ---

// 1. เปลี่ยนชื่อโมเดลเป็น gemini-1.5-flash-latest (รุ่นที่ Google ให้ใช้ฟรีล่าสุด)
// 2. ใช้ URL เวอร์ชัน v1beta (ซึ่งรองรับรุ่นใหม่ๆ ได้ดีกว่าสำหรับ API Key ฟรี)
// แก้ไขบรรทัด apiUrl ใน app.js ให้เป็นตามนี้เป๊ะๆ ครับ:
// เปลี่ยน URL เป็นรุ่น 2.0 Flash ตามรายการที่ระบบอนุญาต
// ใช้ v1beta และรุ่น gemini-flash-latest
const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;

const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        contents: [{ parts: [{ text: context }] }]
    })
});
        const data = await response.json();

        // ตรวจสอบว่า Google ส่ง Error กลับมาไหม
        if (data.error) {
            console.error("Google Error:", data.error.message);
            return res.json({ reply: "ขออภัยครับ Google แจ้งว่า: " + data.error.message });
        }

        // ดึงข้อความตอบกลับจาก AI
        const aiReply = data.candidates[0].content.parts[0].text;
        res.json({ reply: aiReply });

    } catch (error) {
        console.error("System Error:", error);
        res.status(500).json({ reply: "ระบบขัดข้อง: " + error.message });
    }
});

app.get('/api/user-info', (req, res) => {
    if (!req.session.userId) return res.json({});
    db.get("SELECT email FROM users WHERE id = ?", [req.session.userId], (err, row) => res.json(row || {}));
});

app.post('/api/forgot-password', (req, res) => {
    const userEmail = req.body.email;
    
    // ส่งข้อความหา Admin ทาง LINE
    lineClient.pushMessage(myLineId, [{
        type: 'text',
        text: `🆘 มีคำขอรีเซ็ตรหัสผ่าน!\n📧 จากผู้ใช้: ${userEmail}\n\nกรุณาตรวจสอบที่เมนูจัดการผู้ใช้งาน (Admin Section)`
    }]).then(() => {
        res.json({ success: true });
    }).catch(err => {
        console.error("Line Error:", err);
        res.status(500).json({ error: "Failed to notify admin" });
    });
});

// หน้าแผงควบคุม Admin
app.get('/admin/users', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    db.get("SELECT email FROM users WHERE id = ?", [req.session.userId], (err, user) => {
        if (user.email !== 'adminadmin@gmail.com') return res.send("สิทธิ์ไม่เพียงพอ");
        db.all("SELECT id, email, password, (SELECT COUNT(*) FROM medicines WHERE userId = users.id) as medCount FROM users", (err, users) => {
            const rows = users.map(u => `
                <tr class="border-b border-slate-50">
                    <td class="p-4 text-sm text-slate-500">${u.id}</td>
                    <td class="p-4 font-bold text-slate-700">${u.email}</td>
                    <td class="p-4 text-center font-bold text-sky-600">${u.medCount}</td>
                    <td class="p-4 text-right">
                        <form action="/admin/reset-password/${u.id}" method="POST" onsubmit="confirmAction(event, 'รีเซ็ตรหัสผ่าน?', 'รหัสจะถูกเปลี่ยนเป็น 123456', 'ยืนยัน', 'warning')">
                            <button class="text-xs bg-amber-100 text-amber-700 px-3 py-1.5 rounded-lg font-bold hover:bg-amber-200 transition">🔄 Reset Pass</button>
                        </form>
                    </td>
                </tr>`).join('');
            res.send(layout(`<div class="mb-8"><h2 class="text-3xl font-bold text-slate-800">🔑 ผู้ดูแลระบบ</h2></div><div class="soft-card overflow-hidden"><table class="w-full text-left"><thead class="bg-slate-50 text-slate-400 text-[10px] uppercase font-bold tracking-widest"><tr><th class="p-4">ID</th><th class="p-4">Email</th><th class="p-4 text-center">ยาในระบบ</th><th class="p-4 text-right">จัดการ</th></tr></thead><tbody>${rows}</tbody></table></div>`, req.session.userId));
        });
    });
});

app.post('/admin/reset-password/:id', async (req, res) => {
    db.get("SELECT email FROM users WHERE id = ?", [req.session.userId], async (err, user) => {
        if (user && user.email === 'adminadmin@gmail.com') {
            const newHash = await bcrypt.hash("123456", 10);
            db.run("UPDATE users SET password = ? WHERE id = ?", [newHash, req.params.id], () => res.redirect('/admin/users'));
        } else res.send("สิทธิ์ไม่เพียงพอ");
    });
});


app.get('/api/stats', (req, res) => {
    if (!req.session.userId) return res.json({ percent: 0 });
    db.get("SELECT COUNT(*) as target FROM medicines WHERE userId = ?", [req.session.userId], (err, row) => {
        const weeklyTarget = (row.target || 0) * 7;
        db.get("SELECT COUNT(*) as actual FROM medicine_logs WHERE userId = ? AND takenAt > date('now','-7 days','localtime')", [req.session.userId], (err, log) => {
            const percent = weeklyTarget > 0 ? Math.min(Math.round((log.actual / weeklyTarget) * 100), 100) : 0;
            res.json({ percent });
        });
    });
});

app.get('/', (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');

    db.get(
        "SELECT linkToken FROM users WHERE id = ?",
        [req.session.userId],
        (err, user) => {

            db.all(
                "SELECT * FROM medicines WHERE userId = ? ORDER BY time ASC",
                [req.session.userId],
                (err, meds) => {

        const getTimeInfo = (timeStr) => {
            const hour = parseInt(timeStr.split(':')[0]);
            if (hour >= 5 && hour < 11) return { name: 'เช้า (Morning)', icon: '🌅', color: 'text-amber-500' };
            if (hour >= 11 && hour < 15) return { name: 'กลางวัน (Afternoon)', icon: '☀️', color: 'text-sky-500' };
            if (hour >= 15 && hour < 20) return { name: 'เย็น (Evening)', icon: '🌆', color: 'text-orange-500' };
            return { name: 'ก่อนนอน (Night)', icon: '🌙', color: 'text-indigo-500' };
        };
        const groups = { 'เช้า (Morning)': [], 'กลางวัน (Afternoon)': [], 'เย็น (Evening)': [], 'ก่อนนอน (Night)': [] };
        meds.forEach(m => { groups[getTimeInfo(m.time).name].push(m); });

        let dashboardContent = '';
        for (const [title, items] of Object.entries(groups)) {
            if (items.length > 0) {
                const info = getTimeInfo(items[0].time);
                dashboardContent += `
                <div class="mb-10">
                    <div class="flex items-center gap-2 mb-4 border-b border-slate-200 pb-2"><span class="text-2xl">${info.icon}</span><h2 class="text-xl font-bold ${info.color}">${title}</h2></div>
                    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                        ${items.map(m => `
                        <div class="soft-card p-6 flex flex-col items-center text-center">
                            <a href="/edit/${m.id}" class="absolute top-4 right-4 bg-slate-100 p-2 rounded-full text-sm hover:bg-sky-100">✏️</a>
                            <img src="/uploads/${m.image}" class="w-full h-40 object-cover rounded-2xl mb-4 border border-slate-50">
                            <div class="bg-sky-100 text-sky-700 px-3 py-1 rounded-full text-xs font-bold mb-2 uppercase">เวลา: ${m.time} น.</div>
                            <h3 class="font-bold text-xl mb-1 text-slate-800">${m.name}</h3>
                            <div class="w-full bg-slate-50 p-3 rounded-2xl mb-4">
                                <div class="flex justify-between text-xs font-bold mb-1"><span class="text-slate-400 uppercase">คงเหลือ</span><span class="${m.stock <= (m.dosage*3) ? 'text-rose-500 animate-pulse' : 'text-sky-600'}">${m.stock} ${m.unit}</span></div>
                                <div class="w-full bg-slate-200 h-1.5 rounded-full"><div class="blue-gradient h-full rounded-full" style="width: ${Math.min((m.stock/(m.dosage*10))*100, 100)}%"></div></div>
                            </div>
                            <form onsubmit="confirmAction(event, 'บันทึกการทานยา?', '${m.name}', 'บันทึกแล้ว')" action="/take/${m.id}" method="POST" class="w-full">
                                <button type="submit" class="w-full blue-gradient text-white py-4 rounded-xl font-bold ${m.stock < m.dosage ? 'opacity-50' : ''}" ${m.stock < m.dosage ? 'disabled' : ''}>${m.stock < m.dosage ? '❌ ยาหมด' : '✅ ทานแล้ว'}</button>
                            </form>
                        </div>`).join('')}
                    </div>
                </div>`;
            }
        }
        res.send(layout(`
            <div class="soft-card p-5 mb-6 text-center">
    <p class="text-sm text-slate-500">📱 เชื่อม LINE Bot</p>
    <p class="text-2xl font-bold text-sky-600">${user.linkToken || '-'}</p>
    <p class="text-xs text-slate-400">
        แอด LINE Bot แล้วพิมพ์โค้ดนี้
    </p>
</div>

            <div class="mb-8"><h1 class="text-3xl font-bold text-slate-800">สวัสดีคุณผู้ใช้งาน</h1></div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-10">
                <div class="soft-card p-6 flex items-center gap-6">
                    <div class="w-16 h-16"><canvas id="statChart"></canvas></div>
                    <div><p class="text-xs font-bold text-slate-400">วินัยสัปดาห์นี้</p><p id="pctText" class="text-3xl font-bold text-sky-600">0%</p></div>
                </div>
                <div class="blue-gradient p-6 rounded-[2rem] text-white flex flex-col justify-center">
                    <p class="font-medium text-sm mb-3">เป้าหมายของคุณในวันนี้: <span class="font-bold">${meds.length} ยา</span></p>
                    <div class="bg-white/30 h-3 rounded-full overflow-hidden p-0.5"><div id="statBar" class="bg-white h-full rounded-full transition-all duration-1000" style="width:0%"></div></div>
                </div>
            </div>
            ${dashboardContent || '<div class="text-center py-20 text-slate-400">ยังไม่มีรายการยา</div>'}
            <script>
                fetch('/api/stats').then(r=>r.json()).then(d=>{
                    document.getElementById('pctText').innerText = d.percent + '%';
                    document.getElementById('statBar').style.width = d.percent + '%';
                    new Chart(document.getElementById('statChart'), { type: 'doughnut', data: { datasets: [{ data: [d.percent, 100-d.percent], backgroundColor: ['#0ea5e9', '#f1f5f9'], borderWidth: 0 }] }, options: { cutout: '75%', plugins: { tooltip: { enabled: false } }, events: [] } });
                });
            </script>`, req.session.userId, 'dashboard'));
          });
    });
});

app.get('/edit/:id', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    db.get("SELECT * FROM medicines WHERE id = ? AND userId = ?", [req.params.id, req.session.userId], (err, m) => {
        if (!m) return res.redirect('/dashboard');
        res.send(layout(`
            <div class="soft-card max-w-lg mx-auto p-8">
                <h2 class="text-2xl font-bold mb-6 text-slate-800 flex justify-between">✏️ แก้ไขยา <form action="/delete/${m.id}" method="POST" onsubmit="confirmAction(event, 'ลบรายการยา?', 'ลบ ${m.name}', 'ลบ', 'warning')"><button class="text-xs text-rose-400 underline font-normal">ลบยา</button></form></h2>
                <form method="POST" action="/edit/${m.id}" class="space-y-4">
                    <input name="name" value="${m.name}" placeholder="ชื่อยา" required class="w-full p-4 bg-slate-50 border rounded-xl">
                    <div class="grid grid-cols-2 gap-4"><input type="time" name="time" value="${m.time}" required class="p-4 bg-slate-50 border rounded-xl"><input name="unit" value="${m.unit}" placeholder="หน่วย" required class="p-4 bg-slate-50 border rounded-xl"></div>
                    <div class="grid grid-cols-2 gap-4"><div><label class="text-[10px] text-slate-400">สต็อก</label><input type="number" step="0.1" name="stock" value="${m.stock}" required class="w-full p-4 bg-slate-50 border rounded-xl"></div><div><label class="text-[10px] text-slate-400">ครั้งละ</label><input type="number" step="0.1" name="dosage" value="${m.dosage}" required class="w-full p-4 bg-slate-50 border rounded-xl"></div></div>
                    <textarea name="info" class="w-full p-4 bg-slate-50 border rounded-xl">${m.info}</textarea>
                    <button class="w-full blue-gradient text-white py-4 rounded-xl font-bold shadow-md">บันทึกข้อมูล</button>
                    <a href="/dashboard" class="block text-center text-slate-400 mt-2">ยกเลิก</a>
                </form>
            </div>`, req.session.userId));
    });
});

app.post('/edit/:id', (req, res) => {
    const { name, time, unit, stock, dosage, info } = req.body;
    db.run("UPDATE medicines SET name=?, time=?, unit=?, stock=?, dosage=?, info=? WHERE id=? AND userId=?", [name, time, unit, stock, dosage, info, req.params.id, req.session.userId], () => res.redirect('/dashboard'));
});

app.get('/add', (req, res) => res.send(layout(`<div class="soft-card max-w-lg mx-auto p-8"><h2 class="text-2xl font-bold mb-6 text-slate-800">➕ เพิ่มยาใหม่</h2><form method="POST" action="/add" enctype="multipart/form-data" class="space-y-4"><input name="name" placeholder="ชื่อยา" required class="w-full p-4 bg-slate-50 border rounded-xl"><div class="grid grid-cols-2 gap-4"><input type="time" name="time" required class="p-4 bg-slate-50 border rounded-xl"><input name="unit" placeholder="หน่วย" required class="p-4 bg-slate-50 border rounded-xl"></div><div class="grid grid-cols-2 gap-4"><input type="number" name="stock" placeholder="สต็อก" required class="p-4 bg-slate-50 border rounded-xl"><input type="number" step="0.1" name="dosage" placeholder="ทานครั้งละ" required class="p-4 bg-slate-50 border rounded-xl"></div><textarea name="info" placeholder="รายละเอียด" class="w-full p-4 bg-slate-50 border rounded-xl"></textarea><input type="file" name="image" required class="text-xs text-slate-400"><button class="w-full blue-gradient text-white py-4 rounded-xl font-bold shadow-md">บันทึกยา</button></form></div>`, req.session.userId, 'add')));

app.post('/add', upload.single('image'), (req, res) => {
    const { name, time, unit, stock, dosage, info } = req.body;
    db.run("INSERT INTO medicines (userId, name, info, image, time, stock, unit, dosage) VALUES (?,?,?,?,?,?,?,?)", [req.session.userId, name, info, req.file ? req.file.filename : '', time, stock, unit, dosage], () => res.redirect('/dashboard'));
});

app.post('/take/:id', (req, res) => {
    db.get("SELECT name, stock, dosage FROM medicines WHERE id = ?", [req.params.id], (err, m) => {
        if (m && m.stock >= m.dosage) {
            const newStock = m.stock - m.dosage; // คำนวณสต็อกใหม่
            db.run("UPDATE medicines SET stock = ? WHERE id = ?", [newStock, req.params.id], () => {
                
                // --- เพิ่มบรรทัดนี้เพื่อสั่งให้ LINE เตือน ---
                checkLowStock(req.session.userId, m.name, newStock);

                // --------------------------------------

                const thaiTime = new Date(new Date().getTime() + (7 * 60 * 60 * 1000)).toISOString().replace('Z', '').replace('T', ' ');
                db.run("INSERT INTO medicine_logs (userId, medicineId, medName, takenAt) VALUES (?,?,?,?)", [req.session.userId, req.params.id, m.name, thaiTime], () => res.redirect('/dashboard'));
            });
        }
    });
});

app.get('/logs', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    db.all("SELECT * FROM medicine_logs WHERE userId = ? ORDER BY takenAt DESC LIMIT 30", [req.session.userId], (err, rows) => {
        const list = rows.map(l => `<div class="soft-card p-5 mb-3 flex justify-between items-center"><div class="flex items-center gap-4"><div class="w-10 h-10 bg-sky-50 rounded-full flex items-center justify-center text-sky-500">✔</div><div><span class="font-bold text-slate-800 block">${l.medName}</span><span class="text-slate-400 text-xs">${new Date(l.takenAt).toLocaleString('th-TH')}</span></div></div><form onsubmit="confirmAction(event, 'ลบประวัติ?', 'ลบข้อมูลนี้?', 'ลบ', 'warning')" action="/del-log/${l.id}" method="POST"><button class="px-5 py-2 rounded-xl bg-rose-50 text-rose-600 font-bold text-sm">ลบ</button></form></div>`).join('');
        res.send(layout(`<h2 class="text-3xl font-bold text-slate-800 mb-6">📋 ประวัติการทานยา</h2><div class="max-w-2xl mx-auto">${list || '<p class="text-center py-20 text-slate-300">ไม่มีข้อมูล</p>'}</div>`, req.session.userId, 'logs'));
    });
});

app.post('/del-log/:id', (req, res) => db.run("DELETE FROM medicine_logs WHERE id = ? AND userId = ?", [req.params.id, req.session.userId], () => res.redirect('/logs')));
app.post('/delete/:id', (req, res) => db.run("DELETE FROM medicines WHERE id=? AND userId=?", [req.params.id, req.session.userId], () => res.redirect('/dashboard')));

app.get('/login', (req, res) => res.send(layout(`
    <div class="max-w-md mx-auto mt-16 soft-card p-10 text-center">
        <h2 class="text-4xl font-bold text-sky-600 mb-2">MedTrack</h2>
        <form method="POST" class="space-y-4 mt-8" id="loginForm">
            <input id="loginEmail" name="email" type="email" placeholder="อีเมล" class="w-full p-4 bg-slate-50 border rounded-xl" required>
            <input name="password" type="password" placeholder="รหัสผ่าน" class="w-full p-4 bg-slate-50 border rounded-xl" required>
            
            <div class="text-right">
                <button type="button" onclick="forgotPassword()" class="text-xs text-slate-400 hover:text-sky-600">ลืมรหัสผ่าน?</button>
            </div>

            <button class="w-full blue-gradient text-white py-4 rounded-xl font-bold shadow-lg">เข้าสู่ระบบ</button>
        </form>
        <div class="mt-6"><p class="text-sm text-slate-400">ยังไม่มีบัญชี? <a href="/register" class="text-sky-600 font-bold">สมัครสมาชิก</a></p></div>
    </div>

    <script>
        async function forgotPassword() {
            const email = document.getElementById('loginEmail').value;
            if(!email) {
                Swal.fire('กรุณากรอกอีเมล', 'กรุณากรอกอีเมลของคุณในช่องด้านบนก่อนกดลืมรหัสผ่าน', 'warning');
                return;
            }

            const result = await Swal.fire({
                title: 'แจ้งลืมรหัสผ่าน?',
                text: "ระบบจะส่งคำขอรีเซ็ตรหัสผ่านไปยังแอดมินสำหรับอีเมล: " + email,
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: 'ส่งคำขอ',
                cancelButtonText: 'ยกเลิก'
            });

            if (result.isConfirmed) {
                fetch('/api/forgot-password', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    body: 'email=' + encodeURIComponent(email)
                });
                Swal.fire('ส่งคำขอแล้ว!', 'กรุณารอแอดมินดำเนินการรีเซ็ตรหัสผ่านให้คุณ', 'success');
            }
        }
    </script>
`)));

app.post('/login', (req, res) => { db.get("SELECT * FROM users WHERE email=?", [req.body.email], async (err, user) => { if (user && await bcrypt.compare(req.body.password, user.password)) { req.session.userId = user.id; res.redirect('/dashboard'); } else res.send("<script>alert('ผิดพลาด'); window.history.back();</script>"); }); });
app.get('/register', (req, res) => res.send(layout(`
    <div class="max-w-md mx-auto mt-16 soft-card p-10 text-center">
        <h2 class="text-2xl font-bold mb-8 text-slate-800">สมัครสมาชิกใหม่</h2>
        
        <form method="POST" class="space-y-4">
            <input name="email" type="email" placeholder="อีเมล" class="w-full p-4 bg-slate-50 border rounded-xl" required>
            <input name="password" type="password" placeholder="รหัสผ่าน" class="w-full p-4 bg-slate-50 border rounded-xl" required>
            <button class="w-full bg-slate-800 text-white py-4 rounded-xl font-bold shadow-lg hover:bg-slate-700 transition">สร้างบัญชี</button>
        </form>

        <div class="mt-6 pt-6 border-t border-slate-100">
            <p class="text-sm text-slate-400">มีบัญชีผู้ใช้งานอยู่แล้ว? 
                <a href="/login" class="text-sky-600 font-bold hover:underline">เข้าสู่ระบบที่นี่</a>
            </p>
        </div>
    </div>
`)));
app.post('/register', async (req, res) => {
    const hash = await bcrypt.hash(req.body.password, 10);
    const linkToken = 'LINK-' + Math.random().toString(36).substring(2, 8).toUpperCase();

    db.run(
        "INSERT INTO users (email, password, linkToken) VALUES (?,?,?)",
        [req.body.email, hash, linkToken],
        () => res.redirect('/login')
    );
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });



// --- ระบบแจ้งเตือนตามเวลา (ทุกๆ 1 นาที ระบบจะตรวจสอบว่ามียาต้องกินไหม) ---
cron.schedule('* * * * *', () => {
    const now = new Date();
    // ปรับเวลาให้เป็นเขตเวลาไทย (GMT+7)
    const thTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
    const currentTime = thTime.getUTCHours().toString().padStart(2, '0') + ":" + 
                        thTime.getUTCMinutes().toString().padStart(2, '0');

    console.log(`[System] Checking reminders for: ${currentTime}`);

    // ค้นหายาที่ตรงกับเวลาปัจจุบัน
   db.all(`
    SELECT 
        medicines.*, 
        users.lineUserId
    FROM medicines
    JOIN users ON medicines.userId = users.id
    WHERE medicines.time = ?
`, [currentTime], (err, meds) => {
    if (err) return console.error(err);

    meds.forEach(m => {

        // ถ้ายังไม่ผูก LINE → ข้าม
        if (!m.lineUserId) return;

        console.log(`[LINE] Sending alert to ${m.lineUserId} for: ${m.name}`);

        lineClient.pushMessage(m.lineUserId, [{
            type: 'text',
            text: `🔔 ได้เวลาทานยาแล้วครับ!
💊 ยา: ${m.name}
📢 รายละเอียด: ${m.info || '-'}
💊 ครั้งละ: ${m.dosage} ${m.unit}`
        }]).catch(err => console.error("Line Push Error:", err));
    });
});

});

// --- ส่วนล้างรหัสผ่าน Admin เพื่อให้ bcrypt ตรวจสอบผ่าน ---
async function resetAdminPassword() {
    const email = 'adminadmin@gmail.com';
    const rawPassword = '123456'; // รหัสผ่านใหม่ที่คุณต้องการใช้
    const hashedPassword = await bcrypt.hash(rawPassword, 10);

    db.run("UPDATE users SET password = ? WHERE email = ?", [hashedPassword, email], function(err) {
        if (this.changes > 0) {
            console.log(`✅ อัปเดตรหัสผ่านสำหรับ ${email} เรียบร้อยแล้ว! (รหัสคือ: ${rawPassword})`);
        } else {
            console.log("❌ ไม่พบอีเมล admin ในฐานข้อมูล กรุณาสมัครสมาชิกใหม่ด้วยอีเมลนี้ก่อน");
        }
    });
}
resetAdminPassword();

console.log(
  'LINE_SECRET length:',
  process.env.LINE_CHANNEL_SECRET?.length
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Running on port...', PORT));
