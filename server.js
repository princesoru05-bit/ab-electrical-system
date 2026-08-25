const express = require('express');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();

// --- 1. SETTING GOOGLE CONTACTS OAUTH2 ---
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET
);

oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const peopleService = google.people({ version: 'v1', auth: oauth2Client });

// Auto-Create Contact
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

// --- 2. SETTING MIDDLEWARE & STATIC FILES ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname)); // Direct serve fail statik dalam folder root

// ROUTE HALAMAN UTAMA (FIX FOR NOT FOUND)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Route Download PDF
app.get('/download-pdf/:orderId', (req, res) => {
    const orderId = req.params.orderId;
    const pdfPath = path.join(__dirname, 'uploads', orderId, `${orderId}.pdf`);
    if (fs.existsSync(pdfPath)) {
        res.download(pdfPath);
    } else {
        res.status(404).send('Fail PDF tidak dijumpai');
    }
});

let orderCounter = 551; 

// --- 3. SUBMIT FORM HANDLER ---
app.post('/submit-service', upload.single('gambar'), async (req, res) => {
    const { nama, phone, alamat, jenis_barang, model, masalah } = req.body;
    
    const orderId = `KOD-${String(orderCounter++).padStart(4, '0')}`;
    
    await createGoogleContact(nama, phone, orderId, jenis_barang);

    const clientFolderPath = path.join(__dirname, 'uploads', orderId);
    if (!fs.existsSync(clientFolderPath)) {
        fs.mkdirSync(clientFolderPath, { recursive: true });
    }

    let imagePath = null;
    if (req.file) {
        const ext = path.extname(req.file.originalname) || '.jpg';
        imagePath = path.join(clientFolderPath, `gambar_${orderId}${ext}`);
        fs.writeFileSync(imagePath, req.file.buffer);
    }

    const pdfPath = path.join(clientFolderPath, `${orderId}.pdf`);
    const doc = new PDFDocument();
    doc.pipe(fs.createWriteStream(pdfPath));

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

    if (imagePath) {
        doc.text('GAMBAR KEROSAKAN:', { underline: true });
        doc.moveDown(0.5);
        doc.image(imagePath, { fit: [300, 200], align: 'center' });
    }

    doc.end();

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
                        📱 Hantar Notis ke WhatsApp Mekanik
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