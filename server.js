process.env.NODE_OPTIONS = '--dns-result-order=ipv4first';
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
const { DateTime } = require("luxon");
const express = require("express");
const fs = require("fs");
const bodyParser = require("body-parser");
const QRCode = require("qrcode");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const { randomUUID } = require("crypto");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));

const FILE = "reservations.json";

// Créer le fichier si inexistant
if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, "[]");
}

// --- FONCTION POUR SÉCURISER LE HTML ---
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
app.post("/api/checkpass", (req, res) => {
  const { password } = req.body;

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ ok: false, error: "ADMIN_PASSWORD non défini" });
  }

  if (password === process.env.ADMIN_PASSWORD) {
    return res.json({ ok: true });
  }

  res.json({ ok: false });
});


// --- EXPIRATION AUTOMATIQUE ---

/**
 * Marque comme "expiré" toute réservation (en attente ou validé)
 * dont la séance est passée depuis plus de 10 minutes.
 * Retourne true si au moins une réservation a été modifiée.
 */
function applyExpirations(data) {
    const now = DateTime.now().setZone("Europe/Paris");
    let changed = false;

    data.forEach(r => {
        if (r.status === "expiré" || r.status === "refusé") return;
        if (!r.sessionDate || !r.sessionTime) return;

        const sessionDateTime = DateTime.fromFormat(
            `${r.sessionDate} ${r.sessionTime}`,
            "yyyy-MM-dd HH:mm",
            { zone: "Europe/Paris" }
        );

        if (sessionDateTime.isValid && now >= sessionDateTime.plus({ minutes: 10 })) {
            r.status = "expiré";
            r.expiredAt = new Date();
            changed = true;
        }
    });

    return changed;
}

// Vérification automatique toutes les minutes
setInterval(() => {
    try {
        const data = JSON.parse(fs.readFileSync(FILE));
        if (applyExpirations(data)) {
            fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
            console.log(`[${new Date().toISOString()}] Réservations expirées mises à jour.`);
        }
    } catch (err) {
        console.error("Erreur lors de la vérification des expirations :", err);
    }
}, 60 * 1000);

// --- ROUTES ---

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

// 📥 Créer réservation
app.post("/api/reserver", (req, res) => {
    const { sessionDate, sessionTime } = req.body;

    // Vérification que la date/heure de séance n'est pas dépassée
    if (sessionDate && sessionTime) {
        const sessionDateTime = DateTime.fromFormat(
            `${sessionDate} ${sessionTime}`,
            "yyyy-MM-dd HH:mm",
            { zone: "Europe/Paris" }
        );
        const now = DateTime.now().setZone("Europe/Paris");

        if (!sessionDateTime.isValid || sessionDateTime < now) {
            return res.status(400).send("La date et l'heure de la séance sont déjà passées. Impossible d'effectuer cette réservation.");
        }
    }

    // Vérification du nombre de personnes (max 10)
    if (parseInt(req.body.peopleNumber) > 10) {
        return res.status(400).send("Le nombre de personnes est limité à 10 par réservation.");
    }

    const data = JSON.parse(fs.readFileSync(FILE));
    const newResa = {
        id: randomUUID(),
        status: "en attente",
        ...req.body
    };
    data.push(newResa);
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    res.send("Réservation enregistrée");
});

// 🖥️ Voir réservations (Admin)
app.get("/api/admin", (req, res) => {
    const data = JSON.parse(fs.readFileSync(FILE));
    if (applyExpirations(data)) {
        fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    }
    res.json(data);
});
// Check résa client 
app.get("/api/reservation", (req, res) => {
  const name = (req.query.name || "").trim().toLowerCase();

  if (!name) {
    return res.json({ ok: false, error: "Nom manquant" });
  }

  // Ton fichier JSON
  const reservations = JSON.parse(fs.readFileSync("./reservations.json", "utf8"));

  const result = reservations.filter(r =>
    r.clientName.toLowerCase().includes(name)
  );

  if (result.length === 0) {
    return res.json({ ok: false, error: "Aucune réservation trouvée" });
  }

  res.json({ ok: true, reservations: result });
});
app.post("/api/supprimer", (req, res) => {
  const { id } = req.body;

  if (!id) return res.status(400).send("ID manquant");

  const filePath = "./reservations.json";
  const reservations = JSON.parse(fs.readFileSync(filePath, "utf8"));

  const updated = reservations.filter(r => r.id !== id);

  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));

  res.send("Réservation supprimée");
});


// 📩 Valider + Télécharger PDF (remplace l'envoi email)
app.post("/api/valider", async (req, res) => {
    try {
        const { id } = req.body;
        let data = JSON.parse(fs.readFileSync(FILE));
        const resa = data.find(r => r.id === id);

        if (!resa) return res.status(404).send("Réservation introuvable");

        // Vérification que la séance n'est pas expirée (10 min après)
        if (resa.sessionDate && resa.sessionTime) {
            const sessionDateTime = DateTime.fromFormat(
                `${resa.sessionDate} ${resa.sessionTime}`,
                "yyyy-MM-dd HH:mm",
                { zone: "Europe/Paris" }
            );
            const now = DateTime.now().setZone("Europe/Paris");
            if (sessionDateTime.isValid && now >= sessionDateTime.plus({ minutes: 10 })) {
                resa.status = "expiré";
                resa.expiredAt = new Date();
                fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
                return res.status(400).send("La séance est expirée. Validation impossible.");
            }
        }

        const BASE_URL = process.env.BASE_URL || "https://reservation-cinepop.onrender.com";
        const qrData = `${BASE_URL}/verify?id=${resa.id}`;

        // QR Code buffer
        const qrBuffer = await QRCode.toBuffer(qrData);
        const qrBase64 = qrBuffer.toString("base64");

        const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    body { font-family: Arial; }
    .ticket {
        width: 280px;
        border: 2px dashed black;
        padding: 20px;
        text-align: center;
        margin: 0 auto;
    }
</style>
</head>
<body>
    <div class="ticket">
        <h2>TICKET CINEPOP</h2>
        <hr>
        <h1>${escapeHtml(resa.filmTitle)}</h1>
        <p><b>Salle :</b> ${escapeHtml(resa.roomNumber)}</p>
        <p><b>Date :</b> ${escapeHtml(resa.sessionDate)}</p>
        <p><b>Heure :</b> ${escapeHtml(resa.sessionTime)}</p>
        <p><b>Client :</b> ${escapeHtml(resa.clientName)}</p>
        <p><b>Places :</b> ${escapeHtml(resa.peopleNumber)}</p>
        <img src="data:image/png;base64,${qrBase64}" style="width:120px;" />
        <p style="font-size:10px;">Ticket #${resa.id}</p>
    </div>
</body>
</html>
`;

        // --- LANCEMENT PUPPETEER ---
        const browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--single-process",
                "--no-zygote"
            ],
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: "networkidle0" });

        const buffer = await page.pdf({
            width: "300px",
            height: "500px",
            printBackground: true
        });

        await browser.close();

        // Mise à jour de la réservation
        resa.status = "validé";
        resa.validatedAt = new Date();
        fs.writeFileSync(FILE, JSON.stringify(data, null, 2));

        // 🔥 Téléchargement direct du PDF
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="ticket-Cinepop-${resa.clientName}.pdf"`);
        res.send(buffer);

    } catch (err) {
        console.error(err);
        res.status(500).send("Erreur lors de la validation");
    }
});

// ❌ Refuser réservation
app.post("/api/refuser", async (req, res) => {
    try {
        const { id } = req.body;
        let data = JSON.parse(fs.readFileSync(FILE));
        const resa = data.find(r => r.id === id);

        if (!resa) return res.status(404).send("Réservation introuvable");

        resa.status = "refusé";
        resa.refusedAt = new Date();
        fs.writeFileSync(FILE, JSON.stringify(data, null, 2));

        res.send("Réservation refusée");
    } catch (err) {
        console.error(err);
        res.status(500).send("Erreur lors du refus");
    }
});

// 🔎 Vérification QR code (TON HTML COMPLET EST CONSERVÉ)
app.get("/verify", (req, res) => {
    const id = req.query.id;
    const check = req.query.check;

    const data = JSON.parse(fs.readFileSync(FILE));
    const resa = data.find(r => r.id === id);

    // --- SI CHECK = 1 → ON RENVOIE JSON ---
    if (check == "1") {
        if (!resa) return res.json({ status: "invalid", reason: "Identifiant inexistant" });
        if (resa.status == "refusé") return res.json({ status: "invalid", reason: "réservation refusée" });
        if (resa.status == "en attente") return res.json({ status: "invalid", reason: "réservation en attente" });

        const now = DateTime.now().setZone("Europe/Paris").toJSDate();
        const sessionDateTime = DateTime.fromFormat(
            `${resa.sessionDate} ${resa.sessionTime}`,
            "yyyy-MM-dd HH:mm",
            { zone: "Europe/Paris" }
        ).toJSDate();

        const startWindow = new Date(sessionDateTime);
        startWindow.setMinutes(startWindow.getMinutes() - 30);
        const endWindow = new Date(sessionDateTime);
        endWindow.setMinutes(endWindow.getMinutes() + 5);

        if (now < startWindow || now > endWindow) {
            return res.json({ status: "invalid", reason: "Hors délai" });
        }

        return res.json({
            status: "valid",
            client: resa.clientName,
            film: resa.filmTitle,
            salle: resa.roomNumber,
            date: resa.sessionDate,
            heure: resa.sessionTime
        });
    }

    // --- SINON → PAGE AVEC BOUTON CHECK (TON HTML ORIGINAL) ---
    res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Vérification Ticket</title>
<style>
    * { box-sizing: border-box; }
    body {
        background: #fff;
        font-family: Arial, sans-serif;
        margin: 0;
        min-height: 100vh;
        display: flex;
        justify-content: center;
        align-items: center;
        padding: 16px;
        text-align: center;
    }
    #checkBtn {
        width: min(90vw, 360px);
        padding: 18px 24px;
        font-size: 20px;
        border-radius: 12px;
        border: none;
        background: #3498db;
        color: white;
        cursor: pointer;
        touch-action: manipulation;
    }
    #result {
        margin-top: 20px;
        display: none;
    }
    .card {
        width: min(92vw, 420px);
        padding: 28px 20px;
        border-radius: 16px;
        border: 2px solid #e0e0e0;
        box-shadow: 0 10px 25px rgba(0,0,0,0.08);
        margin: 0 auto;
        background: white;
    }
    .icon {
        width: 96px;
        height: auto;
        margin-bottom: 16px;
    }
    h1 {
        font-size: 28px;
        margin: 10px 0;
    }
    p {
        font-size: 17px;
        margin: 6px 0;
        line-height: 1.4;
        word-break: break-word;
    }
    .loader {
        width: 80px;
        height: 80px;
        margin: 0 auto 15px;
        border-radius: 50%;
        position: relative;
    }
    .loader::before {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 4px solid transparent;
        border-top: 4px solid #00d4ff;
        border-right: 4px solid #00d4ff;
        animation: spin 1s linear infinite;
    }
    .loader::after {
        content: "";
        position: absolute;
        inset: 12px;
        border-radius: 50%;
        background: radial-gradient(circle, #00d4ff33, transparent);
        animation: pulse 1.5s ease-in-out infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pulse {
        0%, 100% { transform: scale(1); opacity: 0.6; }
        50% { transform: scale(1.2); opacity: 1; }
    }
</style>
</head>
<body>

<div>
    <button id="checkBtn">CHECK TICKET</button>
    <div id="result"></div>
</div>

<script>
document.getElementById("checkBtn").addEventListener("click", async () => {
    navigator.vibrate?.(40);
    const box = document.getElementById("result");
    box.style.display = "block";

    box.innerHTML = '<div class="loader"></div><div class="text">Vérification...</div>';

    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
        const res = await fetch("/verify?id=${id}&check=1");
        const data = await res.json();

        if (data.status === "valid") {
            box.innerHTML =
                '<div class="card"><img src="/img/check.png" class="icon"><h1 style="color:#2ecc71;">Ticket VALIDE</h1>' +
                '<p><b>Client :</b> ' + data.client + '</p>' +
                '<p><b>Film :</b> ' + data.film + '</p>' +
                '<p><b>Salle :</b> ' + data.salle + '</p>' +
                '<p><b>Date :</b> ' + data.date + '</p>' +
                '<p><b>Heure :</b> ' + data.heure + '</p></div>';

            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const response = await fetch("/sounds/valid.mp3");
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);
            source.start(0);

        } else {
            box.innerHTML =
                '<div class="card"><img src="/img/cross.png" class="icon"><h1 style="color:#e74c3c;">Ticket REFUSÉ</h1>' +
                '<p>Raison : ' + data.reason + '</p></div>';

            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const response = await fetch("/sounds/error.mp3");
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);
            source.start(0);
        }
    } catch (err) {
        box.innerHTML = '<div class="card"><h1 style="color:#e74c3c;">Erreur</h1><p>Impossible de vérifier le ticket</p></div>';
    }
});
</script>

</body>
</html>
`);
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Serveur lancé sur le port " + PORT);
});
