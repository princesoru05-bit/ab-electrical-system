const express = require('express');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const streamifier = require('streamifier');
const { google } = require('googleapis');
const bcrypt = require('bcryptjs');
const session = require('express-session');

const app = express();

// --- SESSION MIDDLEWARE ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'ab-electrical-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 hari
    }
}));

// --- 1. SETTING GOOGLE OAUTH2 (MANAGER: princesorustorage05) ---
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const LOCAL_SERVICE_ACCOUNT_PATH = path.join(__dirname, 'service-account.json');
// Render exposes Secret Files under /etc/secrets. Locally we use the ignored file.
const SERVICE_ACCOUNT_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_FILE
    || (fs.existsSync(LOCAL_SERVICE_ACCOUNT_PATH) ? LOCAL_SERVICE_ACCOUNT_PATH : '/etc/secrets/service-account.json');

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const peopleService = google.people({ version: 'v1', auth: oauth2Client });
// Service account membolehkan rekod Drive berfungsi tanpa token OAuth di mesin
// server. Pastikan folder Registration dikongsi kepada service account sebagai Editor.
const driveAuth = fs.existsSync(SERVICE_ACCOUNT_PATH)
    ? new google.auth.GoogleAuth({ keyFile: SERVICE_ACCOUNT_PATH, scopes: ['https://www.googleapis.com/auth/drive'] })
    : oauth2Client;
const driveService = google.drive({ version: 'v3', auth: driveAuth });

// --- FOLDER ID ---
const REGISTRATION_FOLDER_ID = process.env.REGISTRATION_FOLDER_ID || '1FBXbGYqEtjqn6JplIuqRbIAy9dHtrX_a';
// Laporan servis masuk ke folder Registration yang sama secara default. Jika mahu
// asingkan kemudian, tetapkan SERVICE_REPORT_FOLDER_ID di Render.
const SERVICE_REPORT_FOLDER_ID = process.env.SERVICE_REPORT_FOLDER_ID || REGISTRATION_FOLDER_ID;

// --- IN-MEMORY USER CACHE ---
// { username_lowercase: { username, email, passwordHash } }
let usersCache = {};

// --- FUNGSI: LOAD SEMUA USER DARI GOOGLE DRIVE ---
async function loadUsersFromDrive() {
    try {
        const res = await driveService.files.list({
            q: `'${REGISTRATION_FOLDER_ID}' in parents and mimeType='text/plain' and trashed=false`,
            fields: 'files(id, name)',
        });
        const files = res.data.files || [];
        for (const file of files) {
            const content = await driveService.files.get(
                { fileId: file.id, alt: 'media' },
                { responseType: 'text' }
            );
            const text = content.data;
            const lines = text.split('\n');
            const getData = (label) => {
                const line = lines.find(l => l.startsWith(label + ':'));
                return line ? line.slice(label.length + 1).trim() : '';
            };
            const username = getData('USERNAME');
            const email = getData('EMAIL');
            const passwordHash = getData('PASSWORD_HASH');
            if (username && passwordHash) {
                usersCache[username.toLowerCase()] = { username, email, passwordHash };
            }
        }
        console.log(`✅ [AUTH] ${Object.keys(usersCache).length} user(s) diload dari Google Drive.`);
    } catch (err) {
        console.error('❌ [AUTH] Gagal load users dari Drive:', err.message);
    }
}

// --- FUNGSI: SIMPAN USER BARU KE GOOGLE DRIVE ---
async function saveUserToDrive(username, email, passwordHash) {
    try {
        const tarikh = new Date().toLocaleString('ms-MY', {
            timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'long', timeStyle: 'short'
        });
        const filename = username.replace(/\s+/g, '_') + '.txt';
        // Kata laluan asal sengaja tidak disimpan. Hash bcrypt ini hanya boleh
        // digunakan untuk mengesahkan log masuk, bukan untuk melihat password.
        const content = `USERNAME: ${username}\nEMAIL: ${email}\nPASSWORD_HASH: ${passwordHash}\nREGISTERED ON: ${tarikh}\n`;

        // Semak kalau fail dah wujud (duplicate check)
        const existing = await driveService.files.list({
            q: `'${REGISTRATION_FOLDER_ID}' in parents and name='${filename}' and trashed=false`,
            fields: 'files(id)',
        });
        if (existing.data.files && existing.data.files.length > 0) {
            return false; // Username dah wujud
        }

        await driveService.files.create({
            requestBody: {
                name: filename,
                mimeType: 'text/plain',
                parents: [REGISTRATION_FOLDER_ID]
            },
            media: {
                mimeType: 'text/plain',
                body: streamifier.createReadStream(Buffer.from(content, 'utf-8'))
            }
        });

        console.log(`✅ [AUTH] User baru disimpan ke Drive: ${filename}`);
        return true;
    } catch (err) {
        console.error('❌ [AUTH] Gagal simpan user ke Drive:', err.message);
        throw err;
    }
}

// --- FUNGSI 1: AUTO-ADD GOOGLE CONTACT ---
async function createGoogleContact(nama, phone, orderId, jenisBarang) {
    try {
        let formattedPhone = phone.trim();
        if (formattedPhone.startsWith('0')) {
            formattedPhone = '+60' + formattedPhone.slice(1);
        }

        await peopleService.people.createContact({
            requestBody: {
                names: [{ givenName: `${orderId} - ${nama}` }],
                phoneNumbers: [{ value: formattedPhone, type: 'mobile' }],
                biographies: [{ value: `Jenis Barangan: ${jenisBarang}`, contentType: 'TEXT_PLAIN' }]
            }
        });
        console.log(`✅ [GOOGLE CONTACT] BERJAYA ADD: ${orderId} - ${nama}`);
    } catch (err) {
        console.error('❌ [GOOGLE CONTACT ERROR]:', err.response ? JSON.stringify(err.response.data) : err.message);
        throw new Error('Google Contact gagal dikemaskini: ' + err.message);
    }
}

// --- FUNGSI 2: AUTO-UPLOAD FOLDER & FAIL KE GOOGLE DRIVE ---
async function uploadToGoogleDrive(orderId, pdfBuffer, imageFiles) {
    try {
        const PARENT_FOLDER_ID = SERVICE_REPORT_FOLDER_ID;

        // 1. Buat Sub-folder mengikut orderId di Google Drive
        const folderRes = await driveService.files.create({
            requestBody: {
                name: orderId,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [PARENT_FOLDER_ID]
            },
            fields: 'id'
        });
        const folderId = folderRes.data.id;

        // 2. Upload Fail PDF Resit dari Buffer
        await driveService.files.create({
            requestBody: {
                name: `${orderId}.pdf`,
                parents: [folderId]
            },
            media: {
                mimeType: 'application/pdf',
                body: streamifier.createReadStream(pdfBuffer)
            }
        });

        // 3. Upload semua gambar kerosakan (jika ada) dari Buffer
        await Promise.all((imageFiles || []).map((file, index) => {
            const ext = path.extname(file.originalname) || '.jpg';
            return driveService.files.create({
                requestBody: { name: `gambar_${orderId}_${index + 1}${ext}`, parents: [folderId] },
                media: { mimeType: file.mimetype, body: streamifier.createReadStream(file.buffer) }
            });
        }));

        console.log(`✅ [GOOGLE DRIVE SUCCESS] Fail & Folder ${orderId} berjaya dimuat naik ke Drive!`);
    } catch (err) {
        console.error('❌ [GOOGLE DRIVE ERROR DETAIL]:', err.response ? JSON.stringify(err.response.data) : err.message);
        throw new Error('Google Drive gagal dikemaskini: ' + err.message);
    }
}

// --- FUNGSI KAWALAN GENERATE PDF ---
function generatePDFBuffer(orderId, nama, phone, alamat, jenis_barang, model, masalah, imageFiles, tarikhHantar) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument();
        let buffers = [];

        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        const orange = '#f97316';
        const ink = '#171310';
        const muted = '#57534e';
        const pageWidth = doc.page.width;
        const left = 48;
        const contentWidth = pageWidth - (left * 2);
        const safe = (value) => String(value || 'Tiada maklumat');
        const field = (label, value, x, y, width) => {
            doc.font('Helvetica-Bold').fontSize(8).fillColor(muted).text(label.toUpperCase(), x, y, { width, characterSpacing: .5 });
            doc.font('Helvetica').fontSize(11).fillColor(ink).text(safe(value), x, y + 13, { width, height: 34, ellipsis: true });
        };

        // Header identiti AB Electrical (gelap + aksen oren seperti laman utama)
        doc.rect(0, 0, pageWidth, 112).fill(ink);
        doc.rect(0, 108, pageWidth, 4).fill(orange);
        doc.circle(left + 22, 50, 22).fill(orange);
        doc.font('Helvetica-Bold').fontSize(14).fillColor('#ffffff').text('AB', left + 9, 42, { width: 28, align: 'center' });
        doc.font('Helvetica-Bold').fontSize(18).fillColor('#ffffff').text('AB ELECTRICAL ENGINEERING', left + 58, 31);
        doc.font('Helvetica').fontSize(9).fillColor('#d6d3d1').text('PAKAR PEMBAIKAN BARANGAN ELEKTRIK', left + 59, 56, { characterSpacing: 1.1 });
        doc.font('Helvetica-Bold').fontSize(9).fillColor(orange).text('RESIT LAPORAN SERVIS', left + 59, 76);
        doc.font('Helvetica-Bold').fontSize(12).fillColor('#ffffff').text(orderId, pageWidth - left - 150, 47, { width: 150, align: 'right' });

        doc.y = 142;
        doc.font('Helvetica-Bold').fontSize(17).fillColor(ink).text('Service Report Summary');
        doc.moveDown(.35);
        doc.font('Helvetica').fontSize(9).fillColor(muted).text('This information was recorded automatically when the form was submitted.');
        doc.moveDown(1.1);

        const cardTop = doc.y;
        doc.roundedRect(left, cardTop, contentWidth, 137, 8).fillAndStroke('#fff7ed', '#fed7aa');
        field('Customer name', nama, left + 16, cardTop + 16, 220);
        field('Phone number', phone, left + 270, cardTop + 16, 215);
        field('Appliance type', jenis_barang, left + 16, cardTop + 67, 220);
        field('Brand & model', model, left + 270, cardTop + 67, 215);
        field('Submitted on', tarikhHantar, left + 16, cardTop + 112, contentWidth - 32);
        doc.y = cardTop + 160;

        doc.font('Helvetica-Bold').fontSize(11).fillColor(ink).text('Customer address');
        doc.moveDown(.35);
        doc.roundedRect(left, doc.y, contentWidth, 42, 6).fillAndStroke('#fafaf9', '#e7e5e4');
        doc.font('Helvetica').fontSize(10).fillColor(ink).text(safe(alamat), left + 12, doc.y + 12, { width: contentWidth - 24, height: 22, ellipsis: true });
        doc.y += 62;

        doc.font('Helvetica-Bold').fontSize(11).fillColor(ink).text('Problem description');
        doc.moveDown(.35);
        const problemTop = doc.y;
        doc.roundedRect(left, problemTop, contentWidth, 72, 6).fillAndStroke('#fafaf9', '#e7e5e4');
        doc.font('Helvetica').fontSize(10).fillColor(ink).text(safe(masalah), left + 12, problemTop + 12, { width: contentWidth - 24, height: 50 });
        doc.y = problemTop + 98;

        if (imageFiles && imageFiles.length) {
            doc.font('Helvetica-Bold').fontSize(13).fillColor(ink).text(`Damage photos (${imageFiles.length})`);
            doc.moveDown(.5);
            imageFiles.forEach((file, index) => {
                if (doc.y > 535) doc.addPage();
                const imageTop = doc.y;
                doc.roundedRect(left, imageTop, contentWidth, 225, 7).fillAndStroke('#fafaf9', '#e7e5e4');
                doc.font('Helvetica-Bold').fontSize(9).fillColor(orange).text(`GAMBAR ${index + 1}`, left + 12, imageTop + 10);
                doc.font('Helvetica').fontSize(8).fillColor(muted).text(safe(file.originalname), left + 88, imageTop + 10, { width: contentWidth - 100, ellipsis: true });
                doc.image(file.buffer, { fit: [contentWidth - 24, 190], align: 'center', valign: 'center', x: left + 12, y: imageTop + 28 });
                doc.y = imageTop + 239;
            });
        }

        const footerY = doc.page.height - 42;
        doc.moveTo(left, footerY - 10).lineTo(pageWidth - left, footerY - 10).lineWidth(.5).strokeColor('#e7e5e4').stroke();
        doc.font('Helvetica').fontSize(8).fillColor(muted).text('AB Electrical Engineering  ·  Thank you for choosing us.', left, footerY, { width: contentWidth, align: 'center' });

        doc.end();
    });
}

// --- 2. SETTING MULTER & MIDDLEWARE ---
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024, files: 8 },
    fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png'].includes(file.mimetype))
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(__dirname));

// Route untuk Halaman Utama (Advance Homepage)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Route untuk Halaman Borang Pendaftaran / Laporan
app.get('/registration_page.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'registration_page.html'));
});

const pdfStore = new Map();

app.get('/download-pdf/:orderId', (req, res) => {
    const orderId = req.params.orderId;
    const pdfBuffer = pdfStore.get(orderId);

    if (pdfBuffer) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=${orderId}.pdf`);
        res.send(pdfBuffer);
    } else {
        res.status(404).send('Fail PDF tidak dijumpai atau telah tamat tempoh.');
    }
});

let orderCounter = 551;

// --- HELPER: escape HTML supaya input pelanggan tak rosakkan halaman ---
function esc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// =====================================================
// --- ROUTE: DAFTAR AKAUN BARU (REGISTER) ---
// =====================================================
app.post('/register', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!username || !email || !password) {
        return res.status(400).json({ success: false, message: 'Semua medan wajib diisi.' });
    }

    if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) {
        return res.status(400).json({ success: false, message: 'Username mesti 3–30 aksara (huruf, nombor, titik, sempang atau underscore).' });
    }

    if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password mesti sekurang-kurangnya 6 aksara.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ success: false, message: 'Format email tidak sah.' });
    }

    // Semak duplicate dalam cache
    if (usersCache[username.toLowerCase()]) {
        return res.status(409).json({ success: false, message: 'Username sudah digunakan. Sila pilih username lain.' });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 10);
        const saved = await saveUserToDrive(username, email, passwordHash);

        if (!saved) {
            return res.status(409).json({ success: false, message: 'Username sudah digunakan. Sila pilih username lain.' });
        }

        // Tambah ke cache
        usersCache[username.toLowerCase()] = { username, email, passwordHash };

        // Auto login lepas register
        req.session.user = { username, email };

        return res.json({ success: true, message: 'Akaun berjaya didaftarkan!', username });
    } catch (err) {
        console.error('❌ [REGISTER ERROR]:', err.message);
        return res.status(500).json({ success: false, message: 'Ralat server. Cuba lagi.' });
    }
});

// =====================================================
// --- ROUTE: LOG MASUK (LOGIN) ---
// =====================================================
app.post('/login', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username dan password diperlukan.' });
    }

    const user = usersCache[username.toLowerCase()];

    if (!user) {
        return res.status(401).json({ success: false, message: 'Username atau password salah.' });
    }

    try {
        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match) {
            return res.status(401).json({ success: false, message: 'Username atau password salah.' });
        }

        req.session.user = { username: user.username, email: user.email };
        return res.json({ success: true, message: 'Log masuk berjaya!', username: user.username });
    } catch (err) {
        console.error('❌ [LOGIN ERROR]:', err.message);
        return res.status(500).json({ success: false, message: 'Ralat server. Cuba lagi.' });
    }
});

// =====================================================
// --- ROUTE: LOG KELUAR (LOGOUT) ---
// =====================================================
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) console.error('❌ [LOGOUT ERROR]:', err.message);
        res.clearCookie('connect.sid');
        res.json({ success: true });
    });
});

// =====================================================
// --- ROUTE: SEMAK STATUS AUTH ---
// =====================================================
app.get('/check-auth', (req, res) => {
    if (req.session && req.session.user) {
        return res.json({ loggedIn: true, username: req.session.user.username });
    }
    return res.json({ loggedIn: false });
});

// =====================================================
// --- 3. SUBMIT FORM HANDLER ---
// =====================================================
app.post('/submit-service', upload.array('gambar', 8), async (req, res) => {

    const { nama, phone, alamat, jenis_barang, model, masalah } = req.body;
    const orderId = `KOD-${String(orderCounter++).padStart(4, '0')}`;

    const imageFiles = req.files || [];

    // 1. Generate PDF Buffer secara lengkap
    // Masa rasmi direkod ketika submit mengikut timezone Malaysia, bukan timezone server.
    const tarikhHantar = new Date().toLocaleString('ms-MY', {
        timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'long', timeStyle: 'short'
    });
    let pdfBuffer;
    try {
        pdfBuffer = await generatePDFBuffer(orderId, nama, phone, alamat, jenis_barang, model, masalah, imageFiles, tarikhHantar);
        pdfStore.set(orderId, pdfBuffer);

        // Rekod dianggap berjaya hanya selepas kedua-dua integrasi berjaya.
        await Promise.all([
            createGoogleContact(nama, phone, orderId, jenis_barang),
            uploadToGoogleDrive(orderId, pdfBuffer, imageFiles)
        ]);
    } catch (err) {
        console.error('❌ [SUBMIT SERVICE ERROR]:', err.message);
        return res.status(502).send(`<!doctype html><html lang="ms"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Submission Failed</title><body style="margin:0;background:#171310;color:#fff;font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box"><main style="max-width:560px;background:#211916;border:1px solid #ef4444;border-radius:16px;padding:32px"><p style="color:#fb923c;font-weight:bold">AB ELECTRICAL ENGINEERING</p><h1>Rekod belum berjaya disimpan</h1><p style="color:#d6d3d1;line-height:1.6">Google Drive atau Google Contacts tidak dapat dikemaskini. Sila cuba semula selepas admin betulkan sambungan.</p><p style="color:#fca5a5;font-size:14px">${esc(err.message)}</p><a href="/registration_page.html" style="display:inline-block;margin-top:12px;background:#f97316;color:#171310;padding:12px 18px;border-radius:8px;font-weight:bold;text-decoration:none">Kembali ke borang</a></main></body></html>`);
    }

    // 3. Link WhatsApp Manager
    const noMekanik = '60195254754';
    const textWA = encodeURIComponent(`Salam AB Electrical, saya dah hantar borang rujukan *${orderId}* (${nama}) untuk baiki ${jenis_barang}.`);
    const waLink = `https://wa.me/${noMekanik}?text=${textWA}`;

    const tarikh = tarikhHantar;

    const row = (label, value) => `
                        <div class="flex items-start justify-between gap-4 py-2.5 border-b border-stone-800 last:border-0">
                            <span class="text-xs uppercase tracking-wider text-stone-500 shrink-0">${esc(label)}</span>
                            <span class="text-sm text-stone-200 text-right break-words">${esc(value || '-')}</span>
                        </div>`;

    res.send(`<!DOCTYPE html>
<html lang="ms">
<head>
    <meta charset="UTF-8">
    <title>Report Submitted - AB Electrical Engineering</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { font-family: 'Inter', system-ui, -apple-system, sans-serif; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
        .animate-fade-up { animation: fadeUp .5s ease-out both; }
        .delay-100 { animation-delay: .1s; }
    </style>
</head>
<body class="min-h-screen bg-[#171310] text-white">

    <header class="bg-[#11100f] border-b-4 border-orange-600">
        <div class="max-w-5xl mx-auto px-4 py-4 flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg bg-orange-600 flex items-center justify-center font-black text-white">AB</div>
            <div class="leading-tight">
                <p class="font-black tracking-tight text-white text-sm sm:text-base">AB ELECTRICAL ENGINEERING</p>
                <p class="text-[11px] uppercase tracking-widest text-stone-500">Electrical Appliance Repair Specialists</p>
            </div>
        </div>
    </header>

    <main class="px-4 py-10 sm:py-16 flex justify-center">
        <div class="w-full max-w-lg bg-[#211916] rounded-2xl shadow-2xl border border-orange-500/15 p-6 sm:p-10 animate-fade-up">

            <div class="flex flex-col items-center text-center">
                <div class="w-16 h-16 rounded-full bg-orange-500/10 ring-4 ring-orange-500/20 flex items-center justify-center mb-5">
                    <svg class="w-8 h-8 text-orange-500" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                </div>
                <h1 class="text-2xl sm:text-3xl font-black tracking-tight text-white">Report Submitted Successfully!</h1>
                <p class="mt-2 text-sm text-stone-400">Thank you, ${esc(nama)}. We will contact you shortly.</p>
            </div>

            <div class="mt-7 rounded-xl bg-[#171310] border border-orange-500/30 p-5 text-center">
                <p class="text-[11px] uppercase tracking-widest text-stone-500">Your Reference Code</p>
                <p id="kod" class="mt-1 font-mono font-bold text-orange-500 text-2xl sm:text-3xl tracking-wider">${esc(orderId)}</p>
                <button type="button" onclick="salinKod()" id="btnSalin"
                    class="mt-3 text-xs font-semibold text-stone-400 hover:text-orange-400 underline underline-offset-4 transition-colors">
                    Copy code
                </button>
            </div>

            <div class="mt-6">
                <p class="text-[11px] uppercase tracking-widest text-stone-500 mb-1">Order Summary</p>
        ${row('Name', nama)}
                ${row('Phone', phone)}
                ${row('Appliance', jenis_barang)}
                ${row('Model', model)}
                ${row('Submitted on', tarikh)}
            </div>

            <div class="mt-7 space-y-3 animate-fade-up delay-100">
                <a href="${waLink}" target="_blank" rel="noopener"
                    class="flex items-center justify-center gap-2 w-full bg-orange-600 hover:bg-orange-500 text-white font-bold py-3.5 px-4 rounded-lg shadow-lg shadow-orange-900/30 transition-colors duration-200">
                    <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M20.5 3.5A11.9 11.9 0 0012 0C5.4 0 .1 5.3.1 11.9c0 2.1.6 4.1 1.6 5.9L0 24l6.4-1.7c1.7.9 3.6 1.4 5.6 1.4 6.6 0 11.9-5.3 11.9-11.9 0-3.2-1.2-6.2-3.4-8.3zM12 21.4c-1.8 0-3.5-.5-5-1.4l-.4-.2-3.8 1 1-3.7-.2-.4a9.5 9.5 0 01-1.5-5.1c0-5.2 4.3-9.5 9.5-9.5 2.5 0 4.9 1 6.7 2.8a9.4 9.4 0 012.8 6.7c0 5.3-4.3 9.5-9.5 9.5zm5.2-7.1c-.3-.1-1.7-.8-1.9-.9-.3-.1-.5-.1-.7.1-.2.3-.7.9-.9 1.1-.2.2-.3.2-.6.1a7.7 7.7 0 01-2.3-1.4 8.6 8.6 0 01-1.6-2c-.2-.3 0-.4.1-.6l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.9-2.1c-.2-.5-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.1.2 2.1 3.2 5 4.5.7.3 1.3.5 1.7.6.7.2 1.4.2 1.9.1.6-.1 1.7-.7 2-1.4.2-.7.2-1.3.2-1.4-.1-.2-.3-.2-.6-.3z"/></svg>
                    Notify Manager on WhatsApp
                </a>

                <a href="/download-pdf/${esc(orderId)}"
                    class="flex items-center justify-center gap-2 w-full border border-orange-500/40 hover:border-orange-500 hover:bg-orange-500/10 text-orange-400 font-bold py-3.5 px-4 rounded-lg transition-colors duration-200">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" />
                    </svg>
                    Download PDF Receipt
                </a>

                <a href="/" class="block text-center text-sm text-stone-500 hover:text-stone-300 transition-colors pt-1">
                    Return to Home
                </a>
            </div>

            <p class="mt-7 text-center text-xs text-stone-500 leading-relaxed">
                A copy of your receipt and photos has been saved automatically.
            </p>
        </div>
    </main>

    <footer class="bg-[#11100f] text-stone-500 text-center text-xs py-6 border-t border-stone-800">
        &copy; ${new Date().getFullYear()} AB Electrical Engineering
    </footer>

    <script>
        function salinKod() {
            var kod = document.getElementById('kod').textContent.trim();
            var btn = document.getElementById('btnSalin');
            navigator.clipboard.writeText(kod).then(function () {
                btn.textContent = 'Kod disalin!';
                setTimeout(function () { btn.textContent = 'Salin kod'; }, 2000);
            });
        }
    </script>
</body>
</html>`);

});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
        console.warn('⚠️ [GOOGLE CONTACT] CLIENT_ID, CLIENT_SECRET atau REFRESH_TOKEN belum diset. Contact tidak akan dapat dibuat.');
    }
    // Load semua user dari Drive masa server start
    await loadUsersFromDrive();
});
