const fetch = require('node-fetch');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const line = require('@line/bot-sdk');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const db = new sqlite3.Database('./database.db');

// --- CONFIGURATION ---
const lineConfig = {
    channelAccessToken: 'eedlKlaBxP/e9ECr8B7FSce0lI/22GZjU5s4utrBeUYOwr+L3H2+WRoALg6s0fR4BPB0CjL18cSRIByqYNwgKzwT5CFm+BwiTAj8mtX9UQ0Z6D/9FoFDpE9YCm+YIrPSf5noUI7MVduTYMjmROIDSAdB04t89/1O/w1cDnyilFU=', 
    channelSecret: '10efddbe99d7dea5aff2a164eb01521d'
};
const lineClient = new line.Client(lineConfig);
const myLineId = 'Ub93df2f838d5756fa7c9e8040b65530f';
const GEMINI_API_KEY = "AIzaSyAlyfGADObdnOiVzygM80mxLIS7UpptG3A";

// --- DIRECTORY SETUP ---
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({ 
    secret: 'medtrack-gentle-ui', 
    resave: false, 
    saveUninitialized: false 
}));

// --- DATABASE INIT ---
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE, password TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS medicines (id INTEGER PRIMARY KEY, userId INTEGER, name TEXT, info TEXT, image TEXT, time TEXT, stock REAL DEFAULT 0, unit TEXT, dosage REAL DEFAULT 1)");
    db.run("CREATE TABLE IF NOT EXISTS medicine_logs (id INTEGER PRIMARY KEY, userId INTEGER, medicineId INTEGER, medName TEXT, takenAt DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

// --- HELPER FUNCTIONS ---
function checkLowStock(medName, currentStock) {
    if (currentStock <= 5) {
        lineClient.pushMessage(myLineId, [{
            type: 'text',
            text: `⚠️ คำเตือน: ยา ${medName} ของคุณใกล้จะหมดแล้ว (เหลือเพียง ${currentStock} หน่วย) อย่าลืมเตรียมยาเพิ่มนะครับ!`
        }]).catch(err => console.error("Line Error:", err));
    }
}

// --- UI LAYOUT ---
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
        </style>
    </head>
    <body>
        ${userId ? `
        <aside class="fixed top-0 left-0 z-40 w-64 h-screen transition-transform -translate-x-full sm:translate-x-0 bg-white border-r border-blue-50">
            <div class="p-8 pb-4 text-2xl font-bold text-sky-600 flex items-center gap-2"><span class="text-3xl">🛡️</span> MedTrack</div>
            
            <div class="px-6 mb-6">
                <div class="bg-slate-50 p-3 rounded-2xl border border-slate-100 flex items-center gap-3">
                    <div class="w-8 h-8 blue-gradient rounded-full flex-shrink-0 flex items-center justify-center text-white text-xs">👤</div>
                    <div class="overflow-hidden">
                        <p class="text-[9px] font-bold text-slate-400 uppercase tracking-tighter">Login as:</p>
                        <p id="user-email-display" class="text-[11px] font-medium text-slate-600 truncate">Loading...</p>
                    </div>
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
                    <div><p class="font-bold">MedBot AI</p><p class="text-[10px] opacity-80">ถามข้อมูลจากบันทึกยาของคุณ</p></div>
                    <button onclick="toggleChat()" class="hover:rotate-90 transition">✕</button>
                </div>
                <div id="chat-content" class="h-80 overflow-y-auto p-4 space-y-4 bg-slate-50 flex flex-col text-sm">
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
            async function askAI() {
                const input = document.getElementById('chat-input');
                const content = document.getElementById('chat-content');
                if(!input.value.trim()) return;
                const userMsg = input.value;
                content.innerHTML += \`<div class="bg-sky-500 text-white p-3 rounded-2xl rounded-tr-none self-end max-w-[80%]">\${userMsg}</div>\`;
                input.value = '';
                content.scrollTop = content.scrollHeight;
                try {
                    const res = await fetch('/api/ai-chat', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                        body: 'query=' + encodeURIComponent(userMsg)
                    });
                    const data = await res.json();
                    content.innerHTML += \`<div class="bg-white p-3 rounded-2xl rounded-tl-none shadow-sm border border-slate-100 self-start max-w-[80%]">🤖: \${data.reply}</div>\`;
                } catch(e) { content.innerHTML += \`<div class="text-rose-500 text-xs italic text-center">ขัดข้อง</div>\`; }
                content.scrollTop = content.scrollHeight;
            }

            // ดึงข้อมูล User มาแสดงผล
            fetch('/api/user-info').then(r => r.json()).then(user => {
                if(user.email) {
                    document.getElementById('user-email-display').innerText = user.email;
                    if(user.email === 'adminadmin@gmail.com') {
                        document.getElementById('admin-menu').innerHTML = \`
                            <div class="mt-4 pt-4 border-t border-slate-100">
                                <p class="px-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Admin Section</p>
                                <a href="/admin/users" class="flex items-center gap-3 p-4 rounded-xl font-medium text-rose-600 hover:bg-rose-50 transition">🔑 จัดการผู้ใช้งาน</a>
                            </div>\`;
                    }
                }
            });
        </script>
        ` : ''}
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

// --- API ROUTES ---
app.post('/api/ai-chat', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    const userQuery = req.body.query;
    const getData = (sql, params) => new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });

    try {
        const meds = await getData("SELECT name, time, stock, unit, dosage, info FROM medicines WHERE userId = ?", [req.session.userId]);
        const logs = await getData("SELECT medName, takenAt FROM medicine_logs WHERE userId = ? ORDER BY takenAt DESC LIMIT 10", [req.session.userId]);
        const context = `คุณคือ MedBot ผู้ช่วยจัดการยา ตอบภาษาไทยสุภาพ ข้อมูลยา: ${JSON.stringify(meds)} ประวัติ: ${JSON.stringify(logs)} คำถาม: "${userQuery}"`;

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`;
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: context }] }] })
        });
        const data = await response.json();
        const aiReply = data.candidates[0].content.parts[0].text;
        res.json({ reply: aiReply });
    } catch (error) { res.status(500).json({ reply: "ขออภัย ระบบ AI ขัดข้อง" }); }
});

app.get('/api/user-info', (req, res) => {
    if (!req.session.userId) return res.json({});
    db.get("SELECT email FROM users WHERE id = ?", [req.session.userId], (err, row) => res.json(row || {}));
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

// --- MAIN PAGES ---
app.get('/', (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    db.all("SELECT * FROM medicines WHERE userId = ? ORDER BY time ASC", [req.session.userId], (err, meds) => {
        const groups = { 'เช้า': [], 'กลางวัน': [], 'เย็น': [], 'ก่อนนอน': [] };
        meds.forEach(m => {
            const h = parseInt(m.time.split(':')[0]);
            if (h >= 5 && h < 11) groups['เช้า'].push(m);
            else if (h >= 11 && h < 15) groups['กลางวัน'].push(m);
            else if (h >= 15 && h < 20) groups['เย็น'].push(m);
            else groups['ก่อนนอน'].push(m);
        });

        let dashboardContent = Object.entries(groups).map(([title, items]) => {
            if (items.length === 0) return '';
            return `
                <div class="mb-10">
                    <h2 class="text-xl font-bold mb-4 border-b pb-2">${title}</h2>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                        ${items.map(m => `
                        <div class="soft-card p-6 flex flex-col items-center">
                            <a href="/edit/${m.id}" class="absolute top-4 right-4 text-xs bg-slate-100 p-2 rounded-lg">✏️ แก้ไข</a>
                            <img src="/uploads/${m.image}" class="w-full h-32 object-cover rounded-xl mb-3">
                            <p class="text-xs font-bold text-sky-600 mb-1">${m.time} น.</p>
                            <h3 class="font-bold mb-3">${m.name}</h3>
                            <form action="/take/${m.id}" method="POST" class="w-full">
                                <button class="w-full blue-gradient text-white py-3 rounded-xl font-bold">✅ ทานแล้ว</button>
                            </form>
                        </div>`).join('')}
                    </div>
                </div>`;
        }).join('');

        res.send(layout(`
            <h1 class="text-2xl font-bold mb-6">แผงควบคุมการทานยา</h1>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                <div class="soft-card p-6 flex items-center gap-4">
                    <div class="w-12 h-12 bg-sky-100 rounded-full flex items-center justify-center">📈</div>
                    <div><p class="text-xs text-slate-400">วินัยการทานยา</p><p id="pctText" class="text-2xl font-bold text-sky-600">0%</p></div>
                </div>
            </div>
            ${dashboardContent || '<p class="text-center text-slate-400">ยังไม่มีรายการยา</p>'}
        `, req.session.userId, 'dashboard'));
    });
});

app.get('/add', (req, res) => res.send(layout(`<div class="soft-card max-w-lg mx-auto p-8"><h2>➕ เพิ่มยาใหม่</h2><form method="POST" action="/add" enctype="multipart/form-data" class="space-y-4"><input name="name" placeholder="ชื่อยา" required class="w-full p-4 border rounded-xl"><input type="time" name="time" required class="w-full p-4 border rounded-xl"><input name="unit" placeholder="หน่วย (เช่น เม็ด)" required class="w-full p-4 border rounded-xl"><input type="number" name="stock" placeholder="จำนวนยาที่มี" required class="w-full p-4 border rounded-xl"><input type="number" step="0.1" name="dosage" placeholder="ทานครั้งละ" required class="w-full p-4 border rounded-xl"><textarea name="info" placeholder="รายละเอียดการทาน" class="w-full p-4 border rounded-xl"></textarea><input type="file" name="image" required><button class="w-full blue-gradient text-white py-4 rounded-xl font-bold">บันทึกยา</button></form></div>`, req.session.userId, 'add')));

app.post('/add', upload.single('image'), (req, res) => {
    const { name, time, unit, stock, dosage, info } = req.body;
    db.run("INSERT INTO medicines (userId, name, info, image, time, stock, unit, dosage) VALUES (?,?,?,?,?,?,?,?)", [req.session.userId, name, info, req.file ? req.file.filename : '', time, stock, unit, dosage], () => res.redirect('/dashboard'));
});

app.post('/take/:id', (req, res) => {
    db.get("SELECT name, stock, dosage FROM medicines WHERE id = ?", [req.params.id], (err, m) => {
        if (m && m.stock >= m.dosage) {
            const newStock = m.stock - m.dosage;
            db.run("UPDATE medicines SET stock = ? WHERE id = ?", [newStock, req.params.id], () => {
                checkLowStock(m.name, newStock);
                const thaiTime = new Date(new Date().getTime() + (7 * 60 * 60 * 1000)).toISOString().replace('T', ' ').substring(0, 19);
                db.run("INSERT INTO medicine_logs (userId, medicineId, medName, takenAt) VALUES (?,?,?,?)", [req.session.userId, req.params.id, m.name, thaiTime], () => res.redirect('/dashboard'));
            });
        }
    });
});

app.get('/logs', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    db.all("SELECT * FROM medicine_logs WHERE userId = ? ORDER BY takenAt DESC LIMIT 20", [req.session.userId], (err, rows) => {
        const list = rows.map(l => `<div class="soft-card p-4 mb-2 flex justify-between"><span><b>${l.medName}</b> - ${l.takenAt}</span></div>`).join('');
        res.send(layout(`<h2>📋 ประวัติการทานยา</h2>${list || 'ไม่มีข้อมูล'}`, req.session.userId, 'logs'));
    });
});

app.get('/login', (req, res) => res.send(layout(`<div class="max-w-md mx-auto mt-20 soft-card p-10 text-center"><h2 class="text-3xl font-bold text-sky-600 mb-6">MedTrack Login</h2><form method="POST" class="space-y-4"><input name="email" type="email" placeholder="Email" class="w-full p-4 border rounded-xl" required><input name="password" type="password" placeholder="Password" class="w-full p-4 border rounded-xl" required><button class="w-full blue-gradient text-white py-4 rounded-xl font-bold">เข้าสู่ระบบ</button></form><p class="mt-4 text-sm">ยังไม่มีบัญชี? <a href="/register" class="text-sky-600 font-bold">สมัครที่นี่</a></p></div>`)));
app.post('/login', (req, res) => { db.get("SELECT * FROM users WHERE email=?", [req.body.email], async (err, user) => { if (user && await bcrypt.compare(req.body.password, user.password)) { req.session.userId = user.id; res.redirect('/dashboard'); } else res.send("<script>alert('อีเมลหรือรหัสผ่านผิด'); window.history.back();</script>"); }); });
app.get('/register', (req, res) => res.send(layout(`<div class="max-w-md mx-auto mt-20 soft-card p-10 text-center"><h2>สมัครสมาชิก</h2><form method="POST" class="space-y-4"><input name="email" type="email" placeholder="Email" class="w-full p-4 border rounded-xl" required><input name="password" type="password" placeholder="Password" class="w-full p-4 border rounded-xl" required><button class="w-full bg-slate-800 text-white py-4 rounded-xl font-bold">สร้างบัญชี</button></form></div>`)));
app.post('/register', async (req, res) => { const hash = await bcrypt.hash(req.body.password, 10); db.run("INSERT INTO users (email, password) VALUES (?,?)", [req.body.email, hash], () => res.redirect('/login')); });
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// --- CRON JOB ---
cron.schedule('* * * * *', () => {
    const thTime = new Date(new Date().getTime() + (7 * 60 * 60 * 1000));
    const currentTime = thTime.getUTCHours().toString().padStart(2, '0') + ":" + thTime.getUTCMinutes().toString().padStart(2, '0');
    console.log(`Checking reminders: ${currentTime}`);
    db.all("SELECT * FROM medicines WHERE time = ?", [currentTime], (err, meds) => {
        meds?.forEach(m => {
            lineClient.pushMessage(myLineId, [{ type: 'text', text: `🔔 ถึงเวลาทานยา ${m.name} แล้วครับ!` }])
            .catch(e => console.error(e));
        });
    });
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));