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

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Laporan Berjaya</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="bg-gray-100 min-h-screen flex items-center justify-center p-4">
            <div class="bg-white p-8 rounded-xl shadow-md max-w-md w-full text-center">
                <div class="text-green-500 text-5xl mb-4">✓</div>
                <h2 class="text-2xl font-bold text-gray-800 mb-2">Laporan Berjaya Dihantar!</h2>
                <p class="text-gray-600 mb-4">Kod Rujukan Anda: <strong class="text-blue-600 font-mono text-lg">${orderId}</strong></p>
                
                <div class="space-y-3 my-6">
                    <a href="${waLink}" target="_blank" class="block w-full bg-green-500 hover:bg-green-600 text-white font-bold py-3 px-4 rounded-lg shadow transition duration-200">
                        📱 Hantar Notis ke WhatsApp Manager
                    </a>
                    
                    <a href="/download-pdf/${orderId}" class="block w-full bg-blue-500 hover:bg-blue-600 text-white font-bold py-3 px-4 rounded-lg shadow transition duration-200">
                        📄 Muat Turun Salinan Resit PDF
                    </a>
                </div>

                <p class="text-xs text-gray-400">Salinan resit & gambar telah auto-simpan dalam rekod maklumat sistem.</p>
            </div>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});