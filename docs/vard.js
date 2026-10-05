import { supabase } from "./supabase.js";
import QRCode from "https://esm.sh/qrcode@1";
import { hamtaLat, bildUrl } from "./media.js";

const $ = (id) => document.getElementById(id);

const sektioner = {
  login: $("login"),
  start: $("start"),
  lobby: $("lobby"),
  spel: $("spel"),
  slut: $("slut"),
};

const FARGER = ["rod", "bla", "gul", "gron"];
const SYMBOLER = ["▲", "◆", "●", "■"];

let rum = null;      // rummets rad, uppdateras via realtid
let spelare = [];
let kanal = null;
let fraga = null;    // aktuell fråga från quiz_aktuell_fraga
let svar = [];       // inkomna svar på aktuell fråga
let timer = null;

const ljud = new Audio();
let ljudFragaNr = null; // vilken fråga ljudet hör till

function visa(namn) {
  for (const [n, s] of Object.entries(sektioner)) s.hidden = n !== namn;
}

function arVard(session) {
  return session && !session.user.is_anonymous;
}

function esc(text) {
  const d = document.createElement("div");
  d.textContent = String(text ?? "");
  return d.innerHTML;
}

function alternativText(a) {
  return typeof a === "string" ? a : a?.text ?? "";
}

// ---------- Rum ----------

async function skapaRum() {
  for (let forsok = 0; forsok < 3; forsok++) {
    const { data, error } = await supabase
      .from("quiz_rooms")
      .insert({})
      .select()
      .single();
    if (!error) return data;
    if (error.code !== "23505") throw error;
  }
  throw new Error("Kunde inte skapa en unik kod, försök igen");
}

async function hittaOppetRum(userId) {
  const { data } = await supabase
    .from("quiz_rooms")
    .select()
    .eq("host_id", userId)
    .neq("status", "slut")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function oppnaRum(nyttRum) {
  rum = nyttRum;

  // Anslutningsinfo och QR-kod
  const adress = new URL("./", location.href);
  $("adress").textContent = adress.host + adress.pathname;
  $("kod").textContent = rum.code;
  const lank = new URL(`./?kod=${rum.code}`, location.href).href;
  $("qr").innerHTML = await QRCode.toString(lank, {
    type: "svg",
    margin: 1,
    color: { dark: "#1c1917", light: "#ffffff" },
  });

  // Spelare
  const { data: sp } = await supabase
    .from("quiz_players")
    .select("id, nickname")
    .eq("room_id", rum.id)
    .order("joined_at");
  spelare = sp ?? [];

  // Frågesporter, egna och andras
  const [{ data: quizzar }, { data: profiler }] = await Promise.all([
    supabase.from("quiz_quizzes").select("id, titel, owner_id").order("titel"),
    supabase.from("quiz_profiles").select("user_id, namn"),
  ]);

  const namn = Object.fromEntries((profiler ?? []).map((p) => [p.user_id, p.namn]));
  const mina = (quizzar ?? []).filter((q) => q.owner_id === rum.host_id);
  const andras = (quizzar ?? []).filter((q) => q.owner_id !== rum.host_id);

  const alternativ = (q, visaSkapare) =>
    `<option value="${q.id}">${esc(q.titel)}${
      visaSkapare ? ` (${esc(namn[q.owner_id] ?? "okänd")})` : ""
    }</option>`;

  $("quizval").innerHTML =
    `<optgroup label="Mina">${mina.map((q) => alternativ(q, false)).join("")}</optgroup>` +
    (andras.length
      ? `<optgroup label="Andras">${andras.map((q) => alternativ(q, true)).join("")}</optgroup>`
      : "");

  // En kanal för allt som händer i rummet
  kanal = supabase
    .channel(`rum-${rum.id}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "quiz_players", filter: `room_id=eq.${rum.id}` },
      (p) => {
        if (spelare.some((s) => s.id === p.new.id)) return;
        spelare.push(p.new);
        ritaSpelare();
      }
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "quiz_players" },
      (p) => {
        spelare = spelare.filter((s) => s.id !== p.old.id);
        ritaSpelare();
      }
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "quiz_rooms", filter: `id=eq.${rum.id}` },
      (p) => {
        rum = p.new;
        rendera();
      }
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "quiz_answers", filter: `room_id=eq.${rum.id}` },
      (p) => {
        if (p.new.fraga_nr !== rum.fraga_nr) return;
        svar.push(p.new);
        ritaSvarsantal();
      }
    )
    .subscribe();

  await rendera();
}

async function stangRum() {
  clearInterval(timer);
  ljud.pause();
  ljudFragaNr = null;
  if (kanal) await supabase.removeChannel(kanal);
  kanal = null;
  rum = null;
  spelare = [];
  fraga = null;
  svar = [];
}

// ---------- Ljud ----------

async function startaLjud(m) {
  const lat = await hamtaLat(m.ref);
  if (!lat?.ljud) return;

  ljud.src = lat.ljud;
  ljud.currentTime = m.start ?? 0;
  try {
    await ljud.play();
  } catch {
    // Webbläsaren kan blockera uppspelning som inte startats av ett klick.
    // Då visar knappen ▶ och värden startar klippet själv.
  }
}

function uppdateraLjudknapp() {
  const knapp = $("ljudknapp");
  if (!knapp) return;
  knapp.textContent = ljud.paused ? "▶" : "⏸";
  knapp.setAttribute("aria-label", ljud.paused ? "Spela" : "Pausa");
}

ljud.addEventListener("play", uppdateraLjudknapp);
ljud.addEventListener("pause", uppdateraLjudknapp);
ljud.addEventListener("ended", uppdateraLjudknapp);

// ---------- Rendering ----------

async function rendera() {
  clearInterval(timer);

  if (rum.status === "lobby" || rum.status === "slut") {
    ljud.pause();
    ljudFragaNr = null;
  }

  if (rum.status === "lobby") {
    fraga = null;
    svar = [];
    ritaSpelare();
    visa("lobby");
    return;
  }

  if (rum.status === "slut") {
    const { data: res } = await supabase.rpc("quiz_resultat", { p_rum: rum.id });
    $("slutlista").innerHTML = topplistaHtml(res?.topplista ?? []);
    visa("slut");
    return;
  }

  // Läget är "fraga" eller "facit"
  const { data } = await supabase.rpc("quiz_aktuell_fraga", { p_rum: rum.id });
  fraga = data;

  const { data: inkomna } = await supabase
    .from("quiz_answers")
    .select("svar, player_id")
    .eq("room_id", rum.id)
    .eq("fraga_nr", rum.fraga_nr);
  svar = inkomna ?? [];

  // Ljudet startar en gång per fråga och fortsätter in i facit
  if (fraga.media?.typ === "ljud") {
    if (ljudFragaNr !== rum.fraga_nr) {
      ljudFragaNr = rum.fraga_nr;
      ljud.pause();
      startaLjud(fraga.media);
    }
  } else {
    ljud.pause();
    ljudFragaNr = null;
  }

  const facit = rum.status === "facit";

  $("fragenr").textContent = `Fråga ${fraga.nr} av ${fraga.antal}`;
  $("fragetext").textContent = fraga.fraga;
  $("nedrakning").hidden = facit;
  $("visafacit").hidden = facit;
  $("facitdel").hidden = !facit;
  ritaMedia();
  ritaAlternativ();
  ritaNummerfacit();
  ritaSvarsantal();

  if (facit) {
    const { data: res } = await supabase.rpc("quiz_resultat", { p_rum: rum.id });
    $("topplista").innerHTML = topplistaHtml((res?.topplista ?? []).slice(0, 5));
    $("nasta").textContent = fraga.nr === fraga.antal ? "Visa resultat" : "Nästa fråga";
  } else {
    startaNedrakning(fraga.kvar_ms);
  }

  visa("spel");
}

function ritaSpelare() {
  $("antal").textContent =
    spelare.length === 1 ? "1 spelare" : `${spelare.length} spelare`;

  $("spelarlista").innerHTML = spelare
    .map(
      (s) =>
        `<li><button class="spelare" data-id="${s.id}" title="Klicka för att ta bort">${esc(s.nickname)}</button></li>`
    )
    .join("");
}

function ritaMedia() {
  const m = fraga.media;
  const facit = rum.status === "facit";

  if (m?.typ === "bild") {
    const kalla =
      m.kalla === "wikimedia"
        ? `${esc(m.upphov || "Okänd upphovsperson")} · ${esc(m.licens)} · Wikimedia Commons`
        : "";
    $("fragemedia").innerHTML = `
      <figure>
        <img src="${esc(bildUrl(m, 1200))}" alt="">
        <figcaption>${kalla}</figcaption>
      </figure>`;
    return;
  }

  if (m?.typ === "ljud") {
    // Under frågan avslöjas inte låten, i facit visas omslag, titel och artist
    $("fragemedia").innerHTML = `
      <div class="ljudkort">
        ${facit && m.bild ? `<img src="${esc(m.bild)}" alt="">` : ""}
        <button id="ljudknapp" class="ljudknapp">⏸</button>
        <div class="ljudinfo">
          ${facit
            ? `<strong>${esc(m.titel)}</strong><span>${esc(m.artist)}</span>`
            : `<strong>Lyssna!</strong>`}
        </div>
      </div>`;
    uppdateraLjudknapp();
    return;
  }

  $("fragemedia").innerHTML = "";
}

function ritaAlternativ() {
  if (fraga.typ === "nummer") {
    $("alternativ").hidden = true;
    return;
  }
  $("alternativ").hidden = false;

  const facit = rum.status === "facit";

  $("alternativ").innerHTML = fraga.alternativ
    .map((a, i) => {
      const klasser = [FARGER[i % 4]];
      if (facit) klasser.push(i === fraga.ratt ? "ratt-alt" : "fel-alt");
      const antal = svar.filter((s) => s.svar === i).length;

      return `
        <li class="${klasser.join(" ")}">
          <span class="symbol">${SYMBOLER[i % 4]}</span>
          <span class="alt-text">${esc(alternativText(a))}</span>
          ${facit ? `<span class="alt-antal">${antal}</span>` : ""}
        </li>`;
    })
    .join("");
}

function ritaNummerfacit() {
  if (fraga.typ !== "nummer") {
    $("nummerfacit").hidden = true;
    return;
  }
  $("nummerfacit").hidden = false;

  if (rum.status !== "facit") {
    $("nummerfacit").innerHTML = `<p class="instruktion">Skriv ditt svar på mobilen</p>`;
    return;
  }

  const ratt = Number(fraga.ratt.svar);
  const namn = Object.fromEntries(spelare.map((s) => [s.id, s.nickname]));

  const narmast = svar
    .map((s) => ({
      namn: namn[s.player_id] ?? "?",
      gissning: Number(s.svar),
      avstand: Math.abs(Number(s.svar) - ratt),
    }))
    .sort((a, b) => a.avstand - b.avstand)
    .slice(0, 3);

  $("nummerfacit").innerHTML = `
    <p class="nummersvar">${esc(fraga.ratt.svar)}</p>
    ${narmast.length
      ? `<ul class="narmast">${narmast
          .map((n) => `<li><span>${esc(n.namn)}</span><strong>${esc(n.gissning)}</strong></li>`)
          .join("")}</ul>`
      : ""}`;
}

function ritaSvarsantal() {
  $("svarsantal").textContent = `${svar.length} av ${spelare.length} svar`;

  // Alla har svarat: visa facit direkt i stället för att vänta ut tiden
  if (rum.status === "fraga" && spelare.length > 0 && svar.length >= spelare.length) {
    visaFacit();
  }
}

function topplistaHtml(lista) {
  return lista
    .map(
      (p) => `
        <li>
          <span class="placering">${p.placering}</span>
          <span class="namn">${esc(p.namn)}</span>
          <span class="poang">${p.poang}</span>
        </li>`
    )
    .join("");
}

function startaNedrakning(ms) {
  const slut = Date.now() + ms;

  const tick = () => {
    const kvar = Math.max(0, Math.ceil((slut - Date.now()) / 1000));
    $("nedrakning").textContent = kvar;
    if (kvar === 0) {
      clearInterval(timer);
      visaFacit();
    }
  };

  tick();
  timer = setInterval(tick, 250);
}

async function visaFacit() {
  if (rum?.status !== "fraga") return;
  await supabase.rpc("quiz_facit", { p_rum: rum.id });
}

// ---------- Uppstart ----------

async function efterInloggning(user) {
  const oppet = await hittaOppetRum(user.id);
  if (oppet) await oppnaRum(oppet);
  else visa("start");
}

const { data: { session } } = await supabase.auth.getSession();
if (arVard(session)) await efterInloggning(session.user);
else visa("login");

// ---------- Knappar ----------

$("loginform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: $("epost").value,
    password: $("losen").value,
  });
  if (error) {
    $("loginfel").textContent = "Fel e-post eller lösenord";
    return;
  }
  await efterInloggning(data.user);
});

$("loggaut").addEventListener("click", async () => {
  await supabase.auth.signOut();
  visa("login");
});

$("skapa").addEventListener("click", async () => {
  try {
    await oppnaRum(await skapaRum());
  } catch (err) {
    $("startfel").textContent = err.message;
  }
});

$("starta").addEventListener("click", async () => {
  $("lobbyfel").textContent = "";
  const { error } = await supabase.rpc("quiz_starta", {
    p_rum: rum.id,
    p_quiz: $("quizval").value,
  });
  if (error) $("lobbyfel").textContent = error.message;
});

$("visafacit").addEventListener("click", visaFacit);

$("nasta").addEventListener("click", async () => {
  await supabase.rpc("quiz_nasta", { p_rum: rum.id });
});

$("fragemedia").addEventListener("click", (e) => {
  if (!e.target.closest("#ljudknapp")) return;
  if (!ljud.src) {
    startaLjud(fraga.media);
  } else if (ljud.paused) {
    ljud.play();
  } else {
    ljud.pause();
  }
});

async function avslutaRum() {
  await supabase.from("quiz_rooms").delete().eq("id", rum.id);
  await stangRum();
  visa("start");
}

$("avsluta").addEventListener("click", async () => {
  if (!confirm("Avsluta rummet? Alla spelare kopplas bort.")) return;
  await avslutaRum();
});

$("klar").addEventListener("click", avslutaRum);

// Tillbaka till lobbyn: spelarna är kvar, svaren och poängen nollställs
async function tillbakaTillLobbyn() {
  const { error } = await supabase.rpc("quiz_till_lobbyn", { p_rum: rum.id });
  if (error) alert(error.message);
}

$("avbrytspel").addEventListener("click", async () => {
  if (!confirm("Avbryta spelet? Poängen nollställs och alla går tillbaka till lobbyn.")) return;
  await tillbakaTillLobbyn();
});

$("igen").addEventListener("click", tillbakaTillLobbyn);

$("spelarlista").addEventListener("click", async (e) => {
  const knapp = e.target.closest("button.spelare");
  if (!knapp) return;
  if (!confirm(`Ta bort ${knapp.textContent}?`)) return;

  const id = knapp.dataset.id;
  await supabase.from("quiz_players").delete().eq("id", id);
  spelare = spelare.filter((s) => s.id !== id);
  ritaSpelare();
});