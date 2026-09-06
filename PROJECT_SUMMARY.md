# AB Electrical Engineering — Project Summary

## Siap dibina

- Laman utama mempunyai pop-up **Log In** dan **Register**.
- Pop-up telah dikemaskan supaya berada di tengah skrin, responsive, mempunyai jarak input yang selesa, dan menggunakan tema gelap/oren AB Electrical.
- Pop-up tidak lagi tertutup apabila pengguna left-click dan drag untuk memilih teks hingga keluar sedikit daripada border.
- Right-click pada backdrop pop-up Log In/Register akan menutup pop-up.
- Ralat Log In/Register dipaparkan dalam pop-up tengah skrin yang kemas, dengan butang untuk membuka semula form yang sesuai.
- Register berjaya memaparkan pop-up kejayaan dengan butang **Kembali ke halaman utama**.
- Login berjaya memaparkan pop-up kejayaan dengan butang **Teruskan ke halaman utama**.
- Selepas login, username dipaparkan di bahagian kanan atas. Klik username untuk membuka menu akaun dan **Log Out**.
- Log Out membuang session dan mengembalikan laman kepada keadaan Log In biasa.

## Sistem akaun

- Pendaftaran menyimpan `USERNAME`, `EMAIL`, `PASSWORD_HASH`, dan tarikh pendaftaran sebagai fail `.txt` dalam folder Google Drive Registration.
- Nama fail adalah berdasarkan username, contohnya `ali_hassan.txt`.
- Password menggunakan bcrypt hash. Password asal tidak disimpan dan tidak boleh dibaca semula oleh admin.
- Jika pelanggan lupa password, fungsi yang betul untuk dibina kemudian ialah **Reset Password**, bukan menyimpan password plain text.

## Google integrations

- Borang laporan kerosakan akan:
  - tambah customer ke Google Contacts;
  - bina folder `KOD-xxxx` dalam folder laporan servis Google Drive;
  - upload PDF resit dan gambar kerosakan.
- Pendaftaran akaun akan masuk ke folder Google Drive Registration.
- Sistem kini akan paparkan ralat jika Google Drive atau Google Contacts gagal dikemaskini, supaya submission tidak kelihatan berjaya secara palsu.

## Struktur credentials di Render

Render Web Service perlu mempunyai environment variables berikut:

```text
CLIENT_ID
CLIENT_SECRET
REFRESH_TOKEN
SESSION_SECRET
```

- `CLIENT_ID`, `CLIENT_SECRET`, dan `REFRESH_TOKEN` ialah OAuth credentials Google bagi akaun admin. Ia digunakan untuk Google Contacts dan Google Drive laporan servis.
- `SESSION_SECRET` mestilah nilai rawak yang panjang.
- `service-account.json` tidak perlu masuk GitHub. Jika masih mahu digunakan sebagai fallback, upload di Render melalui **Environment > Secret Files** dengan filename `service-account.json`.

## Deploy

Projek perlu deploy sebagai **Render Web Service**, bukan Static Site.

```text
Build Command: npm ci
Start Command: npm start
```

Selepas perubahan dibuat:

```powershell
git add .
git commit -m "Describe your change"
git push origin main
```

Render akan deploy commit terbaru jika auto-deploy aktif; jika tidak, gunakan **Manual Deploy > Deploy latest commit**.

## Nota semasa

- Amaran `express-session MemoryStore is not designed for production` tidak menghalang sistem berjalan, tetapi session boleh hilang selepas restart Render. Untuk skala production, tukar kepada persistent session store kemudian.
- Pastikan API Google People dan Google Drive diaktifkan dalam projek Google Cloud yang sama dengan OAuth credentials.
