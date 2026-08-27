const express = require('express');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const streamifier = require('streamifier');
const { google } = require('googleapis');

const app = express();

// --- 1. SETTING GOOGLE OAUTH2 (MANAGER: princesorustorage05) ---
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const peopleService = google.people({ version: 'v1', auth: oauth2Client });
const driveService = google.drive({ version: 'v3', auth: oauth2Client });

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
    }
}

// --- FUNGSI 2: AUTO-UPLOAD FOLDER & FAIL KE GOOGLE DRIVE ---
async function uploadToGoogleDrive(orderId, pdfBuffer, imageBuffer, imageFileName) {
    try {
        const PARENT_FOLDER_ID = '1BtDqeFE14W0OhSaa3CUCDzIQrUBH9Css';

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

        // 3. Upload Gambar Kerosakan (jika ada) dari Buffer
        if (imageBuffer && imageFileName) {
            await driveService.files.create({
                requestBody: {
                    name: imageFileName,
                    parents: [folderId]
                },
                media: {
                    mimeType: 'image/jpeg',
                    body: streamifier.createReadStream(imageBuffer)
                }
            });
        }

        console.log(`✅ [GOOGLE DRIVE SUCCESS] Fail & Folder ${orderId} berjaya dimuat naik ke Drive!`);
    } catch (err) {
        console.error('❌ [GOOGLE DRIVE ERROR DETAIL]:', err.response ? JSON.stringify(err.response.data) : err.message);
    }
}

// --- FUNGSI KAWALAN GENERATE PDF ---
function generatePDFBuffer(orderId, nama, phone, alamat, jenis_barang, model, masalah, imageBuffer) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument();
        let buffers = [];

        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        doc.fontSize(20).text('AB ELECTRICAL ENGINEERING', { align: 'center' });
        doc.fontSize(12).text(`NO. RESIT / KOD: ${orderId}`, { align: 'center' });
        doc.moveDown();
        doc.text(`--------------------------------------------------`);
        doc.text(`Nama Pelanggan: ${nama}`);
        doc.text(`No. Telefon: ${phone}`);
        doc.text(`Alamat: ${alamat}`);
        doc.text(`Jenis Barangan: ${jenis_barang}`);
        doc.text(`Model: ${model || 'Tiada Maklumat'}`);
        doc.text(`Masalah: ${masalah}`);
        doc.text(`--------------------------------------------------`);
        doc.moveDown();

        if (imageBuffer) {
            doc.text('GAMBAR KEROSAKAN:', { underline: true });
            doc.moveDown(0.5);
            doc.image(imageBuffer, { fit: [300, 200], align: 'center' });
        }

        doc.end();
    });
}

// --- 2. SETTING MULTER & MIDDLEWARE ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(express.urlencoded({ extended: true }));
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

// --- 3. SUBMIT FORM HANDLER ---
app.post('/submit-service', upload.single('gambar'), async (req, res) => {

    const { nama, phone, alamat, jenis_barang, model, masalah } = req.body;
    const orderId = `KOD-${String(orderCounter++).padStart(4, '0')}`;

    let imageBuffer = req.file ? req.file.buffer : null;
    let imageFileName = null;
    if (req.file) {
        const ext = path.extname(req.file.originalname) || '.jpg';
        imageFileName = `gambar_${orderId}${ext}`;
    }

    // 1. Generate PDF Buffer secara lengkap
    const pdfBuffer = await generatePDFBuffer(orderId, nama, phone, alamat, jenis_barang, model, masalah, imageBuffer);
    pdfStore.set(orderId, pdfBuffer);

    // 2. Add Google Contact & Upload ke Drive secara serentak
    await Promise.all([
        createGoogleContact(nama, phone, orderId, jenis_barang),
        uploadToGoogleDrive(orderId, pdfBuffer, imageBuffer, imageFileName)
    ]);

    // 3. Link WhatsApp Manager
    const noMekanik = '60195254754';
    const textWA = encodeURIComponent(`Salam AB Electrical, saya dah hantar borang rujukan *${orderId}* (${nama}) untuk baiki ${jenis_barang}.`);
    const waLink = `https://wa.me/${noMekanik}?text=${textWA}`;

    const tarikh = new Date().toLocaleString('ms-MY', { dateStyle: 'long', timeStyle: 'short' });

    const row = (label, value) => `
                        <div class="flex items-start justify-between gap-4 py-2.5 border-b border-stone-800 last:border-0">
                            <span class="text-xs uppercase tracking-wider text-stone-500 shrink-0">${esc(label)}</span>
                            <span class="text-sm text-stone-200 text-right break-words">${esc(value || '-')}</span>
                        </div>`;

    res.send(`<!DOCTYPE html>
<html lang="ms">
<head>
    <meta charset="UTF-8">
    <title>Laporan Berjaya - AB Electrical Engineering</title>
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
                <p class="text-[11px] uppercase tracking-widest text-stone-500">Pakar Pembaikan Barangan Elektrik</p>
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
                <h1 class="text-2xl sm:text-3xl font-black tracking-tight text-white">Laporan Berjaya Dihantar!</h1>
                <p class="mt-2 text-sm text-stone-400">Terima kasih ${esc(nama)}. Kami akan hubungi anda tidak lama lagi.</p>
            </div>

            <div class="mt-7 rounded-xl bg-[#171310] border border-orange-500/30 p-5 text-center">
                <p class="text-[11px] uppercase tracking-widest text-stone-500">Kod Rujukan Anda</p>
                <p id="kod" class="mt-1 font-mono font-bold text-orange-500 text-2xl sm:text-3xl tracking-wider">${esc(orderId)}</p>
                <button type="button" onclick="salinKod()" id="btnSalin"
                    class="mt-3 text-xs font-semibold text-stone-400 hover:text-orange-400 underline underline-offset-4 transition-colors">
                    Salin kod
                </button>
            </div>

            <div class="mt-6">
                <p class="text-[11px] uppercase tracking-widest text-stone-500 mb-1">Ringkasan Pesanan</p>
                ${row('Nama', nama)}
                ${row('No. Telefon', phone)}
                ${row('Jenis Barangan', jenis_barang)}
                ${row('Model', model)}
                ${row('Tarikh Hantar', tarikh)}
            </div>

            <div class="mt-7 space-y-3 animate-fade-up delay-100">
                <a href="${waLink}" target="_blank" rel="noopener"
                    class="flex items-center justify-center gap-2 w-full bg-orange-600 hover:bg-orange-500 text-white font-bold py-3.5 px-4 rounded-lg shadow-lg shadow-orange-900/30 transition-colors duration-200">
                    <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M20.5 3.5A11.9 11.9 0 0012 0C5.4 0 .1 5.3.1 11.9c0 2.1.6 4.1 1.6 5.9L0 24l6.4-1.7c1.7.9 3.6 1.4 5.6 1.4 6.6 0 11.9-5.3 11.9-11.9 0-3.2-1.2-6.2-3.4-8.3zM12 21.4c-1.8 0-3.5-.5-5-1.4l-.4-.2-3.8 1 1-3.7-.2-.4a9.5 9.5 0 01-1.5-5.1c0-5.2 4.3-9.5 9.5-9.5 2.5 0 4.9 1 6.7 2.8a9.4 9.4 0 012.8 6.7c0 5.3-4.3 9.5-9.5 9.5zm5.2-7.1c-.3-.1-1.7-.8-1.9-.9-.3-.1-.5-.1-.7.1-.2.3-.7.9-.9 1.1-.2.2-.3.2-.6.1a7.7 7.7 0 01-2.3-1.4 8.6 8.6 0 01-1.6-2c-.2-.3 0-.4.1-.6l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.9-2.1c-.2-.5-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.1.2 2.1 3.2 5 4.5.7.3 1.3.5 1.7.6.7.2 1.4.2 1.9.1.6-.1 1.7-.7 2-1.4.2-.7.2-1.3.2-1.4-.1-.2-.3-.2-.6-.3z"/></svg>
                    Hantar Notis ke WhatsApp Manager
                </a>

                <a href="/download-pdf/${esc(orderId)}"
                    class="flex items-center justify-center gap-2 w-full border border-orange-500/40 hover:border-orange-500 hover:bg-orange-500/10 text-orange-400 font-bold py-3.5 px-4 rounded-lg transition-colors duration-200">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" />
                    </svg>
                    Muat Turun Salinan Resit PDF
                </a>

                <a href="/" class="block text-center text-sm text-stone-500 hover:text-stone-300 transition-colors pt-1">
                    Kembali ke Laman Utama
                </a>
            </div>

            <p class="mt-7 text-center text-xs text-stone-500 leading-relaxed">
                Salinan resit &amp; gambar telah auto-simpan dalam rekod maklumat sistem.
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
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});