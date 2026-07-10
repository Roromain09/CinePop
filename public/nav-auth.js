(async () => {
  const SUPABASE_URL  = "https://fsywnmsppegrffvoijuv.supabase.co";
  const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZzeXdubXNwcGVncmZmdm9panV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MTE1MjUsImV4cCI6MjA5NzE4NzUyNX0.dXoTVu3ZN5kt7JtqSy9PcQpqI9vvto1s61S23WuJgbU";

  const { createClient } = supabase;
  const _sb = createClient(SUPABASE_URL, SUPABASE_ANON);

  const { data: { session } } = await _sb.auth.getSession();

  // Expose userId pour reservation.html
  window._navAuthUserId = session?.user?.id || null;

  const linkDesktop = document.getElementById("navAuthLink");
  const linkMobile  = document.getElementById("navAuthMobile");

  if (!linkDesktop && !linkMobile) return;

  if (!session) {
    // Pas connecté : on garde les liens "Connexion" par défaut (déjà dans le HTML)
    return;
  }

  // Connecté : récupérer l'avatar depuis profiles
  let avatar = "🎬";
  const { data: profil } = await _sb
    .from("profiles")
    .select("avatar")
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (profil?.avatar) avatar = profil.avatar;

  // Desktop : transformer le lien en bulle avatar → /compte.html
  if (linkDesktop) {
    linkDesktop.href        = "/compte.html";
    linkDesktop.title       = "Mon compte";
    linkDesktop.textContent = avatar;
  }

  // Mobile : transformer le lien en "Mon compte" avec emoji
  if (linkMobile) {
    linkMobile.href        = "/compte.html";
    linkMobile.style.display = "flex";
    const emojiSpan = linkMobile.querySelector(".nav-emoji-mobile");
    if (emojiSpan) emojiSpan.textContent = avatar;
    else linkMobile.textContent = avatar + " Mon compte";
  }

  // Pré-remplissage formulaire réservation (reservation.html)
  const nameInput  = document.getElementById("clientName");
  const emailInput = document.getElementById("email");
  if (nameInput || emailInput) {
    const { data: profilFull } = await _sb
      .from("profiles")
      .select("display_name")
      .eq("user_id", session.user.id)
      .maybeSingle();
    if (nameInput  && profilFull?.display_name) nameInput.value  = profilFull.display_name;
    if (emailInput && session.user.email)        emailInput.value = session.user.email;
  }
})();
