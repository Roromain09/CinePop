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

function escapeHtml(str) {
    return String(str ?? "")
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

function requireAdmin(req, res, next) {
    const provided = req.get("x-admin-password");
    if (!process.env.ADMIN_PASSWORD || provided !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ ok: false, error: "Non autorisé" });
    }
    next();
}
app.use("/api/admin", requireAdmin);

function sessionDateTimeOf(date, time) {
    return DateTime.fromFormat(`${date} ${time}`, "yyyy-MM-dd HH:mm", { zone: "Europe/Paris" });
}
function now() {
    return DateTime.now().setZone("Europe/Paris");
}

function flattenReservation(r, commande) {
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
        createdByAdmin: r.created_by_admin,
        commande: commande || null
    };
}

const RESA_SELECT = "*, seances(room_number, session_date, session_time, films(title, poster_url))";

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

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

// ============================================
//  PROGRAMME (public)
// ============================================
app.get("/api/programme", async (req, res) => {
    const { data, error } = await supabase
        .from("films")
        .select(`
            id, title, poster_url, synopsis, duration_minutes, genre,
            seances ( id, room_number, session_date, session_time, capacity, cancelled, info_message, price,
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
                    remaining: Math.max(0, s.capacity - taken),
                    cancelled: s.cancelled || false,
                    infoMessage: s.info_message || null,
                    price: s.price ?? null
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
//  HISTORIQUE (public)
// ============================================
app.get("/api/historique", async (req, res) => {
    const nowTime = now();

    const { data, error } = await supabase
        .from("seances")
        .select(`
            id, room_number, session_date, session_time, capacity, cancelled,
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
                cancelled: s.cancelled || false,
                dt
            };
        })
        .filter(s => s.dt.isValid && s.dt < nowTime && !s.cancelled)
        .sort((a, b) => b.dt.toMillis() - a.dt.toMillis())
        .map(({ dt, cancelled, ...rest }) => rest);

    res.json({ ok: true, seances });
});

// ============================================
//  RÉSERVATION CLIENT
// ============================================
app.post("/api/reserver", async (req, res) => {
    const { seanceId, clientName, email, peopleNumber, userId, panier } = req.body;

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

    const resaId = randomUUID();

    const newResa = {
        id: resaId,
        seance_id: seanceId,
        client_name: clientName,
        email: email || "",
        people_number: parseInt(peopleNumber),
        status: "en attente",
        user_id: userId || null
    };

    const { error: insertError } = await supabase.from("reservations").insert(newResa);
    if (insertError) {
        console.error(insertError);
        return res.status(500).send("Erreur lors de l'enregistrement de la réservation.");
    }

    if (panier && Array.isArray(panier) && panier.length > 0) {
        const produitIds = panier.map(i => i.id);
        const { data: produits, error: prodErr } = await supabase
            .from("boutique_produits")
            .select("id, nom, prix, stock, actif")
            .in("id", produitIds);

        if (!prodErr && produits) {
            const itemsValides = [];
            let total = 0;
            let stockOk = true;

            for (const ligne of panier) {
                const prod = produits.find(p => p.id === ligne.id);
                if (!prod || !prod.actif) continue;
                if (prod.stock < ligne.qte) { stockOk = false; break; }
                itemsValides.push({ id: prod.id, nom: prod.nom, prix: prod.prix, qte: ligne.qte });
                total += prod.prix * ligne.qte;
            }

            if (stockOk && itemsValides.length > 0) {
                const { error: cmdErr } = await supabase.from("boutique_commandes").insert({
                    reservation_id: resaId,
                    user_id: userId || null,
                    items: itemsValides,
                    total: Math.round(total * 100) / 100,
                    statut: "en attente"
                });

                if (!cmdErr) {
                    for (const ligne of itemsValides) {
                        const prod = produits.find(p => p.id === ligne.id);
                        await supabase
                            .from("boutique_produits")
                            .update({ stock: prod.stock - ligne.qte })
                            .eq("id", ligne.id);
                    }
                } else {
                    console.error("Erreur insertion commande boutique :", cmdErr.message);
                }
            }
        }
    }

    res.send("Réservation enregistrée");
});

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

    res.json({ ok: true, reservations: data.map(r => flattenReservation(r, null)) });
});

app.post("/api/support", async (req, res) => {
    const { email, subject, message } = req.body;
    if (!email || !subject || !message) {
        return res.status(400).send("Champs obligatoires manquants.");
    }
    const { error } = await supabase.from("support_messages").insert({
        email, subject, message
    });
    if (error) {
        console.error(error);
        return res.status(500).send("Erreur lors de l'envoi du message.");
    }
    res.send("Message envoyé");
});

// ============================================
//  BOUTIQUE (public)
// ============================================
app.get("/api/boutique/produits", async (req, res) => {
    const { data, error } = await supabase
        .from("boutique_produits")
        .select("id, nom, description, prix, stock, image_url")
        .eq("actif", true)
        .gt("stock", 0)
        .order("nom", { ascending: true });

    if (error) {
        console.error(error);
        return res.status(500).json({ ok: false, error: error.message });
    }
    res.json({ ok: true, produits: data || [] });
});

// ============================================
//  ADMIN — RÉSERVATIONS
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

    const resaIds = data.map(r => r.id);
    let commandesMap = {};
    if (resaIds.length > 0) {
        const { data: commandes } = await supabase
            .from("boutique_commandes")
            .select("reservation_id, items, total, statut")
            .in("reservation_id", resaIds);
        (commandes || []).forEach(c => {
            commandesMap[c.reservation_id] = { items: c.items, total: c.total, statut: c.statut };
        });
    }

    res.json(data.map(r => flattenReservation(r, commandesMap[r.id] || null)));
});

app.post("/api/admin/supprimer", async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).send("ID manquant");
    // Supprimer la commande boutique associée si elle existe
    await supabase.from("boutique_commandes").delete().eq("reservation_id", id);
    const { error } = await supabase.from("reservations").delete().eq("id", id);
    if (error) {
        console.error(error);
        return res.status(500).send("Erreur lors de la suppression");
    }
    res.send("Réservation supprimée");
});

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

        // Passer la commande boutique associée à "prête"
        await supabase.from("boutique_commandes")
            .update({ statut: "prête" })
            .eq("reservation_id", id)
            .eq("statut", "en attente");

        res.json({ ok: true, message: "Réservation validée." });

    } catch (err) {
        console.error(err);
        res.status(500).send("Erreur lors de la validation");
    }
});

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

        // Charger la commande boutique si elle existe
        const { data: commande } = await supabase
            .from("boutique_commandes")
            .select("items, total, statut")
            .eq("reservation_id", id)
            .maybeSingle();

        const BASE_URL = process.env.BASE_URL || "https://reservation-cinepop.onrender.com";
        const qrData = `${BASE_URL}/verify?id=${resa.id}`;

        const qrBuffer = await QRCode.toBuffer(qrData);
        const qrBase64 = qrBuffer.toString("base64");

        let levelColor = "#000000";
        let levelBg    = "#f9f9f9";
        let levelLabel = "";

        if (resa.user_id) {
            const { data: profil } = await supabase
                .from("profiles")
                .select("level")
                .eq("user_id", resa.user_id)
                .maybeSingle();

            const level = profil?.level || "bronze";
            const LEVELS = {
                bronze: { color: "#cd7f32", bg: "#fdf5ee", label: "Niveau Bronze" },
                argent: { color: "#a8b8cc", bg: "#f2f5f8", label: "Niveau Argent" },
                or:     { color: "#f5b700", bg: "#fffbe6", label: "Niveau Or"     },
            };
            const lv = LEVELS[level] || LEVELS.bronze;
            levelColor = lv.color;
            levelBg    = lv.bg;
            levelLabel = lv.label;
        }

        // Page 2 : bon de commande style bonbon
        let page2Html = "";
        if (commande && commande.items && commande.items.length > 0) {
            const itemsHtml = commande.items.map(it => `
                <div class="bon-item">
                    <span class="bon-item-nom">${escapeHtml(it.nom)}</span>
                    <span class="bon-item-qte">x${it.qte}</span>
                    <span class="bon-item-prix">${(it.prix * it.qte).toFixed(2)} €</span>
                </div>`).join("");

            page2Html = `
<div class="page-break"></div>
<div class="bon">
    <div class="bon-header">
        <div class="bon-icon">🍿</div>
        <div class="bon-title">Bon de commande</div>
        <div class="bon-sub">A remettre en caisse a ton arrivee</div>
    </div>
    <div class="bon-client">
        <span class="bon-client-label">Pour</span>
        <span class="bon-client-name">${escapeHtml(resa.client_name)}</span>
    </div>
    <div class="bon-film">
        <span>${escapeHtml(film.title)} - ${escapeHtml(sessionTimeShort)}</span>
    </div>
    <div class="bon-items">
        <div class="bon-items-header">Ta commande</div>
        ${itemsHtml}
    </div>
    <div class="bon-total">
        <span>Total</span>
        <span class="bon-total-val">${parseFloat(commande.total).toFixed(2)} EUR</span>
    </div>
    <div class="bon-footer">Merci et bonne seance !</div>
    <div class="bon-id">Ref : ${resa.id}</div>
</div>`;
        }

        const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 300px; font-family: Arial, sans-serif; }

    /* PAGE 1 : TICKET */
    .ticket {
        width: 280px; height: 490px;
        border: 2px solid ${levelColor};
        border-radius: 10px;
        background: ${levelBg};
        margin: 0 auto;
        display: flex; flex-direction: column; align-items: center;
        overflow: hidden;
    }
    .ticket-header {
        width: 100%; background: ${levelColor};
        padding: 12px 16px; text-align: center;
    }
    .ticket-header h2 { font-size: 14px; color: #fff; letter-spacing: 1px; }
    .ticket-header .level { font-size: 11px; color: rgba(255,255,255,0.85); margin-top: 3px; }
    .ticket-body {
        flex: 1; width: 100%; padding: 14px 16px;
        display: flex; flex-direction: column; align-items: center;
        justify-content: space-between; gap: 4px;
    }
    h1 { font-size: 15px; word-break: break-word; text-align: center; color: #111; }
    .divider { width: 100%; border: none; border-top: 1px dashed ${levelColor}; opacity: 0.5; }
    p { font-size: 12px; line-height: 1.5; color: #333; text-align: center; }
    p b { color: #111; }
    .ticket-id { font-size: 9px; color: #888; }

    /* SAUT DE PAGE */
    .page-break { page-break-after: always; }

    /* PAGE 2 : BON DE COMMANDE BONBON */
    .bon {
        width: 280px;
        margin: 0 auto;
        background: #fff9fe;
        border: 2px dashed #ff6eb4;
        border-radius: 14px;
        overflow: hidden;
    }
    .bon-header {
        background: linear-gradient(135deg, #ff6eb4, #ffa94d);
        padding: 18px 16px 14px;
        text-align: center;
    }
    .bon-icon { font-size: 26px; margin-bottom: 4px; }
    .bon-title { font-size: 16px; font-weight: 900; color: #fff; letter-spacing: 0.5px; }
    .bon-sub { font-size: 10px; color: rgba(255,255,255,0.88); margin-top: 3px; }
    .bon-client {
        display: flex; align-items: center; gap: 6px;
        padding: 10px 16px 0;
    }
    .bon-client-label {
        font-size: 10px; font-weight: 700; color: #ff6eb4;
        text-transform: uppercase; letter-spacing: 0.5px;
    }
    .bon-client-name { font-size: 13px; font-weight: 900; color: #2d1a2e; }
    .bon-film {
        padding: 4px 16px 10px;
        font-size: 11px; color: #7a4a7a;
        border-bottom: 1.5px dashed #ffc0e0;
    }
    .bon-items { padding: 12px 16px; }
    .bon-items-header {
        font-size: 10px; font-weight: 700; color: #ff6eb4;
        text-transform: uppercase; letter-spacing: 0.5px;
        margin-bottom: 8px;
    }
    .bon-item {
        display: flex; align-items: center;
        padding: 6px 0;
        border-bottom: 1px dotted #ffc0e0;
    }
    .bon-item:last-child { border-bottom: none; }
    .bon-item-nom { flex: 1; font-size: 12px; font-weight: 700; color: #2d1a2e; }
    .bon-item-qte {
        font-size: 11px; font-weight: 900; color: #ff6eb4;
        background: #ffe0f2; border-radius: 999px;
        padding: 1px 7px; margin-right: 8px;
    }
    .bon-item-prix { font-size: 11px; font-weight: 700; color: #7a4a7a; }
    .bon-total {
        display: flex; justify-content: space-between; align-items: center;
        background: linear-gradient(135deg, #ffe0f2, #fff0e0);
        margin: 0 16px 12px; border-radius: 8px;
        padding: 8px 12px;
        border: 1.5px solid #ffb0d8;
    }
    .bon-total span:first-child {
        font-size: 11px; font-weight: 700; color: #7a4a7a;
        text-transform: uppercase; letter-spacing: 0.5px;
    }
    .bon-total-val { font-size: 16px; font-weight: 900; color: #ff6eb4; }
    .bon-footer {
        text-align: center; font-size: 11px; color: #ff6eb4;
        font-weight: 700; padding: 0 16px 8px;
    }
    .bon-id {
        text-align: center; font-size: 8px; color: #cca0cc;
        padding-bottom: 10px; font-family: monospace;
    }
</style>
</head>
<body>
    <div class="ticket">
        <div class="ticket-header">
            <h2>TICKET CINEPOP</h2>
            ${levelLabel ? `<div class="level">${levelLabel}</div>` : ""}
        </div>
        <div class="ticket-body">
            <h1>${escapeHtml(film.title)}</h1>
            <hr class="divider">
            <p><b>Salle :</b> ${escapeHtml(seance.room_number)}</p>
            <p><b>Date :</b> ${escapeHtml(seance.session_date)}</p>
            <p><b>Heure :</b> ${escapeHtml(sessionTimeShort)}</p>
            <p><b>Client :</b> ${escapeHtml(resa.client_name)}</p>
            <p><b>Places :</b> ${escapeHtml(resa.people_number)}</p>
            <img src="data:image/png;base64,${qrBase64}" style="width:90px;" />
            <p class="ticket-id">Ticket #${resa.id}</p>
        </div>
    </div>
    ${page2Html}
</body>
</html>`;

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
        .select("*, films(title), cancelled, info_message, price")
        .order("session_date", { ascending: true })
        .order("session_time", { ascending: true });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, seances: data });
});

app.post("/api/admin/seances/creer", async (req, res) => {
    const { filmId, roomNumber, sessionDate, sessionTime, capacity, infoMessage, price } = req.body;
    if (!filmId || !sessionDate || !sessionTime) {
        return res.status(400).send("Film, date et heure sont obligatoires.");
    }
    const { error } = await supabase.from("seances").insert({
        film_id: filmId,
        room_number: roomNumber || null,
        session_date: sessionDate,
        session_time: sessionTime,
        capacity: capacity ? parseInt(capacity) : 50,
        info_message: infoMessage || null,
        price: price ? parseFloat(price) : null
    });
    if (error) return res.status(500).send(error.message);
    res.json({ ok: true });
});

app.post("/api/admin/seances/modifier", async (req, res) => {
    const { id, filmId, roomNumber, sessionDate, sessionTime, capacity, infoMessage, price } = req.body;
    if (!id || !filmId || !sessionDate || !sessionTime) {
        return res.status(400).send("Champs obligatoires manquants.");
    }
    const { error } = await supabase.from("seances").update({
        film_id: filmId,
        room_number: roomNumber || null,
        session_date: sessionDate,
        session_time: sessionTime,
        capacity: capacity ? parseInt(capacity) : 50,
        info_message: infoMessage || null,
        price: price ? parseFloat(price) : null
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

app.post("/api/admin/seances/annuler", async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).send("ID manquant");
    const { error } = await supabase.from("seances")
        .update({ cancelled: true })
        .eq("id", id);
    if (error) return res.status(500).send(error.message);
    const { error: rezaError } = await supabase.from("reservations")
        .update({ status: "refusé", refused_at: new Date().toISOString() })
        .eq("seance_id", id)
        .in("status", ["en attente", "validé"]);
    if (rezaError) return res.status(500).send(rezaError.message);
    res.json({ ok: true });
});

app.post("/api/admin/seances/restaurer", async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).send("ID manquant");
    const { error } = await supabase.from("seances")
        .update({ cancelled: false })
        .eq("id", id);
    if (error) return res.status(500).send(error.message);
    res.json({ ok: true });
});

// ============================================
//  ADMIN — SUPPORT
// ============================================
app.get("/api/admin/support", async (req, res) => {
    const { data, error } = await supabase
        .from("support_messages")
        .select("*")
        .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, messages: data });
});

app.post("/api/admin/support/traiter", async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).send("ID manquant");
    const { error } = await supabase.from("support_messages")
        .update({ status: "traité" })
        .eq("id", id);
    if (error) return res.status(500).send(error.message);
    res.send("Message marqué comme traité");
});

app.post("/api/admin/support/supprimer", async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).send("ID manquant");
    const { error } = await supabase.from("support_messages").delete().eq("id", id);
    if (error) return res.status(500).send(error.message);
    res.send("Message supprimé");
});

// ============================================
//  ADMIN — BOUTIQUE PRODUITS
// ============================================
app.get("/api/admin/boutique/produits", async (req, res) => {
    const { data, error } = await supabase
        .from("boutique_produits")
        .select("*")
        .order("nom", { ascending: true });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, produits: data || [] });
});

app.post("/api/admin/boutique/produits/creer", async (req, res) => {
    const { nom, description, prix, stock, image_url } = req.body;
    if (!nom || prix == null) return res.status(400).send("Nom et prix obligatoires.");
    const { error } = await supabase.from("boutique_produits").insert({
        nom, description: description || null,
        prix: parseFloat(prix), stock: parseInt(stock) || 0,
        image_url: image_url || null, actif: true
    });
    if (error) return res.status(500).send(error.message);
    res.json({ ok: true });
});

app.post("/api/admin/boutique/produits/modifier", async (req, res) => {
    const { id, nom, description, prix, stock, image_url, actif } = req.body;
    if (!id || !nom || prix == null) return res.status(400).send("ID, nom et prix obligatoires.");
    const { error } = await supabase.from("boutique_produits").update({
        nom, description: description || null,
        prix: parseFloat(prix), stock: parseInt(stock) || 0,
        image_url: image_url || null,
        actif: actif !== false
    }).eq("id", id);
    if (error) return res.status(500).send(error.message);
    res.json({ ok: true });
});

app.post("/api/admin/boutique/produits/supprimer", async (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).send("ID manquant");
    const { error } = await supabase.from("boutique_produits").delete().eq("id", id);
    if (error) return res.status(500).send(error.message);
    res.send("Produit supprimé");
});

app.post("/api/admin/boutique/produits/toggle", async (req, res) => {
    const { id, actif } = req.body;
    if (!id) return res.status(400).send("ID manquant");
    const { error } = await supabase.from("boutique_produits").update({ actif }).eq("id", id);
    if (error) return res.status(500).send(error.message);
    res.json({ ok: true });
});

app.post("/api/admin/boutique/produits/stock", async (req, res) => {
    const { id, delta } = req.body;
    if (!id || delta == null) return res.status(400).send("ID et delta obligatoires.");
    const { data: prod, error: fetchErr } = await supabase
        .from("boutique_produits")
        .select("stock")
        .eq("id", id)
        .single();
    if (fetchErr || !prod) return res.status(404).send("Produit introuvable.");
    const newStock = Math.max(0, (prod.stock || 0) + parseInt(delta));
    const { error } = await supabase.from("boutique_produits").update({ stock: newStock }).eq("id", id);
    if (error) return res.status(500).send(error.message);
    res.json({ ok: true, stock: newStock });
});

// ============================================
//  ADMIN — BOUTIQUE COMMANDES
// ============================================
app.get("/api/admin/boutique/commandes", async (req, res) => {
    const { data, error } = await supabase
        .from("boutique_commandes")
        .select("*")
        .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, commandes: data || [] });
});

// Marquer une commande comme remise (depuis /verify, sans auth admin)
app.post("/api/boutique/commandes/remettre", async (req, res) => {
    const { reservationId } = req.body;
    if (!reservationId) return res.status(400).send("reservationId manquant");
    const { error } = await supabase.from("boutique_commandes")
        .update({ statut: "remise" })
        .eq("reservation_id", reservationId);
    if (error) return res.status(500).send(error.message);
    res.json({ ok: true });
});

// ============================================
//  INFOS PRATIQUES
// ============================================
app.get("/api/info", async (req, res) => {
    const { data, error } = await supabase
        .from("infos_pratiques")
        .select("content")
        .eq("id", 1)
        .maybeSingle();
    if (error) return res.status(500).json({ ok: false });
    res.json({ ok: true, content: data?.content || "" });
});

app.post("/api/admin/info", async (req, res) => {
    const { content } = req.body;
    const { error } = await supabase
        .from("infos_pratiques")
        .upsert({ id: 1, content: content || "" }, { onConflict: "id" });
    if (error) return res.status(500).send(error.message);
    res.json({ ok: true });
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

        if (newScanCount === 1 && resa.user_id && !resa.points_credited) {
            const pts = (resa.people_number || 1) * 10;
            const filmTitle = resa.seances?.films?.title || null;

            const { data: profil } = await supabase
                .from("profiles")
                .select("points, total_seances, total_personnes, total_films_vus, films_vus_list")
                .eq("user_id", resa.user_id)
                .maybeSingle();

            if (profil) {
                const filmsVus = profil.films_vus_list || [];
                const dejaVu = filmTitle && filmsVus.includes(filmTitle);
                const newFilmsList = (filmTitle && !dejaVu) ? [...filmsVus, filmTitle] : filmsVus;
                const newFilmsVus = dejaVu ? (profil.total_films_vus || 0) : (profil.total_films_vus || 0) + 1;
                const newLevel = newFilmsVus >= 50 ? "or" : newFilmsVus >= 20 ? "argent" : "bronze";

                await supabase.from("profiles").update({
                    points:          (profil.points || 0) + pts,
                    level:           newLevel,
                    total_seances:   (profil.total_seances || 0) + 1,
                    total_personnes: (profil.total_personnes || 0) + (resa.people_number || 1),
                    total_films_vus: newFilmsVus,
                    films_vus_list:  newFilmsList
                }).eq("user_id", resa.user_id);

                await supabase.from("reservations")
                    .update({ points_credited: true, pts_gagnes: pts })
                    .eq("id", id);

                console.log(`[Fidélité scan] +${pts} pts → user ${resa.user_id}`);
            }
        }

        // Charger la commande boutique liée
        const { data: commande } = await supabase
            .from("boutique_commandes")
            .select("items, total, statut")
            .eq("reservation_id", id)
            .maybeSingle();

        return res.json({
            status: "valid",
            scanCount: newScanCount,
            client: resa.client_name,
            film: film.title,
            salle: seance.room_number,
            date: seance.session_date,
            heure: sessionTimeShort,
            places: resa.people_number,
            commande: commande ? { items: commande.items, total: commande.total, statut: commande.statut } : null
        });
    }

    // Page HTML de vérification
    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Vérification Ticket</title>
<style>
    * { box-sizing: border-box; }
    body {
        background: #fff; font-family: Arial, sans-serif; margin: 0;
        min-height: 100vh; display: flex; justify-content: center;
        align-items: center; padding: 16px; text-align: center;
    }
    #checkBtn {
        width: min(90vw, 360px); padding: 18px 24px; font-size: 20px;
        border-radius: 12px; border: none; background: #3498db;
        color: white; cursor: pointer; touch-action: manipulation;
    }
    #result { margin-top: 20px; display: none; }
    .card {
        width: min(92vw, 420px); padding: 28px 20px; border-radius: 16px;
        border: 2px solid #e0e0e0; box-shadow: 0 10px 25px rgba(0,0,0,0.08);
        margin: 0 auto; background: white;
    }
    .icon { width: 96px; height: auto; margin-bottom: 16px; }
    h1 { font-size: 28px; margin: 10px 0; }
    p { font-size: 17px; margin: 6px 0; line-height: 1.4; word-break: break-word; }
    .commande-box {
        margin-top: 18px; border-radius: 12px; overflow: hidden;
        border: 2px dashed #ff6eb4; background: #fff9fe; text-align: left;
    }
    .commande-box-header {
        background: linear-gradient(135deg, #ff6eb4, #ffa94d);
        padding: 10px 14px;
    }
    .commande-box-header span { font-size: 14px; font-weight: 900; color: #fff; }
    .commande-box-body { padding: 12px 14px; }
    .commande-item-line {
        display: flex; justify-content: space-between;
        font-size: 14px; padding: 5px 0;
        border-bottom: 1px dotted #ffc0e0; color: #2d1a2e;
    }
    .commande-item-line:last-child { border-bottom: none; }
    .commande-item-line b { color: #ff6eb4; }
    .commande-total-line {
        display: flex; justify-content: space-between; align-items: center;
        margin-top: 10px; padding: 8px 12px;
        background: linear-gradient(135deg, #ffe0f2, #fff0e0);
        border-radius: 8px; border: 1.5px solid #ffb0d8;
    }
    .commande-total-line span:first-child { font-size: 12px; font-weight: 700; color: #7a4a7a; text-transform: uppercase; }
    .commande-total-line span:last-child { font-size: 16px; font-weight: 900; color: #ff6eb4; }
    #btnRemettre {
        width: 100%; margin-top: 12px; padding: 14px;
        border-radius: 10px; border: none;
        background: linear-gradient(135deg, #ff6eb4, #ffa94d);
        color: white; font-size: 15px; font-weight: 900;
        cursor: pointer; touch-action: manipulation;
        box-shadow: 0 6px 18px rgba(255,110,180,0.35);
    }
    #btnRemettre:disabled { opacity: 0.55; cursor: not-allowed; }
    .commande-remise-badge {
        margin-top: 12px; padding: 10px 14px; border-radius: 10px;
        background: #e8f8f0; border: 1.5px solid #2ecc71;
        color: #1a7a45; font-size: 14px; font-weight: 700; text-align: center;
    }
    .loader { width: 80px; height: 80px; margin: 0 auto 15px; border-radius: 50%; position: relative; }
    .loader::before {
        content: ""; position: absolute; inset: 0; border-radius: 50%;
        border: 4px solid transparent; border-top: 4px solid #00d4ff;
        border-right: 4px solid #00d4ff; animation: spin 1s linear infinite;
    }
    .loader::after {
        content: ""; position: absolute; inset: 12px; border-radius: 50%;
        background: radial-gradient(circle, #00d4ff33, transparent);
        animation: pulse 1.5s ease-in-out infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 0.6; } 50% { transform: scale(1.2); opacity: 1; } }
</style>
</head>
<body>
<div>
    <button id="checkBtn">CHECK TICKET</button>
    <div id="result"></div>
</div>
<script>
const RESA_ID = "${id}";

function buildCommandeHtml(commande) {
    if (!commande || !commande.items || !commande.items.length) return "";
    const dejaRemise = commande.statut === "remise";
    const itemsHtml = commande.items.map(it =>
        '<div class="commande-item-line"><span>' + it.nom + ' x' + it.qte + '</span><b>' + (it.prix * it.qte).toFixed(2) + ' \u20ac</b></div>'
    ).join("");
    const actionHtml = dejaRemise
        ? '<div class="commande-remise-badge">\u2705 Commande d\u00e9j\u00e0 transmise</div>'
        : '<button id="btnRemettre" onclick="remettre()">\ud83c\udf7f Marquer comme remise</button>';
    return '<div class="commande-box">'
        + '<div class="commande-box-header"><span>\ud83c\udf7f Snacks &amp; boissons</span></div>'
        + '<div class="commande-box-body">' + itemsHtml
        + '<div class="commande-total-line"><span>Total</span><span>' + parseFloat(commande.total).toFixed(2) + ' \u20ac</span></div>'
        + '</div>' + actionHtml + '</div>';
}

async function remettre() {
    const btn = document.getElementById("btnRemettre");
    if (btn) { btn.disabled = true; btn.textContent = "En cours\u2026"; }
    try {
        await fetch("/api/boutique/commandes/remettre", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reservationId: RESA_ID })
        });
        if (btn) btn.outerHTML = '<div class="commande-remise-badge">\u2705 Commande d\u00e9j\u00e0 transmise</div>';
    } catch {
        if (btn) { btn.disabled = false; btn.textContent = "\ud83c\udf7f Marquer comme remise"; }
    }
}

document.getElementById("checkBtn").addEventListener("click", async () => {
    navigator.vibrate && navigator.vibrate(40);
    const box = document.getElementById("result");
    box.style.display = "block";
    box.innerHTML = '<div class="loader"></div><p>V\u00e9rification...</p>';
    await new Promise(function(r) { setTimeout(r, 1000); });
    try {
        const res = await fetch("/verify?id=${id}&check=1");
        const data = await res.json();
        if (data.status === "valid") {
            const alreadyScanned = data.scanCount > 1
                ? '<div style="background:#3498db;color:#000;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:15px;font-weight:bold;">Ce ticket a deja ete scanne ' + (data.scanCount - 1) + ' fois</div>'
                : "";
            box.innerHTML = '<div class="card">' + alreadyScanned
                + '<img src="/img/check.png" class="icon"><h1 style="color:#2ecc71;">Ticket VALIDE</h1>'
                + '<p><b>Client :</b> ' + data.client + '</p>'
                + '<p><b>Film :</b> ' + data.film + '</p>'
                + '<p><b>Salle :</b> ' + data.salle + '</p>'
                + '<p><b>Date :</b> ' + data.date + '</p>'
                + '<p><b>Heure :</b> ' + data.heure + '</p>'
                + '<p><b>Places :</b> ' + data.places + '</p>'
                + buildCommandeHtml(data.commande)
                + '</div>';
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const response = await fetch("/sounds/valid.mp3");
                const arrayBuffer = await response.arrayBuffer();
                const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
                const source = ctx.createBufferSource();
                source.buffer = audioBuffer; source.connect(ctx.destination); source.start(0);
            } catch(e) {}
        } else {
            box.innerHTML = '<div class="card"><img src="/img/cross.png" class="icon"><h1 style="color:#e74c3c;">Ticket REFUSE</h1><p>Raison : ' + data.reason + '</p></div>';
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)();
                const response = await fetch("/sounds/error.mp3");
                const arrayBuffer = await response.arrayBuffer();
                const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
                const source = ctx.createBufferSource();
                source.buffer = audioBuffer; source.connect(ctx.destination); source.start(0);
            } catch(e) {}
        }
    } catch(err) {
        box.innerHTML = '<div class="card"><h1 style="color:#e74c3c;">Erreur</h1><p>Impossible de verifier le ticket</p></div>';
    }
});
</script>
</body>
</html>`);
});

app.post("/api/supprimer-compte", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).send("userId manquant");
  const { error } = await supabase.auth.admin.deleteUser(userId);
  if (error) return res.status(500).send(error.message);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Serveur lancé sur le port " + PORT);
});
