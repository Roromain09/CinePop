process.env.NODE_OPTIONS = '--dns-result-order=ipv4first';
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
const { DateTime } = require("luxon");
const express = require("express");
const QRCode = require("qrcode");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const { randomUUID } = require("crypto");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error("❌ SUPABASE_URL / SUPABASE_SERVICE_KEY manquants dans les variables d'environnement.");
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const app = express();
app.use(express.json());
app.use(express.static("public"));

// --- FONCTION POUR SÉCURISER LE HTML ---
function escapeHtml(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// --- AUTH ADMIN ---
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

// Toutes les routes /api/admin/* exigent le mot de passe en en-tête x-admin-password.
function requireAdmin(req, res, next) {
    const provided = req.get("x-admin-password");
    if (!process.env.ADMIN_PASSWORD || provided !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ ok: false, error: "Non autorisé" });
    }
    next();
}
app.use("/api/admin", requireAdmin);

// --- HELPERS DATE ---
function sessionDateTimeOf(date, time) {
    return DateTime.fromFormat(`${date} ${time}`, "yyyy-MM-dd HH:mm", { zone: "Europe/Paris" });
}
function now() {
    return DateTime.now().setZone("Europe/Paris");
}

// Met à plat une réservation (avec sa séance/film joints) au format utilisé par le front.
function flattenReservation(r) {
    const seance = r.seances || {};
    const film = seance.films || {};
    return {
        id: r.id,
        clientName: r.client_name,
        email: r.email,
        peopleNumber: r.people_number,
        status: r.status,
        scanCount: r.scan_count,
        filmTitle: film.title || "",
        roomNumber: seance.room_number || "",
        sessionDate: seance.session_date || "",
        sessionTime: (seance.session_time || "").slice(0, 5),
        seanceId: r.seance_id,
        createdByAdmin: r.created_by_admin
    };
}

const RESA_SELECT = "*, seances(room_number, session_date, session_time, films(title))";

// --- EXPIRATION AUTOMATIQUE ---
async function applyExpirations() {
    const { data, error } = await supabase
        .from("reservations")
        .select("id, status, seances(session_date, session_time)")
        .in("status", ["en attente", "validé"]);

    if (error) {
        console.error("Erreur lecture expirations :", error.message);
        return;
    }

    const nowTime = now();
    const toExpire = [];

    (data || []).forEach(r => {
        const s = r.seances;
        if (!s || !s.session_date || !s.session_time) return;
        const dt = sessionDateTimeOf(s.session_date, (s.session_time || "").slice(0, 5));
        if (dt.isValid && nowTime >= dt.plus({ minutes: 10 })) {
            toExpire.push(r.id);
        }
    });

    if (toExpire.length === 0) return;

    const { error: updateError } = await supabase
        .from("reservations")
        .update({ status: "expiré", expired_at: new Date().toISOString() })
        .in("id", toExpire);

    if (updateError) {
        console.error("Erreur mise à jour expirations :", updateError.message);
    } else {
        console.log(`[${new Date().toISOString()}] ${toExpire.length} réservation(s) expirée(s).`);
    }
}

setInterval(applyExpirations, 60 * 1000);

// --- ROUTES PAGES ---
app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

// ============================================
//  PROGRAMME (public)
// ============================================
app.get("/api/programme", async (req, res) => {
    const today = now().toFormat("yyyy-MM-dd");

    const { data, error } = await supabase
        .from("films")
        .select(`
            id, title, poster_url, synopsis, duration_minutes, genre,
            seances ( id, room_number, session_date, session_time, capacity,
                reservations ( people_number, status ) )
        `)
        .order("title", { ascending: true });

    if (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: "Erreur lors du chargement du programme" });
    }

    const nowTime = now();

    const films = (data || []).map(film => {
        const seances = (film.seances || [])
            .filter(s => {
                const dt = sessionDateTimeOf(s.session_date, (s.session_time || "").slice(0, 5));
                return !dt.isValid || dt >= nowTime;
            })
            .map(s => {
                const taken = (s.reservations || [])
                    .filter(r => r.status === "en attente" || r.status === "validé")
                    .reduce((sum, r) => sum + (r.people_number || 0), 0);
                return {
                    id: s.id,
                    roomNumber: s.room_number,
                    sessionDate: s.session_date,
                    sessionTime: (s.session_time || "").slice(0, 5),
                    capacity: s.capacity,
                    remaining: Math.max(0, s.capacity - taken)
                };
            })
            .sort((a, b) => `${a.sessionDate} ${a.sessionTime}`.localeCompare(`${b.sessionDate} ${b.sessionTime}`));

        return {
            id: film.id,
            title: film.title,
            posterUrl: film.poster_url,
            synopsis: film.synopsis,
            durationMinutes: film.duration_minutes,
            genre: film.genre,
            seances
        };
    }).filter(f => f.seances.length > 0);

    res.json({ ok: true, films });
});
// ============================================
//  HISTORIQUE (public) — séances passées (30 derniers jours)
// ============================================
app.get("/api/historique", async (req, res) => {
    const nowTime = now();
    const limitDate = nowTime.minus({ days: 30 });

    const { data, error } = await supabase
        .from("seances")
        .select(`
            id, room_number, session_date, session_time, capacity,
            films ( title, poster_url, genre ),
            reservations ( people_number, status )
        `);

    if (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: "Erreur lors du chargement de l'historique" });
    }

    const seances = (data || [])
        .map(s => {
            const dt = sessionDateTimeOf(s.session_date, (s.session_time || "").slice(0, 5));
            const occupied = (s.reservations || [])
                .filter(r => r.status !== "refusé")
                .reduce((sum, r) => sum + (r.people_number || 0), 0);
            return {
                id: s.id,
                filmTitle: s.films?.title || "",
                posterUrl: s.films?.poster_url || null,
                genre: s.films?.genre || null,
                roomNumber: s.room_number,
                sessionDate: s.session_date,
                sessionTime: (s.session_time || "").slice(0, 5),
                capacity: s.capacity,
                occupied,
                dt
            };
        })
        .filter(s => s.dt.isValid && s.dt < nowTime && s.dt >= limitDate)
        .sort((a, b) => b.dt.toMillis() - a.dt.toMillis())
        .map(({ dt, ...rest }) => rest);

    res.json({ ok: true, seances });
});

// ============================================
//  RÉSERVATION CLIENT
// ============================================
app.post("/api/reserver", async (req, res) => {
    const { seanceId, clientName, email, peopleNumber } = req.body;

    if (!seanceId || !clientName || !peopleNumber) {
        return res.status(400).send("Champs obligatoires manquants.");
    }
    if (parseInt(peopleNumber) > 10 || parseInt(peopleNumber) < 1) {
        return res.status(400).send("Le nombre de personnes est limité à 10 par réservation.");
    }

    const { data: seance, error: seanceError } = await supabase
        .from("seances")
        .select("id, session_date, session_time, capacity, reservations(people_number, status)")
        .eq("id", seanceId)
        .single();

    if (seanceError || !seance) {
        return res.status(404).send("Séance introuvable.");
    }

    const sessionDateTime = sessionDateTimeOf(seance.session_date, (seance.session_time || "").slice(0, 5));
    if (!sessionDateTime.isValid || sessionDateTime < now()) {
        return res.status(400).send("Cette séance est déjà passée. Impossible d'effectuer cette réservation.");
    }

    const taken = (seance.reservations || [])
        .filter(r => r.status === "en attente" || r.status === "validé")
        .reduce((sum, r) => sum + (r.people_number || 0), 0);
    const remaining = seance.capacity - taken;

    if (parseInt(peopleNumber) > remaining) {
        return res.status(400).send(`Il ne reste que ${remaining} place(s) pour cette séance.`);
    }

    const newResa = {
        id: randomUUID(),
        seance_id: seanceId,
        client_name: clientName,
        email: email || "",
        people_number: parseInt(peopleNumber),
        status: "en attente"
    };

    const { error: insertError } = await supabase.from("reservations").insert(newResa);
    if (insertError) {
        console.error(insertError);
        return res.status(500).send("Erreur lors de l'enregistrement de la réservation.");
    }

    res.send("Réservation enregistrée");
});

// Consulter ses réservations par nom (public, utilisé par check.html)
// Correspondance EXACTE (insensible à la casse) sur le nom du client.
app.get("/api/reservation", async (req, res) => {
    const name = (req.query.name || "").trim().toLowerCase();
    if (!name) {
        return res.json({ ok: false, error: "Nom manquant" });
    }

    const { data, error } = await supabase
        .from("reservations")
        .select(RESA_SELECT)
        .ilike("client_name", name);

    if (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: "Erreur serveur" });
    }

    if (!data || data.length === 0) {
        return res.json({ ok: false, error: "Aucune réservation trouvée" });
    }

    res.json({ ok: true, reservations: data.map(flattenReservation) });
});

// ============================================
//  ADMIN — RÉSERVATIONS  (protégé par requireAdmin)
// ============================================
app.get("/api/admin", async (req, res) => {
    await applyExpirations();

    const { data, error } = await supabase
        .from("reservations")
        .select(RESA_SELECT)
        .order("created_at", { ascending: false });

    if (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: "Erreur serveur" });
    }

    res.json(data.map(flattenReservation));
});

app.post("/api/admin/supprimer", async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).send("ID manquant");

    const { error } = await supabase.from("reservations").delete().eq("id", id);
    if (error) {
        console.error(error);
        return res.status(500).send("Erreur lors de la suppression");
    }
    res.send("Réservation supprimée");
});

// Créer réservation depuis l'admin (ID personnalisé, séance existante)
app.post("/api/admin/creer", async (req, res) => {
    const { id, clientName, email, seanceId, peopleNumber } = req.body;

    if (!id || !clientName || !seanceId || !peopleNumber) {
        return res.status(400).send("Champs obligatoires manquants (id, clientName, seanceId, peopleNumber).");
    }
    if (String(id).trim() === "") {
        return res.status(400).send("L'ID ne peut pas être vide.");
    }
    if (parseInt(peopleNumber) > 10) {
        return res.status(400).send("Le nombre de personnes est limité à 10 par réservation.");
    }

    const { data: exists } = await supabase
        .from("reservations")
        .select("id")
        .eq("id", String(id).trim())
        .maybeSingle();

    if (exists) {
        return res.status(409).send("Un ID identique existe déjà. Choisissez un autre ID.");
    }

    const { error } = await supabase.from("reservations").insert({
        id: String(id).trim(),
        seance_id: seanceId,
        client_name: clientName,
        email: email || "",
        people_number: parseInt(peopleNumber),
        status: "en attente",
        created_by_admin: true
    });

    if (error) {
        console.error(error);
        return res.status(500).send("Erreur lors de la création.");
    }

    res.json({ ok: true, message: "Réservation créée avec succès." });
});

// Valider + générer le PDF du ticket
// Valider une réservation (statut uniquement, sans génération de PDF)
app.post("/api/admin/valider", async (req, res) => {
    try {
        const { id } = req.body;

        const { data: resa, error } = await supabase
            .from("reservations")
            .select(RESA_SELECT)
            .eq("id", id)
            .single();

        if (error || !resa) return res.status(404).send("Réservation introuvable");

        const seance = resa.seances || {};
        const sessionTimeShort = (seance.session_time || "").slice(0, 5);

        if (seance.session_date && sessionTimeShort) {
            const sessionDateTime = sessionDateTimeOf(seance.session_date, sessionTimeShort);
            if (sessionDateTime.isValid && now() >= sessionDateTime.plus({ minutes: 10 })) {
                await supabase.from("reservations")
                    .update({ status: "expiré", expired_at: new Date().toISOString() })
                    .eq("id", id);
                return res.status(400).send("La séance est expirée. Validation impossible.");
            }
        }

        const { error: updateError } = await supabase.from("reservations")
            .update({ status: "validé", validated_at: new Date().toISOString() })
            .eq("id", id);

        if (updateError) throw updateError;

        res.json({ ok: true, message: "Réservation validée." });

    } catch (err) {
        console.error(err);
        res.status(500).send("Erreur lors de la validation");
    }
});

// Générer / régénérer le PDF du ticket (réservation déjà validée)
app.post("/api/admin/ticket", async (req, res) => {
    try {
        const { id } = req.body;

        const { data: resa, error } = await supabase
            .from("reservations")
            .select(RESA_SELECT)
            .eq("id", id)
            .single();

        if (error || !resa) return res.status(404).send("Réservation introuvable");
        if (resa.status !== "validé") return res.status(400).send("Cette réservation n'est pas validée.");

        const seance = resa.seances || {};
        const film = seance.films || {};
        const sessionTimeShort = (seance.session_time || "").slice(0, 5);

        const BASE_URL = process.env.BASE_URL || "https://reservation-cinepop.onrender.com";
        const qrData = `${BASE_URL}/verify?id=${resa.id}`;

        const qrBuffer = await QRCode.toBuffer(qrData);
        const qrBase64 = qrBuffer.toString("base64");

        const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
        width: 300px;
        height: 500px;
        overflow: hidden;
        font-family: Arial, sans-serif;
    }
    .ticket {
        width: 280px;
        height: 490px;
        border: 2px dashed black;
        padding: 12px 16px;
        text-align: center;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        align-items: center;
    }
    h2 { font-size: 14px; }
    hr { width: 100%; border: none; border-top: 1px solid #ccc; }
    h1 { font-size: 15px; word-break: break-word; }
    p { font-size: 12px; line-height: 1.4; }
    .ticket-id { font-size: 9px; color: #555; }
</style>
</head>
<body>
    <div class="ticket">
        <h2>TICKET CINEPOP</h2>
        <hr>
        <h1>${escapeHtml(film.title)}</h1>
        <p><b>Salle :</b> ${escapeHtml(seance.room_number)}</p>
        <p><b>Date :</b> ${escapeHtml(seance.session_date)}</p>
        <p><b>Heure :</b> ${escapeHtml(sessionTimeShort)}</p>
        <p><b>Client :</b> ${escapeHtml(resa.client_name)}</p>
        <p><b>Places :</b> ${escapeHtml(resa.people_number)}</p>
        <img src="data:image/png;base64,${qrBase64}" style="width:100px;" />
        <p class="ticket-id">Ticket #${resa.id}</p>
    </div>
</body>
</html>
`;

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

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="ticket-Cinepop-${resa.client_name}.pdf"`);
        res.send(buffer);

    } catch (err) {
        console.error(err);
        res.status(500).send("Erreur lors de la génération du ticket");
    }
});

app.post("/api/admin/refuser", async (req, res) => {
    try {
        const { id } = req.body;
        const { error } = await supabase.from("reservations")
            .update({ status: "refusé", refused_at: new Date().toISOString() })
            .eq("id", id);

        if (error) throw error;
        res.send("Réservation refusée");
    } catch (err) {
        console.error(err);
        res.status(500).send("Erreur lors du refus");
    }
});

// ============================================
//  ADMIN — FILMS
// ============================================
app.get("/api/admin/films", async (req, res) => {
    const { data, error } = await supabase.from("films").select("*").order("title", { ascending: true });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, films: data });
});

app.post("/api/admin/films/creer", async (req, res) => {
    const { title, posterUrl, synopsis, durationMinutes, genre } = req.body;
    if (!title) return res.status(400).send("Le titre est obligatoire.");

    const { error } = await supabase.from("films").insert({
        title,
        poster_url: posterUrl || null,
        synopsis: synopsis || null,
        duration_minutes: durationMinutes ? parseInt(durationMinutes) : null,
        genre: genre || null
    });
    if (error) return res.status(500).send(error.message);
    res.json({ ok: true });
});

app.post("/api/admin/films/modifier", async (req, res) => {
    const { id, title, posterUrl, synopsis, durationMinutes, genre } = req.body;
    if (!id || !title) return res.status(400).send("ID et titre obligatoires.");

    const { error } = await supabase.from("films").update({
        title,
        poster_url: posterUrl || null,
        synopsis: synopsis || null,
        duration_minutes: durationMinutes ? parseInt(durationMinutes) : null,
        genre: genre || null
    }).eq("id", id);
    if (error) return res.status(500).send(error.message);
    res.json({ ok: true });
});

app.post("/api/admin/films/supprimer", async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).send("ID manquant");
    const { error } = await supabase.from("films").delete().eq("id", id);
    if (error) return res.status(500).send(error.message);
    res.send("Film supprimé");
});

// ============================================
//  ADMIN — SÉANCES
// ============================================
app.get("/api/admin/seances", async (req, res) => {
    const { data, error } = await supabase
        .from("seances")
        .select("*, films(title)")
        .order("session_date", { ascending: true })
        .order("session_time", { ascending: true });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, seances: data });
});

app.post("/api/admin/seances/creer", async (req, res) => {
    const { filmId, roomNumber, sessionDate, sessionTime, capacity } = req.body;
    if (!filmId || !sessionDate || !sessionTime) {
        return res.status(400).send("Film, date et heure sont obligatoires.");
    }
    const { error } = await supabase.from("seances").insert({
        film_id: filmId,
        room_number: roomNumber || null,
        session_date: sessionDate,
        session_time: sessionTime,
        capacity: capacity ? parseInt(capacity) : 50
    });
    if (error) return res.status(500).send(error.message);
    res.json({ ok: true });
});

app.post("/api/admin/seances/modifier", async (req, res) => {
    const { id, filmId, roomNumber, sessionDate, sessionTime, capacity } = req.body;
    if (!id || !filmId || !sessionDate || !sessionTime) {
        return res.status(400).send("Champs obligatoires manquants.");
    }
    const { error } = await supabase.from("seances").update({
        film_id: filmId,
        room_number: roomNumber || null,
        session_date: sessionDate,
        session_time: sessionTime,
        capacity: capacity ? parseInt(capacity) : 50
    }).eq("id", id);
    if (error) return res.status(500).send(error.message);
    res.json({ ok: true });
});

app.post("/api/admin/seances/supprimer", async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).send("ID manquant");
    const { error } = await supabase.from("seances").delete().eq("id", id);
    if (error) return res.status(500).send(error.message);
    res.send("Séance supprimée");
});

// ============================================
//  VÉRIFICATION QR CODE
// ============================================
app.get("/verify", async (req, res) => {
    const id = req.query.id;
    const check = req.query.check;

    const { data: resa } = await supabase
        .from("reservations")
        .select(RESA_SELECT)
        .eq("id", id)
        .single();

    if (check == "1") {
        if (!resa) return res.json({ status: "invalid", reason: "Identifiant inexistant" });
        if (resa.status == "refusé") return res.json({ status: "invalid", reason: "réservation refusée" });
        if (resa.status == "expiré") return res.json({ status: "invalid", reason: "réservation expirée" });
        if (resa.status == "en attente") return res.json({ status: "invalid", reason: "réservation en attente" });

        const seance = resa.seances || {};
        const film = seance.films || {};
        const sessionTimeShort = (seance.session_time || "").slice(0, 5);

        const nowDate = now().toJSDate();
        const sessionDateTime = sessionDateTimeOf(seance.session_date, sessionTimeShort).toJSDate();

        const startWindow = new Date(sessionDateTime);
        startWindow.setMinutes(startWindow.getMinutes() - 30);
        const endWindow = new Date(sessionDateTime);
        endWindow.setMinutes(endWindow.getMinutes() + 10);

        if (nowDate < startWindow || nowDate > endWindow) {
            return res.json({ status: "invalid", reason: "Hors délai" });
        }

        const newScanCount = (resa.scan_count || 0) + 1;
        await supabase.from("reservations").update({ scan_count: newScanCount }).eq("id", id);

        return res.json({
            status: "valid",
            scanCount: newScanCount,
            client: resa.client_name,
            film: film.title,
            salle: seance.room_number,
            date: seance.session_date,
            heure: sessionTimeShort,
            places: resa.people_number
        });
    }

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
    const alreadyScanned = data.scanCount > 1
    ? '<div style="background:#3498db;color:#000;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:15px;font-weight:bold;">❗ Ce ticket a déjà été scanné ' + (data.scanCount - 1) + ' fois</div>'
    : "";

    box.innerHTML =
        '<div class="card">' +
        alreadyScanned +
        '<img src="/img/check.png" class="icon"><h1 style="color:#2ecc71;">Ticket VALIDE</h1>' +
        '<p><b>Client :</b> ' + data.client + '</p>' +
        '<p><b>Film :</b> ' + data.film + '</p>' +
        '<p><b>Salle :</b> ' + data.salle + '</p>' +
        '<p><b>Date :</b> ' + data.date + '</p>' +
        '<p><b>Heure :</b> ' + data.heure + '</p>' +
        '<p><b>Places :</b> ' + data.places + '</p></div>';

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
